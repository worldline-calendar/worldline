import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { writeLocal, readDoc, pick, type Synced } from '../lib/sync/model';

const base = (events: Record<string, unknown>[]): Synced =>
  pick({ events, calendars: [], tasks: [], habits: [], projects: [], threads: [], projectLog: [], links: [], habitLog: {}, habitNotes: {}, settings: {} } as never);

describe('sync model stress', () => {
  it('an unchanged record keeps its identity after a field is removed and re-added', () => {
    const doc = new Y.Doc();
    const s1 = base([{ id: 'e', title: 'a', notes: 'n', start: 1 }]);
    writeLocal(doc, null, s1);
    const e2 = { id: 'e', title: 'a', start: 1 }; // notes cleared
    const s2 = base([e2]);
    writeLocal(doc, s1, s2);
    const e3 = { ...e2, notes: 'm' }; // notes re-added (now last in key order)
    const s3 = base([e3]);
    writeLocal(doc, s2, s3);
    const out = readDoc(doc, s3);
    expect(out.events![0]).toBe(e3); // same content → same object (no redraw)
  });

  it('reading twice keeps identity', () => {
    const a = new Y.Doc(), b = new Y.Doc();
    writeLocal(a, null, base([{ id: 'e', title: 'x', start: 5 }]));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    const r = readDoc(b, {});
    expect(readDoc(b, r).events![0]).toBe(r.events![0]);
  });

  it('a malformed record from another device (not a map) does not crash reading', () => {
    const doc = new Y.Doc();
    writeLocal(doc, null, base([{ id: 'ok', title: 't' }]));
    (doc.getMap('events') as Y.Map<unknown>).set('bad', 'not a record');
    expect(() => readDoc(doc, {})).not.toThrow();
  });

  it('a record keyed __proto__ from another device is not passed into the app', () => {
    const doc = new Y.Doc();
    const m = new Y.Map();
    doc.getMap('events').set('__proto__', m);
    m.set('title', 'evil');
    const out = readDoc(doc, {});
    expect(out.events!.some((r) => r.id === '__proto__')).toBe(false);
  });
});
