// Drop anything: paste or drop an email, a text thread, an invitation letter (PDF), a newsletter or a calendar file, and
// see the events, deadlines and to-dos in it (lib/extract.ts) — each with the words it came from, ticked to add or not.
// Nothing is added until "Add"; one ⌘Z takes the whole batch back. Everything is read on this device.
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { format, startOfDay } from 'date-fns';
import { useStore, newEventCalendarId, readOnly } from '../data/store';
import { extract, type Extraction, type ExtractKind, type Proposal } from '../lib/extract';
import { combine, type ModelItem } from '../lib/modelRead';
import { readDocument } from '../lib/readDocument';
import { readings } from '../lib/readings';
import { fmtTime } from '../lib/format';
import { describeRecurrence } from '../lib/recurrence';
import { defaultLeadDays } from '../lib/deadlines';
import { zoneCity } from '../lib/zone';
import { cls } from '../lib/format';
import { Portal } from './Portal';

const hostLabel = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return 'link'; } };
interface Row extends Proposal { on: boolean; key: string; alts: { label: string; p: Proposal['parsed']; kind?: ExtractKind }[] }
const KIND_LABEL: Record<ExtractKind, string> = { event: 'Event', deadline: 'Deadline', task: 'To-do' };

function when(r: Row) {
  const p = r.parsed;
  if (r.kind === 'task') return p.hasDay ? `Due ${format(p.start, 'EEE MMM d')}` : 'No date';
  if (r.kind === 'deadline') return `Due ${format(p.start, 'EEE MMM d')} · ${fmtTime(p.start)}`;
  if (p.allDay) {
    const last = p.end - 86_400_000;
    return startOfDay(last).getTime() > startOfDay(p.start).getTime() ? `${format(p.start, 'EEE MMM d')} – ${format(last, 'EEE MMM d')} · all day` : `${format(p.start, 'EEE MMM d')} · all day`;
  }
  return `${format(p.start, 'EEE MMM d')} · ${fmtTime(p.start)} – ${fmtTime(p.end)}`;
}

export function DropExtract() {
  const drop = useStore((s) => s.drop);
  const calendars = useStore((s) => s.calendars);
  const writable = useMemo(() => calendars.filter((c) => !readOnly(c)), [calendars]);
  const [text, setText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [skipped, setSkipped] = useState<{ text: string; why: string }[]>([]);
  const [calId, setCalId] = useState(() => newEventCalendarId(useStore.getState()));
  const [hover, setHover] = useState<number | null>(null);
  const [over, setOver] = useState(false);
  const srcRef = useRef<HTMLDivElement>(null);
  const close = () => useStore.getState().closeDrop();
  // a file dragged from outside onto any part of the window (not in-app drags: only real files)
  const [cover, setCover] = useState(false);
  useEffect(() => {
    let depth = 0;
    const files = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const enter = (e: DragEvent) => { if (!files(e)) return; e.preventDefault(); depth++; setCover(true); };
    const leave = (e: DragEvent) => { if (!files(e)) return; if (--depth <= 0) { depth = 0; setCover(false); } };
    const overW = (e: DragEvent) => { if (files(e)) e.preventDefault(); };
    const dropW = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setCover(false);
      const f = e.dataTransfer!.files[0];
      if (f) useStore.getState().openDrop({ file: f });
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', overW);
    window.addEventListener('drop', dropW);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('dragover', overW); window.removeEventListener('drop', dropW); };
  }, []);

  const reading = useRef(0);
  const [thinking, setThinking] = useState(false);
  const read = (t: string) => {
    const now = new Date();
    show(t, extract(t, calendars, now), now);
    // then the Mac's own language model (macOS 26, Apple Intelligence on): better titles, a few more finds; if it
    // can't run, what the rules read stays
    const id = ++reading.current;
    if (!('__TAURI_INTERNALS__' in window) || !t.trim() || /BEGIN:VEVENT/i.test(t)) { setThinking(false); return; }
    setThinking(true);
    void import('@tauri-apps/api/core').then(({ invoke }) => invoke<string>('model_read', { text: t, today: format(now, 'EEEE, MMMM d, yyyy') }))
      .then((out) => {
        const r = JSON.parse(out) as { available?: boolean; items?: ModelItem[] };
        if (id !== reading.current || !r.available || !Array.isArray(r.items)) return;
        const items = r.items.filter((x) => x && typeof x.title === 'string').map((x) => ({ kind: String(x.kind ?? ''), title: x.title, when: String(x.when ?? ''), location: String(x.location ?? ''), repeats: String(x.repeats ?? '') }));
        show(t, combine(items, t, calendars, now), now);
      })
      .catch(() => {})
      .finally(() => { if (id === reading.current) setThinking(false); });
  };
  const show = (t: string, r: Extraction, now: Date) => {
    setRows(r.proposals.map((p, i) => {
      const sentence = t.slice(p.from, p.to);
      const alts = sentence && sentence.length < 300 ? readings(sentence, calendars, now, 6, p.kind).filter((a) => !a.id.startsWith('title-')).slice(0, 2).map((a) => ({ label: a.label, p: { ...a.parsed, title: p.parsed.title, location: p.parsed.location ?? a.parsed.location }, kind: a.kind })) : [];
      return { ...p, on: p.confidence >= 0.6, key: `${i}-${p.parsed.start}`, alts };
    }));
    setSkipped(r.skipped);
  };
  const load = async (what: { text?: string; file?: File }) => {
    setError(null);
    if (what.text !== undefined) {
      setFileName(null);
      setText(what.text);
      read(what.text);
      return;
    }
    if (!what.file) return;
    setBusy(true);
    setFileName(what.file.name);
    try {
      const doc = await readDocument(what.file);
      setText(doc.text);
      read(doc.text);
    } catch (e) {
      setError((e as Error).message || 'That file couldn’t be read.');
      setRows([]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (drop.open && (drop.text !== undefined || drop.file)) void load(drop);
    if (!drop.open) { reading.current++; setText(''); setRows([]); setSkipped([]); setFileName(null); setError(null); }
  }, [drop]); // eslint-disable-line react-hooks/exhaustive-deps

  // the source with what each row came from marked
  const marked = useMemo(() => {
    const spans = rows.map((r, i) => ({ i, from: r.from, to: r.to, on: r.on })).filter((x) => x.to > x.from).sort((a, b) => a.from - b.from);
    const out: (string | { s: string; i: number; on: boolean })[] = [];
    let at = 0;
    for (const sp of spans) {
      if (sp.from < at) continue;
      out.push(text.slice(at, sp.from), { s: text.slice(sp.from, sp.to), i: sp.i, on: sp.on });
      at = sp.to;
    }
    out.push(text.slice(at));
    return out;
  }, [rows, text]);
  useEffect(() => { if (hover !== null) srcRef.current?.querySelector(`mark[data-i="${hover}"]`)?.scrollIntoView({ block: 'nearest' }); }, [hover]);

  const add = () => {
    const st = useStore.getState();
    const chosen = rows.filter((r) => r.on);
    st.addMany(() => {
      for (const r of chosen) {
        const p = r.parsed;
        if (r.kind === 'task') st.addTask({ title: p.title, ...(p.hasDay ? { due: startOfDay(p.start).getTime() } : {}) });
        else if (r.kind === 'deadline') st.createEvent({ calendarId: '', title: p.title, start: p.start, end: p.start, allDay: false, kind: 'deadline', leadDays: defaultLeadDays(), ...(p.location ? { location: p.location } : {}), ...(r.flight ? { flight: r.flight } : {}), ...(r.url ? { url: r.url } : {}), ...(r.notes ? { notes: r.notes } : {}) });
        else st.createEvent({ calendarId: calId, title: p.title, start: p.start, end: p.end, allDay: p.allDay, ...(p.location ? { location: p.location } : {}), ...(p.recurrence ? { recurrence: p.recurrence } : {}), ...(p.timeZone ? { timeZone: p.timeZone } : {}), ...(r.url ? { url: r.url } : {}), ...(r.notes ? { notes: r.notes } : {}) });
      }
    });
    close();
    if (chosen.length) {
      st.goTo(Math.min(...chosen.map((r) => r.parsed.start)));
      st.showToast(`Added ${chosen.length}: ${chosen.map((r) => r.parsed.title).join(', ').slice(0, 120)}`);
    }
  };
  const patch = (i: number, p: Partial<Row>) => { reading.current++; setThinking(false); return setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...p } : r))); };

  if (!drop.open) return cover ? <Portal><div className="dx-cover">Drop to find what’s in it</div></Portal> : null;
  const on = rows.filter((r) => r.on).length;
  const counts = (k: ExtractKind) => rows.filter((r) => r.kind === k).length;
  return (
    <Portal>
      <div className="dx-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div className="dx" role="dialog" aria-modal="true" aria-label="Find events, deadlines and to-dos" tabIndex={-1} ref={(n) => { if (n && !n.contains(document.activeElement)) n.focus(); }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
          <div className="dx-head">
            <h2>Find events, deadlines and to-dos</h2>
            <button className="icon-btn" onClick={close} aria-label="Close">✕</button>
          </div>
          <div className="dx-body">
            <div className="dx-left">
              {fileName && <div className="dx-file"><span className="dx-file-ic">{/\.pdf$/i.test(fileName) ? 'PDF' : /\.ics$/i.test(fileName) ? 'ICS' : /\.eml$/i.test(fileName) ? 'EML' : 'TXT'}</span><span><b>{fileName}</b><br /><small>read on this device</small></span></div>}
              <div
                className={cls('dx-zone', over && 'over')}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }}
                onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) void load({ file: f }); else { const t = e.dataTransfer.getData('text'); if (t) void load({ text: t }); } }}
              >
                {text ? (
                  <div className="dx-src" ref={srcRef}>
                    {marked.map((m, k) => (typeof m === 'string' ? m : <mark key={k} data-i={m.i} className={cls(!m.on && 'dim', hover === m.i && 'hot')}>{m.s}</mark>))}
                  </div>
                ) : (
                  <textarea
                    autoFocus
                    placeholder={`Paste an email, a text thread, an invitation letter… or drop a PDF, .eml or .ics file${'__TAURI_INTERNALS__' in window ? ', or a screenshot,' : ''} here`}
                    onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); void load({ text: t }); } }}
                    onChange={(e) => e.target.value.trim().length > 20 && void load({ text: e.target.value })}
                  />
                )}
              </div>
              <div className="dx-hint">
                {busy ? 'Reading…' : thinking ? 'Reading on this Mac…' : error ? <span className="bad">{error}</span> : text ? <button className="chip" onClick={() => { reading.current++; setThinking(false); setText(''); setRows([]); setSkipped([]); setFileName(null); }}>Clear</button> : 'Read on this device — nothing is uploaded.'}
                <label className="chip">Choose file…<input type="file" accept={`.pdf,.eml,.ics,.txt,text/*,application/pdf${'__TAURI_INTERNALS__' in window ? ',image/*' : ''}`} hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void load({ file: f }); }} /></label>
              </div>
            </div>
            <div className="dx-right">
              <div className="dx-found">
                {!text ? 'Nothing yet — paste or drop something on the left.' : rows.length ? <>Found <b>{rows.length}</b> · {counts('event')} event{counts('event') === 1 ? '' : 's'}, {counts('deadline')} deadline{counts('deadline') === 1 ? '' : 's'}, {counts('task')} to-do{counts('task') === 1 ? '' : 's'}</> : 'Nothing to add in this one.'}
              </div>
              <div className="dx-list">
                {rows.map((r, i) => (
                  <div key={r.key} className={cls('dx-item', !r.on && 'off')} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                    <input type="checkbox" checked={r.on} onChange={(e) => patch(i, { on: e.target.checked })} aria-label={`Add ${r.parsed.title}`} />
                    <div className="dx-item-body">
                      <div className="dx-row1">
                        <button className={cls('dx-kind', `k-${r.kind}`)} title="Change what it is" onClick={() => patch(i, { kind: r.kind === 'event' ? 'deadline' : r.kind === 'deadline' ? 'task' : 'event' })}>{KIND_LABEL[r.kind]}</button>
                        <input className="dx-title" value={r.parsed.title} onChange={(e) => patch(i, { parsed: { ...r.parsed, title: e.target.value } })} aria-label="Title" />
                      </div>
                      <div className="dx-when">
                        {when(r)}
                        {r.parsed.location && <> · ⌖ {r.parsed.location}</>}
                        {r.url && <> · 🔗 {hostLabel(r.url)}</>}
                        {r.parsed.timeZone && <span className="dx-z"> · {zoneCity(r.parsed.timeZone)} time</span>}
                        {r.parsed.recurrence && <span className="dx-z"> · ↻ {describeRecurrence(r.parsed.recurrence, r.parsed.start)}</span>}
                      </div>
                      <div className="dx-why">
                        {r.why ?? (r.to > r.from ? `from “${text.slice(r.from, r.to).trim().slice(0, 110)}${r.to - r.from > 110 ? '…' : ''}”` : '')}
                        {!r.parsed.hasTime && !r.parsed.allDay && r.kind !== 'task' && <span className="warn"> · no time given — {fmtTime(r.parsed.start)} assumed</span>}
                      </div>
                      {r.alts.length > 0 && (
                        <div className="dx-alts">
                          {r.alts.map((a, j) => (
                            <button key={j} className="qa-alt" style={{ '--c': 'var(--focus)' } as CSSProperties} onClick={() => patch(i, { parsed: a.p, kind: a.kind ?? r.kind, alts: r.alts.filter((_, k) => k !== j) })}>{a.label}</button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {skipped.length > 0 && <div className="dx-why dx-skipped">Left out: {skipped.slice(0, 6).map((x) => `“${x.text.trim().slice(0, 60)}” — ${x.why}`).join(' · ')}</div>}
              </div>
              <div className="dx-foot">
                <span className="dx-cal">
                  Events go in{' '}
                  <select value={calId} onChange={(e) => setCalId(e.target.value)} aria-label="Calendar">
                    {writable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </span>
                <button className="ce-btn" onClick={close}>Cancel</button>
                <button className="dx-add" disabled={!on} onClick={add}>{on ? `Add ${on}` : 'Add'}</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}
