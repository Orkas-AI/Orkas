import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import {
  wrapToolWithCap,
  persistToolResult,
  buildPersistedOutputMarker,
  sweepToolResults,
  maybeSpillToolResult,
  MAX_RESULT_CHARS_BY_TOOL,
  DEFAULT_MAX_RESULT_CHARS,
  PERSIST_THRESHOLD,
} from '../../../src/main/util/tool-result-cap';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Minimal stub tool whose execute() returns a pre-baked ToolResult. */
function stubTool(name: string, result: ToolResult): AgentTool {
  return {
    name,
    description: `stub ${name}`,
    inputSchema: { type: 'object', properties: {} },
    async execute(_input: Record<string, unknown>, _ctx: ToolContext) {
      return result;
    },
  };
}

const ctx: ToolContext = { state: {} };

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-tool-cap-'));
}

function cleanup(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('tool-result-cap › config table', () => {
  it('Read-type tools cap at the 100K default (no longer Infinity-exempt)', () => {
    expect(MAX_RESULT_CHARS_BY_TOOL.read_file).toBe(100_000);
    expect(MAX_RESULT_CHARS_BY_TOOL.kb_read).toBe(100_000);
  });

  it('PERSIST_THRESHOLD matches Claude Code default (50_000)', () => {
    expect(PERSIST_THRESHOLD).toBe(50_000);
  });

  it('DEFAULT_MAX_RESULT_CHARS is 100_000', () => {
    expect(DEFAULT_MAX_RESULT_CHARS).toBe(100_000);
  });
});

describe('tool-result-cap › wrapToolWithCap', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it('len ≤ cap → passes through verbatim', async () => {
    const tool = stubTool('bash', { content: 'short output' });
    const wrapped = wrapToolWithCap(tool, { maxChars: 30_000, toolResultsDir: dir });
    const r = await wrapped.execute({}, ctx);
    expect(r.content).toBe('short output');
    expect(r.isError).toBeUndefined();
    // nothing written
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('cap < len ≤ PERSIST_THRESHOLD → truncates in place with trailing marker', async () => {
    const big = 'a'.repeat(40_000);
    const tool = stubTool('bash', { content: big });
    const wrapped = wrapToolWithCap(tool, { maxChars: 30_000, toolResultsDir: dir });
    const r = await wrapped.execute({}, ctx);
    expect(r.content.startsWith('a'.repeat(30_000))).toBe(true);
    expect(r.content).toContain('[truncated by bash: 10000 chars removed]');
    expect(r.content.length).toBeLessThan(40_000);
    // no persisted file
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('len > cap AND len > PERSIST_THRESHOLD → writes file + returns <persisted-output> reference', async () => {
    // bash 的 maxChars=30K；60K 既超 cap (触发裁剪) 又超 PERSIST_THRESHOLD
    // (改走落盘分支，而不是就地截断)。测"cap-超但未到落盘线"交给上一条用例。
    const big = 'x'.repeat(60_000);
    const tool = stubTool('bash', { content: big });
    const wrapped = wrapToolWithCap(tool, { maxChars: 30_000, toolResultsDir: dir });
    const r = await wrapped.execute({}, ctx);
    expect(r.content).toMatch(/^<persisted-output tool="bash" size="60000" path="/);
    expect(r.content).toContain('</persisted-output>');
    expect(r.content).toMatch(/\[Full content saved to: .+\. Use read_file\(path\)/);
    // one file written, size matches
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^bash\.[0-9a-f]{12}\.txt$/);
    const written = fs.readFileSync(path.join(dir, files[0]), 'utf8');
    expect(written.length).toBe(60_000);
  });

  it('len ≤ cap (even if > PERSIST_THRESHOLD) → passes through, no persist', async () => {
    // web_fetch 的 maxChars=100K 且 len=60K：没超 cap 就不用动它，即便
    // PERSIST_THRESHOLD=50K。cap 是第一道闸；落盘只在 cap 失效之后才考虑。
    const big = 'y'.repeat(60_000);
    const tool = stubTool('web_fetch', { content: big });
    const wrapped = wrapToolWithCap(tool, { maxChars: 100_000, toolResultsDir: dir });
    const r = await wrapped.execute({}, ctx);
    expect(r.content).toBe(big);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('read_file ≤100K passes through verbatim (normal reads unaffected)', async () => {
    const content = 'r'.repeat(90_000);
    const tool = stubTool('read_file', { content });
    const wrapped = wrapToolWithCap(tool, { maxChars: MAX_RESULT_CHARS_BY_TOOL.read_file, toolResultsDir: dir });
    const r = await wrapped.execute({}, ctx);
    expect(r.content).toBe(content);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('read_file >100K spills + returns a <persisted-output> reference (re-pageable via charStart/charEnd)', async () => {
    const content = 'z'.repeat(120_000);
    const tool = stubTool('read_file', { content });
    const wrapped = wrapToolWithCap(tool, { maxChars: MAX_RESULT_CHARS_BY_TOOL.read_file, toolResultsDir: dir });
    const r = await wrapped.execute({}, ctx);
    expect(r.content).toMatch(/^<persisted-output tool="read_file" size="120000" path="/);
    expect(r.content).toMatch(/Use read_file\(path\)/);
    const files = fs.readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^read_file\.[0-9a-f]{12}\.txt$/);
  });

  it('images field preserved regardless of content size', async () => {
    const big = 'z'.repeat(40_000);
    const img = { data: 'Zm9v', mediaType: 'image/jpeg' }; // base64 "foo"
    const tool = stubTool('web_fetch', { content: big, images: [img] });
    const wrapped = wrapToolWithCap(tool, { maxChars: 30_000, toolResultsDir: dir });
    const r = await wrapped.execute({}, ctx);
    expect(r.images).toEqual([img]);
  });

  it('isError result truncates but does NOT persist', async () => {
    const big = 'e'.repeat(80_000); // > PERSIST_THRESHOLD
    const tool = stubTool('bash', { content: big, isError: true });
    const wrapped = wrapToolWithCap(tool, { maxChars: 30_000, toolResultsDir: dir });
    const r = await wrapped.execute({}, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('[truncated by bash: 50000 chars removed]');
    // no file written — errors don't persist
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it('Infinity maxChars → returns the original tool reference (no wrap)', () => {
    const tool = stubTool('read_file', { content: 'doesnt matter' });
    const wrapped = wrapToolWithCap(tool, { maxChars: Infinity, toolResultsDir: dir });
    expect(wrapped).toBe(tool);
  });

  it('preserves executionMode on a CAPPED tool (G4 parallel flag must survive wrapping)', () => {
    // Regression: the wrapper used to rebuild the tool with only
    // name/description/inputSchema/execute, silently dropping executionMode —
    // which made every capped parallel tool (search/grep/web + run_worker /
    // dispatch_to) run SEQUENTIALLY in the runner's G4 partitioner.
    const tool: AgentTool = {
      name: 'grep_files',
      description: 'stub',
      inputSchema: { type: 'object', properties: {} },
      executionMode: 'parallel',
      async execute() { return { content: 'x' }; },
    };
    const wrapped = wrapToolWithCap(tool, { maxChars: 30_000, toolResultsDir: dir });
    expect(wrapped).not.toBe(tool);          // it IS wrapped (finite cap)
    expect(wrapped.executionMode).toBe('parallel');
  });

  it('a wrapped sequential (default) tool stays sequential — executionMode undefined', () => {
    const tool = stubTool('bash', { content: 'x' }); // no executionMode
    const wrapped = wrapToolWithCap(tool, { maxChars: 30_000, toolResultsDir: dir });
    expect(wrapped.executionMode).toBeUndefined();
  });
});

describe('tool-result-cap › buildPersistedOutputMarker', () => {
  it('embeds head + tail + omitted count for very large content', () => {
    const head = 'H'.repeat(2000);
    const middle = 'M'.repeat(10_000);
    const tail = 'T'.repeat(500);
    const body = head + middle + tail;
    const marker = buildPersistedOutputMarker('/tmp/x.txt', 'bash', body);
    expect(marker).toContain('H'.repeat(2000));
    expect(marker).toContain('T'.repeat(500));
    expect(marker).toContain('[10000 chars omitted]');
    expect(marker).toContain('size="12500"');
  });

  it('omits the ellipsis block when content fits in head+tail', () => {
    const body = 'short';
    const marker = buildPersistedOutputMarker('/tmp/x.txt', 'bash', body);
    expect(marker).not.toContain('chars omitted');
    expect(marker).toContain('short');
  });
});

describe('tool-result-cap › sweepToolResults', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it('removes entries older than maxAgeDays', () => {
    const oldFile = path.join(dir, 'old.txt');
    const youngFile = path.join(dir, 'young.txt');
    fs.writeFileSync(oldFile, 'old');
    fs.writeFileSync(youngFile, 'young');
    // Backdate the old file 10 days.
    const past = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldFile, past / 1000, past / 1000);

    sweepToolResults(dir, 7);

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(youngFile)).toBe(true);
  });

  it('nothrow on missing directory', () => {
    const missing = path.join(dir, 'does-not-exist');
    expect(() => sweepToolResults(missing, 7)).not.toThrow();
  });

  it('recursively removes stale subdirectories', () => {
    const oldDir = path.join(dir, 'sess-old');
    fs.mkdirSync(oldDir);
    fs.writeFileSync(path.join(oldDir, 'a.txt'), 'a');
    const past = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldDir, past / 1000, past / 1000);

    sweepToolResults(dir, 7);
    expect(fs.existsSync(oldDir)).toBe(false);
  });
});

describe('tool-result-cap › persistToolResult', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it('creates the directory lazily if missing', () => {
    const nested = path.join(dir, 'deep', 'nest');
    const abs = persistToolResult(nested, 'bash', 'hello');
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('hello');
  });

  it('generates distinct filenames for distinct content', () => {
    const a = persistToolResult(dir, 'bash', 'content A');
    const b = persistToolResult(dir, 'bash', 'content B');
    expect(a).not.toBe(b);
    expect(fs.readFileSync(a, 'utf8')).toBe('content A');
    expect(fs.readFileSync(b, 'utf8')).toBe('content B');
  });
});

describe('tool-result-cap › maybeSpillToolResult (CLI side)', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => cleanup(dir));

  it('passes through unchanged when under the persist threshold', () => {
    const r = maybeSpillToolResult({
      toolResultsDir: dir,
      toolName: 'bash',
      callId: 'c1',
      output: 'small output',
    });
    expect(r.output).toBe('small output');
    expect(r.outputPath).toBeUndefined();
    // Did NOT create the directory — under-threshold means no IO.
    expect(fs.existsSync(path.join(dir, 'bash.txt'))).toBe(false);
  });

  it('spills to disk and returns marker + path when above threshold', () => {
    const big = 'X'.repeat(PERSIST_THRESHOLD + 100);
    const r = maybeSpillToolResult({
      toolResultsDir: dir,
      toolName: 'bash',
      callId: 'c1',
      output: big,
    });
    expect(r.outputPath).toBeTruthy();
    expect(r.outputPath!.startsWith(dir)).toBe(true);
    expect(fs.existsSync(r.outputPath!)).toBe(true);
    expect(fs.readFileSync(r.outputPath!, 'utf8')).toBe(big);
    // Marker preview wraps the path + sizes (same shape as in-process
    // tool spill so the renderer can treat both identically).
    expect(r.output).toMatch(/<persisted-output/);
    expect(r.output).toContain(r.outputPath!);
    expect(r.output.length).toBeLessThan(big.length);
  });

  it('returns the same shape as buildPersistedOutputMarker so renderers can normalize', () => {
    const big = 'A'.repeat(PERSIST_THRESHOLD + 50);
    const r = maybeSpillToolResult({
      toolResultsDir: dir, toolName: 'bash', callId: 'c1', output: big,
    });
    const marker = buildPersistedOutputMarker(r.outputPath!, 'bash', big);
    // Marker text differs only by the path (which we just substituted),
    // so the prefix must match.
    expect(r.output.startsWith('<persisted-output')).toBe(true);
    expect(marker.startsWith('<persisted-output')).toBe(true);
  });

  it('handles empty output without touching disk', () => {
    const r = maybeSpillToolResult({
      toolResultsDir: dir, toolName: 'bash', callId: 'c1', output: '',
    });
    expect(r.output).toBe('');
    expect(r.outputPath).toBeUndefined();
  });
});
