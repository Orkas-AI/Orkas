/**
 * Machine-local projection cache for renderer conversation history.
 *
 * Canonical conversation JSONL is intentionally lossless: terminal messages
 * retain their complete process trail, including expandable tool output. A
 * single record can therefore be several megabytes even though the renderer
 * initially shows only a short process summary.
 *
 * The newest requested page is projected into a small, clearable cache. A
 * cold read still honours byte-cursor pagination instead of scanning the full
 * conversation. Reopening an unchanged conversation reads only the projection;
 * when the canonical file is appended, only the new byte range is parsed.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { userConversationHistoryCacheDir } from '../paths';
import { createLogger } from '../logger';
import { logErrorSummary, logPathRef } from '../util/log-redact';
import { persistToolResult } from '../util/tool-result-cap';
import { readJson, readJsonlPageWithOffsets, writeJson } from '../storage';
import type { JsonlPage, JsonlRecordWithOffset } from '../storage';
import type { GroupMessage } from './group_chat/visibility';

const log = createLogger('conversation-history-cache');
const CACHE_VERSION = 4;
const MAX_INLINE_PROCESS_OUTPUT_BYTES = 1024;
const MAX_FAILURE_OUTPUT_PREVIEW_CHARS = 600;
const SOURCE_TAIL_FINGERPRINT_BYTES = 4 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_INCREMENTAL_APPEND_BYTES = 8 * 1024 * 1024;
// The persisted newest page serves the renderer's first paint and its
// append-extension. A caller asking for a whole-conversation tail (outputs
// panel, exports) must not widen that page: `capacity` follows the largest
// request ever made, so one 500-record read would turn every later 10-record
// read and every append into a 500-record parse+rewrite.
const LATEST_PAGE_MAX_RECORDS = 100;

type SourceSnapshot = {
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  tailHash: string;
};

type CachedRecord = JsonlRecordWithOffset<GroupMessage>;

type LatestPageCache = {
  version: number;
  source: SourceSnapshot;
  records: CachedRecord[];
  nextCursor: number | null;
};

type CachePaths = {
  entryDir: string;
  latestPageFile: string;
  toolResultsDir: string;
};

const builds = new Map<string, Promise<LatestPageCache | null>>();

function snapshotIdentity(stat: fs.Stats): Omit<SourceSnapshot, 'tailHash'> {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

function sameSourceIdentity(left: SourceSnapshot, right: Omit<SourceSnapshot, 'tailHash'>): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSourceSnapshot(left: SourceSnapshot, right: Omit<SourceSnapshot, 'tailHash'>): boolean {
  return sameSourceIdentity(left, right)
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function isCachedRecord(value: unknown): value is CachedRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CachedRecord>;
  return Number.isSafeInteger(candidate.start)
    && candidate.start! >= 0
    && !!candidate.record
    && typeof candidate.record === 'object';
}

function isLatestPageCache(value: unknown): value is LatestPageCache {
  if (!value || typeof value !== 'object') return false;
  const cache = value as Partial<LatestPageCache>;
  const source = cache.source as Partial<SourceSnapshot> | undefined;
  return cache.version === CACHE_VERSION
    && !!source
    && typeof source.dev === 'string'
    && typeof source.ino === 'string'
    && Number.isSafeInteger(source.size)
    && source.size! >= 0
    && Number.isFinite(source.mtimeMs)
    && typeof source.tailHash === 'string'
    && Array.isArray(cache.records)
    && cache.records.every(isCachedRecord)
    && (cache.nextCursor === null
      || (Number.isSafeInteger(cache.nextCursor) && cache.nextCursor! >= 0));
}

function cachePaths(userId: string, sourceFile: string): CachePaths {
  const key = createHash('sha256').update(path.resolve(sourceFile)).digest('hex').slice(0, 32);
  const entryDir = path.join(userConversationHistoryCacheDir(userId), key);
  return {
    entryDir,
    latestPageFile: path.join(entryDir, 'latest-page.json'),
    toolResultsDir: path.join(entryDir, 'tool-results'),
  };
}

function processOutputPreview(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_FAILURE_OUTPUT_PREVIEW_CHARS
    ? `${oneLine.slice(0, MAX_FAILURE_OUTPUT_PREVIEW_CHARS)}…`
    : oneLine;
}

function processEventIsFailure(data: Record<string, unknown>): boolean {
  const status = String(data.status || '').toLowerCase();
  return data.isError === true
    || data.is_error === true
    || data.error === true
    || (typeof data.error === 'string' && !!data.error.trim())
    || data.success === false
    || status === 'error'
    || status === 'failed';
}

function processToolKey(data: Record<string, unknown>): string {
  const raw = String(data.name || data.tool || data.toolName || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (raw.startsWith('orkas.')) return raw.slice('orkas.'.length);
  if (raw.startsWith('mcp__orkas__')) return raw.slice('mcp__orkas__'.length);
  return raw;
}

function processOutputIsPlanResult(output: unknown): boolean {
  let candidate = output;
  if (typeof candidate === 'string') {
    const text = candidate.trim();
    if (!text.startsWith('{') || text.length > 64 * 1024) return false;
    try { candidate = JSON.parse(text); } catch { return false; }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  return ['update', 'replace', 'append_step', 'set_status', 'clear']
    .includes(String((candidate as Record<string, unknown>).action || '').trim().toLowerCase());
}

function processEventNeedsStructuredOutput(data: Record<string, unknown>): boolean {
  return [
    'manage_execution_plan',
    'plan_set',
    'todo_write',
    'todowrite',
    'update_plan',
  ].includes(processToolKey(data)) || processOutputIsPlanResult(data.output);
}

function serializedProcessOutput(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (output === undefined) return null;
  try {
    return JSON.stringify(output);
  } catch {
    return null;
  }
}

function spillProcessOutput(
  data: Record<string, unknown>,
  stream: string,
  toolResultsDir: string,
): Record<string, unknown> {
  const output = serializedProcessOutput(data.output);
  if (output === null || Buffer.byteLength(output, 'utf8') <= MAX_INLINE_PROCESS_OUTPUT_BYTES) {
    return data;
  }
  // Plan-result values drive the visible plan rows during replay. Other
  // structured tool results are diagnostic data and do not need to cross IPC
  // or be parsed by the renderer. They were not expandable in the renderer
  // before this cache existed, so dropping them from this derived page changes
  // no UI behavior and avoids hundreds of synchronous spill-file writes.
  if (processEventNeedsStructuredOutput(data)) return data;

  const next = { ...data };
  if (typeof data.output !== 'string') {
    delete next.output;
    if (processEventIsFailure(data)) next.output = processOutputPreview(output);
    if (stream !== 'cli') next.result_size = Buffer.byteLength(output, 'utf8');
    return next;
  }

  const hasLazyLocation = stream === 'cli'
    ? !!(data.outputPath || data.outputRef)
    : !!data.result_path;
  if (hasLazyLocation) {
    delete next.output;
    if (processEventIsFailure(data)) next.output = processOutputPreview(output);
    if (stream !== 'cli' && !next.result_size) {
      next.result_size = Buffer.byteLength(output, 'utf8');
    }
    return next;
  }

  const toolName = String(data.name || data.tool || data.toolName || 'tool');
  try {
    const resultPath = persistToolResult(toolResultsDir, toolName, output);
    delete next.output;
    if (stream === 'cli') next.outputPath = resultPath;
    else {
      next.result_path = resultPath;
      next.result_size = Buffer.byteLength(output, 'utf8');
    }
    // Failure formatting historically falls back to the inline output. Keep a
    // bounded preview while the click-to-expand path owns the complete body.
    if (processEventIsFailure(data)) next.output = processOutputPreview(output);
    return next;
  } catch {
    // Cache projection must never make history unavailable. If the lazy spill
    // cannot be written, retain the canonical inline payload for this record.
    return data;
  }
}

function projectProcessItem(item: unknown, toolResultsDir: string): unknown | null {
  if (!item || typeof item !== 'object') return item;
  const typed = item as { type?: unknown; text?: unknown; event?: unknown };
  if (typed.type !== 'event' && typed.type !== 'progress') return item;
  if (!typed.event || typeof typed.event !== 'object') return item;

  const rawEvent = typed.event as { stream?: unknown; data?: unknown };
  const stream = String(rawEvent.stream || '');
  const rawData = rawEvent.data;
  const dataRecord: Record<string, unknown> | null = rawData
      && typeof rawData === 'object'
      && !Array.isArray(rawData)
    ? { ...(rawData as Record<string, unknown>) }
    : null;

  // These streams do not produce a renderer process-rail line. The canonical
  // JSONL and devtools archive remain lossless for diagnostics.
  if (stream === 'command_output' || stream === 'usage' || stream === 'item') return null;
  if (stream === 'cli' && dataRecord) {
    const cliType = String(dataRecord.type || '').toLowerCase();
    const cliStatus = String(dataRecord.status || '').toLowerCase();
    if (cliType === 'process-info') return null;
    if (cliType === 'status' && cliStatus === 'usage') return null;
    if (cliType === 'log' && String(dataRecord.level || 'info').toLowerCase() === 'debug') return null;
  }

  let projectedData: unknown = rawData;
  if (dataRecord) {
    let projectedRecord = dataRecord;
    if (stream === 'compaction') delete projectedRecord.summary;
    if (stream === 'cli'
        && String(projectedRecord.type || '').toLowerCase() === 'status'
        && String(projectedRecord.status || '').toLowerCase() === 'compacted') {
      delete projectedRecord.summary;
    }
    if (stream === 'tool'
        && String(projectedRecord.phase || projectedRecord.status || '').toLowerCase() === 'progress') {
      // Renderer uses the bounded message/timing fields; provider-specific
      // progress_data is diagnostic-only and can contain repeated payloads.
      delete projectedRecord.progress_data;
    }
    const isToolResult = stream === 'tool'
      && ['end', 'result'].includes(String(projectedRecord.phase || projectedRecord.status || '').toLowerCase());
    const isCliToolResult = stream === 'cli'
      && String(projectedRecord.type || '').toLowerCase() === 'tool-event'
      && ['end', 'result'].includes(String(projectedRecord.phase || '').toLowerCase());
    if (isToolResult || isCliToolResult) {
      projectedRecord = spillProcessOutput(projectedRecord, stream, toolResultsDir);
    }
    projectedData = projectedRecord;
  }

  return {
    ...typed,
    event: {
      ...rawEvent,
      ...(projectedData === undefined ? {} : { data: projectedData }),
    },
  };
}

/** Build the renderer-equivalent, byte-bounded representation of one row. */
export function projectConversationHistoryRecord(
  record: GroupMessage,
  toolResultsDir: string,
): GroupMessage {
  if (!Array.isArray(record.process) || !record.process.length) return record;
  const process = record.process
    .map((item) => projectProcessItem(item, toolResultsDir))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  return { ...record, process: process as GroupMessage['process'] };
}

/** Project already-selected records without changing their pagination/index identity. */
export function projectConversationHistoryRecords(
  userId: string,
  sourceFile: string,
  records: GroupMessage[],
): GroupMessage[] {
  const { toolResultsDir } = cachePaths(userId, sourceFile);
  return records.map((record) => projectConversationHistoryRecord(record, toolResultsDir));
}

async function sourceTailHash(sourceFile: string, size: number): Promise<string> {
  const start = Math.max(0, size - SOURCE_TAIL_FINGERPRINT_BYTES);
  const length = size - start;
  if (length <= 0) return createHash('sha256').digest('hex');
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fsp.open(sourceFile, 'r');
    const bytes = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(bytes, 0, length, start);
    return createHash('sha256').update(bytes.subarray(0, bytesRead)).digest('hex');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function snapshotWithHash(
  sourceFile: string,
  identity: Omit<SourceSnapshot, 'tailHash'>,
): Promise<SourceSnapshot> {
  return { ...identity, tailHash: await sourceTailHash(sourceFile, identity.size) };
}

async function prefixStillMatches(sourceFile: string, cached: SourceSnapshot): Promise<boolean> {
  try {
    return await sourceTailHash(sourceFile, cached.size) === cached.tailHash;
  } catch {
    return false;
  }
}

async function sourcePrefixEndsAtRecordBoundary(
  sourceFile: string,
  size: number,
): Promise<boolean> {
  if (size === 0) return true;
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fsp.open(sourceFile, 'r');
    const byte = Buffer.allocUnsafe(1);
    const { bytesRead } = await handle.read(byte, 0, 1, size - 1);
    return bytesRead === 1 && byte[0] === 0x0a;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readJsonlRangeWithOffsets<T>(
  sourceFile: string,
  start: number,
  end: number,
): Promise<JsonlRecordWithOffset<T>[]> {
  if (end <= start) return [];
  let handle: fs.promises.FileHandle;
  try { handle = await fsp.open(sourceFile, 'r'); }
  catch { return []; }
  const records: JsonlRecordWithOffset<T>[] = [];
  let position = start;
  let lineSegments: Buffer[] = [];
  let currentRecordStart = start;
  try {
    while (position < end) {
      const bytes = Math.min(READ_CHUNK_BYTES, end - position);
      const block = Buffer.allocUnsafe(bytes);
      const { bytesRead } = await handle.read(block, 0, bytes, position);
      if (bytesRead <= 0) break;
      let lineStart = 0;
      for (let i = 0; i < bytesRead; i += 1) {
        if (block[i] !== 0x0a) continue;
        const current = block.subarray(lineStart, i);
        const line = lineSegments.length
          ? Buffer.concat([...lineSegments, current])
          : current;
        const trimmed = line.toString('utf8').trim();
        if (trimmed) {
          try {
            records.push({ start: currentRecordStart, record: JSON.parse(trimmed) as T });
          } catch { /* retain malformed-row behavior of readJsonlPage */ }
        }
        lineSegments = [];
        lineStart = i + 1;
        currentRecordStart = position + lineStart;
      }
      position += bytesRead;
      if (lineStart < bytesRead) lineSegments.push(block.subarray(lineStart, bytesRead));
    }
    if (lineSegments.length) {
      const trimmed = (lineSegments.length === 1
        ? lineSegments[0]
        : Buffer.concat(lineSegments)).toString('utf8').trim();
      if (trimmed) {
        try { records.push({ start: currentRecordStart, record: JSON.parse(trimmed) as T }); }
        catch { /* retain malformed-row behavior of readJsonlPage */ }
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}

function cachedPage(cache: LatestPageCache, wanted: number): JsonlPage<GroupMessage> | null {
  if (cache.records.length < wanted && cache.nextCursor !== null) return null;
  const selected = cache.records.slice(-wanted);
  return {
    records: selected.map(({ record }) => record),
    nextCursor: selected.length && selected[0].start > 0 ? selected[0].start : null,
  };
}

async function coldLatestPage(
  userId: string,
  sourceFile: string,
  identity: Omit<SourceSnapshot, 'tailHash'>,
  wanted: number,
): Promise<LatestPageCache> {
  const startedAt = Date.now();
  const page = await readJsonlPageWithOffsets<GroupMessage>(sourceFile, wanted, identity.size);
  const readFinishedAt = Date.now();
  const projected = projectConversationHistoryRecords(
    userId,
    sourceFile,
    page.entries.map(({ record }) => record),
  );
  const projectedAt = Date.now();
  const source = await snapshotWithHash(sourceFile, identity);
  const finishedAt = Date.now();
  if (finishedAt - startedAt >= 100) {
    log.info('cold conversation history page projected', {
      source: logPathRef(sourceFile),
      source_bytes: identity.size,
      records: page.entries.length,
      read_ms: readFinishedAt - startedAt,
      project_ms: projectedAt - readFinishedAt,
      fingerprint_ms: finishedAt - projectedAt,
      duration_ms: finishedAt - startedAt,
    });
  }
  return {
    version: CACHE_VERSION,
    source,
    records: page.entries.map(({ start }, index) => ({ start, record: projected[index] })),
    nextCursor: page.nextCursor,
  };
}

async function extendLatestPage(
  userId: string,
  sourceFile: string,
  identity: Omit<SourceSnapshot, 'tailHash'>,
  wanted: number,
  cached: LatestPageCache,
): Promise<LatestPageCache | null> {
  if (!sameSourceIdentity(cached.source, identity)
      || identity.size <= cached.source.size
      || identity.size - cached.source.size > MAX_INCREMENTAL_APPEND_BYTES
      || (cached.records.length < wanted && cached.nextCursor !== null)
      || !await prefixStillMatches(sourceFile, cached.source)
      || !await sourcePrefixEndsAtRecordBoundary(sourceFile, cached.source.size)) {
    return null;
  }
  const appended = await readJsonlRangeWithOffsets<GroupMessage>(
    sourceFile,
    cached.source.size,
    identity.size,
  );
  const projected = projectConversationHistoryRecords(
    userId,
    sourceFile,
    appended.map(({ record }) => record),
  );
  const capacity = Math.max(wanted, cached.records.length);
  const merged = cached.records.concat(
    appended.map(({ start }, index) => ({ start, record: projected[index] })),
  ).slice(-capacity);
  return {
    version: CACHE_VERSION,
    source: await snapshotWithHash(sourceFile, identity),
    records: merged,
    nextCursor: merged.length && merged[0].start > 0 ? merged[0].start : null,
  };
}

async function buildLatestPage(
  userId: string,
  sourceFile: string,
  wanted: number,
): Promise<LatestPageCache | null> {
  const files = cachePaths(userId, sourceFile);
  const cachedCandidate = await readJson<LatestPageCache>(files.latestPageFile);
  let cached = isLatestPageCache(cachedCandidate) ? cachedCandidate : null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let before: fs.Stats;
    try { before = await fsp.stat(sourceFile); }
    catch { return null; }
    const identity = snapshotIdentity(before);
    if (cached && sameSourceSnapshot(cached.source, identity) && cachedPage(cached, wanted)) {
      return cached;
    }

    let next = cached
      ? await extendLatestPage(userId, sourceFile, identity, wanted, cached)
      : null;
    if (!next) next = await coldLatestPage(userId, sourceFile, identity, wanted);

    let after: fs.Stats;
    try { after = await fsp.stat(sourceFile); }
    catch { return null; }
    if (sameSourceSnapshot(next.source, snapshotIdentity(after))) {
      await fsp.mkdir(files.entryDir, { recursive: true });
      await writeJson(files.latestPageFile, next);
      return next;
    }
    // A message landed while the page was being projected. Keep the valid
    // prefix in memory and append only the newly-arrived range on the retry.
    cached = next;
  }
  return null;
}

async function latestPage(
  userId: string,
  sourceFile: string,
  wanted: number,
): Promise<JsonlPage<GroupMessage>> {
  const key = `${userId}\u0000${path.resolve(sourceFile)}`;
  // A concurrent caller may have started a smaller page build. Share it, then
  // expand once if this caller needs more rows than that projection contains.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let build = builds.get(key);
    if (!build) {
      build = buildLatestPage(userId, sourceFile, wanted).catch((err) => {
        log.warn('conversation history page cache unavailable', {
          source: logPathRef(sourceFile),
          error: logErrorSummary(err),
        });
        return null;
      });
      builds.set(key, build);
    }
    let cache: LatestPageCache | null;
    try { cache = await build; }
    finally {
      if (builds.get(key) === build) builds.delete(key);
    }
    const selected = cache && cachedPage(cache, wanted);
    if (selected) return selected;
  }

  // Stabilization/cache failures must not make history unavailable.
  const page = await readJsonlPageWithOffsets<GroupMessage>(sourceFile, wanted);
  return {
    records: projectConversationHistoryRecords(
      userId,
      sourceFile,
      page.entries.map(({ record }) => record),
    ),
    nextCursor: page.nextCursor,
  };
}

/**
 * Read one renderer-facing page. The newest page is persisted and append-
 * extended; older cursor pages remain direct bounded reads.
 */
export async function readConversationHistoryPage(
  userId: string,
  sourceFile: string,
  limit: number,
  before?: number | null,
): Promise<JsonlPage<GroupMessage>> {
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  if ((before === undefined || before === null) && wanted <= LATEST_PAGE_MAX_RECORDS) {
    return latestPage(userId, sourceFile, wanted);
  }
  const page = await readJsonlPageWithOffsets<GroupMessage>(sourceFile, wanted, before ?? undefined);
  return {
    records: projectConversationHistoryRecords(
      userId,
      sourceFile,
      page.entries.map(({ record }) => record),
    ),
    nextCursor: page.nextCursor,
  };
}

/** Remove the derived copy when the user deletes its canonical conversation. */
export async function purgeConversationHistoryCache(
  userId: string,
  sourceFile: string,
): Promise<void> {
  const key = `${userId}\u0000${path.resolve(sourceFile)}`;
  await builds.get(key)?.catch(() => {});
  await fsp.rm(cachePaths(userId, sourceFile).entryDir, { recursive: true, force: true });
}
