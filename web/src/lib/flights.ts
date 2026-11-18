// Flights: typed as printed on the ticket — each time on its own airport's clock — and kept as the real moments, so
// the block sits right whatever zone you view it from. A flight is an ordinary timed event with a `flight` field:
//   "AC 856 YYZ 6:40pm → LHR 6:55am dec 12"   "YYZ-LHR dec 12 18:40-06:55"   "flight LHR to YYZ fri 11:15am 2:05pm"
// Before it: a countdown in the deadline band (FLIGHT_LEAD days) and three reminders (FLIGHT_ALERTS).
// After it: the days until the next flight out of that city are a trip ("In London"), shown across the all-day row.
import type { CalEvent, CalendarSource } from '../data/types';
import { airport, type Airport } from './airports';
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
const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a|p)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b/gi;
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
  const codes = tokens(text, /\b[A-Za-z]{3}\b/g).filter((t) => airport(t.text));
  let pair: [Tok, Tok] | null = null;
  for (let i = 0; i < codes.length && !pair; i++)
    for (let j = i + 1; j < codes.length && !pair; j++) {
      const [a, b] = [codes[i], codes[j]];
      if (a.text.toUpperCase() === b.text.toUpperCase()) continue;
      const between = text.slice(a.end, b.start);
      const joined = SEP.test(between) || SEP.test(between.replace(TIME, ' ').replace(/\s+/g, ' '));
      const caps = a.text === a.text.toUpperCase() && b.text === b.text.toUpperCase();
      if (joined || (caps && /flight|✈|→|->/i.test(text)) || (caps && FLIGHT_NO.test(text.replace(a.text, '').replace(b.text, '')))) pair = [a, b];
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
  const p = parseQuick(left, [], now);
  const day = p.hasDay ? new Date(p.start) : now;
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
  if (y !== undefined) return [y, mo, d];
  const thisYear = new Date(now.getFullYear(), mo, d);
  return [thisYear.getTime() < now.getTime() - 30 * DAY ? now.getFullYear() + 1 : now.getFullYear(), mo, d];
}

/** Every flight in a pasted itinerary or confirmation email: each segment starts at a flight number ("AC 856", "LH471"),
 *  and holds two airport codes (often in brackets: "Toronto (YYZ)"), a date and the departure and arrival times. */
export function parseItinerary(text: string, now = new Date()): FlightPlan[] {
  const flat = text.replace(/\s+/g, ' ');
  // (not "PM 11" in "3:55 PM 11:50 AM", nor a time: a flight number isn't followed by ":")
  const nos = [...flat.matchAll(/\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b(?![:.]\d)/g)].filter((m) => !/^(?:AM|PM)$/.test(m[1]) && !airport(m[0].slice(0, 3)));
  const out: FlightPlan[] = [];
  const seen = new Set<string>();
  let lastDate = null as [number, number, number] | null;
  for (let i = 0; i < nos.length; i++) {
    const seg = flat.slice(nos[i].index!, nos[i + 1]?.index ?? flat.length);
    const codes = [...seg.matchAll(/\(([A-Z]{3})\)|\b([A-Z]{3})\b/g)].map((m) => m[1] ?? m[2]).filter((c) => airport(c));
    const from = airport(codes[0]), to = airport(codes.find((c) => c !== codes[0]));
    const times = [...seg.matchAll(TIME)].map((m) => m[0]);
    const date = dateIn(seg, now) ?? lastDate;
    if (!from || !to || !times.length || !date) continue;
    lastDate = date;
    const no = `${nos[i][1]} ${nos[i][2]}`;
    const [y, m, d] = date;
    const start = instantOf(y, m, d, minutesOf(times[0]), from.zone);
    let end = times[1] ? instantOf(y, m, d, minutesOf(times[1]), to.zone) : start + 2 * 3_600_000;
    for (let k = 1; end <= start && k <= 3; k++) end = instantOf(y, m, d + k, minutesOf(times[1]), to.zone);
    const key = `${no}|${y}-${m}-${d}`;
    if (end <= start || seen.has(key)) continue; // (emails often repeat a segment: the summary, then the details)
    seen.add(key);
    const flight: FlightInfo = { no, from: from.code, to: to.code, fromZone: from.zone, toZone: to.zone };
    out.push({ title: flightTitle(flight), start, end, flight, from, to, hasArrival: !!times[1] });
  }
  return out;
}
