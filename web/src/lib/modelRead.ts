// The on-device model's reading of a document (src-tauri/reader), combined with the rules' (lib/extract.ts).
//
// Each is good at half of it. The model knows what a thing is and what to call it ("Winter Concert", not "<li>Thu,
// Dec 10, 6:30 pm — Winter Concert, gymnasium"), but it drops times, and now and then invents a to-do. The rules
// read dates and times exactly but take their titles from the words around them. So: the rules' times, the model's
// titles; a thing only the model saw is offered, unticked; a thing only the rules saw stays as the rules had it.
import { startOfDay } from 'date-fns';
import { parseQuick, type Parsed } from './quickparse';
import { documentDate, extract, type Extraction, type Proposal } from './extract';
import type { CalendarSource } from '../data/types';

export interface ModelItem { kind: string; title: string; when: string; location: string; repeats: string }

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['the', 'and', 'for', 'with', 'your', 'our', 'from', 'this', 'that', 'event', 'meeting', 'day', 'none']);
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2 && !STOP.has(w)));
const DAY = 86_400_000;

/** The line an item came from: the one sharing most of its title's and date's words. */
function spanOf(text: string, it: ModelItem) {
  const want = words(`${it.title} ${it.when} ${it.location}`);
  const whenW = words(it.when);
  let best = { from: 0, to: 0, score: 0, line: '' };
  let at = 0;
  for (const line of text.split('\n')) {
    const w = words(line);
    const score = [...want].filter((x) => w.has(x)).length + [...whenW].filter((x) => w.has(x)).length; // (date words count twice)
    if (score > best.score) best = { from: at, to: at + line.length, score, line };
    at += line.length + 1;
  }
  return best;
}

/** Words the model says that aren't anywhere in the text: an invented thing, not a misreading. */
function grounded(text: string, it: ModelItem) {
  const t = words(text);
  const w = [...words(`${it.title} ${it.when}`)];
  return w.length > 0 && w.filter((x) => t.has(x)).length / w.length >= 0.5;
}

// to-dos the model makes out of instructions every letter has ("arrive 10 minutes early", "reply YES to confirm")
const BOILERPLATE_TASK = /^(?:call|phone|reply|respond|text|arrive|board|check in|confirm|contact|email|cancel|show up|be there|bring (?:id|photo id)\b|keep|print|read|review|see|visit|log ?in|sign ?in)\b/i;

const sameThing = (p: Proposal, q: { kind: string; parsed: Parsed }) =>
  Math.abs(startOfDay(p.parsed.start).getTime() - startOfDay(q.parsed.start).getTime()) < DAY / 2 && (p.kind === 'task') === (q.kind === 'task');

/** How a proposal is put to the model for review: "event \"Dentist\" Tue Dec 8 3:00 PM — from: Dentist Dec 8 at 3pm." */
export function describeForReview(p: Proposal, text: string) {
  const when = new Date(p.parsed.start).toLocaleString('en-US', p.parsed.hasTime ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { weekday: 'short', month: 'short', day: 'numeric' });
  return `${p.kind} "${p.parsed.title}" ${when} — from: ${text.slice(p.from, p.to).replace(/\s+/g, ' ').trim().slice(0, 200)}`;
}

/** The rules' proposals with the model's review applied: what it would drop starts unticked. */
export function reviewed(rules: Extraction, keep: boolean[] | undefined): Extraction {
  if (!keep || keep.length !== rules.proposals.length) return rules;
  return { ...rules, proposals: rules.proposals.map((p, i) => (keep[i] || p.confidence >= 1 ? p : { ...p, confidence: Math.min(p.confidence, 0.4), why: 'probably not a plan (reviewed on this Mac)' })) };
}

export function combine(items: ModelItem[], text: string, calendars: CalendarSource[], now = new Date(), keep?: boolean[]): Extraction {
  const rules = reviewed(extract(text, calendars, now), keep);
  // a calendar file or a booking: the rules read those exactly
  if (/BEGIN:VEVENT/i.test(text) || rules.proposals.some((p) => p.why === 'flight booking' || p.why === 'calendar file (.ics)')) return rules;
  const docNow = documentDate(text, now);
  const fromModel: Proposal[] = [];
  for (const it of items) {
    const kind = it.kind === 'deadline' || it.kind === 'task' ? it.kind : 'event';
    const title = it.title.trim().replace(/\s+/g, ' ').slice(0, 120);
    if (!title || /^none$/i.test(title) || !grounded(text, it)) continue;
    if (kind === 'task' && BOILERPLATE_TASK.test(title)) continue;
    const span = spanOf(text, it);
    // the date: the model's words, with the time from its own sentence when it left the time out
    const when = it.when.replace(/^none$/i, '').trim();
    let p = when ? parseQuick(`${title} ${when} ${it.repeats.replace(/^none$/i, '')}`.slice(0, 380), calendars, docNow) : null;
    if (span.line && span.score > 0) {
      const own = parseQuick(span.line.slice(0, 380), calendars, docNow);
      if (own.hasDate && (!p || !p.hasDate || (own.hasTime && !p.hasTime && Math.abs(startOfDay(own.start).getTime() - startOfDay(p.start).getTime()) < DAY / 2)))
        p = { ...own, recurrence: p?.recurrence ?? own.recurrence };
    }
    let parsed: Parsed;
    if (p?.hasDate) parsed = { ...p, title };
    else if (kind === 'task') { const d = startOfDay(now).getTime(); parsed = { title, start: d, end: d, allDay: true, hasDate: false, hasDay: false, hasTime: false, timeFromWords: false, hasEnd: false }; }
    else continue;
    if (parsed.start < startOfDay(docNow).getTime() - DAY && !parsed.recurrence) continue; // (already past)
    if (kind === 'deadline' && !parsed.hasTime) { const d = startOfDay(parsed.start); d.setHours(17); parsed = { ...parsed, start: d.getTime(), end: d.getTime(), allDay: false }; }
    const loc = it.location.replace(/^none$/i, '').trim();
    if (loc) parsed = { ...parsed, location: loc.slice(0, 200) };
    fromModel.push({ kind, parsed, from: span.from, to: span.to, confidence: parsed.hasDay ? 0.9 : 0.6, why: 'read on this Mac' });
  }

  // both saw it: the rules' when (and repeat, link), the model's title and kind
  const out: Proposal[] = [];
  const used = new Set<Proposal>();
  for (const r of rules.proposals) {
    const m = fromModel.find((q) => !used.has(q) && sameThing(r, q) && (words(q.parsed.title).size === 0 || [...words(q.parsed.title)].some((w) => words(text.slice(r.from, r.to) + ' ' + r.parsed.title).has(w))))
      ?? fromModel.find((q) => !used.has(q) && sameThing(r, q) && rules.proposals.filter((x) => sameThing(x, q)).length === 1);
    if (m) {
      used.add(m);
      out.push({ ...r, kind: m.kind === 'task' || r.kind === 'task' ? r.kind : m.kind, parsed: { ...r.parsed, title: m.parsed.title, location: r.parsed.location ?? m.parsed.location }, confidence: 1 });
    } else out.push(r);
  }
  // only the model saw it: offered, never ticked (a small model invents now and then; one click adds it)
  for (const m of fromModel) if (!used.has(m) && m.kind !== 'task' && m.parsed.hasDay && !out.some((o) => sameThing(o, m))) out.push({ ...m, confidence: 0.5 });
  return { proposals: out.sort((a, b) => a.parsed.start - b.parsed.start), skipped: rules.skipped };
}
