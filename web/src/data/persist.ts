// Where the app keeps your data. In the Mac app: a SQLite database — one file, worldline.db, in the app's own folder
// (~/Library/Application Support/<app id>/), written atomically, with a snapshot of each day's data kept for two
// weeks as a safety net. In a browser (the iPhone / web version, and development): the browser's IndexedDB (no 5 MB
// cap like localStorage; anything saved in localStorage by an older version is moved over once).
//
// Safeguards:
//   · Saved data that can't be read (damaged, or the database won't open) is never written over: saving stops, the
//     app opens a recovery screen (components/Recovery.tsx) offering a snapshot or a backup, and the unreadable copy
//     is kept aside.
//   · A save that fails is kept and tried again (every few seconds, and on the next change); the app is told, once.
//   · Restoring (a snapshot or a backup file) first keeps what it replaces, so the restore can be undone.
import type { StateStorage } from 'zustand/middleware';
import { get as idbGet, set as idbSet, del as idbDel, keys as idbKeys } from 'idb-keyval';
import { isApp } from '../lib/platform';

// The browser's database (IndexedDB). Tests and very old browsers without it fall back to localStorage.
const hasIdb = typeof indexedDB !== 'undefined';
const browserGet = async (key: string): Promise<string | null> => {
  if (!hasIdb) return localStorage.getItem(key);
  const v = await idbGet<string>(key);
  if (v !== undefined) return v;
  const old = localStorage.getItem(key); // saved by an older version: move it over
  if (old !== null) {
    await idbSet(key, old);
    localStorage.removeItem(key);
  }
  return old;
};
const browserSet = (key: string, value: string) => (hasIdb ? idbSet(key, value) : Promise.resolve(localStorage.setItem(key, value)));
const browserDel = (key: string) => (hasIdb ? idbDel(key) : Promise.resolve(localStorage.removeItem(key)));

// The Mac app's database (src-tauri/src/db.rs): a few fixed native operations on worldline.db — the page can't run
// SQL of its own or open any other file.
const native = async <T,>(cmd: string, args?: Record<string, unknown>) => (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);

const BEFORE_RESTORE = '-before-restore'; // key suffix: what the last restore replaced
const UNREADABLE = '-unreadable'; // key suffix: saved data that couldn't be read, kept aside

/** Set when the app starts with nothing saved yet (a new install): it starts empty rather than with demo data. */
export let firstRun = false;

/** Why the saved data couldn't be loaded (null: it loaded fine). While set, nothing is saved. */
export let loadProblem: string | null = null;

/** Is this what the app saves (JSON with a `state` object)? */
export function readable(value: string): boolean {
  try {
    const v = JSON.parse(value) as { state?: unknown };
    return !!v && typeof v === 'object' && !!v.state && typeof v.state === 'object';
  } catch {
    return false;
  }
}

// ---- the two places data can live: the database (the app) or localStorage (a browser)
const today = () => new Date().toISOString().slice(0, 10);
const kv = {
  get: async (key: string): Promise<string | null> => (isApp() ? ((await native<string | null>('db_get', { key })) ?? null) : browserGet(key)),
  // (snapshot: the day's first save is also kept as that day's snapshot — `full` when given, else `value` — the newest
  // 14 days are kept)
  set: async (key: string, value: string, snapshot = false, full: string | null = null) =>
    isApp() ? native<void>('db_set', { key, value, snapshot: snapshot ? today() : null, full }) : browserSet(key, value),
  del: async (key: string) => (isApp() ? native<void>('db_del', { key }) : browserDel(key)),
  keys: async (prefix: string): Promise<string[]> => {
    if (isApp()) return native<string[]>('db_keys', { prefix });
    if (hasIdb) return (await idbKeys()).filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
    const out: string[] = [];
    for (let i = 0; i < (localStorage.length ?? 0); i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) out.push(k);
    }
    return out;
  },
};

// ---- the saved layout. The big collections (events, tasks, habit log, …) are each kept under their own key, so a
// save rewrites only the ones that changed — a habit tick no longer re-writes ten years of events. The app's key holds
// the "head": the small fields, plus which revision of each collection goes with them:
//   calendar-v1          {"state":{…small…},"version":2,"split":{"seq":41,"parts":{"events":40,"tasks":41,…}}}
//   calendar-v1:events.40  [ …the events… ]
// Each save writes the changed collections under new keys first and the head last, so a crash between the two leaves
// the old head pointing at the old (still there) collections: always a consistent whole. Superseded revisions are
// deleted after the head is written (and any left by a crash, at the next load). A head without `split` is the whole
// state in one value — what older versions, restores and backups write — and loads as it is.
const SEP = ':';
const partKey = (key: string, name: string, rev: number) => `${key}${SEP}${name}.${rev}`;
type Split = { seq: number; parts: Record<string, number> };
const splitOf = (head: string): Split | null => {
  try {
    const s = (JSON.parse(head) as { split?: Split }).split;
    return s && typeof s.seq === 'number' && s.parts && typeof s.parts === 'object' ? s : null;
  } catch {
    return null;
  }
};
/** The whole state as one value (`{"state":{…},"version":n}`), put together from the head's small fields and the
 *  collections' text — no re-serialising. */
const assemble = (small: string, version: number, parts: Record<string, string>) => {
  const names = Object.keys(parts);
  const body = small.slice(1, -1); // (small is a JSON object's text)
  const rest = names.map((n) => `${JSON.stringify(n)}:${parts[n]}`).join(',');
  return `{"state":{${body}${body && rest ? ',' : ''}${rest}},"version":${version}}`;
};
/** What's saved under `key`, whole (the head and its collections put together). Throws if a collection is missing. */
async function loadWhole(key: string): Promise<{ value: string | null; parts?: Record<string, { rev: number; str: string }>; seq?: number }> {
  const head = await kv.get(key);
  const split = head === null ? null : splitOf(head);
  if (head === null || !split) return { value: head };
  const parts: Record<string, { rev: number; str: string }> = {};
  for (const [n, rev] of Object.entries(split.parts)) {
    const str = await kv.get(partKey(key, n, rev));
    if (str === null) throw new Error(`part of the saved data (${n}) is missing`);
    parts[n] = { rev, str };
  }
  const h = JSON.parse(head) as { state: unknown; version?: number };
  const strs = Object.fromEntries(Object.entries(parts).map(([n, p]) => [n, p.str]));
  return { value: assemble(JSON.stringify(h.state), h.version ?? 0, strs), parts, seq: split.seq };
}
/** What was last written under the app's key (to write only what changed since). */
let written: { seq: number; parts: Record<string, { rev: number; str: string }> } = { seq: 0, parts: {} };
/** The day a full snapshot was last handed over this session (the database keeps only the day's first anyway). */
let snapDay = '';

// ---- saving: batched (typing fires many changes), retried if it fails, one write at a time (in order) so a slow or
// failed older write can never land after a newer one
type Pending = { key: string; value: string } | { key: string; small: string; version: number; parts: Record<string, string> };
let pending: Pending | null = null;
let timer = 0;
let failing = false;
let chain: Promise<void> = Promise.resolve();
let busy = 0;
const troubleListeners = new Set<(ok: boolean) => void>();
/** Hear when saving starts failing (false) and when it works again (true). */
export const onSaveTrouble = (fn: (ok: boolean) => void) => (troubleListeners.add(fn), () => void troubleListeners.delete(fn));

async function writeOnce() {
  const p = pending;
  pending = null;
  if (!p || loadProblem || readOnly) return;
  try {
    if ('value' in p) {
      await kv.set(p.key, p.value, true);
      written = { seq: written.seq, parts: {} }; // (the whole state in one value: the next split save writes everything)
    } else await writeSplit(p);
    if (failing) {
      failing = false;
      troubleListeners.forEach((fn) => fn(true));
    }
  } catch (e) {
    console.error('Saving failed; will try again', e);
    pending ??= p; // keep it (unless something newer is already waiting — that replaces it)
    if (!failing) {
      failing = true;
      troubleListeners.forEach((fn) => fn(false));
    }
    clearTimeout(timer);
    timer = window.setTimeout(() => void write(), 5000);
  }
}
/** One split save: the changed collections under new keys, then the head; then the superseded revisions go. */
async function writeSplit(p: Extract<Pending, { small: string }>) {
  const seq = written.seq + 1; // (a retry after a failure reuses it: the same keys are written again)
  const revs: Record<string, number> = {};
  for (const [n, str] of Object.entries(p.parts)) {
    const w = written.parts[n];
    if (w && w.str === str) revs[n] = w.rev;
    else {
      await kv.set(partKey(p.key, n, seq), str);
      revs[n] = seq;
    }
  }
  const head = `{"state":${p.small},"version":${p.version},"split":${JSON.stringify({ seq, parts: revs })}}`;
  // the day's first save is that day's snapshot: the whole state, put together from the text already made
  const snap = isApp() && snapDay !== today();
  await kv.set(p.key, head, true, snap ? assemble(p.small, p.version, p.parts) : null);
  if (snap) snapDay = today();
  const old = written.parts;
  written = { seq, parts: Object.fromEntries(Object.entries(p.parts).map(([n, str]) => [n, { rev: revs[n], str }])) };
  for (const [n, w] of Object.entries(old)) if (revs[n] !== w.rev) await kv.del(partKey(p.key, n, w.rev)).catch(() => undefined);
  // (once a session, by the tab that saves: a second tab loading meanwhile never deletes the first one's new keys)
  if (!tidied) {
    tidied = true;
    await tidyParts(p.key);
  }
}
let tidied = false;
/** Delete collection revisions the head doesn't point at (left by a crash mid-save, or by a restore). */
async function tidyParts(key: string) {
  const keep = new Set(Object.entries(written.parts).map(([n, w]) => partKey(key, n, w.rev)));
  const all = await kv.keys(key + SEP).catch(() => [] as string[]);
  for (const k of all) if (!keep.has(k)) await kv.del(k).catch(() => undefined);
}
/** Save the app's state split up (data/store.ts): `small` is the JSON of the small fields, `parts` each big
 *  collection's JSON (the same string object again when the collection hasn't changed — then it isn't rewritten). */
export function saveSplit(key: string, small: string, version: number, parts: Record<string, string>) {
  if (loadProblem || readOnly) return;
  pending = { key, small, version, parts };
  clearTimeout(timer);
  timer = window.setTimeout(() => void write(), isApp() ? 300 : 0);
}
function write(): Promise<void> {
  clearTimeout(timer);
  busy++;
  chain = chain.then(writeOnce).finally(() => void busy--);
  return chain;
}
/** Write anything not yet saved (called when the window hides or closes, before quitting and before a restart). */
export const flush = () => {
  flushHooks.forEach((fn) => fn()); // (the store's own debounce hands over what it's holding first)
  return write();
};
const flushHooks = new Set<() => void>();
/** Run before every flush — data/store.ts hands over a save it's still holding. */
export const onFlush = (fn: () => void) => void flushHooks.add(fn);
/** Is everything the app holds saved (nothing waiting, nothing being written, the last write worked)? */
export const allSaved = () => !pending && !busy && !failing && !loadProblem && !readOnly;

const storage: StateStorage = {
  getItem: async (key) => {
    let value: string | null;
    let loaded: Awaited<ReturnType<typeof loadWhole>>;
    try {
      value = await kv.get(key);
      loaded = value !== null && readable(value) ? await loadWhole(key) : { value };
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 160);
      loadProblem = /missing/.test(why) ? `Your saved data couldn’t be read (${why}).` : `The database couldn’t be opened (${why}).`;
      return null;
    }
    if (loaded.parts) {
      written = { seq: loaded.seq!, parts: loaded.parts };
      value = loaded.value;
    } else written = { seq: written.seq, parts: {} };
    if (value === null) {
      firstRun = true;
      return null;
    }
    if (!readable(value)) {
      loadProblem = 'Your saved data couldn’t be read — it may have been damaged.';
      await kv.set(key + UNREADABLE, value).catch(() => undefined); // keep it aside, untouched
      return null;
    }
    return value;
  },
  setItem: (key, value) => {
    if (loadProblem || readOnly) return; // never write over data we couldn't read (or another tab's)
    pending = { key, value };
    clearTimeout(timer);
    timer = window.setTimeout(() => void write(), isApp() ? 300 : 0);
  },
  removeItem: (key) => kv.del(key),
};

/** Other things kept beside the app's state, never in it (so never in a backup): the sync key, the sync document. */
export const sideStore = { get: kv.get, set: async (key: string, value: string) => void (readOnly || (await kv.set(key, value))), del: kv.del };

/** The storage the app's state is saved to. */
export const appStorage = (): StateStorage => storage;

/** Another tab or window of this web app holds the data (see main.tsx): this one never saves, so neither writes
 *  over the other's changes. */
let readOnly = false;
export const makeReadOnly = () => {
  readOnly = true;
  pending = null;
  clearTimeout(timer);
};

/** The hydration itself failed (e.g. a migration threw): treat it like unreadable data. */
const problemListeners = new Set<() => void>();
export function markLoadProblem(reason: string) {
  loadProblem ??= reason;
  problemListeners.forEach((fn) => fn());
}
/** Hear when loading fails outright (the app then shows the recovery screen instead of waiting forever). */
export const onLoadProblem = (fn: () => void) => void problemListeners.add(fn);

// ---- snapshots and restoring

/** Told when the app's data is replaced wholesale — a restore, starting over, erase everything (store.ts startFresh) —
 *  before it happens. Sync listens (data/syncEngine.ts): it must never send the replacement out as everyone's edits. */
const replacedListeners = new Set<(reloading: boolean) => Promise<void> | void>();
export const onDataReplaced = (fn: (reloading: boolean) => Promise<void> | void) => (replacedListeners.add(fn), () => void replacedListeners.delete(fn));
/** The app's data is about to be replaced (`reloading`: and the app reloads next). Each listener's first, synchronous
 *  step runs before this returns. */
export const dataReplaced = (reloading = false) => Promise.all([...replacedListeners].map((fn) => fn(reloading))).then(() => undefined);

/** The daily snapshots kept in the database (newest first). The Mac app only. */
export const listSnapshots = async (): Promise<string[]> => (isApp() ? native<string[]>('db_snapshots') : []);

/** A snapshot's saved state, as stored. */
export const snapshotValue = async (day: string): Promise<string | null> => (await native<string | null>('db_snapshot', { day })) ?? null;

/** Replace everything with what was saved (a snapshot, a backup's state, or an undo), keeping what it replaces so the
 *  restore can be undone. The caller reloads the app afterwards. */
export async function replaceSaved(key: string, value: string) {
  if (!readable(value)) throw new Error('That isn’t data Worldline can load.');
  await dataReplaced(true);
  pending = null;
  clearTimeout(timer);
  await chain.catch(() => undefined); // (a save already under way finishes first)
  const current = (await loadWhole(key).catch(() => null))?.value ?? null; // (the whole state, put together)
  if (current && readable(current)) await kv.set(key + BEFORE_RESTORE, current);
  await kv.set(key, value); // (one value, no `split`: the old collections are tidied away by the next save)
  written = { seq: written.seq, parts: {} };
  loadProblem = null;
}

/** What the last restore replaced (to undo it), if anything. */
export const beforeRestore = (key: string) => kv.get(key + BEFORE_RESTORE).then((v) => (v && readable(v) ? v : null)).catch(() => null);

/** Start over from the recovery screen: an empty calendar; the unreadable data stays kept aside. */
export async function startOverKeepingUnreadable(key: string) {
  // (data that read fine but couldn't be loaded — from a newer version, or a failed migration — is kept aside too)
  await dataReplaced(true);
  const cur = (await loadWhole(key).catch(() => null))?.value ?? (await kv.get(key).catch(() => null));
  if (cur !== null) await kv.set(`${key}${UNREADABLE}-${new Date().toISOString()}`, cur); // never over an earlier copy kept aside
  await kv.del(key).catch(() => undefined);
  await tidyKeptAside(key);
  loadProblem = null;
}

/** Copies kept aside by starting over pile up only if it happens again and again: the newest 3 are kept. */
const KEEP_ASIDE = 3;
async function tidyKeptAside(key: string) {
  if (!isApp()) return; // (the browser keeps them in IndexedDB: rare, and small next to the app's data)
  const keys = await native<string[]>('db_keys', { prefix: `${key}${UNREADABLE}-` }).catch(() => [] as string[]);
  for (const k of keys.sort().slice(0, -KEEP_ASIDE)) await kv.del(k).catch(() => undefined);
}

if (isApp()) {
  // don't lose the last few keystrokes when the window goes away
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flush());
  window.addEventListener('blur', () => void flush());
}
