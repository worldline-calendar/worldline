// The split saved layout (persist.ts): the big collections under their own keys, the head written last. Run against a
// stand-in for the Mac app's database (src-tauri/src/db.rs: kv, daily snapshots of the whole state).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const kv = new Map<string, string>();
const snaps = new Map<string, string>();
let failKey: ((k: string) => boolean) | null = null;
const sets: string[] = [];
vi.mock('../lib/platform', () => ({ isApp: () => true }));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, a: Record<string, string | null>) => {
    if (cmd === 'db_get') return kv.get(a.key!) ?? null;
    if (cmd === 'db_set') {
      if (failKey?.(a.key!)) throw new Error('disk full');
      sets.push(a.key!);
      kv.set(a.key!, a.value!);
      if (a.snapshot && !snaps.has(a.snapshot)) snaps.set(a.snapshot, a.full ?? a.value!);
      return;
    }
    if (cmd === 'db_del') return void kv.delete(a.key!);
    if (cmd === 'db_keys') return [...kv.keys()].filter((k) => k.startsWith(a.prefix!));
    if (cmd === 'db_snapshots') return [...snaps.keys()].sort().reverse();
    if (cmd === 'db_snapshot') return snaps.get(a.day!) ?? null;
    throw new Error(cmd);
  },
}));
Object.assign(globalThis, { window: { setTimeout, clearTimeout, addEventListener() {} }, document: { addEventListener() {} } });

const KEY = 'calendar-v1';
type S = { myName: string; events: unknown[]; tasks: unknown[]; habitLog: Record<string, unknown> };
const load = async () => {
  vi.resetModules();
  const p = await import('./persist');
  const v = await p.appStorage().getItem(KEY);
  return { p, state: v === null ? null : (JSON.parse(v as string) as { state: S; version: number }) };
};
/** What the store hands over (store.ts handOver): the small fields' JSON and each collection's JSON. */
const save = async (p: typeof import('./persist'), s: S, prev?: Record<string, string>) => {
  const parts: Record<string, string> = {};
  for (const k of ['events', 'tasks', 'habitLog'] as const) {
    const str = JSON.stringify(s[k]);
    parts[k] = prev && prev[k] === str ? prev[k] : str;
  }
  p.saveSplit(KEY, JSON.stringify({ myName: s.myName }), 2, parts);
  await p.flush();
  return parts;
};
const A: S = { myName: 'A', events: [{ id: 'e1' }], tasks: [{ id: 't1' }], habitLog: { h: { 1: 1 } } };

beforeEach(() => {
  kv.clear();
  snaps.clear();
  sets.length = 0;
  failKey = null;
});

describe('the split layout', () => {
  it('round trip: what was saved loads whole; an unchanged collection isn’t written again', async () => {
    let { p } = await load();
    const parts = await save(p, A);
    expect(JSON.parse(kv.get(KEY)!).state).toEqual({ myName: 'A' }); // the head holds only the small fields
    expect([...kv.keys()].filter((k) => k.startsWith(KEY + ':')).length).toBe(3);
    sets.length = 0;
    await save(p, { ...A, habitLog: { h: { 1: 2 } } }, parts); // a habit tick
    expect(sets).toEqual([`${KEY}:habitLog.2`, KEY]); // events and tasks untouched
    expect(kv.has(`${KEY}:habitLog.1`)).toBe(false); // the old revision is gone
    ({ p } = await load());
    const { state } = await load();
    expect(state).toEqual({ state: { myName: 'A', events: A.events, tasks: A.tasks, habitLog: { h: { 1: 2 } } }, version: 2 });
    expect(p.loadProblem).toBeNull();
  });

  it('migration: an old single-key save loads, and stays until the new layout is written', async () => {
    const old = JSON.stringify({ state: A, version: 2 });
    kv.set(KEY, old);
    let { p, state } = await load();
    expect(state).toEqual({ state: A, version: 2 });
    failKey = (k) => k === KEY; // the head can't be written: the old value must survive
    p.saveSplit(KEY, JSON.stringify({ myName: 'B' }), 2, { events: '[]', tasks: '[]', habitLog: '{}' });
    await p.flush();
    expect(kv.get(KEY)).toBe(old);
    failKey = null;
    await p.flush();
    ({ state } = await load());
    expect(state!.state).toEqual({ myName: 'B', events: [], tasks: [], habitLog: {} });
  });

  it('a crash between the collections and the head: the old head still loads consistent data', async () => {
    let { p } = await load();
    const parts = await save(p, A);
    failKey = (k) => k === KEY; // (the collections are written, then the app dies before the head)
    p.saveSplit(KEY, JSON.stringify({ myName: 'B' }), 2, { ...parts, events: '[{"id":"e2"}]', tasks: '[{"id":"t2"}]' });
    await p.flush();
    expect(kv.has(`${KEY}:events.2`)).toBe(true);
    failKey = null;
    let state;
    ({ p, state } = await load());
    expect(state!.state).toEqual(A); // all of the old save, none of the half-written one
    await save(p, { ...A, myName: 'C' }); // the next save tidies the leftovers away
    expect([...kv.keys()].filter((k) => k.startsWith(KEY + ':')).sort()).toEqual([`${KEY}:events.1`, `${KEY}:habitLog.1`, `${KEY}:tasks.1`]); // (unchanged since the load: not rewritten)
    ({ state } = await load());
    expect(state!.state).toEqual({ ...A, myName: 'C' });
  });

  it('a missing collection is a load problem, never an empty calendar that gets saved over it', async () => {
    const { p } = await load();
    await save(p, A);
    kv.delete(`${KEY}:events.1`);
    const again = await load();
    expect(again.state).toBeNull();
    expect(again.p.loadProblem).toMatch(/events/);
  });

  it('the day’s snapshot is the whole state, and restoring it (or a backup) brings everything back', async () => {
    let { p } = await load();
    await save(p, A);
    const [day] = await p.listSnapshots();
    const snap = (await p.snapshotValue(day))!;
    expect(JSON.parse(snap)).toEqual({ state: A, version: 2 });
    await save(p, { ...A, myName: 'Later', events: [] });
    expect(await p.snapshotValue(day)).toBe(snap); // (only the day's first save)

    ({ p } = await load());
    await p.replaceSaved(KEY, snap);
    expect(JSON.parse((await p.beforeRestore(KEY))!)).toEqual({ state: { ...A, myName: 'Later', events: [] }, version: 2 }); // undo keeps the whole state
    let state;
    ({ p, state } = await load());
    expect(state).toEqual({ state: A, version: 2 });
    const backup = JSON.stringify({ state: { ...A, myName: 'Backup' }, version: 2 });
    await p.replaceSaved(KEY, backup);
    ({ state } = await load());
    expect(state!.state.myName).toBe('Backup');
    expect(state!.state.events).toEqual(A.events);
  });
});
