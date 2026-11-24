// Turns a typed or dictated sentence into an event, e.g.
//   "Lunch with Sam tomorrow 12:30 at Fran's #social for 90 min"
//
// Pipeline:
//   1. normalize   — clean dictation quirks and rewrite phrasings chrono-node misses
//                    ("sat 7", "11-1", "half past 3", "the 15th", "three pm", …)
//   2. extract     — #calendar, "for 2h" duration, "all day"
//   3. find dates  — chrono-node, ignoring weak matches (a bare month name like "June"
//                    is far more often a person); a separate date and time are combined
//   4. resolve     — apply human defaults: bare 1–7 means PM, "morning" means 9 AM,
//                    "lunch" means noon, a date with no time is all-day
//   5. location    — "at/in <Capitalized place>" or "@ place"; the rest is the title
import * as chrono from 'chrono-node';
import { addDays, addMonths, getDaysInMonth, isLeapYear, startOfDay } from 'date-fns';
import type { CalendarSource, Recurrence } from '../data/types';
import { MIN, dayIndex } from './dates';
import { fixDateTypos, typoDistance } from './fuzzy';
import { prefs } from './prefs';
import { ZONE_ABBR, ZONE_WORDS, zoneByName } from './zoneNames';
import { AIRPORTS } from './airports';
import { instantOf } from './zone';

export interface Parsed {
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  location?: string;
  calendarId?: string;
  hasDate: boolean;
  // Which parts the sentence actually specified (used when moving existing events):
  hasDay: boolean; // a date or weekday
  hasTime: boolean; // an explicit clock time
  timeFromWords: boolean; // a time implied by "morning", "lunch", …
  hasEnd: boolean; // an explicit end ("3-4pm") or length ("for 2h")
  recurrence?: Recurrence; // "every friday", "weekly", "every other tue and thu until dec 15"
  repeatDays?: number[]; // weekdays actually named in a repeat phrase ("on Fridays")
  deadline?: { leadDays: number }; // "due", "deadline", "by friday", "needs 3 weeks"
  timeZone?: string; // "9am Tokyo time": the times are on this zone's clock (a series repeats on it)
}

// ---- deadlines ---------------------------------------------------------------------------
const LEAD_NUM = '(\\d+|a|an|one|two|three|four|five|six|seven|eight|ten)';
const LEAD_UNIT = '(days?|weeks?|wks?|months?)';
const LEAD_RES = [
  new RegExp(`\\b(?:needs?|takes?|requires?|allow|give (?:it|myself|me))\\s+(?:about\\s+|~\\s*)?${LEAD_NUM}\\s*${LEAD_UNIT}(?:\\s+(?:of work|ahead|lead(?:\\s*time)?|runway))?\\b`, 'i'),
  new RegExp(`\\b(?:start|begin)\\s+${LEAD_NUM}\\s*${LEAD_UNIT}\\s+(?:before|ahead|early|out)\\b`, 'i'),
  new RegExp(`\\b${LEAD_NUM}\\s*${LEAD_UNIT}\\s+(?:of work|lead(?:\\s*time)?|runway)\\b`, 'i'),
];
const WORD_N: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10 };

/** "needs 3 weeks" → 21 (days of runway), removed from the text. */
function takeLead(t: string): [string, number | undefined] {
  for (const re of LEAD_RES) {
    const m = t.match(re);
    if (!m) continue;
    const n = WORD_N[m[1].toLowerCase()] ?? +m[1];
    const u = m[2].toLowerCase();
    return [t.replace(m[0], ' '), n * (u.startsWith('w') ? 7 : u.startsWith('m') ? 30 : 1)];
  }
  return [t, undefined];
}

// ---- repeats ----------------------------------------------------------------------------
const WD_NAMES: [RegExp, number][] = [
  [/^sun/i, 0], [/^mon/i, 1], [/^tue?/i, 2], [/^wed/i, 3], [/^th/i, 4], [/^fri/i, 5], [/^sat/i, 6],
];
const wdOf = (w: string) => WD_NAMES.find(([re]) => re.test(w))?.[1];
const WD = '(?:mon|tues?|tu|wed(?:nes)?|thu(?:rs?)?|th|fri|sat(?:ur)?|sun)(?:day)?';
const WD_LIST = `${WD}s?(?:(?:\\s*(?:,|and|&|\\+|/)\\s*|\\s+)${WD}s?)*`;
const MONTH_RE = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const UNIT_FREQ: Record<string, Recurrence['freq']> = { day: 'daily', week: 'weekly', month: 'monthly', year: 'yearly' };

interface RepeatInfo {
  text: string;
  rule?: Recurrence;
  byDayGiven: boolean;
  untilText?: string;
  times?: number; // "for 10 weeks" / "10 times"
  timesUnit?: 'occurrence' | 'week' | 'month' | 'day' | 'year';
}

/** Pull repeat phrases out of the sentence. Only words that clearly mean "repeat" are taken. */
function takeRepeat(input: string): RepeatInfo {
  let t = ` ${input} `;
  let rule: Recurrence | undefined;
  let byDayGiven = false;
  const set = (freq: Recurrence['freq'], interval = 1, byDay?: number[]) => {
    rule = { freq, interval, ...(byDay ? { byDay } : {}) };
    if (byDay) byDayGiven = true;
  };
  const days = (list: string) => [...new Set(list.split(/\s*(?:,|\band\b|&|\+|\/|\s)\s*/).map((w) => wdOf(w.trim())).filter((d): d is number => d !== undefined))].sort();
  const take = (re: RegExp, fn: (...m: string[]) => void) => {
    t = t.replace(re, (...m) => (fn(...(m as string[])), ' '));
  };

  // "repeating / recurring" say only that it repeats (how is said elsewhere, or it's weekly)
  let wantsRepeat = false;
  take(/\b(?:repeating|repeats?|recurring|recurrent)\b/i, () => (wantsRepeat = true));
  const ORD = '(first|1st|second|2nd|third|3rd|fourth|4th|last)';
  const ordN = (w: string) => (/last/i.test(w) ? -1 : /^(first|1)/i.test(w) ? 1 : /^(second|2)/i.test(w) ? 2 : /^(third|3)/i.test(w) ? 3 : 4);
  const DAYNUM = '(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?';
  const EACH_MONTH = '(?:of\\s+)?(?:each|every|the|a)\\s+month|monthly|a\\s+month';
  // "2nd and 4th monday(s)", "1st & 3rd thursdays of the month": several weeks of the month
  t = t.replace(new RegExp(`\\b(?:every\\s+|on\\s+)?(?:the\\s+)?${ORD}\\s*(?:,|and|&)\\s*(?:the\\s+)?${ORD}\\s+(${WD})s?(?:\\s+(?:${EACH_MONTH}))?\\b`, 'i'), (_, a: string, b: string, wd: string) => {
    rule = { freq: 'monthly', interval: 1, byDay: [wdOf(wd)!], nths: [...new Set([ordN(a), ordN(b)])].sort((x, y) => (x < 0 ? 9 : x) - (y < 0 ? 9 : y)) };
    byDayGiven = true;
    return ' ';
  });
  // "1st and 15th of each month", "the 15th and last day of the month", "last day of every month", "every 10th of the month",
  // "on the 20th monthly", "monthly on the 20th"
  if (!rule)
    t = t.replace(new RegExp(`\\b(?:on\\s+)?${DAYNUM}\\s*(?:,|and|&)\\s*(?:the\\s+)?(?:(\\d{1,2})(?:st|nd|rd|th)?|(last)(?:\\s+day)?)\\s+(?:${EACH_MONTH})\\b`, 'i'), (_, a: string, b?: string, last?: string) => {
      rule = { freq: 'monthly', interval: 1, byMonthDay: [+a, last ? -1 : +b!] };
      return ' ';
    });
  if (!rule)
    t = t.replace(new RegExp(`\\b(?:on\\s+)?(?:the\\s+)?last\\s+day\\s+(?:${EACH_MONTH})\\b|\\bend\\s+of\\s+(?:each|every)\\s+month\\b`, 'i'), () => {
      rule = { freq: 'monthly', interval: 1, byMonthDay: [-1] };
      return ' ';
    });
  if (!rule)
    t = t.replace(new RegExp(`\\b(?:every\\s+|on\\s+)?${DAYNUM}\\s+(?:${EACH_MONTH})\\b|\\bmonthly\\s+on\\s+${DAYNUM}\\b`, 'i'), (m: string, a?: string, b?: string) => {
      const d = +(a ?? b!);
      if (!(d >= 1 && d <= 31) || (!/\d(?:st|nd|rd|th)|\bthe\b|\bevery\b|\bon\b/i.test(m))) return m;
      rule = { freq: 'monthly', interval: 1, byMonthDay: [d] };
      return ' ';
    });
  if (!rule) take(/\bbi-?monthly\b|\bevery\s+(?:other|two|2)\s+months?\b/i, () => set('monthly', 2));

  // "first Monday of the month", "every last friday", "the 2nd tuesday of each month", "third thursday monthly"
  t = t.replace(
    new RegExp(`\\b(?:(?:every|each|on)\\s+(?:the\\s+)?|the\\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|last)\\s+(${WD})s?(\\s+of\\s+(?:(?:every|each|the|a)\\s+)?month|\\s+(?:of\\s+)?(?:every|each)\\s+month|\\s+monthly|\\s+a\\s+month)?\\b`, 'i'),
    (whole: string, n: string, wd: string, monthWords?: string) => {
      const ofMonth = new RegExp(`^\\s*(?:of|in)\\s+${MONTH_RE}`, 'i').test(input.slice(input.toLowerCase().indexOf(whole.trim().toLowerCase()) + whole.trim().length));
      if (ofMonth) return whole; // ("first saturday of december": one date)
      if (!monthWords && !/^\s*(every|each)/i.test(whole) && !wantsRepeat && !/\bmonthly\b|\b(?:every|each)\s+month\b/i.test(input) && /^\s*the\b/i.test(whole)) return whole; // ("the first monday" alone: a date)
      if (!monthWords && /^second$/i.test(n) && !/\bmonthly\b|\bmonth\b/i.test(input)) return whole; // ("every second friday": every other one)
      const nth = /last/i.test(n) ? -1 : /^(first|1)/i.test(n) ? 1 : /^(second|2)/i.test(n) ? 2 : /^(third|3)/i.test(n) ? 3 : 4;
      rule = { freq: 'monthly', interval: 1, byDay: [wdOf(wd)!], nth };
      byDayGiven = true;
      return ' ';
    },
  );
  take(/\b(?:every|each|on)\s+weekdays?\b|\bweekdays\b|^\s*weekday\b/i, () => set('weekly', 1, [1, 2, 3, 4, 5]));
  if (!rule) take(/\b(?:every|each|on)\s+weekends?\b|\bweekends\b/i, () => set('weekly', 1, [0, 6]));
  if (!rule) t = t.replace(/\b(?:every|each)\s+(morning|evening|night|afternoon)\b/i, (_, part: string) => (set('daily'), ` ${part} `));
  if (!rule) take(/\bquarterly\b|\bevery\s+(?:quarter|three months)\b/i, () => set('monthly', 3));
  // "wed nights", "tuesday evenings": plural times of day after a weekday mean every week
  if (!rule)
    t = t.replace(new RegExp(`\\b(${WD_LIST})\\s+(nights|evenings|mornings|afternoons)\\b`, 'i'), (_, list: string, part: string) => {
      set('weekly', 1, days(list));
      return ` ${part.slice(0, -1)} `;
    });
  if (!rule)
    take(new RegExp(`\\b(?:every|each)\\s+(other\\s+|second\\s+|2nd\\s+)?(${WD_LIST})\\b`, 'i'), (_, other, list) =>
      set('weekly', other ? 2 : 1, days(list)),
    );
  if (!rule)
    take(/\b(?:every|each)\s+(other|second|2nd|third|3rd|\d+)?\s*(day|week|month|year)s?\b/i, (_, n, unit) => {
      const k = !n ? 1 : /other|second|2nd/i.test(n) ? 2 : /third|3rd/i.test(n) ? 3 : +n;
      set(UNIT_FREQ[unit.toLowerCase()], k);
    });
  if (!rule) take(/\b(bi-?weekly|fortnightly)\b/i, () => set('weekly', 2));
  if (!rule)
    take(/\b(daily|weekly|monthly|yearly|annually)\b/i, (_, w) =>
      set(({ daily: 'daily', weekly: 'weekly', monthly: 'monthly' } as Record<string, Recurrence['freq']>)[w.toLowerCase()] ?? 'yearly'),
    );
  // Plural weekdays mean a repeat too: "Alex meeting fridays at 3", "on mondays and wednesdays"
  const FULL = '(?:mon|tues|wednes|thurs|fri|satur|sun)days'; // only full names: "tues" alone is not a plural
  const plural = new RegExp(`\\b(?:on\\s+)?(${FULL}(?:\\s*(?:,|and|&)\\s*${FULL})*)\\b`, 'i');
  if (!rule || (rule.freq === 'weekly' && !rule.byDay)) {
    const m = t.match(plural);
    if (m) {
      const interval = rule?.interval ?? 1;
      t = t.replace(m[0], ' ');
      set('weekly', interval, days(m[1].replace(/s\b/gi, '')));
    }
  }
  // Timetable shorthand: "MWF", "TR", "TTh", "MTWRF" — and a list of weekdays with no "every": "mon wed fri", "tues/thurs"
  if (!rule)
    take(/(?<![\w'])(mtwrf|mtwthf|mwf|mw|tth|tuth|tr|wf)(?![\w'])/i, (_, code) => {
      const c = code.toLowerCase().replace('th', 'r').replace('tu', 't');
      const map: Record<string, number> = { m: 1, t: 2, w: 3, r: 4, f: 5 };
      set('weekly', 1, [...new Set([...c].map((ch) => map[ch]))].sort());
    });
  if (!rule)
    take(new RegExp(`\\b(?:on\\s+)?(${WD}s?(?:\\s*(?:,|/|&|\\+|and|\\s)\\s*${WD}s?)+)\\b`, 'i'), (_, list) =>
      set('weekly', 1, [...new Set(list.split(/\s*(?:,|\/|&|\+|\band\b|\s)\s*/).map((w: string) => wdOf(w.trim())).filter((d: number | undefined): d is number => d !== undefined))].sort()),
    );
  if (!rule && wantsRepeat) set('weekly');
  // "swim lessons sat 9am until feb 27": a weekday with an end date repeats on it
  if (!rule && new RegExp(`\\b${WD}\\b[^]*\\b(?:until|till|thru|through)\\s+(?:${MONTH_RE}|\\d)`, 'i').test(t)) {
    const m = new RegExp(`\\b(${WD})\\b`, 'i').exec(t)!;
    set('weekly', 1, [wdOf(m[1])!]);
  }
  if (!rule) return { text: input, byDayGiven: false };

  let untilText: string | undefined;
  take(/\b(?:until|till|til|through|thru)\s+(?:the\s+)?end\s+of\s+(?:the\s+)?(month|year|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/i, (_, m) => {
    untilText = `end of ${m}`;
  });
  if (!untilText) take(/\b(?:until|till|til|through|thru|ending(?:\s+on)?|ends?)\s+((?:the\s+)?[\w/]+(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+\d{4})?)/i, (_, d) => {
    untilText = d;
  });
  let times: number | undefined;
  let timesUnit: RepeatInfo['timesUnit'];
  take(/\bfor\s+(\d+|two|three|four|five|six|ten|twelve)\s+(weeks?|months?|days?|years?|times|sessions|occurrences)\b/i, (_, n, u) => {
    times = NUMBER_WORDS[n.toLowerCase()] ?? +n;
    timesUnit = /^(times|sessions|occurrences)$/i.test(u) ? 'occurrence' : (u.toLowerCase().replace(/s$/, '') as RepeatInfo['timesUnit']);
  });
  take(/,?\s*\b(\d+|two|three|four|five|six|seven|eight|nine|ten|twelve)\s+(?:times|sessions|occurrences)\b/i, (_, n) => {
    times = NUMBER_WORDS[n.toLowerCase()] ?? +n;
    timesUnit = 'occurrence';
  });
  take(/\b(x|×)\s*(\d+)\b|\b(\d+)\s*(x|×)\b/i, (_, _a, n1, n2) => {
    times = +(n1 ?? n2);
    timesUnit = 'occurrence';
  });
  t = t.replace(/\b(?:starting|beginning|from)\s+(?=\S)/i, ' ');
  return { text: t, rule, byDayGiven, untilText, times, timesUnit };
}

const WEEKDAY = '(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?';
const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const TIME = '\\d{1,2}(?::\\d{2})?';
const SEP = 'Zsep';
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const PART_OF_DAY: [RegExp, number][] = [
  [/\bmorning\b/i, 9 * 60],
  [/\bafternoon\b/i, 14 * 60],
  [/\bevening\b/i, 18 * 60],
  [/\b(tonight|night)\b/i, 19 * 60],
];
const MEALS: [RegExp, number][] = [
  [/\bbreakfast\b/i, 8 * 60 + 30],
  [/\bbrunch\b/i, 11 * 60],
  [/\blunch\b/i, 12 * 60],
  [/\b(dinner|supper)\b/i, 18 * 60 + 30],
];

// A month name with no day number beside it ("coffee with June", "May's talk") is a name,
// not a date. Hide it from the date parser behind a placeholder and restore it afterwards.
// "June 10/22" is June + a slash date, so a day number only counts if no slash follows it.
const LONE_MONTH =
  /(?<!\d\s*)\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b(?!\.?\s*\d{1,2}(?:st|nd|rd|th)?\b(?!\/\d))/gi;
// Room numbers etc. ("Room 1318") must not be read as years; "at 1530" (24-hour time) and 20xx years are kept.
const LONG_NUMBER = /(?<![:/\d]|\bat\s)\b(?!20\d\d\b)\d{3,}\b(?![:/])/g;
// "Cottage weekend" is a name; only "this/next/the weekend" (or "on/over the weekend") is a date.
const LONE_WEEKEND = /(?<!\b(?:this|next|the|coming|every|each|on)\s+)\bweekend\b/gi;
// Addresses and site numbers are places, not times: "22 Birch Rd", "123 PINE ST", "at 12 Oak", "Lot 14", "Unit 5"
const ADDRESS =
  /\b\d{1,5}\s+[A-Za-z][A-Za-z'.-]*(?:\s+[A-Za-z][A-Za-z'.-]*)?\s+(?:St|Street|Rd|Road|Ave|Avenue|Blvd|Dr|Drive|Ln|Lane|Way|Ct|Court|Cres|Crescent|Pl|Place|Pkwy|Hwy|Terr?|Sq)\b\.?|\b(?:lot|unit|suite|site|pad|bay|bldg|building|room|rm)\s+\d+[a-z]?\b/gi;
// "at 220 Oak": a house number (3-5 digits, not a 24-hour time) and a capitalised name after "at"
const ADDRESS_AT =
  /(?<=\b(?:at|@)\s+)(?!(?:[01]\d|2[0-3])[0-5]\d\b)\d{3,5}\s+(?!(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|Today|Tomorrow|Tonight|Noon|Midnight|Next|This|For|And|With|Am|Pm|AM|PM|O'?clock)[a-z]*\b)[A-Z][a-z]{2,}\b/g;
function shieldNames(t: string): [string, (x: string) => string] {
  const saved: string[] = [];
  const hide = (m: string) => `Zqx${saved.push(m) - 1}x`;
  const out = t.replace(/\b1:1s?\b|\b1-on-1s?\b/gi, hide).replace(ADDRESS, hide).replace(ADDRESS_AT, hide).replace(LONE_MONTH, hide).replace(LONG_NUMBER, hide).replace(LONE_WEEKEND, hide);
  return [out, (x) => x.replace(/Zqx(\d+)x/g, (_, i: string) => saved[+i])];
}

/** Step 1: rewrite the sentence into a form chrono parses reliably. */
function normalize(input: string, now: Date) {
  let t = ` ${input.trim()} `;
  t = t.replace(/[.!?]+\s*$/, ' '); // dictation adds a final period
  // What people say to an assistant before the thing itself: "okay so um", "can you", "put … on my calendar",
  // "add an event called …", "book a meeting with …" (a verb with no article is the to-do itself: "book flights")
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(/^\s*(?:ok(?:ay)?|so|um+|uh+|hey|hi|please|pls|can you|could you|would you|will you|i want to|i'd like to|i would like to|let'?s|go ahead and)\b[\s,]*/i, ' ');
  }
  t = t.replace(/^\s*put\s+(.+?)\s+(?:on|in|into)\s+(?:my|the)\s+(?:calendar|cal|schedule|diary)\b/i, ' $1 ');
  t = t.replace(/\s+(?:to|on|in|into)\s+(?:my|the)\s+(?:calendar|cal|schedule)\b/i, ' ');
  t = t.replace(/^\s*(?:add|create|make|new|schedule|put in)\s+(?:an?\s+|new\s+)?(?:event|entry|item|appointment|appt)\s*(?:called|named|titled|for|:)?\s+/i, ' ');
  t = t.replace(/^\s*(?:add|schedule|create|book|set up|setup|set|arrange|make|plan|organi[sz]e|put in|put)\s+(?:an?|another)\s+(?=\S)/i, ' ');
  t = t.replace(/^\s*(?:add|new event:?|remind me to|remind me|remember to|don'?t forget to|dont forget to|need to|i need to|i have to|i gotta|gotta|have to|must)\s+/i, ' ');
  t = t.replace(/^\s*(?:i have|i've got|ive got|i got|there's|theres|there is)\s+(?:an?\s+)?/i, ' ');
  // "schedule coffee with April at 2pm": the verb is the request, the rest the event (with no time it's a to-do:
  // "schedule car service")
  if (/\d|\b(?:noon|tomorrow|today|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(t))
    t = t.replace(/^\s*(?:schedule|add|set up|setup|arrange|create|put in|put)\s+(?=\S)/i, ' ');
  t = t.replace(/\ballday\b/gi, 'all day');
  t = t.replace(/\b(\d{1,2}|noon)\s*-?ish\b/gi, '$1').replace(/\b(?:twice|three times|\d+ times|once)\s+(?:a|per|each)\s+week\b/gi, ' ').replace(/\b(?:like|around|about|approx\.?|~)\s+(?=\d)/gi, '');
  t = t.replace(/\b(\d{1,2}(?::\d\d)?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+([ap])\s?\.?\s?m\b\.?/gi, '$1 $2m');
  t = t.replace(/\b(?:a|one|1)\s+(day|week|month|year)\s+from\s+(?:today|now)\b/gi, 'in 1 $1').replace(/\b(\d+|two|three|four|five|six)\s+(days|weeks|months|years)\s+from\s+(?:today|now)\b/gi, 'in $1 $2');
  t = resolveChains(t, now);
  t = t.replace(/\b(?:the\s+)?day after tomorrow\b/gi, 'in 2 days').replace(/\ba week from tomorrow\b/gi, 'in 8 days').replace(/\blater today\b/gi, 'today');
  t = t.replace(/[–—]/g, '-').replace(/\bhalf-hour\b/gi, 'half hour');
  t = t.replace(/\b(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(\d)/gi, '$1 $2'); // "tues3pm"
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => (+mo >= 1 && +mo <= 12 ? `${MONTHS3[+mo - 1]} ${+d} ${y}` : m)); // ISO dates
  t = t.replace(/\b(\d{1,2})(?:st|nd|rd|th)?\s+of\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/gi, '$2 $1'); // "3rd of December"
  t = t.replace(new RegExp(`\\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\\s+(?:the\\s+)?(${Object.keys(ORDINAL_WORDS).join('|')})\\b`, 'gi'), (_, m: string, o: string) => `${m} ${ORDINAL_WORDS[o.toLowerCase()]}`);
  t = t.replace(new RegExp(`\\bthe\\s+(${Object.keys(ORDINAL_WORDS).sort((a, b) => b.length - a.length).join('|')})\\b(?!\\s+(?:${WEEKDAY_ALT})\\b)`, 'gi'), (_, o: string) => { const n = ORDINAL_WORDS[o.toLowerCase()]; return `the ${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`; });
  t = t.replace(/\b(\d{1,2})(?:st|nd|rd|th)\s+of\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/gi, '$2 $1');
  t = t.replace(/\bnext week\s+((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)\b/gi, '$1 next week');
  t = t.replace(/\bmid-?afternoon\b/gi, '3pm').replace(/\bmid-?morning\b/gi, '10am').replace(/\blate afternoon\b/gi, '4pm').replace(/\bearly evening\b/gi, '6pm');
  t = t.replace(/\b([01]\d|2[0-3])([0-5]\d)\s*-\s*([01]\d|2[0-3])([0-5]\d)\b/g, '$1:$2-$3:$4'); // "1300-1500"
  // "from 6 to 7am", "between 7 and 9am", "1-3am": the start is in the morning too
  t = t.replace(/\b(\d{1,2}(?::\d\d)?)\s*(-|to|and|until|till)\s*(\d{1,2}(?::\d\d)?)\s*am\b/gi, '$1am $2 $3am');
  t = t.replace(/@\s*(?=\d|quarter\b|half\b|noon\b|midnight\b)/gi, 'at ');
  // holidays as dates — unless the sentence gives its own date ("Christmas party dec 18" is on the 18th)
  if (!/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d|\b\d{1,2}\/\d{1,2}\b/i.test(t)) t = t.replace(/\bchristmas eve\b/gi, 'dec 24').replace(/\b(?:christmas|xmas)(?:\s+day)?\b/gi, 'dec 25').replace(/\bboxing day\b/gi, 'dec 26')
    .replace(/\bnew year'?s eve\b/gi, 'dec 31').replace(/\bnew year'?s(?:\s+day)?\b(?!\s+(?:brunch|party|dinner|resolution))/gi, 'jan 1')
    .replace(/\bhalloween\b/gi, 'oct 31').replace(/\bvalentine'?s(?:\s+day)?\b/gi, 'feb 14').replace(/\bcanada day\b/gi, 'jul 1');
  // "mortgage 15th every month": a bare ordinal is a day of the month ("the 15th") — not after a month name
  t = t.replace(/(^|\s)(\d{1,2})(st|nd|rd|th)(?=\s)/gi, (m, sp, d, suf, off: number) =>
    /\b(?:the|of|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*$/i.test(t.slice(0, off + sp.length)) ? m : `${sp}the ${d}${suf}`);
  t = t.replace(/\bnext year\s+(?=(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b)/gi, ' ');
  t = t.replace(/\b(?:the\s+)?following\s+(?=(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b)/gi, 'next ');
  // nouns that end in "night" aren't the night ("pizza night", "trivia night"); hidden from the date reader
  t = t.replace(/\ball\s+morning\b/gi, '9am-12pm').replace(/\ball\s+afternoon\b/gi, '1pm-5pm').replace(/\ball\s+evening\b/gi, '6pm-10pm');
  t = t.replace(/\bthis\s+(morning|afternoon|evening)\b/gi, 'today $1');
  t = t.replace(/(-|–|\bto|\buntil|\btill|\bthrough)\s*noon\b/gi, '$1 12pm').replace(/\bnoon\s*(-|–|to\b|till\b|until\b)/gi, '12pm $1');
  t = t.replace(/\b(\d{1,2})\s*(?:pm)?\s*(?:-|to|till|until)\s*midnight\b/gi, '$1pm - 11:59pm').replace(/\s*\b(?:till|until|to)\s+late\b/gi, ' ');
  t = t.replace(/\bfor\s+a\s+couple(?:\s+of)?\s+hours\b/gi, 'for 2 hours').replace(/\ban\s+hour\s+and\s+a\s+half\b/gi, '90 min');
  t = t.replace(/\bend of (?:the\s+)?week\b/gi, 'friday');
  {
    const n = new Date(now);
    const mname = (d: Date) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][d.getMonth()];
    const last = new Date(n.getFullYear(), n.getMonth() + 1, 0);
    const next = new Date(n.getFullYear(), n.getMonth() + 1, 1);
    t = t.replace(/\b(?:the\s+)?end of (?:the\s+)?month\b/gi, `${mname(last)} ${last.getDate()}`);
    t = t.replace(/(^|\s)next month\b(?!\s+on\b)/gi, `$1${mname(next)} 1 ${next.getFullYear()}`);
  }
  // "12/19-1/3": a span of dates
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})\s*-\s*(\d{1,2})\/(\d{1,2})\b/g, (_, m1, d1, m2, d2) => {
    const M = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    return M[+m1 - 1] && M[+m2 - 1] ? `${M[+m1 - 1]} ${d1} - ${M[+m2 - 1]} ${d2}` : _;
  });
  t = t.replace(/[,;]?\s*\b(?:checklist|to-?dos?|steps)\s*:.*$/i, ' ');
  t = t.replace(new RegExp(`\\b((?:${WEEKDAY_ALT})(?:day)?s?|today|tomorrow|tonight|monthly|weekly|daily|fortnight|week|weekend)\\s+(1[0-2]|[1-9])(?=\\s+[a-z])(?!\\s+(?:am|pm|a\\.m|p\\.m|o'?clock|hours?|hrs?|mins?|minutes?|days?|weeks?|months?|times?|people|kids)\\b)`, 'gi'), '$1 at $2');
  t = t.replace(/^(\s*)(1[0-2]|[1-9])(?=\s+(?:tomorrow|today|tonight|this|next|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*)\b)/i, '$1at $2');
  t = t.replace(/\b2moro+w?\b|\b2morrow\b/gi, 'tomorrow').replace(/\bteh\b/gi, 'the').replace(/~\s*/g, '');
  t = t.replace(/\btues\b/gi, 'tuesday').replace(/\bthurs?\b/gi, 'thursday').replace(/\bweds\b/gi, 'wednesday');
  t = t.replace(/\b(tmrw|tmrrw|tmr|tmw|tomoz)\b/gi, 'tomorrow').replace(/\btonite\b/gi, 'tonight');
  t = t.replace(/\b(lunchtime|midday)\b/gi, 'noon').replace(/\b(eod|end of (?:the )?day)\b/gi, '5pm');
  t = t.replace(/(\d)\s*(a|p)\.\s?m\.?/gi, '$1$2m'); // "3 p.m." → "3pm"
  t = t.replace(/\b(\d{1,2})\s+([0-5]\d)\s*([ap]m)\b/gi, '$1:$2$3'); // dictated "6 30 pm"
  t = t.replace(/\b(\d{1,2})\.([0-5]\d)(?=\s*(?:[ap]m\b|$|\s))/gi, '$1:$2'); // "3.30"
  t = t.replace(/(\d)\s+([ap]m)\b/gi, '$1$2'); // "3 PM" → "3PM"

  // Number words when clearly a time: "at three", "three pm", "seven thirty"
  const nw = Object.keys(NUMBER_WORDS).join('|');
  t = t.replace(new RegExp(`\\b(at|from|to|until|till|-|around|about|like|by)\\s+(${nw})\\b`, 'gi'), (_, p: string, w: string) => `${p} ${NUMBER_WORDS[w.toLowerCase()]}`);
  t = t.replace(new RegExp(`\\b(${nw})(?=\\s*(?:am|pm|o'?clock|thirty|fifteen|forty-?five)\\b)`, 'gi'), (w) => String(NUMBER_WORDS[w.toLowerCase()]));
  t = t.replace(/\b(\d{1,2})\s+thirty\b/gi, '$1:30').replace(/\b(\d{1,2})\s+fifteen\b/gi, '$1:15').replace(/\b(\d{1,2})\s+forty-?five\b/gi, '$1:45');
  t = t.replace(/(?:\bat\s+)?\b(\d{1,2})\s*o'?clock\b/gi, 'at $1');
  t = t.replace(new RegExp(`\\b(past|to|of|half)\\s+(${nw})\\b`, 'gi'), (_, p: string, w: string) => `${p} ${NUMBER_WORDS[w.toLowerCase()]}`);
  t = t.replace(new RegExp(`\\b(${nw}|1[0-9]|2[0-3])\\s+hundred(?:\\s+hours)?\\b`, 'gi'), (_, w: string) => `${NUMBER_WORDS[w.toLowerCase()] ?? w}:00`); // "fifteen hundred"
  t = t.replace(/\bhalf\s+(\d{1,2})\b(?!\s*(?:hours?|hrs?|days?|weeks?|an?\b))/gi, '$1:30'); // "half seven" (British): 7:30
  t = t.replace(/\bhalf past (\d{1,2})\b/gi, '$1:30').replace(/\bquarter past (\d{1,2})\b/gi, '$1:15');
  t = t.replace(/\bquarter (?:to|of) (\d{1,2})\b/gi, (_, h: string) => `${((+h + 10) % 12) + 1}:45`);

  // 24-hour "at 1530" → "at 15:30"
  t = t.replace(/\bat ([01]\d|2[0-3])([0-5]\d)\b/g, 'at $1:$2');
  // "at 7" → "at 7:00": otherwise "at 7 nov 2" reads as 7 November
  t = t.replace(/\bat (1[0-2]|0?[1-9])(?![:\d])(\s*[ap]m\b)?/gi, (_, h: string, ap = '') => `at ${h}:00${ap}`);
  // "thursday after next" → "next thursday"
  t = t.replace(new RegExp(`\\b(${WEEKDAY}) after next\\b`, 'gi'), 'next $1');
  // "the 15th" (no month) → this month, or next month if already past
  t = t.replace(new RegExp(`(?<!${MONTH}\\s*)\\b(?:on\\s+)?the (\\d{1,2})(?:st|nd|rd|th)\\b`, 'gi'), (m, d: string) => {
    const day = +d;
    if (day < 1 || day > 31) return m;
    let month = day >= now.getDate() ? now : addMonths(now, 1);
    while (getDaysInMonth(month) < day) month = addMonths(month, 1); // "the 31st" in November is December's
    return ` ${month.toLocaleString('en', { month: 'short' })} ${day} `;
  });
  // "feb 29" with no year: the next one there is (a leap year)
  t = t.replace(/\b(?:feb(?:ruary)?\.?\s+29(?:th)?|29(?:th)?\s+(?:of\s+)?feb(?:ruary)?\.?)(?!,?\s*\d{4})\b/gi, (m) => {
    let y = now.getFullYear();
    while (!isLeapYear(new Date(y, 0, 1)) || new Date(y, 1, 29) < startOfDay(now)) y++;
    return `${m} ${y}`;
  });

  // Bare time ranges: "11-1", "2 to 4", "between 2 and 3" → "from 11 to 1" (not after a month: "oct 3-5")
  const range = new RegExp(
    `(?<![\\w/:])(?:between\\s+|from\\s+)?(${TIME})\\s*([ap]m)?\\s*(?:-|–|—|to|until|till|and)\\s*(${TIME})\\s*([ap]m)?(?![\\w/:])`,
    'gi',
  );
  t = t.replace(range, (m, a: string, ap = '', b: string, bp = '', offset: number, whole: string) => {
    const before = whole.slice(0, offset);
    if (new RegExp(`${MONTH}\\s*$`, 'i').test(before)) return m; // a date range like "oct 3-5"
    if (/\band\b/i.test(m) && !/between/i.test(m)) return m; // plain "2 and 3"
    const ok = (x: string) => x.includes(':') || +x <= 12;
    if (!ok(a) || !ok(b)) return m;
    const hm = (x: string) => (x.includes(':') ? x : `${x}:00`);
    return ` from ${hm(a)}${ap} to ${hm(b)}${bp} `;
  });

  // "sat 7", "tomorrow 3:30", "friday 11am": a bare time right after a day word
  t = t.replace(new RegExp(`\\b(${WEEKDAY}|today|tonight|tomorrow)\\s+(${TIME}\\s*(?:[ap]m)?)(?=[\\s,]|$)`, 'gi'), '$1 at $2');
  // A time directly followed by a date ("at 9:00 Oct 20") confuses chrono; a separator makes it
  // parse them as two pieces, which are combined later. The separator is removed afterwards.
  t = t.replace(/(\bat \d{1,2}:\d{2}(?:\s*[ap]m)?|\bto \d{1,2}:\d{2}(?:\s*[ap]m)?)(?=\s+(?![ap]m\b)\S)/gi, `$1 ${SEP} `);
  return t;
}

const DURATION =
  /\s(?:(?:for\s+|(?=(?:an?|one|two|three|four|five|six|half an?|half|\d+(?:\.\d+)?)\s*(?:hours?|hrs?|minutes?|mins?)\b|\d+m\b))(?:(an?|one|two|three|four|five|six|half an?|half|\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)\b(?:\s*(?:and\s*)?(a half|\d+)\s*(?:minutes?|mins?|m)?\b)?)|(\d+)h(\d{1,2})?m?\b|(\d+)\s?(?:min|mins)\b(?<!\bin\s+\d+\s?mins?))/i;

function takeDuration(t: string): [string, number | undefined] {
  let minutes: number | undefined;
  const out = t.replace(DURATION, (m, q, unit, extra, ch, cm, cmin, offset: number) => {
    if (/\bin\s+\d+\s?mins?\b/i.test(m)) return m; // "in 30 min" is a start time, not a length
    if (!/^\s*for\b/i.test(m) && /\b(?:in|within|after)\s*$/i.test(t.slice(Math.max(0, offset - 8), offset + 1))) return m; // "in 2 hours": when
    if (ch) minutes = +ch * 60 + (cm ? +cm : 0);
    else if (cmin) minutes = +cmin;
    else {
      const n = q === 'a' || q === 'an' || q === 'one' ? 1 : /^half/i.test(q) ? 0.5 : NUMBER_WORDS[q.toLowerCase()] ?? parseFloat(q);
      minutes = n * (unit[0].toLowerCase() === 'h' ? 60 : 1);
      if (extra) minutes += extra === 'a half' ? 30 : +extra;
    }
    return ' ';
  });
  return [out, minutes];
}

/** A chrono match is trusted only if it names a day, a weekday or a time — not just a month. */
const isSpecific = (r: chrono.ParsedResult) =>
  r.start.isCertain('hour') || r.start.isCertain('day') || r.start.isCertain('weekday') ||
  /^(?:in|within)\s+(?:\d+|an?|one|two|three|four|five|six|ten|twelve)\s+(?:days?|weeks?|months?|years?)$/i.test(r.text.trim()); // ("in 6 months": a date)

const PLACE_NOUN = /\b(?:room|rm|library|park|hall|building|bldg|lab|office|cafe|café|coffee shop|centre|center|gym|place|house|apartment|apt|bar|pub|restaurant|church|school|campus|station|airport|hospital|clinic|arena|stadium|theatre|theater|museum|studio|field|court|pool|rink|beach|club|lounge|auditorium|observatory|institute|university|college)\b/i;
/** Is a lowercase "at …" / "in …" phrase a place (and not "in a bit", "at the end")? */
function isPlace(phrase: string) {
  const p = phrase.trim().toLowerCase();
  if (/^(?:the\s+)?(?:morning|afternoon|evening|night|end|start|beginning|middle|weekend|meantime|moment|latest|earliest|least|most|office hours|a bit|a while)\b/.test(p)) return false;
  if (/^(?:a|an|my|our|your|his|her|their|this|that|\d)\b/.test(p) && !PLACE_NOUN.test(p)) return false;
  return /^the\s+\w/.test(p) || PLACE_NOUN.test(p) || /'s\b/.test(p) || !!zoneByName(p) || [...AIRPORTS.values()].some((a) => a.city.toLowerCase() === p) || /^(?:keck|gemini|alma|vlt|cern|fermilab|slac|nrao|lick|palomar|mauna kea)$/.test(p);
}

const WD_WORD = '(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day)?s?';
/** Words about *when* that the date reader left in the title: "am" ("sat am soccer"), "evenings" ("tues & fri
 *  evenings"), "night" right after a weekday ("monday night trivia" — but "pizza night" keeps it), "this week",
 *  "after school", a checklist written after the thing. */
function cleanTitle(title: string, input: string) {
  let t = ` ${title} `;
  t = t.replace(/[,;]?\s*\b(?:checklist|todo|to-do|steps)\s*:.*$/i, ' ');
  t = t.replace(/\s(?:a\.?m\.?|p\.?m\.?)(?=\s)/gi, ' ');
  t = t.replace(/\b(?:this|next|that)\s+(?:week|weekend)\b|\b(?:after|before)\s+(?:school|work|class|lunch|dinner)\b|\bfirst thing\b/gi, ' ');
  t = t.replace(/\b(?:evenings|mornings|afternoons|nights)\b/gi, ' ');
  t = t.replace(/\bin the (?:morning|afternoon|evening)\b/gi, ' ').replace(/\s(?:is|are|will be|must be|should be)\s*$/i, ' ').replace(/\bmust be\s+(?=\w+ed\b)/i, ' ');
  // a day that names the thing ("Sunday service", "Saturday school"): kept even though it also says when
  const named = /^\s*(sunday|saturday)\s+(service|school)\b/i.exec(input);
  if (named && !new RegExp(`\\b${named[1]}\\b`, 'i').test(t)) t = t.replace(new RegExp(`\\b${named[2]}\\b`, 'i'), `${named[1]} ${named[2]}`);
  for (const m of input.matchAll(new RegExp(`\\b${WD_WORD}\\s+(night|evening|morning|afternoon)s?\\b`, 'gi'))) t = t.replace(new RegExp(`\\b${m[1]}s?\\b`, 'i'), ' ');
  // a part of the day said as *when* ("this evening call dad", "tomorrow morning run") — but "evening run" keeps it
  for (const m of input.matchAll(/\b(?:this|today|tomorrow|tmrw|tonight|every|each)\s+(morning|afternoon|evening|night)\b/gi)) t = t.replace(new RegExp(`\\b${m[1]}\\b`, 'i'), ' ');
  if (/\bmonthly\s+on\s+the\b/i.test(input)) t = t.replace(/\bmonthly\b/i, ' ');
  t = t.replace(/[A-Za-z]{4,}/g, (w) => fixWord(w));
  return t.replace(/\s+/g, ' ').trim();
}
const VOCAB = ['meeting', 'call', 'appointment', 'dentist', 'doctor', 'dinner', 'lunch', 'breakfast', 'rehearsal', 'interview', 'conference', 'seminar', 'lecture', 'presentation', 'review', 'session', 'inspection', 'showing', 'birthday', 'party', 'practice', 'workout', 'training', 'deadline', 'proposal', 'report', 'submission', 'tutorial', 'office', 'hours', 'consultation', 'therapy', 'haircut', 'flight', 'hotel', 'wedding', 'reception', 'ceremony', 'concert', 'webinar', 'workshop', 'standup', 'retreat', 'committee', 'colloquium', 'meetup', 'coffee', 'drinks', 'client', 'contractor', 'designer', 'teacher', 'student', 'project', 'invoice', 'payment'];
/** A common calendar word typed with a slip ("meetign", "calll", "apointment") — names and other words are left alone. */
function fixWord(w: string) {
  const lw = w.toLowerCase();
  if (VOCAB.includes(lw) || (lw.endsWith('s') && VOCAB.some((v) => typoDistance(lw.slice(0, -1), v) <= 1 && lw.length >= 5))) return w; // (plurals: as typed)
  const collapsed = lw.replace(/(.)\1{2,}/g, '$1$1');
  for (const v of VOCAB) {
    if (collapsed === v || lw.replace(/(.)\1+/g, '$1') === v.replace(/(.)\1+/g, '$1')) return match(w, v);
    if (v.length >= 6 && Math.abs(v.length - lw.length) <= 1 && typoDistance(lw, v) <= 1) return match(w, v);
  }
  return w;
}
const match = (orig: string, v: string) => (orig[0] === orig[0].toUpperCase() ? v[0].toUpperCase() + v.slice(1) : v);

const MONTHS3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ORDINAL_WORDS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12,
  thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20,
  'twenty-first': 21, 'twenty first': 21, 'twenty-second': 22, 'twenty second': 22, 'twenty-third': 23, 'twenty third': 23,
  'twenty-fourth': 24, 'twenty fourth': 24, 'twenty-fifth': 25, 'twenty fifth': 25, 'twenty-sixth': 26, 'twenty sixth': 26,
  'twenty-seventh': 27, 'twenty seventh': 27, 'twenty-eighth': 28, 'twenty eighth': 28, 'twenty-ninth': 29, 'twenty ninth': 29, thirtieth: 30, 'thirty-first': 31, 'thirty first': 31,
};
// ---- what people say while thinking ------------------------------------------------------
const CORRECTION = String.raw`(?:no\s+wait|wait\s+no|no,?|nope|actually(?:\s+make\s+(?:it|that))?|make\s+(?:it|that)|(?:er|uh|um)?\s*i\s+mean|sorry|scratch\s+that|or\s+rather|rather)`;
const WHEN_TOKEN = String.raw`(?:(?:next|this)\s+)?(?:mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)(?:day)?|\d{1,2}(?::\d\d)?\s*(?:am|pm)?`;
/** "thursday no wait friday 2pm", "at 3 actually make it 4", "3pm, no 3:30", "next tuesday er I mean this tuesday",
 *  "dinner at 5. no 6.": the earlier "when" is taken back. Then the filler of thinking out loud goes. */
function takeBackCorrections(t: string) {
  const re = new RegExp(`(?:\\bat\\s+)?\\b(${WHEN_TOKEN})\\s*[,.;]?\\s*\\b${CORRECTION}\\b[,.;]?\\s*(?=(?:at\\s+)?(?:${WHEN_TOKEN})\\b)`, 'i');
  for (let k = 0; k < 3 && re.test(t); k++) t = t.replace(re, (m) => (/^\s*at\b/i.test(m) ? 'at ' : ' '));
  t = t.replace(/(\d)\s*\.\s+(?=\w)/g, '$1 '); // "at 5. no 6." leftovers
  return t
    .replace(/^\s*(?:um+|uh+|er+|erm|so|ok(?:ay)?|hmm+)\b[\s,]*/gi, ' ')
    .replace(/\b(?:um+|uh+|erm|er)\b[,]?/gi, ' ')
    .replace(/\bi\s+(?:think|guess|believe)\b|\bi'?m\s+pretty\s+sure\b|\bsometime\b|\bmaybe\b(?=\s+\d)|\bwe\s+have\s+the\b|\bwe\s+have\b/gi, ' ')
    .replace(/[,.]?\s*\b(?:period|full stop)\s*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const HUNDREDS: Record<string, number> = { thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, 'twenty-one': 21, 'twenty-two': 22, 'twenty-three': 23 };
const WEEKDAY_ALT = 'mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday';
// ---- dates counted from other dates ---------------------------------------------------------
const WD_INDEX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const wdNum = (w: string) => WD_INDEX[w.slice(0, 3).toLowerCase()];
const dateWords = (d: Date) => ` ${MONTHS3[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} `;
const spanWords = (a: Date, b: Date) => ` ${MONTHS3[a.getMonth()]} ${a.getDate()} ${a.getFullYear()} - ${MONTHS3[b.getMonth()]} ${b.getDate()} ${b.getFullYear()} `;
const N_WORD: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, 'a couple of': 2 };
const nOf = (w: string) => N_WORD[w.toLowerCase()] ?? +w;
/** The next `wd` after today (today itself doesn't count), as a date. */
function coming(now: Date, wd: number, includeToday = false) {
  const d = startOfDay(now);
  const k = (wd - d.getDay() + 7) % 7 || (includeToday ? 0 : 7);
  return addDays(d, k);
}
/** "a week from friday", "3 weeks from tomorrow", "monday after next", "thursday week", "end of next week", "in a
 *  fortnight", "this coming friday", "the weekend after next", "mid december", "early next week", "net 30" — and spans:
 *  "tue thru thu", "rest of the week", "the week of dec 7", "today and tomorrow", "next week" (as days), "3 days
 *  starting wednesday": each written out as plain dates the date reader can't misread. */
function resolveChains(t: string, now: Date) {
  const WDX = '(mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun)[a-z]*';
  const NUM = '(a|an|one|two|three|four|five|six|seven|eight|nine|ten|\\d+)';
  const today = startOfDay(now);
  t = t.replace(new RegExp(`\\b${NUM}\\s+(day|week|month)s?\\s+(?:from|after)\\s+(today|now|tomorrow|${WDX})\\b`, 'gi'), (_, n: string, unit: string, base: string) => {
    const b = /today|now/i.test(base) ? today : /tomorrow/i.test(base) ? addDays(today, 1) : coming(now, wdNum(base));
    const k = nOf(n);
    return dateWords(unit.toLowerCase() === 'month' ? addMonths(b, k) : addDays(b, unit.toLowerCase() === 'week' ? 7 * k : k));
  });
  t = t.replace(new RegExp(`\\b(?:the\\s+)?${WDX}\\s+after\\s+next\\b`, 'gi'), (_, w: string) => dateWords(addDays(coming(now, wdNum(w)), 7)));
  t = t.replace(new RegExp(`\\b${WDX}\\s+week\\b(?!\\s*(?:of|end))`, 'gi'), (m, w: string) => (/\b(?:next|this|last)\s*$/i.test(t.slice(0, t.indexOf(m))) ? m : dateWords(addDays(coming(now, wdNum(w)), 7))));
  t = t.replace(/\bend of next week\b/gi, () => dateWords(addDays(coming(now, 5), 7)));
  t = t.replace(/\b(?:in\s+)?a\s+fortnight\b/gi, 'in 14 days');
  t = t.replace(new RegExp(`\\bthis\\s+coming\\s+${WDX}\\b`, 'gi'), (_, w: string) => dateWords(coming(now, wdNum(w))));
  t = t.replace(/\b(?:the\s+)?weekend\s+after\s+next\b/gi, () => dateWords(addDays(coming(now, 6, true), 7)));
  t = t.replace(/\bearly next week\b/gi, () => dateWords(addDays(coming(now, 1), 0)));
  t = t.replace(/\bnet\s+(\d+)(?:\s+(?:days?\s+)?(?:from\s+today)?)?/gi, (_, n: string) => `in ${n} days`);
  t = t.replace(/\b(mid|middle of)[-\s]+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\b/gi, (_, _m: string, mo: string) => `${mo} 15`);
  // spans of days
  t = t.replace(new RegExp(`\\b${WDX}\\s*(?:-|–|to|thru|through|till|until)\\s*${WDX}\\b`, 'gi'), (m, a: string, b: string) => {
    if (/\d\s*$/.test(t.slice(0, t.indexOf(m)))) return m;
    const s0 = coming(now, wdNum(a), true);
    let e0 = coming(now, wdNum(b), true);
    if (e0 < s0) e0 = addDays(e0, 7);
    return spanWords(s0, e0);
  });
  t = t.replace(/\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\s+(\d{1,2})\s+(?:and|&)\s+(\d{1,2})\b(?!\s*(?:am|pm|:))/gi, '$1 $2 - $1 $3'); // "feb 4 and 5"
  t = t.replace(/\b(?:the\s+)?rest\s+of\s+(?:the|this)\s+week\b/gi, () => spanWords(today, addDays(coming(now, 5, true), 0)));
  t = t.replace(/\btoday\s+and\s+tomorrow\b/gi, () => spanWords(today, addDays(today, 1)));
  t = t.replace(/\b(?:the\s+|whole\s+)?week\s+of\s+((?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*)\s+(\d{1,2})\b/gi, (_, mo: string, d: string) => {
    const m = MONTHS3.indexOf(mo.slice(0, 3).toLowerCase());
    let a = new Date(now.getFullYear(), m, +d);
    if (a < today) a = new Date(now.getFullYear() + 1, m, +d);
    const mon = addDays(a, -((a.getDay() + 6) % 7));
    return spanWords(mon, addDays(mon, 4));
  });
  t = t.replace(new RegExp(`\\b${NUM}\\s+days?\\s+(?:starting|from|beginning)\\s+(?:on\\s+)?(today|tomorrow|${WDX})\\b`, 'gi'), (_, n: string, base: string) => {
    const b = /today/i.test(base) ? today : /tomorrow/i.test(base) ? addDays(today, 1) : coming(now, wdNum(base), true);
    return spanWords(b, addDays(b, nOf(n) - 1));
  });
  return t;
}

const DEFAULT_BLOCK_START = 9 * 60; // a block with a length but no time starts at 9 AM

/** "9am Tokyo time", "at 4 in Taipei time", "10am New York time": the zone, taken out of the text (an unknown place
 *  is left alone). */
function takeZone(t: string): [string, string | undefined] {
  // right after a time: "3pm PST", "13:00 CEST", "10am PT", "11am pacific" (elsewhere "PT" may be physio, "central" a place)
  const abbr = new RegExp(`(\\d(?:[:.]\\d\\d)?\\s*(?:[ap]\\.?m\\.?)?)\\s*\\(?\\b(${Object.keys(ZONE_ABBR).join('|')})\\b\\)?|(\\d(?:[:.]\\d\\d)?\\s*(?:[ap]\\.?m\\.?)?)\\s+(pacific|mountain|central|eastern|atlantic)\\b(?:\\s+time\\b)?`, 'i');
  const a = abbr.exec(t);
  if (a && (a[2] ? a[2] === a[2].toUpperCase() : true)) {
    const zone = a[2] ? ZONE_ABBR[a[2]] : ZONE_WORDS[a[4].toLowerCase()];
    if (zone) return [t.slice(0, a.index) + (a[1] ?? a[3]) + ' ' + t.slice(a.index + a[0].length), zone];
  }
  const m = /\b(?:in\s+)?((?:[A-Za-z][\w.'-]*\s+){0,2}[A-Za-z][\w.'-]*)\s+time\b/i.exec(t);
  if (!m) return [t, undefined];
  const words = m[1].split(/\s+/);
  for (let k = Math.min(3, words.length); k >= 1; k--) {
    const name = words.slice(-k).join(' ');
    const zone = zoneByName(name);
    if (zone) {
      const phrase = new RegExp(`\\b(?:in\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+time\\b`, 'i');
      return [t.replace(phrase, ' '), zone];
    }
  }
  return [t, undefined];
}

const at = (day: Date, minutes: number) => {
  const d = startOfDay(day);
  d.setMinutes(minutes);
  return d;
};

export const QUICK_MAX = 400; // (a sentence, not a pasted page: longer text is read up to here — fast on any paste)
export function parseQuick(input: string, calendars: CalendarSource[], now = new Date()): Parsed {
  if (input.length > QUICK_MAX) input = input.slice(0, QUICK_MAX);
  input = input
    .replace(/[\u2610-\u2612\u2713\u2714\u2705]|\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/gu, ' ') // emoji, ☐ ✓
    .replace(/\s+/g, ' ')
    .trim();
  // a sentence in capitals reads as one in lowercase ("SHOWING 123 PINE ST SUN 2PM")
  if (/[A-Z]{3,}/.test(input) && input === input.toUpperCase() && /[A-Z].*\s.*[A-Z]/.test(input)) input = input.toLowerCase();
  input = takeBackCorrections(input);
  // nouns that end in "night" aren't the night ("pizza night") — but "thursday night" is
  input = input.replace(/\b(?!(?:to|tomorrow|tonight|last|this|next|every|each|on|at|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|late|the)\b)([a-z]+)\s+night\b/gi, '$1 Nyght');
  input = input.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|twenty-one|twenty-two|twenty-three|1[0-9]|2[0-3])\s+hundred(?:\s+hours)?\b/gi, (_, w: string) => `${NUMBER_WORDS[w.toLowerCase()] ?? HUNDREDS[w.toLowerCase()] ?? w}:00`);
  input = input.replace(/\bb4\b/gi, 'before').replace(/\b2\s*mor+ow\b|\b2moro+w?\b/gi, 'tomorrow').replace(/\bweeknights?\b/gi, 'weekdays').replace(/\b(\w+)-long\b/gi, (m, u: string) => (/^(hour|day|week)$/i.test(u) ? `for 1 ${u}` : m));
  const [shielded, unshield] = shieldNames(fixDateTypos(input));
  const repeat = takeRepeat(shielded);
  if (repeat.rule) repeat.text = repeat.text.replace(/^(\s*)(1[0-2]|[1-9])(?=\s+[a-z])(?!\s+(?:am|pm|hours?|hrs?|mins?|minutes?|days?|weeks?|months?|times?)\b)/i, '$1at $2');
  const [afterLeadRaw, lead] = takeLead(repeat.text);
  const [afterLead, zone] = takeZone(afterLeadRaw);
  let isDeadline = lead !== undefined || /\b(due|deadline)\b/i.test(afterLead) ||
    /\b(?:closes?|cut-?off|expires|ends)\b(?=\s+(?:on\s+|in\s+)?(?:today|tomorrow|tonight|mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d))/i.test(afterLead) ||
    /^\s*(?:the\s+)?(?:cut-?off|deadline)\s+(?:for|to)\b/i.test(afterLead);
  let text = normalize(afterLead, now);

  // ---- 2. calendar, duration, all-day -------------------------------------------------
  let calendarId: string | undefined;
  text = text.replace(/\s#(\w+)/g, (m, tag: string) => {
    const cal = calendars.find((c) => c.name.toLowerCase().startsWith(tag.toLowerCase()));
    if (!cal) return m;
    calendarId ??= cal.id; // (the first tag picks; any others are only tags)
    return ' ';
  });
  let durMin: number | undefined;
  [text, durMin] = takeDuration(text);
  let forceAllDay = false;
  text = text.replace(/\ball[- ]day\b/i, () => ((forceAllDay = true), ' '));

  // A bare hour at the very end, with nothing else saying when: a time ("budget review 11") — not a number that
  // belongs to the thing ("chapter 3", "room 1325", "ps 4")
  if (!/\d\s*(?:am|pm)\b|\d:\d|\bnoon\b|\bmidnight\b/i.test(text))
    text = text.replace(/(^|\s)(?<!\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december|the|on|chapter|ch|room|rm|section|sec|part|week|wk|day|lecture|lab|hw|ps|problem|question|q|episode|ep|season|vol|v|no|number|#|level|grade|period|step|phase|round|game|team|table|bus|route|gate|floor|unit|apt|suite|psalm|act|scene|book|year|class)\s)(1[0-2]|[1-9])\s*$/i, (_, sp: string, h: string) => `${sp}at ${h}`);

  if (isDeadline) text = text.replace(/\bmidnight tonight\b|\btonight at midnight\b/gi, 'today 11:59pm').replace(/\bmidnight\b/gi, '11:59pm');
  // "before thursday": done by the day before
  const beforeDay = /\bbefore\s+(?=(?:mon|tue|wed|thu|fri|sat|sun|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|tomorrow|the\s+\d)\w*)/i.test(text);
  if (beforeDay) text = text.replace(/\bbefore\s+(?=\w)/i, ' ');

  // ---- 3. dates & times ---------------------------------------------------------------
  const results = chrono.parse(text, now, { forwardDate: true }).filter(isSpecific);
  const relative = (r: chrono.ParsedResult) => /^(?:in|within)\s+\S+\s+(?:days?|weeks?|months?|years?)$/i.test(r.text.trim());
  const dateRes = results.find((r) => r.start.isCertain('day') || r.start.isCertain('weekday') || relative(r));
  const timeRes = results.find((r) => r.start.isCertain('hour'));
  // "finish slides by thursday": "by" right before the date makes it a deadline
  const first = [dateRes, timeRes].filter(Boolean).sort((a, b) => a!.index - b!.index)[0];
  if (first && /\bby\s*$/i.test(text.slice(0, first.index))) isDeadline = true;
  const context = text; // keep for part-of-day / morning checks before removing date words
  for (const r of [...new Set([dateRes, timeRes])].filter(Boolean).sort((a, b) => b!.index - a!.index))
    text = text.slice(0, r!.index) + ' ' + text.slice(r!.index + r!.text.length);

  // ---- 4. resolve ---------------------------------------------------------------------
  const meal = MEALS.find(([re]) => re.test(text));
  const morning = /\b(morning|breakfast)\b/i.test(context);
  let start: Date;
  let end: Date;
  let allDay = false;
  let timeFromWords = false;
  let hasEnd = durMin !== undefined;

  if (timeRes && !forceAllDay) {
    const c = timeRes.start;
    let h = c.get('hour')!;
    const m = c.get('minute') ?? 0;
    // "at 7" → 7 PM; but "carpool 7:45", "yoga 6:30" (minutes, nothing evening-ish about it) → the morning
    const earlyWithMinutes = (h === 6 || h === 7) && m > 0 && /\b(?:carpool|commute|bus|train|drop[- ]?off|school|gym|run|jog|yoga|workout|swim|standup|stand-up|rounds|shift|breakfast|class|lecture|meds|alarm|wake)\b/i.test(input);
    if (!c.isCertain('meridiem') && h >= 1 && h <= 7 && !morning && !earlyWithMinutes) h += 12;
    // "from 10:30 until 12pm": the end's PM doesn't make the start 10:30 PM
    const e0 = timeRes.end;
    if (!c.isCertain('meridiem') && e0?.isCertain('meridiem') && c.get('hour')! >= 12) {
      const eh = e0.get('hour')!;
      if ((h - 12) * 60 + m < eh * 60 + (e0.get('minute') ?? 0) && eh - (h - 12) <= 8) h -= 12;
    }
    if (dateRes && dateRes !== timeRes) start = at(dateRes.start.date(), h * 60 + m);
    else if (dateRes) start = c.isCertain('meridiem') ? c.date() : at(c.date(), h * 60 + m);
    else {
      start = at(now, h * 60 + m); // time only: today, or tomorrow if it has passed (this very minute counts as passed)
      if (start <= now) start = addDays(start, 1);
    }
    end = new Date(start.getTime() + (durMin ?? prefs.defaultEventMin) * MIN);
    const e = timeRes.end;
    if (e?.isCertain('hour')) {
      hasEnd = true;
      end = at(start, e.get('hour')! * 60 + (e.get('minute') ?? 0));
      if (e.isCertain('meridiem')) { if (end <= start) end = addDays(end, 1); }
      else while (end <= start) end = new Date(end.getTime() + 12 * 60 * MIN); // "11-1" → 11 AM–1 PM
    }
  } else if (dateRes || meal || (PART_OF_DAY.some(([re]) => re.test(context)) && !forceAllDay)) {
    // ("evening run", "this evening call dad": today, at that part of the day)
    const day = dateRes ? dateRes.start.date() : now;
    const part = PART_OF_DAY.find(([re]) => re.test(context));
    const minutesFromWords = part?.[1] ?? meal?.[1];
    // a length but no time ("write 2h friday"): a block in the morning, not a whole day
    const minutes = minutesFromWords ?? (durMin !== undefined && !forceAllDay ? DEFAULT_BLOCK_START : undefined);
    if (minutes !== undefined && !forceAllDay) {
      timeFromWords = true;
      start = at(day, minutes);
      if (!dateRes && start < now) start = addDays(start, 1); // "lunch with Sam" after noon → tomorrow

      end = new Date(start.getTime() + (durMin ?? prefs.defaultEventMin) * MIN);
    } else {
      allDay = true;
      start = startOfDay(day);
      end = addDays(startOfDay(dateRes?.end?.date() ?? day), 1);
      if (dateRes && /\bweekend\b/i.test(dateRes.text)) end = addDays(start, 2); // Sat + Sun
    }
  } else {
    start = new Date(now); // nothing said about when: the next full hour
    start.setHours(start.getHours() + 1, 0, 0, 0);
    end = new Date(start.getTime() + (durMin ?? prefs.defaultEventMin) * MIN);
    if (forceAllDay) {
      allDay = true;
      start = startOfDay(now);
      end = addDays(start, 1);
    }
  }

  // A weekday that is today: with a time still ahead it's today ("monday at 3", said Monday morning); on its own it's
  // next week's ("monday", said on a Monday)
  if (beforeDay && !(timeRes && !forceAllDay)) {
    start = addDays(start, -1);
    end = addDays(end, -1);
  }
  if (isDeadline && dateRes && dateRes.start.isCertain('weekday') && !dateRes.start.isCertain('day') && !/\b(?:this|today)\b/i.test(dateRes.text) && startOfDay(start).getTime() === startOfDay(now).getTime()) {
    // ("submit chapter 3 by monday", said on a Monday: next Monday)
    start = addDays(start, 7);
    end = addDays(end, 7);
  }
  if (!isDeadline && dateRes && dateRes.start.isCertain('weekday') && !dateRes.start.isCertain('day') && !/\b(?:this|next|today|coming)\b/i.test(dateRes.text)) {
    const today = startOfDay(now).getTime();
    const timedNow = !allDay && (!!timeRes || timeFromWords);
    if (timedNow && startOfDay(start).getTime() === today && start <= now) {
      // ("board meeting 10 to 2 monday", said Monday at 10: next Monday's)
      start = addDays(start, 7);
      end = addDays(end, 7);
    } else if (timedNow && startOfDay(start).getTime() === today + 7 * 86_400_000) {
      const earlier = addDays(start, -7);
      if (earlier > now) {
        end = addDays(end, -7);
        start = earlier;
      }
    } else if (!timedNow && startOfDay(start).getTime() === today) {
      start = addDays(start, 7);
      end = addDays(end, 7);
    }
  }
  text = text.replace(new RegExp(`\\s*${SEP}\\s*`, 'g'), ' ');

  // ---- 4b. repeats: line the first occurrence up with the rule, work out the end ----------
  let recurrence: Recurrence | undefined;
  if (repeat.rule) {
    recurrence = { ...repeat.rule };
    if (!timeRes && !timeFromWords && durMin !== undefined && !forceAllDay) {
      // "read papers 30 min every day": a block at the usual time, not an all-day event
      allDay = false;
      start = at(start, DEFAULT_BLOCK_START);
      end = new Date(start.getTime() + durMin * MIN);
      timeFromWords = true;
    }
    const timed = !!timeRes || timeFromWords;
    if (!timed && !forceAllDay && !allDay) {
      // "gym every monday" with no time → all-day on those days
      allDay = true;
      start = startOfDay(start);
      end = addDays(start, 1);
    }
    if (recurrence.freq === 'monthly' && (recurrence.byMonthDay?.length || recurrence.nths?.length)) {
      // "1st and 15th", "last day", "2nd and 4th monday": the first such day from the given date (or from today)
      const len = end.getTime() - start.getTime();
      let d = dateRes ? new Date(start) : at(now, timed ? start.getHours() * 60 + start.getMinutes() : 0);
      if (allDay) d = startOfDay(d);
      const ok = (x: Date) => {
        const dim = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
        if (recurrence!.byMonthDay?.length) return recurrence!.byMonthDay.some((n) => (n > 0 ? x.getDate() === n : x.getDate() === dim + n + 1));
        return x.getDay() === recurrence!.byDay![0] && recurrence!.nths!.some((n) => (n > 0 ? Math.ceil(x.getDate() / 7) === n : x.getDate() + 7 > dim));
      };
      for (let k = 0; k < 400 && (!ok(d) || (!dateRes && timed && d <= now)); k++) d = addDays(d, 1);
      start = d;
      end = new Date(d.getTime() + len);
    } else if (recurrence.nth && recurrence.byDay?.length === 1) {
      // "first Monday of the month": the first such day from the given date (or from today)
      const len = end.getTime() - start.getTime();
      let d = dateRes ? new Date(start) : at(now, timed ? start.getHours() * 60 + start.getMinutes() : 0);
      if (allDay) d = startOfDay(d);
      const isNth = (x: Date) => {
        if (x.getDay() !== recurrence!.byDay![0]) return false;
        const dim = new Date(x.getFullYear(), x.getMonth() + 1, 0).getDate();
        return recurrence!.nth! > 0 ? Math.ceil(x.getDate() / 7) === recurrence!.nth : x.getDate() + 7 > dim;
      };
      for (let k = 0; k < 400 && (!isNth(d) || (!dateRes && timed && d <= now)); k++) d = addDays(d, 1);
      start = d;
      end = new Date(d.getTime() + len);
    } else if (recurrence.byDay && recurrence.byDay.length) {
      // First occurrence: the first matching weekday from the given date (or from today).
      const len = end.getTime() - start.getTime();
      const fromDate = dateRes && !(repeat.byDayGiven && dateRes.start.isCertain('weekday') && !dateRes.start.isCertain('day'));
      let d = fromDate ? new Date(start) : at(now, timed ? start.getHours() * 60 + start.getMinutes() : 0);
      if (allDay) d = startOfDay(d);
      for (let k = 0; k < 8 && (!recurrence.byDay.includes(d.getDay()) || (!fromDate && timed && d <= now)); k++) d = addDays(d, 1);
      start = d;
      end = new Date(d.getTime() + len);
    } else if (recurrence.freq === 'weekly') recurrence.byDay = [start.getDay()];
    const endOf = repeat.untilText && /^end of (\w+)/i.exec(repeat.untilText);
    if (endOf) {
      // "until end of december / the month / the year": through that month's (or year's) last day
      const w = endOf[1].toLowerCase();
      const mi = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(w.slice(0, 3));
      const base = start;
      const last = w === 'year' ? new Date(base.getFullYear(), 11, 31) : w === 'month' ? new Date(base.getFullYear(), base.getMonth() + 1, 0)
        : new Date(base.getFullYear() + (mi < base.getMonth() ? 1 : 0), mi + 1, 0);
      recurrence.until = addDays(startOfDay(last), 1).getTime() - 1;
    } else if (repeat.untilText) {
      const u = chrono.parse(normalize(repeat.untilText, now), now, { forwardDate: true })[0];
      if (u) recurrence.until = addDays(startOfDay(u.start.date()), 1).getTime() - 1; // through the end of that day
    }
    if (repeat.times) {
      const n = repeat.times;
      const lastStart =
        repeat.timesUnit === 'occurrence'
          ? null
          : repeat.timesUnit === 'week' ? addDays(start, 7 * n - 1)
          : repeat.timesUnit === 'day' ? addDays(start, n - 1)
          : repeat.timesUnit === 'month' ? addDays(addMonths(start, n), -1)
          : addDays(addMonths(start, 12 * n), -1);
      if (lastStart) recurrence.until = addDays(startOfDay(lastStart), 1).getTime() - 1;
      else {
        // N occurrences: walk the rule forward.
        let d = startOfDay(start);
        let count = 0;
        for (let k = 0; k < 3700 && count < n; k++, d = addDays(d, 1)) {
          const diffDays = Math.round((d.getTime() - startOfDay(start).getTime()) / 86_400_000);
          const r = recurrence;
          const hit =
            r.freq === 'daily' ? diffDays % r.interval === 0
            : r.freq === 'weekly'
              ? r.byDay!.includes(d.getDay()) && (Math.floor(dayIndex(d) / 7) - Math.floor(dayIndex(start) / 7)) % r.interval === 0
            : r.freq === 'monthly' && r.nth
              ? d.getDay() === r.byDay![0] && (r.nth > 0 ? Math.ceil(d.getDate() / 7) === r.nth : d.getDate() + 7 > new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())
            : r.freq === 'monthly'
              ? d.getDate() === start.getDate() && ((d.getFullYear() - start.getFullYear()) * 12 + d.getMonth() - start.getMonth()) % r.interval === 0
            : d.getDate() === start.getDate() && d.getMonth() === start.getMonth() && (d.getFullYear() - start.getFullYear()) % r.interval === 0;
          if (hit && ++count === n) recurrence.until = addDays(d, 1).getTime() - 1;
        }
      }
    }
  }

  // ---- 4c. deadlines: a moment (5 PM unless a time is given), not a span ----------------------
  if (isDeadline) {
    const timed = !!timeRes || timeFromWords;
    // "by midnight sunday": the very end of Sunday, not its first minute
    if (timed && /\bmidnight\b/i.test(input) && start.getHours() === 0 && start.getMinutes() === 0) start = at(start, 23 * 60 + 59);
    if (!timed) {
      start = at(start, prefs.dueMinutes); // 5 PM unless Settings says otherwise
      if (!dateRes && !recurrence && start < now) start = addDays(start, 1);
    }
    end = new Date(start);
    allDay = false;
    hasEnd = false;
  }

  // ---- 5. location & title --------------------------------------------------------------
  // "at noon Friday Coffee…" leaves a stranded leading "at" once the date is gone.
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = text.replace(/^[\s,:;\-–]*(?:on|at|from|by|this|next)\b[\s,:;\-–]*/i, ' ');
  }
  let location: string | undefined;
  const stop = String.raw`(?=\s+(?:with|about|re|regarding|to discuss|for|and)\b|\s*[,;]|\s*$)`;
  const locRes = [
    new RegExp(String.raw`\s@\s*(.+?)${stop}`),
    new RegExp(String.raw`\s(?:[Aa]t|[Ii]n)\s+((?:the\s+)?[A-Z0-9][^,;]*?)${stop}`),
    new RegExp(String.raw`\s[Aa]t\s+(home|work|the gym|the office|the lab|school|campus)${stop}`, 'i'),
    // in lowercase, when it's clearly a place: "at the madison", "in robarts library", "at jake's place", "in montreal"
    new RegExp(String.raw`\s(?:at|in)\s+((?:the\s+)?[a-z][\w'.-]*(?:\s+[\w'.-]+){0,3}?)${stop}`, 'i'),
  ];
  for (const re of locRes) {
    const m = text.match(re);
    if (m && re === locRes[3] && !isPlace(m[1])) continue;
    if (m && /^\d+\s*(?:min|mins|minutes?|hours?|hrs?|days?|weeks?|months?|years?)\b/i.test(m[1].trim())) continue; // ("in 2 hours": when)
    if (m) {
      location = unshield(m[1].trim());
      text = text.replace(m[0], ' ');
      break;
    }
  }

  const DANGLING = /^(?:on|at|from|for|by|in|this|next|the|and|to|of|before|after|starting|until|,)\s+|\s+(?:on|at|from|for|by|in|this|next|the|and|to|of|before|after|starting|until|,)$/i;
  if (isDeadline) {
    // "Deadline for X" → "X"; "X due" / "X deadline" → "X" unless only one word would be left ("Tax deadline")
    text = text.replace(/^\s*(?:the\s+)?(?:deadline|due)(?:\s+(?:for|of|on|date))?\s*:?\s+/i, ' ');
    // ("due to dean": a person it goes to, kept)
    const stripped = text.replace(/\b(?:is\s+)?due(?!\s+to\b)(?:\s+(?:on|by|at|date))?\b|\b(?:deadline|cut-?off|closes?|expires)(?:\s+(?:for|of|on|to))?\b|:/gi, ' ');
    // ("due" always goes; "deadline" stays when it would leave one word: "Tax deadline", not "Tax")
    const words = (x: string) => x.trim().split(/\s+/).filter((w) => w && !/^(on|at|by|the|for)$/i.test(w)).length;
    if (words(stripped) >= 1) text = stripped;
    else text = text.replace(/\b(?:is\s+)?due(?!\s+to\b)(?:\s+(?:on|by|at|date))?\b|:/gi, ' ');
  }
  let title = unshield(text).replace(/\s+/g, ' ').replace(/\s+,/g, ',').trim();
  title = cleanTitle(title.replace(/Nyght/g, 'night'), input);
  if (repeat.rule && title && !/\s/.test(title)) {
    const adj = new RegExp(`\\b(quarterly|annual|yearly)\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').exec(input); // (the title escaped: it's the user's text)
    if (adj) title = `${adj[1]} ${title}`;
  }
  for (let prev = ''; prev !== title; ) {
    prev = title;
    title = title.replace(DANGLING, '').replace(/^[,:;\-–\s]+|[,:;\-–\s]+$/g, '').trim();
  }
  title = title.charAt(0).toUpperCase() + title.slice(1);

  // "9am Tokyo time": the clock time is Tokyo's — the same wall time there, as an instant here
  let timeZone: string | undefined;
  if (zone && !allDay && (timeRes || timeFromWords)) {
    const shifted = instantOf(start.getFullYear(), start.getMonth(), start.getDate(), start.getHours() * 60 + start.getMinutes(), zone);
    const delta = shifted - start.getTime();
    start = new Date(shifted);
    end = new Date(end.getTime() + delta);
    timeZone = zone;
  }

  return {
    title,
    timeZone,
    start: start.getTime(),
    end: end.getTime(),
    allDay,
    location,
    calendarId,
    hasDate: !!(dateRes || timeRes),
    hasDay: !!dateRes,
    hasTime: !!timeRes && !forceAllDay,
    timeFromWords,
    hasEnd,
    recurrence,
    repeatDays: repeat.byDayGiven ? repeat.rule?.byDay : undefined,
    deadline: isDeadline ? { leadDays: lead ?? (recurrence ? 2 : 14) } : undefined,
  };
}
