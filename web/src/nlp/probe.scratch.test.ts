import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { accepted, interpret, wrongFields, type Case } from './score';
const NOW = new Date(2026, 10, 23, 10);
it('missing alternative readings', () => {
  const by: Record<string, string[]> = {};
  for (const f of ['dev', 'dev2', 'dev3', 'dev4', 'dev5']) {
    const cases = JSON.parse(readFileSync(resolve(__dirname, `corpus.${f}.json`), 'utf8')) as Case[];
    for (const c of cases) {
      if (!c.alts?.length) continue;
      const got = interpret(c.input, NOW);
      for (const a of accepted(c)) {
        if (got.some((g) => wrongFields({ ...a, input: c.input, cat: c.cat, alts: [] } as Case, g).length === 0)) continue;
        // which fields differ from the first reading shown
        const k = wrongFields({ ...a, input: c.input, cat: c.cat, alts: [] } as Case, got[0]).sort().join('+') || 'same?';
        (by[k] ??= []).push(`${c.input}  →  ${JSON.stringify(Object.fromEntries(Object.entries(a).filter(([x]) => ['kind', 'title', 'start', 'end', 'repeat', 'loc'].includes(x))))}`);
      }
    }
  }
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n${v.length}  ${k}`);
    for (const x of v.slice(0, 6)) console.log('   ' + x.slice(0, 190));
  }
});
