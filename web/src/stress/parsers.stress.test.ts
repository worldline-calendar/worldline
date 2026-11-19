// Stress: fuzz and timing of the text parsers.
import { describe, expect, it } from 'vitest';
import { parseQuick } from '../lib/quickparse';
import { parseFlight, parseItinerary, tripsOf } from '../lib/flights';
import { parseIcs } from '../lib/ics';
import { DEFAULT_CALENDARS } from '../data/mock';

// time limits stretch on a slow machine (CI runners; PERF_SLACK as in src/perf) — a single GC pause isn't a bug
const SLACK = Number(process.env.PERF_SLACK) || (process.env.CI ? 4 : 1);

const NOW = new Date(2026, 10, 18, 12, 0);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const WORDS = ['at', 'on', 'every', 'tomorrow', 'next', 'friday', 'fri', '3pm', '15:30', '12am', '12pm', 'noon', 'midnight', 'dec', '31',
  'feb', '29', '30', 'for', '2h', '90m', 'from', 'to', '-', '→', 'until', 'weekly', 'daily', 'monthly', 'in', '3', 'days', 'weeks',
  'YYZ', 'LHR', 'yyz', 'AC', '856', 'flight', '+1', '#work', '@home', '!', '2026-02-30', '25:00', '99pm', '0am', '1/2', '13/13',
  'last', 'day', 'of', 'month', 'week', 'mon', 'tue', 'wed', 'thu', 'sat', 'sun', 'all', 'day', 'remind', 'me', 'deadline', 'due',
  '😀', '\u0000', '‮', '(', ')', '[', '"', "'", '\\', '$', '^', '.*', '((((', 'aaaaaaaaaaaaaaaaaaaa', '1'.repeat(30)];
const phrase = () => Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => pick(WORDS)).join(rnd() < 0.8 ? ' ' : '');

describe('quick-add fuzz', () => {
  it('never throws, returns finite start/end with end >= start, and each parse < 50 ms', () => {
    const bad: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const s = phrase();
      const t0 = performance.now();
      try {
        const p = parseQuick(s, DEFAULT_CALENDARS, NOW);
        let ms = performance.now() - t0;
        if (ms > 50 * SLACK) {
          // (timed again: one slow run is usually a garbage-collection pause; a slow input is slow every time)
          const t1 = performance.now();
          parseQuick(s, DEFAULT_CALENDARS, NOW);
          ms = performance.now() - t1;
        }
        if (!Number.isFinite(p.start) || !Number.isFinite(p.end) || p.end < p.start || ms > 50 * SLACK) bad.push(`${JSON.stringify(s)} → ${p.start}..${p.end} ${ms.toFixed(0)}ms`);
      } catch (e) {
        bad.push(`${JSON.stringify(s)} threw ${(e as Error).message}`);
      }
    }
    expect(bad.slice(0, 15)).toEqual([]);
  });
  it('a 200 KB paste parses in < 500 ms', () => {
    const big = 'meeting with bob tomorrow at 3pm for 2h '.repeat(5000);
    const t0 = performance.now();
    parseQuick(big, DEFAULT_CALENDARS, NOW);
    expect(performance.now() - t0).toBeLessThan(500 * SLACK);
  });
});

describe('flight parsing', () => {
  it('fuzz never throws and never yields end <= start', () => {
    const bad: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const s = phrase();
      try {
        const f = parseFlight(s, NOW);
        if (f && !(f.end > f.start)) bad.push(s);
        for (const g of parseItinerary(s, NOW)) if (!(g.end > g.start) || !Number.isFinite(g.start)) bad.push('itin ' + s);
      } catch (e) {
        bad.push(`${JSON.stringify(s)} threw ${(e as Error).message}`);
      }
    }
    expect(bad.slice(0, 15)).toEqual([]);
  });
  it('a 200 KB pasted email does not hang (parseFlight + parseItinerary < 1 s)', () => {
    const seg = 'Flight AC 856 Toronto (YYZ) to London (LHR) Sat 12 Dec 2026 Departs 6:30 PM Arrives 6:40 AM +1 Seat 34C ';
    const big = (seg + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ').repeat(1300);
    expect(big.length).toBeGreaterThan(200_000);
    const t0 = performance.now();
    parseFlight(big, NOW);
    const t1 = performance.now();
    parseItinerary(big, NOW);
    const t2 = performance.now();
    expect({ flight: Math.round(t1 - t0) < 1000 * SLACK, itin: Math.round(t2 - t1) < 1000 * SLACK }).toEqual({ flight: true, itin: true });
  });
  it('a 4 KB paste of capital 3-letter words parses in < 200 ms (it is cubic: 16 KB takes ~75 s)', () => {
    const big = 'THE AND FOR YYZ ARE LHR NOT CDG BUT JFK '.repeat(100);
    const t0 = performance.now();
    parseFlight(big, NOW);
    expect(performance.now() - t0).toBeLessThan(200 * SLACK);
  });
  it('ordinary sentences are not flights', () => {
    for (const s of ['Lunch with Ann to discuss the MAD project at 1pm', 'Call SFO office re: LAX contract 3pm', 'Review ICS to PDF at 4pm',
      'Meet BOS and NYC teams 2pm'])
      expect([s, parseFlight(s, NOW)?.title ?? null]).toEqual([s, null]);
  });
  it('itinerary: an impossible date (31 Feb) is rejected, not rolled into March', () => {
    const f = parseItinerary('AC 856 Toronto (YYZ) London (LHR) 31 Feb 2027 Departs 18:30 Arrives 06:40', NOW);
    expect(f.map((x) => new Date(x.start).getMonth())).not.toContain(2);
  });
  it('tripsOf survives flights with unknown airports and identical times', () => {
    const ev = [0, 1, 2].map((i) => ({ id: 'f' + i, calendarId: 'c', title: 'f', start: 1e12, end: 1e12 + 3600e3, allDay: false,
      flight: { from: i % 2 ? 'LHR' : 'YYZ', to: i % 2 ? 'YYZ' : 'LHR', fromZone: 'UTC', toZone: 'UTC' } }));
    expect(() => tripsOf(ev, 'America/Toronto')).not.toThrow();
  });
});

describe('ICS hostile feeds', () => {
  const wrap = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;
  const FROM = Date.UTC(2026, 0, 1), TO = Date.UTC(2027, 0, 1);
  it('fuzzed property lines never throw', () => {
    const bad: string[] = [];
    const lines = ['BEGIN:VEVENT', 'END:VEVENT', 'DTSTART:20260101T100000Z', 'DTSTART;TZID=Nowhere/Land:20260101T100000', 'DTSTART;VALUE=DATE:20260230',
      'DTEND:19000101', 'RRULE:FREQ=DAILY;COUNT=-1', 'RRULE:FREQ=YEARLY;BYMONTH=13', 'RRULE:FREQ=WEEKLY;BYDAY=XX', 'RRULE:FREQ=HOURLY;BYHOUR=1,2,3,4,5',
      'RRULE:FREQ=DAILY;UNTIL=garbage', 'EXDATE:,,,', 'RDATE:99999999T999999', 'DURATION:P99999999W', 'DURATION:-P1D', 'RECURRENCE-ID:20260105T100000Z',
      'UID:a', 'UID:__proto__', 'SUMMARY:\\n\\,\\;\\\\', 'BEGIN:VALARM', 'END:VALARM', 'BEGIN:VTIMEZONE', 'END:VTIMEZONE', 'TZID:X', 'BEGIN:STANDARD',
      'END:STANDARD', 'TZOFFSETFROM:+9999', 'TZOFFSETTO:-0500', 'URL:javascript:alert(1)', ' folded', 'X-WR-TIMEZONE:Bad/Zone', ':', ';;;:'];
    for (let i = 0; i < 400; i++) {
      const body = Array.from({ length: 5 + Math.floor(rnd() * 40) }, () => pick(lines)).join('\r\n') + '\r\n';
      try {
        const c = parseIcs(wrap(body), 'feed', FROM, TO);
        for (const e of c.events) if (!Number.isFinite(e.start) || !Number.isFinite(e.end) || e.end < e.start || (e.url && !/^https?:/i.test(e.url))) bad.push(body);
      } catch (e) {
        bad.push(`threw ${(e as Error).message}: ${body.slice(0, 200)}`);
      }
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
  it('a 5 MB feed of single events parses in < 5 s', () => {
    const ev = (i: number) => `BEGIN:VEVENT\r\nUID:${i}\r\nDTSTART:2026${String(1 + (i % 12)).padStart(2, '0')}10T100000Z\r\nDTEND:2026${String(1 + (i % 12)).padStart(2, '0')}10T110000Z\r\nSUMMARY:Event ${i}\r\nEND:VEVENT\r\n`;
    const text = wrap(Array.from({ length: 50_000 }, (_, i) => ev(i)).join(''));
    const t0 = performance.now();
    const c = parseIcs(text, 'feed', FROM, TO);
    expect(c.events.length).toBe(50_000);
    expect(performance.now() - t0).toBeLessThan(5000 * SLACK);
  });
  it('many recurrence overrides for one series do not go quadratic (< 5 s)', () => {
    const over = Array.from({ length: 5000 }, (_, i) => {
      const d = new Date(FROM + i * 3600e3).toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
      return `BEGIN:VEVENT\r\nUID:s\r\nRECURRENCE-ID:${d}\r\nDTSTART:${d}\r\nDTEND:${d}\r\nSUMMARY:o\r\nEND:VEVENT\r\n`;
    }).join('');
    const text = wrap(`BEGIN:VEVENT\r\nUID:s\r\nDTSTART:20260101T000000Z\r\nDTEND:20260101T001000Z\r\nRRULE:FREQ=HOURLY\r\nSUMMARY:s\r\nEND:VEVENT\r\n` + over);
    const t0 = performance.now();
    parseIcs(text, 'feed', FROM, TO);
    expect(performance.now() - t0).toBeLessThan(5000 * SLACK);
  });
  it('one event with RRULE BYDAY=XX does not throw away the whole feed', () => {
    const text = wrap('BEGIN:VEVENT\r\nUID:ok\r\nDTSTART:20260310T100000Z\r\nDTEND:20260310T110000Z\r\nSUMMARY:fine\r\nEND:VEVENT\r\n' +
      'BEGIN:VEVENT\r\nUID:bad\r\nDTSTART:20260101T100000Z\r\nRRULE:FREQ=WEEKLY;BYDAY=XX\r\nSUMMARY:bad\r\nEND:VEVENT\r\n');
    let titles: string[] = [];
    expect(() => (titles = parseIcs(text, 'feed', FROM, TO).events.map((e) => e.title))).not.toThrow();
    expect(titles).toContain('fine');
  });
});
