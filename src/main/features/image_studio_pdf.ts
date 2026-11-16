import { inflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

const MAX_PDF_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
function fail(reason = 'use a single-page PDF with vector content at the current canvas size'): never {
  throw new Error(`E_IMAGE_PDF_INVALID: ${reason}.`);
}

/** Inspect host-produced Chromium output, never an arbitrary replacement file.
 * Text strings/comments are excluded from operator recognition. This reports
 * actual vector content, not that every effect or embedded photo is vector. */
export async function inspectImageStudioPdf(bytes: Buffer, canvas: { width: number; height: number }, options: { allowRaster?: boolean } = {}) {
  if (bytes.length > MAX_PDF_BYTES || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail();
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    if (document.getPageCount() !== 1) fail('PDF must contain exactly one page');
    const page = document.getPage(0), box = page.getSize();
    if (page.getRotation().angle !== 0 || Math.abs(box.width - canvas.width * .75) > .1
      || Math.abs(box.height - canvas.height * .75) > .1) fail(`PDF page size ${box.width}x${box.height} differs from the canvas`);
    let hasText = false, hasPaths = false, imageCount = 0, inspectedBytes = 0, objects = 0;
    const visited = new Set<unknown>();
    const scan = (value: unknown) => {
      if (!value || visited.has(value)) return;
      visited.add(value);
      if (++objects > 256) fail();
      if (value instanceof PDFArray) {
        for (let index = 0; index < value.size(); index++) scan(value.lookup(index));
        return;
      }
      if (!(value instanceof PDFRawStream)) fail('PDF content stream is unsupported');
      const subtype = value.dict.get(PDFName.of('Subtype'));
      if (subtype === PDFName.of('Image')) { imageCount++; return; }
      const filter = value.dict.get(PDFName.of('Filter'));
      const remaining = MAX_CONTENT_BYTES - inspectedBytes;
      if (remaining <= 0) fail();
      const content = filter === PDFName.of('FlateDecode')
        ? inflateSync(value.contents, { maxOutputLength: remaining })
        : !filter ? value.contents : fail();
      inspectedBytes += content.length;
      if (inspectedBytes > MAX_CONTENT_BYTES) fail();
      const text = content.toString('latin1');
      let tokens = '', nesting = 0;
      for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (nesting) {
          if (char === '\\') index++;
          else if (char === '(') nesting++;
          else if (char === ')') nesting--;
        } else if (char === '(') { nesting = 1; tokens += ' '; }
        else if (char === '%') { while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index++; tokens += ' '; }
        else if (char === '<' && text[index + 1] !== '<') { while (index < text.length && text[index] !== '>') index++; tokens += ' '; }
        else tokens += char;
      }
      const operators = tokens.split(/\s+/);
      hasText ||= operators.some(op => ['Tj', 'TJ', "'", '"'].includes(op));
      hasPaths ||= operators.some(op => ['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'sh'].includes(op));
      const resources = value.dict.lookup(PDFName.of('Resources'));
      scanResources(resources);
    };
    const scanResources = (resources: unknown) => {
      if (!(resources instanceof PDFDict)) return;
      const xobjects = resources.lookup(PDFName.of('XObject'));
      if (xobjects instanceof PDFDict) for (const [, object] of xobjects.entries()) scan(document.context.lookup(object));
    };
    scan(page.node.Contents());
    scanResources(page.node.Resources());
    if (!hasText && !hasPaths && !options.allowRaster) fail('PDF has no vector text or painted paths');
    return { pages: 1, width_points: box.width, height_points: box.height,
      has_text: hasText, has_paths: hasPaths, embedded_images: imageCount };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('E_IMAGE_PDF_INVALID:')) throw error;
    fail();
  }
}


/** Chromium rounds physical paper sizes to printer units. Correct only that
 * sub-point rounding while retaining CSS geometry measured from the top left. */
export async function normalizeImageStudioPdfCanvas(bytes: Buffer, canvas: { width: number; height: number }): Promise<Buffer> {
  if (bytes.length > MAX_PDF_BYTES || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) fail();
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  if (document.getPageCount() !== 1) fail();
  const page = document.getPage(0), box = page.getSize();
  const width = canvas.width * .75, height = canvas.height * .75;
  if (Math.abs(box.width - width) > 1 || Math.abs(box.height - height) > 1) fail();
  if (box.width === width && box.height === height) return bytes;
  page.translateContent(0, height - box.height);
  page.setSize(width, height);
  const result = Buffer.from(await document.save());
  if (result.length > MAX_PDF_BYTES) fail();
  return result;
}
