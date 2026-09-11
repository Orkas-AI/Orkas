import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import {
  capToolResult,
  DEFAULT_INLINE_RESULT_TOKENS,
  DEFAULT_LOCAL_TOOL_RESULTS_MAX_BYTES,
  TOOL_RESULT_REF_HASH_HEX,
  TOOL_RESULT_INLINE_LEDGER_STATE_KEY,
  buildPersistedOutputMarker,
  buildPersistedOutputMarkerFromPreview,
  buildStructureOutline,
  estimateToolResultTokens,
  maybeSpillToolResult,
  persistToolResult,
  sweepExpiredCloudToolResults,
  sweepToolResults,
  wrapToolWithCap,
} from '../../../src/main/util/tool-result-cap';

function stubTool(name: string, result: ToolResult): AgentTool {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: 'object', properties: {} },
    async execute() { return result; },
  };
}

const ctx: ToolContext = { state: {} };
const makeTmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-tool-cap-'));
const cleanup = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

describe('tool-result-cap configuration', () => {
  it('keeps the token budget at the pre-switch 50K-char equivalent', () => {
    expect(DEFAULT_INLINE_RESULT_TOKENS).toBe(12_500);
    expect(TOOL_RESULT_REF_HASH_HEX).toBe(64);
    expect(DEFAULT_LOCAL_TOOL_RESULTS_MAX_BYTES).toBe(1024 ** 3);
  });

  // Regression: an 8K budget spilled `skill-creator` (11.1K tokens) and
  // `agent-creator` (10.6K), so commander authored machine containers from a
  // head/tail preview and emitted unparseable blocks. Both must stay inline.
  it('keeps the largest system-skill protocol specs inline', () => {
    expect(estimateToolResultTokens('a'.repeat(44_000)))
      .toBeLessThan(DEFAULT_INLINE_RESULT_TOKENS);
  });

  it('counts CJK more aggressively than ASCII', () => {
    expect(estimateToolResultTokens('汉'.repeat(1_000))).toBe(1_500);
    expect(estimateToolResultTokens('a'.repeat(1_000))).toBe(250);
  });

  // The same text is measured here at the inline-cap boundary and by
  // core-agent's estimateTextTokens for every context-budget decision. The
  // implementations are twins by necessity (#core-agent is dynamic-import-only
  // in main, this path is synchronous); a divergence moves a result across the
  // spill line on one side only. Non-BMP input is the case that split them
  // before: a code-point iterator counts an astral char once, a UTF-16
  // iterator counts its surrogate pair twice.
  it('stays byte-for-byte equivalent to core-agent estimateTextTokens', async () => {
    const { estimateTextTokens } = await import('../../../src/core-agent/src/agent/session');
    const fixtures = [
      '',
      'plain ascii with spaces and 1234 !@#',
      '这是一段中文说明文字，包含标点。',
      'ひらがなとカタカナのテキスト',
      '한글 음절 텍스트',
      'ＦＵＬＬＷＩＤＴＨ　ｆｏｒｍｓ！',
      'emoji 😀😀 and flags 🇨🇳',
      'astral CJK 𠮷野家 mixed with 汉字',
      'mixed 中英 mixed ascii 汉字 with everything かな 한글 😀 𠮷',
      '汉'.repeat(1_000) + 'a'.repeat(1_000),
    ];
    for (const text of fixtures) {
      expect(estimateToolResultTokens(text), JSON.stringify(text.slice(0, 24))).toBe(estimateTextTokens(text));
    }
  });
});

describe('wrapToolWithCap', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it('passes through a result within budget', async () => {
    const tool = wrapToolWithCap(stubTool('bash', { content: 'short output' }), {
      maxInlineTokens: 100,
      toolResultsDir: dir,
    });
    expect((await tool.execute({}, ctx)).content).toBe('short output');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('persists every over-budget result instead of using a truncation tier', async () => {
    const original = 'x'.repeat(10_000);
    const tool = wrapToolWithCap(stubTool('web_fetch', { content: original }), {
      maxInlineTokens: 1_000,
      toolResultsDir: dir,
    });
    const result = await tool.execute({}, ctx);
    expect(result.content).toMatch(/^<persisted-output ref="web_fetch\.[0-9a-f]{64}"/);
    expect(result.content).toContain('tool_result');
    expect(result.content).toContain('action="read"');
    expect(result.content).not.toContain('Use read_file(path)');
    expect(result.content).not.toContain(' path="');
    expect(result.persistedOutput).toMatchObject({
      size: original.length,
      ref: expect.stringMatching(/^web_fetch\.[0-9a-f]{64}$/),
    });
    const files = fs.readdirSync(dir);
    expect(files).toEqual([expect.stringMatching(/^web_fetch\.[0-9a-f]{64}\.txt$/)]);
    expect(fs.readFileSync(path.join(dir, files[0]), 'utf8')).toBe(original);
  });

  it('keeps the observed agent-creator-sized read inline under the verbatim ceiling', () => {
    // Regression from 2026-08-07: a system-skill read was ~10,940 tokens while
    // gpt-5.6-luna derived a 7,917-token ordinary ceiling. The round still had
    // enough room, so correct skill classification must admit the document.
    const ledger = () => ({
      initialTokens: 11_728,
      remainingTokens: 11_728,
      perResultTokens: 7_917,
      verbatimDocumentTokens: 15_834,
    });
    const body = 'x'.repeat(43_760);
    expect(estimateToolResultTokens(body)).toBe(10_940);

    const spilled = capToolResult('read_file', { content: body }, {
      ...ctx,
      state: { [TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: ledger() },
    } as unknown as typeof ctx, {
      maxInlineTokens: 12_500,
      toolResultsDir: dir,
    });
    expect(spilled.content).toMatch(/^<persisted-output/);

    const inlined = capToolResult('read_file', { content: body, verbatimDocument: true }, {
      ...ctx,
      state: { [TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: ledger() },
    } as unknown as typeof ctx, {
      maxInlineTokens: 12_500,
      toolResultsDir: dir,
    });
    expect(inlined.content).toBe(body);
  });

  it('still charges a verbatim document to the round ledger', () => {
    // The wider ceiling is a per-item policy, not an exemption: the ledger is
    // what protects the context window, and it falls to zero as the request
    // fills. A skill read that no longer fits the round spills like anything
    // else once it is larger than the marker's own preview; below that size
    // the marker would repeat the whole document, so it stays inline.
    const ledger = {
      initialTokens: 50_000,
      remainingTokens: 100,
      perResultTokens: 400,
      verbatimDocumentTokens: 100_000,
    };
    const tightCtx = {
      ...ctx,
      state: { [TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: ledger },
    } as unknown as typeof ctx;
    const result = capToolResult(
      'read_file',
      { content: 'x'.repeat(4_000), verbatimDocument: true },
      tightCtx,
      { maxInlineTokens: 12_500, toolResultsDir: dir },
    );
    expect(result.content).toMatch(/^<persisted-output/);
    const small = capToolResult(
      'read_file',
      { content: 'y'.repeat(2_000), verbatimDocument: true },
      tightCtx,
      { maxInlineTokens: 12_500, toolResultsDir: dir },
    );
    expect(small.content).toBe('y'.repeat(2_000));
    expect(small.persistedOutput).toBeUndefined();
  });

  it('keeps the caller default when no budget was resolved', () => {
    // Unknown model, reflection, one-shots: there is no window to derive from,
    // so behaviour must be exactly what it was before the derivation existed —
    // including for a verbatim document, which gets no invented multiple.
    const body = 'x'.repeat(2_400);
    const plain = capToolResult('read_file', { content: body }, ctx, {
      maxInlineTokens: 1_000,
      toolResultsDir: dir,
    });
    expect(plain.content).toBe(body);
    const verbatim = capToolResult(
      'read_file',
      { content: 'x'.repeat(8_000), verbatimDocument: true },
      ctx,
      { maxInlineTokens: 1_000, toolResultsDir: dir },
    );
    expect(verbatim.content).toMatch(/^<persisted-output/);
  });

  it('marks persistence failure as an error without leaking the backing path', async () => {
    const blockedDir = path.join(dir, 'not-a-directory');
    fs.writeFileSync(blockedDir, 'block mkdir');
    const result = capToolResult('bash', { content: 'x'.repeat(10_000) }, ctx, {
      maxInlineTokens: 1_000,
      toolResultsDir: blockedDir,
    });

    expect(result.isError).toBe(true);
    expect(result.persistedOutput).toBeUndefined();
    expect(result.content).toContain('oversized output persistence failed');
    expect(result.content).toContain('full output was not preserved');
    expect(result.content).not.toContain(blockedDir);
  });

  it('uses the token estimate for CJK spill decisions', async () => {
    const original = '界'.repeat(800);
    const tool = wrapToolWithCap(stubTool('read_file', { content: original }), {
      maxInlineTokens: 1_000,
      toolResultsDir: dir,
    });
    expect((await tool.execute({}, ctx)).content).toContain('<persisted-output');
  });

  it('persists oversized error output and preserves the error flag', async () => {
    const original = 'error\n'.repeat(2_000);
    const failureContext = {
      kind: 'deterministic_validation' as const,
      scope: 'project:stable-id',
      complete: true,
      issueCount: 80,
      issueCodes: ['E_FIRST', 'E_SECOND'],
    };
    const tool = wrapToolWithCap(stubTool('bash', {
      content: original,
      isError: true,
      failureContext,
    }), {
      maxInlineTokens: 200,
      toolResultsDir: dir,
    });
    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.failureContext).toEqual(failureContext);
    expect(result.content).toContain('status="error"');
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('preserves images and execution mode', async () => {
    const image = { data: 'Zm9v', mediaType: 'image/jpeg' };
    const base = stubTool('web_fetch', { content: 'x'.repeat(5_000), images: [image] });
    base.executionMode = 'parallel';
    const tool = wrapToolWithCap(base, { maxInlineTokens: 100, toolResultsDir: dir });
    expect(tool.executionMode).toBe('parallel');
    expect((await tool.execute({}, ctx)).images).toEqual([image]);
  });

  it('adopts a streamed temp file without reloading its full content into the result', () => {
    const original = 'streamed\n'.repeat(10_000);
    const source = path.join(dir, '.bash.test.spool');
    fs.writeFileSync(source, original, { mode: 0o600 });

    const result = capToolResult('bash', {
      content: 'streamed preview',
      streamedOutput: { path: source, size: Buffer.byteLength(original) },
    }, ctx, { maxInlineTokens: 8_000, toolResultsDir: dir });

    expect(result.streamedOutput).toBeUndefined();
    expect(result.persistedOutput?.ref).toMatch(/^bash\.[0-9a-f]{64}$/);
    expect(result.content).toContain('source_truncated="false"');
    expect(result.content).not.toContain(source);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(result.persistedOutput!.path, 'utf8')).toBe(original);
  });

  it('preserves an explicit incomplete-source warning after adopting a hard-capped stream', () => {
    const source = path.join(dir, '.bash.capped.spool');
    fs.writeFileSync(source, 'prefix only', { mode: 0o600 });

    const result = capToolResult('bash', {
      content: 'prefix preview',
      isError: true,
      streamedOutput: { path: source, size: 11, sourceTruncated: true },
    }, ctx, { maxInlineTokens: 8_000, toolResultsDir: dir });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('source_truncated="true"');
    expect(result.content).toContain('stored file is an incomplete prefix');
    expect(fs.readFileSync(result.persistedOutput!.path, 'utf8')).toBe('prefix only');
  });

  it('refuses to adopt a streamed path outside the active Result Store', () => {
    const outsideDir = makeTmpDir();
    const source = path.join(outsideDir, '.outside.spool');
    fs.writeFileSync(source, 'outside');
    try {
      const result = capToolResult('bash', {
        content: 'safe preview',
        streamedOutput: { path: source, size: 7 },
      }, ctx, { maxInlineTokens: 8_000, toolResultsDir: dir });

      expect(result.isError).toBe(true);
      expect(result.streamedOutput).toBeUndefined();
      expect(result.persistedOutput).toBeUndefined();
      expect(result.content).toContain('streamed output adoption failed');
      expect(result.content).not.toContain(source);
      expect(fs.readFileSync(source, 'utf8')).toBe('outside');
    } finally {
      cleanup(outsideDir);
    }
  });

  it('returns the original tool for an infinite budget', () => {
    const base = stubTool('custom', { content: 'x' });
    expect(wrapToolWithCap(base, { maxInlineTokens: Infinity, toolResultsDir: dir })).toBe(base);
  });

  it('shares a 16K-style inline ledger across results in one model step', () => {
    const ledgerCtx: ToolContext = {
      state: {
        [TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
          initialTokens: 16_000,
          remainingTokens: 16_000,
        },
      },
    };
    const opts = { maxInlineTokens: 8_000, toolResultsDir: dir };
    const first = capToolResult('first', { content: 'a'.repeat(24_000) }, ledgerCtx, opts);
    const second = capToolResult('second', { content: 'b'.repeat(24_000) }, ledgerCtx, opts);
    const third = capToolResult('third', { content: 'c'.repeat(20_000) }, ledgerCtx, opts);

    expect(first.persistedOutput).toBeUndefined();
    expect(second.persistedOutput).toBeUndefined();
    expect(third.persistedOutput?.ref).toMatch(/^third\.[0-9a-f]{64}$/);
    expect(third.content).toContain('<persisted-output');
    expect(
      (ledgerCtx.state[TOOL_RESULT_INLINE_LEDGER_STATE_KEY] as { remainingTokens: number })
        .remainingTokens,
    ).toBe(4_000);
    expect(fs.readFileSync(third.persistedOutput!.path, 'utf8')).toBe('c'.repeat(20_000));
  });

  it('keeps a small result inline when the round ledger is exhausted instead of wrapping it', () => {
    const ledgerCtx: ToolContext = {
      state: {
        [TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
          initialTokens: 16_000,
          remainingTokens: 0,
        },
      },
    };
    const opts = { maxInlineTokens: 8_000, toolResultsDir: dir };
    const small = capToolResult('write_file', { content: 'wrote 12 bytes to notes.md' }, ledgerCtx, opts);
    const large = capToolResult('read_files', { content: 'z'.repeat(24_000) }, ledgerCtx, opts);

    // The marker for a ≤600-token result would repeat the whole content plus
    // ~200 tokens of refs/hints; inline unchanged is strictly cheaper.
    expect(small.content).toBe('wrote 12 bytes to notes.md');
    expect(small.persistedOutput).toBeUndefined();
    expect(fs.readdirSync(dir).some((name) => name.startsWith('write_file.'))).toBe(false);
    // Results above the preview budget still spill to disk on round exhaustion.
    expect(large.persistedOutput?.ref).toMatch(/^read_files\.[0-9a-f]{64}$/);
    expect(large.content).toContain('<persisted-output');
  });

  it('does not spend the round ledger on a result already above the 8K limit', () => {
    const ledgerCtx: ToolContext = {
      state: {
        [TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
          initialTokens: 16_000,
          remainingTokens: 16_000,
        },
      },
    };
    const result = capToolResult(
      'large',
      { content: 'x'.repeat(40_000) },
      ledgerCtx,
      { maxInlineTokens: 8_000, toolResultsDir: dir },
    );
    expect(result.persistedOutput).toBeTruthy();
    expect(
      (ledgerCtx.state[TOOL_RESULT_INLINE_LEDGER_STATE_KEY] as { remainingTokens: number })
        .remainingTokens,
    ).toBe(16_000);
  });

  it('keeps concurrently completed results within the shared round budget', async () => {
    const ledgerCtx: ToolContext = {
      state: {
        [TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
          initialTokens: 16_000,
          remainingTokens: 16_000,
        },
      },
    };
    const delayed = (name: string, char: string, delayMs: number): AgentTool => ({
      name,
      description: name,
      inputSchema: { type: 'object', properties: {} },
      executionMode: 'parallel',
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { content: char.repeat(28_000) }; // 7K estimated tokens
      },
    });
    const tools = [
      delayed('parallel_a', 'a', 3),
      delayed('parallel_b', 'b', 1),
      delayed('parallel_c', 'c', 2),
    ].map((tool) => wrapToolWithCap(tool, {
      maxInlineTokens: 8_000,
      toolResultsDir: dir,
    }));

    const results = await Promise.all(tools.map((tool) => tool.execute({}, ledgerCtx)));
    expect(results.filter((result) => result.persistedOutput)).toHaveLength(1);
    expect(results.filter((result) => !result.persistedOutput)).toHaveLength(2);
    expect(
      (ledgerCtx.state[TOOL_RESULT_INLINE_LEDGER_STATE_KEY] as { remainingTokens: number })
        .remainingTokens,
    ).toBe(2_000);
  });
});

describe('persisted result helpers', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it('uses a content-addressed name and deduplicates identical output', () => {
    const first = persistToolResult(dir, 'bash', 'same content');
    const second = persistToolResult(dir, 'bash', 'same content');
    expect(second).toBe(first);
    expect(path.basename(first)).toMatch(/^bash\.[0-9a-f]{64}\.txt$/);
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });

  it('keeps distinct content separate and creates nested directories lazily', () => {
    const nested = path.join(dir, 'deep', 'results');
    const first = persistToolResult(nested, 'bash', 'A');
    const second = persistToolResult(nested, 'bash', 'B');
    expect(first).not.toBe(second);
    expect(fs.readFileSync(first, 'utf8')).toBe('A');
    expect(fs.readFileSync(second, 'utf8')).toBe('B');
  });

  it('builds a bounded preview with a stable ref', () => {
    const marker = buildPersistedOutputMarker(
      '/tmp/web_fetch.0123456789abcdef.txt',
      'web_fetch',
      `head-${'x'.repeat(20_000)}-tail`,
    );
    expect(marker).toContain('ref="web_fetch.0123456789abcdef"');
    expect(marker).toContain('chars omitted; full result is stored');
    expect(estimateToolResultTokens(marker)).toBeLessThan(1_000);
  });

  it('advertises deterministic query capabilities and bounded schema for structured output', () => {
    const marker = buildPersistedOutputMarker(
      '/tmp/connector.0123456789abcdef.txt',
      'connector',
      JSON.stringify([
        { status: 'active', amount: 3, nested: { region: 'PH' } },
        { status: 'paused', amount: 7, nested: { region: 'SG' } },
      ]),
    );

    expect(marker).toContain('data_type="json"');
    expect(marker).toContain('actions="query,search,read,materialize"');
    expect(marker).toContain('query operations=count,sum,average,minimum,maximum');
    expect(marker).toContain('omit match/count_unit for structured data');
    expect(marker).toContain('Make at most one tool_result call in the next model step');
    expect(marker).toContain('batch same-action requests in one requests array');
    expect(marker).toContain('data{records=2;fields=');
    expect(marker).toContain('amount:number');
    expect(marker).toContain('nested.region:string');
  });

  it('advertises queryable array item fields and the explode namespaces', () => {
    const marker = buildPersistedOutputMarker(
      '/tmp/connector.0123456789abcdef.txt',
      'connector',
      JSON.stringify([{ campaign_id: 9, metrics_list: [{ date: '2026-08-01', expense: 12 }] }]),
    );

    expect(marker).toContain('array query uses explode with $item/$parent/$index');
    expect(marker).toContain('metrics_list[]{items=1;fields=');
    expect(marker).toContain('$item.date:string');
    expect(marker).toContain('$item.expense:number');
    expect(marker).not.toContain('/tmp/connector');
  });

  it('states when the bounded result marker omits additional arrays', () => {
    const marker = buildPersistedOutputMarker(
      '/tmp/connector.0123456789abcdef.txt',
      'connector',
      JSON.stringify([{ first: [1], second: [2], third: [3] }]),
    );

    expect(marker).toContain('first[]{items=1');
    expect(marker).toContain('second[]{items=1');
    expect(marker).toContain('+1 more arrays');
  });

  it('labels the only safe query for unstructured text instead of inventing record semantics', () => {
    const marker = buildPersistedOutputMarker(
      '/tmp/bash.0123456789abcdef.txt',
      'bash',
      'first error\nsecond line\nthird error',
    );

    expect(marker).toContain('data_type="text"');
    expect(marker).toContain('actions="query,search,read,materialize"');
    expect(marker).toContain('query supports exact count only with match + count_unit');
    expect(marker).toContain('Make at most one tool_result call in the next model step');
    expect(marker).toContain('batch same-action requests in one requests array');
    expect(marker).toContain('lines=3');
  });

  // A head/tail preview hides the middle of a structured document, which is
  // where reference material lives. The section map replaces guesswork with a
  // seek: every offset is a `tool_result` read cursor.
  it('emits a section map with char cursors for structured documents', () => {
    const doc = [
      '# Title',
      'intro'.repeat(200),
      '## Alpha',
      'a'.repeat(9_000),
      '## Block format',
      'the part that matters',
      '## Omega',
      'z'.repeat(9_000),
    ].join('\n');
    const marker = buildPersistedOutputMarker('/tmp/read_file.0123456789abcdef.txt', 'read_file', doc);

    expect(marker).toContain('Section map');
    expect(marker).toContain('Block format');
    expect(marker).toContain('Omega');
    const offset = Number(/@(\d+)\t\s*## ?Block format|@(\d+)\t\s*Block format/.exec(marker)?.slice(1).find(Boolean));
    expect(doc.slice(offset)).toMatch(/^## Block format/);
    expect(estimateToolResultTokens(marker)).toBeLessThan(1_000);
  });

  it('does not fabricate an outline from a partial streamed preview', () => {
    const full = ['# A', 'x'.repeat(5_000), '## B', 'y'.repeat(5_000), '## C'].join('\n');
    const marker = buildPersistedOutputMarkerFromPreview(
      '/tmp/bash.0123456789abcdef.txt',
      'bash',
      full.slice(0, 200),
      { sizeChars: full.length, estimatedTokens: 3_000, isError: false, sourceTruncated: false },
    );
    expect(marker).not.toContain('Section map');
    expect(marker).toContain('data_type="unknown"');
    expect(marker).toContain('actions="search,read,materialize"');
    expect(marker).not.toContain('query operations=');
  });

  it('explains full-data calculation recovery when built-in querying is unavailable', () => {
    const marker = buildPersistedOutputMarker(
      '/tmp/connector.0123456789abcdef.txt',
      'connector',
      JSON.stringify({ rows: [{ amount: 7 }], diagnostic_blob: 'x'.repeat(32 * 1024 * 1024) }),
    );
    const summary = marker.split('\n').find((line) => line.startsWith('[Result data'));
    expect(marker).toContain('actions="search,read,materialize"');
    expect(summary).toMatch(/query.*limit/);
    expect(summary).toMatch(/materialize.*full-data calculations/);
    expect(summary).toMatch(/search\/read.*excerpts/);
    expect(marker).not.toContain('/tmp/connector');
  });

  it('leaves unstructured output on the plain head/tail preview', () => {
    const marker = buildPersistedOutputMarker(
      '/tmp/bash.0123456789abcdef.txt',
      'bash',
      'no headings here\n'.repeat(4_000),
    );
    expect(marker).not.toContain('Section map');
    expect(marker).toContain('chars omitted; full result is stored');
  });
});

describe('maybeSpillToolResult', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it('passes through output within the budget', () => {
    const result = maybeSpillToolResult({
      toolResultsDir: dir,
      toolName: 'bash',
      callId: 'c1',
      output: 'small',
    });
    expect(result).toEqual({ output: 'small' });
  });

  it('preserves the original shape of a small structured result', () => {
    const output = { rows: [{ id: 1, value: 'small' }], hasMore: false };
    const result = maybeSpillToolResult({
      toolResultsDir: dir,
      toolName: 'mcp_read',
      callId: 'c-structured-small',
      output,
    });

    expect(result).toEqual({ output });
    expect(result.output).toBe(output);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('spills output above the budget and returns its durable path', () => {
    // ASCII length past the token-aware spill budget (~4 chars per token).
    const original = 'X'.repeat(DEFAULT_INLINE_RESULT_TOKENS * 4 + 100);
    const result = maybeSpillToolResult({
      toolResultsDir: dir,
      toolName: 'bash',
      callId: 'c1',
      output: original,
    });
    expect(result.outputPath).toBeTruthy();
    expect(fs.readFileSync(result.outputPath!, 'utf8')).toBe(original);
    expect(result.output).toContain('<persisted-output');
  });

  it('serializes and spills an oversized structured array as exact JSON', () => {
    const original = [
      { id: 'row-1', value: 'A'.repeat(DEFAULT_INLINE_RESULT_TOKENS * 4) },
      { id: 'row-2', value: 'B'.repeat(DEFAULT_INLINE_RESULT_TOKENS * 4) },
    ];
    const result = maybeSpillToolResult({
      toolResultsDir: dir,
      toolName: 'mcp_query',
      callId: 'c-structured-large',
      output: original,
    });

    expect(result.outputPath).toBeTruthy();
    expect(fs.readFileSync(result.outputPath!, 'utf8')).toBe(JSON.stringify(original));
    expect(result.output).toEqual(expect.stringContaining('<persisted-output'));
  });

  it('replaces an unserializable result with a bounded safe marker', () => {
    const original: Record<string, unknown> = {};
    original.self = original;

    const result = maybeSpillToolResult({
      toolResultsDir: dir,
      toolName: 'mcp_query',
      callId: 'c-circular',
      output: original,
    });

    expect(result).toEqual({ output: '[Unserializable tool result omitted.]' });
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});

describe('sweepToolResults', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it('removes stale entries and retains recent entries', () => {
    const old = path.join(dir, 'old.txt');
    const recent = path.join(dir, 'recent.txt');
    fs.writeFileSync(old, 'old');
    fs.writeFileSync(recent, 'recent');
    const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1_000) / 1_000;
    fs.utimesSync(old, tenDaysAgo, tenDaysAgo);
    const stats = sweepToolResults(dir, 7);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(recent)).toBe(true);
    expect(stats.removedStale).toBe(1);
  });

  it('does not throw for a missing directory', () => {
    expect(sweepToolResults(path.join(dir, 'missing'), 7)).toEqual({
      removedStale: 0,
      removedForQuota: 0,
      retainedBytes: 0,
    });
  });

  it('evicts the oldest recent session entries when the local quota is exceeded', () => {
    const now = Date.now() / 1_000;
    const makeEntry = (name: string, ageMinutes: number) => {
      const entry = path.join(dir, name);
      fs.mkdirSync(entry);
      fs.writeFileSync(path.join(entry, 'result.txt'), name.repeat(4)); // 12 bytes
      const time = now - ageMinutes * 60;
      fs.utimesSync(entry, time, time);
      return entry;
    };
    const oldest = makeEntry('old', 3);
    const middle = makeEntry('mid', 2);
    const newest = makeEntry('new', 1);

    const stats = sweepToolResults(dir, 7, 24);

    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(true);
    expect(fs.existsSync(newest)).toBe(true);
    expect(stats).toMatchObject({ removedStale: 0, removedForQuota: 1, retainedBytes: 24 });
  });
});

describe('sweepExpiredCloudToolResults', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  const daysAgoSec = (days: number) => (Date.now() - days * 24 * 60 * 60 * 1_000) / 1_000;
  const spillDir = (name: string) => {
    const abs = path.join(dir, name);
    fs.mkdirSync(abs, { recursive: true });
    return abs;
  };
  const spillFile = (parent: string, name: string, ageDays: number) => {
    const abs = path.join(parent, name);
    fs.writeFileSync(abs, name);
    const t = daysAgoSec(ageDays);
    fs.utimesSync(abs, t, t);
    return abs;
  };

  it('expires old files, keeps fresh ones, and removes only emptied dirs', () => {
    const emptied = spillDir('gconv-a.tool-results');
    const mixed = spillDir('gconv-b.tool-results');
    const oldA = spillFile(emptied, 'bash.a1.txt', 40);
    const oldB = spillFile(mixed, 'web_fetch.b1.txt', 31);
    const fresh = spillFile(mixed, 'web_fetch.b2.txt', 1);

    const stats = sweepExpiredCloudToolResults([emptied, mixed]);

    expect(fs.existsSync(oldA)).toBe(false);
    expect(fs.existsSync(oldB)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(emptied)).toBe(false);
    expect(fs.existsSync(mixed)).toBe(true);
    expect(stats).toEqual({ removedFiles: 2, removedDirs: 1, truncated: false });
  });

  it('spends the deletion budget oldest-first across dirs and reports truncation', () => {
    const a = spillDir('gconv-a.tool-results');
    const b = spillDir('gconv-b.tool-results');
    const oldest = spillFile(b, 'bash.oldest.txt', 90);
    const middle = spillFile(a, 'bash.middle.txt', 60);
    const newerExpired = spillFile(a, 'bash.newer.txt', 35);

    const stats = sweepExpiredCloudToolResults([a, b], 30, 2);

    expect(fs.existsSync(oldest)).toBe(false);
    expect(fs.existsSync(middle)).toBe(false);
    expect(fs.existsSync(newerExpired)).toBe(true);
    expect(stats).toEqual({ removedFiles: 2, removedDirs: 1, truncated: true });
  });

  it('tolerates missing dirs', () => {
    expect(sweepExpiredCloudToolResults([path.join(dir, 'absent.tool-results')]))
      .toEqual({ removedFiles: 0, removedDirs: 0, truncated: false });
  });

  it('never follows or deletes symlink entries', () => {
    const spill = spillDir('gconv-a.tool-results');
    const outside = path.join(dir, 'outside.txt');
    fs.writeFileSync(outside, 'target');
    const t = daysAgoSec(90);
    fs.utimesSync(outside, t, t);
    const link = path.join(spill, 'bash.link.txt');
    fs.symlinkSync(outside, link);
    // lutimes is not portable; the dirent type gate must skip the link even
    // though its target is long expired.
    const stats = sweepExpiredCloudToolResults([spill]);

    expect(fs.existsSync(outside)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(stats).toEqual({ removedFiles: 0, removedDirs: 0, truncated: false });
  });
});
