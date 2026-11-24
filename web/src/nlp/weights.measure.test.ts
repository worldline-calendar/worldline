// How often each kind of other reading (lib/readings.ts) is what someone meant, when it's offered — the source of
// readings.ts WEIGHT. Run with NLP_WEIGHTS=1 TZ=America/Toronto after changing the readings, and copy the rates over.
import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accepted, answerOf, wrongFields, type Case } from './score';
import { readings } from '../lib/readings';
import { parseQuick } from '../lib/quickparse';
import { guessKind, hasTaskPrefix, stripTaskPrefix } from '../lib/tasks';
import { DEFAULT_CALENDARS } from '../data/mock';
const NOW = new Date(2026, 10, 23, 10);
it.runIf(!!process.env.NLP_WEIGHTS)('hit rate per kind of reading', () => {
  const shown: Record<string, number> = {}, hit: Record<string, number> = {};
  for (const f of ['dev', 'dev2', 'dev3', 'dev4', 'dev5', 'dev6']) {
    for (const c of (JSON.parse(readFileSync(resolve(__dirname, `corpus.${f}.json`), 'utf8')) as Case[]).filter((x) => x.alts?.length)) {
      const text = hasTaskPrefix(c.input) ? stripTaskPrefix(c.input) : c.input;
      const p = parseQuick(text, DEFAULT_CALENDARS, NOW);
      const kind = guessKind(c.input, p);
      for (const r of readings(text, DEFAULT_CALENDARS, NOW, 99, kind)) {
        const id = r.id.replace(/-\d+$/, '');
        shown[id] = (shown[id] ?? 0) + 1;
        const a = answerOf(c.input, r.parsed, r.kind ?? kind);
        if (accepted(c).some((x) => wrongFields({ ...x, input: c.input, cat: c.cat, alts: [] } as Case, a).length === 0)) hit[id] = (hit[id] ?? 0) + 1;
      }
    }
  }
  const rows = Object.keys(shown).map((k) => [k, shown[k], hit[k] ?? 0, ((hit[k] ?? 0) + 0.5) / (shown[k] + 2)] as const).sort((a, b) => b[3] - a[3]);
  for (const [k, n, h, w] of rows) console.log(`W ${k.padEnd(18)} shown ${String(n).padStart(4)} hit ${String(h).padStart(4)}  w ${w.toFixed(3)}`);
});
