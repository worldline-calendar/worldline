// Find: every event, deadline and task by its words (title, place, notes) — past and future. ⌘F or / opens it.
// A date typed on its own ("march 3") offers to go there. Upcoming ones first (soonest first), then past ones (most recent first); Enter or a click goes to it.
import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { format } from 'date-fns';
import { useStore } from '../data/store';
import { decodeEvent, occurrences } from '../lib/recurrence';
import { dueOf } from '../lib/tasks';
import type { CalEvent } from '../data/types';
import { parseQuick } from '../lib/quickparse';

interface Hit {
  id: string;
  title: string;
  when?: number; // the occurrence shown (a series: its next one, or its last)
  allDay: boolean;
  color: string;
  where?: string;
  kind: 'event' | 'deadline' | 'task' | 'series' | 'date';
}

const MAX = 60;
const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);
const hay = (...xs: (string | undefined)[]) => xs.filter(Boolean).join(' \u0000 ').toLowerCase();

export function Search() {
  const close = () => useStore.getState().setSearch(false);
  const events = useStore((s) => s.events);
  const tasks = useStore((s) => s.tasks);
  const calendars = useStore((s) => s.calendars);
  const [q, setQ] = useState('');
  const query = useDeferredValue(q); // (typing never waits on the search)
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const hits = useMemo((): Hit[] => {
    const ws = words(query);
    if (!ws.length) return [];
    const now = Date.now();
    // a date on its own ("march 3", "next friday", "12/24"): go there
    const p = parseQuick(query, calendars);
    const date: Hit[] = p.hasDay && !p.title.trim() ? [{ id: '', title: `Go to ${format(p.start, 'EEEE, MMMM d, yyyy')}`, when: p.start, allDay: true, color: 'var(--focus)', kind: 'date' }] : [];
    const color = new Map(calendars.map((c) => [c.id, c.color]));
    const out: Hit[] = [];
    for (const raw of events) {
      if (raw.seriesId && !raw.recurrence) { /* an exception to a series: found like any event */ }
      const h = hay(raw.title, raw.location, raw.notes);
      if (!ws.every((w) => h.includes(w))) continue;
      let ev: CalEvent = decodeEvent(raw);
      let kind: Hit['kind'] = raw.kind === 'deadline' ? 'deadline' : 'event';
      if (raw.recurrence) {
        kind = 'series';
        ev = occurrences(raw, now, now + 400 * 86_400_000)[0] ?? occurrences(raw, now - 400 * 86_400_000, now).at(-1) ?? ev;
      }
      out.push({ id: ev.id, title: raw.title || 'New Event', when: ev.start, allDay: ev.allDay, color: color.get(raw.calendarId) ?? 'var(--text-3)', where: raw.location, kind });
    }
    for (const t of tasks) {
      if (!ws.every((w) => t.title.toLowerCase().includes(w))) continue;
      out.push({ id: t.id, title: t.title, when: dueOf(t), allDay: true, color: 'var(--ok)', kind: 'task' });
    }
    const up = out.filter((h) => h.when === undefined || h.when >= now - 3_600_000).sort((a, b) => (a.when ?? Infinity) - (b.when ?? Infinity));
    const past = out.filter((h) => h.when !== undefined && h.when < now - 3_600_000).sort((a, b) => b.when! - a.when!);
    return [...date, ...up, ...past].slice(0, MAX);
  }, [query, events, tasks, calendars]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => listRef.current?.querySelector('.sr-hit.on')?.scrollIntoView({ block: 'nearest' }), [active]);

  const open = (h: Hit) => {
    const st = useStore.getState();
    close();
    st.setPage('calendar');
    if (h.when !== undefined) st.goTo(h.when);
    if (h.kind === 'date') return;
    st.select(h.id);
    st.flash(h.id);
  };

  const now = Date.now();
  const firstPast = hits.findIndex((h) => h.kind !== 'date' && h.when !== undefined && h.when < now - 3_600_000);
  return (
    <div className="qa-scrim" onMouseDown={close}>
      <div className="qa sr" role="dialog" aria-modal="true" aria-label="Find" onMouseDown={(e) => e.stopPropagation()}>
        <div className="qa-input-row">
          <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden style={{ color: 'var(--text-3)' }}>
            <circle cx="7" cy="7" r="4.5" /><path d="m10.5 10.5 3 3" />
          </svg>
          <input
            className="qa-input"
            autoFocus
            value={q}
            placeholder="Find events, deadlines, tasks — or type a date"
            aria-label="Find"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') close();
              else if (e.key === 'ArrowDown') (e.preventDefault(), setActive((i) => Math.min(i + 1, hits.length - 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setActive((i) => Math.max(i - 1, 0)));
              else if (e.key === 'Enter' && hits[active]) open(hits[active]);
            }}
          />
        </div>
        {query && (
          <div className="sr-list" ref={listRef} role="listbox">
            {!hits.length && <div className="sr-empty">Nothing matches “{query}”</div>}
            {hits.map((h, i) => (
              <div key={h.kind + h.id}>
                {i === firstPast && <div className="sr-sep">Past</div>}
                <button
                  className={'sr-hit' + (i === active ? ' on' : '')}
                  role="option"
                  aria-selected={i === active}
                  style={{ '--c': h.color } as CSSProperties}
                  onMouseMove={() => setActive(i)}
                  onClick={() => open(h)}
                >
                  <span className={h.kind === 'task' ? 'sr-check' : h.kind === 'date' ? 'sr-go' : 'sr-dot'} />
                  <span className="sr-title">{h.kind === 'deadline' ? '⚑ ' : ''}{h.title}</span>
                  {h.where && <span className="sr-where">{h.where}</span>}
                  {h.kind !== 'date' && <span className="sr-when">
                    {h.kind === 'series' && <span className="sr-rep" title="Repeats — showing the next one">↻ </span>}
                    {h.when === undefined ? 'no date' : format(h.when, new Date(h.when).getFullYear() === new Date().getFullYear() ? 'EEE MMM d' : 'MMM d, yyyy') + (h.allDay ? '' : format(h.when, ' · h:mm a'))}
                  </span>}
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="qa-foot"><span><kbd>↑</kbd><kbd>↓</kbd> choose</span><span><kbd>↵</kbd> go to it</span><span><kbd>esc</kbd> close</span></div>
      </div>
    </div>
  );
}
