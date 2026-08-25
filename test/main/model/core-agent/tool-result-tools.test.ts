import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toToolDefinition, type AgentTool, type ToolContext } from '#core-agent';
import {
  estimateToolResultTokens,
  persistToolResult,
  toolResultRefForPath,
  wrapToolWithCap,
} from '../../../../src/main/util/tool-result-cap';
import {
  TOOL_RESULT_ROUND_MAX_TOKENS,
  TOOL_RESULT_REF_SCHEMA_PATTERN,
  TOOL_RESULT_SEARCH_MAX_TOKENS,
  createToolResultTools,
  resolveToolResultRef,
} from '../../../../src/main/model/core-agent/tool-result-tools';
import { TOOL_RESULT_QUERY_MAX_INPUT_BYTES } from '../../../../src/main/util/tool-result-data';

function getTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function queryRows(content: string): Array<{ group?: Record<string, unknown>; value: number | null }> {
  const match = /<tool-result-query\b[^>]*>\n([^\n]*)\n<\/tool-result-query>/.exec(content);
  if (!match) throw new Error(`missing query payload: ${content}`);
  return JSON.parse(match[1]);
}

describe('persisted tool-result retrieval', () => {
  let dir: string;
  let ref: string;
  let tools: AgentTool[];
  let ctx: ToolContext;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-result-tools-'));
    const content = [
      'alpha preface',
      'needle first important observation',
      'x'.repeat(12_000),
      'needle second important observation',
      'omega ending',
    ].join('\n');
    ref = toolResultRefForPath(persistToolResult(dir, 'web_fetch', content));
    tools = createToolResultTools({ toolResultsDir: dir });
    ctx = {
      state: {
        toolResultReadLedger: {
          epoch: 0,
          remainingTokens: TOOL_RESULT_ROUND_MAX_TOKENS,
          readKeys: new Set<string>(),
        },
      },
    };
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('resolves only valid refs inside the active session', () => {
    expect(ref).toMatch(/^web_fetch\.[a-f0-9]{64}$/);
    expect(resolveToolResultRef(dir, ref)).toMatchObject({ ok: true });
    expect(resolveToolResultRef(dir, '../secret')).toMatchObject({ ok: false, code: 'E_RESULT_REF_INVALID' });
    expect(resolveToolResultRef(dir, 'call_abc123')).toMatchObject({
      ok: false,
      code: 'E_RESULT_REF_NOT_PERSISTED',
    });
    // The refusal carries the retention window and the remedy: a ref can
    // vanish through the 30-day cloud expiry sweep, and the model must know
    // to re-run the tool instead of retrying the ref.
    expect(resolveToolResultRef(dir, 'web_fetch.0000000000000000')).toMatchObject({
      ok: false,
      code: 'E_RESULT_REF_MISSING',
      message: expect.stringMatching(/retained up to 30 days[\s\S]*Re-run the original tool/),
    });
  });

  it('retrieves persisted connector output whose tool name starts with call_', async () => {
    const connectorContent = 'Figma frame title: Checkout\nReview status: needs spacing fix';
    const connectorRef = toolResultRefForPath(
      persistToolResult(dir, 'call_connector_tool', connectorContent),
    );

    expect(connectorRef).toMatch(/^call_connector_tool\.[a-f0-9]{64}$/);
    expect(resolveToolResultRef(dir, connectorRef)).toMatchObject({ ok: true });

    const search = await getTool(tools, 'tool_result').execute({
      action: 'search',
      requests: [{ ref: connectorRef, query: 'Checkout spacing' }],
    }, ctx);
    expect(search.isError).toBeFalsy();
    expect(search.content).toContain('Checkout');

    ctx.state.toolResultReadLedger = {
      epoch: 1,
      remainingTokens: TOOL_RESULT_ROUND_MAX_TOKENS,
      readKeys: new Set<string>(),
    };
    const read = await getTool(tools, 'tool_result').execute({
      action: 'read',
      requests: [{ ref: connectorRef, cursor: 0, max_tokens: 256 }],
    }, ctx);
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('Review status: needs spacing fix');
  });

  it('round-trips an oversized structured connector result through persistence and exact query', async () => {
    const campaigns = [
      ...Array.from({ length: 120 }, (_, index) => ({
        id: `invalid-ph-${index}`,
        status: 'invalid',
        region: 'PH',
        spend: 10,
        diagnostic: 'x'.repeat(160),
      })),
      ...Array.from({ length: 80 }, (_, index) => ({
        id: `invalid-sg-${index}`,
        status: 'invalid',
        region: 'SG',
        spend: 20,
        diagnostic: 'y'.repeat(160),
      })),
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `active-ph-${index}`,
        status: 'active',
        region: 'PH',
        spend: 999,
        diagnostic: 'z'.repeat(160),
      })),
    ];
    const connector = wrapToolWithCap({
      name: 'call_connector_tool',
      description: 'Return a structured connector report',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        return { content: JSON.stringify({ campaigns }) };
      },
    }, {
      maxInlineTokens: 100,
      toolResultsDir: dir,
    });

    const capped = await connector.execute({}, ctx);
    expect(capped.persistedOutput?.ref).toMatch(/^call_connector_tool\.[a-f0-9]{64}$/);
    expect(capped.content).toContain('actions="query,search,read"');
    expect(capped.content).not.toContain('invalid-ph-119');

    const result = await getTool(tools, 'tool_result').execute({
      action: 'query',
      requests: [
        {
          ref: capped.persistedOutput!.ref,
          operation: 'count',
          dataset: 'campaigns',
          filters: [{ field: 'status', op: 'eq', value: 'invalid' }],
        },
        {
          ref: capped.persistedOutput!.ref,
          operation: 'sum',
          dataset: 'campaigns',
          field: 'spend',
          filters: [{ field: 'status', op: 'eq', value: 'invalid' }],
          group_by: ['region'],
        },
      ],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content.match(/<tool-result-query /g)).toHaveLength(2);
    expect(result.content).toContain('[{"value":200}]');
    expect(result.content).toContain('{"group":{"region":"SG"},"value":1600}');
    expect(result.content).toContain('{"group":{"region":"PH"},"value":1200}');
    expect(result.content).not.toContain('diagnostic');
  });

  it('grounds every model-facing ref field to persisted-output syntax after compaction', () => {
    type Schema = {
      description?: string;
      pattern?: string;
      properties?: Record<string, Schema>;
      items?: Schema;
    };
    const definitions = tools.map(toToolDefinition);
    const refs = definitions.map((tool) => {
      const schema = tool.inputSchema as Schema;
      return schema.properties?.requests?.items?.properties?.ref;
    });

    expect(refs).toHaveLength(1);
    for (const schema of refs) {
      expect(schema?.pattern).toBe(TOOL_RESULT_REF_SCHEMA_PATTERN);
      expect(schema?.description).toMatch(/persisted-output/i);
      expect(schema?.description).toMatch(/never use.*call_/i);
      expect(new RegExp(schema!.pattern!).test('call_246')).toBe(false);
      expect(new RegExp(schema!.pattern!).test('grep_files.0123456789abcdef')).toBe(true);
      expect(new RegExp(schema!.pattern!).test('call_connector_tool.0123456789abcdef')).toBe(true);
    }
    for (const tool of definitions) {
      expect(tool.description).toMatch(/call_\.\.\..*never|never.*call_\.\.\./i);
    }
  });

  it('advertises one action-discriminated canonical batch request', async () => {
    expect(tools.map((tool) => tool.name)).toEqual(['tool_result']);
    const schema = getTool(tools, 'tool_result').inputSchema as any;

    expect(schema.required).toEqual(['action', 'requests']);
    expect(schema.properties.action.enum).toEqual(['search', 'query', 'read']);
    expect(schema.properties.requests.items.additionalProperties).toBe(false);

    const invalid = await getTool(tools, 'tool_result').execute({
      action: 'unknown',
      requests: [{ ref }],
    }, ctx);
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain('E_BAD_INPUT');
  });

  it('rejects action-specific request shapes without consuming the retrieval ledger', async () => {
    const tool = getTool(tools, 'tool_result');
    const invalidSearch = await tool.execute({
      action: 'search',
      requests: [{ ref, cursor: 0 }],
    }, ctx);
    const invalidRead = await tool.execute({
      action: 'read',
      requests: [{ ref, query: 'needle important' }],
    }, ctx);
    const invalidQuery = await tool.execute({
      action: 'query',
      requests: [{ ref }],
    }, ctx);

    expect(invalidSearch).toMatchObject({ isError: true });
    expect(invalidSearch.content).toContain('`ref` and `query` are required');
    expect(invalidRead).toMatchObject({ isError: true });
    expect(invalidRead.content).toContain('non-negative integer `cursor`');
    expect(invalidQuery).toMatchObject({ isError: true });
    expect(invalidQuery.content).toContain('`ref` and `operation` are required');
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(0);
  });

  it('rejects an oversized batch before reading or partially disclosing any result', async () => {
    const result = await getTool(tools, 'tool_result').execute({
      action: 'search',
      requests: Array.from({ length: 9 }, (_, index) => ({ ref, query: `needle ${index}` })),
    }, ctx);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('1-8 requests');
    expect(result.content).not.toContain('important observation');
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(0);
  });

  it('keeps legacy 16-hex refs readable while new writes use full SHA-256 refs', () => {
    const legacyRef = 'bash.1111111111111111';
    fs.writeFileSync(path.join(dir, `${legacyRef}.txt`), 'legacy result');
    expect(resolveToolResultRef(dir, legacyRef)).toMatchObject({ ok: true });
    expect(TOOL_RESULT_SEARCH_MAX_TOKENS).toBe(2_000);
  });

  it('searches for narrow excerpts without returning the whole result', async () => {
    const result = await getTool(tools, 'tool_result').execute({
      action: 'search',
      requests: [{ ref, query: 'needle important' }],
    }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<tool-result-search');
    expect(result.content).toContain('needle first important observation');
    expect(result.content).toContain('</tool-result-search>');
    expect(result.content.length).toBeLessThan(12_000);
  });

  it('searches multiple narrow queries in one tool round under the shared budget', async () => {
    const result = await getTool(tools, 'tool_result').execute({
      action: 'search',
      requests: [
        { ref, query: 'alpha preface' },
        { ref, query: 'omega ending' },
      ],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content.match(/<tool-result-search /g)).toHaveLength(2);
    expect(result.content).toContain('alpha preface');
    expect(result.content).toContain('omega ending');
    expect(estimateToolResultTokens(result.content)).toBeLessThanOrEqual(TOOL_RESULT_ROUND_MAX_TOKENS);
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(2);
  });

  it('canonicalizes reordered search terms and reports a duplicate inside a batch', async () => {
    const result = await getTool(tools, 'tool_result').execute({
      action: 'search',
      requests: [
        { ref, query: 'needle important' },
        { ref, query: ' IMPORTANT   needle ' },
      ],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content.match(/<tool-result-search /g)).toHaveLength(1);
    expect(result.content).toContain('E_RESULT_CHUNK_ALREADY_READ');
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(1);
  });

  it('computes exact filtered and grouped aggregates without returning the source records', async () => {
    const structured = JSON.stringify({
      campaigns: [
        { status: 'invalid', region: 'PH', spend: 10, metrics: { clicks: 2 } },
        { status: 'active', region: 'PH', spend: 20, metrics: { clicks: 4 } },
        { status: 'invalid', region: 'SG', spend: 5, metrics: { clicks: 1 } },
        { status: 'invalid', region: 'PH', spend: 25, metrics: { clicks: 5 } },
        { status: 'invalid', region: 'SG', spend: null, metrics: { clicks: 0 } },
      ],
      archived: [{ status: 'invalid', region: 'PH', spend: 999 }],
      padding: 'private-source-padding-'.repeat(4_000),
    });
    const structuredRef = toolResultRefForPath(persistToolResult(dir, 'connector', structured));
    const tool = getTool(tools, 'tool_result');

    const missingDataset = await tool.execute({
      action: 'query',
      requests: [{ ref: structuredRef, operation: 'count' }],
    }, ctx);
    expect(missingDataset).toMatchObject({ isError: true });
    expect(missingDataset.content).toContain('E_RESULT_QUERY_DATASET');
    expect(missingDataset.content).toContain('campaigns');
    expect(missingDataset.content).toContain('archived');

    const count = await tool.execute({
      action: 'query',
      requests: [{
        ref: structuredRef,
        operation: 'count',
        dataset: 'campaigns',
        filters: [{ field: 'status', op: 'eq', value: 'invalid' }],
      }],
    }, ctx);
    expect(count.isError).toBeFalsy();
    expect(count.content).toContain('unit="records"');
    expect(count.content).toContain('scanned="5"');
    expect(count.content).toContain('matched="4"');
    expect(queryRows(count.content)).toEqual([{ value: 4 }]);
    expect(count.content).not.toContain('private-source-padding');

    const grouped = await tool.execute({
      action: 'query',
      requests: [{
        ref: structuredRef,
        operation: 'sum',
        dataset: 'campaigns',
        field: 'spend',
        filters: [{ field: 'status', op: 'eq', value: 'invalid' }],
        group_by: ['region'],
      }],
    }, ctx);
    expect(grouped.isError).toBeFalsy();
    expect(queryRows(grouped.content)).toEqual([
      { group: { region: 'PH' }, value: 35 },
      { group: { region: 'SG' }, value: 5 },
    ]);
  });

  it('returns exact, explicitly labelled text counts and refuses unsupported calculations', async () => {
    const textRef = toolResultRefForPath(persistToolResult(
      dir,
      'bash',
      'error on first line\nclean line\nERROR twice: error\n',
    ));
    const tool = getTool(tools, 'tool_result');
    const matchingLines = await tool.execute({
      action: 'query',
      requests: [{
        ref: textRef,
        operation: 'count',
        match: 'error',
        count_unit: 'matching_lines',
      }],
    }, ctx);
    expect(matchingLines.isError).toBeFalsy();
    expect(matchingLines.content).toContain('unit="matching_lines"');
    expect(queryRows(matchingLines.content)).toEqual([{ value: 2 }]);

    const occurrences = await tool.execute({
      action: 'query',
      requests: [{
        ref: textRef,
        operation: 'count',
        match: 'error',
        count_unit: 'occurrences',
      }],
    }, ctx);
    expect(occurrences.isError).toBeFalsy();
    expect(occurrences.content).toContain('unit="occurrences"');
    expect(queryRows(occurrences.content)).toEqual([{ value: 3 }]);

    const ambiguousCount = await tool.execute({
      action: 'query',
      requests: [{ ref: textRef, operation: 'count' }],
    }, ctx);
    expect(ambiguousCount).toMatchObject({ isError: true });
    expect(ambiguousCount.content).toContain('E_RESULT_COUNT_UNIT_REQUIRED');
    expect(ambiguousCount.content).not.toContain('<tool-result-query');

    const unsupported = await tool.execute({
      action: 'query',
      requests: [{ ref: textRef, operation: 'sum', field: 'amount' }],
    }, ctx);
    expect(unsupported).toMatchObject({ isError: true });
    expect(unsupported.content).toContain('E_RESULT_NOT_QUERYABLE');
    expect(unsupported.content).not.toContain('<tool-result-query');
  });

  it('batches independent deterministic queries in one tool round', async () => {
    const batchRef = toolResultRefForPath(persistToolResult(
      dir,
      'connector',
      JSON.stringify([
        { state: 'active', amount: 4 },
        { state: 'paused', amount: 9 },
        { state: 'active', amount: 7 },
      ]),
    ));
    const result = await getTool(tools, 'tool_result').execute({
      action: 'query',
      requests: [
        {
          ref: batchRef,
          operation: 'count',
          filters: [{ field: 'state', op: 'eq', value: 'active' }],
        },
        { ref: batchRef, operation: 'sum', field: 'amount' },
      ],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content.match(/<tool-result-query /g)).toHaveLength(2);
    expect(result.content).toContain('[{"value":2}]');
    expect(result.content).toContain('[{"value":20}]');
    expect(estimateToolResultTokens(result.content)).toBeLessThanOrEqual(TOOL_RESULT_ROUND_MAX_TOKENS);
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(2);
  });

  it('returns zero for an exact structured count with no matching records', async () => {
    const emptyMatchRef = toolResultRefForPath(persistToolResult(
      dir,
      'connector',
      JSON.stringify([{ status: 'active' }, { status: 'paused' }]),
    ));
    const result = await getTool(tools, 'tool_result').execute({
      action: 'query',
      requests: [{
        ref: emptyMatchRef,
        operation: 'count',
        filters: [{ field: 'status', op: 'eq', value: 'missing' }],
      }],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('matched="0"');
    expect(queryRows(result.content)).toEqual([{ value: 0 }]);
  });

  it('rejects deterministic aggregation above the input cap before parsing the file', async () => {
    const oversizedRef = `bash.${'a'.repeat(64)}`;
    const oversizedPath = path.join(dir, `${oversizedRef}.txt`);
    fs.closeSync(fs.openSync(oversizedPath, 'w'));
    fs.truncateSync(oversizedPath, TOOL_RESULT_QUERY_MAX_INPUT_BYTES + 1);

    const result = await getTool(tools, 'tool_result').execute({
      action: 'query',
      requests: [{ ref: oversizedRef, operation: 'count', match: 'error', count_unit: 'occurrences' }],
    }, ctx);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('E_RESULT_QUERY_TOO_LARGE');
    expect(result.content).toMatch(/search or paged read/);
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(0);
  });

  it('keeps the main event loop responsive while querying the maximum record count', async () => {
    const records = Array.from({ length: 250_000 }, () => ({ amount: 1 }));
    const maximumRecordsRef = toolResultRefForPath(persistToolResult(
      dir,
      'connector',
      JSON.stringify(records),
    ));
    const mainLoopHeartbeat = new Promise<void>((resolve) => setImmediate(resolve));
    let settled = false;
    const pending = getTool(tools, 'tool_result').execute({
      action: 'query',
      requests: [{ ref: maximumRecordsRef, operation: 'sum', field: 'amount' }],
    }, ctx).finally(() => { settled = true; });

    await mainLoopHeartbeat;
    expect(settled).toBe(false);

    const result = await pending;
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('scanned="250000"');
    expect(queryRows(result.content)).toEqual([{ value: 250_000 }]);
  });

  it('terminates an in-flight query worker when the tool context is aborted', async () => {
    const records = Array.from({ length: 250_000 }, (_, index) => ({
      amount: index % 17,
      region: index % 2 ? 'PH' : 'SG',
    }));
    const cancellableRef = toolResultRefForPath(persistToolResult(
      dir,
      'connector',
      JSON.stringify(records),
    ));
    const controller = new AbortController();
    const cancellableCtx: ToolContext = { ...ctx, signal: controller.signal };
    const pending = getTool(tools, 'tool_result').execute({
      action: 'query',
      requests: [{
        ref: cancellableRef,
        operation: 'sum',
        field: 'amount',
        group_by: ['region'],
      }],
    }, cancellableCtx);

    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(0);
  });

  it('returns a bounded recovery error when the off-thread query boundary fails', async () => {
    const failedTools = createToolResultTools({
      toolResultsDir: dir,
      async queryExecutor() {
        throw new Error('private worker detail');
      },
    });
    const result = await getTool(failedTools, 'tool_result').execute({
      action: 'query',
      requests: [{ ref, operation: 'count', match: 'needle', count_unit: 'occurrences' }],
    }, ctx);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('E_RESULT_QUERY_READ');
    expect(result.content).toMatch(/Re-run the original tool/);
    expect(result.content).not.toContain('private worker detail');
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(0);
  });

  it('reads an exact bounded chunk and returns a continuation cursor', async () => {
    const result = await getTool(tools, 'tool_result').execute({
      action: 'read',
      requests: [{ ref, cursor: 0, max_tokens: 9_000 }],
    }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('covered="0-');
    expect(result.content).toMatch(/next_cursor="\d+"/);
    expect(result.content).toContain('</tool-result-chunk>');
    expect(estimateToolResultTokens(result.content)).toBeLessThanOrEqual(2_000);
  });

  it('reads multiple exact chunks in one tool round under the shared budget', async () => {
    const result = await getTool(tools, 'tool_result').execute({
      action: 'read',
      requests: [
        { ref, cursor: 0, max_tokens: 2_000 },
        { ref, cursor: 10_000, max_tokens: 2_000 },
      ],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content.match(/<tool-result-chunk /g)).toHaveLength(2);
    expect(result.content).toContain('covered="0-');
    expect(result.content).toContain('covered="10000-');
    expect(estimateToolResultTokens(result.content)).toBeLessThanOrEqual(TOOL_RESULT_ROUND_MAX_TOKENS);
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(2);
  });

  it('shares the aggregate budget across every requested chunk instead of dropping the batch tail', async () => {
    const result = await getTool(tools, 'tool_result').execute({
      action: 'read',
      requests: [0, 3_000, 6_000, 9_000].map((cursor) => ({ ref, cursor, max_tokens: 2_000 })),
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content.match(/<tool-result-chunk /g)).toHaveLength(4);
    expect(estimateToolResultTokens(result.content)).toBeLessThanOrEqual(TOOL_RESULT_ROUND_MAX_TOKENS);
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(4);
  });

  it('keeps successful batch items when another persisted-result request is invalid', async () => {
    const result = await getTool(tools, 'tool_result').execute({
      action: 'search',
      requests: [
        { ref: '../invalid', query: 'needle' },
        { ref, query: 'omega ending' },
      ],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('E_RESULT_REF_INVALID');
    expect(result.content).toContain('omega ending');
  });

  it('searches and reads correctly across a 64KB UTF-8 scan boundary', async () => {
    const content = `${'a'.repeat(65_535)}界needle-after-boundary\nomega`;
    const boundaryRef = toolResultRefForPath(persistToolResult(dir, 'bash', content));
    const search = await getTool(tools, 'tool_result').execute({
      action: 'search',
      requests: [{ ref: boundaryRef, query: '界needle' }],
    }, ctx);
    expect(search.isError).toBeFalsy();
    expect(search.content).toContain('界needle-after-boundary');
    expect(search.content).toContain(`total_chars="${content.length}"`);

    const chunk = await getTool(tools, 'tool_result').execute({
      action: 'read',
      requests: [{ ref: boundaryRef, cursor: 65_534, max_tokens: 256 }],
    }, ctx);
    expect(chunk.isError).toBeFalsy();
    expect(chunk.content).toContain('a界needle-after-boundary');
    expect(chunk.content).toContain(`total_chars="${content.length}"`);
  });

  it('suppresses duplicate reads in the same compaction epoch', async () => {
    const tool = getTool(tools, 'tool_result');
    await tool.execute({ action: 'read', requests: [{ ref, cursor: 0, max_tokens: 300 }] }, ctx);
    const duplicate = await tool.execute({ action: 'read', requests: [{ ref, cursor: 0, max_tokens: 300 }] }, ctx);
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toContain('E_RESULT_CHUNK_ALREADY_READ');
  });

  it('enforces the aggregate per-round read budget', async () => {
    const ledger = ctx.state.toolResultReadLedger as { remainingTokens: number };
    ledger.remainingTokens = 100;
    const result = await getTool(tools, 'tool_result').execute({
      action: 'read',
      requests: [{ ref, cursor: 0, max_tokens: 300 }],
    }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_RESULT_READ_BUDGET');
  });
});
