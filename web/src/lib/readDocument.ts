// A dropped file as text, read on this device: a PDF (pdf.js, loaded only when one is dropped), an email (.eml: its
// readable part, decoded), a calendar file (.ics) or anything plain. Nothing is uploaded.
const MAX_BYTES = 25 * 1024 * 1024; // (a bigger file isn't an invitation)
const MAX_PAGES = 30;

export async function readDocument(file: File): Promise<{ text: string; kind: 'pdf' | 'email' | 'ics' | 'text' }> {
  if (file.size > MAX_BYTES) throw new Error('That file is too large to read (over 25 MB).');
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return { text: await pdfText(file), kind: 'pdf' };
  if (/^(?:image|video|audio)\//.test(file.type) || /\.(?:png|jpe?g|gif|heic|webp|tiff?|bmp|mp[34]|mov|zip|gz|dmg|exe|docx?|xlsx?|pptx?|pages|key|numbers)$/.test(name))
    throw new Error('That kind of file can’t be read here — paste its text, or drop a PDF, email, .ics or text file.');
  const raw = await file.text();
  // (bytes that aren't text: many replacement characters or control codes in the first few KB)
  const head = raw.slice(0, 4000);
  if (head && ((head.match(/\uFFFD|[\x00-\x08\x0E-\x1F]/g)?.length ?? 0) / head.length > 0.05)) throw new Error('That file isn’t text — nothing to read in it.');
  if (!raw.trim()) throw new Error('That file is empty.');
  if (name.endsWith('.ics') || /BEGIN:VCALENDAR/i.test(raw.slice(0, 2000))) return { text: raw, kind: 'ics' };
  if (name.endsWith('.eml') || /^(?:received|from|return-path|mime-version):/im.test(raw.slice(0, 500))) return { text: emailText(raw), kind: 'email' };
  return { text: raw, kind: 'text' };
}

// pdf.js reads a page's text with `for await (… of stream)`; the Mac app's WebKit can't loop over a stream that way yet
// ("undefined is not a function"), so it's taught to here
function streamsIterable() {
  const RS = globalThis.ReadableStream?.prototype as (ReadableStream & { [Symbol.asyncIterator]?: unknown }) | undefined;
  if (!RS || RS[Symbol.asyncIterator]) return;
  Object.defineProperty(RS, Symbol.asyncIterator, {
    configurable: true,
    writable: true,
    value: async function* (this: ReadableStream) {
      const reader = this.getReader();
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) return; yield value; }
      } finally { reader.releaseLock(); }
    },
  });
}

async function pdfText(file: File) {
  streamsIterable();
  const pdfjs = await import('pdfjs-dist');
  const data = new Uint8Array(await file.arrayBuffer());
  let task;
  let doc;
  try {
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    task = pdfjs.getDocument({ data: data.slice() });
    doc = await task.promise;
  } catch {
    // the worker couldn't start (a webview that won't run it): read on the page itself — slower, same result
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import('pdfjs-dist/build/pdf.worker.min.mjs');
    task = pdfjs.getDocument({ data });
    doc = await task.promise;
  }
  const pages: string[] = [];
  for (let i = 1; i <= Math.min(doc.numPages, MAX_PAGES); i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // lines from the text's positions: a new line wherever the baseline moves
    let line = '', lastY: number | null = null;
    const lines: string[] = [];
    for (const it of content.items as { str: string; transform: number[]; hasEOL?: boolean }[]) {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2 && line) { lines.push(line); line = ''; }
      line += (line && !line.endsWith(' ') && it.str && !it.str.startsWith(' ') ? ' ' : '') + it.str;
      if (it.hasEOL && line) { lines.push(line); line = ''; }
      lastY = y;
    }
    if (line) lines.push(line);
    pages.push(lines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n'));
  }
  await task.destroy();
  return pages.join('\n\n');
}

/** An email's readable text: its headers (From, Sent/Date, Subject) and its text/plain part, decoded. */
export function emailText(raw: string) {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  const body = rest.join('\n\n');
  const header = (k: string) => new RegExp(`^${k}:\\s*(.+(?:\\r?\\n[ \\t].+)*)`, 'im').exec(head)?.[1].replace(/\r?\n[ \t]+/g, ' ').trim();
  const keep = ['From', 'Date', 'Subject'].map((k) => (header(k) ? `${k === 'Date' ? 'Sent' : k}: ${decodeWords(header(k)!)}` : '')).filter(Boolean);
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(head)?.[1];
  let text = body;
  let encoding = header('Content-Transfer-Encoding') ?? '';
  if (boundary) {
    const parts = body.split(`--${boundary}`);
    const plain = parts.find((p) => /content-type:\s*text\/plain/i.test(p)) ?? parts.find((p) => /content-type:\s*text\/html/i.test(p)) ?? '';
    const [ph, ...pb] = plain.split(/\r?\n\r?\n/);
    text = pb.join('\n\n');
    encoding = /content-transfer-encoding:\s*(\S+)/i.exec(ph)?.[1] ?? '';
    if (/text\/html/i.test(ph)) text = htmlText(decode(text, encoding)), encoding = '';
  }
  return [...keep, '', decode(text, encoding)].join('\n');
}
function decode(s: string, encoding: string) {
  if (/base64/i.test(encoding)) {
    try { return new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s+/g, '')), (c) => c.charCodeAt(0))); } catch { return s; }
  }
  if (/quoted-printable/i.test(encoding)) {
    const bytes = s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    try { return new TextDecoder().decode(Uint8Array.from(bytes, (c) => c.charCodeAt(0))); } catch { return bytes; }
  }
  return s;
}
/** "=?UTF-8?Q?Caf=C3=A9?=" in a header, readable. */
function decodeWords(s: string) {
  return s.replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, _cs: string, enc: string, t: string) => decode(enc.toUpperCase() === 'B' ? t : t.replace(/_/g, ' '), enc.toUpperCase() === 'B' ? 'base64' : 'quoted-printable'));
}
/** An HTML email's words, line by line (no markup runs: it's parsed inert and only its text is kept). */
export function htmlText(html: string) {
  if (typeof DOMParser === 'undefined') {
    // (no DOM here: tags dropped as text — nothing is ever rendered or run)
    return html.replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<(?:br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, '\n').replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, head').forEach((n) => n.remove());
  doc.querySelectorAll('br, p, div, li, tr, h1, h2, h3, h4, td').forEach((n) => n.append('\n'));
  return (doc.body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
