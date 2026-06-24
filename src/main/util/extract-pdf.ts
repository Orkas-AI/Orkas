/**
 * PDF → text chunks. Pure function, reusable anywhere in main/.
 *
 * Uses pdfjs-dist's legacy ESM build (no worker thread, runs fine in main proc).
 * Dynamic import because pdfjs-dist is ESM-only and main runs under tsx/cjs.
 */

export interface PdfExtractOpts {
  /** Per-chunk char budget. Default 8000 — a LLM-consumption unit sized to
   *  fit ~4-6k tokens on mixed CJK/EN content. Call sites that need to match
   *  organizer's MAX_FILE_CHARS can pass it explicitly. */
  maxChars?: number;
}

export interface PdfChunk {
  text: string;        // markdown-ish plain text
  pageStart: number;   // 1-based
  pageEnd: number;     // 1-based (== pageStart for mid-page splits)
}

const DEFAULT_MAX_CHARS = 8_000;

/** Bump when the extraction algorithm or chunking boundary changes
 *  in a way that invalidates on-disk caches (chat_attachments /
 *  contexts_extract / file_indexer). Each cache layer records this
 *  version and wipes the directory on mismatch. */
export const EXTRACT_CACHE_VERSION = 3;

/** Lazy module handle so we only pay the import cost once per process. */
let _pdfjsPromise: Promise<any> | null = null;
function loadPdfjs(): Promise<any> {
  if (!_pdfjsPromise) {
    _pdfjsPromise = (async () => {
      const mod: any = await import('pdfjs-dist/legacy/build/pdf.mjs' as any);
      // pdfjs needs a workerSrc even in Node; point it at the bundled worker.
      // Without this getDocument() throws "No GlobalWorkerOptions.workerSrc specified".
      try {
        const url = await import('node:url');
        const workerPath = url.pathToFileURL(
          require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
        ).href;
        if (mod.GlobalWorkerOptions) mod.GlobalWorkerOptions.workerSrc = workerPath;
      } catch { /* fall back to fake worker */ }
      return mod;
    })();
  }
  return _pdfjsPromise;
}

export async function pdfBufferToChunks(buf: Buffer, opts: PdfExtractOpts = {}): Promise<PdfChunk[]> {
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const pageTexts = await pdfBufferToPages(buf);
  return packPagesIntoChunks(pageTexts, maxChars);
}

/**
 * Extract per-page plain text from a PDF buffer. Returns one entry per page
 * (may be empty for blank/image-only pages). Used by file_indexer when it
 * needs to build a pageMap for range reads — KB and the legacy chunker both
 * still go through `pdfBufferToChunks` above.
 */
export async function pdfBufferToPages(buf: Buffer): Promise<string[]> {
  if (!buf || !(buf instanceof Buffer) || buf.length === 0) {
    throw new Error('pdfBufferToPages: empty or invalid buffer');
  }

  const pdfjs: any = await loadPdfjs();
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;

  const numPages = doc.numPages;
  const pageTexts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pageTexts.push(stitchTextItems(content.items));
    page.cleanup();
  }
  await doc.destroy();

  return pageTexts;
}

/** pdfjs returns items with `str` and a transform — stitch with newlines on big y deltas. */
function stitchTextItems(items: any[]): string {
  if (!items.length) return '';
  const out: string[] = [];
  let prevY: number | null = null;
  for (const it of items) {
    if (typeof it?.str !== 'string') continue;
    const y = Array.isArray(it.transform) ? it.transform[5] : null;
    if (prevY !== null && y !== null && Math.abs(prevY - y) > 4) {
      out.push('\n');
    } else if (out.length && !out[out.length - 1].endsWith(' ') && it.str && !it.str.startsWith(' ')) {
      out.push(' ');
    }
    out.push(it.str);
    if (y !== null) prevY = y;
    if (it.hasEOL) out.push('\n');
  }
  return out.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Greedy pack pages into chunks ≤ maxChars; split a single oversized page on paragraph/sentence/char. */
function packPagesIntoChunks(pageTexts: string[], maxChars: number): PdfChunk[] {
  const chunks: PdfChunk[] = [];
  let buf: string[] = [];
  let bufLen = 0;
  let bufStart = 0;
  let bufEnd = 0;

  const flush = () => {
    if (!buf.length) return;
    chunks.push({ text: buf.join('\n\n').trim(), pageStart: bufStart, pageEnd: bufEnd });
    buf = []; bufLen = 0; bufStart = 0; bufEnd = 0;
  };

  for (let i = 0; i < pageTexts.length; i++) {
    const pageNum = i + 1;
    const text = pageTexts[i].trim();
    if (!text) continue;

    if (text.length > maxChars) {
      // Single page too big — flush current buffer first, then split this page alone.
      flush();
      const parts = splitOversized(text, maxChars);
      for (const p of parts) {
        chunks.push({ text: p, pageStart: pageNum, pageEnd: pageNum });
      }
      continue;
    }

    // Compute would-be size with current buffer, then flush if it overflows.
    // After flush() the buffer is empty, so the separator becomes 0 — recompute
    // it AFTER the flush check, otherwise we double-count it (see prior bug).
    const wouldAdd = (buf.length ? 2 : 0) + text.length;
    if (bufLen + wouldAdd > maxChars && buf.length) flush();
    if (!buf.length) bufStart = pageNum;
    const sep = buf.length ? 2 : 0;
    buf.push(text);
    bufLen += sep + text.length;
    bufEnd = pageNum;
  }
  flush();

  // Edge: empty PDF → return a single empty chunk so callers can still write a placeholder.
  if (!chunks.length) chunks.push({ text: '', pageStart: 1, pageEnd: pageTexts.length || 1 });
  return chunks;
}

/** Split an oversized chunk by paragraph, then sentence, then hard char-cut. */
function splitOversized(text: string, maxChars: number): string[] {
  const out: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let buf = '';
  const push = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      push();
      // Sentence split.
      const sentences = p.split(/(?<=[.!?。！？\n])\s+/);
      let sb = '';
      for (const s of sentences) {
        if (s.length > maxChars) {
          if (sb.trim()) { out.push(sb.trim()); sb = ''; }
          // Hard char cut.
          for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
          continue;
        }
        if (sb.length + 1 + s.length > maxChars && sb.trim()) {
          out.push(sb.trim()); sb = '';
        }
        sb += (sb ? ' ' : '') + s;
      }
      if (sb.trim()) out.push(sb.trim());
      continue;
    }
    if (buf.length + 2 + p.length > maxChars && buf.trim()) push();
    buf += (buf ? '\n\n' : '') + p;
  }
  push();
  return out;
}
