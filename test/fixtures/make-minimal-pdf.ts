/**
 * Minimal PDF generator for tests. Produces a valid PDF 1.4 with one or more
 * single-line text pages. Just enough for pdfjs-dist to parse and extract text.
 *
 * Used by extract-pdf.test.ts and contexts_extract.test.ts. NOT for production.
 */

import { Buffer } from 'node:buffer';

/** Build a minimal PDF where each input string becomes one page rendered with Helvetica 24pt. */
export function makeMinimalPdf(pages: string[]): Buffer {
  if (!pages.length) pages = [''];

  const objects: string[] = [];
  // Object indices (1-based). Layout:
  //   1 = Catalog
  //   2 = Pages
  //   3 = Font (shared)
  //   4..3+N = Page object for page i
  //   4+N..3+2N = Content stream for page i
  const N = pages.length;
  const pageObjStart = 4;
  const contentObjStart = 4 + N;

  // 1: Catalog
  objects.push(`<</Type/Catalog/Pages 2 0 R>>`);
  // 2: Pages — Kids list and Count
  const kids = Array.from({ length: N }, (_, i) => `${pageObjStart + i} 0 R`).join(' ');
  objects.push(`<</Type/Pages/Count ${N}/Kids[${kids}]>>`);
  // 3: Font (Helvetica, standard 14)
  objects.push(`<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`);

  // Page objects
  for (let i = 0; i < N; i++) {
    objects.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${contentObjStart + i} 0 R/Resources<</Font<</F1 3 0 R>>>>>>`
    );
  }
  // Content streams
  for (let i = 0; i < N; i++) {
    const safe = pages[i].replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    const stream = `BT /F1 24 Tf 72 720 Td (${safe}) Tj ET`;
    objects.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  }

  // Now serialize, tracking byte offsets per object.
  const header = `%PDF-1.4\n%\xff\xff\xff\xff\n`;
  const parts: Buffer[] = [Buffer.from(header, 'binary')];
  let cursor = parts[0].length;
  const offsets: number[] = [0];   // index 0 reserved for the free-list head

  objects.forEach((body, idx) => {
    offsets.push(cursor);
    const chunk = Buffer.from(`${idx + 1} 0 obj\n${body}\nendobj\n`, 'binary');
    parts.push(chunk);
    cursor += chunk.length;
  });

  // xref
  const xrefStart = cursor;
  const lines: string[] = [];
  lines.push(`xref`);
  lines.push(`0 ${objects.length + 1}`);
  lines.push(`0000000000 65535 f `);
  for (let i = 1; i <= objects.length; i++) {
    lines.push(`${String(offsets[i]).padStart(10, '0')} 00000 n `);
  }
  lines.push(`trailer`);
  lines.push(`<</Size ${objects.length + 1}/Root 1 0 R>>`);
  lines.push(`startxref`);
  lines.push(`${xrefStart}`);
  lines.push(`%%EOF`);
  parts.push(Buffer.from(lines.join('\n') + '\n', 'binary'));

  return Buffer.concat(parts);
}
