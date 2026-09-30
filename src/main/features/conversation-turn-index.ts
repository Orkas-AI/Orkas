/** Worker-owned, rebuildable navigation index. Never import this store from
 * main: only bounded pages cross the conversation-history client boundary. */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as readline from 'node:readline';
import { createHash } from 'node:crypto';
import { userConversationTurnIndexPath } from '../paths';
import { readJson, writeJson } from '../storage';
import { createLogger } from '../logger';
import { logErrorSummary, logPathRef, maskId } from '../util/log-redact';
import { CONVERSATION_TURN_PAGE_SIZE, CONVERSATION_TURN_USER_PREVIEW_CHARS,
  CONVERSATION_TURN_ASSISTANT_PREVIEW_CHARS } from './conversation-turn-types';
import type { ConversationTurnIndexEntry, ConversationTurnPage } from './conversation-turn-types';

const log = createLogger('conversation-turn-index');

function _messageText(raw: any): string {
  if (!raw || typeof raw !== 'object') return '';
  if (typeof raw.text === 'string') return raw.text;
  if (typeof raw.content === 'string') return raw.content;
  if (Array.isArray(raw.content)) {
    return raw.content
      .map((part: any) => (typeof part === 'string'
        ? part
        : (part && typeof part.text === 'string' ? part.text : '')))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

// ── Compact conversation-turn navigation index ──────────────────────────

/**
 * The transcript stays tail-paged, but its navigation rail needs one stable
 * address for every user turn. This machine-local derived index is deliberately
 * compact and rebuildable: it never enters sync or the conversation metadata.
 */
const CONVERSATION_TURN_INDEX_VERSION = 2;
const CONVERSATION_TURN_FINGERPRINT_BYTES = 4 * 1024;
interface ConversationTurnIndexSource {
  owner: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

interface ConversationTurnIndexFile {
  version: number;
  source: ConversationTurnIndexSource;
  recordCount: number;
  tailHash: string;
  turns: ConversationTurnIndexEntry[];
}

const _conversationTurnIndexMemory = new Map<string, ConversationTurnIndexFile>();
/** Whole turn indexes stay resident per visited conversation and were only
 *  dropped on delete; keep the most recently used ones instead. */
const CONVERSATION_TURN_INDEX_MEMORY_MAX = 64;

function _rememberConversationTurnIndex(key: string, index: ConversationTurnIndexFile): void {
  _conversationTurnIndexMemory.delete(key);
  if (_conversationTurnIndexMemory.size >= CONVERSATION_TURN_INDEX_MEMORY_MAX) {
    const oldest = _conversationTurnIndexMemory.keys().next().value;
    if (oldest !== undefined) _conversationTurnIndexMemory.delete(oldest);
  }
  _conversationTurnIndexMemory.set(key, index);
}

export function _conversationTurnIndexMemorySizeForTest(): number {
  return _conversationTurnIndexMemory.size;
}
const _conversationTurnIndexBuilds = new Map<string, Promise<ConversationTurnIndexFile>>();

function _conversationTurnIndexKey(userId: string, cid: string): string {
  return `${userId}\u0000${cid}`;
}

function _conversationTurnSourceOwner(projectIdHint?: string | null): string {
  return projectIdHint ? `project:${projectIdHint}` : 'global';
}

async function _conversationTurnSource(
  file: string,
  projectIdHint?: string | null,
): Promise<ConversationTurnIndexSource> {
  try {
    const stat = await fsp.stat(file);
    return {
      owner: _conversationTurnSourceOwner(projectIdHint),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      ino: Number(stat.ino) || 0,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('conversation turn source stat failed', {
        file: logPathRef(file),
        error: logErrorSummary(err),
      });
      throw err;
    }
    return {
      owner: _conversationTurnSourceOwner(projectIdHint),
      size: 0,
      mtimeMs: 0,
      ctimeMs: 0,
      ino: 0,
    };
  }
}

function _sameConversationTurnSource(
  left: ConversationTurnIndexSource | null | undefined,
  right: ConversationTurnIndexSource,
): boolean {
  return !!left
    && left.owner === right.owner
    && Number(left.size) === right.size
    && Number(left.mtimeMs) === right.mtimeMs
    && Number(left.ctimeMs) === right.ctimeMs
    && Number(left.ino || 0) === right.ino;
}

function _truncateConversationTurnPreview(value: string, maximum: number): string {
  const text = String(value || '');
  let count = 0;
  let prefixEnd = 0;
  const retained = Math.max(1, maximum - 1);
  // Only the preview prefix needs code-point iteration. Array.from allocated
  // one slot per character of an arbitrarily large reply before discarding it.
  for (const char of text) {
    if (++count > maximum) return `${text.slice(0, prefixEnd)}…`;
    if (count <= retained) prefixEnd += char.length;
  }
  return text;
}

function _conversationTurnPreviewText(raw: unknown): string {
  return String(raw || '')
    .replace(/!\[([^\]]*)\]\([^\s)]+(?:\s+[^)]*)?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\s)]+(?:\s+[^)]*)?\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ')
    .replace(/(^|\s)(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '$1')
    .replace(/[`*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _isConversationTurnUserRecord(record: any): boolean {
  return String(record?.from || record?.role || '') === 'user';
}

function _isConversationTurnVisibleAssistantRecord(record: any): boolean {
  if (!record || record.deleted_at || record.dispatch) return false;
  const role = String(record.from || record.role || '');
  return role !== 'user';
}

interface ConversationTurnIndexScanOptions {
  start?: number;
  end?: number;
  seed?: ConversationTurnIndexFile;
}

interface ConversationTurnIndexScanResult {
  turns: ConversationTurnIndexEntry[];
  recordCount: number;
}

async function _scanConversationTurnIndex(
  file: string,
  options: ConversationTurnIndexScanOptions = {},
): Promise<ConversationTurnIndexScanResult> {
  let stream: fs.ReadStream | null = null;
  let lines: readline.Interface | null = null;
  const turns = options.seed
    ? options.seed.turns.map((turn) => ({ ...turn }))
    : [];
  let current: ConversationTurnIndexEntry | null = turns.pop() ?? null;
  let recordIndex = options.seed?.recordCount ?? 0;
  let malformedRecordReported = false;
  try {
    const start = Math.max(0, Math.floor(Number(options.start) || 0));
    const requestedEnd = Number(options.end);
    stream = fs.createReadStream(file, {
      encoding: 'utf8',
      ...(start > 0 ? { start } : {}),
      ...(Number.isSafeInteger(requestedEnd) && requestedEnd >= start
        ? { end: requestedEnd }
        : {}),
    });
    lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: any;
      try { record = JSON.parse(trimmed); } catch (err) {
        if (!malformedRecordReported) {
          malformedRecordReported = true;
          log.warn('conversation turn index skipped malformed records', {
            file: logPathRef(file),
            error: logErrorSummary(err),
          });
        }
        continue;
      }
      const sourceIndex = recordIndex;
      recordIndex += 1;
      if (!record || record.deleted_at) continue;
      if (_isConversationTurnUserRecord(record)) {
        if (current) turns.push(current);
        current = {
          messageId: typeof record.id === 'string' ? record.id : '',
          clientMessageId: typeof record.client_msg_id === 'string' ? record.client_msg_id : '',
          messageIndex: sourceIndex,
          userPreview: _truncateConversationTurnPreview(
            _conversationTurnPreviewText(_messageText(record)),
            CONVERSATION_TURN_USER_PREVIEW_CHARS,
          ),
          assistantPreview: '',
        };
        continue;
      }
      if (!current || !_isConversationTurnVisibleAssistantRecord(record)) continue;
      const reply = _conversationTurnPreviewText(_messageText(record));
      if (!reply) continue;
      const combined = current.assistantPreview
        ? `${current.assistantPreview} · ${reply}`
        : reply;
      current.assistantPreview = _truncateConversationTurnPreview(
        combined,
        CONVERSATION_TURN_ASSISTANT_PREVIEW_CHARS,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  } finally {
    lines?.close();
    stream?.destroy();
  }
  if (current) turns.push(current);
  return { turns, recordCount: recordIndex };
}

function _isConversationTurnIndexFile(value: any): value is ConversationTurnIndexFile {
  return value?.version === CONVERSATION_TURN_INDEX_VERSION
    && value.source && typeof value.source === 'object'
    && Number.isSafeInteger(value.recordCount) && value.recordCount >= 0
    && typeof value.tailHash === 'string' && /^[a-f0-9]{64}$/.test(value.tailHash)
    && Array.isArray(value.turns)
    && value.turns.every((turn: any) => (
      turn && typeof turn === 'object'
      && typeof turn.messageId === 'string'
      && typeof turn.clientMessageId === 'string'
      && Number.isSafeInteger(turn.messageIndex) && turn.messageIndex >= 0
      && typeof turn.userPreview === 'string'
      && typeof turn.assistantPreview === 'string'
    ));
}

async function _conversationTurnTailFingerprint(
  file: string,
  endExclusive: number,
): Promise<{ hash: string; endsWithNewline: boolean }> {
  const end = Math.max(0, Math.floor(Number(endExclusive) || 0));
  if (end === 0) {
    return {
      hash: createHash('sha256').update('').digest('hex'),
      endsWithNewline: true,
    };
  }
  const handle = await fsp.open(file, 'r');
  try {
    const start = Math.max(0, end - CONVERSATION_TURN_FINGERPRINT_BYTES);
    const buffer = Buffer.allocUnsafe(end - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const tail = buffer.subarray(0, bytesRead);
    return {
      hash: createHash('sha256').update(tail).digest('hex'),
      endsWithNewline: tail.length > 0 && tail[tail.length - 1] === 0x0a,
    };
  } finally {
    await handle.close();
  }
}

function _canExtendConversationTurnIndex(
  index: ConversationTurnIndexFile,
  source: ConversationTurnIndexSource,
): boolean {
  return index.source.owner === source.owner
    && index.source.ino > 0
    && index.source.ino === source.ino
    && index.source.size >= 0
    && source.size > index.source.size;
}

async function _extendConversationTurnIndex(
  userId: string,
  cid: string,
  file: string,
  base: ConversationTurnIndexFile,
  source: ConversationTurnIndexSource,
  projectIdHint?: string | null,
): Promise<ConversationTurnIndexFile | null> {
  const startedAt = Date.now();
  const previousTail = await _conversationTurnTailFingerprint(file, base.source.size);
  // Same inode + a larger size normally means append. Verify the old tail as
  // well so ordinary in-place truncate/rewrite paths are not mistaken for one.
  if (previousTail.hash !== base.tailHash || !previousTail.endsWithNewline) return null;

  const scan = await _scanConversationTurnIndex(file, {
    start: base.source.size,
    end: source.size - 1,
    seed: base,
  });
  const sourceAfter = await _conversationTurnSource(file, projectIdHint);
  if (!_sameConversationTurnSource(source, sourceAfter)) return null;
  const tail = await _conversationTurnTailFingerprint(file, sourceAfter.size);
  const sourceVerified = await _conversationTurnSource(file, projectIdHint);
  if (!_sameConversationTurnSource(sourceAfter, sourceVerified) || !tail.endsWithNewline) return null;

  const index: ConversationTurnIndexFile = {
    version: CONVERSATION_TURN_INDEX_VERSION,
    source: sourceVerified,
    recordCount: scan.recordCount,
    tailHash: tail.hash,
    turns: scan.turns,
  };
  await writeJson(userConversationTurnIndexPath(userId, cid), index);
  _rememberConversationTurnIndex(_conversationTurnIndexKey(userId, cid), index);
  log.info('conversation turn index extended', {
    cid: maskId(cid),
    ms: Date.now() - startedAt,
    appended_bytes: sourceVerified.size - base.source.size,
    records: index.recordCount - base.recordCount,
    turns: index.turns.length,
  });
  return index;
}

async function _buildConversationTurnIndex(
  userId: string,
  cid: string,
  file: string,
  projectIdHint?: string | null,
): Promise<ConversationTurnIndexFile> {
  const startedAt = Date.now();
  // A sync pull or live append can move the source while the lazy legacy scan
  // is running. Retry once so the atomically-published index describes one
  // coherent file revision rather than a mixed snapshot.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const sourceBefore = await _conversationTurnSource(file, projectIdHint);
    const scan = await _scanConversationTurnIndex(file);
    const sourceAfter = await _conversationTurnSource(file, projectIdHint);
    if (!_sameConversationTurnSource(sourceBefore, sourceAfter)) {
      if (attempt === 0) continue;
      throw new Error('conversation turn index source did not stabilize');
    }
    const tail = await _conversationTurnTailFingerprint(file, sourceAfter.size);
    const sourceVerified = await _conversationTurnSource(file, projectIdHint);
    if (!_sameConversationTurnSource(sourceAfter, sourceVerified)) {
      if (attempt === 0) continue;
      throw new Error('conversation turn index source did not stabilize');
    }
    const index: ConversationTurnIndexFile = {
      version: CONVERSATION_TURN_INDEX_VERSION,
      source: sourceVerified,
      recordCount: scan.recordCount,
      tailHash: tail.hash,
      turns: scan.turns,
    };
    if (!sourceVerified.ino && !sourceVerified.size) return index;
    await writeJson(userConversationTurnIndexPath(userId, cid), index);
    _rememberConversationTurnIndex(_conversationTurnIndexKey(userId, cid), index);
    log.info('conversation turn index rebuilt', {
      cid: maskId(cid),
      ms: Date.now() - startedAt,
      bytes: sourceVerified.size,
      records: index.recordCount,
      turns: index.turns.length,
    });
    return index;
  }
  throw new Error('conversation turn index source did not stabilize');
}

async function _getConversationTurnIndex(
  userId: string,
  cid: string,
  sourceFile: string,
  projectIdHint?: string | null,
): Promise<ConversationTurnIndexFile> {
  const key = _conversationTurnIndexKey(userId, cid);
  const source = await _conversationTurnSource(sourceFile, projectIdHint);
  const memory = _conversationTurnIndexMemory.get(key);
  if (_isConversationTurnIndexFile(memory)
      && _sameConversationTurnSource(memory.source, source)) {
    _rememberConversationTurnIndex(key, memory);
    return memory;
  }

  const persisted = await readJson<ConversationTurnIndexFile>(
    userConversationTurnIndexPath(userId, cid),
  );
  if (_isConversationTurnIndexFile(persisted)
      && _sameConversationTurnSource(persisted.source, source)) {
    _rememberConversationTurnIndex(key, persisted);
    return persisted;
  }

  const existingBuild = _conversationTurnIndexBuilds.get(key);
  if (existingBuild) return existingBuild;
  const appendBase = [memory, persisted]
    .filter(_isConversationTurnIndexFile)
    .filter((index) => _canExtendConversationTurnIndex(index, source))
    .sort((left, right) => right.source.size - left.source.size)[0];
  const build = (async () => {
    if (appendBase) {
      const extended = await _extendConversationTurnIndex(
        userId, cid, sourceFile, appendBase, source, projectIdHint,
      );
      if (extended) return extended;
    }
    return _buildConversationTurnIndex(userId, cid, sourceFile, projectIdHint);
  })();
  _conversationTurnIndexBuilds.set(key, build);
  try {
    return await build;
  } finally {
    if (_conversationTurnIndexBuilds.get(key) === build) {
      _conversationTurnIndexBuilds.delete(key);
    }
  }
}

/** Return one newest-tail page of compact user-turn navigation entries. */
export async function readConversationTurnPage(
  userId: string,
  cid: string,
  sourceFile: string,
  before?: number | null,
  projectIdHint?: string | null,
): Promise<ConversationTurnPage> {
  const index = await _getConversationTurnIndex(userId, cid, sourceFile, projectIdHint);
  const total = index.turns.length;
  const requestedEnd = Number(before);
  const end = Number.isSafeInteger(requestedEnd) && requestedEnd >= 0
    ? Math.min(requestedEnd, total)
    : total;
  const start = Math.max(0, end - CONVERSATION_TURN_PAGE_SIZE);
  return {
    turns: index.turns.slice(start, end).map((turn, offset) => ({
      ...turn,
      turnNo: start + offset + 1,
    })),
    total,
    nextCursor: start > 0 ? start : null,
    pageSize: CONVERSATION_TURN_PAGE_SIZE,
  };
}

export async function purgeConversationTurnIndex(userId: string, cid: string): Promise<void> {
  const key = _conversationTurnIndexKey(userId, cid);
  _conversationTurnIndexMemory.delete(key);
  _conversationTurnIndexBuilds.delete(key);
  try {
    await fsp.unlink(userConversationTurnIndexPath(userId, cid));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('conversation turn index purge failed', {
        user_id: maskId(userId),
        cid: maskId(cid),
        error: logErrorSummary(err),
      });
    }
  }
}
