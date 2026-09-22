/**
 * Tool-result inline budget + durable oversized-output persistence.
 *
 * AgentRunner calls `capToolResult` at its final successful-result boundary,
 * covering builtins, host tools, and late-added evolution tools uniformly.
 * `wrapToolWithCap` remains available for standalone callers and tests. Results
 * within the token budget pass through. Larger results are always persisted
 * losslessly and replaced with a bounded preview plus a stable result reference.
 * Retrieval goes through the dedicated
 * `tool_result` tool so a persisted result
 * can never be pulled back into context as one unbounded read.
 *
 * Budgets are token-aware (including CJK) rather than fixed character counts.
 *
 * Pure-function util: Node stdlib only, never imports features/ or model/.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { StringDecoder } from 'node:string_decoder';
import type { AgentTool, ToolResult, ToolContext } from '#core-agent';
import { createLogger } from '../logger';
import {
  estimateBudgetTokenQuarters,
  type TokenBudgetScanState,
} from './token-estimate';
import { logErrorRef, logPathRef, maskId } from './log-redact';
import { describeToolResultData, type ToolResultDataDescriptor } from './tool-result-data';

const log = createLogger('util/tool-result-cap');

// ── Config ───────────────────────────────────────────────────────────────

/** One simple default for original tool results. Results above this estimated
 * token count are persisted losslessly; smaller results may still spill when
 * the shared per-model-step inline ledger is exhausted. Persisted-result
 * retrieval uses the same allowance and never persists another wrapper.
 *
 * Ordinary results use a fixed 10K allowance. AgentRunner supplies a separate
 * 25K ceiling for complete Skill documents; lowering this ordinary default
 * must not turn those document reads into partial previews. */
export const DEFAULT_INLINE_RESULT_TOKENS = 10_000;

/** `AgentRunner` creates one of these ledgers for every model tool-use step.
 * The result transformer consumes it synchronously after each tool completes,
 * so even parallel tool calls cannot inline more than the round allowance. */
export const TOOL_RESULT_INLINE_LEDGER_STATE_KEY = 'toolResultInlineLedger';

export type ToolResultInlineLedger = {
  initialTokens: number;
  remainingTokens: number;
  /** Fixed per-result ceiling supplied by the runner, independent of window
   *  size. Standalone callers may omit it and use `maxInlineTokens`. */
  perResultTokens?: number;
  /** Per-result ceiling for a document the model was told to read whole.
   *  This is also fixed; the shared round ledger still bounds admission. */
  verbatimDocumentTokens?: number;
};

/** Host-owned storage failure; never a request to re-execute the tool. */
export class ToolResultPersistenceError extends Error {
  readonly code = 'TOOL_RESULT_PERSISTENCE_FAILED';
  constructor() {
    super('The tool executed, but its complete output could not be saved. The task has stopped. Check available storage and write permissions before continuing.');
    this.name = 'ToolResultPersistenceError';
  }
}

const RESULT_SAVE_RETRY_DELAYS_MS = [200, 1_000, 3_000];

/** Retain the original result and retry storage only, with cancellable backoff.
 * No shared lock: other tasks and already-running tools continue normally. */
export async function capToolResultWithRetry(
  toolName: string, result: ToolResult, ctx: ToolContext, opts: WrapOpts,
): Promise<ToolResult> {
  for (let attempt = 0; ; attempt++) {
    ctx.signal?.throwIfAborted();
    try {
      return capToolResult(toolName, result, ctx, opts);
    } catch (err) {
      if (!(err instanceof ToolResultPersistenceError) || attempt >= RESULT_SAVE_RETRY_DELAYS_MS.length) throw err;
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, RESULT_SAVE_RETRY_DELAYS_MS[attempt]);
        ctx.signal?.addEventListener('abort', finish, { once: true });
        if (ctx.signal?.aborted) finish();
      });
    }
  }
}

const PERSISTED_PREVIEW_TOKENS = 600;
/** Head-only preview kept alongside a section map. Smaller than the plain
 *  head/tail preview because the outline already covers the rest of the
 *  document, and the two together should stay near the same total. */
const OUTLINE_HEAD_PREVIEW_TOKENS = 250;
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

/** Host-owned receipts cannot be forged through a tool payload. Reservations
 * happen synchronously before I/O; concurrent calls see only unreserved room.
 * The final transformer recognizes the exact result/ledger/content tuple and
 * does not charge it a second time. Nothing is serialized into conversation. */
const retrievalReceipts = new WeakMap<ToolResult, { ledger: unknown; content: string }>();
export const RETRIEVAL_OUTPUT_BUDGET_KEY = 'retrievalOutputBudget';

const retrievalQueues = new WeakMap<object, Promise<void>>();
export async function withRetrievalBudget(
  ctx: ToolContext,
  execute: (ctx: ToolContext, budget: number) => Promise<ToolResult>,
): Promise<ToolResult> {
  const ledger = ctx.state[TOOL_RESULT_INLINE_LEDGER_STATE_KEY];
  if (!ledger || typeof ledger !== 'object') return executeWithRetrievalBudget(ctx, execute);
  const previous = retrievalQueues.get(ledger) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  retrievalQueues.set(ledger, current);
  await previous;
  try {
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('Retrieval aborted.');
    return await executeWithRetrievalBudget(ctx, execute);
  } finally {
    release();
    if (retrievalQueues.get(ledger) === current) retrievalQueues.delete(ledger);
  }
}

async function executeWithRetrievalBudget(
  ctx: ToolContext,
  execute: (ctx: ToolContext, budget: number) => Promise<ToolResult>,
): Promise<ToolResult> {
  const ledger = ctx.state[TOOL_RESULT_INLINE_LEDGER_STATE_KEY] as ToolResultInlineLedger | undefined;
  const ceiling = Math.min(DEFAULT_INLINE_RESULT_TOKENS, ledger?.perResultTokens ?? DEFAULT_INLINE_RESULT_TOKENS);
  const reserved = Math.max(0, Math.floor(Math.min(ceiling, ledger?.remainingTokens ?? ceiling)));
  if (ledger) ledger.remainingTokens -= reserved;
  const previousReads = ctx.state.toolResultReadLedger as { epoch: number; readKeys: Set<string> } | undefined;
  const reads = { epoch: previousReads?.epoch ?? 0, remainingTokens: reserved,
    readKeys: new Set(previousReads?.readKeys ?? []) };
  const child = { ...ctx, state: { ...ctx.state, [RETRIEVAL_OUTPUT_BUDGET_KEY]: reserved,
    toolResultReadLedger: reads } };
  let used = 0;
  try {
    let result = reserved > 0 ? await execute(child, reserved) : { content: '', isError: true };
    if (ctx.signal?.aborted) throw ctx.signal.reason ?? new Error('Retrieval aborted.');
    if (estimateToolResultTokens(result.content) > reserved) {
      // Contract failure: do not publish partial source bytes or advance its
      // cursor. In particular, never turn this receipt into a persisted ref.
      result = { content: boundedRetrievalText('Retrieval output did not fit. No source data was delivered; retry the same source with a narrower range.', reserved), isError: true };
    } else if (previousReads) {
      for (const key of reads.readKeys) previousReads.readKeys.add(key);
    }
    used = estimateToolResultTokens(result.content);
    retrievalReceipts.set(result, { ledger, content: result.content });
    return result;
  } finally {
    if (ledger) ledger.remainingTokens += reserved - used;
  }
}

export function boundedRetrievalText(text: string, maxTokens: number): string {
  if (estimateToolResultTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateToolResultTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  // Never split a UTF-16 surrogate pair at the source cursor.
  if (lo > 0 && /[\uD800-\uDBFF]/.test(text[lo - 1])) lo--;
  return text.slice(0, lo);
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
  const receipt = retrievalReceipts.get(result);
  if (receipt && receipt.ledger === ctx.state[TOOL_RESULT_INLINE_LEDGER_STATE_KEY]
    && receipt.content === result.content && !result.streamedOutput) return result;
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
      log.warn('streamed tool result adoption failed', {
        tool: toolName,
        session_id: maskId(sid),
        size_bytes: streamedOutput.size,
        error: logErrorRef(err),
      });
      throw new ToolResultPersistenceError();
    }
  }

  const content = result.content || '';
  const len = content.length;
  const estimatedTokens = estimateToolResultTokens(content);
  const perResultBudget = resolvePerResultBudget(ctx, opts, !!result.verbatimDocument);
  const exceedsPerResultBudget = estimatedTokens > perResultBudget;
  const exceedsRoundBudget = !exceedsPerResultBudget && !claimRoundInlineBudget(ctx, estimatedTokens);
  if (!exceedsPerResultBudget && !exceedsRoundBudget) return result;
  // A result the persisted marker would carry whole (≤ preview budget) only
  // grows when wrapped: the marker repeats the content plus refs and hints and
  // is itself not charged to the ledger. Keep it inline unchanged.
  if (exceedsRoundBudget && estimatedTokens <= PERSISTED_PREVIEW_TOKENS) return result;

  const sid = path.basename(opts.toolResultsDir);
  try {
    const absPath = persistToolResult(opts.toolResultsDir, toolName, content);
    log.info('tool result persisted', {
      tool: toolName,
      session_id: maskId(sid),
      size: len,
      estimated_tokens: estimatedTokens,
      inline_budget_tokens: perResultBudget,
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
    log.warn('tool result persist failed', {
      tool: toolName,
      session_id: maskId(sid),
      size: len,
      error: logErrorRef(err),
    });
    throw new ToolResultPersistenceError();
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
    // read_files / library: they used to be returned unwrapped (Infinity) and
    // kept their parallel mode natively, but now flow through this wrapper, so
    // their executionMode must be carried over here.
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    // The per-call refinement travels with the mode: dropping it would turn a
    // read-only-only shell into an unconditional parallel one.
    ...(tool.parallelWhen ? { parallelWhen: tool.parallelWhen } : {}),
    async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const result = await tool.execute(input, ctx);
      return capToolResultWithRetry(tool.name, result, ctx, opts);
    },
  };
}

/** The ceiling this one result may inline under.
 *
 * The round ledger — not this number — is what protects the context window:
 * it is derived from real remaining headroom and falls to zero as the request
 * fills, and every result must claim from it regardless of what this returns.
 * The per-result ceiling is a fixed policy about ONE item. It is independent
 * of the checkpoint's raw-tail retention and summarization input budget.
 * Standalone callers without a runner ledger retain their explicit limit.
 */
function resolvePerResultBudget(
  ctx: ToolContext,
  opts: WrapOpts,
  verbatimDocument: boolean,
): number {
  const value = ctx.state[TOOL_RESULT_INLINE_LEDGER_STATE_KEY];
  const ledger = value && typeof value === 'object'
    ? value as Partial<ToolResultInlineLedger>
    : undefined;
  if (verbatimDocument) {
    const declared = ledger?.verbatimDocumentTokens;
    if (Number.isFinite(declared) && (declared as number) > 0) return declared as number;
    // Standalone callers retain their explicit limit.
    return opts.maxInlineTokens;
  }
  const declared = ledger?.perResultTokens;
  if (Number.isFinite(declared) && (declared as number) > 0) return declared as number;
  return opts.maxInlineTokens;
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

/** Must stay byte-for-byte equivalent to core-agent's
 * `session.ts::estimateTextTokens`: the same text is measured here at the
 * inline-cap boundary and there for every context-budget decision, so a
 * divergent count moves a result across the spill line on one side only.
 * A separate implementation exists there because `#core-agent` is
 * dynamic-import-only in main and this estimator is called synchronously;
 * the parity test in `test/main/util/tool-result-cap.test.ts` pins the two
 * together, non-BMP input included (both count UTF-16 units, not code
 * points — a surrogate pair is two "other" units).
 *
 * Conservative on purpose: an under-estimate here overflows a model window
 * and ends a run, while an over-estimate only spills a result sooner. */
export function estimateToolResultTokens(text: string): number {
  return Math.ceil(estimateBudgetTokenQuarters(text) / 4);
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
  let tokenQuarters = 0;
  const tokenState: TokenBudgetScanState = { digitRemainder: 0, inAsciiPunctuation: false };
  const countDecoded = (text: string) => {
    chars += text.length;
    tokenQuarters += estimateBudgetTokenQuarters(text, tokenState);
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
          const tmp = `${abs}.${process.pid}.copy.tmp`;
          try {
            fs.copyFileSync(source, tmp);
            fs.renameSync(tmp, abs);
          } catch (copyErr) {
            try { fs.unlinkSync(tmp); } catch { /* best-effort partial copy cleanup */ }
            throw copyErr;
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
    estimatedTokens: Math.ceil(tokenQuarters / 4),
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
 *  Returns the rewritten `{output, outputPath}`. Structured CLI results are
 *  measured and persisted as compact JSON, while below-threshold values keep
 *  their original shape. */
export function maybeSpillToolResult(opts: {
  toolResultsDir: string;
  toolName: string;
  callId: string;
  output: unknown;
  maxInlineTokens?: number;
}): { output: unknown; outputPath?: string } {
  const { toolResultsDir, toolName, output } = opts;
  const maxInlineTokens = opts.maxInlineTokens ?? DEFAULT_INLINE_RESULT_TOKENS;
  let serialized: string | undefined;
  try {
    serialized = typeof output === 'string' ? output : JSON.stringify(output);
  } catch {
    return { output: '[Unserializable tool result omitted.]' };
  }
  if (typeof serialized !== 'string') {
    return { output: '[Unsupported tool result omitted.]' };
  }
  if (!serialized || estimateToolResultTokens(serialized) <= maxInlineTokens) {
    return { output };
  }
  try {
    const abs = persistToolResult(toolResultsDir, toolName, serialized);
    log.info('cli tool result spilled', {
      tool: toolName,
      session_id: maskId(path.basename(toolResultsDir)),
      size: serialized.length,
      path: logPathRef(abs),
    });
    // Same preview shape as the in-process path so the renderer's
    // click-to-expand logic works identically.
    return {
      output: buildPersistedOutputMarker(abs, toolName, serialized),
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
      output: `${buildBoundedPreview(serialized, PERSISTED_PREVIEW_TOKENS)}\n\n[ERROR: oversized output spill failed; the full output was not preserved.]`,
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
  const completePreview = preview.length >= meta.sizeChars;
  // The outline needs the whole document to be honest about its offsets. The
  // streamed-adoption path passes a partial `preview` against the persisted
  // `sizeChars`, so only build one when we were handed the full text.
  const outline = completePreview ? buildStructureOutline(preview) : null;
  const dataDescriptor = completePreview ? describeToolResultData(preview) : null;
  const actions = dataDescriptor && dataDescriptor.reason !== 'input_too_large'
    ? 'query,search,read,materialize'
    : 'search,read,materialize';
  const dataSummary = dataDescriptor ? `${renderToolResultDataSummary(dataDescriptor)}\n` : '';
  const body = outline
    ? `${buildBoundedPreview(preview, OUTLINE_HEAD_PREVIEW_TOKENS)}\n\n`
      + `[Section map — @N is the 0-based char cursor for tool_result(action="read", requests=[{ref, cursor:N}])]\n`
      + outline
    : buildBoundedPreview(preview, PERSISTED_PREVIEW_TOKENS);
  const sourceWarning = meta.sourceTruncated
    ? '[WARNING: The producer exceeded its hard safety limit. The stored file is an incomplete prefix; do not treat it as a lossless full result.]\n'
    : '';
  // Tool definitions own invocation guidance. Keep each receipt independently
  // addressable without repeating that manual for every persisted result.
  const retrievalHint = `[Full content is stored under result ref ${ref}. Retrieve with tool_result.]`;
  return (
    `<persisted-output ref="${escapeAttr(ref)}" tool="${escapeAttr(toolName)}" size="${meta.sizeChars}" estimated_tokens="${meta.estimatedTokens}" status="${meta.isError ? 'error' : 'success'}" source_truncated="${meta.sourceTruncated ? 'true' : 'false'}" data_type="${dataDescriptor?.reason === 'input_too_large' ? 'unknown' : dataDescriptor?.kind || 'unknown'}" actions="${actions}">\n` +
    sourceWarning +
    dataSummary +
    `${body}\n` +
    `${retrievalHint}\n` +
    `</persisted-output>`
  );
}

function renderToolResultDataSummary(descriptor: ToolResultDataDescriptor): string {
  if (descriptor.reason === 'input_too_large') {
    return `[Result data — input exceeds the deterministic query limit; use materialize for full-data calculations with an available local runtime, or search/read for source excerpts.]`;
  }
  if (!descriptor.queryable) {
    return `[Result data — type=text; lines=${descriptor.textLines ?? 0}; query supports exact count only with match + count_unit; search locates excerpts; read uses a cursor.]`;
  }
  let remainingFieldSlots = 16;
  let remainingArrayFieldSlots = 8;
  const visibleDatasets = descriptor.datasets.slice(0, 8);
  const datasets = visibleDatasets.map((dataset, index) => {
    const remainingDatasets = visibleDatasets.length - index;
    const fieldSlots = Math.min(8, Math.max(1, Math.floor(remainingFieldSlots / remainingDatasets)));
    const fields = dataset.fields
      .slice(0, fieldSlots)
      .map((field) => `${field.name}:${field.type}`)
      .join(',');
    const shownFields = Math.min(dataset.fields.length, fieldSlots);
    remainingFieldSlots = Math.max(0, remainingFieldSlots - shownFields);
    const omitted = dataset.fields.length > shownFields
      ? `${fields ? ',' : ''}+${dataset.fields.length - shownFields} more`
      : '';
    const datasetArrays = dataset.arrays ?? [];
    const arrays = datasetArrays.slice(0, 2).map((array) => {
      const fieldSlots = Math.min(4, remainingArrayFieldSlots);
      const usefulFields = array.fields
        .filter((field) => field.name !== '$item' || field.type !== 'object');
      const shownArrayFields = usefulFields.slice(0, fieldSlots);
      const itemFields = shownArrayFields
        .map((field) => `${field.name}:${field.type}`)
        .join(',');
      remainingArrayFieldSlots = Math.max(0, remainingArrayFieldSlots - shownArrayFields.length);
      const arrayOmitted = usefulFields.length > shownArrayFields.length
        ? `${itemFields ? ',' : ''}+${usefulFields.length - shownArrayFields.length} more`
        : '';
      return `${array.name}[]{items=${array.items};fields=${itemFields || '(none)'}${arrayOmitted}}`;
    }).join(',');
    const omittedArrays = datasetArrays.length > 2
      ? `${arrays ? ',' : ''}+${datasetArrays.length - 2} more arrays`
      : '';
    return `${dataset.name}{records=${dataset.records};fields=${fields || '(none)'}${omitted}${arrays || omittedArrays ? `;arrays=${arrays}${omittedArrays}` : ''}}`;
  }).join(' ');
  const arrayHint = descriptor.datasets.some((dataset) => dataset.arrays?.length)
    ? '; array query uses explode with $item/$parent/$index'
    : '';
  return `[Result data — type=${descriptor.kind}; query operations=count,sum,average,minimum,maximum; omit match/count_unit for structured data${arrayHint}; datasets: ${datasets}]`;
}

/** Outline entries emitted at most; keeps the marker bounded on a document with
 *  hundreds of headings. */
const OUTLINE_MAX_ENTRIES = 40;
/** Below this a document isn't structured enough for an outline to beat a plain
 *  head/tail preview. */
const OUTLINE_MIN_ENTRIES = 3;

/** Build a heading outline with **character offsets**, so the model can feed an
 *  entry straight into `tool_result(action="read", requests=[{ref, cursor}])`.
 *
 *  A head/tail preview is close to useless on a structured document: it shows
 *  the opening and the closing and hides everything in between, which is where
 *  reference material actually lives. A protocol spec whose block-syntax
 *  section sits a third of the way in reads as "not present" — the model then
 *  keyword-searches for something it cannot name, or guesses. An outline costs
 *  the same tokens and turns retrieval into one targeted seek.
 *
 *  Offsets, not line numbers: `tool_result` action `read` takes a 0-based char
 *  cursor, so anything else would need a conversion the model can't perform.
 *
 *  Returns null when the text has too little structure to be worth it. */
export function buildStructureOutline(content: string): string | null {
  const entries: string[] = [];
  let offset = 0;
  let inFence = false;
  let truncated = false;
  for (const line of content.split('\n')) {
    const fence = /^\s{0,3}(?:```|~~~)/.test(line);
    if (fence) inFence = !inFence;
    if (!inFence && !fence) {
      const m = /^(#{1,6})\s+(\S.*?)\s*$/.exec(line);
      if (m) {
        if (entries.length >= OUTLINE_MAX_ENTRIES) { truncated = true; break; }
        const depth = m[1].length;
        entries.push(`@${offset}\t${'  '.repeat(depth - 1)}${m[2]}`);
      }
    }
    offset += line.length + 1;
  }
  if (entries.length < OUTLINE_MIN_ENTRIES) return null;
  if (truncated) entries.push('… [more sections follow]');
  return entries.join('\n');
}

function buildBoundedPreview(content: string, maxTokens: number): string {
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

// ── Cloud-side retention ─────────────────────────────────────────────────
