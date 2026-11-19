// Pure edits on the event list that understand recurring series.
//   scope 'this' on an occurrence → an exception for that date only
//   scope 'following' on an occurrence → the series splits there: the old one ends before it, a new one (with the
//                     change) starts from it — "from January the meeting moves rooms", without rewriting the past
//   scope 'all'  on an occurrence → the whole series (the master) changes
import type { CalEvent } from '../data/types';
import { decodeEvent, encodeEvent, isOccurrenceId, occurrenceId, resolveEvent, splitOccurrenceId } from './recurrence';
import { encodeDay, epochDay, instantOf, wallClock } from './zone';

// Edits work on events as shown (all-day ones as local midnights) and store them back encoded.
const toLocal = (events: CalEvent[]) => events.map(decodeEvent);
const toStored = (events: CalEvent[]) => events.map(encodeEvent);

export type Scope = 'this' | 'following' | 'all';

/** Weekdays (0 = Sunday) moved by `days`: [1, 3] + 1 → [2, 4]. */
export const rotateDays = (byDay: number[], days: number) => byDay.map((d) => (((d + days) % 7) + 7) % 7);

/** Apply `patch` to event `id`. Returns the new list and the id the edited event now has. */
export function updateEvent(stored: CalEvent[], id: string, patch: Partial<CalEvent>, scope: Scope, newId: () => string) {
  const r = updateLocal(toLocal(stored), id, patch, scope, newId);
  return { events: toStored(r.events), id: r.id };
}

function updateLocal(events: CalEvent[], id: string, patch: Partial<CalEvent>, scope: Scope, newId: () => string) {
  if (!isOccurrenceId(id)) return { events: events.map((e) => (e.id === id ? { ...e, ...patch } : e)), id };

  const occ = resolveEvent(events, id);
  if (!occ) return { events, id };
  const { masterId, start: original } = splitOccurrenceId(id);

  if (scope === 'following') {
    const split = splitSeries(events, masterId, occ, newId);
    if (!split) return updateLocal(events, id, patch, 'all', newId); // (the first occurrence: that's the whole series)
    return updateLocal(split.events, split.id, patch, 'all', newId);
  }

  if (scope === 'all') {
    const master = events.find((e) => e.id === masterId)!;
    const mp: Partial<CalEvent> = { ...patch };
    if (patch.start !== undefined || patch.end !== undefined) {
      // The whole series moves as this occurrence moved, counted on the series' own clock: so many calendar days and
      // so many minutes of wall-clock time (not milliseconds: across a daylight-saving change a day isn't 24 hours).
      const tz = master.allDay ? undefined : master.timeZone;
      const newStart = patch.start ?? occ.start, newEnd = patch.end ?? occ.end;
      const a = wallClock(occ.start, tz), b = wallClock(newStart, tz), m = wallClock(master.start, tz);
      const days = epochDay(b.y, b.m, b.d) - epochDay(a.y, a.m, a.d);
      const minutes = b.h * 60 + b.min - (a.h * 60 + a.min);
      mp.start = days || minutes ? instantOf(m.y, m.m, m.d + days, m.h * 60 + m.min + minutes, tz) : master.start;
      if (master.allDay) {
        // all-day: as many days long as the occurrence now is
        const e = wallClock(newEnd), s = wallClock(newStart);
        mp.end = new Date(m.y, m.m, m.d + days + Math.max(1, epochDay(e.y, e.m, e.d) - epochDay(s.y, s.m, s.d))).getTime();
      } else mp.end = mp.start + (newEnd - newStart);
      // A weekly series on set weekdays moves its weekdays too (Mon + Wed, a day later → Tue + Thu).
      const r = master.recurrence;
      if (patch.recurrence === undefined && r?.freq === 'weekly' && r.byDay?.length && days % 7) mp.recurrence = { ...r, byDay: rotateDays(r.byDay, days) };
      // Skipped dates and changed occurrences are named by their original start: they move with the series, or a
      // deleted one would come back at the new time and a changed one would show twice.
      if (days || minutes) {
        const shift = (t: number) => {
          if (master.allDay) return t + days * 86_400_000; // (day keys: UTC midnights)
          const w = wallClock(t, tz);
          return instantOf(w.y, w.m, w.d + days, w.h * 60 + w.min + minutes, tz);
        };
        if (master.exdates?.length) mp.exdates = master.exdates.map(shift);
        const moved = events.map((e) => (e.seriesId === masterId && e.originalStart !== undefined ? { ...e, originalStart: shift(e.originalStart) } : e));
        const next = moved.map((e) => (e.id === masterId ? { ...e, ...mp } : e));
        return { events: next, id: occurrenceId(masterId, master.allDay ? encodeDay(patch.start ?? occ.start) : patch.start ?? occ.start) };
      }
    }
    const next = events.map((e) => (e.id === masterId ? { ...e, ...mp } : e));
    const newStart = patch.start ?? occ.start;
    return { events: next, id: occurrenceId(masterId, master.allDay ? encodeDay(newStart) : newStart) };
  }

  const exceptionId = newId();
  const exception: CalEvent = {
    ...occ,
    ...patch,
    id: exceptionId,
    seriesId: masterId,
    originalStart: original,
    recurrence: undefined,
    exdates: undefined,
  };
  const next = events.map((e) => (e.id === masterId ? { ...e, exdates: [...(e.exdates ?? []), original] } : e));
  return { events: [...next, exception], id: exceptionId };
}

/** Remove event `id`: one occurrence (skip that date) or, with scope 'all', the whole series. */
export function removeEvent(stored: CalEvent[], id: string, scope: Scope): CalEvent[] {
  return toStored(removeLocal(toLocal(stored), id, scope));
}

function removeLocal(events: CalEvent[], id: string, scope: Scope): CalEvent[] {
  if (isOccurrenceId(id)) {
    const { masterId, start } = splitOccurrenceId(id);
    if (scope === 'all') return removeSeries(events, masterId);
    if (scope === 'following') {
      const occ = resolveEvent(events, id);
      return occ ? endLocal(events, masterId, occ.start) : events;
    }
    return events.map((e) => (e.id === masterId ? { ...e, exdates: [...(e.exdates ?? []), start] } : e));
  }
  const ev = events.find((e) => e.id === id);
  if (ev?.recurrence) return removeSeries(events, id);
  if (ev?.seriesId && scope === 'all') return removeSeries(events, ev.seriesId);
  return events.filter((e) => e.id !== id);
}

function removeSeries(events: CalEvent[], masterId: string) {
  return events.filter((e) => e.id !== masterId && e.seriesId !== masterId);
}

/** Stop a series from `at` onward; past occurrences stay. A series that hasn't started is removed. */
export function endSeries(stored: CalEvent[], masterId: string, at: number): CalEvent[] {
  const events = toLocal(stored);
  const master = events.find((e) => e.id === masterId);
  if (!master?.recurrence) return stored;
  return toStored(endLocal(events, masterId, at));
}
function endLocal(events: CalEvent[], masterId: string, at: number): CalEvent[] {
  const master = events.find((e) => e.id === masterId);
  if (!master?.recurrence) return events;
  if (master.start >= at) return removeSeries(events, masterId);
  // (an all-day series stores this as its last day: see recurrence.ts)
  return events
    .filter((e) => !(e.seriesId === masterId && e.start >= at)) // drop future exceptions too
    .map((e) => (e.id === masterId ? { ...e, recurrence: { ...e.recurrence!, until: at - 1 } } : e));
}

/** Split a series at occurrence `occ`: the old series ends just before it, a copy starts there (its later exceptions
 *  and skipped dates go with it). Returns the copy's occurrence id for `occ`, or null when `occ` is the first one. */
function splitSeries(events: CalEvent[], masterId: string, occ: CalEvent, newId: () => string) {
  const master = events.find((e) => e.id === masterId);
  if (!master?.recurrence || occ.start <= master.start) return null;
  const at = occ.start;
  const id = newId();
  const fresh: CalEvent = {
    ...master,
    id,
    start: occ.start,
    end: occ.start + (master.end - master.start),
    exdates: master.exdates?.filter((x) => x >= (master.allDay ? encodeDay(at) : at)),
    ext: undefined, // (a new series: not yet in the Calendar app)
  };
  if (!fresh.exdates?.length) delete fresh.exdates;
  delete fresh.ext;
  const moved = events.map((e) => {
    if (e.id === masterId) return { ...e, recurrence: { ...e.recurrence!, until: at - 1 } };
    if (e.seriesId === masterId && (e.originalStart ?? e.start) >= (e.allDay ? encodeDay(at) : at)) return { ...e, seriesId: id };
    return e;
  });
  return { events: [...moved, fresh], id: occurrenceId(id, master.allDay ? encodeDay(at) : at) };
}
