import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';

/** Live inner size of an element (excludes scrollbars). */
export function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      setSize((s) =>
        s.width === el.clientWidth && s.height === el.clientHeight
          ? s
          : { width: el.clientWidth, height: el.clientHeight },
      );
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** Current time, refreshed every `ms` — on the clock's own boundaries (a new minute shows on the minute), and at once
 *  after the Mac wakes from sleep or the app comes back to the front (timers stop while it sleeps; waiting for the
 *  next tick showed the time before the sleep for up to a minute). One shared second-by-second check for every user. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let shown = Date.now();
    const check = (force: boolean) => {
      const t = Date.now();
      if (force || Math.floor(t / ms) !== Math.floor(shown / ms)) setNow((shown = t));
    };
    return onClockTick(check);
  }, [ms]);
  return now;
}

// ---- the shared clock: one 1-second timer; a jump in time (sleep, or the system clock set) tells every user at once
type Listener = (force: boolean) => void;
const listeners = new Set<Listener>();
let timer: ReturnType<typeof setInterval> | undefined;
let last = 0;
const tick = (force = false) => {
  const t = Date.now();
  const jumped = Math.abs(t - last - 1000) > 2500; // asleep, or the clock was changed
  last = t;
  for (const l of [...listeners]) l(force || jumped);
};
const wake = () => document.visibilityState !== 'hidden' && tick(true);
function onClockTick(l: Listener) {
  listeners.add(l);
  if (!timer) {
    last = Date.now();
    timer = setInterval(() => tick(), 1000);
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('pageshow', wake);
  }
  return () => {
    listeners.delete(l);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = undefined;
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('pageshow', wake);
    }
  };
}

export function useMediaQuery(q: string) {
  const [match, setMatch] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setMatch(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [q]);
  return match;
}

/** (tests: the shared clock without React) */
export const __onClockTick = onClockTick;
