// Set at build time from package.json (vite.config.ts → define).
declare const __APP_VERSION__: string;

// pdf.js's worker, imported to read PDFs on the page when a worker can't start (lib/readDocument.ts)
declare module 'pdfjs-dist/build/pdf.worker.min.mjs';
