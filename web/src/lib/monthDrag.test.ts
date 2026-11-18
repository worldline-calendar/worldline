// Pinned to Toronto (Nov 1 2026 is a 25-hour day) so the DST case means the same on every machine.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { moveByDays } from './monthDrag';

const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const hostTz = env.TZ;
beforeAll(() => { env.TZ = 'America/Toronto'; });
afterAll(() => { if (hostTz === undefined) delete env.TZ; else env.TZ = hostTz; });

const t = (m: number, d: number, h = 0, min = 0) => new Date(2026, m, d, h, min).getTime();
const H = 3600_000;

describe('moveByDays', () => {
  it('keeps a 9 AM event at 9 AM across the November DST change, and its length', () => {
    const r = moveByDays({ start: t(9, 30, 9), end: t(9, 30, 10, 30), allDay: false }, 3);
    expect(new Date(r.start).getHours()).toBe(9);
    expect(new Date(r.start).getDate()).toBe(2);
    expect(r.end - r.start).toBe(1.5 * H);
    expect(r.start - t(9, 30, 9)).toBe(73 * H); // one 25-hour day in between
  });
  it('moves backwards across the March change too (a deadline: start = end)', () => {
    const r = moveByDays({ start: t(2, 10, 9), end: t(2, 10, 9), allDay: false }, -4);
    expect(r.start).toBe(t(2, 6, 9));
    expect(r.start - t(2, 10, 9)).toBe(-(4 * 24 - 1) * H);
    expect(r.end).toBe(r.start);
  });
  it('keeps an all-day event as many days long', () => {
    expect(moveByDays({ start: t(9, 30), end: t(10, 2), allDay: true }, 2)).toEqual({ start: t(10, 1), end: t(10, 4) });
  });
  it('zero days is no change', () => {
    const ev = { start: t(5, 1, 14), end: t(5, 1, 15), allDay: false };
    expect(moveByDays(ev, 0)).toEqual({ start: ev.start, end: ev.end });
  });
});
