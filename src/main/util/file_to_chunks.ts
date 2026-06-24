/**
 * Pure file → text chunks extraction. Dispatches by `kind` and composes:
 *
 *   text  → paragraph-first packer (short paragraphs coalesce, oversized
 *           paragraphs split at sentence boundaries with char overlap)
 *   pdf   → `util/extract-pdf` + page-range titles
 *   docx  → `util/extract-docx` + heading-derived titles
 *   spreadsheet / presentation → lightweight OOXML text extraction + text
 *           chunking
 *   image → `imageDescriber` callback (required for image kind) turns the
 *           raw image bytes into a text description that then gets chunked
 *           as a single entry
 *
 * No state, no persistence, no uid: one in → one out. The sibling module
 * `features/vec_store.ts` composes this with the embedder and sqlite-vec
 * to form the full vectorisation pipeline.
 */

import { pdfBufferToChunks } from './extract-pdf';
import { docxBufferToChunks } from './extract-docx';
import { pptxBufferToMarkdown, xlsxBufferToMarkdown } from './extract-office';

export type ChunkableKind = 'text' | 'pdf' | 'docx' | 'spreadsheet' | 'presentation' | 'image';

export interface ExtractedChunk {
  title: string;
  content: string;
}

export interface FileToChunksOptions {
  kind: ChunkableKind;
  buf: Buffer;
  /** Max chars per chunk. Default 400 — bge-small-zh-v1.5 at 512-token window. */
  maxChars?: number;
  /** Char overlap across sentence cuts within the same paragraph. Default 50. */
  overlap?: number;
  /**
   * Required for `kind: 'image'`. Caller supplies vision-LLM adapter because
   * the LLM session is environment-specific (uid, auth, model selection) and
   * does not belong in a pure chunker.
   */
  imageDescriber?: (buf: Buffer) => Promise<string>;
  /** Display label for image chunks (e.g. the original filename). Optional. */
  imageTitle?: string;
}

export const DEFAULT_MAX_CHARS = 400;
export const DEFAULT_OVERLAP = 50;

/** Primary entrypoint. Returns ≥ 1 chunk for any successful input. */
export async function fileToChunks(opts: FileToChunksOptions): Promise<ExtractedChunk[]> {
  const budget = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const overlap = opts.overlap ?? DEFAULT_OVERLAP;

  if (opts.kind === 'text') {
    return chunkPlainText(opts.buf.toString('utf8'), budget, overlap);
  }
  if (opts.kind === 'pdf') {
    const chunks = await pdfBufferToChunks(opts.buf, { maxChars: budget });
    return chunks.map((c) => ({
      title: `p.${c.pageStart}${c.pageStart === c.pageEnd ? '' : `-${c.pageEnd}`}`,
      content: c.text || `(empty page ${c.pageStart})`,
    }));
  }
  if (opts.kind === 'docx') {
    const chunks = await docxBufferToChunks(opts.buf, { maxChars: budget });
    return chunks.map((c) => ({
      title: firstLineOrIndex(c.text, c.index),
      content: c.text || `(empty section ${c.index})`,
    }));
  }
  if (opts.kind === 'spreadsheet') {
    return chunkPlainText(xlsxBufferToMarkdown(opts.buf), budget, overlap);
  }
  if (opts.kind === 'presentation') {
    return chunkPlainText(pptxBufferToMarkdown(opts.buf), budget, overlap);
  }
  if (opts.kind === 'image') {
    if (!opts.imageDescriber) {
      throw new Error('fileToChunks: imageDescriber is required for kind=image');
    }
    const text = await opts.imageDescriber(opts.buf);
    if (!text || !text.trim()) throw new Error('imageDescriber returned empty text');
    return [{ title: opts.imageTitle || 'image', content: text.trim() }];
  }
  throw new Error(`fileToChunks: unhandled kind ${opts.kind}`);
}

// ── Text chunker (paragraph-first, sentence-split for oversized) ─────────

/**
 * Paragraph-first chunker for plain text. Rules:
 *   1. Split by blank-line runs (`\n{2,}`) into paragraphs.
 *   2. Short paragraphs (≤ budget) are greedy-packed into the same chunk
 *      while the running total stays within budget.
 *   3. Oversized paragraphs split at sentence boundaries (。！？!? + newline),
 *      with `overlap` chars carried across the cut for continuity. Overlap
 *      only applies within the same paragraph.
 *   4. A single sentence > budget (rare — pasted URL, no punctuation) is
 *      hard-sliced with overlap as a last resort.
 */
export function chunkPlainText(
  text: string,
  budget = DEFAULT_MAX_CHARS,
  overlap = DEFAULT_OVERLAP,
): ExtractedChunk[] {
  const trimmed = text.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return [{ title: '(empty)', content: '' }];
  const paras = trimmed.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const out: string[] = [];
  let pack = '';
  const flushPack = () => { if (pack) { out.push(pack); pack = ''; } };

  for (const p of paras) {
    if (p.length > budget) {
      flushPack();
      for (const piece of splitOversizedParagraph(p, budget, overlap)) out.push(piece);
      continue;
    }
    const candidate = pack ? `${pack}\n\n${p}` : p;
    if (candidate.length <= budget) {
      pack = candidate;
    } else {
      flushPack();
      pack = p;
    }
  }
  flushPack();
  if (!out.length) out.push(trimmed);
  return out.map((content, i) => ({ title: titleOf(content, i + 1), content }));
}

function splitOversizedParagraph(text: string, budget: number, overlap: number): string[] {
  const sentences = splitSentences(text);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > budget) {
      if (cur) { out.push(cur.trim()); cur = ''; }
      const stride = Math.max(1, budget - overlap);
      for (let i = 0; i < s.length; i += stride) out.push(s.slice(i, i + budget).trim());
      continue;
    }
    if (cur.length + s.length > budget) {
      out.push(cur.trim());
      const tail = cur.slice(-overlap);
      cur = (tail + s).length <= budget ? tail + s : s;
    } else {
      cur += s;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** Tokenise on CJK+Latin sentence terminators. Newlines are soft terminators. */
function splitSentences(text: string): string[] {
  const out: string[] = [];
  const re = /[^。！？!?\n]+[。！？!?\n]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m[0].trim()) out.push(m[0]);
  }
  return out.length ? out : [text];
}

function titleOf(text: string, fallback: number): string {
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    if (s.startsWith('#')) return s.replace(/^#+\s*/, '').slice(0, 80);
    return s.slice(0, 80);
  }
  return `chunk ${fallback}`;
}

function firstLineOrIndex(text: string, index: number): string {
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (s) return s.replace(/^#+\s*/, '').slice(0, 80);
  }
  return `section ${index}`;
}
