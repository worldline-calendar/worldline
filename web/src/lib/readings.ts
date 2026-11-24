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
import { ACTION } from './tasks';
import { typoDistance } from './fuzzy';

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
  // Every reading that could be meant is collected with how likely it is, then the likeliest few are offered (the same
  // reading reached two ways counts once, at its likelier weight).
  const all: (Reading & { w: number; order: number })[] = [];
  const add = (id: string, label: string, parsed: Parsed, as?: Kind) => {
    if (all.some((r) => r.id === id)) return;
    const k = as ?? kind;
    if (k === kind && parsed.start === base.start && parsed.end === base.end && parsed.allDay === base.allDay && parsed.title === base.title &&
      JSON.stringify(parsed.recurrence) === JSON.stringify(base.recurrence) && parsed.timeZone === base.timeZone && parsed.location === base.location) return;
    const same = all.find((r) => (r.kind ?? kind) === k && r.parsed.start === parsed.start && r.parsed.end === parsed.end && r.parsed.title === parsed.title &&
      r.parsed.allDay === parsed.allDay && JSON.stringify(r.parsed.recurrence) === JSON.stringify(parsed.recurrence));
    const w = WEIGHT[id.replace(/-\d+$/, '')] ?? 0.3;
    if (same) { same.w = Math.max(same.w, w); return; }
    all.push({ id, label, parsed, ...(as ? { kind: as } : {}), w, order: all.length });
  };
  const finish = () => all.sort((a, b) => b.w - a.w || a.order - b.order).slice(0, max).map(({ w: _w, order: _o, ...r }) => r);
  const out = { get length() { return all.length; } };
  void out;
  const day = (t: number) => format(t, 'EEE MMM d');
  moreReadings(text, base, kind, calendars, now, add);

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
      const allDay = base.allDay ? base : { ...base, allDay: true, start: startOfDay(base.start).getTime(), end: startOfDay(base.start).getTime() + 86_400_000 };
      add('as-event', `An event · ${base.hasTime ? when(base) : `${day(base.start)} · all day`}`, base.hasTime ? base : allDay, 'event');
    } else if (kind === 'task' && (base.hasTime || base.timeFromWords)) add('as-event', `An event · ${when(base)}`, base, 'event');
    titleVariants(text, base, kind, add);
    return finish();
  }

  // a bare hour read as PM ("at 7" → 7 PM): or the morning — and 8–11 read as AM: or the evening
  if (base.hasTime && !/\b\d{1,2}(:\d{2})?\s*(a|p)\.?m?\b|\bnoon\b|\bmidnight\b|\b(?:1[3-9]|2[0-3]|0\d):\d{2}\b/i.test(text)) {
    const h = new Date(base.start).getHours();
    const flip = h >= 12 ? -12 : 12;
    let p = { ...base, start: base.start + flip * 60 * MIN, end: base.end + flip * 60 * MIN };
    // (no day said: the next time it's that hour — today if still ahead, else tomorrow)
    if (!base.hasDay) {
      while (p.start - 86_400_000 > now.getTime()) p = { ...p, start: p.start - 86_400_000, end: p.end - 86_400_000 };
      if (p.start <= now.getTime()) p = { ...p, start: p.start + 86_400_000, end: p.end + 86_400_000 };
    }
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

  // an event that reads like a to-do ("clean the garage saturday", "pay nanny every 2 weeks", "charge batteries tonight"):
  // or a to-do for that day
  if (base.allDay || base.recurrence || (base.timeFromWords && !base.hasTime)) {
    const verb = ACTION.test(text.trim()) || /^(?:photocopy|copy|transfer|invoice|backup|back up|change|replace|refill|pay|check|update|rake|laundry|grocer|clean|pack|mow|shovel|wash|vacuum)\b/i.test(text.trim());
    add(verb ? 'as-task' : 'as-task-weak', `A to-do · due ${day(base.start)}`, { ...base, recurrence: undefined }, 'task');
  }

  titleVariants(text, base, kind, add);

  // "tomorrow" said late at night usually means the day that starts after sleeping — today, if it's past midnight
  if (now.getHours() < 4 && /\btomorrow\b|\btmrw?\b/i.test(text)) {
    const p = { ...base, start: base.start - 86_400_000, end: base.end - 86_400_000 };
    if (startOfDay(p.start).getTime() === startOfDay(now).getTime()) add('today', `Today · ${when(p).replace(/^\w+ \w+ \d+ · /, '')}`, p);
  }
  return finish();
}

/** The same thing under another name, when a word the reader took out may belong in it: the place ("Soccer at Trinity
 *  Bellwoods"), the deadline word ("Arxiv submission cutoff"), the part of the day ("Evening run"), how often ("Weekly
 *  sync"), the weekday ("Sunday brunch"). */
function titleVariants(text: string, base: Parsed, kind: Kind, add: (id: string, label: string, p: Parsed, as?: Kind) => void) {
  const titled = (t: string) => `Titled “${t}”`;
  // a word the reader corrected ("Cofee" → "Coffee"): or as typed
  const typed = text.split(/\s+/);
  const asTyped = base.title.replace(/[A-Za-z]{4,}/g, (w) => {
    if (typed.some((x) => x.toLowerCase() === w.toLowerCase())) return w;
    const orig = typed.find((x) => /^[A-Za-z]+$/.test(x) && x.length >= 3 && typoDistance(x.toLowerCase(), w.toLowerCase()) <= 2);
    return orig ? (w[0] === w[0].toUpperCase() ? orig[0].toUpperCase() + orig.slice(1) : orig) : w;
  });
  if (asTyped !== base.title) add('title-typed', titled(asTyped), { ...base, title: asTyped }, kind);
  // an emoji that was typed ("🎻 quartet 8pm", "call grandma 📞"): kept in the name
  const emo = /\p{Extended_Pictographic}/u.exec(text);
  if (emo) {
    const t = text.trim().startsWith(emo[0]) ? `${emo[0]} ${base.title}` : `${base.title} ${emo[0]}`;
    add('title-emoji', titled(t), { ...base, title: t }, kind);
  }
  // leftovers of how it was said ("Or sun brunch w ali", "7 book club", "Lab meeting, no"): a tidied title
  const tidy = base.title
    .replace(/\b(?:or|no|just|wait|maybe|like|ish|and|then|also|um|uh)\b|\?|\b\d{1,2}\b(?!:)|\b(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day)?s?\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi, ' ')
    .replace(/\s*[,;]\s*$/, '').replace(/^\s*[,;]\s*/, '').replace(/\s+/g, ' ').trim();
  if (tidy && tidy.length >= 3 && tidy.toLowerCase() !== base.title.toLowerCase()) {
    const t = tidy[0].toUpperCase() + tidy.slice(1);
    add('title-tidy', titled(t), { ...base, title: t }, kind);
  }
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
    if (!base.allDay && base.timeFromWords && !base.hasTime) {
      const d0 = startOfDay(base.start).getTime();
      add('title-wd-allday', `${titled(t)} · all day`, { ...base, title: t, allDay: true, start: d0, end: d0 + 86_400_000 }, kind);
    }
  }
}

/** How likely each kind of other reading is, highest first: how often it was what someone meant, when offered, in the
 *  practice sentences (src/nlp — measured, not guessed; re-measure when readings change). */
const WEIGHT: Record<string, number> = {
  this: 0.7, 'title-typed': 0.64, 'title-expand': 0.62, 'title-wd-allday': 0.62, 'zone-city': 0.59, 'as-event': 0.55, len: 0.43,
  span: 0.42, ampm: 0.41, 'as-task': 0.38, second: 0.37, local: 0.36, 'title-emoji': 0.36, 'all-day': 0.35, today: 0.3,
  'midnight-next': 0.25, once: 0.24, 'title-tidy': 0.23, 'span-workweek': 0.19, 'span-week': 0.19, 'as-event-today': 0.19,
  'title-freq': 0.17, 'title-loc': 0.14, 'repeat-daily': 0.13, sunday: 0.13, 'repeat-weekly': 0.13, 'title-wd': 0.12,
  'len-block': 0.11, part: 0.1, 'span-weekend': 0.1, 'as-deadline': 0.1, 'monthly-date': 0.07, 'title-dl': 0.06,
  'as-task-weak': 0.05, 'tail-hour': 0.04, 'title-part': 0.03, timed: 0.03, evening: 0.003,
};

const PART_TIMES: [RegExp, number[]][] = [
  [/\bmorning\b|\bfirst thing\b/i, [8 * 60, 10 * 60, 7 * 60]],
  [/\bafternoon\b/i, [13 * 60, 15 * 60, 16 * 60]],
  [/\bevening\b/i, [19 * 60, 17 * 60, 20 * 60]],
  [/\btonight\b|\bnight\b/i, [20 * 60, 21 * 60, 18 * 60]],
  [/\blunch\b/i, [12 * 60 + 30, 13 * 60, 11 * 60 + 30]],
  [/\bdinner\b|\bsupper\b/i, [19 * 60, 18 * 60, 20 * 60]],
  [/\bbreakfast\b/i, [8 * 60, 9 * 60, 7 * 60]],
  [/\bbrunch\b/i, [10 * 60, 12 * 60, 10 * 60 + 30]],
];
const ABBREV: [RegExp, string][] = [
  [/\bw\/\s*/gi, 'with '], [/\bw\s+(?=[A-Z]|[a-z]+\b)/g, 'with '], [/\bappt\b/gi, 'appointment'], [/\bmtg\b/gi, 'meeting'], [/\bmtng\b/gi, 'meeting'],
  [/\bb-?day\b/gi, 'birthday'], [/\bconf\b/gi, 'conference'], [/\bpres\b/gi, 'presentation'], [/\bprof\b/gi, 'professor'], [/\bhr\b/g, 'HR'],
  [/\bdept\b/gi, 'department'], [/\bmgr\b/gi, 'manager'], [/\bdoc\b/gi, 'doctor'], [/\bdr\s+appt\b/gi, 'doctor appointment'], [/\bre:\s*/gi, 're: '],
];
const MEETINGISH = /\b(?:standup|stand-up|sync|meeting|mtg|class|lecture|practice|lessons?|club|service|seminar|tutorial|lab|office hours|1:1|check-?in|huddle|rehearsal|training|tutoring|choir|yoga|gym)\b/i;

/** The readings that come from the shape of the sentence: other times for a part of the day, a whole weekend or week,
 *  an expanded title, a weekly meeting, a deadline at the very start of the next day, the same time here. */
function moreReadings(text: string, base: Parsed, kind: Kind, calendars: CalendarSource[], now: Date, add: (id: string, label: string, p: Parsed, as?: Kind) => void) {
  const len = base.end - base.start;
  const at = (t: number, minutes: number) => { const d = new Date(t); d.setHours(0, minutes, 0, 0); return d.getTime(); };
  // a part of the day or a meal, with no clock time: its other likely hours
  if (base.timeFromWords && !base.hasTime && !base.allDay) {
    const pt = PART_TIMES.find(([re]) => re.test(text));
    for (const m of pt?.[1] ?? []) {
      const s0 = at(base.start, m);
      if (s0 === base.start) continue;
      const p = { ...base, start: s0, end: s0 + Math.max(len, kind === 'deadline' ? 0 : 3_600_000) };
      add(`part-${m}`, `${format(p.start, 'EEE MMM d')} · ${fmtTime(p.start)}`, p);
    }
  }
  // how long: "quick call" → 15 or 30 minutes; "long lunch" → 2 hours; "workshop afternoon" → the afternoon
  if (!base.allDay && kind === 'event' && !base.hasEnd) {
    if (/\b(?:quick|short|brief|break)\b/i.test(text)) {
      add('len-15', `${fmtTime(base.start)}–${fmtTime(base.start + 15 * MIN)} · 15 min`, { ...base, end: base.start + 15 * MIN });
      add('len-30', `${fmtTime(base.start)}–${fmtTime(base.start + 30 * MIN)} · 30 min`, { ...base, end: base.start + 30 * MIN });
    }
    if (/\b(?:movie|film|concert|show|game|play|match|opera|musical)\b/i.test(text)) {
      add('len-120', `${fmtTime(base.start)}–${fmtTime(base.start + 120 * MIN)} · 2 hours`, { ...base, end: base.start + 120 * MIN });
      add('len-180', `${fmtTime(base.start)}–${fmtTime(base.start + 180 * MIN)} · 3 hours`, { ...base, end: base.start + 180 * MIN });
    }
    if (/\blong\b/i.test(text)) add('len-120', `${fmtTime(base.start)}–${fmtTime(base.start + 120 * MIN)} · 2 hours`, { ...base, end: base.start + 120 * MIN });
    const block = /\bafternoon\b/i.test(text) ? [14, 17] : /\bmorning\b/i.test(text) ? [9, 12] : null;
    if (block && base.timeFromWords && !base.hasTime) {
      const s0 = at(base.start, block[0] * 60);
      add('len-block', `${format(s0, 'EEE MMM d')} · ${fmtTime(s0)}–${fmtTime(at(base.start, block[1] * 60))}`, { ...base, start: s0, end: at(base.start, block[1] * 60) });
    }
  }
  // a to-do with no day ("email Bart"): or something to do today; a timed chore ("call insurance at 2"): or a to-do
  if (kind === 'task' && !base.hasDay && !base.hasTime) {
    const d1 = startOfDay(now).getTime();
    add('as-event-today', `An event · today · all day`, { ...base, allDay: true, start: d1, end: d1 + 86_400_000 }, 'event');
  }
  if (kind === 'event' && base.hasTime && !base.recurrence && ACTION.test(text.trim())) add('as-task', `A to-do · due ${format(base.start, 'EEE MMM d')}`, base, 'task');
  // routines said with a time ("take meds at 8", "morning run 6:30", "standup at 9"): every day
  if (kind === 'event' && !base.recurrence && base.hasTime && /\b(?:meds|medication|pills?|vitamins?|insulin|run|walk|jog|meditat\w*|journal\w*|gym|workout|standup|stand-up|stretch\w*|dog walk)\b/i.test(text)) {
    const rule = { freq: 'daily' as const, interval: 1 };
    add('repeat-daily', describeRecurrence(rule, base.start), { ...base, recurrence: rule });
  }
  // a city in the title of a timed thing ("call Tokyo team 9am"): or that hour there
  if (!base.allDay && !base.timeZone && base.hasTime) {
    for (const w of base.title.match(/\b[A-Z][a-z]{3,}\b/g) ?? []) {
      const p = parseQuick(`${text} ${w} time`, calendars, now);
      if (p.timeZone) { add('zone-city', `${fmtTime(p.start)} here · ${w} time`, { ...p, title: base.title }); break; }
    }
  }
  // a standup or class with no repeat said: every weekday / every week
  if (!base.recurrence && kind === 'event' && /\b(?:standup|stand-up|scrum|huddle)\b/i.test(base.title) && !/\b(mon|tue|wed|thu|fri|sat|sun)/i.test(text)) {
    const rule = { freq: 'weekly' as const, interval: 1, byDay: [1, 2, 3, 4, 5] };
    add('repeat-weekly', describeRecurrence(rule, base.start), { ...base, recurrence: rule });
  }
  // "this weekend" / "next weekend": the whole weekend; "next week" / "this week": the working week, the whole week
  const d0 = startOfDay(base.start).getTime();
  if (/\bweekend\b/i.test(text) && new Date(base.start).getDay() === 6) {
    const p = { ...base, allDay: true, start: d0, end: d0 + 2 * 86_400_000 };
    add('span-weekend', `${format(d0, 'EEE MMM d')} – Sun · all weekend`, p);
  }
  if (/\b(?:this|next)\s+week\b(?!end)/i.test(text) && kind === 'event') {
    const mon = d0 - ((new Date(d0).getDay() + 6) % 7) * 86_400_000;
    add('span-workweek', `${format(mon, 'MMM d')} – Fri · all week`, { ...base, allDay: true, start: mon, end: mon + 5 * 86_400_000 });
    add('span-week', `${format(mon, 'MMM d')} – Sun · the whole week`, { ...base, allDay: true, start: mon, end: mon + 7 * 86_400_000 });
  }
  // an abbreviated title written out ("coffee w/ priya" → "Coffee with priya", "vet appt" → "Vet appointment")
  let ex = base.title;
  for (const [re, to] of ABBREV) ex = ex.replace(re, to);
  ex = ex.replace(/\s+/g, ' ').trim();
  if (ex !== base.title) add('title-expand', `Titled “${ex}”`, { ...base, title: ex });
  // a meeting-ish thing said with its weekday ("monday standup") or "daily": every week
  if (!base.recurrence && kind === 'event' && MEETINGISH.test(base.title)) {
    const daily = /\bdaily\b/i.test(text);
    const wd = /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i.test(text);
    if (daily || wd) {
      const rule = daily ? { freq: 'weekly' as const, interval: 1, byDay: [1, 2, 3, 4, 5] } : { freq: 'weekly' as const, interval: 1, byDay: [new Date(base.start).getDay()] };
      add('repeat-weekly', describeRecurrence(rule, base.start), { ...base, recurrence: rule });
    }
  }
  // a deadline at 11:59 PM: or the first minute of the next day (how some forms count "midnight")
  if (kind === 'deadline' && new Date(base.start).getHours() === 23 && new Date(base.start).getMinutes() === 59)
    add('midnight-next', `Due ${format(base.start + 60_000, 'EEE MMM d')} at 12 AM`, { ...base, start: base.start + 60_000, end: base.end + 60_000 });
  // "end of week": or Sunday
  if (kind === 'deadline' && /\bend of (?:the |this |next )?week\b/i.test(text) && new Date(base.start).getDay() === 5)
    add('span', `Due Sunday ${format(base.start + 2 * 86_400_000, 'MMM d')}`, { ...base, start: base.start + 2 * 86_400_000, end: base.end + 2 * 86_400_000 });
  // another zone written as an abbreviation ("3pm PST"): or this device's clock
  if (base.timeZone && !/\btime\b/i.test(text)) {
    const plain = text.replace(/\b(?:[A-Z]{2,5}T|UTC|GMT|pacific|eastern|central|mountain|atlantic)\b/g, ' ');
    const p = parseQuick(plain, calendars, now);
    if (!p.timeZone) add('local', `${fmtTime(p.start)} ${zoneCity(localZone())} time`, { ...p, title: base.title });
  }
}
