/**
 * Bounded retrieval for persisted tool results.
 *
 * Persisted outputs are addressed by an opaque ref, never by a model-chosen
 * path. Search locates text, query computes deterministic aggregates over
 * recognized records, read returns an exact cursor range, and materialize
 * creates an isolated working copy for bash/Node processing. Every operation
 * accepts a bounded batch. Model-facing reads use a runner-provided 4K round
 * ledger with duplicate suppression; reads retained inside run_program use
 * that runtime's stricter call/result/wall-clock limits instead.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { Worker } from 'node:worker_threads';
import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { createLogger } from '../../logger';
import { fileEditLock } from '../../util/locks';
import { sha256OfFileStream } from '../../util/sha256';
import { CLOUD_TOOL_RESULT_MAX_AGE_DAYS, estimateToolResultTokens } from '../../util/tool-result-cap';
import {
  TOOL_RESULT_QUERY_MAX_INPUT_BYTES,
  TOOL_RESULT_QUERY_TOO_LARGE_MESSAGE,
  aggregateToolResultData,
  type ToolResultAggregateRequest,
  type ToolResultAggregateResult,
  type ToolResultQueryFilter,
} from '../../util/tool-result-data';

export const TOOL_RESULT_CHUNK_DEFAULT_TOKENS = 1_000;
export const TOOL_RESULT_CHUNK_MAX_TOKENS = 2_000;
export const TOOL_RESULT_SEARCH_MAX_TOKENS = 2_000;
export const TOOL_RESULT_ROUND_MAX_TOKENS = 4_000;
export const TOOL_RESULT_BATCH_MAX_ITEMS = 8;
export const TOOL_RESULT_REF_SCHEMA_PATTERN = '^[a-zA-Z0-9_-]{1,48}\\.(?:[a-f0-9]{16}|[a-f0-9]{64})$';
const TOOL_RESULT_REF_RE = new RegExp(TOOL_RESULT_REF_SCHEMA_PATTERN);
const TOOL_RESULT_FILE_SCAN_BYTES = 64 * 1024;
const TOOL_RESULT_REF_DESCRIPTION =
  'Literal opaque ref from <persisted-output ref="...">. It has tool.hash form; never use a tool-call ID such as call_...';
const TOOL_RESULT_QUERY_WORKER_SOURCE = String.raw`
'use strict';
const { parentPort, workerData } = require('node:worker_threads');
require(workerData.tsxCjsPath);
const { aggregateToolResultData } = require(workerData.dataModulePath);
parentPort.on('message', (message) => {
  try {
    const bytes = message.bytes;
    const content = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
    parentPort.postMessage({
      id: message.id,
      result: aggregateToolResultData(content, message.request),
    });
  } catch {
    parentPort.postMessage({ id: message && message.id, failed: true });
  }
});
`;
const log = createLogger('tool-result-query');

export type ToolResultReadLedger = {
  epoch: number;
  remainingTokens: number;
  readKeys: Set<string>;
};

type ToolResultToolsOpts = {
  toolResultsDir: string;
  materializeDir: string;
  queryExecutor?: PersistedToolResultQueryExecutor;
  isProgrammaticToolCallContext: (ctx: ToolContext) => boolean;
};

type PersistedToolResultQueryExecutor = (
  filePath: string,
  request: ToolResultAggregateRequest,
  signal?: AbortSignal,
) => Promise<ToolResultAggregateResult>;

type PendingWorkerQuery = {
  worker: Worker;
  resolve: (result: ToolResultAggregateResult) => void;
  reject: (reason: Error) => void;
  cleanup: () => void;
};

class PersistedToolResultQueryWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingWorkerQuery>();
  private disposed = false;

  async query(
    filePath: string,
    request: ToolResultAggregateRequest,
    signal?: AbortSignal,
  ): Promise<ToolResultAggregateResult> {
    throwIfQueryAborted(signal);
    const stat = await fs.promises.stat(filePath);
    if (stat.size > TOOL_RESULT_QUERY_MAX_INPUT_BYTES) return queryTooLargeResult();
    const bytes = await fs.promises.readFile(filePath, signal ? { signal } : undefined);
    throwIfQueryAborted(signal);
    if (bytes.byteLength > TOOL_RESULT_QUERY_MAX_INPUT_BYTES) return queryTooLargeResult();
    return this.aggregate(bytes, request, signal);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    const error = new Error('Persisted-result query worker disposed.');
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(error);
    }
    await worker.terminate();
  }

  private aggregate(
    bytes: Buffer,
    request: ToolResultAggregateRequest,
    signal?: AbortSignal,
  ): Promise<ToolResultAggregateResult> {
    throwIfQueryAborted(signal);
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<ToolResultAggregateResult>((resolve, reject) => {
      const onAbort = () => {
        const reason = queryAbortError(signal);
        this.failWorker(worker, reason);
        void worker.terminate();
      };
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, { worker, resolve, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try {
        const transfer = bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : [];
        worker.postMessage({ id, bytes, request }, transfer);
      } catch {
        this.pending.delete(id);
        cleanup();
        reject(new Error('Persisted-result query worker could not accept input.'));
      }
    });
  }

  private ensureWorker(): Worker {
    if (this.disposed) throw new Error('Persisted-result query worker is closed.');
    if (this.worker) return this.worker;
    const worker = new Worker(TOOL_RESULT_QUERY_WORKER_SOURCE, {
      eval: true,
      workerData: {
        tsxCjsPath: require.resolve('tsx/cjs'),
        dataModulePath: require.resolve('../../util/tool-result-data.ts'),
      },
    });
    worker.on('message', (message: unknown) => this.onMessage(worker, message));
    worker.once('error', () => {
      this.failWorker(worker, new Error('Persisted-result query worker failed.'));
    });
    worker.once('exit', (code) => {
      if (this.disposed || (this.worker !== worker && !this.hasPendingFor(worker))) return;
      this.failWorker(worker, new Error(`Persisted-result query worker exited with code ${code}.`));
    });
    this.worker = worker;
    return worker;
  }

  private onMessage(worker: Worker, raw: unknown): void {
    if (!raw || typeof raw !== 'object') {
      this.failWorker(worker, new Error('Persisted-result query worker returned an invalid response.'));
      void worker.terminate();
      return;
    }
    const message = raw as { id?: unknown; result?: unknown; failed?: unknown };
    if (!Number.isInteger(message.id)) {
      this.failWorker(worker, new Error('Persisted-result query worker omitted its request id.'));
      void worker.terminate();
      return;
    }
    const id = Number(message.id);
    const pending = this.pending.get(id);
    if (!pending || pending.worker !== worker) return;
    this.pending.delete(id);
    pending.cleanup();
    const result = message.result as ToolResultAggregateResult | undefined;
    if (message.failed === true || !result || typeof result.ok !== 'boolean') {
      pending.reject(new Error('Persisted-result query worker could not process the input.'));
      return;
    }
    pending.resolve(result);
  }

  private failWorker(worker: Worker, reason: Error): void {
    if (this.worker === worker) this.worker = null;
    for (const [id, pending] of this.pending) {
      if (pending.worker !== worker) continue;
      this.pending.delete(id);
      pending.cleanup();
      pending.reject(reason);
    }
  }

  private hasPendingFor(worker: Worker): boolean {
    return [...this.pending.values()].some((pending) => pending.worker === worker);
  }
}

export function createToolResultTools(opts: ToolResultToolsOpts): AgentTool[] {
  return [createToolResultTool(opts)];
}

type ToolResultAction = 'search' | 'query' | 'read' | 'materialize';

const TOOL_RESULT_ACTION_REQUEST_FIELDS: Readonly<Record<ToolResultAction, ReadonlySet<string>>> = {
  search: new Set(['ref', 'query']),
  query: new Set([
    'ref', 'operation', 'dataset', 'explode', 'field', 'filters', 'group_by',
    'order', 'limit', 'match', 'count_unit',
  ]),
  read: new Set(['ref', 'cursor', 'max_tokens']),
  materialize: new Set(['ref']),
};

function toolResultActionRequestError(
  action: ToolResultAction,
  requests: unknown,
): RetrievalItemResult | null {
  if (!Array.isArray(requests)) return null;
  const allowed = TOOL_RESULT_ACTION_REQUEST_FIELDS[action];
  for (let index = 0; index < requests.length; index++) {
    const item = requests[index];
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const unexpected = Object.keys(item).filter((key) => !allowed.has(key)).sort();
    if (!unexpected.length) continue;
    return error(
      'E_BAD_INPUT',
      `tool_result(${action}) request ${index + 1}: unsupported field(s): ${unexpected.join(', ')}. `
      + 'Use only the fields advertised for the selected action.',
    );
  }
  return null;
}

function createToolResultTool(opts: ToolResultToolsOpts): AgentTool {
  const search = createSearchTool(opts);
  const read = createReadChunkTool(opts);
  const query = createQueryTool(opts);
  const refProperty = () => ({
    type: 'string',
    pattern: TOOL_RESULT_REF_SCHEMA_PATTERN,
    description: TOOL_RESULT_REF_DESCRIPTION,
  });
  const searchRequest = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ref: refProperty(),
      query: {
        type: 'string',
        description: 'Narrow text expression under 256 estimated tokens. Do not use for structured aggregation.',
      },
    },
    required: ['ref', 'query'],
  };
  const structuredQueryProperties = () => ({
    ref: refProperty(),
    dataset: {
      type: 'string',
      description: 'Dataset advertised by the marker. Required only when multiple datasets are advertised.',
    },
    explode: {
      type: 'string',
      description: 'Expand one advertised array by its record-relative path; no dataset prefix or [].',
    },
    field: {
      type: 'string',
      description: 'Dotted numeric field. Required for sum, average, minimum, and maximum; optional for count.',
    },
    filters: {
      type: 'array',
      maxItems: 8,
      description: 'Up to eight structured predicates combined with AND.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          field: { type: 'string' },
          op: { type: 'string', enum: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'] },
          value: { type: ['string', 'number', 'boolean', 'null'] },
        },
        required: ['field', 'op'],
      },
    },
    group_by: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string' },
      description: 'Up to three dotted fields used to group a structured aggregate.',
    },
    order: { type: 'string', enum: ['asc', 'desc'], description: 'Structured aggregate sort order; default desc.' },
    limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum structured result groups; default 20.' },
  });
  // One structured request covers count and numeric aggregates; the runtime
  // (`toolResultActionRequestError` + the query tool) enforces which fields
  // each operation needs, so the schema does not repeat the property set per
  // operation.
  const structuredRequest = {
    type: 'object',
    description: 'With explode, field, filters.field and group_by use $item.<field>, $parent.<field>, or $index; scalar items use $item.',
    additionalProperties: false,
    properties: {
      ...structuredQueryProperties(),
      operation: {
        type: 'string',
        enum: ['count', 'sum', 'average', 'minimum', 'maximum'],
        description: 'Structured aggregate. count needs no field; sum/average/minimum/maximum require field. Never include match or count_unit.',
      },
    },
    required: ['ref', 'operation'],
  };
  const textCountRequest = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ref: refProperty(),
      operation: {
        type: 'string',
        enum: ['count'],
        description: 'Exact count over a marker advertised as unstructured text.',
      },
      match: {
        type: 'string',
        description: 'Required exact case-insensitive text. Use only for unstructured-text count.',
      },
      count_unit: {
        type: 'string',
        enum: ['matching_lines', 'occurrences'],
        description: 'Required count unit. Use only for unstructured-text count.',
      },
    },
    required: ['ref', 'operation', 'match', 'count_unit'],
  };
  const readRequest = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ref: refProperty(),
      cursor: { type: 'integer', minimum: 0, description: 'Exact non-negative character cursor.' },
      max_tokens: {
        type: 'integer',
        minimum: 256,
        maximum: TOOL_RESULT_CHUNK_MAX_TOKENS,
        description: 'Requested slice size; default 1000, maximum 2000.',
      },
    },
    required: ['ref', 'cursor'],
  };
  const materializeRequest = {
    type: 'object',
    additionalProperties: false,
    properties: { ref: refProperty() },
    required: ['ref'],
  };
  const actionProperty = {
    type: 'string',
    enum: ['search', 'query', 'read', 'materialize'],
    description: 'Choose exactly one operation and use only that action\'s request fields.',
  };
  // The request shapes are advertised once, as the union of `requests.items`;
  // the action branches below only bind `action` to its purpose. Pairing each
  // action with its request shape is enforced at runtime
  // (`toolResultActionRequestError`), so repeating the full item schema per
  // branch bought no enforcement and cost ~1,100 tokens on every model request.
  const actionBranch = (action: ToolResultAction, description: string) => ({
    properties: {
      action: { type: 'string', enum: [action], description },
    },
  });
  return {
    name: 'tool_result',
    description:
      'Inspect one oversized result referenced by a prior <persisted-output ref="..."> marker. Make at most one tool_result call per model step and batch up to eight currently needed same-action requests. Use only the selected action branch; never use a tool-call ID such as call_....',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: actionProperty,
        requests: {
          type: 'array',
          minItems: 1,
          maxItems: TOOL_RESULT_BATCH_MAX_ITEMS,
          description: 'One to eight same-action requests using only that action\'s fields (search: ref+query; query: ref+operation…; read: ref+cursor; materialize: ref). Retrieval actions share one 4K-token model-step budget.',
          items: { oneOf: [searchRequest, structuredRequest, textCountRequest, readRequest, materializeRequest] },
        },
      },
      required: ['action', 'requests'],
      oneOf: [
        actionBranch('search', 'Search 1-8 narrow text expressions; do not include cursor or aggregate fields.'),
        actionBranch('query', 'Run 1-8 deterministic aggregates matching the marker data type.'),
        actionBranch('read', 'Read 1-8 exact source excerpts by cursor for inspection; do not prefetch sequential chunks.'),
        actionBranch('materialize', 'Create 1-8 session-scoped UTF-8 working copies for full-data calculations that query cannot express; process them with an available local runtime.'),
      ],
    },
    async execute(input, ctx) {
      const action = String(input.action ?? '') as ToolResultAction;
      const requests = Array.isArray(input.requests)
        ? input.requests.map((item) => item && typeof item === 'object' && !Array.isArray(item)
          ? item as Record<string, unknown>
          : {})
        : input.requests;
      if (!['search', 'query', 'read', 'materialize'].includes(action)) {
        return error('E_BAD_INPUT', '`action` must be search, query, read, or materialize.');
      }
      const shapeError = toolResultActionRequestError(action, requests);
      if (shapeError) return shapeError;
      if (action === 'search') return search.execute({ queries: requests }, ctx);
      if (action === 'query') return query.execute({ queries: requests }, ctx);
      if (action === 'read') {
        const chunks = Array.isArray(requests)
          ? requests.map((item) => ({ ...item, maxTokens: item.max_tokens }))
          : requests;
        return read.execute({ chunks }, ctx);
      }
      if (action === 'materialize') return materializeToolResults(opts, requests);
      return error('E_BAD_INPUT', '`action` must be search, query, read, or materialize.');
    },
  };
}

async function materializeToolResults(
  opts: ToolResultToolsOpts,
  requests: unknown,
): Promise<RetrievalItemResult> {
  const batch = batchItems({ requests }, 'requests', ['ref']);
  if (batch.error) return batch.error;

  const sources: Array<{ ref: string; path: string; bytes: number }> = [];
  for (const item of batch.items) {
    const ref = String(item.ref || '').trim();
    if (!ref) return error('E_BAD_INPUT', '`ref` is required.');
    const resolved = resolveToolResultRef(opts.toolResultsDir, ref);
    if (resolved.ok === false) return error(resolved.code, resolved.message);
    try {
      const stat = await fs.promises.stat(resolved.path);
      if (!stat.isFile()) return error('E_RESULT_REF_NOT_FILE', 'Tool-result ref is not a regular file.');
      sources.push({ ref, path: resolved.path, bytes: stat.size });
    } catch {
      log.warn('persisted-result materialization failed', { phase: 'read' });
      return error(
        'E_RESULT_MATERIALIZE_READ',
        'The persisted result could not be read. Re-run the original tool to regenerate the data.',
      );
    }
  }

  const created: string[] = [];
  let release: (() => void) | undefined;
  try {
    await fs.promises.mkdir(opts.materializeDir, { recursive: true });
    const root = await fs.promises.realpath(path.resolve(opts.materializeDir));
    // Publication and rollback share one session-root lock: simultaneous
    // batches must not replace or remove each other's deterministic copies.
    release = await fileEditLock(root).acquire();
    const files: Array<{ ref: string; path: string; bytes: number; encoding: 'utf8' }> = [];
    for (const source of sources) {
      // One working copy per ref: persisted results are write-once, so a
      // repeat materialize of the same ref in a long session reuses the copy
      // instead of stacking identical files until the conversation is deleted.
      // Working copies are writable. Reuse only an independent regular file
      // whose bytes still match; size alone misses same-length edits.
      const destination = path.join(root, `result-${createHash('sha256').update(source.ref).digest('hex')}.txt`);
      if (!isInside(root, destination)) {
        throw new Error('materialized result path escaped its session root');
      }
      let reusable = false;
      try {
        const existing = await fs.promises.lstat(destination);
        if (existing.isFile() && existing.nlink === 1 && existing.size === source.bytes) {
          const sourceHash = await sha256OfFileStream(source.path);
          reusable = sourceHash === await sha256OfFileStream(destination);
        }
      } catch { /* not materialized yet */ }
      if (!reusable) {
        await fs.promises.rm(destination, { force: true });
        await fs.promises.copyFile(source.path, destination, fs.constants.COPYFILE_EXCL);
        created.push(destination);
      }
      files.push({ ref: source.ref, path: destination, bytes: source.bytes, encoding: 'utf8' });
    }
    return { content: JSON.stringify({ files, dataContract: {
      sourceBytes: 'unchanged',
      validation: 'not-performed',
      calculation: 'Validate required container structure and operand types before arithmetic; field presence alone is insufficient. '
        + 'Missing/null containers are not empty collections, and missing/null operands are not zero. '
        + 'Use only defaults explicitly defined by the task\'s rules.',
    } }) };
  } catch {
    log.warn('persisted-result materialization failed', { phase: 'write' });
    for (const file of created) {
      try { await fs.promises.unlink(file); } catch { /* best-effort rollback */ }
    }
    return error(
      'E_RESULT_MATERIALIZE_WRITE',
      'The persisted result could not be materialized. Retry once or use search/read instead.',
    );
  } finally {
    release?.();
  }
}

function createQueryTool(opts: ToolResultToolsOpts): AgentTool {
  return {
    // Internal executor used only by the canonical tool_result action.
    name: 'tool_result_query',
    description: 'Compute a bounded deterministic aggregate over a persisted tool result.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        queries: { type: 'array', minItems: 1, maxItems: TOOL_RESULT_BATCH_MAX_ITEMS },
      },
      required: ['queries'],
    },
    async execute(input, ctx) {
      const ledger = readLedger(ctx, opts);
      const batch = batchItems(input, 'queries', ['ref', 'operation']);
      if (batch.error) return batch.error;
      const worker = opts.queryExecutor ? null : new PersistedToolResultQueryWorker();
      const queryExecutor = opts.queryExecutor ?? worker!.query.bind(worker);
      try {
        return await executeBatch(batch.items, ledger, (item, maxOutputTokens) =>
          executeQueryItem(opts, item, ledger, maxOutputTokens, queryExecutor, ctx.signal));
      } finally {
        try {
          await worker?.dispose();
        } catch {
          log.warn('persisted-result query worker cleanup failed', { phase: 'terminate' });
        }
      }
    },
  };
}

function createSearchTool(opts: ToolResultToolsOpts): AgentTool {
  return {
    name: 'tool_result_search',
    description: 'Search an oversized tool result referenced by a prior <persisted-output ref="..."> marker. Never use a tool-call ID such as call_... as a result ref.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        queries: {
          type: 'array',
          minItems: 1,
          maxItems: TOOL_RESULT_BATCH_MAX_ITEMS,
          description: 'One to eight searches sharing a 4K-token round budget. Each item contains an opaque ref and a narrow query.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ref: {
                type: 'string',
                pattern: TOOL_RESULT_REF_SCHEMA_PATTERN,
                description: TOOL_RESULT_REF_DESCRIPTION,
              },
              query: { type: 'string' },
            },
            required: ['ref', 'query'],
          },
        },
      },
      required: ['queries'],
    },
    async execute(input, ctx) {
      const ledger = readLedger(ctx, opts);
      const batch = batchItems(input, 'queries', ['ref', 'query']);
      if (batch.error) return batch.error;
      return executeBatch(batch.items, ledger, (item, maxOutputTokens) =>
        executeSearchItem(opts, item, ledger, maxOutputTokens));
    },
  };
}

function createReadChunkTool(opts: ToolResultToolsOpts): AgentTool {
  return {
    name: 'tool_result_read_chunk',
    description: 'Read exact chunks from an oversized tool result referenced by a prior <persisted-output ref="..."> marker. Never use a tool-call ID such as call_... as a result ref.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chunks: {
          type: 'array',
          minItems: 1,
          maxItems: TOOL_RESULT_BATCH_MAX_ITEMS,
          description: 'One to eight exact reads sharing a 4K-token round budget. Each item contains ref, cursor, and optional maxTokens capped at 2K.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ref: {
                type: 'string',
                pattern: TOOL_RESULT_REF_SCHEMA_PATTERN,
                description: TOOL_RESULT_REF_DESCRIPTION,
              },
              cursor: { type: 'number' },
              maxTokens: { type: 'number' },
            },
            required: ['ref', 'cursor'],
          },
        },
      },
      required: ['chunks'],
    },
    async execute(input, ctx) {
      const ledger = readLedger(ctx, opts);
      const batch = batchItems(input, 'chunks', ['ref', 'cursor']);
      if (batch.error) return batch.error;
      return executeBatch(batch.items, ledger, (item, maxOutputTokens) =>
        executeReadChunkItem(opts, item, ledger, maxOutputTokens));
    },
  };
}

type RetrievalItemResult = Pick<ToolResult, 'content' | 'isError' | 'observations'>;

function batchItems(
  input: Record<string, unknown>,
  batchKey: 'queries' | 'chunks' | 'requests',
  legacyRequired: string[],
): { items: Record<string, unknown>[]; error?: never } | { items?: never; error: RetrievalItemResult } {
  const rawBatch = input[batchKey];
  if (rawBatch !== undefined) {
    if (!Array.isArray(rawBatch) || rawBatch.length < 1 || rawBatch.length > TOOL_RESULT_BATCH_MAX_ITEMS) {
      return {
        error: error(
          'E_BAD_INPUT',
          `\`${batchKey}\` must contain 1-${TOOL_RESULT_BATCH_MAX_ITEMS} requests.`,
        ),
      };
    }
    return {
      items: rawBatch.map((item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? item as Record<string, unknown>
          : {}),
    };
  }
  if (!legacyRequired.every((key) => input[key] !== undefined)) {
    return {
      error: error(
        'E_BAD_INPUT',
        `Provide either \`${batchKey}\` or the legacy ${legacyRequired.map((key) => `\`${key}\``).join(' + ')} fields.`,
      ),
    };
  }
  return { items: [input] };
}

async function executeBatch(
  items: Record<string, unknown>[],
  ledger: ToolResultReadLedger | null,
  executeItem: (
    item: Record<string, unknown>,
    maxOutputTokens: number,
  ) => RetrievalItemResult | Promise<RetrievalItemResult>,
): Promise<RetrievalItemResult> {
  const outputs: string[] = [];
  let successes = 0;
  const failures: Array<{ index: number; code: string }> = [];
  let remainingOutputTokens = Math.min(
    TOOL_RESULT_ROUND_MAX_TOKENS,
    ledger?.remainingTokens ?? TOOL_RESULT_ROUND_MAX_TOKENS,
  );
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const separatorTokens = outputs.length ? estimateToolResultTokens('\n') : 0;
    const remainingItems = items.length - index;
    // Divide what remains across every pending request. Without this, the
    // first two 2K chunks can consume the entire 4K allowance and silently
    // drop the tail of an otherwise valid batch.
    const itemBudget = Math.max(
      0,
      Math.floor((remainingOutputTokens - separatorTokens) / remainingItems),
    );
    if (itemBudget < 1) break;
    const result = await executeItem(item, itemBudget);
    // Inspect the owning item's status before rendering/truncation. Source
    // excerpts may themselves quote tool-error text; those are not failures.
    if (result.isError) failures.push({ index,
      code: /^<tool-error code="([A-Z][A-Z0-9_]{0,63})">/.exec(result.content)?.[1]
        ?? 'E_RESULT_ITEM_FAILED' });
    const content = prefixWithinTokenBudget(result.content, itemBudget);
    outputs.push(content);
    remainingOutputTokens = Math.max(
      0,
      remainingOutputTokens - separatorTokens - estimateToolResultTokens(content),
    );
    if (!result.isError) successes++;
  }
  const observations = { resultRetrievalBatch: {
    requested: items.length, attempted: outputs.length, succeeded: successes,
    failed: failures.length, skipped: items.length - outputs.length, failures,
  } };
  if (!outputs.length) return { ...budgetError(), observations };
  return {
    content: outputs.join('\n'),
    observations,
    ...(successes === 0 ? { isError: true as const } : {}),
  };
}

async function executeQueryItem(
  opts: ToolResultToolsOpts,
  input: Record<string, unknown>,
  ledger: ToolResultReadLedger | null,
  maxOutputTokens: number,
  queryExecutor: PersistedToolResultQueryExecutor,
  signal?: AbortSignal,
): Promise<RetrievalItemResult> {
  const ref = String(input.ref || '').trim();
  const operation = String(input.operation || '').trim() as ToolResultAggregateRequest['operation'];
  if (!ref || !operation) return error('E_BAD_INPUT', '`ref` and `operation` are required.');
  const resolved = resolveToolResultRef(opts.toolResultsDir, ref);
  if (resolved.ok === false) return error(resolved.code, resolved.message);
  const request: ToolResultAggregateRequest = {
    operation,
    ...(typeof input.dataset === 'string' ? { dataset: input.dataset } : {}),
    ...(typeof input.explode === 'string' ? { explode: input.explode } : {}),
    ...(typeof input.field === 'string' ? { field: input.field } : {}),
    ...(Array.isArray(input.filters) ? {
      filters: input.filters.map((filter) => (
        filter && typeof filter === 'object' && !Array.isArray(filter)
          ? filter as ToolResultQueryFilter
          : { field: '', op: 'eq' }
      )),
    } : {}),
    ...(Array.isArray(input.group_by) ? { groupBy: input.group_by.map(String) } : {}),
    ...(input.order === 'asc' || input.order === 'desc' ? { order: input.order } : {}),
    ...(input.limit !== undefined ? { limit: Number(input.limit) } : {}),
    ...(typeof input.match === 'string' ? { match: input.match } : {}),
    ...(input.count_unit === 'matching_lines' || input.count_unit === 'occurrences'
      ? { countUnit: input.count_unit }
      : {}),
  };
  const key = `${ledger?.epoch ?? 0}:query:${ref}:${canonicalAggregateRequest(request)}`;
  const duplicate = rejectDuplicate(ledger, key);
  if (duplicate) return duplicate;
  const budget = availableBudget(ledger, Math.min(TOOL_RESULT_SEARCH_MAX_TOKENS, maxOutputTokens));
  if (budget < 128) return budgetError();

  let content: string;
  try {
    const result = await queryExecutor(resolved.path, request, signal);
    if (result.ok === false) return error(result.code, result.message);
    content = renderAggregateResult(ref, request, result, budget);
  } catch (queryError) {
    if (signal?.aborted || isQueryAbortError(queryError)) throw queryError;
    log.warn('persisted-result query failed', { phase: 'read_or_worker' });
    return error(
      'E_RESULT_QUERY_READ',
      'The persisted result could not be read for querying. Re-run the original tool or use a different retained result ref.',
    );
  }
  commitRead(ledger, key, estimateToolResultTokens(content));
  return { content };
}

function queryTooLargeResult(): Extract<ToolResultAggregateResult, { ok: false }> {
  return {
    ok: false,
    code: 'E_RESULT_QUERY_TOO_LARGE',
    message: TOOL_RESULT_QUERY_TOO_LARGE_MESSAGE,
  };
}

function queryAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return Object.assign(new Error('Persisted-result query aborted.'), {
    name: 'AbortError',
    code: 'ABORT_ERR',
  });
}

function throwIfQueryAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw queryAbortError(signal);
}

function isQueryAbortError(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const errorValue = value as { name?: unknown; code?: unknown };
  return errorValue.name === 'AbortError' || errorValue.code === 'ABORT_ERR';
}

function renderAggregateResult(
  ref: string,
  request: ToolResultAggregateRequest,
  result: Extract<ReturnType<typeof aggregateToolResultData>, { ok: true }>,
  budget: number,
): string {
  const render = (rows: typeof result.rows, truncated: boolean): string => (
    `<tool-result-query ref="${escapeAttr(ref)}" operation="${escapeAttr(request.operation)}" dataset="${escapeAttr(result.dataset)}" `
    + `${request.explode ? `explode="${escapeAttr(request.explode)}" ` : ''}`
    + `source_type="${escapeAttr(result.kind)}" unit="${escapeAttr(result.unit)}" scanned="${result.scanned}" matched="${result.matched}" groups="${result.groups}" truncated="${truncated ? 'true' : 'false'}">\n`
    + `${JSON.stringify(rows)}\n`
    + '</tool-result-query>'
  );
  let rows = result.rows;
  let output = render(rows, result.truncated);
  while (rows.length > 1 && estimateToolResultTokens(output) > budget) {
    rows = rows.slice(0, Math.ceil(rows.length / 2));
    output = render(rows, true);
  }
  if (estimateToolResultTokens(output) > budget) output = render([], true);
  return prefixWithinTokenBudget(output, budget);
}

function canonicalAggregateRequest(request: ToolResultAggregateRequest): string {
  return JSON.stringify({
    operation: request.operation,
    dataset: request.dataset || '',
    explode: request.explode || '',
    field: request.field || '',
    filters: request.filters || [],
    groupBy: request.groupBy || [],
    order: request.order || 'desc',
    limit: request.limit || 20,
    match: request.match || '',
    countUnit: request.countUnit || '',
  });
}

function executeSearchItem(
  opts: ToolResultToolsOpts,
  input: Record<string, unknown>,
  ledger: ToolResultReadLedger | null,
  maxOutputTokens: number,
): RetrievalItemResult {
  const ref = String(input.ref || '').trim();
  const query = String(input.query || '').trim();
  if (!ref || !query) return error('E_BAD_INPUT', '`ref` and `query` are required.');
  if (estimateToolResultTokens(query) > 256) {
    return error('E_BAD_INPUT', '`query` must be a narrow search expression under 256 estimated tokens.');
  }
  const resolved = resolveToolResultRef(opts.toolResultsDir, ref);
  if (resolved.ok === false) return error(resolved.code, resolved.message);

  const key = `${ledger?.epoch ?? 0}:search:${ref}:${canonicalSearchQuery(query)}`;
  const duplicate = rejectDuplicate(ledger, key);
  if (duplicate) return duplicate;
  const budget = availableBudget(ledger, Math.min(TOOL_RESULT_SEARCH_MAX_TOKENS, maxOutputTokens));
  if (budget < 128) return budgetError();

  const output = searchResultFile(resolved.path, ref, query, budget);
  commitRead(ledger, key, estimateToolResultTokens(output));
  return { content: output };
}

function executeReadChunkItem(
  opts: ToolResultToolsOpts,
  input: Record<string, unknown>,
  ledger: ToolResultReadLedger | null,
  maxOutputTokens: number,
): RetrievalItemResult {
  const ref = String(input.ref || '').trim();
  const cursor = Number(input.cursor);
  if (!ref || !Number.isInteger(cursor) || cursor < 0) {
    return error('E_BAD_INPUT', '`ref` and a non-negative integer `cursor` are required.');
  }
  const resolved = resolveToolResultRef(opts.toolResultsDir, ref);
  if (resolved.ok === false) return error(resolved.code, resolved.message);

  const key = `${ledger?.epoch ?? 0}:chunk:${ref}:${cursor}`;
  const duplicate = rejectDuplicate(ledger, key);
  if (duplicate) return duplicate;
  const requested = Number.isFinite(Number(input.maxTokens))
    ? Math.trunc(Number(input.maxTokens))
    : TOOL_RESULT_CHUNK_DEFAULT_TOKENS;
  const perCall = clamp(requested, 256, TOOL_RESULT_CHUNK_MAX_TOKENS);
  const budget = availableBudget(ledger, Math.min(perCall, maxOutputTokens));
  if (budget < 128) return budgetError();

  let candidate = '';
  let candidateFull = false;
  const totalChars = scanUtf8File(resolved.path, (text, chunkStart) => {
    if (candidateFull || chunkStart + text.length <= cursor) return;
    const localStart = Math.max(0, cursor - chunkStart);
    const combined = candidate + text.slice(localStart);
    const bounded = prefixWithinTokenBudget(combined, budget);
    candidate = bounded;
    candidateFull = bounded.length < combined.length;
  });
  if (cursor > totalChars) {
    return error('E_RESULT_CURSOR_RANGE', `cursor ${cursor} exceeds total_chars ${totalChars}.`);
  }
  const emptyEnvelope =
    `<tool-result-chunk ref="${escapeAttr(ref)}" total_chars="${totalChars}" covered="${cursor}-${cursor}" next_cursor="done">\n\n` +
    `</tool-result-chunk>`;
  const payloadBudget = budget - estimateToolResultTokens(emptyEnvelope);
  if (payloadBudget < 64) return budgetError();
  // The cursor/end attributes grow with the selected payload, so reserving
  // an envelope built with `covered="cursor-cursor"` can be one or two
  // tokens short once real offsets are inserted. Bound the FINAL envelope,
  // not only its text payload, so the documented 2K per-read ceiling is a
  // strict invariant rather than an approximate one.
  const payloadCandidate = prefixWithinTokenBudget(candidate, payloadBudget);
  const render = (text: string): string => {
    const end = cursor + text.length;
    const next = end < totalChars ? String(end) : 'done';
    return (
      `<tool-result-chunk ref="${escapeAttr(ref)}" total_chars="${totalChars}" covered="${cursor}-${end}" next_cursor="${next}">\n` +
      `${text}\n` +
      `</tool-result-chunk>`
    );
  };
  let lo = 0;
  let hi = payloadCandidate.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateToolResultTokens(render(payloadCandidate.slice(0, mid))) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const output = render(payloadCandidate.slice(0, lo));
  commitRead(ledger, key, estimateToolResultTokens(output));
  return { content: output };
}

export function resolveToolResultRef(
  toolResultsDir: string,
  ref: string,
): { ok: true; path: string } | { ok: false; code: string; message: string } {
  // Accept legacy 64-bit refs plus the current full SHA-256 refs. New writes
  // always use 64 hex chars; compatibility here keeps existing conversations
  // and persisted markers readable after upgrade. Validate that persisted
  // shape before diagnosing bare `call_...` IDs: connector results are
  // legitimately named `call_connector_tool.<hash>`.
  if (!TOOL_RESULT_REF_RE.test(ref)) {
    if (/^call[_-]/i.test(ref)) {
      return {
        ok: false,
        code: 'E_RESULT_REF_NOT_PERSISTED',
        message:
          'A tool-call ID is not a persisted-output ref. Use only the opaque ref from '
          + '<persisted-output ref="...">; otherwise read the task file/ledger directly.',
      };
    }
    return { ok: false, code: 'E_RESULT_REF_INVALID', message: 'Invalid tool-result ref.' };
  }
  const root = path.resolve(toolResultsDir);
  const candidate = path.resolve(root, `${ref}.txt`);
  if (!isInside(root, candidate)) {
    return { ok: false, code: 'E_RESULT_REF_SCOPE', message: 'Tool-result ref resolves outside the active session.' };
  }
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(candidate);
    if (!isInside(realRoot, real)) {
      return { ok: false, code: 'E_RESULT_REF_SCOPE', message: 'Tool-result ref resolves outside the active session.' };
    }
    if (!fs.statSync(real).isFile()) {
      return { ok: false, code: 'E_RESULT_REF_NOT_FILE', message: 'Tool-result ref is not a regular file.' };
    }
    return { ok: true, path: real };
  } catch {
    return {
      ok: false,
      code: 'E_RESULT_REF_MISSING',
      message: `Tool result no longer exists — persisted results are retained up to ${CLOUD_TOOL_RESULT_MAX_AGE_DAYS} days. Re-run the original tool to regenerate the data.`,
    };
  }
}

function searchResultFile(filePath: string, ref: string, query: string, budget: number): string {
  const terms = Array.from(new Set(
    normalizeQuery(query).match(/[\p{L}\p{N}_-]{2,}/gu) || [normalizeQuery(query)],
  )).filter(Boolean).slice(0, 12);
  const ranges: Array<{ start: number; end: number; score: number }> = [];
  const foundByTerm = new Map(terms.map((term) => [term, 0]));
  const overlapChars = Math.max(0, ...terms.map((term) => term.length - 1));
  let carry = '';
  const totalChars = scanUtf8File(filePath, (text, chunkStart) => {
    const window = carry + text;
    const windowStart = chunkStart - carry.length;
    const lower = window.toLocaleLowerCase();
    for (const term of terms) {
      let found = foundByTerm.get(term) ?? 0;
      if (found >= 20) continue;
      let from = 0;
      while (from < lower.length && found < 20) {
        const index = lower.indexOf(term, from);
        if (index < 0) break;
        const globalIndex = windowStart + index;
        // Matches wholly inside carry were emitted with the prior chunk.
        if (globalIndex + term.length > chunkStart) {
          ranges.push({
            start: Math.max(0, globalIndex - 500),
            end: globalIndex + term.length + 1_000,
            score: term.length,
          });
          found++;
        }
        from = index + Math.max(1, term.length);
      }
      foundByTerm.set(term, found);
    }
    carry = overlapChars ? window.slice(-overlapChars) : '';
  });
  for (const range of ranges) range.end = Math.min(totalChars, range.end);
  ranges.sort((a, b) => b.score - a.score || a.start - b.start);
  const selected: Array<{ start: number; end: number }> = [];
  for (const range of ranges) {
    if (selected.some((s) => range.start < s.end && range.end > s.start)) continue;
    selected.push(range);
    if (selected.length >= 3) break;
  }

  const header = `<tool-result-search ref="${escapeAttr(ref)}" query="${escapeAttr(query)}" total_chars="${totalChars}" matches="${selected.length}">`;
  const closing = '</tool-result-search>';
  if (!selected.length) return `${header}\nNo matching text found. Refine the query; do not scan the whole result.\n${closing}`;
  const excerpts = readUtf8CharacterRanges(filePath, selected);
  const pieces: string[] = [header];
  for (let i = 0; i < selected.length; i++) {
    const range = selected[i];
    const wrapper = `<match covered="${range.start}-${range.end}">\n\n</match>`;
    const remaining = budget
      - estimateToolResultTokens([...pieces, closing].join('\n'))
      - estimateToolResultTokens(wrapper);
    if (remaining < 64) break;
    const excerpt = prefixWithinTokenBudget(excerpts[i], remaining);
    if (!excerpt) break;
    pieces.push(`<match covered="${range.start}-${range.start + excerpt.length}">\n${excerpt}\n</match>`);
  }
  pieces.push(closing);
  return pieces.join('\n');
}

/** Decode a Result Store file incrementally. `chunkStart` and the returned
 * total use JavaScript UTF-16 character cursors, matching String#slice and the
 * public cursor contract, while resident memory stays bounded by one 64KB
 * byte buffer plus whatever the callback deliberately retains. */
function scanUtf8File(
  filePath: string,
  onText: (text: string, chunkStart: number) => void,
): number {
  const fd = fs.openSync(filePath, 'r');
  const decoder = new StringDecoder('utf8');
  const bytes = Buffer.allocUnsafe(TOOL_RESULT_FILE_SCAN_BYTES);
  let chars = 0;
  const emit = (text: string) => {
    if (!text) return;
    const start = chars;
    chars += text.length;
    onText(text, start);
  };
  try {
    while (true) {
      const read = fs.readSync(fd, bytes, 0, bytes.length, null);
      if (!read) break;
      emit(decoder.write(bytes.subarray(0, read)));
    }
    emit(decoder.end());
  } finally {
    fs.closeSync(fd);
  }
  return chars;
}

function readUtf8CharacterRanges(
  filePath: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): string[] {
  const pieces = ranges.map(() => [] as string[]);
  scanUtf8File(filePath, (text, chunkStart) => {
    const chunkEnd = chunkStart + text.length;
    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i];
      if (range.start >= chunkEnd || range.end <= chunkStart) continue;
      const start = Math.max(0, range.start - chunkStart);
      const end = Math.min(text.length, range.end - chunkStart);
      pieces[i].push(text.slice(start, end));
    }
  });
  return pieces.map((parts) => parts.join(''));
}

function readLedger(ctx: ToolContext, opts: ToolResultToolsOpts): ToolResultReadLedger | null {
  // Program child results stay inside the isolated runtime and are governed
  // by run_program's call/result/wall-clock limits. Do not charge those bytes
  // to the model-facing 4K retrieval ledger; only run_program's final compact
  // output crosses into conversation context.
  if (opts.isProgrammaticToolCallContext(ctx)) return null;
  const value = ctx.state.toolResultReadLedger;
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<ToolResultReadLedger>;
  if (!(record.readKeys instanceof Set) || !Number.isFinite(record.remainingTokens)) return null;
  return record as ToolResultReadLedger;
}

function rejectDuplicate(ledger: ToolResultReadLedger | null, key: string): ReturnType<typeof error> | null {
  if (!ledger?.readKeys.has(key)) return null;
  return error(
    'E_RESULT_CHUNK_ALREADY_READ',
    'This result range/query was already read in the current compaction epoch. Reuse the prior observation or request a different narrow range/query.',
  );
}

function availableBudget(ledger: ToolResultReadLedger | null, requested: number): number {
  return Math.max(0, Math.min(requested, ledger?.remainingTokens ?? TOOL_RESULT_ROUND_MAX_TOKENS));
}

function commitRead(ledger: ToolResultReadLedger | null, key: string, usedTokens: number): void {
  if (!ledger) return;
  ledger.readKeys.add(key);
  ledger.remainingTokens = Math.max(0, ledger.remainingTokens - usedTokens);
}

function budgetError(): ReturnType<typeof error> {
  return error(
    'E_RESULT_READ_BUDGET',
    'The shared 4K-token query/search/read observation budget for this model step is exhausted. Reuse prior observations. For full-data calculations, materialize the same ref and process its working copy with an available local runtime.',
  );
}

function error(code: string, message: string): { content: string; isError: true } {
  return { content: `<tool-error code="${code}">${message}</tool-error>`, isError: true };
}

function prefixWithinTokenBudget(text: string, maxTokens: number): string {
  if (estimateToolResultTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateToolResultTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

function normalizeQuery(value: string): string {
  return value.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/** Search matching already treats whitespace-separated terms as an unordered
 * OR-set, so the duplicate key should do the same. This prevents a model from
 * spending another round merely by changing term order/case/spacing. */
function canonicalSearchQuery(value: string): string {
  const normalized = normalizeQuery(value);
  const terms = normalized.match(/[\p{L}\p{N}_-]{2,}/gu);
  return terms?.length
    ? Array.from(new Set(terms)).sort().join(' ')
    : normalized;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
