import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ToolResult } from '#core-agent';

export const DEEP_RESEARCH_SKILL_ID = 'ee99fbb42964';
export const DEEP_RESEARCH_EVIDENCE_STATE_KEY = 'deepResearchEvidenceFile';
export const DEEP_RESEARCH_EVIDENCE_ENV = 'ORKAS_DEEP_RESEARCH_EVIDENCE_FILE';
export const DEEP_RESEARCH_EVIDENCE_FILENAME = 'deep-research-source-snapshots.jsonl';

const MAX_CAPTURE_CHARS = 12_500;
const CACHE_REPLAY_RE = /^(?:WEB_FETCH_RUN_CACHE_HIT|GITHUB_REPOSITORY_SNAPSHOT_CACHE_HIT):/;
const SOURCE_URL_RE = /^URL:\s*(https?:\/\/\S+)\s*$/mi;

export type DeepResearchEvidenceCapture = {
  captured: boolean;
  reason?: 'not_web_source' | 'cache_replay' | 'io_error';
  errorType?: string;
};

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
    fs.appendFileSync(evidenceFile, `${JSON.stringify(row)}\n`, 'utf8');
    return { captured: true };
  } catch (error) {
    return {
      captured: false,
      reason: 'io_error',
      errorType: error instanceof Error ? error.name : 'UnknownError',
    };
  }
}
