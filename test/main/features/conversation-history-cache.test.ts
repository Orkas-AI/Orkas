import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

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

afterEach(async () => {
  await (await import('../../../src/main/features/conversation-history-client')).closeConversationHistoryWorker();
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('conversation history projection cache', () => {
  it.each([
    ['local seconds', '2026-10-26T14:31:24', '2026-10-26T14:31:11.226', '2026-10-26T14:31:24.602', 13374, true],
    ['UTC seconds', '2026-10-26T06:31:24Z', '2026-10-26T06:31:11.226Z', '2026-10-26T06:31:24.602Z', 13374, true],
    ['offset seconds', '2026-10-26T14:31:24+08:00', '2026-10-26T06:31:11.226Z', '2026-10-26T06:31:24.602Z', 13374, true],
    ['last millisecond', '2026-10-26T06:31:24Z', '2026-10-26T06:31:11.226Z', '2026-10-26T06:31:24.999Z', 13773, true],
    ['next second', '2026-10-26T06:31:24Z', '2026-10-26T06:31:11.226Z', '2026-10-26T06:31:25.000Z', 13774, false],
    ['explicit milliseconds', '2026-10-26T06:31:24.000Z', '2026-10-26T06:31:11.226Z', '2026-10-26T06:31:24.602Z', 13374, false],
    ['subsecond run', '2026-10-26T06:31:24Z', '2026-10-26T06:31:24.226Z', '2026-10-26T06:31:24.602Z', 374, true],
    ['duration exceeds notice precision', '2026-10-26T06:31:24Z', '2026-10-26T06:31:11.226Z', '2026-10-26T06:31:24.602Z', 14000, false],
  ] as const)('preserves an interrupted reply and its evidenced clock at timestamp precision boundaries: %s',
    async (_shape, ts, startedAt, endedAt, durationMs, expectedClock) => {
      const notice = { ...message('interrupted'), from: 'codex-agent', ts, text: 'The previous reply was interrupted.',
        system_kind: 'reply_interrupted', turn_id: 'turn-cancelled', source_message_id: 'source', seg: 0,
        process: [{ type: 'event', event: { stream: 'cli', data: { type: 'status', status: 'running' } } }] };
      writeRows([{ ...message('source'), from: 'user', ts: startedAt }, notice]);
      const original = fs.readFileSync(sourceFile, 'utf8');
      const paths = await import('../../../src/main/paths');
      const run = paths.localAgentRunDir(TEST_UID, '123456abcdef');
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ cid: 'canonical', agentId: 'codex-agent', cli: 'codex',
        currentMessageId: 'source', startedAt, endedAt, durationMs, status: 'cancelled' }));
      const cache = await import('../../../src/main/features/conversation_history_cache');
      const { records: [record] } = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
      const clocks = record.process?.filter(item => item.event?.stream === 'runtime') || [];
      expect(clocks).toEqual(expectedClock ? [{ type: 'event', event: { stream: 'runtime', data: {
        phase: 'interrupted', duration_ms: durationMs,
      } } }] : []);
      expect(record.display_phase).not.toBe('commentary');
      expect(record.text).toBe(notice.text);
      expect(record.process?.filter(item => item.event?.stream !== 'runtime')).toEqual(notice.process);
      await (await import('../../../src/main/features/conversation-history-client')).closeConversationHistoryWorker();
      expect((await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1)).records[0]).toEqual(record);
      expect((await cache.readConversationHistoryWindowAtMessage(TEST_UID, sourceFile, notice.id, 1))?.records[0]).toEqual(record);
      expect(fs.readFileSync(sourceFile, 'utf8')).toBe(original);
    });

  it.each(['inline', 'paged', 'already-timed', 'wrong-source', 'dispatch-source'])(
    'fills only the missing interruption clock without duplicating saved process: %s', async shape => {
      const saved = Array.from({ length: shape === 'paged' ? 1200 : 1 }, (_, i) => ({ type: 'progress', text: `Saved step ${i}` }));
      const clock = { type: 'event', event: { stream: 'runtime', data: { phase: 'interrupted', duration_ms: 7000 } } };
      writeRows([
        { ...message('source'), from: shape === 'dispatch-source' ? 'commander' : 'user',
          ...(shape === 'dispatch-source' ? { dispatch: true, to: ['codex-agent'] } : {}), ts: '2026-10-17T01:00:00Z' },
        { ...message('interrupted'), from: 'codex-agent', ts: '2026-10-17T02:00:00Z',
          source_message_id: 'source', system_kind: 'reply_interrupted', process: [...saved, ...(shape === 'already-timed' ? [clock] : [])] },
      ]);
      const original = fs.readFileSync(sourceFile, 'utf8');
      const paths = await import('../../../src/main/paths');
      const run = paths.localAgentRunDir(TEST_UID, '123456abcdef');
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ cid: 'canonical', agentId: 'codex-agent', cli: 'codex',
        currentMessageId: shape === 'wrong-source' ? 'different-source' : 'source',
        startedAt: '2026-10-17T01:00:01Z', endedAt: '2026-10-17T01:00:11Z', durationMs: 10000 }));
      fs.writeFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ type: 'tool-event', phase: 'result', tool: 'bash', callId: 'duplicate', output: 'Duplicate' }) + '\n');
      const cache = await import('../../../src/main/features/conversation_history_cache');
      const { records: [record] } = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
      const clocks = record.process?.filter(item => item.event?.stream === 'runtime') || [];
      expect(clocks).toEqual(shape === 'wrong-source' ? [] : [shape === 'already-timed' ? clock : {
        type: 'event', event: { stream: 'runtime', data: { phase: 'interrupted', duration_ms: 10000 } },
      }]);
      const items: any[] = record.process_parts?.length ? [] : record.process || [];
      for (const part of record.process_parts || []) {
        if (!('ref' in part)) throw new Error('Expected a saved process page');
        let cursor: number | null = 0;
        do {
          const page = await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, cursor, record.id);
          items.push(...page.items); cursor = page.nextCursor;
        } while (cursor !== null);
      }
      expect(items.filter(item => item.type === 'progress')).toEqual(saved);
      expect(JSON.stringify(items)).not.toContain('Duplicate');
      await (await import('../../../src/main/features/conversation-history-client')).closeConversationHistoryWorker();
      expect((await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1)).records[0]).toEqual(record);
      expect(fs.readFileSync(sourceFile, 'utf8')).toBe(original);
    });

  it.each(['measured', 'estimated', 'missing', 'overlap'])(
    'recovers an interruption clock across identified attempts without counting downtime: %s', async timing => {
      writeRows([
        { ...message('source'), from: 'user', ts: '2026-10-17T01:00:00Z' },
        { ...message('interrupted'), from: 'codex-agent', ts: '2026-10-17T04:00:00Z', system_kind: 'reply_interrupted' },
      ]);
      const paths = await import('../../../src/main/paths');
      for (const [id, startedAt, endedAt, durationMs] of [
        ['123456abcdef', '2026-10-17T01:00:01Z', '2026-10-17T01:00:11Z', 10000],
        ['abcdef123456', timing === 'overlap' ? '2026-10-17T01:00:06Z' : '2026-10-17T03:00:00Z',
          timing === 'overlap' ? '2026-10-17T01:00:16Z' : '2026-10-17T03:00:05Z', timing === 'overlap' ? 10000 : 5000],
      ] as const) {
        const run = paths.localAgentRunDir(TEST_UID, id);
        fs.mkdirSync(run, { recursive: true });
        const last = id === 'abcdef123456';
        fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ cid: 'canonical', agentId: 'codex-agent', cli: 'codex',
          currentMessageId: 'source', startedAt, ...(!last || timing === 'measured' || timing === 'overlap' ? { endedAt, durationMs } : {}) }));
        const file = path.join(run, 'events.jsonl');
        fs.writeFileSync(file, timing === 'missing' && last ? '' : JSON.stringify({ type: 'tool-event', phase: 'result', tool: 'bash', callId: id, output: 'Saved' }) + '\n');
        fs.utimesSync(file, new Date(endedAt), new Date(endedAt));
      }
      const cache = await import('../../../src/main/features/conversation_history_cache');
      const { records: [record] } = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
      expect(record.process?.filter(item => item.event?.stream === 'runtime') || []).toEqual(timing === 'missing' ? [] : [{
        type: 'event', event: { stream: 'runtime', data: { phase: 'interrupted', duration_ms: 15000,
          ...(timing === 'estimated' ? { duration_estimated: true } : {}) } },
      }]);
      expect(record.process_parts).toHaveLength(timing === 'missing' ? 1 : 2);
      expect(record.system_kind).toBe('reply_interrupted');
    });

  it('prefers the notice actor archive when a delegated CLI question is the last visible activity', async () => {
    writeRows([
      { ...message('user-1'), from: 'user', to: ['commander'], ts: '2026-10-17T01:00:00Z' },
      { ...message('question-1'), from: 'codex-agent', ts: '2026-10-17T02:00:00Z', turn_id: 'nested-turn',
        cli_question: { questions: [] } },
      { ...message('interrupted'), ts: '2026-10-17T12:14:21Z', system_kind: 'reply_interrupted' },
    ]);
    const paths = await import('../../../src/main/paths');
    for (const [id, agentId] of [['123456abcdef', 'commander'], ['abcdef123456', 'codex-agent']]) {
      const run = paths.localAgentRunDir(TEST_UID, id);
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ cid: 'canonical', agentId, cli: 'codex',
        currentMessageId: 'user-1', startedAt: '2026-10-17T01:00:01Z', endedAt: '2026-10-17T12:00:01Z' }));
      fs.writeFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ type: 'tool-event', phase: 'result',
        tool: 'bash', callId: agentId, output: `${agentId} saved work` }) + '\n');
    }
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const { records: [record] } = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
    expect(record.process_parts).toHaveLength(1);
    const part = record.process_parts![0];
    if (!('ref' in part)) throw new Error('Missing original actor process');
    const { items } = await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 0, record.id);
    expect(items.map(item => (item.event?.data as any)?.callId)).toEqual(['commander']);
  });

  it.each(['question', 'answer', 'direct', 'wrong-source', 'legacy', 'settled', 'commander', 'multiple-recipients'])(
    'associates a fallback Commander interruption with only its explicitly addressed CLI run: %s', async variation => {
      // Startup may have no in-flight actor and create a Commander notice.
      // The original user destination and archive trigger, not the notice's
      // fallback sender or free-form question text, identify the lost work.
      const rows = [
        { ...message('previous-user'), from: 'user', to: ['codex-agent'], ts: '2026-10-17T00:00:00Z' },
        { ...message('previous-reply'), from: 'codex-agent', source_message_id: 'previous-user', ts: '2026-10-17T00:10:00Z' },
        { ...message('user-1'), from: 'user', to: variation === 'commander' ? ['commander']
          : variation === 'multiple-recipients' ? ['codex-agent', 'other-agent'] : ['codex-agent'], ts: '2026-10-17T01:00:00Z' },
        ...(['direct', 'commander', 'multiple-recipients'].includes(variation) ? [] : [{
          ...message('question-1'), from: 'codex-agent', ts: '2026-10-17T02:00:00Z', turn_id: 'active-turn',
          cli_question: { questions: [] },
        }]),
        ...(variation === 'answer' ? [{ ...message('answer-1'), from: 'user', to: ['codex-agent'],
          ts: '2026-10-17T02:01:00Z', cli_answer: { message_id: 'question-1', answers: {} } }] : []),
        ...(variation === 'settled' ? [{ ...message('saved-reply'), from: 'codex-agent',
          ts: '2026-10-17T03:00:00Z', source_message_id: 'user-1' }] : []),
        { ...message('interrupted'), ts: '2026-10-17T12:14:21Z', system_kind: 'reply_interrupted' },
      ];
      writeRows(rows);
      const original = fs.readFileSync(sourceFile, 'utf8');
      const paths = await import('../../../src/main/paths');
      const run = paths.localAgentRunDir(TEST_UID, '123456abcdef');
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ cid: 'canonical',
        agentId: 'codex-agent', cli: 'codex', startedAt: '2026-10-17T01:00:01Z',
        endedAt: '2026-10-17T12:00:01Z', durationMs: 39_600_000,
        ...(variation === 'legacy' ? {} : { currentMessageId: variation === 'wrong-source' ? 'previous-user' : 'user-1' }) }));
      fs.writeFileSync(path.join(run, 'events.jsonl'), [
        { type: 'text-delta', phase: 'commentary', text: 'Checking the remaining files.' },
        { type: 'tool-event', phase: 'result', tool: 'bash', callId: 'current-run', output: 'Reviewed 42 files.' },
      ].map(event => JSON.stringify(event)).join('\n') + '\n');
      const cache = await import('../../../src/main/features/conversation_history_cache');
      const { records: [record] } = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
      if (['question', 'answer', 'direct'].includes(variation)) {
        expect(record.process).toContainEqual({ type: 'event', event: { stream: 'runtime', data: {
          phase: 'interrupted', duration_ms: 39_600_000,
        } } });
        expect(record.process_parts).toHaveLength(1);
        const part = record.process_parts![0];
        if (!('ref' in part)) throw new Error('Missing recovered CLI process');
        const { items } = await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 0, record.id);
        expect(items[0]).toMatchObject({ type: 'progress', text: 'Checking the remaining files.' });
        expect(items[1].event?.data).toMatchObject({ callId: 'current-run', output: 'Reviewed 42 files.' });
        await (await import('../../../src/main/features/conversation-history-client')).closeConversationHistoryWorker();
        expect((await cache.readConversationHistoryWindowAtMessage(TEST_UID, sourceFile, record.id, 1))?.records[0])
          .toEqual(record);
      } else {
        expect(record.process_parts).toBeUndefined();
        expect(record.process).toBeUndefined();
      }
      expect(record.from).toBe('commander');
      expect(record.system_kind).toBe('reply_interrupted');
      expect(record.text).toBe('message interrupted');
      expect(fs.readFileSync(sourceFile, 'utf8')).toBe(original);
    });

  it.each(['last-write', 'done', 'retry-after-done', 'future-write', 'old-write', 'empty', 'timing-only'])(
    'recovers interrupted timing without finalized metadata: %s', async timing => {
      writeRows([
        { ...message('user-1'), from: 'user', ts: '2026-10-17T01:00:00Z' },
        { ...message('interrupted'), from: 'codex-agent', ts: '2026-10-17T12:14:21Z', system_kind: 'reply_interrupted' },
      ]);
      const paths = await import('../../../src/main/paths');
      const run = paths.localAgentRunDir(TEST_UID, '123456abcdef');
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ runId: '123456abcdef',
        cid: 'canonical', agentId: 'codex-agent', cli: 'codex', currentMessageId: 'user-1',
        startedAt: '2026-10-17T01:00:03.973Z',
        ...(timing === 'timing-only' ? { durationMs: 40_430_000 } : {}) }));
      const events = timing === 'empty' || timing === 'timing-only' ? [] : [
        ...(timing === 'retry-after-done' ? [{ type: 'done', status: 'failed', durationMs: 1000 }] : []),
        { type: 'tool-event', phase: 'result', tool: 'bash', callId: 'saved', durationMs: 25, output: 'Saved work' },
        ...(timing === 'done' ? [{ type: 'done', status: 'cancelled', durationMs: 40_430_000 }] : []),
      ];
      const eventsFile = path.join(run, 'events.jsonl');
      fs.writeFileSync(eventsFile, events.length ? events.map(e => JSON.stringify(e)).join('\n') + '\n' : '');
      const writtenAt = new Date(timing === 'future-write' ? '2026-10-17T12:15:00Z'
        : timing === 'old-write' ? '2026-10-17T00:00:00Z' : '2026-10-17T11:13:55.849Z');
      fs.utimesSync(eventsFile, writtenAt, writtenAt);
      const original = fs.readFileSync(sourceFile, 'utf8');
      const cache = await import('../../../src/main/features/conversation_history_cache');
      const { records: [record] } = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
      const runtimes = record.process?.filter(item => item.event?.stream === 'runtime') || [];
      if (['last-write', 'retry-after-done', 'done', 'timing-only'].includes(timing)) {
        const estimated = timing === 'last-write' || timing === 'retry-after-done';
        expect(runtimes).toEqual([{ type: 'event', event: { stream: 'runtime', data: {
          phase: 'interrupted', duration_ms: estimated ? 36_831_876 : 40_430_000,
          ...(estimated ? { duration_estimated: true } : {}),
        } } }]);
        await (await import('../../../src/main/features/conversation-history-client')).closeConversationHistoryWorker();
        expect((await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1)).records[0]).toEqual(record);
      } else expect(runtimes).toEqual([]);
      expect(record.system_kind).toBe('reply_interrupted');
      expect(record.text).toBe('message interrupted');
      expect(fs.readFileSync(sourceFile, 'utf8')).toBe(original);
    });

  it.each(['timestamps', 'measured', 'missing-end', 'invalid-end'])(
    'restores only an evidenced elapsed duration for an interrupted run: %s', async timing => {
      writeRows([
        { ...message('user-1'), from: 'user', ts: '2026-10-17T01:00:00Z' },
        { ...message('interrupted'), from: 'codex-agent', ts: '2026-10-17T12:14:21Z', system_kind: 'reply_interrupted' },
      ]);
      const paths = await import('../../../src/main/paths');
      const run = paths.localAgentRunDir(TEST_UID, '123456abcdef');
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ runId: '123456abcdef',
        cid: 'canonical', agentId: 'codex-agent', cli: 'codex', startedAt: '2026-10-17T01:00:03.973Z',
        ...(timing === 'missing-end' ? {} : { endedAt: timing === 'invalid-end' ? 'invalid' : '2026-10-17T12:13:55.849Z' }),
        ...(timing === 'measured' ? { durationMs: 40_430_000 } : {}) }));
      fs.writeFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ type: 'tool-event', phase: 'result', tool: 'bash', callId: 'saved', output: 'Saved work' }) + '\n');
      const original = fs.readFileSync(sourceFile, 'utf8');
      const cache = await import('../../../src/main/features/conversation_history_cache');
      const { records: [record] } = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
      if (timing === 'timestamps' || timing === 'measured') {
        expect(record.process).toContainEqual({ type: 'event', event: { stream: 'runtime', data: {
          phase: 'interrupted', duration_ms: timing === 'timestamps' ? 40_431_876 : 40_430_000,
        } } });
        expect(record.process_parts?.length).toBe(1);
        await (await import('../../../src/main/features/conversation-history-client')).closeConversationHistoryWorker();
        expect((await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1)).records[0].process).toEqual(record.process);
      } else {
        expect(record.process?.some(item => item.event?.stream === 'runtime')).not.toBe(true);
      }
      expect(record.system_kind).toBe('reply_interrupted');
      expect(record.process?.some(item => (item.event?.data as any)?.phase === 'end')).not.toBe(true);
      expect(fs.readFileSync(sourceFile, 'utf8')).toBe(original);
    });

  it('restores an interrupted CLI trail from its scoped archive across reopen, paging and cache clearing', async () => {
    const user = { ...message('user-1'), from: 'user', ts: '2026-10-17T01:00:00Z' };
    const notice = { ...message('interrupted'), from: 'codex-agent', ts: '2026-10-17T12:14:00Z',
      system_kind: 'reply_interrupted', text: 'The previous reply was interrupted.' };
    writeRows([user, notice]);
    const paths = await import('../../../src/main/paths');
    const run = paths.localAgentRunDir(TEST_UID, '123456abcdef');
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ runId: '123456abcdef',
      cid: 'canonical', agentId: 'codex-agent', cli: 'codex', startedAt: '2026-10-17T01:00:01Z' }));
    const fullOutput = '🌟工具输出\n'.repeat(400);
    const events = [
      { type: 'text-delta', phase: 'commentary', text: 'Checking the saved submissions.' },
      { type: 'thinking', text: 'PRIVATE REASONING', chars: 17, summary: 'Checking progress' },
      ...Array.from({ length: 20_001 }, (_, n) => ({ type: 'tool-event', phase: 'result', tool: 'bash',
        callId: `call-${n}`, input: { command: `check ${n}` }, output: n ? `result-${n}` : fullOutput })),
      { type: 'text-delta', phase: 'final_answer', text: 'UNFINISHED ANSWER' },
      { type: 'idle', stalledMs: 30_000 },
    ];
    fs.writeFileSync(path.join(run, 'events.jsonl'), events.map(e => JSON.stringify(e)).join('\n') + '\n{"type":');
    const original = fs.readFileSync(sourceFile, 'utf8');
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const history = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
    expect(history.records[0]).toMatchObject({ id: notice.id, text: notice.text, system_kind: notice.system_kind });
    expect(history.records[0].process_parts?.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(32 * 1024);
    const readTrail = async (record: any) => {
      const items: any[] = [];
      for (const part of record.process_parts || []) {
        let cursor: number | null = 0;
        do {
          const page = await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, cursor!, notice.id);
          items.push(...page.items); cursor = page.nextCursor;
        } while (cursor !== null);
      }
      return items;
    };
    const trail = await readTrail(history.records[0]);
    expect(trail.filter(item => item.event?.data?.type === 'tool-event').map(item => item.event.data.callId))
      .toEqual(Array.from({ length: 20_001 }, (_, n) => `call-${n}`));
    expect(trail[0]).toMatchObject({ type: 'progress', text: events[0].text });
    const savedResult = trail.find(item => item.event?.data?.callId === 'call-0').event.data;
    expect(fs.readFileSync(savedResult.outputPath, 'utf8')).toBe(fullOutput);
    expect(JSON.stringify(trail)).not.toMatch(/PRIVATE REASONING|UNFINISHED ANSWER|stalledMs/);
    await (await import('../../../src/main/features/conversation-history-client')).closeConversationHistoryWorker();
    expect((await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1)).records).toEqual(history.records);
    await cache.purgeConversationHistoryCache(TEST_UID, sourceFile);
    expect(await readTrail(history.records[0])).toEqual(trail);
    expect((await cache.readConversationHistoryWindowAtMessage(TEST_UID, sourceFile, notice.id, 1))?.records[0].process_parts?.length)
      .toBeGreaterThan(0);
    expect((await cache.readConversationHistoryWindow(TEST_UID, sourceFile, 1, 1)).records[0].process_parts?.length)
      .toBeGreaterThan(0);
    expect(fs.readFileSync(sourceFile, 'utf8')).toBe(original);
  });

  it('keeps multiple exactly identified attempts in chronological order without claiming task completion', async () => {
    writeRows([
      { ...message('user-1'), from: 'user', ts: '2026-10-17T01:00:00Z' },
      { ...message('interrupted'), from: 'codex-agent', ts: '2026-10-17T12:14:00Z', system_kind: 'reply_interrupted' },
    ]);
    const paths = await import('../../../src/main/paths');
    for (const [id, startedAt, callId] of [
      ['123456abcdef', '2026-10-17T02:00:00Z', 'second'],
      ['abcdef123456', '2026-10-17T01:00:01Z', 'first'],
    ]) {
      const directory = paths.localAgentRunDir(TEST_UID, id);
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, 'meta.json'), JSON.stringify({ runId: id, cid: 'canonical',
        cli: 'codex', agentId: 'codex-agent', currentMessageId: 'user-1', startedAt }));
      fs.writeFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ type: 'tool-event', phase: 'result', tool: 'bash', callId, output: callId }) + '\n');
    }
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const { records: [record] } = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
    const items: any[] = [];
    for (const part of record.process_parts || []) {
      if ('ref' in part) items.push(...(await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 0, record.id)).items);
    }
    expect(items.map(item => item.event.data.callId)).toEqual(['first', 'second']);
    expect(record.system_kind).toBe('reply_interrupted');
    expect(record.text).toBe('message interrupted');
  });

  it.each([false, true])('restores a run that began before an in-flight user reply (trigger identity: %s)', async identified => {
    writeRows([
      { ...message('initial-user'), from: 'user', ts: '2026-10-17T01:00:00Z' },
      { ...message('async-question'), from: 'codex-agent', ts: '2026-10-17T02:02:00Z' },
      { ...message('steering-user'), from: 'user', ts: '2026-10-17T02:47:00Z' },
      { ...message('interrupted'), from: 'codex-agent', ts: '2026-10-17T12:14:00Z', system_kind: 'reply_interrupted' },
    ]);
    const paths = await import('../../../src/main/paths');
    const run = paths.localAgentRunDir(TEST_UID, '123456abcdef');
    fs.mkdirSync(run, { recursive: true });
    fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ runId: '123456abcdef', cid: 'canonical',
      agentId: 'codex-agent', cli: 'codex', startedAt: '2026-10-17T01:00:01Z',
      ...(identified ? { currentMessageId: 'initial-user' } : {}) }));
    fs.writeFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ type: 'tool-event', phase: 'result', tool: 'bash', callId: 'same-run', output: 'Saved work' }) + '\n');
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const { records: [record] } = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
    expect(record.process_parts?.length).toBe(1);
    const part = record.process_parts![0];
    if (!('ref' in part)) throw new Error('Missing archived process');
    expect((await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 0, record.id)).items)
      .toContainEqual({ type: 'event', event: { stream: 'cli', data: { type: 'tool-event', phase: 'result', tool: 'bash', callId: 'same-run', output: 'Saved work' } } });
  });

  it.each(['other-account', 'other-conversation', 'other-actor', 'older-turn', 'newer-run', 'ambiguous', 'symlink', 'wrong-source', 'existing-process', 'invalid-barrier', 'prior-reply'])(
    'does not attach unrelated or duplicate CLI history: %s', async variation => {
      const rows = [
        { ...message('user-1'), from: 'user', ts: '2026-10-17T01:00:00Z' },
        ...(variation === 'invalid-barrier' ? [{ ...message('bad-date'), from: 'user', ts: 'invalid' }] : []),
        ...(variation === 'prior-reply' ? [{ ...message('saved-reply'), from: 'codex-agent', ts: '2026-10-17T02:00:00Z',
          source_message_id: 'user-1' }] : []),
        { ...message('interrupted'), from: 'codex-agent', ts: '2026-10-17T12:14:00Z', system_kind: 'reply_interrupted',
          ...(variation === 'existing-process' ? { process: [{ type: 'progress', text: 'Already saved' }] } : {}) },
      ];
      writeRows(rows);
      const paths = await import('../../../src/main/paths');
      const run = paths.localAgentRunDir(variation === 'other-account' ? 'other-user' : TEST_UID, '123456abcdef');
      fs.mkdirSync(run, { recursive: true });
      fs.writeFileSync(path.join(run, 'meta.json'), JSON.stringify({ runId: '123456abcdef', cli: 'codex',
        cid: variation === 'other-conversation' ? 'other' : 'canonical',
        agentId: variation === 'other-actor' ? 'other' : 'codex-agent',
        startedAt: variation === 'older-turn' ? '2026-10-16T01:00:01Z'
          : variation === 'newer-run' ? '2026-10-17T13:00:00Z' : '2026-10-17T01:00:01Z',
        ...(variation === 'wrong-source' ? { currentMessageId: 'another-user-message' } : {}) }));
      fs.writeFileSync(path.join(run, 'events.jsonl'), JSON.stringify({ type: 'tool-event', phase: 'use', tool: 'bash', input: { command: 'WRONG RUN' } }) + '\n');
      if (variation === 'ambiguous') fs.cpSync(run, paths.localAgentRunDir(TEST_UID, 'abcdef123456'), { recursive: true });
      if (variation === 'symlink') {
        fs.renameSync(path.join(run, 'events.jsonl'), path.join(tmpDir, 'private-events.jsonl'));
        fs.symlinkSync(path.join(tmpDir, 'private-events.jsonl'), path.join(run, 'events.jsonl'));
      }
      const cache = await import('../../../src/main/features/conversation_history_cache');
      const history = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
      expect(history.records[0].process_parts).toBeUndefined();
      expect(history.records[0].process).toEqual(rows.at(-1).process);
    });
  it.each([0, 1001])('caches legacy native classification with %s process items across page boundaries without rewriting raw history', async count => {
    const earlier = { ...message('native-0'), from: 'claude', text: 'Checking the files.',
      turn_id: 'turn-native', source_message_id: 'user-1', seg: 0,
      process: Array.from({ length: count }, (_, n) => ({ type: 'progress', text: `Operation ${n}` })) };
    const final = { ...earlier, id: 'native-1', text: 'Final answer.', seg: 1,
      process: [{ type: 'event', event: { stream: 'runtime', data: { phase: 'end', duration_ms: 12 } } }] };
    writeRows([earlier, final]);
    const original = fs.readFileSync(sourceFile, 'utf8');
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const first = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1);
    expect(first.records[0]).toMatchObject({ display_phase: 'final_answer', text: 'Final answer.' });
    const previous = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1, first.nextCursor!);
    expect(previous.records[0]).toMatchObject({ display_phase: 'commentary', text: earlier.text });
    const part = previous.records[0].process_parts?.[0];
    const items = part && 'ref' in part
      ? (await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 0, earlier.id)).items
      : previous.records[0].process!;
    expect(items[0]).toEqual({ type: 'progress', text: earlier.text,
      event: { stream: 'assistant', data: { phase: 'commentary', native_segment: 0 } } });
    expect(items.filter(item => item.type === 'progress' && item.text === earlier.text)).toHaveLength(1);
    await (await import('../../../src/main/features/conversation-history-client')).closeConversationHistoryWorker();
    expect((await cache.readConversationHistoryPage(TEST_UID, sourceFile, 1)).records).toEqual(first.records);
    expect(fs.readFileSync(sourceFile, 'utf8')).toBe(original);
  });

  it('does not classify unknown, live or Commander records from their prose', async () => {
    const { projectConversationHistoryRecord } = await import('../../../src/main/features/conversation_history_cache');
    for (const record of [message('ordinary'), { ...message(''), from: 'claude', seg: 0, turn_id: 't', source_message_id: 'u', process: [] },
      { ...message('commander'), seg: 0, turn_id: 't', source_message_id: 'u', process: [] },
      { ...message('unknown'), from: 'claude', seg: 0, turn_id: 't' }]) {
      expect(projectConversationHistoryRecord(record as any, tmpDir)).toEqual(record);
    }
  });

  it('bounds raw process-page bytes independently of event count and keeps the legacy content address', async () => {
    const items = Array.from({ length: 401 }, (_, n) => ({ type: 'event', event: { stream: 'tool',
      data: { phase: 'end', name: 'bash', id: `call-${n}`, output: `${n}:` + '界🌟'.repeat(9400) } } }));
    const { storeProcessPages, readProcessPage, processCacheDirectory } = await import('../../../src/main/features/conversation-process-cache');
    const expected = createHash('sha256');
    for (let n = 0; n < items.length; n += 200) expected.update(JSON.stringify(items.slice(n, n + 200)) + '\n');
    const part = storeProcessPages(tmpDir, items as any);
    if (!('ref' in part)) throw new Error('Missing process reference');
    expect(part.ref).toBe(expected.digest('hex'));
    const directory = processCacheDirectory(tmpDir);
    const indexFile = fs.readdirSync(directory).find(name => name.endsWith('.json'))!;
    const index = JSON.parse(fs.readFileSync(path.join(directory, indexFile), 'utf8'));
    for (let n = 0; n < index.offsets.length; n++) {
      expect((index.offsets[n + 1] ?? index.bytes) - index.offsets[n]).toBeLessThanOrEqual(1024 * 1024);
    }
    const received: unknown[] = [];
    let cursor: number | null = 0;
    do {
      const page = await readProcessPage(tmpDir, part.ref, cursor!);
      expect(Buffer.byteLength(JSON.stringify(page.items))).toBeLessThanOrEqual(1024 * 1024);
      received.push(...page.items); cursor = page.nextCursor;
    } while (cursor !== null);
    expect(received).toEqual(items);
  });

  it('externalizes an oversized real tool result before storing a bounded page and retains its full Unicode body', async () => {
    const output = 'HEAD🌟\n' + '工具输出'.repeat(400_000) + '\nTAIL🌟';
    const process = [
      { type: 'event', event: { stream: 'tool', data: { phase: 'end', name: 'bash', id: 'huge-call', output } } },
      ...Array.from({ length: 1000 }, (_, n) => ({ type: 'progress', text: `Event ${n}` })),
      { type: 'event', event: { stream: 'runtime', data: { phase: 'end', duration_ms: 1200 } } },
    ];
    writeRows([message('huge', process)]);
    const canonical = fs.readFileSync(sourceFile);
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const history = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 10);
    const part = history.records[0].process_parts![0];
    if (!('ref' in part)) throw new Error('Missing process reference');
    const first = await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 0, 'huge');
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(1024 * 1024);
    const tool = (first.items[0] as any).event.data;
    expect(tool.output).toBeUndefined();
    expect(tool.id).toBe('huge-call');
    expect(fs.readFileSync(tool.result_path, 'utf8')).toBe(output);
    const directory = path.join(onlyCacheEntry(), 'process-records');
    const indexFile = fs.readdirSync(directory).find(name => name.endsWith('.json'))!;
    const index = JSON.parse(fs.readFileSync(path.join(directory, indexFile), 'utf8'));
    expect(index.offsets.every((start: number, n: number) => (index.offsets[n + 1] ?? index.bytes) - start <= 1024 * 1024)).toBe(true);
    expect(fs.readFileSync(sourceFile).equals(canonical)).toBe(true);
    expect(history.records[0].process).toContainEqual(process.at(-1));
  });

  it('keeps native JSON content addresses across Unicode boundaries and cleans up rejected cyclic records', async () => {
    const { storeProcessPages, processPageReference, readProcessPage, processCacheDirectory } = await import('../../../src/main/features/conversation-process-cache');
    const items: any[] = Array.from({ length: 201 }, (_, n) => ({ type: 'progress', text: `${n}` }));
    items[0] = { type: 'progress', text: 'x'.repeat(16 * 1024 - 1) + '🌟界\n\t"\\' + String.fromCharCode(0xd800),
      nested: [undefined, NaN, Infinity, -0, { omit: undefined, escaped: '\b', boxed: new Number(7) }] };
    items[200] = { toJSON(key: string) { return { type: 'progress', text: `JSON key ${key}` }; } };
    const expected = createHash('sha256');
    for (let n = 0; n < items.length; n += 200) expected.update(JSON.stringify(items.slice(n, n + 200)) + '\n');
    const ref = expected.digest('hex');
    expect(processPageReference(items)).toBe(ref);
    expect(storeProcessPages(tmpDir, items)).toMatchObject({ ref, count: 201 });
    expect((await readProcessPage(tmpDir, ref)).items).toEqual(JSON.parse(JSON.stringify(items.slice(0, 200))));
    const cycle: any = {}; cycle.self = cycle;
    expect(() => storeProcessPages(tmpDir, [cycle])).toThrow();
    expect(fs.readdirSync(processCacheDirectory(tmpDir)).some(file => file.endsWith('.tmp'))).toBe(false);
  });

  it('rebuilds oversized legacy pages without changing legacy cursor meaning and resumes after cache clearing', async () => {
    const items = Array.from({ length: 1001 }, (_, n) => ({ type: 'event', event: { stream: 'tool',
      data: { phase: 'end', name: 'bash', id: `legacy-${n}`, output: `${n}:` + '界🌟'.repeat(1200) } } }));
    writeRows([message('legacy', items)]);
    const original = fs.readFileSync(sourceFile);
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const history = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 10);
    const part = history.records[0].process_parts![0];
    if (!('ref' in part)) throw new Error('Missing process reference');
    const entry = onlyCacheEntry();
    const directory = path.join(entry, 'process-records');
    fs.rmSync(directory, { recursive: true }); fs.mkdirSync(directory);
    const lines = Array.from({ length: Math.ceil(items.length / 200) }, (_, n) => JSON.stringify(items.slice(n * 200, n * 200 + 200)) + '\n');
    const offsets: number[] = []; let bytes = 0;
    for (const line of lines) { offsets.push(bytes); bytes += Buffer.byteLength(line); }
    fs.writeFileSync(path.join(directory, part.ref + '.jsonl'), lines.join(''));
    fs.writeFileSync(path.join(directory, part.ref + '.json'), JSON.stringify({ offsets, bytes, count: items.length }));
    const direct = await import('../../../src/main/features/conversation-process-cache');
    await expect(direct.readProcessPage(entry, part.ref, 1)).rejects.toMatchObject({ code: 'E_PROCESS_PAGE_REBUILD' });
    const second = await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 1, 'legacy');
    expect((second.items[0] as any).event.data.id).toBe('legacy-200');
    expect(second.nextCursor).not.toBeNull();
    const following = await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, second.nextCursor!, 'legacy');
    fs.rmSync(directory, { recursive: true });
    expect(await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, second.nextCursor!, 'legacy')).toEqual(following);
    const tail = await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 5, 'legacy');
    expect(tail.items).toHaveLength(1);
    expect((tail.items[0] as any).event.data.id).toBe('legacy-1000');
    expect(tail.nextCursor).toBeNull();
    expect(fs.readFileSync(sourceFile).equals(original)).toBe(true);
  });

  it('keeps hidden oversized diagnostic groups navigable without disclosing their contents', async () => {
    const hidden = { type: 'event', event: { stream: 'command_output', data: { output: 'secret'.repeat(180_000) } } };
    const direct = await import('../../../src/main/features/conversation-process-cache');
    const empty = direct.storeProcessPages(tmpDir, [hidden] as any, () => []);
    if (!('ref' in empty)) throw new Error('Missing empty process reference');
    expect(await direct.readProcessPage(tmpDir, empty.ref)).toEqual({ items: [], nextCursor: null });
    writeRows([message('hidden', [hidden, ...Array.from({ length: 199 }, () => ({ type: 'event', event: { stream: 'usage', data: {} } })),
      ...Array.from({ length: 801 }, (_, n) => ({ type: 'progress', text: `Visible ${n}` }))])]);
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const history = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 10);
    const part = history.records[0].process_parts![0];
    if (!('ref' in part)) throw new Error('Missing process reference');
    const first = await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 0, 'hidden');
    expect(first.items).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const next = await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, first.nextCursor!, 'hidden');
    expect(next.items[0]).toEqual({ type: 'progress', text: 'Visible 0' });
  }, 30_000);

  it('opens a large process history with bounded first-paint data and pages every event in order', async () => {
    const process = Array.from({ length: 1503 }, (_, index) => ({ type: 'event', event: { stream: 'tool',
      data: { phase: 'end', name: 'bash', id: `call-${index}`, output: `Complete output ${index}` } } }));
    const rows = [message('question'), message('large', process)];
    writeRows(rows);
    const original = fs.readFileSync(sourceFile, 'utf8');
    const { readConversationHistoryPage, readConversationProcessPage } = await import('../../../src/main/features/conversation_history_cache');
    const page = await readConversationHistoryPage(TEST_UID, sourceFile, 10);
    expect(page.records.map(record => record.text)).toEqual(['message question', 'message large']);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4096);
    const part = page.records[1].process_parts![0];
    expect(part).toMatchObject({ count: 1503, message_id: 'large' });
    expect('ref' in part).toBe(true);
    if (!('ref' in part)) throw new Error('Missing deferred process');
    const received: unknown[] = [];
    let cursor: number | null = 0;
    do {
      const details = await readConversationProcessPage(TEST_UID, sourceFile, part.ref, cursor!, 'large');
      expect(details.items.length).toBeLessThanOrEqual(200);
      received.push(...details.items);
      cursor = details.nextCursor;
    } while (cursor !== null);
    expect(received).toEqual(process);
    expect(fs.readFileSync(sourceFile, 'utf8')).toBe(original);
  });

  it('rebuilds a cleared process cache and refuses another source or malformed reference', async () => {
    writeRows([message('large', Array.from({ length: 1001 }, (_, n) => ({ type: 'progress', text: `Event ${n}` })))]);
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const first = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 10);
    const part = first.records[0].process_parts![0];
    if (!('ref' in part)) throw new Error('Missing deferred process');
    await cache.purgeConversationHistoryCache(TEST_UID, sourceFile);
    expect((await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 5, 'large')).items)
      .toEqual([{ type: 'progress', text: 'Event 1000' }]);
    const otherSource = path.join(tmpDir, 'other.jsonl');
    fs.writeFileSync(otherSource, JSON.stringify(message('large')) + '\n');
    await expect(cache.readConversationProcessPage(TEST_UID, otherSource, part.ref, 0, 'large')).rejects.toThrow();
    await expect(cache.readConversationProcessPage(TEST_UID, sourceFile, '../outside', 0, 'large')).rejects.toThrow();
    await expect(cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 99, 'large')).rejects.toThrow();
  });

  it('invalidates the legacy projection without reading it into first paint', async () => {
    writeRows([message('latest')]);
    const cache = await import('../../../src/main/features/conversation_history_cache');
    await cache.readConversationHistoryPage(TEST_UID, sourceFile, 10);
    const entry = onlyCacheEntry();
    fs.rmSync(path.join(entry, 'latest-page-v12.json'));
    fs.writeFileSync(path.join(entry, 'latest-page.json'), JSON.stringify({ version: 4, unrelated: 'x'.repeat(1024 * 1024) }));
    fs.writeFileSync(path.join(entry, 'latest-page-v5.json'), JSON.stringify({ version: 5, unrelated: 'x'.repeat(1024 * 1024) }));
    fs.writeFileSync(path.join(entry, 'latest-page-v6.json'), JSON.stringify({ version: 6, unrelated: 'x'.repeat(1024 * 1024) }));
    fs.writeFileSync(path.join(entry, 'latest-page-v7.json'), JSON.stringify({ version: 7, unrelated: 'x'.repeat(1024 * 1024) }));
    fs.writeFileSync(path.join(entry, 'latest-page-v8.json'), JSON.stringify({ version: 8, unrelated: 'x'.repeat(1024 * 1024) }));
    fs.writeFileSync(path.join(entry, 'latest-page-v9.json'), JSON.stringify({ version: 9, unrelated: 'x'.repeat(1024 * 1024) }));
    fs.writeFileSync(path.join(entry, 'latest-page-v10.json'), JSON.stringify({ version: 10, unrelated: 'x'.repeat(1024 * 1024) }));
    fs.writeFileSync(path.join(entry, 'latest-page-v11.json'), JSON.stringify({ version: 11, unrelated: 'x'.repeat(1024 * 1024) }));
    const next = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 10);
    expect(next.records.map(record => record.id)).toEqual(['latest']);
    expect(fs.existsSync(path.join(entry, 'latest-page.json'))).toBe(false);
    expect(fs.existsSync(path.join(entry, 'latest-page-v5.json'))).toBe(false);
    expect(fs.existsSync(path.join(entry, 'latest-page-v6.json'))).toBe(false);
    expect(fs.existsSync(path.join(entry, 'latest-page-v7.json'))).toBe(false);
    expect(fs.existsSync(path.join(entry, 'latest-page-v8.json'))).toBe(false);
    expect(fs.existsSync(path.join(entry, 'latest-page-v9.json'))).toBe(false);
    expect(fs.existsSync(path.join(entry, 'latest-page-v10.json'))).toBe(false);
    expect(fs.existsSync(path.join(entry, 'latest-page-v11.json'))).toBe(false);
    expect(fs.statSync(path.join(entry, 'latest-page-v12.json')).size).toBeLessThan(4096);
  });

  it('keeps the answer available during a process-cache write failure and recovers its details', async () => {
    writeRows([message('large', Array.from({ length: 1001 }, (_, n) => ({ type: 'progress', text: `Event ${n}` })))]);
    const cache = await import('../../../src/main/features/conversation_history_cache');
    await cache.readConversationHistoryPage(TEST_UID, sourceFile, 10);
    const entry = onlyCacheEntry();
    await cache.purgeConversationHistoryCache(TEST_UID, sourceFile);
    fs.mkdirSync(entry, { recursive: true });
    fs.writeFileSync(path.join(entry, 'process-records'), 'Blocked cache fixture');
    const page = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 10);
    expect(page.records[0].text).toBe('message large');
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(4096);
    const part = page.records[0].process_parts![0];
    if (!('ref' in part)) throw new Error('Missing deferred process');
    fs.rmSync(path.join(entry, 'process-records'));
    expect((await cache.readConversationProcessPage(TEST_UID, sourceFile, part.ref, 5, 'large')).items)
      .toEqual([{ type: 'progress', text: 'Event 1000' }]);
  });

  it('retains terminal and elapsed-time receipts when later bookkeeping has no duration', async () => {
    const end = { type: 'event', event: { stream: 'runtime', data: { phase: 'end', duration_ms: 2000 } } };
    const later = { type: 'event', event: { stream: 'runtime', data: { phase: 'bookkeeping' } } };
    writeRows([message('large', [
      ...Array.from({ length: 1001 }, (_, n) => ({ type: 'progress', text: `Event ${n}` })), end, later,
    ])]);
    const cache = await import('../../../src/main/features/conversation_history_cache');
    const page = await cache.readConversationHistoryPage(TEST_UID, sourceFile, 10);
    expect(page.records[0].process).toEqual([end, later]);
    expect(page.records[0].process_parts).toHaveLength(1);
  });

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
    const latestPageFile = path.join(cacheEntry, 'latest-page-v12.json');
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
    expect(fs.statSync(path.join(onlyCacheEntry(), 'latest-page-v12.json')).size).toBeLessThan(4_000);

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
    const cached = JSON.parse(fs.readFileSync(path.join(onlyCacheEntry(), 'latest-page-v12.json'), 'utf8'));
    expect(cached.records.map((entry: any) => entry.record.id)).toEqual(['m3', 'm4']);
  });

  it('extends the cache across a multi-megabyte appended record without losing its projection', async () => {
    writeRows([message('m1')]);
    const { readConversationHistoryPage } = await import(
      '../../../src/main/features/conversation_history_cache'
    );
    await readConversationHistoryPage(TEST_UID, sourceFile, 2);
    fs.appendFileSync(sourceFile, `${JSON.stringify(structuredToolMessage('m2', {
      ok: true,
      content: 'x'.repeat(2 * 1024 * 1024),
    }))}\n`);
    const page = await readConversationHistoryPage(TEST_UID, sourceFile, 2);
    expect(page.records.map((record) => record.id)).toEqual(['m1', 'm2']);
    expect((page.records[1].process as any[])[0].event.data.output).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(sourceFile, 'utf8').trim().split('\n')[1])
      .process[0].event.data.output.content).toHaveLength(2 * 1024 * 1024);
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
    const cached = JSON.parse(fs.readFileSync(path.join(onlyCacheEntry(), 'latest-page-v12.json'), 'utf8'));
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
    const cached = JSON.parse(fs.readFileSync(path.join(onlyCacheEntry(), 'latest-page-v12.json'), 'utf8'));
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
    const cached = JSON.parse(fs.readFileSync(path.join(onlyCacheEntry(), 'latest-page-v12.json'), 'utf8'));
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
