// Flights: typed as printed on the ticket — each time on its own airport's clock — and kept as the real moments, so
// the block sits right whatever zone you view it from. A flight is an ordinary timed event with a `flight` field:
//   "AC 856 YYZ 6:40pm → LHR 6:55am dec 12"   "YYZ-LHR dec 12 18:40-06:55"   "flight LHR to YYZ fri 11:15am 2:05pm"
// Before it: a countdown in the deadline band (FLIGHT_LEAD days) and three reminders (FLIGHT_ALERTS).
// After it: the days until the next flight out of that city are a trip ("In London"), shown across the all-day row.
import type { CalEvent, CalendarSource } from '../data/types';
import { airport, citiesIn, type Airport } from './airports';
import { instantOf, wallClock, zoneAbbr } from './zone';
import { parseQuick } from './quickparse';
import { prefs } from './prefs';

export interface FlightInfo {
  no?: string; // "AC 856"
  from: string; // IATA codes
  to: string;
  fromZone: string;
  toZone: string;
}

export const FLIGHT_LEAD = 3; // days of countdown in the deadline band
/** Reminders, minutes before departure: 3 days (pack, documents), a day (check-in opens), 3 hours (leave for the airport). */
export const FLIGHT_ALERTS = [3 * 1440, 1440, 180];
export const FLIGHT_COLOR = '#3aa0ff';
const MAX_TRIP_DAYS = 120; // a stay longer than this isn't a trip (you moved)
const DAY = 86_400_000;

// ---------------------------------------------------------------- reading what's typed
const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|a|p)(?![a-z])|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi;
const SEP = /^\s*(?:→|->|–|—|-|>|to|›|»)\s*$/i;
const FLIGHT_NO = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/i;

interface Tok { text: string; start: number; end: number }
const tokens = (s: string, re: RegExp): Tok[] => [...s.matchAll(re)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
const minutesOf = (t: string) => {
  const m = new RegExp(TIME.source, 'i').exec(t)!;
  if (m[4] !== undefined) return Number(m[4]) * 60 + Number(m[5]);
  let h = Number(m[1]) % 12;
  if (m[3].toLowerCase().startsWith('p')) h += 12;
  return h * 60 + Number(m[2] ?? 0);
};

export interface FlightPlan {
  title: string;
  start: number;
  end: number;
  flight: FlightInfo;
  from: Airport;
  to: Airport;
  hasArrival: boolean;
}

/** A flight in what was typed, or null when it isn't one. Two airport codes are needed: written in capitals, or joined
 *  by an arrow / dash / "to" ("yyz to lhr"), so ordinary words ("the", "mad", "den") never read as airports. */
export function parseFlight(text: string, now = new Date()): FlightPlan | null {
  // (one flight is a line, not a page: a long paste goes to parseItinerary — and this stays fast on any input)
  if (text.length > 300) return null;
  const codes = tokens(text, /\b[A-Za-z]{3}\b/g).filter((t) => airport(t.text));
  let pair: [Tok, Tok] | null = null;
  for (let i = 0; i < codes.length && !pair; i++)
    for (let j = i + 1; j < Math.min(codes.length, i + 4) && !pair; j++) {
      const [a, b] = [codes[i], codes[j]];
      if (a.text.toUpperCase() === b.text.toUpperCase()) continue;
      const between = text.slice(a.end, b.start);
      const joined = SEP.test(between) || SEP.test(between.replace(TIME, ' ').replace(/\s+/g, ' '));
      const caps = a.text === a.text.toUpperCase() && b.text === b.text.toUpperCase();
      const bracketed = text[a.start - 1] === '(' && text[a.end] === ')' && text[b.start - 1] === '(' && text[b.end] === ')'; // "Toronto (YYZ) … Phoenix (PHX)"
      if (joined || (caps && bracketed) || (caps && /flight|✈|→|->/i.test(text)) || (caps && FLIGHT_NO.test(text.replace(a.text, '').replace(b.text, '')))) pair = [a, b];
    }
  if (!pair) return null;
  const from = airport(pair[0].text)!, to = airport(pair[1].text)!;

  // the times: one right after an airport is that airport's; otherwise the first is departure, the second arrival
  const times = tokens(text, TIME);
  if (!times.length) return null;
  const near = (code: Tok) => times.find((t) => t.start >= code.end && /^\s*$/.test(text.slice(code.end, t.start)));
  let dep = near(pair[0]), arr = near(pair[1]);
  const rest = times.filter((t) => t !== dep && t !== arr);
  dep ??= rest.shift();
  arr ??= rest.shift();
  if (!dep) return null;

  const noMatch = FLIGHT_NO.exec(text.slice(0, pair[0].start) + ' ' + text.slice(pair[1].end).replace(TIME, ' '));
  const no = noMatch && !/^\d+$/.test(noMatch[1]) && !airport(noMatch[0].replace(/\s/g, '').slice(0, 3)) ? `${noMatch[1].toUpperCase()} ${noMatch[2]}` : undefined;

  // the date: whatever's left, read like any quick-add text ("dec 12", "next friday")
  let left = text;
  for (const t of [pair[0], pair[1], dep, arr].filter(Boolean).sort((x, y) => y!.start - x!.start)) left = left.slice(0, t!.start) + ' ' + left.slice(t!.end);
  if (noMatch) left = left.replace(noMatch[0], ' ');
  const plusDays = Number(/\+\s?(\d)\b/.exec(left)?.[1] ?? 0);
  left = left.replace(/\+\s?\d\b/, ' ').replace(/\b(?:flight|fly|flying)\b|✈|→|->|–|—|›|»|\bto\b|-/gi, ' ');
  // (a written date first — "Tue 13 Jan 2027", "December 3, 2026" — then words like "next friday")
  const written = dateIn(left, now);
  const p = written ? null : parseQuick(left, [], now);
  const day = written ? new Date(written[0], written[1], written[2]) : p!.hasDay ? new Date(p!.start) : now;
  const y = day.getFullYear(), m = day.getMonth(), d = day.getDate();

  const start = instantOf(y, m, d, minutesOf(dep.text), from.zone);
  let end = start + 2 * 3_600_000; // no arrival time given: 2 hours, until it's filled in
  if (arr) {
    // the arrival's date at the destination: the same calendar day (+N if written), moved on until it's after departure
    end = instantOf(y, m, d + plusDays, minutesOf(arr.text), to.zone);
    for (let k = 0; end <= start && k < 3; k++) end = instantOf(y, m, d + plusDays + k + 1, minutesOf(arr.text), to.zone);
  }
  if (end <= start) return null;
  const flight: FlightInfo = { ...(no ? { no } : {}), from: from.code, to: to.code, fromZone: from.zone, toZone: to.zone };
  return { title: flightTitle(flight), start, end, flight, from, to, hasArrival: !!arr };
}

export const flightTitle = (f: FlightInfo) => `${f.no ? f.no + ' ' : 'Flight '}to ${airport(f.to)?.city ?? f.to}`;

// ---------------------------------------------------------------- showing it
const pad = (n: number) => String(n).padStart(2, '0');
/** A time on another zone's clock: "6:40 PM" · 24-hour "18:40". */
export function fmtIn(t: number, zone: string) {
  const w = wallClock(t, zone);
  if (prefs.hour24) return `${pad(w.h)}:${pad(w.min)}`;
  return `${w.h % 12 || 12}${w.min ? ':' + pad(w.min) : ''} ${w.h < 12 ? 'AM' : 'PM'}`;
}
/** Days the arrival's date is past the departure's, each on its own clock (+1 for an overnight flight). */
export function dayShift(ev: Pick<CalEvent, 'start' | 'end'>, f: FlightInfo) {
  const a = wallClock(ev.start, f.fromZone), b = wallClock(ev.end, f.toZone);
  return Math.round((Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / DAY);
}
/** "6:40 PM YYZ → 6:55 AM LHR +1", each time on its airport's clock. */
export function flightTimes(ev: Pick<CalEvent, 'start' | 'end'>, f: FlightInfo) {
  const n = dayShift(ev, f);
  return `${fmtIn(ev.start, f.fromZone)} ${f.from} → ${fmtIn(ev.end, f.toZone)} ${f.to}${n ? ` ${n > 0 ? '+' : ''}${n}` : ''}`;
}
/** "7h 15m" in the air. */
export function flightLength(ev: Pick<CalEvent, 'start' | 'end'>) {
  const min = Math.round((ev.end - ev.start) / 60_000);
  return `${Math.floor(min / 60)}h${min % 60 ? ` ${min % 60}m` : ''}`;
}
export const zoneNote = (t: number, zone: string) => zoneAbbr(zone, t);
/** The airline's own page isn't knowable offline; a flight tracker finds it by number. */
export const trackerUrl = (f: FlightInfo) => (f.no ? `https://www.flightaware.com/live/flight/${f.no.replace(/\s/g, '')}` : undefined);

// ---------------------------------------------------------------- trips
export interface Trip {
  id: string; // the arriving flight's id
  city: string;
  zone: string;
  start: number; // landing
  end: number; // the next flight out of there (or the landing + a day, if none is booked yet)
  open: boolean; // no flight out yet
}

/** Where you are between flights: after landing somewhere other than home, until the next flight leaves from there. */
export function tripsOf(events: CalEvent[], homeZone: string | undefined, calendars?: CalendarSource[]): Trip[] {
  const hidden = new Set(calendars?.filter((c) => !c.visible).map((c) => c.id));
  const flights = events.filter((e) => e.flight && !hidden.has(e.calendarId)).sort((a, b) => a.start - b.start);
  const out: Trip[] = [];
  for (let i = 0; i < flights.length; i++) {
    const f = flights[i], info = f.flight!;
    if (homeZone && info.toZone === homeZone) continue;
    const next = flights.slice(i + 1).find((g) => g.flight!.from === info.to || airport(g.flight!.from)?.city === airport(info.to)?.city);
    const connection = next && next.start - f.end < 24 * 3_600_000 && i + 1 < flights.length && flights[i + 1] === next;
    if (connection) continue; // changing planes: not a stay
    const city = airport(info.to)?.city ?? info.to;
    if (next && next.start - f.end <= MAX_TRIP_DAYS * DAY) out.push({ id: f.id, city, zone: info.toZone, start: f.end, end: next.start, open: false });
    else if (!next) out.push({ id: f.id, city, zone: info.toZone, start: f.end, end: f.end + DAY, open: true });
  }
  return out;
}

/** The trip you're on at `t`, if any. */
export const tripAt = (trips: Trip[], t: number) => trips.find((x) => !x.open && x.start <= t && t < x.end);

// ---------------------------------------------------------------- a pasted confirmation email
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
const DATE_RES: [RegExp, (m: RegExpExecArray) => [number | undefined, number, number]][] = [
  [/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => [+m[1], +m[2] - 1, +m[3]]],
  [/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/, (m) => [+m[3], +m[2] - 1, +m[1]]], // (30.05.2026: day first)
  [new RegExp(`\\b(\\d{1,2})\\s*${MON}\\s*,?\\s*(\\d{4})?\\b`, 'i'), (m) => [m[3] ? +m[3] : undefined, MONTHS.indexOf(m[2].toLowerCase()), +m[1]]],
  [new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})?\\b`, 'i'), (m) => [m[3] ? +m[3] : undefined, MONTHS.indexOf(m[1].toLowerCase()), +m[2]]],
];
/** The first date written in `s` ("Sat 12 Dec 2026", "December 12, 2026", "2026-12-12"); a missing year is the next
 *  time that date comes round. */
function dateIn(s: string, now: Date): [number, number, number] | null {
  let best: { at: number; ymd: [number | undefined, number, number] } | null = null;
  for (const [re, read] of DATE_RES) {
    const m = re.exec(s);
    if (m && (!best || m.index < best.at)) best = { at: m.index, ymd: read(m) };
  }
  if (!best) return null;
  const [y, mo, d] = best.ymd;
  if (mo < 0 || d < 1 || d > 31) return null;
  const real = (yy: number) => new Date(yy, mo, d).getDate() === d; // (no "31 Feb" rolled into March)
  if (y !== undefined) return real(y) ? [y, mo, d] : null;
  if (!real(2028)) return null; // (Feb 29 is real in a leap year)
  const thisYear = new Date(now.getFullYear(), mo, d);
  return [thisYear.getTime() < now.getTime() - 30 * DAY ? now.getFullYear() + 1 : now.getFullYear(), mo, d];
}

/** Every flight in a pasted itinerary, confirmation email or e-ticket. Airlines lay these out every way: the flight
 *  number first, then airports, date and times ("AC 856 · Toronto (YYZ) → London (LHR) · Sat 12 Dec · 6:40 PM 6:55
 *  AM"); or the date, airports and times first and the number after them (Air Canada); or a table, the airports before
 *  the number and the times after it (Aeroméxico). So: each flight number is an anchor, and for each kind of detail —
 *  the date, the two airports, the times — the document is asked once whether it sits before its number or after it
 *  (whichever finds it for more flights, nearer); each flight then takes the nearest ones on that side, up to the
 *  neighbouring flight's number. A leg with no date of its own ("AC 25", the second leg of "FLIGHT 1 • Sat 05 Dec")
 *  flies on the date before it. Airports are codes ("YYZ", "(YYZ)") or, where a ticket prints none, city names. */
export function parseItinerary(text: string, now = new Date()): FlightPlan[] {
  const flat = text.replace(/\s+/g, ' ');
  // (not "PM 11" in "3:55 PM 11:50 AM", nor a time: a flight number isn't followed by ":"; nor an aircraft, "A321-200")
  // (two to four digits: "CA4" is a tax code; "AM 693" is Aeroméxico, but the "AM" after a time isn't)
  const anchors = [...flat.matchAll(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{2,4})\b(?![:.]\d|-\d)/g)]
    .filter((m) => !(/^(?:AM|PM)$/.test(m[1]) && /\d\s*$/.test(flat.slice(0, m.index!))) && !airport(m[0].slice(0, 3)) && !/(?:airbus|boeing|aircraft|type:?|seats?:?|row)\s*$/i.test(flat.slice(Math.max(0, m.index! - 12), m.index!)))
    .map((m) => ({ at: m.index!, end: m.index! + m[0].length, no: `${m[1]} ${m[2].replace(/^0+(?=\d)/, '')}` as string | undefined }));
  // a heading where no number follows ("RETURN FLIGHT", a regional partner's leg; a screenshot too small to read it) is
  // that flight's anchor
  for (const m of flat.matchAll(/\b(?:departing|departure|outbound|return(?:ing)?|inbound)\s+flight\b|\bflight\s+\d\b/gi))
    if (!anchors.some((a) => a.at > m.index! - 40 && a.at < m.index! + m[0].length + 250)) anchors.push({ at: m.index!, end: m.index! + m[0].length, no: undefined });
  anchors.sort((a, b) => a.at - b.at);
  if (!anchors.length) return [];

  // the details, in order; one said several times in a row ("12:05 12:05 12:05", a PDF's bold) is one
  interface Tk { at: number; end: number; text: string }
  const dedup = (xs: Tk[]) => xs.filter((x, i) => !(i && xs[i - 1].text === x.text && x.at - xs[i - 1].end < 4));
  const times = dedup([...flat.matchAll(TIME)].map((m) => ({ at: m.index!, end: m.index! + m[0].length, text: m[0] })));
  const dates: (Tk & { ymd: [number, number, number] })[] = [];
  for (const [re] of DATE_RES)
    for (const m of flat.matchAll(new RegExp(re.source, 'gi'))) {
      const ymd = dateIn(m[0], now);
      if (ymd && !dates.some((d) => d.at < m.index! + m[0].length && m.index! < d.end)) dates.push({ at: m.index!, end: m.index! + m[0].length, text: m[0], ymd });
    }
  dates.sort((a, b) => a.at - b.at);
  const codes = dedup([...flat.matchAll(/\(([A-Z]{3})\)|\b([A-Z]{3})\b/g)].filter((m) => airport(m[1] ?? m[2])).map((m) => ({ at: m.index!, end: m.index! + m[0].length, text: (m[1] ?? m[2]) })));
  const cities = dedup(citiesIn(flat).map((c) => ({ at: c.at, end: c.end, text: c.airport.code })));

  // each flight's room: from the number before it to the number after it
  const room = anchors.map((a, i) => ({ before: [i ? anchors[i - 1].end : 0, a.at] as const, after: [a.end, anchors[i + 1]?.at ?? flat.length] as const }));
  type Side = 'before' | 'after';
  const near = (xs: Tk[], i: number, side: Side, n: number) => {
    const [lo, hi] = room[i][side];
    const inside = xs.filter((x) => x.at >= lo && x.end <= hi);
    const picked = side === 'before' ? inside.slice(-n) : inside.slice(0, n);
    const dist = picked.length ? (side === 'before' ? anchors[i].at - picked[0].at : picked.at(-1)!.end - anchors[i].end) : Infinity;
    return { picked, dist };
  };
  // airports: two different ones nearest the number (codes where the room has any, else city names)
  const pairNear = (i: number, side: Side) => {
    for (const xs of [codes, cities]) {
      const [lo, hi] = room[i][side];
      const inside = xs.filter((x) => x.at >= lo && x.end <= hi);
      const ordered = side === 'before' ? [...inside].reverse() : inside;
      const first = ordered[0], second = ordered.find((x) => x.text !== first?.text);
      if (first && second) {
        const pair = side === 'before' ? [second, first] : [first, second];
        return { picked: pair, dist: side === 'before' ? anchors[i].at - pair[0].at : pair[1].end - anchors[i].end };
      }
    }
    return { picked: [] as Tk[], dist: Infinity };
  };
  // which side, for the whole document: the one that finds the detail for more flights, then the nearer
  const choose = (find: (i: number, side: Side) => { picked: Tk[]; dist: number }, need: number): Side => {
    const score = (side: Side) => {
      let found = 0, dist = 0;
      anchors.forEach((_, i) => { const r = find(i, side); if (r.picked.length >= need) { found++; dist += r.dist; } });
      return { found, dist };
    };
    const b = score('before'), a = score('after');
    return b.found > a.found || (b.found === a.found && b.dist < a.dist) ? 'before' : 'after';
  };
  const timeSide = choose((i, s) => near(times, i, s, 2), 1);
  // (a flight's date sits with its times — reading it on its own side would take the next flight's date as often as
  // its own — unless that side has no dates at all)
  const dateSide: Side = anchors.some((_, i) => near(dates, i, timeSide, 1).picked.length) ? timeSide : timeSide === 'before' ? 'after' : 'before';
  const portSide = choose(pairNear, 2);

  const out: FlightPlan[] = [];
  const seen = new Set<string>();
  let lastDate: [number, number, number] | null = null;
  anchors.forEach((a, i) => {
    const d = near(dates, i, dateSide, 1).picked[0] as (typeof dates)[number] | undefined;
    const date = d?.ymd ?? lastDate;
    const ports = pairNear(i, portSide).picked;
    const ts = near(times, i, timeSide, 2).picked.map((t) => t.text);
    if (!date || ports.length < 2 || !ts.length) return;
    lastDate = date;
    const from = airport(ports[0].text)!, to = airport(ports[1].text)!;
    const [y, m, dd] = date;
    const start = instantOf(y, m, dd, minutesOf(ts[0]), from.zone);
    let end = ts[1] ? instantOf(y, m, dd, minutesOf(ts[1]), to.zone) : start + 2 * 3_600_000;
    for (let k = 1; end <= start && k <= 3; k++) end = instantOf(y, m, dd + k, minutesOf(ts[1]), to.zone);
    const key = `${a.no ?? from.code + to.code}|${y}-${m}-${dd}`;
    if (end <= start || seen.has(key)) return; // (emails often repeat a segment: the summary, then the details)
    seen.add(key);
    const flight: FlightInfo = { ...(a.no ? { no: a.no } : {}), from: from.code, to: to.code, fromZone: from.zone, toZone: to.zone };
    out.push({ title: flightTitle(flight), start, end, flight, from, to, hasArrival: !!ts[1] });
  });
  return out;
}

// ---------------------------------------------------------------- a train or bus ticket
export interface RidePlan { title: string; start: number; end: number; zone?: string; from: string; to: string }
const RIDE_WORDS = /(?<![\p{L}])(?:train|rail|railway|bahn|sncf|trenitalia|renfe|amtrak|via rail|eurostar|české dráhy|ceske drahy|öbb|obb|sbb|ns international|omio|trainline|flixbus|bus|coach|megabus|greyhound|platform|carriage|coach \d)(?![\p{L}])/iu;
/** Each ride in a train or bus ticket: a departure time and station on one line ("11:58 AM Prague hlavní nádraží"),
 *  the arrival time and station a few lines on ("03:02 PM Brno hlavní nádraží"), on the date written before them. Both
 *  times are on the stations' own clock: the zone of the departure city (when it has an airport this app knows),
 *  else the viewer's. */
export function parseRides(text: string, now = new Date()): RidePlan[] {
  if (!RIDE_WORDS.test(text)) return [];
  const lines = text.split('\n').map((l) => l.trim());
  const STOP = new RegExp(`^(${TIME.source})\\s+([\\p{Lu}][^\\d|•]{2,60})$`, 'iu');
  const out: RidePlan[] = [];
  const seen = new Set<string>();
  let date: [number, number, number] | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (!STOP.test(lines[i])) {
      const d = lines[i].length < 60 ? dateIn(lines[i], now) : null;
      if (d) date = d;
      continue;
    }
    const j = lines.slice(i + 1, i + 4).findIndex((l) => STOP.test(l));
    if (j < 0 || !date) continue;
    const a = STOP.exec(lines[i])!, b = STOP.exec(lines[i + 1 + j])!;
    const station = (m: RegExpExecArray) => m[m.length - 1].replace(/\s+/g, ' ').trim();
    const [from, to] = [station(a), station(b)];
    const place = (s: string) => s.split(/\s+(?:hlavn|hbf|centraal|centrale|central|station|gare|bahnhof|main|union|\(|–|-)/i)[0].trim();
    const zone = citiesIn(from)[0]?.airport.zone ?? citiesIn(to)[0]?.airport.zone;
    const [y, m, d] = date;
    const at = (t: string, k = 0) => (zone ? instantOf(y, m, d + k, minutesOf(t), zone) : new Date(y, m, d + k, 0, minutesOf(t)).getTime());
    const start = at(a[1]);
    let end = at(b[1]);
    for (let k = 1; end <= start && k <= 2; k++) end = at(b[1], k);
    const kind = /\b(?:flixbus|bus|coach|megabus|greyhound)\b/i.test(text) && !/\b(?:train|rail)\b/i.test(text) ? 'Bus' : 'Train';
    const key = `${start}|${from}`;
    if (end <= start || seen.has(key)) continue;
    seen.add(key);
    out.push({ title: `${kind} to ${place(to)}`, start, end, zone, from: place(from), to: place(to) });
    i += 1 + j;
  }
  return out;
}
