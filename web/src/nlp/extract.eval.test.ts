// How well "drop anything" finds what's in a document (lib/extract.ts). Each document has the items a person would
// add; a proposal matches one when its day and time agree and its title shares a word with it (or it's the only one
// on that day). found = matched / expected · real = matched / proposed. Prints with NLP_EVAL=1; floors guard regressions.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { format } from 'date-fns';
import { extract, type Extraction, type Proposal } from '../lib/extract';
import { combine, describeForReview, type ModelItem } from '../lib/modelRead';
import { writeFileSync, mkdirSync } from 'node:fs';
import { wallClock } from '../lib/zone';
import { DEFAULT_CALENDARS } from '../data/mock';

interface Item { kind: string; title: string; start: string | null; end: string | null; zone?: string | null; loc?: string | null }
interface Doc { id: string; type: string; text: string; items: Item[] }
const NOW = new Date(2026, 10, 23, 10);
const load = (p: string): Doc[] | null => (existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Doc[]) : null);
const sets = { xdev: load(resolve(__dirname, 'extract.dev.json')), xdev2: load(resolve(__dirname, 'extract.dev2.json')), xheldout: load(resolve(__dirname, '../../test-heldout/extract.heldout.json')), xheldout2: load(resolve(__dirname, '../../test-heldout/extract.heldout2.json')) };
const FLOOR: Record<string, { found: number; real: number }> = { xdev: { found: 0.75, real: 0.71 }, xdev2: { found: 0.70, real: 0.78 }, xheldout: { found: 0.69, real: 0.57 }, xheldout2: { found: 0.65, real: 0.54 } };

const pad = (n: number) => String(n).padStart(2, '0');
function startOf(p: Proposal) {
  if (p.kind === 'task') return format(p.parsed.start, 'yyyy-MM-dd');
  if (p.parsed.allDay) return format(p.parsed.start, 'yyyy-MM-dd');
  const w = wallClock(p.parsed.start, p.parsed.timeZone);
  return `${w.y}-${pad(w.m + 1)}-${pad(w.d)} ${pad(w.h)}:${pad(w.min)}`;
}
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['the', 'and', 'for', 'with'].includes(w)));
const overlap = (a: string, b: string) => { const A = words(a), B = words(b); return [...A].some((w) => B.has(w)); };
const sameStart = (want: Item, got: Proposal) => {
  const g = startOf(got);
  if (!want.start) return got.kind === 'task';
  return want.kind === 'task' || want.start.length === 10 || got.kind === 'task' ? g.slice(0, 10) === want.start.slice(0, 10) : g === want.start;
};

export function scoreDocs(docs: Doc[], read: (d: Doc) => Extraction | null = (d) => extract(d.text, DEFAULT_CALENDARS, NOW)) {
  let expected = 0, proposed = 0, matched = 0, kindOk = 0, titleWord = 0, ticked = 0, tickedOk = 0;
  const misses: string[] = [], extras: string[] = [];
  for (const d of docs) {
    const got = read(d)?.proposals;
    if (!got) continue;
    const used = new Set<number>();
    expected += d.items.length;
    proposed += got.length;
    for (const want of d.items) {
      const cands = got.map((g, i) => [g, i] as const).filter(([g, i]) => !used.has(i) && sameStart(want, g));
      const pick = cands.find(([g]) => overlap(g.parsed.title, want.title)) ?? (cands.length === 1 ? cands[0] : undefined);
      if (!pick) { misses.push(`${d.id}: ${want.kind} "${want.title}" ${want.start}`); continue; }
      used.add(pick[1]);
      matched++;
      if (pick[0].confidence >= 0.6) tickedOk++;
      if (pick[0].kind === want.kind) kindOk++;
      if (overlap(pick[0].parsed.title, want.title)) titleWord++;
    }
    ticked += got.filter((g) => g.confidence >= 0.6).length;
    got.forEach((g, i) => { if (!used.has(i)) extras.push(`${d.id}: ${g.confidence >= 0.6 ? '☑' : '☐'} ${g.kind} "${g.parsed.title}" ${startOf(g)}`); });
  }
  return { docs: docs.length, expected, proposed, matched, found: matched / Math.max(1, expected), real: matched / Math.max(1, proposed), kindOk: kindOk / Math.max(1, matched), titleWord: titleWord / Math.max(1, matched), ticked: tickedOk / Math.max(1, ticked), tickedFound: tickedOk / Math.max(1, expected), misses, extras };
}

const zoneOk = Intl.DateTimeFormat().resolvedOptions().timeZone === 'America/Toronto';
describe.runIf(zoneOk)('finding what is in a dropped document (run with TZ=America/Toronto)', () => {
  for (const [name, docs] of Object.entries(sets)) {
    it.runIf(!!docs)(name, () => {
      const r = scoreDocs(docs!);
      const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
      if (process.env.NLP_EVAL) {
        console.log(`== ${name}: ${r.docs} documents · ${r.expected} items · found ${pct(r.found)} · real ${pct(r.real)} (${r.proposed} proposed) · kind right ${pct(r.kindOk)} · title shares a word ${pct(r.titleWord)} · ticked: found ${pct(r.tickedFound)}, real ${pct(r.ticked)}`);
        if (process.env.NLP_MISSES && name === (process.env.NLP_SET ?? 'xdev')) {
          for (const m of r.misses) console.log('  ✗ missed ' + m);
          for (const x of r.extras) console.log('  + extra  ' + x);
        }
      }
      // the on-device model's reading of the same documents, when scripts/model-eval.mjs has run (Mac, macOS 26)
      const cachePath = resolve(__dirname, `../../test-heldout/model-cache/${name}.json`);
      if (process.env.NLP_GEN_CANDS) {
        // the rules' proposals, for scripts/model-eval.mjs <set> review
        mkdirSync(resolve(__dirname, '../../test-heldout/model-cache'), { recursive: true });
        writeFileSync(cachePath.replace('.json', '.cands.json'), JSON.stringify(Object.fromEntries(docs!.map((d) => [d.id, extract(d.text, DEFAULT_CALENDARS, NOW).proposals.map((p) => describeForReview(p, d.text))]))));
      }
      if (process.env.NLP_EVAL && existsSync(cachePath)) {
        const cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, ModelItem[]>;
        const judgePath = cachePath.replace('.json', '.review.json');
        const judge = existsSync(judgePath) ? (JSON.parse(readFileSync(judgePath, 'utf8')) as Record<string, boolean[]>) : {};
        const m = scoreDocs(docs!.filter((d) => cache[d.id]), (d) => combine(cache[d.id], d.text, DEFAULT_CALENDARS, NOW, judge[d.id]));
        console.log(`== ${name} (model): ${m.docs} documents · found ${pct(m.found)} · real ${pct(m.real)} (${m.proposed} proposed) · kind right ${pct(m.kindOk)} · title shares a word ${pct(m.titleWord)} · ticked: found ${pct(m.tickedFound)}, real ${pct(m.ticked)}`);
        if (process.env.NLP_MISSES && name === (process.env.NLP_SET ?? 'xdev')) {
          for (const x of m.misses) console.log('  ✗ model missed ' + x);
          for (const x of m.extras) console.log('  + model extra  ' + x);
        }
      }
      expect(r.found).toBeGreaterThanOrEqual(FLOOR[name].found);
      expect(r.real).toBeGreaterThanOrEqual(FLOOR[name].real);
    });
  }
});
