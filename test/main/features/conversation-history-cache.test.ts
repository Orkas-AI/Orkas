import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_UID = 'history-cache-user';

let tmpDir: string;
let sourceFile: string;
let previousWorkspaceRoot: string | undefined;

function message(id: string, process: unknown[] = []): Record<string, unknown> {
  return {
    id,
    ts: '2026-08-27T12:00:00',
    from: 'commander',
    to: ['user'],
    text: `message ${id}`,
    ...(process.length ? { process } : {}),
  };
}

function toolMessage(id: string, output: string): Record<string, unknown> {
  return message(id, [{
    type: 'event',
    event: { stream: 'tool', data: { phase: 'end', id: `tool-${id}`, name: 'bash', output } },
  }]);
}

function structuredToolMessage(id: string, output: Record<string, unknown>): Record<string, unknown> {
  return message(id, [{
    type: 'event',
    event: {
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'result',
        callId: `tool-${id}`,
        tool: 'orkas.orkas_run_skill',
        output,
      },
    },
  }]);
}

function writeRows(rows: Array<Record<string, unknown>>): void {
  fs.writeFileSync(sourceFile, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function cacheRoot(): string {
  return path.join(
    process.env.ORKAS_WORKSPACE_ROOT!, TEST_UID, 'local', 'cache', 'conversation-history',
  );
}

function onlyCacheEntry(): string {
  const entries = fs.readdirSync(cacheRoot());
  expect(entries).toHaveLength(1);
  return path.join(cacheRoot(), entries[0]);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-history-cache-'));
  sourceFile = path.join(tmpDir, 'canonical.jsonl');
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(tmpDir, 'workspace');
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('conversation history projection cache', () => {
  it('caches only the requested tail page and moves large output behind lazy files', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => toolMessage(
      `m${index + 1}`,
      `tool-${index}-output\n`.repeat(20_000),
    ));
    writeRows(rows);
    const canonicalBytes = fs.statSync(sourceFile).size;
    const { readConversationHistoryPage } = await import(
      '../../../src/main/features/conversation_history_cache'
    );

    const page = await readConversationHistoryPage(TEST_UID, sourceFile, 10);

    expect(page.records.map((record) => record.id)).toEqual(
      Array.from({ length: 10 }, (_, index) => `m${index + 21}`),
    );
    expect(page.nextCursor).not.toBeNull();
    const cacheEntry = onlyCacheEntry();
    const latestPageFile = path.join(cacheEntry, 'latest-page.json');
    const cached = JSON.parse(fs.readFileSync(latestPageFile, 'utf8'));
    expect(cached.records).toHaveLength(10);
    expect(fs.statSync(latestPageFile).size).toBeLessThan(canonicalBytes / 20);
    expect(fs.readdirSync(path.join(cacheEntry, 'tool-results'))).toHaveLength(10);

    const toolEnd = (page.records[0].process as any[])[0];
    expect(toolEnd.event.data.output).toBeUndefined();
    expect(fs.readFileSync(toolEnd.event.data.result_path, 'utf8')).toContain('tool-20-output');

    // Canonical persistence remains lossless and suitable for model/debug replay.
    const canonicalTail = JSON.parse(fs.readFileSync(sourceFile, 'utf8').trim().split('\n').at(-1)!);
    expect(canonicalTail.process[0].event.data.output).toContain('tool-29-output');
  });

  it('omits large structured CLI results from the derived page', async () => {
    const structuredOutput = {
      ok: true,
      sections: Array.from({ length: 200 }, (_, index) => ({
        index,
        content: `structured result ${index} `.repeat(20),
      })),
    };
    writeRows([structuredToolMessage('m1', structuredOutput)]);
    const { readConversationHistoryPage } = await import(
      '../../../src/main/features/conversation_history_cache'
    );

    const page = await readConversationHistoryPage(TEST_UID, sourceFile, 10);

    const result = (page.records[0].process as any[])[0].event.data;
    expect(result.output).toBeUndefined();
    expect(result.outputPath).toBeUndefined();
    expect(fs.statSync(path.join(onlyCacheEntry(), 'latest-page.json')).size).toBeLessThan(4_000);

    const canonical = JSON.parse(fs.readFileSync(sourceFile, 'utf8').trim());
    expect(canonical.process[0].event.data.output).toEqual(structuredOutput);
  });

  it('keeps structured plan results needed to rebuild visible plan rows', async () => {
    const planOutput = {
      action: 'update',
      steps: [{ step: 'Keep this visible', status: 'in_progress' }],
      diagnostic: 'x'.repeat(2_000),
    };
    writeRows([structuredToolMessage('m1', planOutput)]);
    const { readConversationHistoryPage } = await import(
      '../../../src/main/features/conversation_history_cache'
    );

    const page = await readConversationHistoryPage(TEST_UID, sourceFile, 10);

    const result = (page.records[0].process as any[])[0].event.data;
    expect(result.output).toEqual(planOutput);
  });

  it('extends the newest page from appended bytes without duplicating old rows', async () => {
    writeRows([message('m1'), message('m2'), message('m3')]);
    const { readConversationHistoryPage } = await import(
      '../../../src/main/features/conversation_history_cache'
    );
    const first = await readConversationHistoryPage(TEST_UID, sourceFile, 2);
    expect(first.records.map((record) => record.id)).toEqual(['m2', 'm3']);

    fs.appendFileSync(sourceFile, `${JSON.stringify(message('m4'))}\n`);
    const extended = await readConversationHistoryPage(TEST_UID, sourceFile, 2);

    expect(extended.records.map((record) => record.id)).toEqual(['m3', 'm4']);
    const cached = JSON.parse(fs.readFileSync(path.join(onlyCacheEntry(), 'latest-page.json'), 'utf8'));
    expect(cached.records.map((entry: any) => entry.record.id)).toEqual(['m3', 'm4']);
  });

  it('extends the cache across a multi-megabyte appended record with one assembly copy', async () => {
    writeRows([message('m1')]);
    const { readConversationHistoryPage } = await import(
      '../../../src/main/features/conversation_history_cache'
    );
    await readConversationHistoryPage(TEST_UID, sourceFile, 2);
    fs.appendFileSync(sourceFile, `${JSON.stringify(structuredToolMessage('m2', {
      ok: true,
      content: 'x'.repeat(2 * 1024 * 1024),
    }))}\n`);
    const concat = vi.spyOn(Buffer, 'concat');
    try {
      const page = await readConversationHistoryPage(TEST_UID, sourceFile, 2);

      expect(page.records.map((record) => record.id)).toEqual(['m1', 'm2']);
      expect(concat.mock.calls.length).toBeLessThanOrEqual(1);
    } finally {
      concat.mockRestore();
    }
  });

  it('expands a small cached page when a larger tail is requested', async () => {
    writeRows(Array.from({ length: 12 }, (_, index) => message(`m${index + 1}`)));
    const { readConversationHistoryPage } = await import(
      '../../../src/main/features/conversation_history_cache'
    );
    expect((await readConversationHistoryPage(TEST_UID, sourceFile, 3)).records).toHaveLength(3);

    const expanded = await readConversationHistoryPage(TEST_UID, sourceFile, 8);

    expect(expanded.records.map((record) => record.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `m${index + 5}`),
    );
    const cached = JSON.parse(fs.readFileSync(path.join(onlyCacheEntry(), 'latest-page.json'), 'utf8'));
    expect(cached.records).toHaveLength(8);
  });

  it('does not widen the persisted newest page for a whole-conversation read', async () => {
    // The outputs panel asks for 500 records; before the cap every later
    // 10-record first paint and every append re-parsed and rewrote a
    // 500-record page (2026-08-28 review E2-1).
    writeRows(Array.from({ length: 30 }, (_, index) => message(`m${index + 1}`)));
    const { readConversationHistoryPage } = await import(
      '../../../src/main/features/conversation_history_cache'
    );
    expect((await readConversationHistoryPage(TEST_UID, sourceFile, 10)).records).toHaveLength(10);

    const whole = await readConversationHistoryPage(TEST_UID, sourceFile, 500);
    expect(whole.records.map((record) => record.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `m${index + 1}`),
    );
    const cached = JSON.parse(fs.readFileSync(path.join(onlyCacheEntry(), 'latest-page.json'), 'utf8'));
    expect(cached.records).toHaveLength(10);
  });

  it('coalesces concurrent cold reads into one valid newest-page cache', async () => {
    writeRows(Array.from({ length: 20 }, (_, index) => message(`m${index + 1}`)));
    const { readConversationHistoryPage } = await import(
      '../../../src/main/features/conversation_history_cache'
    );

    const pages = await Promise.all(
      Array.from({ length: 100 }, () => readConversationHistoryPage(TEST_UID, sourceFile, 10)),
    );

    expect(pages.every((page) => page.records.length === 10)).toBe(true);
    const cached = JSON.parse(fs.readFileSync(path.join(onlyCacheEntry(), 'latest-page.json'), 'utf8'));
    expect(cached.records).toHaveLength(10);
  });

  it('purges the derived conversation copy without deleting canonical history', async () => {
    writeRows([message('m1')]);
    const {
      purgeConversationHistoryCache,
      readConversationHistoryPage,
    } = await import('../../../src/main/features/conversation_history_cache');
    await readConversationHistoryPage(TEST_UID, sourceFile, 10);
    const entry = onlyCacheEntry();

    await purgeConversationHistoryCache(TEST_UID, sourceFile);

    expect(fs.existsSync(entry)).toBe(false);
    expect(fs.existsSync(sourceFile)).toBe(true);
  });
});
