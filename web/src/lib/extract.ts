// Drop anything, find what's in it: an email, a text thread, an invitation letter, a newsletter, a confirmation — the
// events, deadlines and to-dos it describes, each with the words it came from, for you to tick and add. Nothing leaves
// the device: the text is read here, by the same reader as quick add, one sentence (or "When: / Where:" block) at a time.
//   1. whole formats first: an .ics file (lib/ics.ts), a flight booking (lib/flights.ts)
//   2. what isn't the message is set aside: headers, quoted replies, signatures, footers, phone numbers, prices
//   3. the document's own date ("Sent: …") is what "tomorrow" and "Friday" count from
//   4. each sentence with a date or time becomes a proposal; a block of "When/Where/What" lines becomes one
//   5. cancelled ones are dropped, a later "7:30 it is" replaces an earlier "7?", the same thing twice is kept once
import { addDays, startOfDay } from 'date-fns';
import * as chrono from 'chrono-node';
import type { CalendarSource } from '../data/types';
import { parseQuick, type Parsed } from './quickparse';
import { guessKind } from './tasks';
import { parseIcs } from './ics';
import { parseItinerary } from './flights';
import { decodeEvent } from './recurrence';

export type ExtractKind = 'event' | 'deadline' | 'task';
export interface Proposal {
  kind: ExtractKind;
  parsed: Parsed;
  /** Where in the text it came from (character offsets), for highlighting. */
  from: number;
  to: number;
  /** How sure: 1 = stated plainly, lower = worked out (a guessed time, a relative day). Low ones start unticked. */
  confidence: number;
  why?: string;
}
export interface Extraction {
  proposals: Proposal[];
  /** What was seen but left out, and why ("Sent: …" — when the email was sent). */
  skipped: { text: string; why: string }[];
}

const MAX_TEXT = 200_000;
const DAY = 86_400_000;

// ---------------------------------------------------------------- what isn't the message
const HEADER = /^\s*(?:from|to|cc|bcc|sent|date|reply-to|received|message-id|importance|attachments?)\s*:/i;
const SIGNOFF = /^\s*(?:best|best regards|regards|kind regards|warm regards|thanks|thank you|many thanks|cheers|sincerely|yours|all the best|talk soon|-- ?)\s*[,!.]?\s*$/i;
const QUOTED = /^\s*>|^\s*On .{5,120}wrote:\s*$|^-{2,}\s*(?:original message|forwarded message)\s*-{2,}/i;
const FOOTER = /©|\bcopyright\b|\bunsubscribe\b|\ball rights reserved\b|\bprivacy policy\b|\bview (?:this|in) (?:email|browser)\b/i;
// "Maya Chen  2:14 PM", "[10:42] Sam", a receipt's "11/22/2026 14:31": when a message was written, not a plan
const CHAT_STAMP = /^\s*(?:[A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*){0,3}\s+(?:\d{1,2}:\d{2}\s?(?:[ap]\.?m\.?)?|yesterday|today)\s*$|\[?\d{1,2}:\d{2}(?:\s?[ap]m)?\]\s*[A-Z][\w.'-]*(?:\s[A-Z][\w.'-]*)?\s*$)|\b\d{1,2}\/\d{1,2}\/\d{2,4}\s+\d{1,2}:\d{2}(?::\d{2})?\s*$|\btracking\s*(?:#|no\.?|number)?:?\s*[\d ]{10,}/i;
// "Returns accepted within 30 days", "valid for 12 months", "allow 5–7 business days": a rule, not an appointment
const POLICY = /\b(?:within|for up to|up to|allow|takes?|valid for|expires? in|after)\s+\d+(?:\s*[-–]\s*\d+)?\s+(?:business\s+|working\s+|calendar\s+)?(?:days?|weeks?|months?|hours?)\b(?!\s+(?:from now|before))|\b(?:returns?|refunds?|exchanges?)\s+(?:are\s+)?(?:accepted|available|policy)\b/i;
const CANCELLED = /\b(?:cancel+ed|called off|postponed|no longer|won'?t be happening|is off\b|scrapped)\b/i;
const PAST_REF = /\b(?:thank(?:s| you) (?:to )?(?:everyone|all) who|was held|took place|last (?:week|month|year)|came out to|attended)\b/i;

/** The lines that carry the message, with their offsets: headers, quoted replies, signatures and footers are left out. */
function messageLines(text: string) {
  return joinWrapped(rawLines(text));
}
/** Lines that are one sentence wrapped across two (a PDF's, a narrow email's) joined back: a line that doesn't end a
 *  sentence, followed by one that continues it in lowercase or with the rest of a date/time. */
function joinWrapped(lines: { s: string; at: number }[]) {
  const out: { s: string; at: number }[] = [];
  for (const l of lines) {
    const prev = out[out.length - 1];
    const cont = prev && prev.s.trim() && l.s.trim() && !/[.!?:;]\s*$/.test(prev.s) && !KEY.test(l.s) && !/^\s*[-•*·–]|^\s*\d{1,2}[.)]\s/.test(l.s) &&
      (/^\s*[a-z(]/.test(l.s) || /^\s*(?:from|at|until|to|and|in|on)\b/i.test(l.s) || (prev.s.length > 45 && /^\s*\d/.test(l.s)));
    if (cont) prev.s = `${prev.s.replace(/\s+$/, '')} ${l.s.trim()}`;
    else out.push({ ...l });
  }
  return out;
}
function rawLines(text: string) {
  const lines: { s: string; at: number }[] = [];
  let at = 0, signed = false, quoted = false;
  let inHeader = /^\s*(?:from|to|sent|date|subject)\s*:/i.test(text);
  for (const raw of text.split('\n')) {
    const s = raw.replace(/\r$/, '');
    const here = at;
    at += raw.length + 1;
    if (QUOTED.test(s)) quoted = true;
    if (quoted || signed) continue;
    if (SIGNOFF.test(s)) { signed = lines.length > 0; continue; }
    // (header lines only at the top of an email: "Date: December 2" further down is the appointment)
    if ((inHeader && HEADER.test(s)) || FOOTER.test(s) || CHAT_STAMP.test(s)) continue;
    if (!s.trim()) inHeader = false;
    lines.push({ s, at: here });
  }
  return lines;
}

/** The document's own date: "Sent: Monday, November 23, 2026 9:12 AM", "Date: 2026-11-20" — else now. */
function documentDate(text: string, now: Date) {
  // (only in an email's header — "Date: December 2" in a confirmation is the appointment, not when it was sent)
  const head = text.split('\n').slice(0, 15).join('\n');
  if (!/^\s*(?:from|to)\s*:/im.test(head)) return now;
  const m = /^\s*(?:sent|date)\s*:\s*(.+)$/im.exec(head);
  const d = m ? chrono.parseDate(m[1], now) : null;
  return d && Math.abs(d.getTime() - now.getTime()) < 400 * DAY ? d : now;
}

/** The subject or heading, as a fallback title: "Subject: Committee meeting + draft chapter" → "Committee meeting". */
function subjectOf(text: string) {
  const m = /^\s*subject\s*:\s*(?:(?:re|fwd?|fw)\s*:\s*)*(.+)$/im.exec(text);
  if (m) return m[1].split(/\s*(?:\+|&|—|–|-|\|)\s*/)[0].trim();
  const first = text.split('\n').map((s) => s.trim()).find((s) => s && s.length <= 70 && !HEADER.test(s));
  return first && !/[.!?:]$/.test(first) && first.split(/\s+/).length <= 9 ? first : undefined;
}

/** RRULE of a dropped VEVENT, as the app's rule (the common parts: FREQ, INTERVAL, BYDAY, UNTIL). */
function icsRule(text: string) {
  const m = /^RRULE:(.+)$/im.exec(text);
  if (!m) return undefined;
  const kv = Object.fromEntries(m[1].trim().split(';').map((x) => x.split('=') as [string, string]));
  const freq = ({ DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' } as const)[kv.FREQ as 'DAILY'];
  if (!freq) return undefined;
  const codes = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  const byDay = kv.BYDAY ? kv.BYDAY.split(',').map((d) => codes.indexOf(d.slice(-2))).filter((d) => d >= 0) : undefined;
  // UNTIL kept (a series that ends, ends); COUNT is left to the occurrences the file lists
  const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(kv.UNTIL ?? '');
  const until = u ? (u[7] ? Date.UTC(+u[1], +u[2] - 1, +u[3], +u[4], +u[5], +u[6]) : new Date(+u[1], +u[2] - 1, +u[3], u[4] ? +u[4] : 23, u[5] ? +u[5] : 59).getTime()) : undefined;
  return { freq, interval: Math.max(1, +(kv.INTERVAL ?? 1) || 1), ...(byDay?.length && (freq as string) === 'weekly' ? { byDay } : {}), ...(until ? { until } : {}) };
}

/** Written dates made plain for the reader: a weekday in front of a full date goes ("Thursday, December 10", "Thu 17
 *  Dec 2026" — the date says it), "Dep 10:00 Arr 14:24" is a range. */
const SMALL: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const ORD_W: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17, eighteenth: 18, nineteenth: 19, twentieth: 20, thirtieth: 30 };
const ordWord = (w: string) => {
  const m = /^(twenty|thirty)[-\s]?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)$/i.exec(w);
  return m ? (m[1].toLowerCase() === 'twenty' ? 20 : 30) + ORD_W[m[2].toLowerCase()] : ORD_W[w.toLowerCase()];
};
const ORD_RE = '(?:(?:twenty|thirty)[-\\s]?(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth)';
/** Formal dates in words: "June twelfth, two thousand twenty-seven" → "June 12 2027"; "the first of April" → "April 1". */
function wordDates(t: string) {
  const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*';
  t = t.replace(/\btwo thousand(?:\s+and)?\s+(twenty|thirty)(?:[-\s](one|two|three|four|five|six|seven|eight|nine))?\b/gi, (_, tens: string, one?: string) => String(2000 + (tens.toLowerCase() === 'twenty' ? 20 : 30) + (one ? SMALL[one.toLowerCase()] : 0)));
  t = t.replace(new RegExp(`\\b${MON}\\s+(?:the\\s+)?(${ORD_RE})\\b`, 'gi'), (m, _mo: string, o: string) => m.replace(o, String(ordWord(o))).replace(/\s+the\s+/i, ' '));
  t = t.replace(new RegExp(`\\b(?:the\\s+)?(${ORD_RE})\\s+(?:day\\s+)?of\\s+${MON}\\b`, 'gi'), (m, o: string) => `${m.replace(/^(?:the\s+)?\S+(?:[-\s](?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth))?\s+(?:day\s+)?of\s+/i, '')} ${ordWord(o)}`);
  return t;
}

function plainDates(t: string) {
  t = wordDates(t);
  // a rota's shorthand: "3p-11p", "7a–3p" → "3pm-11pm"
  t = t.replace(/\b(\d{1,2}(?::\d\d)?)([ap])(?=\s*[-–]\s*\d{1,2}(?::\d\d)?[ap]\b)/gi, '$1$2m').replace(/(?<=[-–]\s*)(\d{1,2}(?::\d\d)?)([ap])\b/gi, '$1$2m');
  const WD = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(?:day|nesday|sday|urday)?\\.?,?';
  const MON = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  return t
    .replace(new RegExp(`\\b${WD}\\s+(?=(?:the\\s+)?\\d{1,2}(?:st|nd|rd|th)?\\s+${MON}|${MON}\\s+\\d{1,2}\\b|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\/\\d{1,2})`, 'gi'), '')
    .replace(/\bdep(?:art(?:s|ure)?)?\.?\s*:?\s*(\d{1,2}:\d\d(?:\s*[ap]m)?)\s+arr(?:ives?|ival)?\.?\s*:?\s*(\d{1,2}:\d\d(?:\s*[ap]m)?)/gi, '$1 - $2');
}
const LENGTH = /\b(?:plan for|allow|it(?:'ll| will) (?:take|last|run)|lasts?|runs?|about|approx(?:imately)?\.?)\s+(?:about\s+)?(\d+(?:\.\d+)?|an?|one|two|three)\s*(hours?|hrs?|minutes?|mins?)\b/i;
/** "Dentist appointment" for a dental clinic's confirmation, and the like — when the document is about an appointment. */
function appointmentTitle(text: string) {
  if (!/\bappointment\b/i.test(text)) return undefined;
  const kinds: [RegExp, string][] = [[/\bdent(?:al|ist)\b/i, 'Dentist appointment'], [/\bvet(?:erinary)?\b|\banimal hospital\b/i, 'Vet appointment'], [/\b(?:physio(?:therapy)?)\b/i, 'Physio appointment'], [/\b(?:optometr\w*|eye exam)\b/i, 'Eye exam'], [/\b(?:salon|barber|haircut)\b/i, 'Haircut'], [/\b(?:clinic|doctor|dr\.|physician|medical)\b/i, "Doctor's appointment"]];
  return kinds.find(([re]) => re.test(text))?.[1] ?? 'Appointment';
}

// ---------------------------------------------------------------- units: sentences and When/Where blocks
interface Unit { s: string; from: number; to: number; where?: string; what?: string; heading?: string }
const KEY = /^\s*(when|date|time|where|location|venue|place|room|what|event|title|deadline|due|rsvp)\s*[:\-–]\s*(.+)$/i;

function units(text: string): Unit[] {
  const out: Unit[] = [];
  const lines = messageLines(text);
  let block: Unit | null = null;
  let heading: string | undefined;
  const flush = () => { if (block) out.push(block); block = null; };
  for (const { s: line, at } of lines) {
    // a chat line: "[11/23, 9:52 PM] Priya: dinner thursday" — the stamp is when it was sent, the name who said it
    const raw = line.replace(/^\s*\[[^\]]{3,30}\]\s*/, (m) => ' '.repeat(m.length)).replace(/^(\s*)([A-Z][\w .'-]{0,20}?(?:\s*\p{Extended_Pictographic})?)\s*:\s+(?=\S)/u, (m, sp: string) => sp + ' '.repeat(m.length - sp.length));
    const s = plainDates(raw);
    const kv = KEY.exec(s);
    if (kv) {
      const k = kv[1].toLowerCase(), v = kv[2].trim();
      block ??= { s: '', from: at, to: at + raw.length, heading };
      block.to = at + raw.length;
      if (/^(where|location|venue|place|room)$/.test(k)) block.where = v;
      else if (/^(what|event|title)$/.test(k)) block.what = v;
      else block.s += (block.s ? ' ' : '') + (/^(deadline|due|rsvp)$/.test(k) ? `${k} ${v}` : v);
      continue;
    }
    flush();
    if (!s.trim()) continue;
    // a short line with no date of its own is a heading for what follows ("Train 45 Toronto → Ottawa")
    if (/^\s*(?:dear|hi|hello|hey|good (?:morning|afternoon|evening))\b[^.!?\d]{0,40},?\s*$/i.test(s)) continue; // ("Hi TAs," alone)
    if (s.trim().length <= 70 && !/\d{1,2}[:/]\d|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d/i.test(s) && !/[.!?]$/.test(s.trim())) heading = s.trim().replace(/[:\-–]\s*$/, '');
    // a line may hold several sentences; each is a unit (bullets and "Date: thing" newsletter lines too)
    const re = /[^.!?\n—]+?(?:[.!?]+(?=\s|$)|\s+—\s+|\s+-{1,2}\s+(?=[a-z])|$)/gi;
    // (split the line as written, so a unit's span is where it really sits; then make each piece plain)
    for (const m of raw.matchAll(re)) {
      const t = plainDates(m[0]).trim();
      if (t.length < 4) continue;
      out.push({ s: t.replace(/^(?:[-•*·–]+\s*|\d{1,2}[.)]\s+)/, ''), from: at + m.index!, to: at + m.index! + m[0].length, heading });
    }
  }
  flush();
  return out;
}

const hasWhen = (s: string, now: Date) => chrono.parse(s, now, { forwardDate: true }).some((r) => r.start.isCertain('day') || r.start.isCertain('weekday') || r.start.isCertain('hour'));
const GENERIC = /^(?:it|this|that|we|let'?s|meet|the meeting|meeting|event|new event|untitled|please|reminder|note|join(?: the)? meeting|join (?:on|with) (?:zoom|teams)|alternatively|add to calendar)$|\|.*\|/i;

/** A short, natural title for what a sentence describes, when the reader's own is a whole clause. */
function tidyTitle(title: string, unit: Unit, subject?: string, preferSubject = false) {
  let t = (unit.what ?? title).trim();
  t = t.replace(/^(?:please\s+)?(?:note|reminder|fyi|just a reminder)\s*(?:that|:)?\s*/i, '')
    .replace(/^(?:we(?:'re| are| will| ?'ll)?|i(?:'m| am| will| ?'ll)?|you(?:'re| are)?|let'?s|can we|could we|shall we|our)\s+(?:have\s+(?:a|an|the|our)\s+|be\s+having\s+(?:a|an|the|our)\s+|meet(?:ing)?\s*(?:for|to)?\s*|do\s+|hold\s+(?:a|an|the|our)\s+)?/i, '')
    .replace(/^(?:(?:you(?:'re| are)\s+)?(?:cordially\s+)?invited\s+to|join us (?:for|at)|please join us (?:for|at)|we invite you to|welcome to)\s+/i, '')
    .replace(/^(?:the|a|an|our|your)\s+/i, '')
    .replace(/\s*,?\s*\b(?:room|rm)\s+[\w-]+\s*$/i, '')
    .replace(/(?:\s+(?:on|at|in|from|by))+\s*[,;]?\s*$/i, '')
    .replace(/\s+(?:is|are|will be|has been|have been|was)\s*(?:on|scheduled|set|planned|booked)?\s*(?:for)?\s*$/i, '')
    .replace(/\s+(?:is|are)\s+(?:scheduled|set|planned|booked)(?:\s+for)?\b.*$/i, '')
    .replace(/[,;:]\s*$/, '')
    .trim();
  const junk = !t || GENERIC.test(t) || t.split(/\s+/).length > 9 || t.length < 3 ||
    /^[\d\s:,.\-–/]+$|^(?:dep|arr|coach|seat|gate|platform|time|date|dates|hours|runs|welcome|this confirms|confirm|want to|if not|arrive|all |unless|moves?|no )\b|^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}$|\b(?:is|are|was|were|be)\s*$|[,(]\s*$/i.test(t);
  if (junk) t = (preferSubject ? subject : undefined) ?? (unit.heading && unit.heading.split(/\s+/).length <= 9 && !/^this confirms|:$/i.test(unit.heading) ? unit.heading : subject ?? t);
  return t ? t[0].toUpperCase() + t.slice(1) : 'New event';
}

/** Pasted HTML source or Markdown, as plain text with every character where it was (the highlights still line up):
 *  tags and ** markers become spaces, a closing block tag a line break, an entity its character. */
const blank = (m: string) => m.replace(/[^\n]/g, ' ');
const ENTITY: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', hellip: '…' };
export function unmark(text: string) {
  let t = text;
  if ((t.match(/<\/?(?:p|br|div|li|ul|td|tr|table|b|strong|span|h\d|a)\b[^>]*>/gi)?.length ?? 0) >= 3) {
    t = t.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, blank)
      .replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d|\/table)\b[^>]*>/gi, (m) => '\n' + ' '.repeat(m.length - 1))
      .replace(/<[^>\n]*>/g, blank)
      .replace(/&(#\d+|[a-z]+);/gi, (m, n: string) => {
        const c = n[0] === '#' ? String.fromCharCode(+n.slice(1)) : ENTITY[n.toLowerCase()];
        return c === undefined ? m : c + ' '.repeat(m.length - 1);
      });
  }
  return t.replace(/\*\*|__(?=\w)|(?<=\w)__/g, blank);
}

// ---------------------------------------------------------------- the reading
export function extract(input: string, calendars: CalendarSource[], now = new Date()): Extraction {
  const text = unmark(input.length > MAX_TEXT ? input.slice(0, MAX_TEXT) : input);
  const skipped: Extraction['skipped'] = [];

  // 1. whole formats
  if (/BEGIN:VEVENT/i.test(text)) {
    const cal = parseIcs(text, 'drop', now.getTime() - 30 * DAY, now.getTime() + 800 * DAY);
    // (a repeating event comes back as its occurrences: one proposal per series, the first one, with its rule)
    // (each VEVENT's own rule: a weekly class beside a one-off party leaves the party one-off)
    const rules = new Map<string, ReturnType<typeof icsRule>>();
    for (const block of text.split(/BEGIN:VEVENT/i).slice(1)) {
      const title = /^SUMMARY[^:\r\n]*:(.*)$/im.exec(block)?.[1].trim().replace(/\\([,;\\])/g, '$1').replace(/\\n/gi, ' ');
      if (title !== undefined) rules.set(title, icsRule(block.split(/END:VEVENT/i)[0]));
    }
    const ruleOf = (title: string) => rules.get(title.trim());
    const seen = new Set<string>();
    const firsts = cal.events.sort((a, b) => a.start - b.start).filter((e) => { const k = e.title + '|' + (ruleOf(e.title) ? '' : e.start); if (seen.has(k)) return false; seen.add(k); return true; });
    const proposals: Proposal[] = firsts.map((raw) => {
      const e = decodeEvent(raw);
      const parsed: Parsed = { title: e.title, start: e.start, end: e.end, allDay: e.allDay, location: e.location, hasDate: true, hasDay: true, hasTime: !e.allDay, timeFromWords: false, hasEnd: true, recurrence: ruleOf(e.title) ?? e.recurrence };
      return { kind: 'event', parsed, from: 0, to: text.length, confidence: 1, why: 'calendar file (.ics)' };
    });
    return { proposals, skipped };
  }
  if (/\b(?:automatic reply|auto-?reply|out of (?:the )?office)\b/i.test(text.slice(0, 600)) || /\bterms (?:of service|and conditions)\b/i.test(text.slice(0, 800)))
    return { proposals: [], skipped: [{ text: text.slice(0, 80), why: 'an automatic reply or terms — nothing to add' }] };
  const flights = parseItinerary(text, now);
  let docNow = documentDate(text, now);
  // a shift schedule: three or more lines that are just a day and hours ("Wed 3p-11p", "12/6 D 07:00-19:30")
  const ROTA_LINE = /^\s*(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?|\d{1,2}\/\d{1,2})\s+(?:[DNE]\s+|day\s+|night\s+|eve\s+)?(?:\d{1,2}(?::?\d\d)?\s*[ap]?m?\s*[-–]\s*\d{1,2}(?::?\d\d)?\s*[ap]?m?|off|rest|—)\s*$/gim;
  const rota = (text.match(ROTA_LINE)?.length ?? 0) >= 3;
  if (rota) {
    // "Rota wk of Nov 30": its weekdays are that week's
    const wk = /\b(?:wk|week)\s+(?:of|starting|beginning|commencing)\s+([^\n—,(]+)/i.exec(text);
    const p = wk && parseQuick(wk[1], calendars, docNow);
    if (p?.hasDay) docNow = new Date(startOfDay(p.start).getTime() - DAY / 2);
  }
  const thread = /^\s*(?:\[[^\]]+\]\s*)?[A-Z][\w .'-]{0,20}:\s+\S/m.test(text) && (text.match(/^\s*(?:\[[^\]]+\]\s*)?[A-Z][\w .'-]{0,20}:\s+\S/gm)?.length ?? 0) >= 2 || /^\s*(?:re|fwd?):/im.test(text) || /\bwrote:\s*$/im.test(text);
  const appt = appointmentTitle(text);
  const subject = appt ?? subjectOf(text);

  // 4. each unit with a date or time
  let proposals: Proposal[] = flights.map((f) => ({
    kind: 'event' as const,
    parsed: { title: f.title, start: f.start, end: f.end, allDay: false, hasDate: true, hasDay: true, hasTime: true, timeFromWords: false, hasEnd: f.hasArrival, timeZone: undefined },
    from: 0, to: 0, confidence: 1, why: 'flight booking',
  }));
  const cancelledDays = new Set<number>();
  let lastEvent: Proposal | null = null;
  for (const u of units(text)) {
    const s = u.s;
    const len = LENGTH.exec(s);
    if (len && lastEvent && !lastEvent.parsed.allDay && !hasWhen(s.replace(len[0], ''), docNow)) {
      const n = /^an?$|^one$/i.test(len[1]) ? 1 : len[1] === 'two' ? 2 : len[1] === 'three' ? 3 : +len[1];
      lastEvent.parsed = { ...lastEvent.parsed, end: lastEvent.parsed.start + n * (/^h/i.test(len[2]) ? 3_600_000 : 60_000) };
      continue;
    }
    // a chore that belongs to the thing just mentioned ("please bring the vaccine record", "bring snacks pls", "also book
    // the projector beforehand", "I'll make mashed potatoes"): a to-do due that day
    const chore = /^(?:(?:also|and|so|pls|please|just|oh|and also)\s+)*(?:i'?ll\s+|you'?ll need to\s+|you need to\s+|remember to\s+|don'?t forget to\s+|make sure to\s+|be sure to\s+)?(bring|book|make|pick up|send|print|pack|fill out|fill in|sign|order|buy|prepare|prep)\b\s+(.{3,80}?)(?:\s+(?:pls|please|beforehand|before(?:\s+then)?|ahead of time|in advance|that day|with you))*[.!]*$/i.exec(s.trim());
    if (chore && lastEvent && !hasWhen(s, docNow)) {
      const title = `${chore[1][0].toUpperCase()}${chore[1].slice(1).toLowerCase()} ${chore[2].replace(/\s+(?:pls|please)$/i, '')}`.trim();
      const d0 = startOfDay(lastEvent.parsed.start).getTime();
      proposals.push({ kind: 'task', parsed: { title, start: d0, end: d0, allDay: false, hasDate: true, hasDay: true, hasTime: false, timeFromWords: false, hasEnd: false }, from: u.from, to: u.to, confidence: 0.5, why: `for ${lastEvent.parsed.title}` });
      continue;
    }
    if (!hasWhen(s, docNow)) {
      // "7:30 it is", "can we do 7:30" with no day: a change to the last thing proposed
      const t = /^(?:(?:ok(?:ay)?|sure|great|perfect|yes|yep|ya|let'?s (?:do|say|make it)|can we (?:do|make it)|how about|actually|make it|at|around)\s*[,!]?\s*)*(\d{1,2}(?::\d\d)?\s*(?:am|pm)?)\s*(?:it is|works|then|instead|\?|!|$)/i.exec(s.trim());
      if (t && lastEvent) {
        const p = parseQuick(`${lastEvent.parsed.title} ${new Date(lastEvent.parsed.start).toDateString()} at ${t[1]}`, calendars, docNow);
        if (p.hasTime) {
          const len = lastEvent.parsed.allDay ? p.end - p.start : lastEvent.parsed.end - lastEvent.parsed.start;
          lastEvent.parsed = { ...lastEvent.parsed, allDay: false, hasTime: true, start: p.start, end: p.start + len };
          lastEvent.to = u.to;
          lastEvent.why = `time from a later message: ${t[1]}`;
        }
      }
      continue;
    }
    if (CANCELLED.test(s)) {
      const p = parseQuick(s, calendars, docNow);
      cancelledDays.add(startOfDay(p.start).getTime());
      skipped.push({ text: s, why: 'cancelled' });
      continue;
    }
    if (rota && /^\s*\S+\s+(?:off|rest|—)\s*$/i.test(s)) { skipped.push({ text: s, why: 'a day off' }); continue; }
    if (POLICY.test(s)) { skipped.push({ text: s, why: 'a policy, not a date' }); continue; }
    if (PAST_REF.test(s)) { skipped.push({ text: s, why: 'already happened' }); continue; }
    // a sentence with two things ("dentist tue 9am and haircut thu 4"): each on its own
    if (rota && /\b(?:wk|week)\s+(?:of|starting|beginning|commencing)\b/i.test(s) && s.length < 60) continue; // (the schedule's own title)
    const parts = rota && new RegExp(ROTA_LINE.source, 'i').test(s) ? [s.replace(/^(\s*\S+\s+)(?:[DNE]|day|night|eve)\s+/i, '$1')] : splitTwo(s, docNow);
    for (const part of parts) {
      const p = parseQuick(part.slice(0, 300), calendars, docNow);
      if (!p.hasDate) continue;
      // a time with no day of its own, after something with a day ("climbing tomorrow? 6pm at Basecamp", "ok 3",
      // "fine gerstein 3pm"): the time of that thing, not a new one today
      if (lastEvent && p.hasTime && !p.hasDay && !p.recurrence && lastEvent.parsed.hasDay) {
        const day = new Date(lastEvent.parsed.start);
        const at = new Date(p.start);
        const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), at.getHours(), at.getMinutes()).getTime();
        const len = p.hasEnd ? p.end - p.start : lastEvent.parsed.allDay ? 3_600_000 : lastEvent.parsed.end - lastEvent.parsed.start;
        lastEvent.parsed = { ...lastEvent.parsed, allDay: false, hasTime: true, start, end: start + len, location: u.where ?? p.location ?? lastEvent.parsed.location };
        lastEvent.to = u.to;
        lastEvent.why = 'time from a later line';
        continue;
      }
      // in a thread, "ok sunday then! meet at Union 8am", "actually thursday at 4": the plan changed, not a second one
      if (lastEvent && thread && /\b(?:then|instead|actually|ok(?:ay)?|let'?s do|works better|moved? to|change(?:d)? to|switch(?:ed)? to)\b/i.test(part) && p.hasDay) {
        lastEvent.parsed = { ...lastEvent.parsed, allDay: p.allDay, hasTime: p.hasTime, start: p.start, end: p.allDay ? p.end : p.start + (p.hasEnd ? p.end - p.start : 3_600_000), location: p.location ?? lastEvent.parsed.location };
        lastEvent.to = u.to;
        lastEvent.why = 'changed later in the thread';
        continue;
      }
      if (p.start < startOfDay(docNow).getTime() - DAY && !p.recurrence) { skipped.push({ text: part, why: 'already past' }); continue; }
      const deadlineWords = /\b(?:due|deadline|by|before|no later than|rsvp|register|registration|submit|submission|closes?|cut-?off|apply|send)\b/i.test(part);
      let kind: ExtractKind = guessKind(part, p) === 'task' ? 'task' : p.deadline ? 'deadline' : 'event';
      if (kind === 'event' && deadlineWords && !p.hasEnd && /\b(?:due|deadline|rsvp|registration|submission|closes?|cut-?off|by)\b/i.test(part)) kind = 'deadline';
      let title = tidyTitle(p.title, u, subject, !!appt);
      if (rota && new RegExp(ROTA_LINE.source, 'i').test(u.s)) {
        const code = /^\s*\S+\s+([DNE]|day|night|eve)\b/i.exec(u.s)?.[1].toLowerCase()[0];
        title = code === 'n' ? 'Night shift' : code === 'd' ? 'Day shift' : code === 'e' ? 'Evening shift' : 'Shift';
      }
      const parsed: Parsed = { ...p, title, location: u.where ?? p.location };
      const confidence = (p.hasTime || p.allDay ? 0.6 : 0.4) + (p.hasDay ? 0.3 : 0) + (u.what || u.where ? 0.1 : 0);
      const prop: Proposal = { kind, parsed, from: u.from, to: u.to, confidence: Math.min(1, confidence) };
      proposals.push(prop);
      if (kind === 'event') lastEvent = prop;
    }
  }

  // a schedule's own time ("All seminars are Tuesdays 11:00–12:00", "every session runs 7–9 pm"): its all-day rows get it
  const common = /\b(?:all|every|each)\s+(?:seminars?|sessions?|talks?|classes|lectures?|meetings?|events?|games?|practices?|shifts?|rehearsals?)\b[^.\n]{0,80}?\b(\d{1,2}(?::\d\d)?\s*(?:am|pm)?)\s*(?:-|–|to|until)\s*(\d{1,2}(?::\d\d)?\s*(?:am|pm)?)/i.exec(text)
    ?? /\b(?:all|every|each)\s+(?:seminars?|sessions?|talks?|classes|lectures?|meetings?|events?|games?|practices?|shifts?|rehearsals?)\b[^.\n]{0,80}?\bat\s+(\d{1,2}(?::\d\d)?\s*(?:am|pm)?)/i.exec(text);
  if (common) {
    const p = parseQuick(`x today ${common[1]}${common[2] ? ` - ${common[2]}` : ''}`, calendars, docNow);
    if (p.hasTime) {
      const startMin = new Date(p.start).getHours() * 60 + new Date(p.start).getMinutes(), len = p.end - p.start;
      for (const q of proposals) if (q.kind === 'event' && q.parsed.allDay && startOfDay(q.parsed.end - 1).getTime() === startOfDay(q.parsed.start).getTime()) {
        const d = new Date(q.parsed.start);
        const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, startMin).getTime();
        q.parsed = { ...q.parsed, allDay: false, hasTime: true, start, end: start + len };
      }
    }
  }

  // 5. cancelled days out; the same thing twice kept once (the one with more said about it)
  proposals = proposals.filter((p) => !cancelledDays.has(startOfDay(p.parsed.start).getTime()) || p.why === 'flight booking');
  const kept: Proposal[] = [];
  for (const p of proposals) {
    const dup = kept.find((k) => k.kind === p.kind && Math.abs(k.parsed.start - p.parsed.start) < 60_000 && (k.parsed.title === p.parsed.title || k.kind === 'event'));
    if (!dup) kept.push(p);
    else if ((p.parsed.location && !dup.parsed.location) || p.confidence > dup.confidence) Object.assign(dup, p);
  }
  return { proposals: kept.sort((a, b) => a.parsed.start - b.parsed.start), skipped };
}

/** "dentist tue 9am and haircut thu 4", "call Bob at 2, then gym at 5": two things, each with its own when. */
export function splitTwo(s: string, now: Date): string[] {
  const m = /^(.+?)(?:,?\s+(?:and then|then|and also|and|plus|also)\s+|;\s*)(.+)$/i.exec(s);
  if (!m) return [s];
  const [a, b] = [m[1], m[2]];
  const whenA = chrono.parse(a, now).length > 0 || /\b\d{1,2}(?::\d\d)?\s*(?:am|pm)?\b/i.test(a);
  const whenB = chrono.parse(b, now).length > 0 || /\b\d{1,2}(?::\d\d)?\s*(?:am|pm)?\b/i.test(b);
  // both halves need a thing and a when ("lunch with Sam and Ana at noon" is one thing)
  const thing = (x: string) => x.replace(/\b(?:at|on|by|from|to|\d{1,2}(?::\d\d)?\s*(?:am|pm)?|mon|tue|wed|thu|fri|sat|sun|today|tomorrow|tonight)[a-z]*\b/gi, '').trim().split(/\s+/).filter(Boolean).length >= 1;
  return whenA && whenB && thing(a) && thing(b) ? [a, ...splitTwo(b, now)] : [s];
}

/** Days from now (start-of-day), for labels. */
export const dayOffset = (t: number, now: Date) => Math.round((startOfDay(t).getTime() - startOfDay(now).getTime()) / DAY);
void addDays;
