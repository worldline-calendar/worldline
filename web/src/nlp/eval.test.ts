// How well quick add reads what people type (see score.ts). Prints a report with NLP_EVAL=1; always guards the scores
// from falling below what they've reached (a change that makes the reader worse fails here).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { printReport, score, type Case } from './score';

const NOW = new Date(2026, 10, 23, 10); // the corpora's "now": Mon Nov 23 2026, 10 AM, Toronto
// (sentences with two things — "items": […] — are scored by the document reader's test, not here)
// (and "2026-11-23T14:00" written the usual way, "2026-11-23 14:00")
const tidy = (x: unknown): unknown => (typeof x === 'string' ? x.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/, '$1 $2') : Array.isArray(x) ? x.map(tidy) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, tidy(v)])) : x);
// (some writers mark a deadline as an event with no end: the same thing)
// (and a one-day all-day event may be written with no end: it ends that day)
const oneDay = (c: Case): Case => (c.kind === 'event' && c.end == null && c.start?.length === 10 ? { ...c, end: c.start } : c);
const asDeadline = (c0: Case): Case => { const c = oneDay(c0); return c.kind === 'event' && c.end == null && c.start && c.start.length > 10 ? { ...c, kind: 'deadline', alts: c.alts?.map((a) => (a.kind === 'event' && a.end === null ? { ...a, kind: 'deadline' as const } : a)) } : c; };
const load = (p: string): Case[] | null => (existsSync(p) ? (tidy(JSON.parse(readFileSync(p, 'utf8'))) as (Case & { items?: unknown })[]).filter((c) => !c.items).map(asDeadline) : null);
const dev = load(resolve(__dirname, 'corpus.dev.json'));
const dev2 = load(resolve(__dirname, 'corpus.dev2.json'));
const heldout = load(resolve(__dirname, '../../test-heldout/corpus.heldout.json'));
const heldout2 = load(resolve(__dirname, '../../test-heldout/corpus.heldout2.json'));
const heldout3 = load(resolve(__dirname, '../../test-heldout/corpus.heldout3.json'));
const dev5 = load(resolve(__dirname, 'corpus.dev5.json'));
const dev6 = load(resolve(__dirname, 'corpus.dev6.json'));
const heldout4 = load(resolve(__dirname, '../../test-heldout/corpus.heldout4.json'));
const dev7 = load(resolve(__dirname, 'corpus.dev7.json'));
const heldout5 = load(resolve(__dirname, '../../test-heldout/corpus.heldout5.json'));
const dev3 = load(resolve(__dirname, 'corpus.dev3.json'));
const dev4 = load(resolve(__dirname, 'corpus.dev4.json'));
const FLOOR = { dev: { top1: 0.94, top3: 0.96 }, dev2: { top1: 0.93, top3: 0.95 }, dev3: { top1: 0.85, top3: 0.88 }, dev4: { top1: 0.78, top3: 0.81 }, dev5: { top1: 0.84, top3: 0.88 }, dev6: { top1: 0.70, top3: 0.83 }, heldout: { top1: 0.89, top3: 0.91 }, heldout2: { top1: 0.81, top3: 0.84 }, heldout3: { top1: 0.85, top3: 0.86 }, heldout4: { top1: 0.81, top3: 0.86 }, dev7: { top1: 0, top3: 0 }, heldout5: { top1: 0, top3: 0 } }; // raised as the reader improves
const zoneOk = Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/Toronto';

describe.runIf(zoneOk)('reading what people type (corpora; run with TZ=America/Toronto)', () => {
  for (const [name, cases] of [['dev', dev], ['dev2', dev2], ['dev3', dev3], ['dev4', dev4], ['dev5', dev5], ['dev6', dev6], ['dev7', dev7], ['heldout', heldout], ['heldout2', heldout2], ['heldout3', heldout3], ['heldout4', heldout4], ['heldout5', heldout5]] as const) {
    it.runIf(!!cases)(name, () => {
      const r = score(cases!, NOW);
      if (process.env.NLP_EVAL) {
        console.log(printReport(name, r));
        if (name === (process.env.NLP_SET ?? 'dev') && process.env.NLP_MISSES)
          for (const m of r.misses.slice(0, Number(process.env.NLP_MISSES) || 40))
            console.log(`  ✗ [${m.cat}] ${m.input}\n      wrong: ${m.wrong.join(', ')}\n      got:  ${JSON.stringify(m.got)}\n      want: ${JSON.stringify(Object.fromEntries(Object.entries(m.want).filter(([k]) => !['input', 'cat'].includes(k))))}`);
      }
      expect(r.top1 / r.n).toBeGreaterThanOrEqual(FLOOR[name].top1);
      expect(r.top3 / r.n).toBeGreaterThanOrEqual(FLOOR[name].top3);
    });
  }
});
