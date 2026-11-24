// Runs the on-device reader over a test set and saves what it read (test-heldout/model-cache/<set>.json, gitignored),
// for src/nlp/extract.eval.test.ts to score. Usage: node scripts/model-eval.mjs <set> [binary]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const set = process.argv[2];
const review = process.argv[3] === 'review';
const bin = 'src-tauri/target/worldline-reader';
const path = { xdev: 'src/nlp/extract.dev.json', xdev2: 'src/nlp/extract.dev2.json', xheldout: 'test-heldout/extract.heldout.json', xheldout2: 'test-heldout/extract.heldout2.json' }[set];
const docs = JSON.parse(readFileSync(path, 'utf8'));
mkdirSync('test-heldout/model-cache', { recursive: true });
const out = `test-heldout/model-cache/${set}${review ? '.review' : ''}.json`;
const cands = review ? JSON.parse(readFileSync(`test-heldout/model-cache/${set}.cands.json`, 'utf8')) : null;
const cache = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
const t0 = Date.now();
for (const d of docs) {
  if (cache[d.id]) continue;
  if (review && !cands[d.id]?.length) { cache[d.id] = []; continue; }
  const res = execFileSync(bin, { input: JSON.stringify({ text: d.text, today: 'Monday, November 23, 2026', ...(review ? { candidates: cands[d.id] } : {}) }), timeout: 120000 }).toString();
  const r = JSON.parse(res);
  if (!r.available) { console.error('model unavailable:', r.reason); process.exit(1); }
  cache[d.id] = review ? r.keep : r.items;
  writeFileSync(out, JSON.stringify(cache, null, 1));
  process.stdout.write('.');
}
console.log(`\n${set}: ${docs.length} documents in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
