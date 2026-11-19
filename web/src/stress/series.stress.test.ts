// Stress: recurring-series edits and untrusted series records.
import { describe, expect, it } from 'vitest';
import { expand } from '../lib/recurrence';
import { removeEvent, updateEvent } from '../lib/mutate';
import { cleanEvent } from '../data/validate';
import type { CalEvent } from '../data/types';

const t = (m: number, d: number, h: number, min = 0) => new Date(2026, m, d, h, min).getTime();
let n = 0;
const newId = () => `new${n++}`;
const weekly: CalEvent = { id: 's', calendarId: 'c', title: 'Standup', start: t(8, 7, 10), end: t(8, 7, 11), allDay: false,
  recurrence: { freq: 'weekly', interval: 1, byDay: [1] } }; // Mondays 10:00 from Sep 7 2026
const win = (ev: CalEvent[]) => expand(ev, t(8, 1, 0), t(11, 1, 0));

describe('scope "all" after deleting/editing single occurrences', () => {
  it('a deleted occurrence stays deleted when the whole series moves 30 minutes later', () => {
    const occ = win([weekly]).find((e) => e.start === t(8, 21, 10))!; // Sep 21
    let ev = removeEvent([weekly], occ.id, 'this');
    expect(win(ev).filter((e) => e.start >= t(8, 21, 0) && e.start < t(8, 22, 0))).toHaveLength(0);
    const other = win(ev).find((e) => e.start === t(8, 28, 10))!;
    ev = updateEvent(ev, other.id, { start: t(8, 28, 10, 30), end: t(8, 28, 11, 30) }, 'all', newId).events;
    expect(win(ev).filter((e) => e.start >= t(8, 21, 0) && e.start < t(8, 22, 0))).toHaveLength(0);
  });
  it('an edited ("this") occurrence is not duplicated when the whole series moves a day', () => {
    const occ = win([weekly]).find((e) => e.start === t(8, 21, 10))!;
    let ev = updateEvent([weekly], occ.id, { title: 'Special' }, 'this', newId).events;
    const other = win(ev).find((e) => e.start === t(8, 28, 10))!;
    ev = updateEvent(ev, other.id, { start: t(8, 29, 10), end: t(8, 29, 11) }, 'all', newId).events;
    const week = win(ev).filter((e) => e.start >= t(8, 21, 0) && e.start < t(8, 28, 0));
    expect(week.map((e) => e.title)).toEqual(['Special']);
  });
});

describe('untrusted series (sync/backup) can hang expansion', () => {
  it('a daily series with an ancient start and huge length shows one week in < 1 s with few events', () => {
    // (dropped as damaged — or, if kept, repaired so it can't flood or hang the view)
    const evil = cleanEvent({ id: 'x', calendarId: 'c', title: 'x', start: -8e14, end: 8e14, allDay: false, recurrence: { freq: 'daily', interval: 1 } });
    if (!evil) return;
    const t0 = performance.now();
    let count = 0;
    try { count = expand([evil], t(9, 5, 0), t(9, 12, 0)).length; } catch { /* */ }
    const ms = performance.now() - t0;
    expect({ fast: ms < 1000, few: count < 1000 }).toEqual({ fast: true, few: true });
  });
});

describe('a kept series with a huge length is cut to a year', () => {
  it('stays fast and sparse', () => {
    const e = cleanEvent({ id: 'y', calendarId: 'c', title: 'y', start: t(0, 1, 0), end: t(0, 1, 0) + 5e11, allDay: false, recurrence: { freq: 'daily', interval: 1 } })!;
    expect(e.end - e.start).toBeLessThanOrEqual(366 * 86_400_000);
    const t0 = performance.now();
    const n = expand([e], t(9, 5, 0), t(9, 12, 0)).length;
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(n).toBeLessThan(400);
  });
});
