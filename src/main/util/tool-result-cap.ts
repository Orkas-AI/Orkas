/**
 * Tool-result inline budget + durable oversized-output persistence.
 *
 * AgentRunner calls `capToolResult` at its final successful-result boundary,
 * covering builtins, host tools, and late-added evolution tools uniformly.
 * `wrapToolWithCap` remains available for standalone callers and tests. Results
 * within the token budget pass through. Larger results are always persisted
 * losslessly and replaced with a bounded preview plus a stable result reference.
 * Retrieval goes through the dedicated
 * `tool_result_search` / `tool_result_read_chunk` tools so a persisted result
 * can never be pulled back into context as one unbounded read.
 *
 * Budgets are token-aware (including CJK) rather than fixed character counts.
 *
 * Pure-function util: Node stdlib only, never imports features/ or model/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { StringDecoder } from 'string_decoder';
import type { AgentTool, ToolResult, ToolContext } from '#core-agent';
import { createLogger } from '../logger';
import { logErrorRef, logPathRef, maskId } from './log-redact';

const log = createLogger('util/tool-result-cap');

// ── Config ───────────────────────────────────────────────────────────────

/** One simple default for original tool results. Results above this estimated
 * token count are persisted losslessly; smaller results may still spill when
 * the shared per-model-step inline ledger is exhausted. Persisted-result
 * retrieval tools retain their own stricter 2K/4K limits. */
export const DEFAULT_INLINE_RESULT_TOKENS = 8_000;

/** `AgentRunner` creates one of these ledgers for every model tool-use step.
 * The result transformer consumes it synchronously after each tool completes,
 * so even parallel tool calls cannot inline more than the round allowance. */
export const TOOL_RESULT_INLINE_LEDGER_STATE_KEY = 'toolResultInlineLedger';

export type ToolResultInlineLedger = {
  initialTokens: number;
  remainingTokens: number;
};

/** Backward-compatible ASCII-sized threshold used by CLI tests/callers. The
 * actual spill decision is token-aware through `estimateToolResultTokens`. */
export const PERSIST_THRESHOLD = DEFAULT_INLINE_RESULT_TOKENS * 4;

export const PERSISTED_PREVIEW_TOKENS = 600;
/** New refs retain the full SHA-256 digest. The reader still accepts legacy
 *  16-hex refs so existing persisted markers remain usable. */
export const TOOL_RESULT_REF_HASH_HEX = 64;
/** Machine-local CLI/local-agent result cache budget. Resumable core-agent
 *  result directories follow their conversation lifecycle instead. */
export const DEFAULT_LOCAL_TOOL_RESULTS_MAX_BYTES = 1024 * 1024 * 1024;

// ── Wrapping ─────────────────────────────────────────────────────────────

export interface WrapOpts {
  /** Estimated-token budget allowed inline for this tool. */
  maxInlineTokens: number;
  /** Spill directory (local for CLI/local-agent; cloud-adjacent for resumable core-agent sessions).
   *  The decorator does not care about uid / sessionId; the caller assembles
   *  the path and passes it in. The directory is mkdir'd on demand, not
   *  required to exist beforehand. */
  toolResultsDir: string;
}

/** Apply the result policy after any tool has executed. Kept separate from the
 * decorator so AgentRunner can transform its own late-added tools (notably
 * skill_manage) at the final execution boundary as well. */
export function capToolResult(
  toolName: string,
  result: ToolResult,
  ctx: ToolContext,
  opts: WrapOpts,
): ToolResult {
  if (result.streamedOutput) {
    const { streamedOutput, ...resultWithoutStreamPath } = result;
    const sid = path.basename(opts.toolResultsDir);
    try {
      const persisted = persistStreamedToolResult(
        opts.toolResultsDir,
        toolName,
        streamedOutput.path,
      );
      log.info('streamed tool result adopted', {
        tool: toolName,
        session_id: maskId(sid),
        size: persisted.chars,
        size_bytes: persisted.bytes,
        estimated_tokens: persisted.estimatedTokens,
        source_truncated: !!streamedOutput.sourceTruncated,
        is_error: !!result.isError,
        path: logPathRef(persisted.path),
      });
      return {
        ...resultWithoutStreamPath,
        content: buildPersistedOutputMarkerFromPreview(
          persisted.path,
          toolName,
          result.content,
          {
            sizeChars: persisted.chars,
            estimatedTokens: persisted.estimatedTokens,
            isError: !!result.isError,
            sourceTruncated: !!streamedOutput.sourceTruncated,
          },
        ),
        persistedOutput: {
          path: persisted.path,
          size: persisted.chars,
          ref: toolResultRefForPath(persisted.path),
        },
      };
    } catch (err) {
      log.warn('streamed tool result adoption failed; returning bounded preview', {
        tool: toolName,
        session_id: maskId(sid),
        size_bytes: streamedOutput.size,
        error: logErrorRef(err),
      });
      return {
        ...resultWithoutStreamPath,
        content:
          buildBoundedPreview(result.content, PERSISTED_PREVIEW_TOKENS) +
          '\n\n[ERROR: streamed output adoption failed; the full output was not preserved. Retry with a narrower command or query.]',
        isError: true,
      };
    }
  }

  const content = result.content || '';
  const len = content.length;
  const estimatedTokens = estimateToolResultTokens(content);
  const exceedsPerResultBudget = estimatedTokens > opts.maxInlineTokens;
  const exceedsRoundBudget = !exceedsPerResultBudget && !claimRoundInlineBudget(ctx, estimatedTokens);
  if (!exceedsPerResultBudget && !exceedsRoundBudget) return result;

  const sid = path.basename(opts.toolResultsDir);
  try {
    const absPath = persistToolResult(opts.toolResultsDir, toolName, content);
    log.info('tool result persisted', {
      tool: toolName,
      session_id: maskId(sid),
      size: len,
      estimated_tokens: estimatedTokens,
      inline_budget_tokens: opts.maxInlineTokens,
      spill_reason: exceedsPerResultBudget ? 'per_result_limit' : 'round_limit',
      is_error: !!result.isError,
      path: logPathRef(absPath),
    });
    return {
      ...result,
      content: buildPersistedOutputMarker(absPath, toolName, content, result.isError),
      persistedOutput: {
        path: absPath,
        size: content.length,
        ref: toolResultRefForPath(absPath),
      },
    };
  } catch (err) {
    log.warn('tool result persist failed; falling back to bounded preview', {
      tool: toolName,
      session_id: maskId(sid),
      size: len,
      error: logErrorRef(err),
    });
    return {
      ...result,
      content:
        buildBoundedPreview(content, PERSISTED_PREVIEW_TOKENS) +
        '\n\n[ERROR: oversized output persistence failed; the full output was not preserved. Retry with a narrower command or query.]',
      isError: true,
    };
  }
}

export function wrapToolWithCap(tool: AgentTool, opts: WrapOpts): AgentTool {
  if (!Number.isFinite(opts.maxInlineTokens)) return tool;

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    // Preserve the concurrency flag — without this the wrapper silently makes
    // EVERY capped tool sequential (the runner's G4 partitioner keys on
    // `executionMode === 'parallel'`), defeating parallel reads/search AND
    // concurrent dispatch (run_worker / dispatch_to). This now also matters for
    // read_file / kb_read: they used to be returned unwrapped (Infinity) and
    // kept their parallel mode natively, but now flow through this wrapper, so
    // their executionMode must be carried over here.
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const result = await tool.execute(input, ctx);
      return capToolResult(tool.name, result, ctx, opts);
    },
  };
}

function claimRoundInlineBudget(ctx: ToolContext, estimatedTokens: number): boolean {
  const value = ctx.state[TOOL_RESULT_INLINE_LEDGER_STATE_KEY];
  if (!value || typeof value !== 'object') return true;
  const ledger = value as Partial<ToolResultInlineLedger>;
  if (!Number.isFinite(ledger.remainingTokens)) return true;
  const remaining = Math.max(0, Math.floor(ledger.remainingTokens!));
  if (estimatedTokens > remaining) return false;
  ledger.remainingTokens = remaining - estimatedTokens;
  return true;
}

// ── Core helpers ─────────────────────────────────────────────────────────

export function estimateToolResultTokens(text: string): number {
  const { cjk, other } = countTokenCharacters(text);
  return Math.ceil(cjk * 1.5 + other / 4);
}

function countTokenCharacters(text: string): { cjk: number; other: number } {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0x3000 && code <= 0x303F) ||
      (code >= 0x3040 && code <= 0x30FF) ||
      (code >= 0xFF00 && code <= 0xFFEF) ||
      (code >= 0xAC00 && code <= 0xD7AF)
    ) cjk++;
    else other++;
  }
  return { cjk, other };
}

export function persistToolResult(
  toolResultsDir: string,
  toolName: string,
  content: string,
): string {
  fs.mkdirSync(toolResultsDir, { recursive: true });
  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48) || 'tool';
  const id = createHash('sha256')
    .update(toolName)
    .update('\0')
    .update(content)
    .digest('hex')
    .slice(0, TOOL_RESULT_REF_HASH_HEX);
  const abs = path.join(toolResultsDir, `${safeTool}.${id}.txt`);
  if (fs.existsSync(abs)) return abs;
  const tmp = `${abs}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, abs);
  } catch (err) {
    if (fs.existsSync(abs)) {
      try { fs.unlinkSync(tmp); } catch { /* another writer won */ }
      return abs;
    }
    try { fs.unlinkSync(tmp); } catch { /* best-effort partial temp cleanup */ }
    throw err;
  }
  return abs;
}

export function persistStreamedToolResult(
  toolResultsDir: string,
  toolName: string,
  sourcePath: string,
): { path: string; bytes: number; chars: number; estimatedTokens: number } {
  fs.mkdirSync(toolResultsDir, { recursive: true });
  const root = fs.realpathSync(path.resolve(toolResultsDir));
  const source = fs.realpathSync(path.resolve(sourcePath));
  if (!isInsideRoot(root, source)) {
    throw new Error('streamed output is outside the active Result Store');
  }
  const st = fs.statSync(source);
  if (!st.isFile()) throw new Error('streamed output is not a regular file');

  const hash = createHash('sha256').update(toolName).update('\0');
  const decoder = new StringDecoder('utf8');
  const fd = fs.openSync(source, 'r');
  const buf = Buffer.allocUnsafe(64 * 1024);
  let bytes = 0;
  let chars = 0;
  let cjk = 0;
  let other = 0;
  const countDecoded = (text: string) => {
    chars += text.length;
    const counts = countTokenCharacters(text);
    cjk += counts.cjk;
    other += counts.other;
  };
  try {
    while (true) {
      const read = fs.readSync(fd, buf, 0, buf.length, null);
      if (!read) break;
      const chunk = buf.subarray(0, read);
      bytes += read;
      hash.update(chunk);
      countDecoded(decoder.write(chunk));
    }
    countDecoded(decoder.end());
  } finally {
    fs.closeSync(fd);
  }

  const safeTool = toolName.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48) || 'tool';
  const id = hash.digest('hex').slice(0, TOOL_RESULT_REF_HASH_HEX);
  const abs = path.join(root, `${safeTool}.${id}.txt`);
  if (path.resolve(source) !== path.resolve(abs)) {
    if (fs.existsSync(abs)) {
      fs.unlinkSync(source);
    } else {
      try { fs.renameSync(source, abs); }
      catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // Parallel identical results can race between existsSync and rename.
        // The content address guarantees an existing destination is the same
        // payload, so the losing writer only needs to remove its temp file.
        if (fs.existsSync(abs)) {
          fs.unlinkSync(source);
        } else if (code === 'EXDEV') {
          try { fs.copyFileSync(source, abs, fs.constants.COPYFILE_EXCL); }
          catch (copyErr) {
            if (!fs.existsSync(abs)) throw copyErr;
          }
          fs.unlinkSync(source);
        } else {
          throw err;
        }
      }
    }
  }
  return {
    path: abs,
    bytes,
    chars,
    estimatedTokens: Math.ceil(cjk * 1.5 + other / 4),
  };
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

export function toolResultRefForPath(absPath: string): string {
  return path.basename(absPath).replace(/\.txt$/i, '');
}

/** Spill a CLI tool-event's full output to disk when it exceeds its estimated
 *  token budget. Mirrors the in-process tool spill policy so an oversized bash
 *  output looks the same to the renderer regardless of whether it came from `wrapToolWithCap`
 *  (in-process tools) or a CLI subprocess's tool-event.
 *
 *  Used by `local_agents/runner.ts` to wrap each `tool-event
 *  phase:'result'` before forwarding to the renderer. Backends stay
 *  unaware of the spill mechanism — they always emit the full output.
 *
 *  Returns the rewritten `{output, outputPath}`. When below threshold,
 *  `outputPath` is undefined and `output` is the original content
 *  unchanged. */
export function maybeSpillToolResult(opts: {
  toolResultsDir: string;
  toolName: string;
  callId: string;
  output: string;
  maxInlineTokens?: number;
}): { output: string; outputPath?: string } {
  const { toolResultsDir, toolName, output } = opts;
  const maxInlineTokens = opts.maxInlineTokens ?? DEFAULT_INLINE_RESULT_TOKENS;
  if (!output || estimateToolResultTokens(output) <= maxInlineTokens) {
    return { output };
  }
  try {
    const abs = persistToolResult(toolResultsDir, toolName, output);
    log.info('cli tool result spilled', {
      tool: toolName,
      session_id: maskId(path.basename(toolResultsDir)),
      size: output.length,
      path: logPathRef(abs),
    });
    // Same preview shape as the in-process path so the renderer's
    // click-to-expand logic works identically.
    return {
      output: buildPersistedOutputMarker(abs, toolName, output),
      outputPath: abs,
    };
  } catch (err) {
    // Disk-write failure: surface a bounded preview rather than the
    // full payload so we don't blow up the event stream.
    log.warn('cli tool spill failed; falling back to bounded preview', {
      tool: toolName,
      error: logErrorRef(err),
    });
    return {
      output: `${buildBoundedPreview(output, PERSISTED_PREVIEW_TOKENS)}\n\n[ERROR: oversized output spill failed; the full output was not preserved.]`,
    };
  }
}

export function buildPersistedOutputMarker(
  absPath: string,
  toolName: string,
  content: string,
  isError = false,
): string {
  return buildPersistedOutputMarkerFromPreview(absPath, toolName, content, {
    sizeChars: content.length,
    estimatedTokens: estimateToolResultTokens(content),
    isError,
    sourceTruncated: false,
  });
}

export function buildPersistedOutputMarkerFromPreview(
  absPath: string,
  toolName: string,
  preview: string,
  meta: {
    sizeChars: number;
    estimatedTokens: number;
    isError: boolean;
    sourceTruncated: boolean;
  },
): string {
  const ref = toolResultRefForPath(absPath);
  const body = buildBoundedPreview(preview, PERSISTED_PREVIEW_TOKENS);
  const sourceWarning = meta.sourceTruncated
    ? '[WARNING: The producer exceeded its hard safety limit. The stored file is an incomplete prefix; do not treat it as a lossless full result.]\n'
    : '';
  return (
    `<persisted-output ref="${escapeAttr(ref)}" tool="${escapeAttr(toolName)}" size="${meta.sizeChars}" estimated_tokens="${meta.estimatedTokens}" status="${meta.isError ? 'error' : 'success'}" source_truncated="${meta.sourceTruncated ? 'true' : 'false'}">\n` +
    sourceWarning +
    `${body}\n` +
    `[Full content is stored under result ref ${ref}. Use tool_result_search(ref, query) first, or tool_result_read_chunk(ref, cursor, maxTokens) for an exact bounded slice. Do not use read_file on the stored path.]\n` +
    `</persisted-output>`
  );
}

export function buildBoundedPreview(content: string, maxTokens: number): string {
  if (estimateToolResultTokens(content) <= maxTokens) return content;
  const headBudget = Math.max(1, Math.floor(maxTokens * 0.72));
  const tailBudget = Math.max(1, maxTokens - headBudget);
  const head = prefixWithinTokenBudget(content, headBudget);
  const tail = suffixWithinTokenBudget(content.slice(head.length), tailBudget);
  const omittedChars = Math.max(0, content.length - head.length - tail.length);
  return `${head}\n\n... [${omittedChars} chars omitted; full result is stored] ...\n\n${tail}`;
}

function prefixWithinTokenBudget(text: string, maxTokens: number): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateToolResultTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

function suffixWithinTokenBudget(text: string, maxTokens: number): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateToolResultTokens(text.slice(text.length - mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(text.length - lo);
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Sweep ────────────────────────────────────────────────────────────────

export type ToolResultSweepStats = {
  removedStale: number;
  removedForQuota: number;
  retainedBytes: number;
};

/** Startup sweep for the machine-local Result Store. Deletes stale top-level
 *  session entries first, then evicts the oldest remaining entries until the
 *  total is within `maxTotalBytes`. Best-effort and symlink-safe: size scans do
 *  not follow symlinks outside the store. */
export function sweepToolResults(
  userToolResultsDir: string,
  maxAgeDays = 7,
  maxTotalBytes = DEFAULT_LOCAL_TOOL_RESULTS_MAX_BYTES,
): ToolResultSweepStats {
  const stats: ToolResultSweepStats = { removedStale: 0, removedForQuota: 0, retainedBytes: 0 };
  if (!fs.existsSync(userToolResultsDir)) return stats;
  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(userToolResultsDir, { withFileTypes: true });
  } catch { return stats; }
  const retained: Array<{ abs: string; isDirectory: boolean; mtimeMs: number; bytes: number }> = [];
  for (const ent of entries) {
    const abs = path.join(userToolResultsDir, ent.name);
    try {
      const st = fs.lstatSync(abs);
      if (st.mtimeMs < cutoffMs) {
        removeToolResultEntry(abs, ent.isDirectory());
        stats.removedStale++;
      } else {
        retained.push({
          abs,
          isDirectory: ent.isDirectory(),
          mtimeMs: st.mtimeMs,
          bytes: toolResultEntryBytes(abs),
        });
      }
    } catch { /* per-entry best-effort */ }
  }
  stats.retainedBytes = retained.reduce((sum, entry) => sum + entry.bytes, 0);
  const quota = Number.isFinite(maxTotalBytes) ? Math.max(0, Math.floor(maxTotalBytes)) : Infinity;
  if (stats.retainedBytes > quota) {
    retained.sort((a, b) => a.mtimeMs - b.mtimeMs || a.abs.localeCompare(b.abs));
    for (const entry of retained) {
      if (stats.retainedBytes <= quota) break;
      try {
        removeToolResultEntry(entry.abs, entry.isDirectory);
        stats.retainedBytes = Math.max(0, stats.retainedBytes - entry.bytes);
        stats.removedForQuota++;
      } catch { /* per-entry best-effort */ }
    }
  }
  if (stats.removedStale || stats.removedForQuota) log.info('swept tool-result entries', {
    removed_stale: stats.removedStale,
    removed_for_quota: stats.removedForQuota,
    retained_bytes: stats.retainedBytes,
    dir: logPathRef(userToolResultsDir),
    maxAgeDays,
    max_total_bytes: Number.isFinite(quota) ? quota : undefined,
  });
  return stats;
}

function toolResultEntryBytes(abs: string): number {
  let st: fs.Stats;
  try { st = fs.lstatSync(abs); }
  catch { return 0; }
  if (st.isSymbolicLink()) return st.size;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  let names: string[];
  try { names = fs.readdirSync(abs); }
  catch { return 0; }
  for (const name of names) total += toolResultEntryBytes(path.join(abs, name));
  return total;
}

function removeToolResultEntry(abs: string, isDirectory: boolean): void {
  if (isDirectory) fs.rmSync(abs, { recursive: true, force: true });
  else fs.unlinkSync(abs);
}
