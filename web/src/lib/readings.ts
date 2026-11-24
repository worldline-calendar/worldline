// Other ways to read what was typed. Quick add shows its best reading; when a sentence could reasonably mean something
// else, these are offered beside it, one tap each — "Telescope time weekly on Thursdays" is all day, or an evening slot;
// "gym at 7" is 7 PM, or 7 AM; "next friday" is the one after this, or this one. Worked out here, on the device, from
// the sentence itself: nothing is sent anywhere.
import { format, startOfDay } from 'date-fns';
import type { CalendarSource } from '../data/types';
import { parseQuick, type Parsed } from './quickparse';
import { describeRecurrence } from './recurrence';
import { fmtTime } from './format';
import { localZone, zoneCity } from './zone';

type Kind = 'event' | 'task' | 'deadline';

export interface Reading {
  id: string;
  label: string; // what this one means, shortly: "Thursdays 8–10 PM"
  parsed: Parsed;
  kind?: 'event' | 'task' | 'deadline'; // (another kind of thing altogether: "as a task", "as a deadline")
}

const MIN = 60_000;
const at = (t: number, minutes: number) => {
  const d = new Date(t);
  d.setHours(0, minutes, 0, 0);
  return d.getTime();
};
const when = (p: Parsed) =>
  p.allDay
    ? `${format(p.start, 'EEE MMM d')} · all day`
    : `${format(p.start, 'EEE MMM d')} · ${fmtTime(p.start)}${p.end > p.start ? `–${fmtTime(p.end)}` : ''}`;
const repeatOr = (p: Parsed, s: string) => (p.recurrence ? describeRecurrence(p.recurrence, p.start) : s);

/** Up to `max` other readings of `text`, most likely first (none when the sentence is clear). */
export function readings(text: string, calendars: CalendarSource[], now = new Date(), max = 3, kind: Kind = 'event'): Reading[] {
  const base = parseQuick(text, calendars, now);
  if (!text.trim()) return [];
  const out: Reading[] = [];
  const add = (id: string, label: string, parsed: Parsed, as?: Kind) => {
    if (out.length >= max || out.some((r) => r.id === id)) return;
    if (!as && parsed.start === base.start && parsed.end === base.end && parsed.allDay === base.allDay && JSON.stringify(parsed.recurrence) === JSON.stringify(base.recurrence) && parsed.timeZone === base.timeZone) return;
    out.push({ id, label, parsed, ...(as ? { kind: as } : {}) });
  };
  const day = (t: number) => format(t, 'EEE MMM d');

  if (kind !== 'event') {
    // a deadline or a to-do: the other weekday reading, and the other kind of thing
    const next = /\bnext\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i.exec(text);
    if (next) {
      const p = parseQuick(text.replace(next[0], next[0].replace(/^next\s+/i, 'this ')), calendars, now);
      if (p.start < base.start) add('this', `This ${format(p.start, 'EEEE')}${kind === 'deadline' ? ` · due ${fmtTime(p.start)}` : ''}`, p, kind);
    }
    if (kind === 'deadline') add('as-task', `A to-do · due ${day(base.start)}`, base, 'task');
    if (kind === 'task' && base.hasDay) {
      if (/\b(?:by|before|due)\b/i.test(text)) add('as-deadline', `A deadline · ${day(base.start)}`, { ...base, deadline: base.deadline ?? { leadDays: 7 } }, 'deadline');
      const allDay = { ...base, allDay: true, start: startOfDay(base.start).getTime(), end: startOfDay(base.start).getTime() + 86_400_000 };
      add('as-event', `An event · ${base.hasTime ? when(base) : `${day(base.start)} · all day`}`, base.hasTime ? base : allDay, 'event');
    } else if (kind === 'task' && (base.hasTime || base.timeFromWords)) add('as-event', `An event · ${when(base)}`, base, 'event');
    titleVariants(text, base, kind, add);
    return out;
  }

  // a bare hour read as PM ("at 7" → 7 PM): or the morning — and 8–11 read as AM: or the evening
  if (base.hasTime && !/\b\d{1,2}(:\d{2})?\s*(a|p)\.?m?\b|\bnoon\b|\bmidnight\b|\b\d{1,2}:\d{2}\b/i.test(text)) {
    const h = new Date(base.start).getHours();
    const flip = h >= 12 ? -12 : 12;
    const p = { ...base, start: base.start + flip * 60 * MIN, end: base.end + flip * 60 * MIN };
    add('ampm', `${repeatOr(p, format(p.start, 'EEE MMM d'))} · ${fmtTime(p.start)}`, p);
  }

  // "next friday": the Friday after this one — or this one
  const next = /\bnext\s+(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i.exec(text);
  if (next) {
    const p = parseQuick(text.replace(next[0], next[0].replace(/^next\s+/i, 'this ')), calendars, now);
    if (p.start < base.start) add('this', `This ${format(p.start, 'EEEE')} · ${when(p).replace(/^\w+ /, '')}`, p);
  }

  // a whole day with no time said: or a time slot on it (an evening for things that happen at night)
  if (base.allDay && !base.hasTime) {
    const night = /\b(telescope|observ\w*|night|evening|dinner|concert|show|party|game)\b/i.test(text);
    const startMin = night ? 20 * 60 : 9 * 60;
    const len = night ? 120 : 60;
    const s = at(base.start, startMin);
    const p: Parsed = { ...base, allDay: false, start: s, end: s + len * MIN, hasTime: true, timeFromWords: true };
    add('timed', `${repeatOr(p, format(p.start, 'EEE MMM d'))} · ${fmtTime(p.start)}–${fmtTime(p.end)}`, p);
    if (!night) {
      const e = at(base.start, 20 * 60);
      const q: Parsed = { ...p, start: e, end: e + 120 * MIN };
      add('evening', `${repeatOr(q, format(q.start, 'EEE MMM d'))} · ${fmtTime(q.start)}–${fmtTime(q.end)}`, q);
    }
  }

  // "this weekend" / "sat or sun": the other day
  if (/\bweekend\b|\bsat(?:urday)?\s+or\s+sun(?:day)?\b/i.test(text) && new Date(base.start).getDay() === 6) {
    const p = { ...base, start: base.start + 86_400_000, end: base.end + 86_400_000 };
    add('sunday', `Sunday · ${when(p).replace(/^\w+ /, '')}`, p);
  }

  // "every second friday": every other week — or the second Friday of each month (and the other way round)
  const r0 = base.recurrence;
  if (r0 && r0.byDay?.length === 1 && ((r0.freq === 'weekly' && r0.interval === 2) || (r0.freq === 'monthly' && r0.nth === 2)) && /\b(?:second|2nd)\b/i.test(text)) {
    const swapped = r0.freq === 'weekly' ? `${text} of the month` : text.replace(/\b(?:second|2nd)\b/i, 'other');
    const p = parseQuick(swapped, calendars, now);
    if (p.recurrence) add('second', describeRecurrence(p.recurrence, p.start), { ...p, title: base.title });
  }

  // a time guessed from a word ("christmas dinner" → 6:30, "brunch" → 11): or the whole day
  if (!base.allDay && base.timeFromWords && !base.hasTime && !base.recurrence) {
    const d0 = startOfDay(base.start).getTime();
    add('all-day', `${day(base.start)} · all day`, { ...base, allDay: true, start: d0, end: d0 + 86_400_000, timeFromWords: false });
  }
  // a number at the end that might be an hour ("lab 2"): or a time
  const tail = /\b([1-9]|1[0-2])\s*$/.exec(text.trim());
  if (tail && !base.hasTime) {
    const p = parseQuick(`${text.trim().slice(0, -tail[0].length)} at ${tail[1]}`, calendars, now);
    if (p.hasTime) add('tail-hour', `${when(p)}`, { ...p }, undefined);
  }

  // a repeat: or just once (the first one)
  if (base.recurrence) add('once', `Just once · ${when(base)}`, { ...base, recurrence: undefined, repeatDays: undefined });
  // monthly on a weekday ("first Monday") vs on that date
  if (base.recurrence?.nth) {
    const { nth: _n, byDay: _b, ...r } = base.recurrence;
    void _n; void _b;
    const p = { ...base, recurrence: { ...r } };
    add('monthly-date', describeRecurrence(p.recurrence, p.start), p);
  }

  // someone else's clock ("9am Tokyo time"): or this device's
  if (base.timeZone) {
    const p = parseQuick(text.replace(/\b(?:in\s+)?[A-Za-z][\w .'-]*?\s+time\b/i, ' '), calendars, now);
    add('local', `${fmtTime(p.start)} ${zoneCity(localZone())} time`, { ...p, title: base.title });
  }

  // an event on a day that reads like a to-do ("clean the garage saturday"): or a to-do for that day
  if (!base.recurrence && base.allDay && /^(?:e-?mail|call|buy|get|order|pay|book|renew|cancel|submit|send|finish|write|clean|fix|pick up|drop off|return|prep|prepare|grade|review|read|print|file|sign)\b/i.test(text.trim()))
    add('as-task', `A to-do · due ${day(base.start)}`, base, 'task');

  titleVariants(text, base, kind, add);

  // "tomorrow" said late at night usually means the day that starts after sleeping — today, if it's past midnight
  if (now.getHours() < 4 && /\btomorrow\b|\btmrw?\b/i.test(text)) {
    const p = { ...base, start: base.start - 86_400_000, end: base.end - 86_400_000 };
    if (startOfDay(p.start).getTime() === startOfDay(now).getTime()) add('today', `Today · ${when(p).replace(/^\w+ \w+ \d+ · /, '')}`, p);
  }
  return out;
}

/** The same thing under another name, when a word the reader took out may belong in it: the place ("Soccer at Trinity
 *  Bellwoods"), the deadline word ("Arxiv submission cutoff"), the part of the day ("Evening run"), how often ("Weekly
 *  sync"), the weekday ("Sunday brunch"). */
function titleVariants(text: string, base: Parsed, kind: Kind, add: (id: string, label: string, p: Parsed, as?: Kind) => void) {
  const titled = (t: string) => `Titled “${t}”`;
  const has = (w: string) => new RegExp(`\\b${w}\\b`, 'i').test(base.title);
  if (base.location && !/^\d|zqx/i.test(base.location)) {
    const t = `${base.title} ${/^(?:the|room|rm)\b|'s\b/i.test(base.location) || /^[a-z]/.test(base.location) ? 'at' : 'in'} ${base.location}`;
    add('title-loc', titled(t), { ...base, title: t, location: undefined }, kind);
  }
  const dl = /\b(deadline|cut-?off|closes|due)\b/i.exec(text);
  if (kind === 'deadline' && dl && !has(dl[1])) add('title-dl', titled(`${base.title} ${dl[1].toLowerCase()}`), { ...base, title: `${base.title} ${dl[1].toLowerCase()}` }, kind);
  const part = /\b(morning|afternoon|evening|night)\s+(\w+)/i.exec(text);
  if (part && !has(part[1]) && base.title.toLowerCase().startsWith(part[2].toLowerCase())) {
    const t = `${part[1][0].toUpperCase()}${part[1].slice(1).toLowerCase()} ${base.title[0].toLowerCase()}${base.title.slice(1)}`;
    add('title-part', titled(t), { ...base, title: t }, kind);
  }
  const freq = /\b(daily|weekly|monthly|biweekly|annual|yearly)\s+(\w+)/i.exec(text);
  if (freq && !has(freq[1]) && base.title.toLowerCase().startsWith(freq[2].toLowerCase())) {
    const t = `${freq[1][0].toUpperCase()}${freq[1].slice(1).toLowerCase()} ${base.title[0].toLowerCase()}${base.title.slice(1)}`;
    add('title-freq', titled(t), { ...base, title: t }, kind);
  }
  const wd = /^\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\w+)/i.exec(text);
  if (wd && !has(wd[1]) && base.title.toLowerCase().startsWith(wd[2].toLowerCase())) {
    const t = `${wd[1][0].toUpperCase()}${wd[1].slice(1).toLowerCase()} ${base.title[0].toLowerCase()}${base.title.slice(1)}`;
    add('title-wd', titled(t), { ...base, title: t }, kind);
  }
}
