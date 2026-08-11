/**
 * Bounded retrieval for persisted tool results.
 *
 * Persisted outputs are addressed by an opaque ref, never by a model-chosen
 * path. Search is the default retrieval path; exact reads require a cursor and
 * are hard-clamped to 2K estimated tokens. Both tools accept a bounded batch so
 * independent retrievals do not require one model round each. A runner-provided
 * per-round ledger enforces a 4K aggregate budget and suppresses duplicate reads
 * within the same compaction epoch.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AgentTool, ToolContext } from '#core-agent';
import { estimateToolResultTokens } from '../../util/tool-result-cap';

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

export type ToolResultReadLedger = {
  epoch: number;
  remainingTokens: number;
  readKeys: Set<string>;
};

type ToolResultToolsOpts = {
  toolResultsDir: string;
};

export function createToolResultTools(opts: ToolResultToolsOpts): AgentTool[] {
  return [createSearchTool(opts), createReadChunkTool(opts)];
}

function createSearchTool(opts: ToolResultToolsOpts): AgentTool {
  return {
    name: 'tool_result_search',
    description: 'Search an oversized tool result only when its prior output literally contained <persisted-output ref="...">. A call_... tool-call ID is never a result ref. Pass `queries` with 1-8 narrow searches in one tool round. All results share the 4K round budget.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        queries: {
          type: 'array',
          minItems: 1,
          maxItems: TOOL_RESULT_BATCH_MAX_ITEMS,
          description: 'Preferred batched searches. Each item contains an opaque ref and a narrow query.',
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
      const ledger = readLedger(ctx);
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
    description: 'Read exact bounded chunks only when prior output literally contained <persisted-output ref="...">. A call_... tool-call ID is never a result ref. Pass `chunks` with 1-8 cursors in one tool round. Each chunk is capped at 2K and all chunks share the 4K round budget.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chunks: {
          type: 'array',
          minItems: 1,
          maxItems: TOOL_RESULT_BATCH_MAX_ITEMS,
          description: 'Preferred batched exact reads. Each item contains ref, cursor, and optional maxTokens.',
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
      const ledger = readLedger(ctx);
      const batch = batchItems(input, 'chunks', ['ref', 'cursor']);
      if (batch.error) return batch.error;
      return executeBatch(batch.items, ledger, (item, maxOutputTokens) =>
        executeReadChunkItem(opts, item, ledger, maxOutputTokens));
    },
  };
}

type RetrievalItemResult = { content: string; isError?: true };

function batchItems(
  input: Record<string, unknown>,
  batchKey: 'queries' | 'chunks',
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

function executeBatch(
  items: Record<string, unknown>[],
  ledger: ToolResultReadLedger | null,
  executeItem: (item: Record<string, unknown>, maxOutputTokens: number) => RetrievalItemResult,
): RetrievalItemResult {
  const outputs: string[] = [];
  let successes = 0;
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
    const result = executeItem(item, itemBudget);
    const content = prefixWithinTokenBudget(result.content, itemBudget);
    outputs.push(content);
    remainingOutputTokens = Math.max(
      0,
      remainingOutputTokens - separatorTokens - estimateToolResultTokens(content),
    );
    if (!result.isError) successes++;
  }
  if (!outputs.length) return budgetError();
  return {
    content: outputs.join('\n'),
    ...(successes === 0 ? { isError: true as const } : {}),
  };
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
  if (/^call[_-]/i.test(ref)) {
    return {
      ok: false,
      code: 'E_RESULT_REF_NOT_PERSISTED',
      message:
        'A tool-call ID is not a persisted-output ref. Use only the opaque ref from '
        + '<persisted-output ref="...">; otherwise read the task file/ledger directly.',
    };
  }
  // Accept legacy 64-bit refs plus the current full SHA-256 refs. New writes
  // always use 64 hex chars; compatibility here keeps existing conversations
  // and persisted markers readable after upgrade.
  if (!TOOL_RESULT_REF_RE.test(ref)) {
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
    return { ok: false, code: 'E_RESULT_REF_MISSING', message: 'Tool result no longer exists.' };
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

function readLedger(ctx: ToolContext): ToolResultReadLedger | null {
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
    'The 4K-token persisted-result read budget for this model step is exhausted. Use the excerpts already loaded, continue with another task step, or synthesize the result before reading more.',
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
