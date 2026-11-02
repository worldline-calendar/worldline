// Records that come from outside this app's own actions — a saved file at load, a backup, another device through
// sync — are checked here before the app uses them. Anything the views rely on is repaired (a missing list becomes
// empty, a broken repeat rule is dropped); a record that can't be repaired is left out. A malformed record must never
// make the app crash on every launch.
import type { CalEvent, CalendarSource, Recurrence } from './types';
import type { Booking, BookingLink, PollResponse } from '../lib/booking';
import type { Task } from '../lib/tasks';
import type { Habit } from '../lib/habits';
import type { DocNode, Idea, LogEntry, Pin, Project, Thread } from '../lib/projects';

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const str = (x: unknown): x is string => typeof x === 'string';
const nums = (x: unknown) => (Array.isArray(x) ? x.filter(num) : []);
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];

/** A repeat rule as the app reads it, or undefined (it's dropped: the event shows once). Only the fields the app
 *  knows are kept. */
export function cleanRecurrence(r: unknown): Recurrence | undefined {
  if (!isObj(r) || !FREQS.includes(r.freq as string)) return undefined;
  const interval = num(r.interval) && r.interval >= 1 ? Math.min(Math.round(r.interval), 1000) : 1;
  const byDay = Array.isArray(r.byDay) ? [...new Set(r.byDay.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : undefined;
  return { freq: r.freq as Recurrence['freq'], interval, ...(byDay ? { byDay } : {}), ...(num(r.until) ? { until: r.until } : {}) };
}

/** A web address that's safe to open from a link: http(s) only (never `javascript:` or `data:`). */
export const webUrl = (x: unknown): string | undefined => (str(x) && /^https?:\/\/\S/i.test(x.trim()) ? x.trim() : undefined);

const TEXT = ['location', 'notes', 'timeZone', 'seriesId', 'linkedTo', 'bookedVia'] as const;
const NUMS = ['createdAt', 'originalStart', 'leadDays'] as const;

/** An event the views can show, or null. */
export function cleanEvent(e: unknown): CalEvent | null {
  if (!isObj(e) || !str(e.id) || !str(e.calendarId) || !num(e.start) || !num(e.end)) return null;
  const fine =
    e.recurrence === undefined && e.exdates === undefined && str(e.title) && e.end >= e.start &&
    (e.url === undefined || webUrl(e.url) === e.url) &&
    TEXT.every((k) => e[k] === undefined || str(e[k])) && NUMS.every((k) => e[k] === undefined || num(e[k])) &&
    (e.kind === undefined || e.kind === 'deadline' || e.kind === 'task');
  if (fine) return e as unknown as CalEvent; // (the usual case: nothing to repair)
  const out = { ...e } as Record<string, unknown>;
  out.title = str(out.title) ? out.title : out.title == null ? '' : String(out.title);
  if ((out.end as number) < (out.start as number)) out.end = out.start;
  if (out.url !== undefined) out.url = webUrl(out.url);
  for (const k of TEXT) if (out[k] !== undefined && !str(out[k])) out[k] = undefined;
  for (const k of NUMS) if (out[k] !== undefined && !num(out[k])) out[k] = undefined;
  if (out.kind !== undefined && out.kind !== 'deadline' && out.kind !== 'task') out.kind = undefined;
  if (out.recurrence !== undefined) out.recurrence = cleanRecurrence(out.recurrence);
  if (out.exdates !== undefined) out.exdates = nums(out.exdates);
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as CalEvent;
}

const cleanBooking = (b: unknown): Booking | null =>
  isObj(b) && str(b.id) && num(b.start) && num(b.end) ? ({ ...b, name: str(b.name) ? b.name : '', createdAt: num(b.createdAt) ? b.createdAt : 0 } as unknown as Booking) : null;
const cleanResponse = (r: unknown): PollResponse | null =>
  isObj(r) && str(r.id) ? { id: r.id, name: str(r.name) ? r.name : '', cells: nums(r.cells), updatedAt: num(r.updatedAt) ? r.updatedAt : 0 } : null;

/** A scheduling link the app can show and answer for, or null. */
export function cleanLink(l: unknown): BookingLink | null {
  if (!isObj(l) || !str(l.id)) return null;
  const n = (k: string, d: number, ok = (x: number) => x >= 0) => (num(l[k]) && ok(l[k] as number) ? (l[k] as number) : d);
  const nostr = isObj(l.nostr) && str(l.nostr.sk) && str(l.nostr.secret) && /^[0-9a-f]{64}$/.test(l.nostr.sk) ? l.nostr : undefined;
  const decisions = isObj(l.decisions) ? Object.fromEntries(Object.entries(l.decisions).filter(([, d]) => isObj(d) && str(d.id) && str(d.status) && num(d.start))) : undefined;
  return {
    ...(l as unknown as BookingLink),
    mode: l.mode === 'poll' ? 'poll' : 'book',
    title: str(l.title) ? l.title : '',
    hostName: str(l.hostName) ? l.hostName : '',
    durationMin: n('durationMin', 30, (x) => x >= 5 && x <= 24 * 60),
    ...(l.days !== undefined ? { days: nums(l.days).filter(Number.isInteger) } : {}),
    firstDay: n('firstDay', 0, () => true),
    lastDay: n('lastDay', 0, () => true),
    weekdays: nums(l.weekdays).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
    windowStart: n('windowStart', 9 * 60, (x) => x >= 0 && x <= 1440),
    windowEnd: n('windowEnd', 17 * 60, (x) => x >= 0 && x <= 2 * 1440),
    timeZone: str(l.timeZone) && l.timeZone ? l.timeZone : 'UTC',
    blockingCalendars: Array.isArray(l.blockingCalendars) ? l.blockingCalendars.filter(str) : [],
    calendarId: str(l.calendarId) ? l.calendarId : '',
    bufferMin: n('bufferMin', 0),
    noticeMin: n('noticeMin', 0),
    createdAt: n('createdAt', 0),
    bookings: Array.isArray(l.bookings) ? (l.bookings.map(cleanBooking).filter(Boolean) as Booking[]) : [],
    responses: Array.isArray(l.responses) ? (l.responses.map(cleanResponse).filter(Boolean) as PollResponse[]) : [],
    nostr: nostr as BookingLink['nostr'],
    decisions: decisions as BookingLink['decisions'],
  };
}

/** Clean a list (keeping each record as it is when nothing needs repairing, so unchanged records stay the same). */
export const cleanList = <T,>(list: unknown, clean: (x: unknown) => T | null): T[] =>
  Array.isArray(list) ? (list.map(clean).filter((x) => x !== null) as T[]) : [];

// ---- the rest of what sync brings in: each record is kept as it is when it's well formed (so unchanged records
//      stay the same object), repaired when a field the views rely on is the wrong type, and left out without an id.

/** Repair `o`'s fields: each rule says whether a value is fine and what to use instead (undefined: drop the field). */
function repair<T>(o: Record<string, unknown>, rules: Record<string, [(v: unknown) => boolean, unknown]>): T {
  let out: Record<string, unknown> | null = null;
  for (const [k, [ok, d]] of Object.entries(rules)) {
    if (ok(o[k])) continue;
    out ??= { ...o };
    if (d === undefined) delete out[k];
    else out[k] = d;
  }
  return (out ?? o) as T;
}
const opt = (test: (v: unknown) => boolean) => (v: unknown) => v === undefined || test(v);
const bool = (x: unknown) => typeof x === 'boolean';
const isDoc = (x: unknown): x is DocNode => isObj(x) && str(x.type);
const list = <T,>(test: (x: unknown) => boolean) => (x: unknown): x is T[] => Array.isArray(x) && x.every(test);

export function cleanTask(t: unknown): Task | null {
  if (!isObj(t) || !str(t.id)) return null;
  return repair<Task>(t, {
    title: [str, str(t.title) ? t.title : ''], due: [opt(num), undefined], done: [opt(bool), undefined],
    doneAt: [opt(num), undefined], createdAt: [num, 0], parentId: [opt(str), undefined],
  });
}

export function cleanHabit(h: unknown): Habit | null {
  if (!isObj(h) || !str(h.id)) return null;
  return repair<Habit>(h, {
    title: [str, ''], color: [str, '#888888'], kind: [(x) => ['check', 'count', 'avoid'].includes(x as string), 'check'],
    goal: [(x) => num(x) && x >= 0, 1], period: [(x) => x === 'day' || x === 'week', 'day'],
    unit: [opt(str), undefined], match: [opt(str), undefined], archived: [opt(bool), undefined], createdAt: [num, 0],
  });
}

const okPin = (p: unknown) => isObj(p) && str(p.id) && str(p.label) && str(p.href);
const okIdea = (i: unknown) => isObj(i) && str(i.id) && str(i.text) && num(i.at);
export function cleanProject(p: unknown): Project | null {
  if (!isObj(p) || !str(p.id)) return null;
  return repair<Project>(p, {
    title: [str, ''], color: [str, '#888888'], about: [opt(str), undefined], doc: [opt(isDoc), undefined],
    pins: [opt(list<Pin>(okPin)), Array.isArray(p.pins) ? p.pins.filter(okPin) : undefined],
    ideas: [opt(list<Idea>(okIdea)), Array.isArray(p.ideas) ? p.ideas.filter(okIdea) : undefined],
    archived: [opt(bool), undefined], createdAt: [num, 0],
  });
}

export function cleanThread(t: unknown): Thread | null {
  if (!isObj(t) || !str(t.id) || !str(t.projectId)) return null;
  return repair<Thread>(t, {
    title: [str, ''], status: [(x) => x === 'active' || x === 'done', 'active'], body: [opt(isDoc), undefined],
    createdAt: [num, 0], updatedAt: [num, num(t.createdAt) ? t.createdAt : 0], doneAt: [opt(num), undefined],
  });
}

export const cleanLogEntry = (e: unknown): LogEntry | null =>
  isObj(e) && str(e.id) && str(e.parentId) && isDoc(e.doc) && num(e.at) ? (e as unknown as LogEntry) : null;

export function cleanCalendar(c: unknown): CalendarSource | null {
  if (!isObj(c) || !str(c.id) || !str(c.name)) return null;
  return repair<CalendarSource>(c, {
    color: [str, '#888888'], visible: [bool, true], account: [str, 'Local'], url: [opt(str), undefined],
    lastSync: [opt(num), undefined], syncError: [opt(str), undefined], autoName: [opt(bool), undefined], alerts: [opt(bool), undefined],
    mac: [opt((m) => isObj(m) && str(m.id) && str(m.host) && bool(m.writable)), undefined],
  });
}

/** habit id → day → value: only plain keys (never `__proto__` and the like) and values of the right type. */
export function cleanNested<V>(m: unknown, ok: (v: unknown) => v is V): Record<string, Record<number, V>> {
  const out: Record<string, Record<number, V>> = {};
  if (!isObj(m)) return out;
  let same = true;
  for (const [k, inner] of Object.entries(m)) {
    if (!safeKey(k) || !isObj(inner)) { same = false; continue; }
    const row: Record<number, V> = {};
    let rowSame = true;
    for (const [d, v] of Object.entries(inner)) {
      if (/^-?\d+$/.test(d) && ok(v)) row[Number(d)] = v;
      else rowSame = false;
    }
    out[k] = rowSame ? (inner as Record<number, V>) : row;
    same &&= rowSame;
  }
  return same ? (m as Record<string, Record<number, V>>) : out;
}
export const safeKey = (k: string) => k !== '__proto__' && k !== 'constructor' && k !== 'prototype';
export const isNum = num;
export const isStr = str;
