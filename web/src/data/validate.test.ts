import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { cleanCalendar, cleanEvent, cleanHabit, cleanNested, cleanProject, cleanTask, isNum, webUrl } from './validate';
import { readDoc } from '../lib/sync/model';
import { parseIcs } from '../lib/ics';

describe('records from another device or a feed', () => {
  it('keeps a well-formed record as the same object', () => {
    const t = { id: 't', title: 'Referee report', createdAt: 1 };
    expect(cleanTask(t)).toBe(t);
    const e = { id: 'e', calendarId: 'c', title: 'Seminar', start: 1, end: 2, allDay: false, url: 'https://example.org/talk' };
    expect(cleanEvent(e)).toBe(e);
  });

  it('repairs or leaves out malformed ones instead of crashing the views', () => {
    expect(cleanTask({ title: 'no id' })).toBeNull();
    expect(cleanTask({ id: 't', title: 5, due: 'soon' })).toEqual({ id: 't', title: '', createdAt: 0 });
    expect(cleanProject({ id: 'p', title: 'A', color: '#f00', createdAt: 0, pins: 'x', ideas: [{ id: 'i', text: 'ok', at: 1 }, 3] }))
      .toEqual({ id: 'p', title: 'A', color: '#f00', createdAt: 0, ideas: [{ id: 'i', text: 'ok', at: 1 }] });
    expect(cleanHabit({ id: 'h', title: 'Gym', kind: 'weird', goal: -3 })).toMatchObject({ kind: 'check', goal: 1, period: 'day' });
    expect(cleanCalendar({ id: 'c', name: 'Work', visible: 'yes' })).toMatchObject({ visible: true, color: '#888888' });
  });

  it("an event can't end before it starts, keep a non-web link, or carry unknown repeat fields", () => {
    const e = cleanEvent({ id: 'e', calendarId: 'c', title: 'x', start: 10, end: 5, allDay: false, url: 'javascript:alert(1)', notes: 7, recurrence: { freq: 'daily', interval: 1, count: 1e9 } })!;
    expect(e.end).toBe(10);
    expect(e.url).toBeUndefined();
    expect(e.notes).toBeUndefined();
    expect(e.recurrence).toEqual({ freq: 'daily', interval: 1 });
  });

  it('only http(s) links count as web addresses', () => {
    expect(webUrl('https://a.org')).toBe('https://a.org');
    for (const u of ['javascript:alert(1)', 'data:text/html,x', 'JAVASCRIPT:x', ' file:///etc', 5]) expect(webUrl(u)).toBeUndefined();
  });

  it("a feed's javascript: link is dropped", () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:1', 'DTSTART:20261102T150000Z', 'DTEND:20261102T160000Z', 'SUMMARY:Talk', 'URL:javascript:alert(1)', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const evs = parseIcs(ics, 'c', Date.UTC(2026, 9, 1), Date.UTC(2026, 11, 1)).events;
    expect(evs.length).toBe(1);
    expect(evs[0].url).toBeUndefined();
  });

  it("habit history keys can't reach Object.prototype", () => {
    const m = JSON.parse('{"__proto__": {"1": 1}, "h": {"20000": 1, "x": 2, "20001": "bad"}}');
    const out = cleanNested(m, isNum);
    expect(out).toEqual({ h: { 20000: 1 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const doc = new Y.Doc();
    doc.getMap('habitLog').set('__proto__\u0001polluted', 1);
    doc.getMap('habitLog').set('nosep', 1);
    doc.getMap('habitLog').set('h\u000120000', 1);
    const read = readDoc(doc);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(read.habitLog).toEqual({ h: { 20000: 1 } });
  });
});
