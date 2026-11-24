import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { describeRecurrence, expand } from './recurrence';
import { toIcs } from './icsExport';
import { cleanRecurrence } from '../data/validate';
import type { CalEvent } from '../data/types';

const t = (m: number, d: number, h = 9) => new Date(2027, m, d, h).getTime();
const series = (rec: CalEvent['recurrence'], start = t(0, 1)): CalEvent => ({ id: 's', calendarId: 'c', title: 'X', start, end: start + 3_600_000, allDay: false, recurrence: rec });
const days = (e: CalEvent, from = t(0, 1, 0), to = t(4, 1, 0)) => expand([e], from, to).map((o) => format(o.start, 'MMM d'));

describe('monthly on several days, the last day, several weeks', () => {
  it('1st and 15th', () => {
    expect(days(series({ freq: 'monthly', interval: 1, byMonthDay: [1, 15] }))).toEqual(['Jan 1', 'Jan 15', 'Feb 1', 'Feb 15', 'Mar 1', 'Mar 15', 'Apr 1', 'Apr 15']);
  });
  it('the last day — 31, 28, 31, 30', () => {
    expect(days(series({ freq: 'monthly', interval: 1, byMonthDay: [-1] }, t(0, 31)))).toEqual(['Jan 31', 'Feb 28', 'Mar 31', 'Apr 30']);
  });
  it('2nd and 4th Monday', () => {
    expect(days(series({ freq: 'monthly', interval: 1, byDay: [1], nths: [2, 4] }, t(0, 11)), t(0, 1, 0), t(2, 1, 0))).toEqual(['Jan 11', 'Jan 25', 'Feb 8', 'Feb 22']);
  });
  it('described, exported, and checked when synced', () => {
    expect(describeRecurrence({ freq: 'monthly', interval: 1, byMonthDay: [15, -1] }, t(0, 15))).toBe('Monthly on the 15th and last day');
    const ics = toIcs('T', [series({ freq: 'monthly', interval: 1, byDay: [4], nths: [1, 3] }, t(0, 7))]);
    expect(ics).toContain('RRULE:FREQ=MONTHLY;BYDAY=1TH,3TH');
    expect(toIcs('T', [series({ freq: 'monthly', interval: 1, byMonthDay: [1, -1] })])).toContain('BYMONTHDAY=1,-1');
    expect(cleanRecurrence({ freq: 'monthly', interval: 1, byMonthDay: [0, 40, 15, 'x'], nths: [9], byDay: [1] })).toEqual({ freq: 'monthly', interval: 1, byDay: [1], byMonthDay: [15] });
  });
});
