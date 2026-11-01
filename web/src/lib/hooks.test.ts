// The clock the views show catches up at once after the Mac sleeps (timers don't run meanwhile), not at the next tick.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSettings } from '../data/settings';

afterEach(() => vi.useRealTimers());

describe('useNow’s shared clock', () => {
  it('tells its users at once when time jumps (asleep), otherwise only when their interval rolls over', async () => {
    const listeners: Record<string, (() => void)[]> = {};
    Object.assign(globalThis, {
      document: { visibilityState: 'visible', addEventListener: (k: string, f: () => void) => (listeners[k] ??= []).push(f), removeEventListener() {} },
      window: { addEventListener: (k: string, f: () => void) => (listeners[k] ??= []).push(f), removeEventListener() {} },
    });
    vi.useFakeTimers({ now: new Date(2026, 10, 1, 9, 0, 10) });
    vi.resetModules();
    // (the hook's clock, without React: subscribe the way useNow does)
    const mod = await import('./hooks');
    const seen: boolean[] = [];
    const off = mod.__onClockTick((f) => seen.push(f));
    expect(off).toBeTypeOf('function');
    vi.advanceTimersByTime(3000);
    expect(seen.filter(Boolean)).toHaveLength(0); // an ordinary second: no forced update
    vi.setSystemTime(Date.now() + 40 * 60_000); // the lid was shut for 40 minutes
    vi.advanceTimersByTime(1000);
    expect(seen.at(-1)).toBe(true);
    listeners.focus?.forEach((f) => f());
    expect(seen.at(-1)).toBe(true);
    off!();
  });
});

describe('deadline rows on the calendar', () => {
  it('a setting, 4 to start with, kept within reason', () => {
    expect(normalizeSettings({}).deadlineRows).toBe(4);
    expect(normalizeSettings({ deadlineRows: 8 }).deadlineRows).toBe(8);
    expect(normalizeSettings({ deadlineRows: 0 }).deadlineRows).toBe(4);
    expect(normalizeSettings({ deadlineRows: 'lots' }).deadlineRows).toBe(4);
  });
});
