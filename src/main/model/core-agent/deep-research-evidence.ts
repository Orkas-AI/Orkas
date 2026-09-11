import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ToolResult } from '#core-agent';

export const DEEP_RESEARCH_SKILL_ID = 'ee99fbb42964';
export const DEEP_RESEARCH_EVIDENCE_STATE_KEY = 'deepResearchEvidenceFile';
export const DEEP_RESEARCH_EVIDENCE_ENV = 'ORKAS_DEEP_RESEARCH_EVIDENCE_FILE';
export const DEEP_RESEARCH_EVIDENCE_FILENAME = 'deep-research-source-snapshots.jsonl';

const MAX_CAPTURE_CHARS = 12_500;
// Mirrors the skill's `_MAX_TRUSTED_SNAPSHOT_BYTES`: past this size the
// verifier discards EVERY snapshot, so an unbounded per-conversation file
// silently turned all citations into model-retyped text. Keep the newest
// rows that fit and never store the same source snapshot twice.
export const MAX_EVIDENCE_FILE_BYTES = 4 * 1024 * 1024;
const CACHE_REPLAY_RE = /^(?:WEB_FETCH_RUN_CACHE_HIT|GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT):/;
const SOURCE_URL_RE = /^URL:\s*(https?:\/\/\S+)\s*$/mi;

export type DeepResearchEvidenceCapture = {
  captured: boolean;
  reason?: 'not_web_source' | 'cache_replay' | 'duplicate' | 'io_error';
  errorType?: string;
};

/** Per-file dedupe index. Every successful web_fetch used to read the whole
 *  evidence file (up to 4 MiB) and JSON.parse each row just to check one
 *  key; the index is rebuilt when the file identity, size or timestamps no longer
 *  matches what this process last saw, so a crash-trimmed or externally
 *  rewritten file is still honored. */
type EvidenceIndex = { signature: string; keys: Set<string>; bytes: number };
const evidenceIndexByFile = new Map<string, EvidenceIndex>();

function statEvidenceFile(evidenceFile: string): string | null {
  try {
    const stat = fs.statSync(evidenceFile);
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function loadEvidenceIndex(evidenceFile: string): EvidenceIndex {
  const stat = statEvidenceFile(evidenceFile);
  if (!stat) {
    evidenceIndexByFile.delete(evidenceFile);
    return { signature: '', keys: new Set(), bytes: 0 };
  }
  const cached = evidenceIndexByFile.get(evidenceFile);
  if (cached && cached.signature === stat) return cached;
  const rows = existingEvidenceRows(evidenceFile);
  const keys = new Set<string>();
  let bytes = 0;
  for (const line of rows) {
    const key = evidenceRowKey(line);
    if (key) keys.add(key);
    bytes += Buffer.byteLength(line, 'utf8') + 1;
  }
  const index: EvidenceIndex = { signature: stat, keys, bytes };
  evidenceIndexByFile.set(evidenceFile, index);
  return index;
}

function rememberEvidenceIndex(evidenceFile: string, keys: Set<string>, bytes: number): void {
  const stat = statEvidenceFile(evidenceFile);
  if (!stat) {
    evidenceIndexByFile.delete(evidenceFile);
    return;
  }
  evidenceIndexByFile.set(evidenceFile, { signature: stat, keys, bytes });
}

export function _resetDeepResearchEvidenceIndexForTest(): void {
  evidenceIndexByFile.clear();
}

function existingEvidenceRows(evidenceFile: string): string[] {
  let raw = '';
  try { raw = fs.readFileSync(evidenceFile, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

function evidenceRowKey(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as { canonical_url?: unknown; content_sha256?: unknown };
    if (typeof parsed?.canonical_url !== 'string' || typeof parsed?.content_sha256 !== 'string') return null;
    return `${parsed.canonical_url}\u0000${parsed.content_sha256}`;
  } catch {
    return null;
  }
}

function normalizeSourceUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = '';
  return parsed.toString();
}

export function deepResearchEvidenceFile(toolResultsDir: string): string {
  return path.join(toolResultsDir, DEEP_RESEARCH_EVIDENCE_FILENAME);
}

/** Persist the exact successful web_fetch result before model-authored claims.
 *
 * The file stays inside the existing session Result Store and is exposed only
 * to bound Skill subprocesses through a host-owned environment value. Invalid
 * or partial trailing JSONL rows are ignored by the verifier after a crash.
 */
export function captureDeepResearchWebFetchEvidence(
  result: ToolResult,
  evidenceFile: string,
  capturedAt = new Date().toISOString(),
): DeepResearchEvidenceCapture {
  const content = String(result.content || '');
  if (result.isError || !content) return { captured: false, reason: 'not_web_source' };
  if (CACHE_REPLAY_RE.test(content)) return { captured: false, reason: 'cache_replay' };
  const match = SOURCE_URL_RE.exec(content);
  if (!match) return { captured: false, reason: 'not_web_source' };

  let canonicalUrl = '';
  try {
    canonicalUrl = normalizeSourceUrl(match[1]);
  } catch {
    return { captured: false, reason: 'not_web_source' };
  }
  const text = content.slice(0, MAX_CAPTURE_CHARS);
  const row = {
    schema_version: 1,
    canonical_url: canonicalUrl,
    captured_at: capturedAt,
    content_sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    text,
  };
  try {
    fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
    const serialized = `${JSON.stringify(row)}\n`;
    const rowBytes = Buffer.byteLength(serialized, 'utf8');
    const index = loadEvidenceIndex(evidenceFile);
    const key = `${row.canonical_url}\u0000${row.content_sha256}`;
    if (index.keys.has(key)) {
      return { captured: false, reason: 'duplicate' };
    }
    if (index.bytes + rowBytes > MAX_EVIDENCE_FILE_BYTES) {
      // Drop the oldest rows until the new one fits; the file is rewritten
      // atomically so a crash never leaves a torn newest row behind. This is
      // the one path that still reads the rows, and it rebuilds the index.
      const existing = existingEvidenceRows(evidenceFile);
      let budget = MAX_EVIDENCE_FILE_BYTES - rowBytes;
      const kept: string[] = [];
      for (let i = existing.length - 1; i >= 0 && budget > 0; i -= 1) {
        const bytes = Buffer.byteLength(existing[i], 'utf8') + 1;
        if (bytes > budget) break;
        kept.unshift(existing[i]);
        budget -= bytes;
      }
      const tmp = `${evidenceFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${kept.join('\n')}${kept.length ? '\n' : ''}${serialized}`, 'utf8');
      fs.renameSync(tmp, evidenceFile);
      const keys = new Set<string>();
      let bytes = 0;
      for (const line of kept) {
        const keptKey = evidenceRowKey(line);
        if (keptKey) keys.add(keptKey);
        bytes += Buffer.byteLength(line, 'utf8') + 1;
      }
      keys.add(key);
      rememberEvidenceIndex(evidenceFile, keys, bytes + rowBytes);
      return { captured: true };
    }
    fs.appendFileSync(evidenceFile, serialized, 'utf8');
    index.keys.add(key);
    rememberEvidenceIndex(evidenceFile, index.keys, index.bytes + rowBytes);
    return { captured: true };
  } catch (error) {
    return {
      captured: false,
      reason: 'io_error',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    };
  }
}
