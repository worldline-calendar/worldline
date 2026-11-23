// Phrases people actually type that quick add used to misread (persona reviews, Nov 2026).
import { describe, expect, it } from 'vitest';
import { format } from 'date-fns';
import { parseQuick } from './quickparse';
import { describeRecurrence } from './recurrence';
import { DEFAULT_CALENDARS } from '../data/mock';

const NOW = new Date(2026, 10, 23, 10); // Mon Nov 23 2026, 10 AM (Toronto in CI's TZ-independent checks below)
const p = (s: string) => parseQuick(s, DEFAULT_CALENDARS, NOW);
const rep = (s: string) => { const x = p(s); return x.recurrence ? describeRecurrence(x.recurrence, x.start) : 'once'; };

describe('repeats people type', () => {
  it('"repeating" is a word about repeating, not part of the title', () => {
    const x = p('Telescope time repeating weekly on Thursdays');
    expect(x.title).toBe('Telescope time');
    expect(rep('Telescope time repeating weekly on Thursdays')).toBe('Weekly on Thursday');
    expect(p('standup recurring every weekday 9:15').title).toBe('Standup');
  });
  it('several weekdays: lists, slashes and timetable codes', () => {
    for (const [s, days] of [
      ['gym mwf 7am', 'Monday, Wednesday and Friday'],
      ['lecture ASTR 320 mon wed fri 10-11am until dec 12', 'Monday, Wednesday and Friday'],
      ['tutorial tues/thurs 2pm', 'Tuesday and Thursday'],
      ['seminar TR 3:30pm', 'Tuesday and Thursday'],
      ['lab tue & thu 1-4pm', 'Tuesday and Thursday'],
    ] as const) {
      expect(rep(s), s).toContain(days);
      expect(p(s).title, s).not.toMatch(/\b(mwf|mon|wed|fri|tues?|thurs?|TR|until)\b/i);
    }
    expect(p('lecture ASTR 320 mon wed fri 10-11am until dec 12').recurrence?.until).toBeDefined();
    expect(p('gym mwf 7am').title).toBe('Gym');
  });
  it('a single weekday is still a date', () => {
    expect(p('dentist mon 9am').recurrence).toBeUndefined();
  });
  it('nth weekday of the month', () => {
    const x = p('Faculty meeting first monday of every month 12pm');
    expect(x.title).toBe('Faculty meeting');
    expect(rep('Faculty meeting first monday of every month 12pm')).toBe('Monthly on the first Monday');
    expect(format(x.start, 'EEE MMM d h a')).toBe('Mon Dec 7 12 PM');
    expect(rep('colloquium last friday of the month 3pm')).toBe('Monthly on the last Friday');
    expect(rep('committee every 2nd tuesday 10am')).toBe('Monthly on the second Tuesday');
    expect(p('dinner the first monday in december').recurrence).toBeUndefined();
  });
  it('a length without a time is a block, not a whole day', () => {
    const x = p('read papers 30 min every day');
    expect(x.allDay).toBe(false);
    expect((x.end - x.start) / 60_000).toBe(30);
    expect(x.title).toBe('Read papers');
    expect(p('write 2h friday').allDay).toBe(false);
  });
});

describe('another place\'s clock', () => {
  it('"9am Tokyo time" is 9 AM in Tokyo', () => {
    const x = p('call with collaborators 9am Tokyo time tomorrow');
    expect(x.title).toBe('Call with collaborators');
    expect(x.timeZone).toBe('Asia/Tokyo');
    const tokyo = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false }).format(x.start);
    expect(tokyo).toBe('09');
  });
  it('a city by its usual name, and places that aren\'t zones are left alone', () => {
    expect(p('vendor call 9am Taipei time tomorrow').timeZone).toBe('Asia/Taipei');
    expect(p('sync 10am New York time fri').timeZone).toBe('America/New_York');
    expect(p('family time saturday 4pm').timeZone).toBeUndefined();
    expect(p('family time saturday 4pm').title).toBe('Family time');
  });
});
