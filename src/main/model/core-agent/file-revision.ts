/**
 * Run-scoped opaque revisions for exact file-content handoff between tools.
 *
 * Models should copy a revision token instead of translating read_file's
 * character offsets into write_file/append_file byte offsets. The token is an
 * opaque lookup key; the host retains the path, byte size, and content hash.
 * Tokens deliberately expire with the run, so a later run must read the file
 * again and cannot accidentally rely on stale process memory. Within a run they
 * must outlive a model round: the model has to see a read result before it can
 * form the append that quotes its revision, so those two calls always land in
 * different rounds and AgentRunner rebuilds ToolContext.state between them. The
 * tokens therefore live in the `runScopedLedger` map the runner injects by
 * reference, the same place web_fetch keeps its run cache.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ToolContext } from '#core-agent';

const FILE_REVISION_STATE_KEY = 'fileRevisionState';

export type FileRevisionRecord = {
  token: string;
  path: string;
  size: number;
  hash: string;
};

export type AppendReplayRecord = {
  baseRevision: string;
  contentHash: string;
  baseSize: number;
  appendedBytes: number;
  resultRevision: string;
  resultHash: string;
};

type FileRevisionState = {
  byToken: Map<string, FileRevisionRecord>;
  tokenByIdentity: Map<string, string>;
  appendReplayByInput: Map<string, AppendReplayRecord>;
};

function newState(): FileRevisionState {
  return {
    byToken: new Map(),
    tokenByIdentity: new Map(),
    appendReplayByInput: new Map(),
  };
}

function stateFor(ctx: ToolContext, create: boolean): FileRevisionState | null {
  // A few direct/legacy tool callers omit `state`; production runners always
  // provide one. Creating it here preserves the useful receipt for those
  // callers without weakening run scoping.
  const toolContext = ctx as ToolContext & { state?: Record<string, unknown> };
  if (!toolContext.state) {
    if (!create) return null;
    toolContext.state = {};
  }
  // Prefer the runner's run-scoped map. `state` itself is rebuilt after every
  // model round, so a token issued by read_file would otherwise be gone by the
  // time append_file quotes it — the read and the append can never share a
  // round. Keeping it on `state` alone made that handoff fail every time in
  // production while passing any test that reused one context object.
  const ledger = toolContext.state.runScopedLedger;
  if (ledger instanceof Map) {
    const shared = ledger.get(FILE_REVISION_STATE_KEY);
    if (shared && typeof shared === 'object') return shared as FileRevisionState;
    if (!create) return null;
    const created = newState();
    ledger.set(FILE_REVISION_STATE_KEY, created);
    return created;
  }
  const existing = toolContext.state[FILE_REVISION_STATE_KEY];
  if (existing && typeof existing === 'object') return existing as FileRevisionState;
  if (!create) return null;
  const created = newState();
  toolContext.state[FILE_REVISION_STATE_KEY] = created;
  return created;
}

function identityKey(abs: string, size: number, hash: string): string {
  return `${canonicalFileRevisionPath(abs)}\0${size}\0${hash}`;
}

function replayKey(baseRevision: string, contentHash: string): string {
  return `${baseRevision}\0${contentHash}`;
}

/** Resolve aliases/casing for an existing file while retaining a safe fallback
 * for a path that vanishes between a tool result and its revision receipt. */
export function canonicalFileRevisionPath(abs: string): string {
  try { return fs.realpathSync.native(abs); }
  catch { return path.resolve(abs); }
}

/** Return a stable token for the same path+size+hash within one run. */
export function issueFileRevision(
  ctx: ToolContext,
  abs: string,
  size: number,
  hash: string,
): string {
  const state = stateFor(ctx, true)!;
  const resolvedPath = canonicalFileRevisionPath(abs);
  const identity = identityKey(resolvedPath, size, hash);
  const existing = state.tokenByIdentity.get(identity);
  if (existing) return existing;
  const token = `file_rev_${crypto.randomBytes(12).toString('base64url')}`;
  state.byToken.set(token, { token, path: resolvedPath, size, hash });
  state.tokenByIdentity.set(identity, token);
  return token;
}

export function resolveFileRevision(
  ctx: ToolContext,
  token: string,
): FileRevisionRecord | null {
  return stateFor(ctx, false)?.byToken.get(token) ?? null;
}

export function recordAppendReplay(
  ctx: ToolContext,
  record: AppendReplayRecord,
): void {
  stateFor(ctx, true)!.appendReplayByInput.set(
    replayKey(record.baseRevision, record.contentHash),
    record,
  );
}

export function findAppendReplay(
  ctx: ToolContext,
  baseRevision: string,
  contentHash: string,
): AppendReplayRecord | null {
  return stateFor(ctx, false)?.appendReplayByInput.get(
    replayKey(baseRevision, contentHash),
  ) ?? null;
}
