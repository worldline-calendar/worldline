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

describe('drop: meeting links', () => {
  const NOW = new Date(2026, 10, 23, 10);
  it('a Zoom invite puts the link and dial-in on the event', () => {
    const t = `Hi all,\n\nProject sync is Wednesday Dec 2 at 10am.\n\nJoin Zoom Meeting\nhttps://utoronto.zoom.us/j/81234567890?pwd=abc123\n\nMeeting ID: 812 3456 7890\nPasscode: 445566\n\nThanks`;
    const [p] = extract(t, DEFAULT_CALENDARS, NOW).proposals;
    expect(p.url).toBe('https://utoronto.zoom.us/j/81234567890?pwd=abc123');
    expect(p.notes).toContain('Passcode: 445566');
    expect(p.parsed.location).toBe('Zoom');
  });
  it('a registration link stays with its deadline, not the meeting', () => {
    const t = `Seminar Dec 9 at 2pm: https://meet.google.com/abc-defg-hij\nRegister by Dec 4 at https://forms.example.org/reg`;
    const ps = extract(t, DEFAULT_CALENDARS, NOW).proposals;
    expect(ps.find((p) => p.kind === 'event')?.url).toContain('meet.google.com');
    expect(ps.find((p) => p.kind === 'deadline')?.url).toBe('https://forms.example.org/reg');
  });
});

describe('a booking with the flight number after its times (Air Canada)', () => {
  const doc = `From: Airline notification@example.com
Subject: Airline - 01 Dec 2026: Toronto - San Francisco (Booking reference: ABC123)
Date: November 18, 2026 at 23:04
Booking Confirmation
ABC123 Issued 19 Nov, 2026
Flights
Departure • Tue 01 Dec, 2026
Economy Standard
Toronto YYZ San Francisco SFO
12:50 15:40
Toronto-Pearson International Airport Terminal 1 San Francisco International Airport Terminal 2
AC 743 • Operated by Air Canada
Aircraft type: Airbus A321-200 Wi-Fi
Return • Fri 04 Dec, 2026
San Francisco SFO Toronto YYZ
12:00 19:55
AC 740 • Operated by Air Canada
Tickets are valid until 19 Nov, 2027. Changes allowed.`;
  it('reads both flights, each on its own airport clock, and ticks nothing else', () => {
    const r = extract(doc, [], new Date(2026, 10, 25, 12));
    const on = r.proposals.filter((p) => p.confidence >= 0.6);
    expect(on.map((p) => p.parsed.title)).toEqual(['AC 743 to San Francisco', 'AC 740 to Toronto']);
    expect(new Date(on[0].parsed.start).toISOString()).toBe('2026-12-01T17:50:00.000Z');
    expect(new Date(on[0].parsed.end).toISOString()).toBe('2026-12-01T23:40:00.000Z');
    expect(new Date(on[1].parsed.start).toISOString()).toBe('2026-12-04T20:00:00.000Z');
    expect(new Date(on[1].parsed.end).toISOString()).toBe('2026-12-05T00:55:00.000Z');
  });
});

describe('travel documents, as their PDFs read', () => {
  const at = (p: { parsed: { start: number; end: number } }) => [new Date(p.parsed.start).toISOString().slice(0, 16), new Date(p.parsed.end).toISOString().slice(0, 16)];
  const ticked = (doc: string, now: Date) => extract(doc, [], now).proposals.filter((p) => p.confidence >= 0.6);
  it('several legs under one date (Air Canada)', () => {
    const r = ticked(`FLIGHT 1 • Sat 05 Dec, 2026
Toronto YYZ Vancouver YVR
06:15 09:51
AC 101 • Operated by Air Canada
Vancouver YVR Shanghai PVG
12:25 16:00
AC 25 • Operated by Air Canada
FLIGHT 2 • Thu 17 Dec, 2026
Shanghai PVG Vancouver YVR
17:35 12:55
AC 26 • Operated by Air Canada
Taxes CAD 34.42 CA4 (CA4)`, new Date(2026, 10, 20));
    expect(r.map((p) => p.parsed.title)).toEqual(['AC 101 to Vancouver', 'AC 25 to Shanghai', 'AC 26 to Vancouver']);
    // (on each airport's own clock: whether BC keeps daylight time in winter depends on this machine's zone data)
    const clock = (t: number, z: string) => new Date(t).toLocaleString('en-CA', { timeZone: z, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    expect([clock(r[1].parsed.start, 'America/Vancouver'), clock(r[1].parsed.end, 'Asia/Shanghai')]).toEqual(['12-05, 12:25', '12-06, 16:00']);
    expect([clock(r[2].parsed.start, 'Asia/Shanghai'), clock(r[2].parsed.end, 'America/Vancouver')]).toEqual(['12-17, 17:35', '12-17, 12:55']);
  });
  it('a ticket table: cities, the number, then the times (Aeroméxico)', () => {
    const r = ticked(`Itinerary Details
26 Jul 26 AEROMEXICO Toronto, Canada Ciudad de Mexico Cabin ECONOMY / H
AEROVIAS DE M Seat Number 14F
AM 693 Baggage Allowance 0 PIECES
Time Time
11:01am 2:00pm
26 Jul 26 AEROMEXICO Ciudad de Mexico Tijuana Cabin ECONOMY / H
AM 182 Baggage Allowance 0 PIECES
Time Time
3:50pm 6:28pm`, new Date(2026, 5, 17));
    expect(r.map((p) => p.parsed.title)).toEqual(['AM 693 to Mexico City', 'AM 182 to Tijuana']);
    expect(at(r[0])).toEqual(['2026-07-26T15:01', '2026-07-26T20:00']);
  });
  it('every word printed four times, dates as 30.05.2026 (Finnair)', () => {
    const r = ticked(`Date: Date: Tuesday, April 14, 2026 at 00:17:30
Departure 30.05.2026
12:05 12:05 12:05 12:05
BUD BUD BUD BUD
15:25 15:25 15:25 15:25
HEL HEL HEL HEL
AY1252
Transfer time 1 h 25 min
16:50 16:50 16:50 16:50
HEL HEL HEL HEL
18:35 18:35 18:35 18:35
YYZ YYZ YYZ YYZ
AY031`, new Date(2026, 3, 15));
    expect(r.map((p) => p.parsed.title)).toEqual(['AY 1252 to Helsinki', 'AY 31 to Toronto']);
    expect(at(r[1])).toEqual(['2026-05-30T13:50', '2026-05-30T22:35']);
  });
  it('a train ticket, on the stations’ clock', () => {
    const r = ticked(`Your booking number is: XXXXXX
Outbound
Sun, May 17, 2026
11:58 AM Prague hlavní nádraží
3h 04 České dráhy | R 869
03:02 PM Brno hlavní nádraží
Ticket CA$27.38`, new Date(2026, 4, 16));
    expect(r.map((p) => p.parsed.title)).toEqual(['Train to Brno']);
    expect(at(r[0])).toEqual(['2026-05-17T09:58', '2026-05-17T13:02']);
  });
});
