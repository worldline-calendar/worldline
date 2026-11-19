// Stress: records from sync / backups that pass validation but break the app.
import { describe, expect, it } from 'vitest';
import { cleanEvent, cleanProject } from '../data/validate';
import { expand } from '../lib/recurrence';
import { wallClock } from '../lib/zone';

const FROM = new Date(2026, 9, 1).getTime(), TO = new Date(2026, 10, 1).getTime();

describe('validation lets through values that throw later', () => {
  it('an event whose timeZone is not a real zone is repaired or dropped, so expanding never throws', () => {
    const e = cleanEvent({ id: 'x', calendarId: 'c', title: 'x', start: FROM + 3600e3, end: FROM + 7200e3, allDay: false, timeZone: 'Not/AZone',
      recurrence: { freq: 'weekly', interval: 1 } });
    expect(() => (e ? expand([e], FROM, TO) : [])).not.toThrow(); // RangeError: Invalid time zone specified
  });
  it('a synced homeZone that is not a real zone would throw wherever it is used (EventPanel.tsx:343)', () => {
    // store.ts:407 and cleanSynced only check typeof === 'string'
    expect(() => wallClock(FROM, 'Not/AZone')).not.toThrow();
  });
  it('a project pin with a javascript: href is dropped (Projects.tsx:89 renders it as <a href>)', () => {
    const p = cleanProject({ id: 'p', title: 'p', color: '#000', createdAt: 0, pins: [{ id: 'a', label: 'docs', href: 'javascript:alert(document.cookie)' }] })!;
    expect((p.pins ?? []).map((x) => x.href)).toEqual([]);
  });
});
