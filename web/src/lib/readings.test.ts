import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { readings } from './readings';
import { DEFAULT_CALENDARS } from '../data/mock';

const NOW = new Date(2026, 10, 23, 10); // Mon Nov 23 2026, 10 AM
const r = (s: string) => readings(s, DEFAULT_CALENDARS, NOW);

describe('other readings', () => {
  it('an all-day repeat offers a time slot (an evening for telescope time) and just once', () => {
    const rs = r('Telescope time repeating weekly on Thursdays');
    expect(rs.map((x) => x.id)).toEqual(['timed', 'once']);
    expect(rs[0].parsed.allDay).toBe(false);
    expect(new Date(rs[0].parsed.start).getHours()).toBe(20);
    expect(rs[0].parsed.recurrence?.byDay).toEqual([4]);
    expect(rs[0].label).toMatch(/^Weekly on Thursday · 8 PM–10 PM$/);
  });
  it('a bare hour: PM, or AM', () => {
    const rs = r('gym at 7 tomorrow');
    expect(rs[0].id).toBe('ampm');
    expect(format(rs[0].parsed.start, 'h a')).toBe('7 AM');
    expect(r('gym at 7pm tomorrow').some((x) => x.id === 'ampm')).toBe(false);
  });
  it('"next friday": or this friday', () => {
    const rs = r('TA marking due next fri noon'.replace(' due', '')); // (an event; deadlines aren't second-guessed)
    const thisOne = rs.find((x) => x.id === 'this')!;
    expect(format(thisOne.parsed.start, 'EEE MMM d')).toBe('Fri Nov 27');
  });
  it('first Monday of the month: or monthly on that date; another zone: or here', () => {
    expect(r('faculty meeting first monday of every month 12pm').map((x) => x.id)).toContain('monthly-date');
    expect(r('call 9am Tokyo time tomorrow').map((x) => x.id)).toContain('local');
  });
  it('a clear sentence has nothing to offer', () => {
    expect(r('dentist tue nov 24 at 9:30am for 1h')).toEqual([]);
  });
});
