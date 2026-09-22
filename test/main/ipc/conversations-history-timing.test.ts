import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../../../src/main/ipc/index.ts'), 'utf8');
const marker = "'conversations.history': ";
const handlerSource = source.slice(
  source.indexOf(marker) + marker.length,
  source.indexOf("'conversations.turns':"),
).trim().replace(/,$/, '');

function setup() {
  let clock = 0;
  let resolveHistory!: (page: any) => void;
  let resolveRuntime!: (status: any) => void;
  const history = new Promise((resolve) => { resolveHistory = resolve; });
  const runtime = new Promise((resolve) => { resolveRuntime = resolve; });
  const info = vi.fn();
  const context = {
    performance: { now: () => clock },
    safeId: () => true,
    conversationProjectHint: () => null,
    isAgentEnabled: () => true,
    log: { info },
    chats: {
      getConversationMetadata: vi.fn(async () => { clock = 100; return { project_id: null }; }),
      getMessagesPage: vi.fn(() => history),
    },
    groupChat: { runtimeStatus: vi.fn(() => runtime), displaySnapshot: vi.fn(() => ({ sequence: 7, turns: [] })) },
  };
  const handler = vm.runInNewContext(`(${handlerSource})`, context);
  return {
    context, handler, info,
    setClock: (value: number) => { clock = value; },
    resolveHistory, resolveRuntime,
  };
}

describe('conversation history latency diagnostics', () => {
  it.each(['history', 'runtime'])('identifies slow %s without logging message content or identity', async (slow) => {
    const s = setup();
    const page = { history: [{ id: 'private-message', text: 'Private reply' }], nextCursor: null };
    const request = s.handler({ cid: 'private-conversation' }, { userId: 'private-user' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(s.context.chats.getMessagesPage).toHaveBeenCalled();
    expect(s.context.groupChat.runtimeStatus).toHaveBeenCalled();
    s.setClock(300);
    if (slow === 'history') s.resolveRuntime({ processing: false });
    else s.resolveHistory(page);
    await new Promise<void>((resolve) => setImmediate(resolve));
    s.setClock(1600);
    if (slow === 'history') s.resolveHistory(page);
    else s.resolveRuntime({ processing: false });
    const result = await request;
    expect(result.history).toEqual(page.history);
    expect(s.info).toHaveBeenCalledExactlyOnceWith('slow conversation history read', {
      metadata_ms: 100,
      history_ms: slow === 'history' ? 1500 : 200,
      runtime_ms: slow === 'runtime' ? 1500 : 200,
      total_ms: 1600, rows: 1, anchored: false,
    });
    expect(JSON.stringify(s.info.mock.calls)).not.toMatch(/private|Private/);
  });

  it('reads active display only for an explicit view rebuild, after the history read', async () => {
    const s = setup();
    const request = s.handler({ cid: 'c1', live: '1' }, { userId: 'u1' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(s.context.groupChat.displaySnapshot).not.toHaveBeenCalled();
    s.resolveHistory({ history: [], nextCursor: null });
    s.resolveRuntime({ processing: true });
    expect((await request).live_display).toEqual({ sequence: 7, turns: [] });
    expect(s.context.groupChat.displaySnapshot).toHaveBeenCalledExactlyOnceWith('u1', 'c1', null);
  });

  it('keeps fast history reads silent', async () => {
    const s = setup();
    const request = s.handler({ cid: 'c1' }, { userId: 'u1' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    s.setClock(200);
    s.resolveHistory({ history: [], nextCursor: null });
    s.resolveRuntime({ processing: false });
    expect((await request).history).toEqual([]);
    expect(s.info).not.toHaveBeenCalled();
    expect(s.context.groupChat.displaySnapshot).not.toHaveBeenCalled();
  });
});
