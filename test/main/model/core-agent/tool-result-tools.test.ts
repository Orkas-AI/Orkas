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
  let materializeDir: string;
  let ref: string;
  let tools: AgentTool[];
  let ctx: ToolContext;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-result-tools-'));
    materializeDir = path.join(dir, 'analysis-inputs');
    const content = [
      'alpha preface',
      'needle first important observation',
      'x'.repeat(12_000),
      'needle second important observation',
      'omega ending',
    ].join('\n');
    ref = toolResultRefForPath(persistToolResult(dir, 'web_fetch', content));
    tools = createToolResultTools({
      toolResultsDir: dir,
      materializeDir,
      isProgrammaticToolCallContext: () => false,
    });
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

  it('retains exact partial failures before truncation without confusing quoted source errors', async () => {
    const quoted = '<tool-error code="E_RESULT_READ_BUDGET">source quotation</tool-error>';
    const quotedRef = toolResultRefForPath(persistToolResult(dir, 'fixture', quoted));
    const tool = getTool(tools, 'tool_result');
    const result = await tool.execute({ action: 'read', requests: [
      { ref: quotedRef, cursor: 0 }, { ref: 'fixture.0000000000000000', cursor: 0 },
    ] }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain(quoted);
    expect(result.observations?.resultRetrievalBatch).toEqual({
      requested: 2, attempted: 2, succeeded: 1, failed: 1, skipped: 0,
      failures: [{ index: 1, code: 'E_RESULT_REF_MISSING' }],
    });
    expect(result.content).not.toContain('resultRetrievalBatch');
    (ctx.state.toolResultReadLedger as { remainingTokens: number }).remainingTokens = 0;
    const exhausted = await tool.execute({ action: 'read', requests: [
      { ref, cursor: 0 }, { ref, cursor: 100 },
    ] }, ctx);
    expect(exhausted.isError).toBe(true);
    expect(exhausted.observations?.resultRetrievalBatch).toMatchObject({
      requested: 2, attempted: 0, succeeded: 0, failed: 0, skipped: 2,
    });
  });

  it('exposes unvalidated source semantics before local arithmetic without coercing missing, null or zero', async () => {
    const source = JSON.stringify([{ on_hand: null, reserved: 2 }, { reserved: 2 },
      { on_hand: 0, reserved: 0 }, { on_hand: 5, reserved: 2 },
      { on_hand: '5', reserved: false }, { inventory: null }]);
    const sourceRef = toolResultRefForPath(persistToolResult(dir, 'inventory', source));
    const result = await getTool(tools, 'tool_result').execute({
      action: 'materialize', requests: [{ ref: sourceRef }],
    }, ctx);
    expect(result.isError).toBeFalsy();
    const receipt = JSON.parse(result.content);
    // Copying preserves facts but does not validate them for arithmetic. The
    // model needs that boundary with the copy, not in its resident instructions.
    expect(receipt.dataContract).toMatchObject({ sourceBytes: 'unchanged', validation: 'not-performed' });
    expect(receipt.dataContract.calculation).toMatch(/before arithmetic/i);
    expect(receipt.dataContract.calculation).toMatch(/structure.*types/i);
    expect(receipt.dataContract.calculation).toMatch(/containers.*not empty collections/i);
    expect(receipt.dataContract.calculation).toMatch(/missing.*null.*zero/i);
    expect(receipt.dataContract.calculation).toMatch(/task.*rules/i);
    const content = fs.readFileSync(receipt.files[0].path, 'utf8');
    expect(content).toBe(source);
    const rows = JSON.parse(content);
    expect(rows[0].on_hand).toBeNull();
    expect(Object.hasOwn(rows[1], 'on_hand')).toBe(false);
    expect(rows[2].on_hand).toBe(0);
    expect(rows[4]).toEqual({ on_hand: '5', reserved: false });
    expect(rows[5].inventory).toBeNull();
    const excerpt = await getTool(tools, 'tool_result').execute({
      action: 'read', requests: [{ ref: sourceRef, cursor: 0 }],
    }, ctx);
    expect(excerpt.content).not.toContain('dataContract');
  });

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
    expect(capped.content).toContain('actions="query,search,read,materialize"');
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

  it('round-trips an exploded nested-array query through the canonical tool contract', async () => {
    const structuredRef = toolResultRefForPath(persistToolResult(
      dir,
      'call_connector_tool',
      JSON.stringify({
        campaigns: [
          {
            campaign_id: 'c-1',
            metrics_list: [
              { date: '2026-08-01', expense: 2 },
              { date: '2026-08-02', expense: 3 },
            ],
          },
          {
            campaign_id: 'c-2',
            metrics_list: [{ date: '2026-08-01', expense: 7 }],
          },
        ],
      }),
    ));
    const tool = getTool(tools, 'tool_result');
    const result = await tool.execute({
      action: 'query',
      requests: [{
        ref: structuredRef,
        operation: 'sum',
        dataset: 'campaigns',
        explode: 'metrics_list',
        field: '$item.expense',
        filters: [{ field: '$item.date', op: 'eq', value: '2026-08-01' }],
        group_by: ['$parent.campaign_id'],
      }],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('explode="metrics_list"');
    expect(result.content).toContain('scanned="3"');
    expect(queryRows(result.content)).toEqual([
      { group: { '$parent.campaign_id': 'c-2' }, value: 7 },
      { group: { '$parent.campaign_id': 'c-1' }, value: 2 },
    ]);
  });

  it('explains record-relative explode syntax at the provider boundary', () => {
    const schema = toToolDefinition(getTool(tools, 'tool_result')).inputSchema as any;
    const structured = schema.properties.requests.items.oneOf.find(
      (shape: any) => shape.properties.explode,
    );
    const description = structured.properties.explode.description;
    expect(description).toMatch(/record-relative/i);
    expect(description).toMatch(/no dataset prefix or \[\]/i);
    expect(structured.description).toMatch(/With explode, field, filters.field and group_by/);
    expect(structured.description).toMatch(/\$item\.<field>[\s\S]*\$parent\.<field>[\s\S]*\$index/);
    expect(structured.description).toContain('scalar items use $item');
    expect(description).not.toContain('Subsequent paths');
  });

  it.each(['field', 'filter', 'group'])(
    'rejects an unscoped %s after explode instead of guessing between parent and item fields', async (target) => {
      const source = JSON.stringify({ items: [{ amount: 100, region: 'parent', models: [
        { amount: 2, region: 'child' }, { amount: 3, region: 'child' },
      ] }] });
      const resultPath = persistToolResult(dir, 'catalog', source);
      const request = { ref: toolResultRefForPath(resultPath), operation: 'sum', explode: 'models',
        field: target === 'field' ? 'amount' : '$item.amount',
        filters: [{ field: target === 'filter' ? 'region' : '$parent.region', op: 'eq', value: 'parent' }],
        group_by: [target === 'group' ? 'region' : '$item.region'],
      };
      const tool = getTool(tools, 'tool_result');
      const failed = await tool.execute({ action: 'query', requests: [request] }, ctx);
      expect(failed.isError).toBe(true);
      expect(failed.content).toContain('E_RESULT_QUERY_FIELD');
      expect(failed.content).toContain('$parent.region');
      expect(failed.content).toContain('$item.amount');
      const recovered = await tool.execute({ action: 'query', requests: [{ ...request,
        field: '$item.amount', filters: [{ field: '$parent.region', op: 'eq', value: 'parent' }], group_by: ['$item.region'],
      }] }, ctx);
      expect(recovered.isError).toBeFalsy();
      expect(queryRows(recovered.content)).toEqual([{ group: { '$item.region': 'child' }, value: 5 }]);
      expect(fs.readFileSync(resultPath, 'utf8')).toBe(source);
      expect(fs.existsSync(materializeDir)).toBe(false);
    },
  );

  it.each(['items.models[]', 'items.models', 'models[]'])(
    'preserves partial query failures for %s and recovers with the advertised relative path', async (explode) => {
      // Preserve the real incident's four-request batch and explicit recovery.
      // Unequal parent/child counts and a paused parent detect wrong-grain totals.
      const source = JSON.stringify({ items: [
        { listing_status: 'NORMAL', models: [{ enabled: true }, { enabled: false }] },
        { listing_status: 'NORMAL', models: [{ enabled: true }] },
        { listing_status: 'PAUSED', models: [{ enabled: true }] },
      ] });
      const sourcePath = persistToolResult(dir, 'large_sales_export', source);
      const sourceRef = toolResultRefForPath(sourcePath);
      const tool = getTool(tools, 'tool_result');
      const filters = [
        { field: '$parent.listing_status', op: 'eq', value: 'NORMAL' },
        { field: '$item.enabled', op: 'eq', value: true },
      ];
      const request = { ref: sourceRef, dataset: 'items', operation: 'count' };
      const failed = await tool.execute({ action: 'query', requests: [
        request, { ...request, group_by: ['listing_status'] },
        { ...request, explode }, { ...request, explode, filters },
      ] }, ctx);
      expect(failed.isError).toBeFalsy();
      expect(failed.observations?.resultRetrievalBatch).toEqual({
        requested: 4, attempted: 4, succeeded: 2, failed: 2, skipped: 0,
        failures: [2, 3].map((index) => ({ index, code: 'E_RESULT_QUERY_EXPLODE' })),
      });
      expect(queryRows(failed.content)).toEqual([{ value: 3 }]);
      expect(failed.content).toContain('Available array fields: models');
      expect(failed.content.match(/<tool-result-query /g)).toHaveLength(2);

      const recovered = await tool.execute({ action: 'query', requests: [
        { ...request, explode: 'models' },
        { ...request, explode: 'models', filters },
        { ...request, explode: 'models', group_by: ['$item.enabled'] },
      ] }, ctx);
      expect(recovered.isError).toBeFalsy();
      expect(recovered.observations?.resultRetrievalBatch).toEqual({
        requested: 3, attempted: 3, succeeded: 3, failed: 0, skipped: 0, failures: [],
      });
      const payloads = [...recovered.content.matchAll(/<tool-result-query\b[^>]*>\n([^\n]*)\n<\/tool-result-query>/g)]
        .map((match) => JSON.parse(match[1]));
      expect(payloads).toEqual([
        [{ value: 4 }], [{ value: 2 }],
        [{ group: { '$item.enabled': true }, value: 3 }, { group: { '$item.enabled': false }, value: 1 }],
      ]);
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe(source);
      expect(fs.existsSync(materializeDir)).toBe(false);
    },
  );

  it('treats different explode paths as distinct deterministic queries', async () => {
    const structuredRef = toolResultRefForPath(persistToolResult(
      dir,
      'call_connector_tool',
      JSON.stringify([{ primary: [1, 2], secondary: [10, 20] }]),
    ));
    const result = await getTool(tools, 'tool_result').execute({
      action: 'query',
      requests: [
        {
          ref: structuredRef,
          operation: 'sum',
          explode: 'primary',
          field: '$item',
        },
        {
          ref: structuredRef,
          operation: 'sum',
          explode: 'secondary',
          field: '$item',
        },
      ],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content.match(/<tool-result-query /g)).toHaveLength(2);
    expect(result.content).toContain('explode="primary"');
    expect(result.content).toContain('[{"value":3}]');
    expect(result.content).toContain('explode="secondary"');
    expect(result.content).toContain('[{"value":30}]');
    expect(result.content).not.toContain('E_RESULT_CHUNK_ALREADY_READ');
  });

  it('grounds every model-facing ref field to persisted-output syntax after compaction', () => {
    type Schema = {
      description?: string;
      pattern?: string;
      properties?: Record<string, Schema>;
      items?: Schema;
      oneOf?: Schema[];
    };
    const definitions = tools.map(toToolDefinition);
    const refs: Schema[] = [];
    const visit = (schema: Schema | undefined) => {
      if (!schema) return;
      if (schema.properties?.ref) refs.push(schema.properties.ref);
      for (const property of Object.values(schema.properties ?? {})) visit(property);
      visit(schema.items);
      for (const branch of schema.oneOf ?? []) visit(branch);
    };
    for (const tool of definitions) visit(tool.inputSchema as Schema);

    // search, structured aggregate, text count, read, materialize: one ref each.
    expect(refs).toHaveLength(5);
    for (const schema of refs) {
      expect(schema.pattern).toBe(TOOL_RESULT_REF_SCHEMA_PATTERN);
      expect(schema.description).toMatch(/persisted-output/i);
      expect(schema.description).toMatch(/never use.*call_/i);
      expect(new RegExp(schema.pattern!).test('call_246')).toBe(false);
      expect(new RegExp(schema.pattern!).test('grep_files.0123456789abcdef')).toBe(true);
      expect(new RegExp(schema.pattern!).test('call_connector_tool.0123456789abcdef')).toBe(true);
    }
    for (const tool of definitions) {
      expect(tool.description).toMatch(/call_\.\.\..*never|never.*call_\.\.\./i);
    }
  });

  it('advertises one action-discriminated canonical batch request', async () => {
    expect(tools.map((tool) => tool.name)).toEqual(['tool_result']);
    const schema = getTool(tools, 'tool_result').inputSchema as any;
    const branches = Object.fromEntries(schema.oneOf.map((branch: any) => [
      branch.properties.action.enum[0], branch,
    ]));

    expect(schema.required).toEqual(['action', 'requests']);
    expect(schema.properties.action.enum).toEqual(['search', 'query', 'read', 'materialize']);
    // The action branches only bind `action`; the request shapes are advertised
    // once as the `requests.items` union (the per-action pairing is enforced at
    // runtime, see the rejected-shape case below).
    expect(Object.keys(branches).sort()).toEqual(['materialize', 'query', 'read', 'search']);
    for (const branch of Object.values(branches) as any[]) {
      expect(Object.keys(branch.properties)).toEqual(['action']);
    }
    const shapes = schema.properties.requests.items.oneOf as any[];
    expect(shapes).toHaveLength(5);
    const byKeys = (keys: string[]) => shapes.find(
      (shape) => JSON.stringify(Object.keys(shape.properties).sort()) === JSON.stringify([...keys].sort()),
    );
    expect(byKeys(['ref', 'query'])).toBeTruthy();
    expect(byKeys(['ref', 'cursor', 'max_tokens'])).toBeTruthy();
    expect(byKeys(['ref'])).toBeTruthy();
    const structured = shapes.find((shape) => shape.properties.operation?.enum?.includes('sum'));
    const textCount = shapes.find((shape) => shape.properties.match);
    expect(structured.properties.operation.enum).toEqual(['count', 'sum', 'average', 'minimum', 'maximum']);
    expect(structured.required).toEqual(['ref', 'operation']);
    expect(structured.properties).not.toHaveProperty('match');
    expect(structured.properties).not.toHaveProperty('count_unit');
    expect(structured.description)
      .toMatch(/\$item[\s\S]*\$parent[\s\S]*\$index/);
    expect(textCount.required).toEqual(['ref', 'operation', 'match', 'count_unit']);
    expect(textCount.properties).not.toHaveProperty('dataset');
    expect(getTool(tools, 'tool_result').description).toMatch(/at most one tool_result call per model step/i);
    expect(branches.materialize.properties.action.description)
      .toMatch(/full-data calculations.*query cannot express/);
    expect(branches.read.properties.action.description).toMatch(/source excerpts/);
    expect(branches.read.properties.action.description).not.toMatch(/query\/search cannot answer/);

    const invalid = await getTool(tools, 'tool_result').execute({
      action: 'unknown',
      requests: [{ ref }],
    }, ctx);
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain('E_BAD_INPUT');
  });

  it('materializes exact session-scoped working copies without spending the retrieval budget', async () => {
    const originalPath = resolveToolResultRef(dir, ref);
    if (!originalPath.ok) throw new Error(originalPath.message);
    const original = fs.readFileSync(originalPath.path, 'utf8');
    const ledger = ctx.state.toolResultReadLedger as {
      remainingTokens: number;
      readKeys: Set<string>;
    };

    const result = await getTool(tools, 'tool_result').execute({
      action: 'materialize',
      requests: [{ ref }],
    }, ctx);

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content) as {
      files: Array<{ ref: string; path: string; bytes: number; encoding: string }>;
    };
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]).toMatchObject({
      ref,
      bytes: Buffer.byteLength(original, 'utf8'),
      encoding: 'utf8',
    });
    expect(path.dirname(payload.files[0].path)).toBe(fs.realpathSync(materializeDir));
    expect(fs.readFileSync(payload.files[0].path, 'utf8')).toBe(original);
    expect(ledger.remainingTokens).toBe(TOOL_RESULT_ROUND_MAX_TOKENS);
    expect(ledger.readKeys.size).toBe(0);
  });

  it('reuses the working copy when the same ref is materialized again', async () => {
    // Persisted results are write-once, so a repeat materialize in a long
    // session used to stack identical copies until the conversation was
    // deleted; the copy is keyed by ref and reused, while a different ref and a
    // damaged copy still get their own fresh file.
    const tool = getTool(tools, 'tool_result');
    const first = JSON.parse((await tool.execute({ action: 'materialize', requests: [{ ref }] }, ctx)).content);
    const second = JSON.parse((await tool.execute({ action: 'materialize', requests: [{ ref }] }, ctx)).content);
    expect(second.files[0].path).toBe(first.files[0].path);
    expect(fs.readdirSync(materializeDir)).toHaveLength(1);

    const otherRef = toolResultRefForPath(persistToolResult(dir, 'web_search', 'other result body'));
    const other = JSON.parse((await tool.execute({ action: 'materialize', requests: [{ ref: otherRef }] }, ctx)).content);
    expect(other.files[0].path).not.toBe(first.files[0].path);
    expect(fs.readdirSync(materializeDir)).toHaveLength(2);

    // A copy that no longer matches its source size (an interrupted copy) is
    // replaced rather than handed back.
    const original = fs.readFileSync(first.files[0].path, 'utf8');
    fs.writeFileSync(first.files[0].path, original.slice(0, 10));
    const repaired = JSON.parse((await tool.execute({ action: 'materialize', requests: [{ ref }] }, ctx)).content);
    expect(repaired.files[0].path).toBe(first.files[0].path);
    expect(fs.readFileSync(repaired.files[0].path, 'utf8')).toBe(original);
    expect(fs.readdirSync(materializeDir)).toHaveLength(2);
  });

  it('validates every materialize ref before writing any file', async () => {
    const result = await getTool(tools, 'tool_result').execute({
      action: 'materialize',
      requests: [
        { ref },
        { ref: 'web_fetch.0000000000000000' },
      ],
    }, ctx);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('E_RESULT_REF_MISSING');
    expect(fs.existsSync(materializeDir)).toBe(false);

    const escaped = await getTool(tools, 'tool_result').execute({
      action: 'materialize',
      requests: [{ ref: '../secret' }],
    }, ctx);
    expect(escaped).toMatchObject({ isError: true });
    expect(escaped.content).toContain('E_RESULT_REF_INVALID');
    expect(fs.existsSync(materializeDir)).toBe(false);
  });

  it.each(['edited', 'symlink', 'hardlink'] as const)('refreshes a materialized %s without changing its source or link target', async (kind) => {
    const tool = getTool(tools, 'tool_result');
    const originalPath = resolveToolResultRef(dir, ref);
    if (!originalPath.ok) throw new Error(originalPath.message);
    const original = fs.readFileSync(originalPath.path);
    const first = JSON.parse((await tool.execute({ action: 'materialize', requests: [{ ref }] }, ctx)).content);
    const destination: string = first.files[0].path;
    const foreign = path.join(dir, 'foreign.txt');
    const changed = kind === 'hardlink' ? original : Buffer.alloc(original.length, 'z');
    fs.writeFileSync(foreign, changed);
    if (kind === 'edited') fs.writeFileSync(destination, changed);
    else {
      fs.unlinkSync(destination);
      if (kind === 'symlink') fs.symlinkSync(foreign, destination);
      else fs.linkSync(foreign, destination);
    }
    const result = await tool.execute({ action: 'materialize', requests: [{ ref }] }, ctx);
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content);
    expect(payload.files[0].path).toBe(destination);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(destination).nlink).toBe(1);
    expect(fs.readFileSync(destination)).toEqual(original);
    expect(fs.readFileSync(foreign)).toEqual(changed);
    expect(fs.readFileSync(originalPath.path)).toEqual(original);
  });

  it('publishes one intact working copy for concurrent requests for the same ref', async () => {
    const tool = getTool(tools, 'tool_result');
    const results = await Promise.all(Array.from({ length: 4 }, () => (
      tool.execute({ action: 'materialize', requests: [{ ref }] }, ctx)
    )));
    for (const result of results) expect(result.isError).toBeFalsy();
    const paths = results.map((result) => JSON.parse(result.content).files[0].path as string);
    expect(new Set(paths).size).toBe(1);
    const original = resolveToolResultRef(dir, ref);
    if (!original.ok) throw new Error(original.message);
    expect(fs.readFileSync(paths[0])).toEqual(fs.readFileSync(original.path));
    expect(fs.readdirSync(materializeDir)).toHaveLength(1);
  });

  it('returns a sanitized error when the materialize root cannot be created', async () => {
    fs.writeFileSync(materializeDir, 'blocked');
    const result = await getTool(tools, 'tool_result').execute({
      action: 'materialize',
      requests: [{ ref }],
    }, ctx);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain('E_RESULT_MATERIALIZE_WRITE');
    expect(result.content).not.toContain(materializeDir);
  });

  it('rejects action-specific request shapes without consuming the retrieval ledger', async () => {
    const tool = getTool(tools, 'tool_result');
    const invalidSearch = await tool.execute({
      action: 'search',
      requests: [{ ref }],
    }, ctx);
    const invalidRead = await tool.execute({
      action: 'read',
      requests: [{ ref }],
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

  it('rejects fields from another action even when the selected request is otherwise complete', async () => {
    const tool = getTool(tools, 'tool_result');
    const invalidSearch = await tool.execute({
      action: 'search',
      requests: [{ ref, query: 'needle', cursor: 0 }],
    }, ctx);
    const invalidRead = await tool.execute({
      action: 'read',
      requests: [{ ref, cursor: 0, query: 'needle' }],
    }, ctx);
    const invalidMaterialize = await tool.execute({
      action: 'materialize',
      requests: [{ ref, max_tokens: 500 }],
    }, ctx);

    for (const result of [invalidSearch, invalidRead, invalidMaterialize]) {
      expect(result).toMatchObject({ isError: true });
      expect(result.content).toContain('unsupported field(s)');
    }
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
    expect(result.content).toContain('materialize');
    expect(result.content).toContain('search or paged read');
    const recovered = await getTool(tools, 'tool_result').execute({
      action: 'materialize', requests: [{ ref: oversizedRef }],
    }, ctx);
    expect(recovered.isError).toBeFalsy();
    const copy = JSON.parse(recovered.content).files[0].path;
    expect(fs.statSync(copy).size).toBe(TOOL_RESULT_QUERY_MAX_INPUT_BYTES + 1);
    expect(fs.readFileSync(copy).equals(fs.readFileSync(oversizedPath))).toBe(true);
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
      materializeDir,
      isProgrammaticToolCallContext: () => false,
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

  it('bounds an overscheduled model step without marking refused ranges as read', async () => {
    // Reproduce the observed call shape, not the unavailable private arguments.
    const source = Array.from({ length: 8 }, (_, index) => (
      `section-${index}: confirmed-${index}\n${'x'.repeat(31_960)}\n`
    )).join('');
    const sourceRef = toolResultRefForPath(persistToolResult(dir, 'export', source));
    const tool = getTool(tools, 'tool_result');
    const requests = Array.from({ length: 8 }, (_, index) => ({
      ref: sourceRef, cursor: source.indexOf(`section-${index}:`), max_tokens: 2_000,
    }));
    const results = [];
    for (const request of requests) {
      results.push(await tool.execute({ action: 'read', requests: [request] }, ctx));
    }
    const successful = results.filter((result) => !result.isError);
    expect(successful).toHaveLength(2);
    expect(successful.reduce((tokens, result) => tokens + estimateToolResultTokens(result.content), 0))
      .toBeLessThanOrEqual(TOOL_RESULT_ROUND_MAX_TOKENS);
    for (const result of results.slice(2)) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain('E_RESULT_READ_BUDGET');
      expect(result.content).not.toContain('confirmed-');
    }
    const ledger = ctx.state.toolResultReadLedger as {
      epoch: number; remainingTokens: number; readKeys: Set<string>;
    };
    expect(ledger.readKeys.size).toBe(2);

    // A fresh model step restores observation capacity, not read history.
    ctx.state.toolResultReadLedger = { ...ledger, remainingTokens: TOOL_RESULT_ROUND_MAX_TOKENS };
    const recovered = await tool.execute({ action: 'read', requests: [requests[2]] }, ctx);
    expect(recovered.isError).toBeFalsy();
    expect(recovered.content).toContain('section-2: confirmed-2');
    const duplicate = await tool.execute({ action: 'read', requests: [requests[0]] }, ctx);
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toContain('E_RESULT_CHUNK_ALREADY_READ');
  });

  it('returns all eight independently located facts in one bounded batch', async () => {
    const source = Array.from({ length: 8 }, (_, index) => (
      `section-${index}: confirmed-${index}\n${'x'.repeat(31_960)}\n`
    )).join('');
    const sourceRef = toolResultRefForPath(persistToolResult(dir, 'export', source));
    const result = await getTool(tools, 'tool_result').execute({
      action: 'read',
      requests: Array.from({ length: 8 }, (_, index) => ({
        ref: sourceRef, cursor: source.indexOf(`section-${index}:`), max_tokens: 2_000,
      })),
    }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content.match(/<tool-result-chunk /g)).toHaveLength(8);
    expect(result.content.match(/<\/tool-result-chunk>/g)).toHaveLength(8);
    for (let index = 0; index < 8; index++) {
      expect(result.content).toContain(`section-${index}: confirmed-${index}`);
    }
    expect(estimateToolResultTokens(result.content)).toBeLessThanOrEqual(TOOL_RESULT_ROUND_MAX_TOKENS);
  });

  it('follows returned cursors without gaps across steps and permits rereading after compaction', async () => {
    const source = '确认订单🧾已发货\n'.repeat(2_000);
    const sourceRef = toolResultRefForPath(persistToolResult(dir, 'export', source));
    const tool = getTool(tools, 'tool_result');
    const ledger = ctx.state.toolResultReadLedger as {
      epoch: number; remainingTokens: number; readKeys: Set<string>;
    };
    let cursor = 0;
    let recovered = '';
    for (let step = 0; step < 100; step++) {
      ctx.state.toolResultReadLedger = { ...ledger, remainingTokens: TOOL_RESULT_ROUND_MAX_TOKENS };
      const result = await tool.execute({
        action: 'read', requests: [{ ref: sourceRef, cursor, max_tokens: 2_000 }],
      }, ctx);
      expect(result.isError).toBeFalsy();
      const match = /covered="(\d+)-(\d+)" next_cursor="(\d+|done)">\n([\s\S]*)\n<\/tool-result-chunk>/.exec(result.content);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBe(cursor);
      recovered += match![4];
      expect(Number(match![2])).toBe(recovered.length);
      if (match![3] === 'done') break;
      expect(Number(match![3])).toBeGreaterThan(cursor);
      cursor = Number(match![3]);
    }
    expect(recovered).toBe(source);
    ctx.state.toolResultReadLedger = { ...ledger, epoch: 1, remainingTokens: TOOL_RESULT_ROUND_MAX_TOKENS };
    const afterCompaction = await tool.execute({
      action: 'read', requests: [{ ref: sourceRef, cursor: 0, max_tokens: 2_000 }],
    }, ctx);
    expect(afterCompaction.isError).toBeFalsy();
    expect(afterCompaction.content).toContain('确认订单🧾已发货');
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

  it('provides an executable full-data recovery after the shared observation budget is exhausted', async () => {
    const source = JSON.stringify([{ amount: 7, memo: 'x'.repeat(20_000) }, { amount: 11 }]);
    const sourceRef = toolResultRefForPath(persistToolResult(dir, 'sales', source));
    const ledger = ctx.state.toolResultReadLedger as { remainingTokens: number; readKeys: Set<string> };
    ledger.remainingTokens = 100;
    const tool = getTool(tools, 'tool_result');
    const blocked = await tool.execute({ action: 'query', requests: [{ ref: sourceRef, operation: 'sum', field: 'amount' }] }, ctx);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('E_RESULT_READ_BUDGET');
    expect(blocked.content).toContain('materialize');
    const recovered = await tool.execute({ action: 'materialize', requests: [{ ref: sourceRef }] }, ctx);
    expect(recovered.isError).toBeFalsy();
    const copied = JSON.parse(recovered.content).files[0];
    const content = fs.readFileSync(copied.path, 'utf8');
    expect(content).toBe(source);
    expect(JSON.parse(content).reduce((sum: number, row: { amount: number }) => sum + row.amount, 0)).toBe(18);
    expect(ledger.remainingTokens).toBe(100);
    expect(ledger.readKeys.size).toBe(0);
  });

  it('queries real business columns omitted from a persisted result marker', async () => {
    const noise = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`extra_${index}`, index]));
    const source = JSON.stringify([{ ...noise, amount: 7 }, { ...noise, amount: 11 }]);
    const sourceRef = toolResultRefForPath(persistToolResult(dir, 'sales', source));
    const result = await getTool(tools, 'tool_result').execute({
      action: 'query', requests: [{ ref: sourceRef, operation: 'sum', field: 'amount' }],
    }, ctx);
    expect(result.isError).toBeFalsy();
    expect(queryRows(result.content)).toEqual([{ value: 18 }]);
    expect(result.content).toContain('scanned="2"');
  });

  it('does not let a model-facing string flag forge the programmatic read boundary', async () => {
    const ledger = ctx.state.toolResultReadLedger as { remainingTokens: number };
    ledger.remainingTokens = 100;
    ctx.state.programmaticToolCall = true;
    ctx.state['orkas.programmatic-tool-call'] = true;

    const result = await getTool(tools, 'tool_result').execute({
      action: 'read',
      requests: [{ ref, cursor: 0, max_tokens: 300 }],
    }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_RESULT_READ_BUDGET');
    expect(ledger.remainingTokens).toBe(100);
  });
});
