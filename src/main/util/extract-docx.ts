import { extractOffice } from './office-extract';
export { DOCX_EXTRACTION_VERSION } from './docx-numbering';

/**
 * .docx → markdown. Pure function, reusable anywhere in main/.
 *
 * Uses mammoth's convertToMarkdown to preserve heading/list/emphasis structure
 * (more useful for downstream organizer than raw text).
 */

/** Conversion and numbering run in the existing bounded Office worker pool. */
export async function docxBufferToMarkdown(buf: Buffer): Promise<string> {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('docxBufferToMarkdown: empty or invalid buffer');
  return extractOffice('docx-markdown', buf);
}

/** Read-only HTML preview; source layout remains approximate. */
export async function docxBufferToHtml(buf: Buffer): Promise<string> {
  if (!Buffer.isBuffer(buf) || buf.length === 0) throw new Error('docxBufferToHtml: empty or invalid buffer');
  return extractOffice('docx-html', buf);
}

export interface DocxChunkOpts {
  /** Per-chunk char budget. Default 8000 to match extract-pdf's default. */
  maxChars?: number;
}

export interface DocxChunk {
  text: string;
  /** 1-based index, purely informational. */
  index: number;
}

const DEFAULT_MAX_CHARS = 8_000;

/** Extract + chunk. Heading-aware: splits on `##+ ` boundaries first, then
 *  falls back to paragraph / sentence / char packing. Returns at least one
 *  chunk (may be empty for empty docx). */
export async function docxBufferToChunks(buf: Buffer, opts: DocxChunkOpts = {}): Promise<DocxChunk[]> {
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const md = await docxBufferToMarkdown(buf);
  if (!md) return [{ text: '', index: 1 }];

  const raw = packByHeading(md, maxChars);
  // Assign 1-based indices at the end so caller can stamp chunk N/total.
  return raw.map((text, i) => ({ text, index: i + 1 }));
}

/** Split a markdown doc into ≤maxChars chunks, preferring heading boundaries. */
function packByHeading(md: string, maxChars: number): string[] {
  // Heading line = ^#{1,6}\s. Break BEFORE each heading; first chunk may be the
  // preamble before the first heading.
  const lines = md.split('\n');
  const sections: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && cur.length) {
      sections.push(cur.join('\n').trim());
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.length) sections.push(cur.join('\n').trim());

  const chunks: string[] = [];
  let buf = '';
  const flush = () => { if (buf.trim()) chunks.push(buf.trim()); buf = ''; };

  for (const sec of sections) {
    if (!sec) continue;
    if (sec.length > maxChars) {
      flush();
      for (const piece of splitOversized(sec, maxChars)) chunks.push(piece);
      continue;
    }
    const wouldBe = buf ? buf.length + 2 + sec.length : sec.length;
    if (wouldBe > maxChars && buf) flush();
    buf = buf ? `${buf}\n\n${sec}` : sec;
  }
  flush();
  return chunks.length ? chunks : [''];
}

/** Paragraph → sentence → char, in that order. Mirrors extract-pdf's splitter. */
function splitOversized(text: string, maxChars: number): string[] {
  const out: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let buf = '';
  const push = () => { if (buf.trim()) out.push(buf.trim()); buf = ''; };
  for (const p of paragraphs) {
    if (p.length > maxChars) {
      push();
      const sentences = p.split(/(?<=[.!?。！？\n])\s+/);
      let sb = '';
      for (const s of sentences) {
        if (s.length > maxChars) {
          if (sb.trim()) { out.push(sb.trim()); sb = ''; }
          for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars));
          continue;
        }
        if (sb.length + 1 + s.length > maxChars && sb.trim()) { out.push(sb.trim()); sb = ''; }
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
