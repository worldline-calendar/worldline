// Scoring quick add like a model: each typed sentence has a known right answer (or several, when a person would be
// unsure too); quick add's first reading and the other readings it offers are compared with it, field by field.
//   top-1: the first reading is right          top-3: one of the readings shown is right
// Corpora: src/nlp/corpus.dev.json (tuned against) and test-heldout/corpus.heldout.json (only measured).
import { format } from 'date-fns';
import { parseQuick, type Parsed } from '../lib/quickparse';
import { readings } from '../lib/readings';
import { guessKind, hasTaskPrefix, stripTaskPrefix, taskFromParsed } from '../lib/tasks';
import { wallClock } from '../lib/zone';
import { DEFAULT_CALENDARS } from '../data/mock';
import type { Recurrence } from '../data/types';

export interface Answer {
  kind: 'event' | 'task' | 'deadline';
  title: string;
  start: string | null;
  end: string | null;
  repeat: string | null;
  zone: string | null;
  loc: string | null;
  cal: string | null;
}
export interface Case extends Answer {
  input: string;
  cat: string;
  alts?: Partial<Answer>[];
}

export const FIELDS = ['kind', 'title', 'start', 'end', 'repeat', 'zone', 'loc', 'cal'] as const;
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const pad = (n: number) => String(n).padStart(2, '0');

export function ruleString(r: Recurrence | undefined, allDay: boolean): string | null {
  if (!r) return null;
  const parts = [`FREQ=${r.freq.toUpperCase()}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byDay?.length && (r.freq === 'weekly' || r.nth)) parts.push(`BYDAY=${r.byDay.map((d) => (r.nth ? r.nth : '') + DAYS[d]).join(',')}`);
  if (r.until !== undefined) parts.push(`UNTIL=${format(allDay ? r.until : r.until, 'yyyy-MM-dd')}`);
  return parts.join(';');
}

/** A reading of a sentence, written the way the corpus writes answers. */
export function answerOf(input: string, p: Parsed, kind = guessKind(input, p)): Answer {
  const zone = p.timeZone ?? null;
  const clock = (t: number) => {
    const w = wallClock(t, zone ?? undefined);
    return `${w.y}-${pad(w.m + 1)}-${pad(w.d)} ${pad(w.h)}:${pad(w.min)}`;
  };
  const cal = p.calendarId ? DEFAULT_CALENDARS.find((c) => c.id === p.calendarId)?.name.toLowerCase() ?? null : null;
  if (kind === 'task') {
    const t = taskFromParsed(p);
    return { kind, title: t.title, start: t.due === undefined ? null : format(t.due, 'yyyy-MM-dd'), end: null, repeat: null, zone: null, loc: null, cal };
  }
  if (kind === 'deadline') {
    return { kind, title: p.title, start: clock(p.start), end: null, repeat: ruleString(p.recurrence, false), zone, loc: p.location ?? null, cal };
  }
  return {
    kind,
    title: p.title,
    start: p.allDay ? format(p.start, 'yyyy-MM-dd') : clock(p.start),
    end: p.allDay ? format(p.end - 1, 'yyyy-MM-dd') : clock(p.end),
    repeat: ruleString(p.recurrence, p.allDay),
    zone,
    loc: p.location ?? null,
    cal,
  };
}

/** What quick add would show for `input`: its first reading, then the others it offers (as many as the UI shows). */
export function interpret(input: string, now: Date, max = 3): Answer[] {
  const text = hasTaskPrefix(input) ? stripTaskPrefix(input) : input;
  const p = parseQuick(text, DEFAULT_CALENDARS, now);
  const first = answerOf(input, p);
  const rest = readings(text, DEFAULT_CALENDARS, now, max - 1, first.kind).map((r) => answerOf(input, r.parsed, r.kind ?? first.kind));
  return [first, ...rest].slice(0, max);
}

const norm = (f: (typeof FIELDS)[number], v: unknown) =>
  v === undefined || v === null || v === '' ? null : f === 'title' || f === 'loc' || f === 'cal' ? String(v).trim().replace(/[.!?,;:]+$/, '').toLowerCase().replace(/\s+/g, ' ') : String(v);

// (the order weekdays are listed in doesn't matter: SA,SU = SU,SA)
// (and "monthly on the 15th" may name its day: the app keeps that in the start date)
const byDaySorted = (r: string | null | undefined) =>
  r == null ? null : r.replace(/BYDAY=([^;]+)/, (_, d: string) => `BYDAY=${d.split(',').sort().join(',')}`).replace(/;BYMONTHDAY=[^;]+/, '');

/** Every answer that counts as right for a case. */
export const accepted = (c: Case): Answer[] => [c, ...(c.alts ?? []).map((a) => ({ ...c, ...a }))];

/** The fields `got` gets wrong against the closest accepted answer (none: right). */
export function wrongFields(c: Case, got: Answer): string[] {
  let best: string[] | null = null;
  for (const a of accepted(c)) {
    const bad = FIELDS.filter((f) => {
      if (f === 'cal' && a.cal == null) return false; // (a calendar only counts when the sentence names one)
      if (f === 'loc' && a.loc == null && got.loc == null) return false;
      if ((f === 'end' || f === 'repeat' || f === 'zone') && a.kind !== got.kind) return false; // (judged with kind)
      if (f === 'repeat' && a.repeat && /COUNT=/.test(a.repeat)) {
        // ("for 6 weeks" written as a count; the app keeps the end date instead — the rule itself must match)
        const base = (x: string | null) => (x ?? '').split(';').filter((p) => !/^(COUNT|UNTIL)=/.test(p)).join(';');
        return base(a.repeat) !== base(got.repeat) || !/UNTIL=/.test(got.repeat ?? '');
      }
      if (f === 'repeat') return byDaySorted(a.repeat) !== byDaySorted(got.repeat);
      return norm(f, a[f]) !== norm(f, got[f]);
    });
    if (!best || bad.length < best.length) best = bad;
  }
  return best ?? [...FIELDS];
}

export interface Report {
  n: number;
  top1: number;
  top3: number;
  byCat: Record<string, { n: number; top1: number; top3: number }>;
  byField: Record<string, number>; // how often each field is wrong in the first reading
  misses: { input: string; cat: string; wrong: string[]; got: Answer; want: Answer }[];
}

export function score(cases: Case[], now: Date): Report {
  const r: Report = { n: 0, top1: 0, top3: 0, byCat: {}, byField: {}, misses: [] };
  for (const c of cases) {
    const got = interpret(c.input, now);
    const wrong1 = wrongFields(c, got[0]);
    const ok1 = wrong1.length === 0;
    const ok3 = got.some((g) => wrongFields(c, g).length === 0);
    r.n++;
    if (ok1) r.top1++;
    if (ok3) r.top3++;
    const b = (r.byCat[c.cat] ??= { n: 0, top1: 0, top3: 0 });
    b.n++;
    if (ok1) b.top1++;
    if (ok3) b.top3++;
    for (const f of wrong1) r.byField[f] = (r.byField[f] ?? 0) + 1;
    if (!ok3) r.misses.push({ input: c.input, cat: c.cat, wrong: wrong1, got: got[0], want: c });
  }
  return r;
}

export function printReport(name: string, r: Report) {
  const pct = (a: number, n: number) => `${((100 * a) / Math.max(1, n)).toFixed(1)}%`;
  const lines = [
    `== ${name}: ${r.n} sentences · first reading right ${pct(r.top1, r.n)} · right among those shown ${pct(r.top3, r.n)}`,
    ...Object.entries(r.byCat).sort().map(([k, b]) => `   ${k.padEnd(20)} ${String(b.n).padStart(4)}  top-1 ${pct(b.top1, b.n).padStart(6)}  top-3 ${pct(b.top3, b.n).padStart(6)}`),
    `   wrong fields (first reading): ${Object.entries(r.byField).sort((a, b) => b[1] - a[1]).map(([f, n]) => `${f} ${n}`).join(' · ')}`,
  ];
  return lines.join('\n');
}
