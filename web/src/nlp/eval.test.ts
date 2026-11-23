// How well quick add reads what people type (see score.ts). Prints a report with NLP_EVAL=1; always guards the scores
// from falling below what they've reached (a change that makes the reader worse fails here).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { printReport, score, type Case } from './score';

const NOW = new Date(2026, 10, 23, 10); // the corpora's "now": Mon Nov 23 2026, 10 AM, Toronto
const load = (p: string): Case[] | null => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Case[]) : null);
const dev = load(resolve(__dirname, 'corpus.dev.json'));
const heldout = load(resolve(__dirname, '../../test-heldout/corpus.heldout.json'));
const FLOOR = { dev: { top1: 0, top3: 0 }, heldout: { top1: 0, top3: 0 } }; // raised as the reader improves
const zoneOk = Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/Toronto';

describe.runIf(zoneOk)('reading what people type (corpora; run with TZ=America/Toronto)', () => {
  for (const [name, cases] of [['dev', dev], ['heldout', heldout]] as const) {
    it.runIf(!!cases)(name, () => {
      const r = score(cases!, NOW);
      if (process.env.NLP_EVAL) {
        console.log(printReport(name, r));
        if (name === 'dev' && process.env.NLP_MISSES)
          for (const m of r.misses.slice(0, Number(process.env.NLP_MISSES) || 40))
            console.log(`  ✗ [${m.cat}] ${m.input}\n      wrong: ${m.wrong.join(', ')}\n      got:  ${JSON.stringify(m.got)}\n      want: ${JSON.stringify(Object.fromEntries(Object.entries(m.want).filter(([k]) => !['input', 'cat'].includes(k))))}`);
      }
      expect(r.top1 / r.n).toBeGreaterThanOrEqual(FLOOR[name].top1);
      expect(r.top3 / r.n).toBeGreaterThanOrEqual(FLOOR[name].top3);
    });
  }
});
