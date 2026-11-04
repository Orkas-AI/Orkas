import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { historyRecordTextParts, historyProcessEntries } from '../chat-history-records';
import { makeSnippet, type ChatSnippet } from './snippet';

const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_STORED_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 1024 * 1024;
const CHUNK_CHARS = 128 * 1024;
type Chunk = [offset: number, bytes: number, filter?: string];
const FILTER_BYTES = 1024;
function gramBit(a: number, b: number): number {
  return (Math.imul(a, 131) ^ Math.imul(b, 2654435761)) & (FILTER_BYTES * 8 - 1);
}
function processFilter(batch: Array<string | [number, string]>): string {
  const bits = Buffer.alloc(FILTER_BYTES);
  for (const value of batch) {
    const text = (typeof value === 'string' ? value : value[1]).toLowerCase();
    for (let i = 0; i < text.length; i++) {
      const a = text.charCodeAt(i), single = gramBit(a, 65536);
      bits[single >>> 3] |= 1 << (single & 7);
      if (i + 1 < text.length) {
        const pair = gramBit(a, text.charCodeAt(i + 1));
        bits[pair >>> 3] |= 1 << (pair & 7);
      }
    }
  }
  return bits.toString('base64');
}
function mayContain(bits: Buffer, term: string): boolean {
  if (!term.length) return true;
  for (let i = 0; i < Math.max(1, term.length - 1); i++) {
    const bit = gramBit(term.charCodeAt(i), term.length === 1 ? 65536 : term.charCodeAt(i + 1));
    if (!(bits[bit >>> 3] & (1 << (bit & 7)))) return false;
  }
  return true;
}
interface Projection {
  version: 2;
  parts: Chunk[];
  process: Chunk[];
  visible: boolean;
  msg_id?: string;
}

/** Store independently compressed public-text blocks. The source projector can
 * stop after its display window/first full-coverage process match, so decoding
 * one entire execution trail would repeat the original foreground bottleneck. */
export function buildChatProjection(message: any): { text: string; payload?: Buffer } {
  if (!message) return { text: '' };
  const parts = [...historyRecordTextParts(message, true)].filter(Boolean);
  const text = parts.join('\n');
  // Oversized outputs remain fully indexed and use the source reader.
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) return { text };
  const blocks: Buffer[] = [];
  let offset = 0;
  const encode = (values: Iterable<string | [number, string]>, process = false): Chunk[] => {
    const chunks: Chunk[] = [];
    let batch: Array<string | [number, string]> = [], chars = 0;
    const flush = () => {
      if (!batch.length) return;
      const encoded = JSON.stringify(batch);
      if (Buffer.byteLength(encoded) > MAX_TEXT_BYTES) throw Error('Projection block too large');
      const block = deflateRawSync(encoded, { level: 1 });
      chunks.push(process && chars > 4096 ? [offset, block.length, processFilter(batch)] : [offset, block.length]); blocks.push(block); offset += block.length;
      if (offset > MAX_STORED_BYTES) throw Error('Projection too large');
      batch = []; chars = 0;
    };
    for (const value of values) {
      const size = typeof value === 'string' ? value.length : value[1].length;
      if (batch.length && chars + size > CHUNK_CHARS) flush();
      batch.push(value); chars += size;
      if (chars >= CHUNK_CHARS || batch.length >= 64) flush();
    }
    flush();
    return chunks;
  };
  try {
    const projection: Projection = {
      version: 2, parts: encode(parts),
      process: encode((function* () {
        for (const { index, text } of historyProcessEntries(message, true)) yield [index, text] as [number, string];
      })(), true),
      visible: !message.deleted_at && !message.dispatch && parts.some(part => !!part.trim()),
      ...(typeof message.id === 'string' && message.id ? { msg_id: message.id } : {}),
    };
    const header = Buffer.from(JSON.stringify(projection));
    if (header.length > MAX_HEADER_BYTES || 4 + header.length + offset > MAX_STORED_BYTES) return { text };
    const length = Buffer.alloc(4); length.writeUInt32LE(header.length);
    return { text, payload: Buffer.concat([length, header, ...blocks]) };
  } catch { return { text }; }
}

/** A corrupt/incompatible cache is a miss. Inflate and directories are bounded,
 * and only public-text blocks actually consumed by the query are decoded. */
export function projectEncodedChatSnippet(payload: Buffer, tokens: readonly string[]): ChatSnippet | undefined {
  try {
    if (payload.length < 4 || payload.length > MAX_STORED_BYTES) return undefined;
    const length = payload.readUInt32LE(0), base = 4 + length;
    if (length > MAX_HEADER_BYTES || base > payload.length) return undefined;
    const value: Projection = JSON.parse(payload.subarray(4, base).toString('utf8'));
    const validChunks = (chunks: unknown): chunks is Chunk[] => Array.isArray(chunks) && chunks.every(chunk =>
      Array.isArray(chunk) && (chunk.length === 2 || (chunk.length === 3 && typeof chunk[2] === 'string' && Buffer.from(chunk[2], 'base64').length === FILTER_BYTES)) && Number.isSafeInteger(chunk[0]) && chunk[0] >= 0
      && Number.isSafeInteger(chunk[1]) && chunk[1] > 0 && base + chunk[0] + chunk[1] <= payload.length);
    if (!value || value.version !== 2 || typeof value.visible !== 'boolean'
        || !validChunks(value.parts) || !validChunks(value.process)
        || (value.msg_id !== undefined && typeof value.msg_id !== 'string')) return undefined;
    let coverage = 0;
    const terms = [...new Set(tokens)];
    function* decode(chunks: Chunk[], process: boolean): Generator<any> {
      for (const [offset, bytes, filter] of chunks) {
        // A block union is an upper bound for every contained entry. False
        // positives only cost a decode; ties retain the earlier process match.
        if (process && filter) {
          const bits = Buffer.from(filter, 'base64');
          if (terms.filter(term => mayContain(bits, term)).length <= coverage) continue;
        }
        const block = JSON.parse(inflateRawSync(payload.subarray(base + offset, base + offset + bytes),
          { maxOutputLength: MAX_TEXT_BYTES }).toString('utf8'));
        if (!Array.isArray(block) || !block.every(item => process
          ? Array.isArray(item) && item.length === 2 && Number.isSafeInteger(item[0]) && item[0] >= 0 && typeof item[1] === 'string'
          : typeof item === 'string')) throw Error('Invalid projection block');
        yield* block;
      }
    }
    const result: ChatSnippet = { snippet: makeSnippet(decode(value.parts, false), tokens), visible: value.visible };
    if (value.msg_id) result.msg_id = value.msg_id;
    if (value.process.length) {
      result.has_process = true;
      for (const [index, text] of decode(value.process, true)) {
        const lower = text.toLowerCase();
        const matched = terms.reduce((count, term) => count + Number(lower.includes(term)), 0);
        if (matched > coverage) {
          coverage = matched;
          result.process_index = index;
          result.process_snippet = makeSnippet([text], tokens);
        }
        if (coverage === terms.length) break;
      }
    }
    return result;
  } catch { return undefined; }
}
