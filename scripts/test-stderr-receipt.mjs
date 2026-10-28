import { createHash } from 'node:crypto';

const MODULUS = 1n << 256n;
const MAX_LINE_BYTES = 1024 * 1024;

// Multiset digest of exact lines: concurrent workers may reorder whole lines,
// but missing, added, modified or interleaved bytes cannot inherit attribution.
// Only an aggregate digest/count leaves the worker, never raw diagnostic text.
export function createStderrReceipt() {
  let lineHash = createHash('sha256');
  let lineBytes = 0;
  let sum = 0n;
  let bytes = 0;
  let lines = 0;
  let valid = true;
  const finishLine = () => {
    sum = (sum + BigInt(`0x${lineHash.digest('hex')}`)) % MODULUS;
    lines += 1;
    lineHash = createHash('sha256');
    lineBytes = 0;
  };
  return {
    ingest(chunk, encoding) {
      const data = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk);
      bytes += data.length;
      if (!valid) return;
      let start = 0;
      while (start < data.length) {
        const newline = data.indexOf(10, start);
        const end = newline === -1 ? data.length : newline + 1;
        lineBytes += end - start;
        if (lineBytes > MAX_LINE_BYTES) { valid = false; return; }
        lineHash.update(data.subarray(start, end));
        if (newline !== -1) finishLine();
        start = end;
      }
    },
    finish() {
      if (valid && lineBytes) finishLine();
      return { valid, bytes, lines, digest: sum.toString(16).padStart(64, '0') };
    },
  };
}

export function combineStderrReceipts(receipts) {
  let sum = 0n;
  let bytes = 0;
  let lines = 0;
  let valid = true;
  for (const receipt of receipts) {
    if (!receipt?.valid || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0
      || !Number.isSafeInteger(receipt.lines) || receipt.lines < 0 || !/^[a-f0-9]{64}$/.test(receipt.digest)) {
      valid = false;
      continue;
    }
    sum = (sum + BigInt(`0x${receipt.digest}`)) % MODULUS;
    bytes += receipt.bytes;
    lines += receipt.lines;
  }
  return { valid, bytes, lines, digest: sum.toString(16).padStart(64, '0') };
}
