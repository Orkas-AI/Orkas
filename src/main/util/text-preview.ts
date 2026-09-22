import * as fs from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

export const TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Read a bounded prefix without splitting UTF-8 code points. Callers own path
 * authorization. Partial results must never be offered as editable originals. */
export function readTextPreview(absPath: string): { text: string; truncated: boolean } {
  const fd = fs.openSync(absPath, 'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('not a file');
    const buf = Buffer.allocUnsafe(TEXT_PREVIEW_BYTES + 1);
    let size = 0;
    while (size < buf.length) {
      const count = fs.readSync(fd, buf, size, buf.length - size, size);
      if (!count) break;
      size += count;
    }
    const truncated = size > TEXT_PREVIEW_BYTES;
    const decoder = new StringDecoder('utf8');
    let text = decoder.write(buf.subarray(0, Math.min(size, TEXT_PREVIEW_BYTES)));
    if (!truncated) text += decoder.end();
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return { text, truncated };
  } finally { fs.closeSync(fd); }
}
