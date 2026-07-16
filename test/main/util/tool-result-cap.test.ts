import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import {
  capToolResult,
  DEFAULT_INLINE_RESULT_TOKENS,
  DEFAULT_LOCAL_TOOL_RESULTS_MAX_BYTES,
  PERSIST_THRESHOLD,
  TOOL_RESULT_REF_HASH_HEX,
  TOOL_RESULT_INLINE_LEDGER_STATE_KEY,
  buildPersistedOutputMarker,
  estimateToolResultTokens,
  maybeSpillToolResult,
  persistToolResult,
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
  it('uses one 8K token-aware inline budget', () => {
    expect(DEFAULT_INLINE_RESULT_TOKENS).toBe(8_000);
    expect(PERSIST_THRESHOLD).toBe(32_000);
    expect(TOOL_RESULT_REF_HASH_HEX).toBe(64);
    expect(DEFAULT_LOCAL_TOOL_RESULTS_MAX_BYTES).toBe(1024 ** 3);
  });

  it('counts CJK more aggressively than ASCII', () => {
    expect(estimateToolResultTokens('汉'.repeat(1_000))).toBe(1_500);
    expect(estimateToolResultTokens('a'.repeat(1_000))).toBe(250);
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
    expect(result.content).toContain('tool_result_search');
    expect(result.content).toContain('tool_result_read_chunk');
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
    const tool = wrapToolWithCap(stubTool('bash', { content: original, isError: true }), {
      maxInlineTokens: 200,
      toolResultsDir: dir,
    });
    const result = await tool.execute({}, ctx);
    expect(result.isError).toBe(true);
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

  it('spills output above the budget and returns its durable path', () => {
    const original = 'X'.repeat(PERSIST_THRESHOLD + 100);
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
