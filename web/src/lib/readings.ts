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

export interface Reading {
  id: string;
  label: string; // what this one means, shortly: "Thursdays 8–10 PM"
  parsed: Parsed;
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
export function readings(text: string, calendars: CalendarSource[], now = new Date(), max = 3): Reading[] {
  const base = parseQuick(text, calendars, now);
  if (!text.trim() || base.deadline) return [];
  const out: Reading[] = [];
  const add = (id: string, label: string, parsed: Parsed) => {
    if (out.length >= max || out.some((r) => r.id === id)) return;
    if (parsed.start === base.start && parsed.end === base.end && parsed.allDay === base.allDay && JSON.stringify(parsed.recurrence) === JSON.stringify(base.recurrence) && parsed.timeZone === base.timeZone) return;
    out.push({ id, label, parsed });
  };

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

  // "tomorrow" said late at night usually means the day that starts after sleeping — today, if it's past midnight
  if (now.getHours() < 4 && /\btomorrow\b|\btmrw?\b/i.test(text)) {
    const p = { ...base, start: base.start - 86_400_000, end: base.end - 86_400_000 };
    if (startOfDay(p.start).getTime() === startOfDay(now).getTime()) add('today', `Today · ${when(p).replace(/^\w+ \w+ \d+ · /, '')}`, p);
  }
  return out;
}
