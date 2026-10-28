import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parseJsonObjectAt } from './parse-json-object';
import { freezeFileMetadata } from './frozen-file-metadata';
import { captureMainLogWorkers } from './capture-main-log-workers';
import { drainMainRuntimeForTest } from './drain-main-runtime';
import { conversationCacheSource, conversationRemovalSource } from '../renderer/conversation-cache-test-source';

describe('reviewed test runtime boundaries', () => {
  it('loads the real conversation cache helpers without replacing newer task state or recounting removal', () => {
    const repaint = vi.fn(), clearRename = vi.fn();
    const context = vm.createContext({
      conversations: [{ conversation_id: 'existing', title: 'User title', title_manually_set: true,
        participants: ['retained'], updated_at: '2026-10-20T00:00:00Z' }],
      _conversationRemovalRevision: 0, _conversationProjectPages: new Map(),
      _unprojectedConversationPage: { total: 1, nextOffset: 1 },
      _clearConversationInlineRenameState: clearRename, renderConversationList: repaint,
    });
    vm.runInContext(conversationCacheSource + '\n' + conversationRemovalSource, context);
    context._cacheCreatedConversation({ conversation_id: 'existing', title: 'Old receipt', participants: [],
      updated_at: '2026-10-19T00:00:00Z' }, 'Optimistic title');
    expect(JSON.parse(JSON.stringify(context.conversations))).toEqual([{ conversation_id: 'existing', title: 'User title',
      title_manually_set: true, participants: ['retained'], updated_at: '2026-10-20T00:00:00Z' }]);
    context._removeConversationFromSidebar('existing'); context._removeConversationFromSidebar('existing');
    expect(context.conversations).toHaveLength(0);
    expect(context._unprojectedConversationPage).toEqual({ total: 0, nextOffset: 0 });
    expect(context._conversationRemovalRevision).toBe(2);
    expect(clearRename).toHaveBeenCalledOnce(); expect(repaint).toHaveBeenCalledOnce();
  });
  it('parses a complete nested JSON object with escaped strings and trailing diagnostics', () => {
    const text = 'prefix {"nested":[{"text":"brace } and \\\"quote\\\""}],"unicode":"雪"} trailing {noise}';
    const result = parseJsonObjectAt<any>(text, text.indexOf('{'));
    expect(result.value).toEqual({ nested: [{ text: 'brace } and "quote"' }], unicode: '雪' });
    expect(text.slice(result.end)).toBe(' trailing {noise}');
    for (const malformed of ['', '[]', '{', '{"text":"unfinished}', '{"bad":}']) {
      expect(() => parseJsonObjectAt(malformed, 0)).toThrow();
    }
    expect(() => parseJsonObjectAt('{}', -1)).toThrow();
    expect(() => parseJsonObjectAt('{}', 2)).toThrow();
  });

  it('closes a real file handle even when the pre-close fault hook rejects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-metadata-close-'));
    const file = path.join(root, 'fixture.txt'); fs.writeFileSync(file, 'fixture');
    const failure = new Error('synthetic pre-close failure');
    let rejectClose = true;
    const restore = freezeFileMetadata([file], async () => { if (rejectClose) throw failure; });
    const handle = await fs.promises.open(file, 'r');
    try {
      await expect(handle.close()).rejects.toBe(failure);
      await expect(handle.read(Buffer.alloc(1), 0, 1, 0)).rejects.toMatchObject({ code: 'EBADF' });
    } finally {
      rejectClose = false;
      restore();
      // The original implementation leaks the descriptor; ensure RED cleanup
      // does not retain that leak in the test process.
      await handle.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['load', 'flush'])('still closes KB state after search %s fails, preserving the original failure', async phase => {
    const failure = new Error('synthetic search drain failure'), closeAllKb = vi.fn();
    vi.doMock('../../src/main/features/search/indexer', () => {
      if (phase === 'load') throw failure;
      return { flushAll: async () => { throw failure; } };
    });
    vi.doMock('../../src/main/features/kb_vector', () => ({ closeAllKb }));
    try {
      const error = await drainMainRuntimeForTest().then(() => null, reason => reason);
      // Vitest wraps a module factory failure, retaining the original as cause.
      expect(phase === 'load' ? error?.cause : error).toBe(failure);
      expect(closeAllKb).toHaveBeenCalledOnce();
    } finally {
      vi.doUnmock('../../src/main/features/search/indexer');
      vi.doUnmock('../../src/main/features/kb_vector'); vi.resetModules();
    }
  });

  it('restores logging state and starts closing every captured worker even when termination rejects', async () => {
    const prior = process.env.ORKAS_TEST_DISABLE_LOG_DELIVERY;
    process.env.ORKAS_TEST_DISABLE_LOG_DELIVERY = 'caller-sentinel';
    const failure = new Error('synthetic worker termination failure');
    const worker = (fail: boolean) => Object.assign(new EventEmitter(), {
      unref: vi.fn(), postMessage: vi.fn(), terminate: vi.fn(async () => { if (fail) throw failure; return 0; }),
    });
    const first = worker(true), second = worker(false);
    const cleanup = await captureMainLogWorkers();
    try {
      (await import('../../src/main/util/log-delivery')).createLogDelivery({}, () => first as any);
      vi.resetModules();
      (await import('../../src/main/util/log-delivery')).createLogDelivery({}, () => second as any);
      await expect(cleanup()).rejects.toBe(failure);
      expect(first.terminate).toHaveBeenCalledOnce(); expect(second.terminate).toHaveBeenCalledOnce();
      expect(process.env.ORKAS_TEST_DISABLE_LOG_DELIVERY).toBe('caller-sentinel');
    } finally {
      vi.doUnmock('../../src/main/util/log-delivery'); vi.resetModules();
      if (prior === undefined) delete process.env.ORKAS_TEST_DISABLE_LOG_DELIVERY;
      else process.env.ORKAS_TEST_DISABLE_LOG_DELIVERY = prior;
    }
  });
});
