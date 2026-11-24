// The document reader on hostile and huge input: it must never throw, never hang, and never propose nonsense times.
import { describe, expect, it } from 'vitest';
import { extract } from '../lib/extract';
import { emailText, htmlText } from '../lib/readDocument';
import { DEFAULT_CALENDARS } from '../data/mock';

const SLACK = Number(process.env.PERF_SLACK) || (process.env.CI ? 4 : 1);
const NOW = new Date(2026, 10, 23, 10);
const run = (t: string) => extract(t, DEFAULT_CALENDARS, NOW);
const timed = (t: string) => { const t0 = performance.now(); const r = run(t); let ms = performance.now() - t0; if (ms > 1000 * SLACK) { const t1 = performance.now(); run(t); ms = performance.now() - t1; } return { r, ms }; };
const sane = (r: ReturnType<typeof run>) => r.proposals.every((p) => Number.isFinite(p.parsed.start) && Number.isFinite(p.parsed.end) && p.parsed.end >= p.parsed.start && p.parsed.title.length < 300 && p.from >= 0 && p.to >= p.from);

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const WORDS = ['meeting', 'tomorrow', 'at', '3', 'pm', 'dec', '12', 'due', 'friday', 'cancelled', 'Subject:', 'Re:', '>', 'From:', 'every', 'tuesday', '2nd', 'and', 'then', '—', '\n', '\n\n', 'RSVP', 'by', 'noon', '7:30', 'Zoom', 'ID:', '913', '555-0142', '©', '2026', '$14.99', 'Hi', 'Dear', 'Best,', 'Mei:', '[11/23, 9:52 PM]', 'BEGIN:VEVENT', 'RRULE:FREQ=WEEKLY', 'END:VEVENT', 'ok', '😀', '🗓️', '(', ')', ':', 'Date:', 'When:', 'Where:'];

describe('dropped documents, hostile and huge', () => {
  it('random documents never throw and every proposal is sane', () => {
    for (let i = 0; i < 300; i++) {
      const doc = Array.from({ length: 5 + Math.floor(rnd() * 120) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ');
      const r = run(doc);
      expect(sane(r), doc).toBe(true);
    }
  });
  it('a 200 KB email reads in about a second at most', () => {
    const para = 'Hi all, the group meeting is on Thursday Dec 3 at 2pm in MP 1318. Please send slides by Wednesday. Thanks!\n';
    const { r, ms } = timed(('From: a\nSubject: x\n\n' + para.repeat(1800)).slice(0, 200_000));
    expect(ms).toBeLessThan(1500 * SLACK);
    expect(r.proposals.length).toBeLessThan(50); // (the same thing over and over is kept once)
  });
  it('a 200 KB line with no line breaks, and text past the cap, read without hanging', () => {
    expect(timed('meeting tomorrow at 3 '.repeat(12_000)).ms).toBeLessThan(1500 * SLACK);
    expect(timed('x'.repeat(1_000_000)).ms).toBeLessThan(1500 * SLACK);
  });
  it('binary junk and control characters', () => {
    let junk = '';
    for (let i = 0; i < 20_000; i++) junk += String.fromCharCode(Math.floor(rnd() * 0xffff));
    const { r, ms } = timed(junk);
    expect(sane(r)).toBe(true);
    expect(ms).toBeLessThan(1500 * SLACK);
  });
  it('a long chat thread of time changes ends on the last one', () => {
    const lines = ['Ana: dinner friday?'];
    for (let h = 5; h <= 9; h++) lines.push(`Bo: can we do ${h}?`, `Ana: ok ${h}`);
    const r = run(lines.join('\n'));
    const dinner = r.proposals.filter((p) => p.kind === 'event');
    expect(dinner.length).toBe(1);
    expect(new Date(dinner[0].parsed.start).getHours()).toBe(21);
  });
  it('emails and HTML decode without running anything', () => {
    const eml = 'From: a@b.c\r\nSubject: =?UTF-8?Q?Caf=C3=A9_meeting?=\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nMeet at the caf=C3=A9 on Dec 3 at 2pm=\r\n.';
    expect(emailText(eml)).toContain('Subject: Café meeting');
    expect(emailText(eml)).toContain('café on Dec 3 at 2pm.');
    const html = '<p>Party <b>Dec 5</b> at 7pm</p><script>window.__pwned = 1</script><img src=x onerror="window.__pwned=2">';
    expect(htmlText(html)).toContain('Party Dec 5 at 7pm');
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe('drop: regressions from the UI pass', () => {
  const NOW = new Date(2026, 10, 23, 10);
  it('highlights the whole sentence, weekday and all', () => {
    const t = 'Hi,\nDentist Tuesday Dec 8 at 3pm.\nThanks';
    const [p] = extract(t, DEFAULT_CALENDARS, NOW).proposals;
    expect(t.slice(p.from, p.to)).toBe('Dentist Tuesday Dec 8 at 3pm.');
  });
  it('a policy sentence is not an event', () => {
    expect(extract('Returns accepted within 30 days.\nTotal $12.00', DEFAULT_CALENDARS, NOW).proposals).toHaveLength(0);
  });
  it('each VEVENT keeps its own repeat rule', () => {
    const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a', 'DTSTART:20261201T150000Z', 'DTEND:20261201T160000Z', 'RRULE:FREQ=WEEKLY;UNTIL=20270126T150000Z', 'SUMMARY:Class', 'END:VEVENT',
      'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261218T230000Z', 'DTEND:20261219T020000Z', 'SUMMARY:Holiday party', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    const ps = extract(ics, DEFAULT_CALENDARS, NOW).proposals;
    expect(ps.find((p) => p.parsed.title === 'Class')?.parsed.recurrence?.until).toBe(Date.UTC(2027, 0, 26, 15));
    expect(ps.find((p) => p.parsed.title === 'Holiday party')?.parsed.recurrence).toBeUndefined();
  });
  it('pasted HTML source reads as its words', () => {
    const ps = extract('<p>Join us for the <b>Holiday Open House</b></p><p>Thursday, December 10 &ndash; 4:00&nbsp;PM</p>', DEFAULT_CALENDARS, NOW).proposals;
    expect(ps.map((p) => p.parsed.title).join()).not.toMatch(/[<>]|&nbsp/);
  });
});
