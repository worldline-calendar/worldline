// Month view drag: an item dropped some whole days away keeps its time of day (wall clock, so a 9 AM
// meeting moved across a daylight-saving change is still 9 AM) and its length.
import type { CalEvent } from '../data/types';
import { shiftWall } from './dates';

/** New start/end for `ev` moved by `days` calendar days. Timed events (and deadlines, start = end) keep their
 * length in real time; all-day events (and tasks) keep their length in days. */
export function moveByDays(ev: Pick<CalEvent, 'start' | 'end' | 'allDay'>, days: number): { start: number; end: number } {
  const start = shiftWall(ev.start, days);
  return { start, end: ev.allDay ? shiftWall(ev.end, days) : start + (ev.end - ev.start) };
}
