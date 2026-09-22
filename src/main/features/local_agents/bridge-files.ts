/** Bounded file pages for run-bound Skill resources and retained connector output. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isPathAllowed } from '../../util/path-sandbox';

export const BRIDGE_FILE_PAGE_BYTES = 60_000;

export function bridgeResourceRealpath(file: string): string {
  try { return fs.realpathSync(file); }
  catch { throw new Error('Skill resource is unavailable; check the listed Skill and relative resource path'); }
}

export function readBridgeFilePage(file: string, input: Record<string, unknown>) {
  const offset = input.offset === undefined ? 0 : input.offset;
  const limit = input.limit === undefined ? BRIDGE_FILE_PAGE_BYTES : input.limit;
  const encoding = input.encoding === undefined ? 'utf8' : input.encoding;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('offset must be a non-negative safe integer');
  if (!Number.isSafeInteger(limit) || (limit as number) < 4 || (limit as number) > BRIDGE_FILE_PAGE_BYTES) {
    throw new Error(`limit must be between 4 and ${BRIDGE_FILE_PAGE_BYTES} bytes`);
  }
  if (encoding !== 'utf8' && encoding !== 'base64') throw new Error('encoding must be utf8 or base64');
  let fd: number;
  // A FIFO must reach descriptor validation without waiting for a writer.
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0)); }
  catch { throw new Error('resource is unavailable for reading'); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error('resource must be a regular file');
    if ((offset as number) > stat.size) throw new Error(`offset exceeds resource size (${stat.size} bytes)`);
    const size = Math.min((limit as number) + 3, stat.size - (offset as number));
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const count = fs.readSync(fd, buffer, read, size - read, (offset as number) + read);
      if (!count) break;
      read += count;
    }
    let end = Math.min(limit as number, read);
    if (encoding === 'utf8' && end < read) {
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
    }
    const bytes = buffer.subarray(0, end);
    let content: string;
    try { content = encoding === 'base64' ? bytes.toString('base64') : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new Error('Resource is not UTF-8 at this offset; use encoding=base64 for binary files or the returned next_offset for text'); }
    const next = (offset as number) + end;
    return { content, encoding, offset, bytes: stat.size, next_offset: next < stat.size ? next : null };
  } finally { fs.closeSync(fd); }
}

export function resolveBridgeSkillResource(root: string, entry: string, resource: unknown): string {
  if (resource === undefined) {
    if (!isPathAllowed(entry, [root], { rootsResolved: true })) throw new Error('Skill entry is outside its bound directory');
    return bridgeResourceRealpath(entry);
  }
  if (typeof resource !== 'string' || !resource.trim() || resource.includes('\0')
      || path.posix.isAbsolute(resource) || path.win32.isAbsolute(resource)
      || resource.includes('\\') || resource.split('/').includes('..')) {
    throw new Error('path must be a relative file path inside the selected Skill');
  }
  const file = path.resolve(root, resource);
  if (!isPathAllowed(file, [root], { rootsResolved: true })) throw new Error('resource is outside the selected Skill');
  return bridgeResourceRealpath(file);
}
