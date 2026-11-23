import { describe, expect, it } from 'vitest';
import { AIRPORTS } from './airports';
import { dayShift, flightTimes, parseFlight, tripsOf } from './flights';
import type { CalEvent } from '../data/types';

const NOW = new Date(2026, 10, 18, 12); // Wed Nov 18 2026
const at = (iso: string) => new Date(iso).getTime();

describe('airports', () => {
  it('every zone is one this device knows', () => {
    for (const a of AIRPORTS.values()) expect(() => new Intl.DateTimeFormat('en', { timeZone: a.zone }), a.code).not.toThrow();
  });
});

describe('typing a flight', () => {
  it('reads each time on its own airport’s clock', () => {
    const p = parseFlight('AC 856 YYZ 6:40pm → LHR 6:55am dec 12', NOW)!;
    expect(p.flight).toMatchObject({ no: 'AC 856', from: 'YYZ', to: 'LHR', fromZone: 'America/Toronto', toZone: 'Europe/London' });
    expect(p.start).toBe(at('2026-12-12T23:40:00Z')); // 6:40 PM EST
    expect(p.end).toBe(at('2026-12-13T06:55:00Z')); // 6:55 AM GMT, the next day
    expect(p.title).toBe('AC 856 to London');
    expect(dayShift(p, p.flight)).toBe(1);
    expect(flightTimes(p, p.flight)).toBe('6:40 PM YYZ → 6:55 AM LHR +1');
  });

  it('takes other ways of writing it', () => {
    const a = parseFlight('yyz to lhr dec 12 18:40 - 06:55', NOW)!;
    expect(a.end - a.start).toBe(7.25 * 3_600_000);
    const b = parseFlight('flight LHR-YYZ dec 19 11:15am 2:05pm', NOW)!;
    expect(b.start).toBe(at('2026-12-19T11:15:00Z'));
    expect(b.end).toBe(at('2026-12-19T19:05:00Z'));
    expect(b.flight.no).toBeUndefined();
    const c = parseFlight('NH 7 SFO 11:25am → NRT 3:35pm +1 jan 4', NOW)!;
    expect(c.end - c.start).toBe(11 * 3_600_000 + 10 * 60_000);
  });

  it('crosses the date line backwards', () => {
    const p = parseFlight('NZ 2 AKL 7:30pm → LAX 10:45am dec 1', NOW)!; // lands the same calendar morning in LA
    expect(p.end).toBeGreaterThan(p.start);
    expect(dayShift(p, p.flight)).toBe(0);
    expect((p.end - p.start) / 3_600_000).toBeCloseTo(12.25);
  });

  it('leaves ordinary sentences alone', () => {
    for (const s of ['lunch with the team at 1pm', 'mad dash to den at 3pm', 'call Sam fri 2pm', 'Den meeting to plan 3pm']) expect(parseFlight(s, NOW), s).toBeNull();
  });
});

describe('trips', () => {
  const fl = (id: string, from: string, to: string, fz: string, tz: string, s: string, e: string): CalEvent =>
    ({ id, calendarId: 'c', title: id, start: at(s), end: at(e), allDay: false, flight: { from, to, fromZone: fz, toZone: tz } });
  it('a stay runs from landing until the flight back; a connection is not a stay', () => {
    const evs = [
      fl('out', 'YYZ', 'FRA', 'America/Toronto', 'Europe/Berlin', '2026-12-12T23:00:00Z', '2026-12-13T07:00:00Z'),
      fl('hop', 'FRA', 'ATH', 'Europe/Berlin', 'Europe/Athens', '2026-12-13T09:00:00Z', '2026-12-13T12:00:00Z'),
      fl('back', 'ATH', 'YYZ', 'Europe/Athens', 'America/Toronto', '2026-12-20T09:00:00Z', '2026-12-20T20:00:00Z'),
    ];
    const t = tripsOf(evs, 'America/Toronto');
    expect(t).toEqual([{ id: 'hop', city: 'Athens', zone: 'Europe/Athens', start: at('2026-12-13T12:00:00Z'), end: at('2026-12-20T09:00:00Z'), open: false }]);
  });
});

import { flightLine, readFlightLine } from './macCalendars';
describe('through the Calendar app', () => {
  it('a flight keeps its airports in a last line of the notes, and gets them back', () => {
    const f = { no: 'AC 856', from: 'YYZ', to: 'LHR', fromZone: 'America/Toronto', toZone: 'Europe/London' };
    expect(readFlightLine(`Seat 32A\n\n${flightLine(f)}`)).toEqual({ notes: 'Seat 32A', flight: f });
    expect(readFlightLine(flightLine({ ...f, no: undefined } as never)).flight).toMatchObject({ from: 'YYZ', to: 'LHR' });
    expect(readFlightLine('just notes')).toEqual({ notes: 'just notes' });
  });
});

import { parseItinerary } from './flights';
describe('a pasted confirmation email', () => {
  it('finds every segment, each on its own clock', () => {
    const email = `Booking confirmation ABC123
      Flight 1   AC 856   Sat 12 Dec 2026
      Toronto (YYZ)  Departs 18:40   →   London Heathrow (LHR)  Arrives 06:55 +1
      Operated by Air Canada · Economy
      Flight 2   AC 857   Sat 19 Dec 2026
      London Heathrow (LHR)  Departs 11:15   →   Toronto (YYZ)  Arrives 14:05
      Baggage: 1 x 23kg`;
    const fs = parseItinerary(email, NOW);
    expect(fs.map((f) => [f.flight.no, f.flight.from, f.flight.to])).toEqual([['AC 856', 'YYZ', 'LHR'], ['AC 857', 'LHR', 'YYZ']]);
    expect(fs[0].start).toBe(at('2026-12-12T23:40:00Z'));
    expect(fs[0].end).toBe(at('2026-12-13T06:55:00Z'));
    expect(fs[1].end).toBe(at('2026-12-19T19:05:00Z'));
  });
  it('reads US-style dates and 12-hour times, and skips repeated segments', () => {
    const email = 'UA 901 San Francisco (SFO) to Frankfurt (FRA) December 3, 2026 3:55 PM - 11:50 AM. ' +
      'Your trip: UA 901 SFO FRA December 3, 2026 3:55 PM 11:50 AM. LH 1280 FRA 1:20 PM → ATH 5:15 PM Dec 4';
    const fs = parseItinerary(email, NOW);
    expect(fs.map((f) => f.flight.no)).toEqual(['UA 901', 'LH 1280']);
    expect((fs[0].end - fs[0].start) / 3_600_000).toBeCloseTo(10.9166, 3);
    expect(fs[1].flight.toZone).toBe('Europe/Athens');
  });
});

describe('a flight line copied from an email', () => {
  it('keeps its written date (no arrow between the airports)', () => {
    const f = parseFlight('Tue 13 Jan 2027 Toronto (YYZ) 07:45 - Phoenix (PHX) 10:32', NOW)!;
    expect(f).not.toBeNull();
    expect(f.start).toBe(at('2027-01-13T12:45:00Z')); // 7:45 EST
    expect(f.end).toBe(at('2027-01-13T17:32:00Z')); // 10:32 MST
  });
});
