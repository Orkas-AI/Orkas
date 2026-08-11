import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { toToolDefinition, type AgentTool, type ToolContext } from '#core-agent';
import {
  estimateToolResultTokens,
  persistToolResult,
  toolResultRefForPath,
} from '../../../../src/main/util/tool-result-cap';
import {
  TOOL_RESULT_ROUND_MAX_TOKENS,
  TOOL_RESULT_REF_SCHEMA_PATTERN,
  TOOL_RESULT_SEARCH_MAX_TOKENS,
  createToolResultTools,
  resolveToolResultRef,
} from '../../../../src/main/model/core-agent/tool-result-tools';

function getTool(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
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
    expect(resolveToolResultRef(dir, 'web_fetch.0000000000000000')).toMatchObject({ ok: false, code: 'E_RESULT_REF_MISSING' });
  });

  it('grounds every model-facing ref field to persisted-output syntax after compaction', () => {
    type Schema = {
      description?: string;
      pattern?: string;
      properties?: Record<string, Schema>;
      items?: Schema;
    };
    const definitions = tools.map(toToolDefinition);
    const refs = definitions.flatMap((tool) => {
      const schema = tool.inputSchema as Schema;
      const batchKey = tool.name === 'tool_result_search' ? 'queries' : 'chunks';
      return [schema.properties?.[batchKey]?.items?.properties?.ref];
    });

    expect(refs).toHaveLength(2);
    for (const schema of refs) {
      expect(schema?.pattern).toBe(TOOL_RESULT_REF_SCHEMA_PATTERN);
      expect(schema?.description).toMatch(/persisted-output/i);
      expect(schema?.description).toMatch(/never use.*call_/i);
      expect(new RegExp(schema!.pattern!).test('call_246')).toBe(false);
      expect(new RegExp(schema!.pattern!).test('grep_files.0123456789abcdef')).toBe(true);
    }
    for (const tool of definitions) {
      expect(tool.description).toMatch(/call_\.\.\..*never|never.*call_\.\.\./i);
    }
  });

  it('advertises only the canonical batch request while retaining legacy execution compatibility', async () => {
    const search = getTool(tools, 'tool_result_search');
    const read = getTool(tools, 'tool_result_read_chunk');
    const searchSchema = search.inputSchema as any;
    const readSchema = read.inputSchema as any;

    expect(searchSchema.required).toEqual(['queries']);
    expect(searchSchema.properties).toEqual({ queries: expect.any(Object) });
    expect(searchSchema.properties.queries.items.additionalProperties).toBe(false);
    expect(readSchema.required).toEqual(['chunks']);
    expect(readSchema.properties).toEqual({ chunks: expect.any(Object) });
    expect(readSchema.properties.chunks.items.additionalProperties).toBe(false);

    const legacySearch = await search.execute({ ref, query: 'needle important' }, ctx);
    expect(legacySearch.isError).toBeFalsy();

    ctx.state.toolResultReadLedger = {
      epoch: 1,
      remainingTokens: TOOL_RESULT_ROUND_MAX_TOKENS,
      readKeys: new Set<string>(),
    };
    const legacyRead = await read.execute({ ref, cursor: 0, maxTokens: 300 }, ctx);
    expect(legacyRead.isError).toBeFalsy();
  });

  it('keeps legacy 16-hex refs readable while new writes use full SHA-256 refs', () => {
    const legacyRef = 'bash.1111111111111111';
    fs.writeFileSync(path.join(dir, `${legacyRef}.txt`), 'legacy result');
    expect(resolveToolResultRef(dir, legacyRef)).toMatchObject({ ok: true });
    expect(TOOL_RESULT_SEARCH_MAX_TOKENS).toBe(2_000);
  });

  it('searches for narrow excerpts without returning the whole result', async () => {
    const result = await getTool(tools, 'tool_result_search').execute({ ref, query: 'needle important' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<tool-result-search');
    expect(result.content).toContain('needle first important observation');
    expect(result.content).toContain('</tool-result-search>');
    expect(result.content.length).toBeLessThan(12_000);
  });

  it('searches multiple narrow queries in one tool round under the shared budget', async () => {
    const result = await getTool(tools, 'tool_result_search').execute({
      queries: [
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
    const result = await getTool(tools, 'tool_result_search').execute({
      queries: [
        { ref, query: 'needle important' },
        { ref, query: ' IMPORTANT   needle ' },
      ],
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content.match(/<tool-result-search /g)).toHaveLength(1);
    expect(result.content).toContain('E_RESULT_CHUNK_ALREADY_READ');
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(1);
  });

  it('reads an exact bounded chunk and returns a continuation cursor', async () => {
    const result = await getTool(tools, 'tool_result_read_chunk').execute({ ref, cursor: 0, maxTokens: 9_000 }, ctx);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('covered="0-');
    expect(result.content).toMatch(/next_cursor="\d+"/);
    expect(result.content).toContain('</tool-result-chunk>');
    expect(estimateToolResultTokens(result.content)).toBeLessThanOrEqual(2_000);
  });

  it('reads multiple exact chunks in one tool round under the shared budget', async () => {
    const result = await getTool(tools, 'tool_result_read_chunk').execute({
      chunks: [
        { ref, cursor: 0, maxTokens: 2_000 },
        { ref, cursor: 10_000, maxTokens: 2_000 },
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
    const result = await getTool(tools, 'tool_result_read_chunk').execute({
      chunks: [0, 3_000, 6_000, 9_000].map((cursor) => ({ ref, cursor, maxTokens: 2_000 })),
    }, ctx);

    expect(result.isError).toBeFalsy();
    expect(result.content.match(/<tool-result-chunk /g)).toHaveLength(4);
    expect(estimateToolResultTokens(result.content)).toBeLessThanOrEqual(TOOL_RESULT_ROUND_MAX_TOKENS);
    expect((ctx.state.toolResultReadLedger as { readKeys: Set<string> }).readKeys.size).toBe(4);
  });

  it('keeps successful batch items when another persisted-result request is invalid', async () => {
    const result = await getTool(tools, 'tool_result_search').execute({
      queries: [
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
    const search = await getTool(tools, 'tool_result_search').execute({
      ref: boundaryRef,
      query: '界needle',
    }, ctx);
    expect(search.isError).toBeFalsy();
    expect(search.content).toContain('界needle-after-boundary');
    expect(search.content).toContain(`total_chars="${content.length}"`);

    const chunk = await getTool(tools, 'tool_result_read_chunk').execute({
      ref: boundaryRef,
      cursor: 65_534,
      maxTokens: 256,
    }, ctx);
    expect(chunk.isError).toBeFalsy();
    expect(chunk.content).toContain('a界needle-after-boundary');
    expect(chunk.content).toContain(`total_chars="${content.length}"`);
  });

  it('suppresses duplicate reads in the same compaction epoch', async () => {
    const tool = getTool(tools, 'tool_result_read_chunk');
    await tool.execute({ ref, cursor: 0, maxTokens: 300 }, ctx);
    const duplicate = await tool.execute({ ref, cursor: 0, maxTokens: 300 }, ctx);
    expect(duplicate.isError).toBe(true);
    expect(duplicate.content).toContain('E_RESULT_CHUNK_ALREADY_READ');
  });

  it('enforces the aggregate per-round read budget', async () => {
    const ledger = ctx.state.toolResultReadLedger as { remainingTokens: number };
    ledger.remainingTokens = 100;
    const result = await getTool(tools, 'tool_result_read_chunk').execute({ ref, cursor: 0, maxTokens: 300 }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_RESULT_READ_BUDGET');
  });
});
