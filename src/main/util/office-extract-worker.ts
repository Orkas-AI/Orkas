import { parentPort } from 'node:worker_threads';
import { xlsxBufferToMarkdown, xlsxBufferToHtml, pptxBufferToMarkdown, pptxBufferToHtml } from './extract-office';

const extractors = {
  'xlsx-markdown': xlsxBufferToMarkdown, 'xlsx-html': xlsxBufferToHtml,
  'pptx-markdown': pptxBufferToMarkdown, 'pptx-html': pptxBufferToHtml,
};
parentPort!.on('message', ({ kind, bytes }: { kind: keyof typeof extractors; bytes: Uint8Array }) => {
  try { parentPort!.postMessage({ ok: true, text: extractors[kind](Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)) }); }
  catch (error) { parentPort!.postMessage({ ok: false, error: error instanceof Error ? error.message : 'Office extraction failed' }); }
});
