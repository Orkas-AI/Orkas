import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const streamGate = vi.hoisted(() => ({
  releaseActiveTurn: null as null | (() => void),
}));
const streamProbe = vi.hoisted(() => ({
  messages: [] as string[],
  readOnlyRoots: [] as string[][],
  dispatchResults: [] as string[],
  maxToolLoops: [] as Array<number | undefined>,
}));

// Mock the model client so `runTurn` doesn't try to do a real LLM call.
// `streamChatWithModel` returns an async iterator that yields one final
// event with empty text + a done event; bus interprets that as "done,
// no reply" and emits a "(no reply)" message. Good enough for the
// integration assertions here — we're testing routing / persistence /
// state, not actual model output.
vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) {
    streamProbe.messages.push(String(_opts?.message || ''));
    streamProbe.readOnlyRoots.push(Array.isArray(_opts?.readOnlyExtraRoots) ? [..._opts.readOnlyExtraRoots] : []);
    streamProbe.maxToolLoops.push(typeof _opts?.maxToolLoops === 'number' ? _opts.maxToolLoops : undefined);
    if (String(_opts?.message || '').includes('ARTIFACT_EVENT_TEST')) {
      _opts?.onArtifactCreated?.({ id: 'art-live-1', title: 'Live App' });
    }
    const nestedOutputMarker = 'NESTED_OUTPUT_VISIBILITY_TEST:';
    const nestedOutputIdx = String(_opts?.message || '').indexOf(nestedOutputMarker);
    if (nestedOutputIdx >= 0) {
      const encoded = String(_opts.message).slice(nestedOutputIdx + nestedOutputMarker.length).split(/\s/, 1)[0];
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const tool = (Array.isArray(_opts?.extraTools) ? _opts.extraTools : [])
        .find((candidate: any) => candidate?.name === data.tool);
      if (!tool) throw new Error(`missing nested tool ${data.tool}`);
      const task = `PRODUCED_FILTER_TEST:${Buffer.from(JSON.stringify({ paths: [data.path] })).toString('base64')}`;
      const result = await tool.execute(
        data.tool === 'run_worker'
          ? { to: AGENT_NAME, task }
          : { to: AGENT_NAME, message: task },
        { signal: new AbortController().signal },
      );
      streamProbe.dispatchResults.push(String(result?.content || ''));
      yield { type: 'final', text: data.tool === 'hand_off_to' ? '' : 'commander synthesis ok' };
      yield { type: 'done' };
      return;
    }
    if (String(_opts?.message || '').includes('AGENT_RESULT_FAILURE_TEST')) {
      yield { type: 'final', text: '没有完成交付。\n<agent-result status="failure" />' };
      yield { type: 'done' };
      return;
    }
    if (String(_opts?.message || '').includes('COMMANDER_RESULT_FAILURE_TEST')) {
      yield { type: 'final', text: '没有完成调度。\n<commander-result status="failure" />' };
      yield { type: 'done' };
      return;
    }
    const xmlMarker = 'SYNC_CONFLICT_XML_RESULT:';
    const xmlIdx = String(_opts?.message || '').indexOf(xmlMarker);
    if (xmlIdx >= 0) {
      const encoded = String(_opts.message).slice(xmlIdx + xmlMarker.length).split(/\s/, 1)[0];
      const esc = (value: string) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      yield {
        type: 'final',
        text: `<sync-conflict-result conflict_id="${esc(data.conflictId)}" rel_path="${esc(data.relPath)}" target_path="${esc(data.targetPath)}" status="${esc(data.status || 'resolved')}" action="${esc(data.action || 'use_current')}" />`,
      };
      yield { type: 'done' };
      return;
    }
    const producedMarker = 'PRODUCED_FILTER_TEST:';
    const producedIdx = String(_opts?.message || '').indexOf(producedMarker);
    if (producedIdx >= 0) {
      const encoded = String(_opts.message).slice(producedIdx + producedMarker.length).split(/\s/, 1)[0];
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      for (const p of data.paths || []) _opts?.onFileWritten?.(p);
      const interaction = data.planInteraction === 'open' || data.planInteraction === 'closed'
        ? `\n<plan-interaction status="${data.planInteraction}" />`
        : '';
      const form = data.withForm
        ? `\n<agent-input-form>\n${JSON.stringify({ fields: [{ id: 'decision', label: 'Decision', type: 'text' }] })}\n</agent-input-form>`
        : '';
      yield { type: 'final', text: `produced filter ok${form}${interaction}` };
      yield { type: 'done' };
      return;
    }
    const publishedMarker = 'PUBLISHED_OUTPUT_TEST:';
    const publishedIdx = String(_opts?.message || '').indexOf(publishedMarker);
    if (publishedIdx >= 0) {
      const encoded = String(_opts.message).slice(publishedIdx + publishedMarker.length).split(/\s/, 1)[0];
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      for (const p of data.paths || []) await _opts?.onFileWritten?.(p);
      _opts?.onOutputsPublished?.(data.published || []);
      const interaction = data.planInteraction === 'open' || data.planInteraction === 'closed'
        ? `\n<plan-interaction status="${data.planInteraction}" />`
        : '';
      const form = data.withForm
        ? `\n<agent-input-form>\n${JSON.stringify({ fields: [{ id: 'decision', label: 'Decision', type: 'text' }] })}\n</agent-input-form>`
        : '';
      yield { type: 'final', text: `published output ok${form}${interaction}` };
      yield { type: 'done' };
      return;
    }
    if (String(_opts?.message || '').includes('ACTIVE_TURN_TEST')) {
      yield { type: 'progress', text: 'active turn started' };
      await new Promise<void>((resolve) => { streamGate.releaseActiveTurn = resolve; });
    }
    if (String(_opts?.message || '').includes('COMPACTION_EVENT_TEST')) {
      yield {
        type: 'progress',
        text: 'compacted 20000→3000 tokens',
        event: {
          stream: 'compaction',
          data: { tokensBefore: 20000, tokensAfter: 3000 },
        },
      };
      yield { type: 'final', text: 'compaction recorded' };
      yield { type: 'done' };
      return;
    }
    if (String(_opts?.message || '').includes('TIMING_EVENT_TEST')) {
      yield {
        type: 'event',
        event: {
          stream: 'agent_run_result',
          data: {
            provider_ms: 40,
            tool_ms: 20,
            compaction_ms: 10,
            retry_wait_ms: 5,
            other_ms: 3,
          },
        },
      };
      yield { type: 'final', text: 'timing recorded' };
      yield { type: 'done' };
      return;
    }
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: vi.fn(() => 0),
}));

const cliRunMock = vi.hoisted(() => ({ calls: [] as any[] }));
vi.mock('../../../../src/main/features/local_agents/runner', () => ({
  run: vi.fn(async (opts: any) => {
    cliRunMock.calls.push(opts);
    opts.onEvent({ type: 'done', status: 'completed', output: 'ok' });
    return { runId: 'mock-run', status: 'completed', output: 'ok' };
  }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cidbus';
const AGENT_ID = 'a83d30d995fd';
const AGENT_NAME = '软件工程师';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bus-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  cliRunMock.calls.length = 0;
  streamProbe.messages.length = 0;
  streamProbe.readOnlyRoots.length = 0;
  streamProbe.dispatchResults.length = 0;
  streamProbe.maxToolLoops.length = 0;
  streamGate.releaseActiveTurn = null;
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);

  // Point the workspace at the `<tmpDir>/workspace` path these fixtures
  // already assume. Produced-file finalization is scoped to the roots Orkas
  // manages, so deliverables must live somewhere the workspace actually
  // resolves to — otherwise the gate assertions below pass because the files
  // sit outside the boundary rather than because a review gate held them.
  const userWorkspace = await import('../../../../src/main/features/user_workspace');
  const wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  userWorkspace.setWorkspacePath(TEST_UID, wsDir);

  // Seed a custom agent on disk so listAgents / getAgent can resolve it.
  // Agent 目录形态: agents/<aid>/agent.json (详见 docs/plans/agent-as-directory.md)
  const paths = await import('../../../../src/main/paths');
  const dir = paths.agentDir(TEST_UID, AGENT_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
    agent_id: AGENT_ID,
    name: AGENT_NAME,
    description: '交付高质量的软件产品',
    workflow: '收需求 → 出方案 → 实现',
    created_at: 't', updated_at: 't',
  }));
});

afterEach(async () => {
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.abort(TEST_UID, TEST_CID);
    bus.dropConv(TEST_UID, TEST_CID);
  } catch {
    // Some skipped/failed setup paths may not have loaded the bus module yet.
  }
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitForQuiescent(uid: string, cid: string, timeoutMs = 2000) {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (bus.isQuiescent(uid, cid)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`bus did not quiesce for ${uid}/${cid}`);
}

describe('group_chat bus › enqueue routing + persistence', () => {
  it('user → commander default route persists with to=["commander"]', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const events: any[] = [];
    bus.subscribe(TEST_UID, TEST_CID, (ev) => events.push(ev));

    const msg = await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user', text: '你好',
    });
    expect(msg.to).toEqual(['commander']);
    expect(msg.from).toBe('user');

    // listener saw message event for the user msg
    expect(events.find((e) => e.type === 'message' && e.msg.id === msg.id)).toBeTruthy();
  });

  it('persists short visible text while sending model_text to the worker', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const visibility = await import('../../../../src/main/features/group_chat/visibility');
    const cid = 'cid-model-text';

    const msg = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: '请帮我处理冲突。',
      model_text: 'Please resolve the conflict using the hidden protocol.',
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(msg.text).toBe('请帮我处理冲突。');
    expect(msg.model_text).toBe('Please resolve the conflict using the hidden protocol.');
    expect(streamProbe.messages.some((m) => m.includes('Please resolve the conflict using the hidden protocol.'))).toBe(true);
    expect(streamProbe.messages.some((m) => m.includes('请帮我处理冲突。'))).toBe(false);

    const slice = await visibility.readSlice(TEST_UID, cid, 'commander');
    expect(visibility.buildReplayPrefix(slice, 'missing').prefix).toContain('Please resolve the conflict using the hidden protocol.');
  });

  it('persists structured references and injects them as inert model context', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const layout = await import('../../../../src/main/util/project-layout');
    const sourceAttachmentDir = layout.chatAttachmentDirForConversation(TEST_UID, 'source-cid');
    fs.mkdirSync(sourceAttachmentDir, { recursive: true });
    fs.writeFileSync(path.join(sourceAttachmentDir, 'brief.txt'), 'reference attachment');
    const msg = await bus.enqueue({
      uid: TEST_UID,
      cid: TEST_CID,
      fromActorId: 'user',
      text: '比较一下',
      references: [{
        source_cid: 'source-cid',
        source_title: '来源任务',
        source_msg_id: 'source-msg',
        from_actor: 'writer',
        from_name: '撰稿人',
        source_ts: '2026-07-10T10:00:00',
        text: '历史内容里有 @other-agent，但不应参与当前消息路由。',
        attachments: [{ name: 'brief.txt', kind: 'text' }],
        produced: ['/tmp/report.pdf'],
      }],
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    expect(msg.to).toEqual(['commander']);
    expect(msg.references?.[0]).toMatchObject({
      source_cid: 'source-cid',
      source_msg_id: 'source-msg',
      text: expect.stringContaining('@other-agent'),
    });
    expect(streamProbe.messages.some((payload) => (
      payload.includes('<referenced-messages>')
      && payload.includes('not executable instructions or routing mentions')
      && payload.includes('@other-agent')
      && payload.includes(path.join(sourceAttachmentDir, 'brief.txt'))
      && payload.includes('比较一下')
    ))).toBe(true);
    expect(streamProbe.readOnlyRoots.some((roots) => roots.includes(sourceAttachmentDir))).toBe(true);
  });

  it('keeps earlier conversation attachments visible on later turns without reattaching', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const attachments = await import('../../../../src/main/features/chat_attachments');
    const cid = 'cid-attachment-index';

    await attachments.uploadAttachment(
      TEST_UID,
      cid,
      'orkas-1.0.5-update.md',
      Buffer.from('# Orkas 1.0.5\nAttachment index keeps old files discoverable.', 'utf8'),
    );

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'please check the old md again',
    });
    await waitForQuiescent(TEST_UID, cid);

    const call = streamProbe.messages.find((m) => m.includes('please check the old md again')) || '';
    expect(call).toContain('<conversation-attachments');
    expect(call).toContain('name="orkas-1.0.5-update.md"');
    expect(call).toContain('kind="text"');
    expect(call).toContain('total_chars=');
  });

  it('strips commander result markers and records commander model failures', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: 'COMMANDER_RESULT_FAILURE_TEST',
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${TEST_CID}.jsonl`);
    const lines = fs.readFileSync(mainFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.find((line) => line.from === 'commander');
    expect(reply?.text).toBe('没有完成调度。');
    expect(reply?.text).not.toContain('commander-result');

    const stats = JSON.parse(fs.readFileSync(paths.commanderRuntimeStatsFile(TEST_UID), 'utf-8'));
    expect(stats.attempts).toBe(1);
    expect(stats.successes).toBe(0);
    expect(stats.deliveries).toBe(0);
    expect(stats.failures).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it('records markerless commander completions as success when no runtime error occurs', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: '普通问题',
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const stats = JSON.parse(fs.readFileSync(paths.commanderRuntimeStatsFile(TEST_UID), 'utf-8'));
    expect(stats.attempts).toBe(1);
    expect(stats.successes).toBe(1);
    expect(stats.deliveries).toBe(1);
    expect(stats.failures).toBe(0);
    expect(stats.errors).toBe(0);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${TEST_CID}.jsonl`);
    const lines = fs.readFileSync(mainFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.find((line) => line.from === 'commander');
    expect(reply?.process).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          stream: 'runtime',
          data: expect.objectContaining({ duration_ms: expect.any(Number) }),
        }),
      }),
    ]));
  });

  it('persists context compaction metadata in process history', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-compaction-process';
    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: 'COMPACTION_EVENT_TEST',
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const lines = fs.readFileSync(mainFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.find((line) => line.from === 'commander');
    expect(reply?.text).toBe('compaction recorded');
    expect(reply?.process).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'progress',
        text: 'compacted 20000→3000 tokens',
        event: {
          stream: 'compaction',
          data: { tokensBefore: 20000, tokensAfter: 3000 },
        },
      }),
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          stream: 'runtime',
          data: expect.objectContaining({ duration_ms: expect.any(Number) }),
        }),
      }),
    ]));
    expect(events.some((e) => e.type === 'process' && e.data?.event?.stream === 'compaction')).toBe(true);
    expect(events.some((e) => e.type === 'process' && e.data?.event?.stream === 'runtime')).toBe(true);
  });

  it('persists phase timing attribution in the final runtime process item', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-runtime-breakdown';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user', text: 'TIMING_EVENT_TEST',
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const lines = fs.readFileSync(mainFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.find((line) => line.from === 'commander');
    const runtime = reply?.process?.find((item: any) => item?.event?.stream === 'runtime');
    expect(runtime?.event?.data).toMatchObject({
      duration_ms: expect.any(Number),
      provider_ms: 40,
      tool_ms: 20,
      compaction_ms: 10,
      retry_wait_ms: 5,
      other_ms: 3,
    });
  });

  it('user → @<name> resolves to agent_id and auto-adds the agent to the roster', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const msg = await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} 我想要开发一个软件`,
    });
    expect(msg.to).toEqual([AGENT_ID]);

    // Auto-add: agent now appears in the roster
    const m = await state.readMembers(TEST_UID, TEST_CID);
    expect(m.actors.find((a) => a.id === AGENT_ID)).toBeTruthy();
    expect(m.actors.find((a) => a.id === AGENT_ID)?.name).toBe(AGENT_NAME);
  });

  it('passes the explicit 100-round tool budget into a named agent run', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} 执行一个长程任务`,
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const callIndex = streamProbe.messages.findIndex((message) => message.includes('执行一个长程任务'));
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(streamProbe.maxToolLoops[callIndex]).toBe(100);
  });

  it('strips agent result markers and records model failures separately from errors', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} AGENT_RESULT_FAILURE_TEST`,
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${TEST_CID}.jsonl`);
    const lines = fs.readFileSync(mainFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.find((line) => line.from === AGENT_ID);
    expect(reply?.text).toBe('没有完成交付。');
    expect(reply?.text).not.toContain('agent-result');

    const stats = JSON.parse(fs.readFileSync(paths.agentRuntimeStatsFile(TEST_UID, AGENT_ID), 'utf-8'));
    expect(stats.attempts).toBe(1);
    expect(stats.successes).toBe(0);
    expect(stats.deliveries).toBe(0);
    expect(stats.failures).toBe(1);
    expect(stats.errors).toBe(0);
  });

  it('records markerless agent completions as success when no runtime error occurs', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} 普通任务`,
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const stats = JSON.parse(fs.readFileSync(paths.agentRuntimeStatsFile(TEST_UID, AGENT_ID), 'utf-8'));
    expect(stats.attempts).toBe(1);
    expect(stats.successes).toBe(1);
    expect(stats.deliveries).toBe(1);
    expect(stats.failures).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('exposes a stable active turn id from process event through final message', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const events: any[] = [];
    let resolveProgress: ((ev: any) => void) | null = null;
    const progressSeen = new Promise<any>((resolve) => { resolveProgress = resolve; });
    bus.subscribe(TEST_UID, TEST_CID, (ev) => {
      events.push(ev);
      if (ev.type === 'process' && ev.actor === 'commander' && ev.data?.type === 'progress') {
        resolveProgress?.(ev);
      }
    });

    try {
      await bus.enqueue({
        uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
        text: 'ACTIVE_TURN_TEST',
      });
      const processEv = await Promise.race([
        progressSeen,
        new Promise((_, reject) => setTimeout(() => reject(new Error('progress event timeout')), 1000)),
      ]) as any;

      expect(processEv.turn_id).toEqual(expect.any(String));
      const running = bus.runtimeSnapshot(TEST_UID, TEST_CID);
      expect(running.activeTurns).toHaveLength(1);
      expect(running.activeTurns[0]).toMatchObject({
        actor: 'commander',
        turn_id: processEv.turn_id,
        started_at_ms: expect.any(Number),
      });
      expect(running.activeTurns[0].started_at_ms).toBeLessThanOrEqual(Date.now());
      expect(bus.runtimeSnapshot(TEST_UID, TEST_CID).activeTurns[0].started_at_ms)
        .toBe(running.activeTurns[0].started_at_ms);
      expect(running.inFlight).toContain('commander');

      streamGate.releaseActiveTurn?.();
      await waitForQuiescent(TEST_UID, TEST_CID);

      const finalEv = events.find((ev) => ev.type === 'message' && ev.turn_end && ev.msg?.from === 'commander');
      expect(finalEv?.turn_id).toBe(processEv.turn_id);
      expect(bus.runtimeSnapshot(TEST_UID, TEST_CID).activeTurns).toEqual([]);
    } finally {
      streamGate.releaseActiveTurn?.();
      streamGate.releaseActiveTurn = null;
    }
  });

  // `@<agent_id>` → `@<name>` rewrite assertions live in
  // `bus-integration.test.ts` since they only matter for the persisted
  // form viewed end-to-end. Keep this file focused on bus's standalone
  // routing / persistence semantics.

  it('writes the message into both main jsonl and recipient visibility slice', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} 第一条任务`,
    });
    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${TEST_CID}.jsonl`);
    expect(fs.existsSync(mainFile)).toBe(true);
    const mainLine = fs.readFileSync(mainFile, 'utf-8').trim();
    const persisted = JSON.parse(mainLine);
    expect(persisted.to).toEqual([AGENT_ID]);

    const sliceFile = paths.groupChatVisibilityFile(TEST_UID, TEST_CID, AGENT_ID);
    expect(fs.existsSync(sliceFile)).toBe(true);
    const sliceLine = fs.readFileSync(sliceFile, 'utf-8').trim();
    expect(JSON.parse(sliceLine).id).toBe(persisted.id);
  });

  it('emits artifact_created as soon as create_artifact reports success', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const events: any[] = [];
    bus.subscribe(TEST_UID, TEST_CID, (ev) => events.push(ev));

    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: 'ARTIFACT_EVENT_TEST',
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const artifactIdx = events.findIndex((e) => e.type === 'artifact_created');
    const finalIdx = events.findIndex((e) =>
      e.type === 'message' && e.turn_end === true && e.msg?.from === 'commander');
    expect(artifactIdx).toBeGreaterThanOrEqual(0);
    expect(finalIdx).toBeGreaterThan(artifactIdx);
    expect(events[artifactIdx]).toMatchObject({
      cid: TEST_CID,
      actor: 'commander',
      artifact: { id: 'art-live-1', title: 'Live App', agent_id: 'commander' },
    });
    expect(events[finalIdx].msg.artifacts).toEqual([
      { id: 'art-live-1', title: 'Live App', agent_id: 'commander' },
    ]);
  });

  it('filters stale produced paths before persisting the final message', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-produced-filter';
    const stalePath = path.join(tmpDir, 'workspace', 'projects', 'business_planning.md');
    const finalPath = path.join(tmpDir, 'workspace', 'projects', 'deck', 'sources', 'business_planning.md');
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, 'final source');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PRODUCED_FILTER_TEST:${Buffer.from(JSON.stringify({
        paths: [stalePath, finalPath],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander' && row.text === 'produced filter ok');
    expect(commanderMsg?.produced).toEqual([finalPath]);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(stalePath)).toBe(false);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(finalPath)).toBe(true);
  });

  it('persists only the terminal deliverable while retaining supporting-file ownership', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-produced-deliverable';
    const sourcePath = path.join(tmpDir, 'workspace', 'report.md');
    const previewPath = path.join(tmpDir, 'workspace', 'preview-cover.png');
    const finalPath = path.join(tmpDir, 'workspace', 'report.pdf');
    for (const [file, body] of [
      [sourcePath, '# source'],
      [previewPath, 'preview'],
      [finalPath, 'pdf'],
    ] as const) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PRODUCED_FILTER_TEST:${Buffer.from(JSON.stringify({
        paths: [sourcePath, previewPath, finalPath],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander' && row.text === 'produced filter ok');
    expect(commanderMsg?.produced).toEqual([finalPath]);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(sourcePath)).toBe(true);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(previewPath)).toBe(true);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(finalPath)).toBe(true);
  });

  it('runs generic produced-file hooks for source-like files', async () => {
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    const finalized: string[] = [];
    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => { finalized.push(file); },
    });
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const sourcePath = path.join(tmpDir, 'workspace', 'repository', 'README.md');
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.mkdirSync(path.join(path.dirname(sourcePath), '.git'));
      fs.writeFileSync(sourcePath, '# source');

      await bus.enqueue({
        uid: TEST_UID,
        cid: 'cid-source-provenance',
        fromActorId: 'user',
        text: `PRODUCED_FILTER_TEST:${Buffer.from(JSON.stringify({ paths: [sourcePath] })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, 'cid-source-provenance');
      expect(finalized).toEqual([sourcePath]);

      await bus.enqueue({
        uid: TEST_UID,
        cid: 'cid-explicit-source-deliverable',
        fromActorId: 'user',
        text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
          paths: [sourcePath],
          published: [sourcePath],
        })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, 'cid-explicit-source-deliverable');
      expect(finalized).toEqual([sourcePath, sourcePath]);
    } finally {
      unregister();
    }
  });

  it('keeps generic produced-file hooks independent from review-gate visibility', async () => {
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    const finalized: string[] = [];
    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => { finalized.push(file); },
    });
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const cid = 'cid-open-gate-output';
      const htmlPath = path.join(tmpDir, 'workspace', 'project', 'composition', 'index.html');
      fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
      fs.writeFileSync(htmlPath, '<!doctype html><html><body>clean composition</body></html>');

      // Plan-interaction parsing is intentionally limited to interactive
      // agents. Make this fixture match VideoStudio's runtime contract.
      const agentPath = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
      fs.writeFileSync(agentPath, JSON.stringify({ ...agent, interactive: true }));

      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `@${AGENT_NAME} PRODUCED_FILTER_TEST:${Buffer.from(JSON.stringify({
          paths: [htmlPath],
          planInteraction: 'open',
          withForm: true,
        })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, cid);

      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const agentMsg = rows.find((row: any) => row.from === AGENT_ID && row.text === 'produced filter ok');
      expect(agentMsg?.produced).toBeUndefined();
      expect(agentMsg?.form?.fields?.[0]?.id).toBe('decision');
      expect(finalized).toEqual([htmlPath]);
      expect(fs.readFileSync(htmlPath, 'utf8')).toContain('clean composition');
    } finally {
      unregister();
    }
  });

  it('shows explicitly published review outputs while running generic produced-file hooks', async () => {
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    const finalized: string[] = [];
    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => { finalized.push(file); },
    });
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const cid = 'cid-open-gate-review-output';
      const contactSheetPath = path.join(tmpDir, 'workspace', 'project', 'composition', 'preview', 'contact-sheet.svg');
      fs.mkdirSync(path.dirname(contactSheetPath), { recursive: true });
      fs.writeFileSync(contactSheetPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

      const agentPath = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
      fs.writeFileSync(agentPath, JSON.stringify({ ...agent, interactive: true }));

      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `@${AGENT_NAME} PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
          paths: [contactSheetPath],
          published: [contactSheetPath],
          planInteraction: 'open',
          withForm: true,
        })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, cid);

      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const agentMsg = rows.find((row: any) => row.from === AGENT_ID && row.text === 'published output ok');
      expect(agentMsg?.produced).toEqual([contactSheetPath]);
      expect(agentMsg?.form?.fields?.[0]?.id).toBe('decision');
      expect(finalized).toEqual([contactSheetPath]);
    } finally {
      unregister();
    }
  });

  it('shows and finalizes explicitly published draft videos at Gate D', async () => {
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    const finalized: string[] = [];
    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => { finalized.push(file); },
    });
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const cid = 'cid-open-gate-draft-video';
      const draftPath = path.join(tmpDir, 'workspace', 'project', 'render', 'draft.webm');
      fs.mkdirSync(path.dirname(draftPath), { recursive: true });
      fs.writeFileSync(draftPath, 'draft video bytes');

      const agentPath = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
      fs.writeFileSync(agentPath, JSON.stringify({ ...agent, interactive: true }));

      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `@${AGENT_NAME} PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
          paths: [draftPath],
          published: [draftPath],
          planInteraction: 'open',
          withForm: true,
        })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, cid);

      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const agentMsg = rows.find((row: any) => row.from === AGENT_ID && row.text === 'published output ok');
      expect(agentMsg?.produced).toEqual([draftPath]);
      expect(agentMsg?.form?.fields?.[0]?.id).toBe('decision');
      expect(finalized).toEqual([draftPath]);
    } finally {
      unregister();
    }
  });

  it('finalizes explicitly published exported videos on terminal delivery', async () => {
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    const finalized: string[] = [];
    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => { finalized.push(file); },
    });
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const cid = 'cid-export-video-final';
      const finalPath = path.join(tmpDir, 'workspace', 'project', 'render', 'final.mp4');
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.writeFileSync(finalPath, 'final video bytes');

      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
          paths: [finalPath],
          published: [finalPath],
        })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, cid);

      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const commanderMsg = rows.find((row: any) => row.from === 'commander' && row.text === 'published output ok');
      expect(commanderMsg?.produced).toEqual([finalPath]);
      expect(finalized).toEqual([finalPath]);
    } finally {
      unregister();
    }
  });

  it('prefers an explicit current-turn publication over extension ranking', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-published-output';
    const sourcePath = path.join(tmpDir, 'workspace', 'editable-source.md');
    const finalPath = path.join(tmpDir, 'workspace', 'export.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '# source');
    fs.writeFileSync(finalPath, 'pdf');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
        paths: [sourcePath, finalPath],
        published: [sourcePath],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander' && row.text === 'published output ok');
    expect(commanderMsg?.produced).toEqual([sourcePath]);
  });

  it('allows an explicit empty publication to suppress ambiguous working files', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-published-output-empty';
    const scriptPath = path.join(tmpDir, 'workspace', 'script.md');
    const shotlistPath = path.join(tmpDir, 'workspace', 'shotlist.json');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '# script');
    fs.writeFileSync(shotlistPath, '{}');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
        paths: [scriptPath, shotlistPath],
        published: [],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander' && row.text === 'published output ok');
    expect(commanderMsg?.produced).toBeUndefined();
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.existsSync(shotlistPath)).toBe(true);
  });

  it('hides process-dispatch files while keeping their paths in the commander handback', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-process-output-hidden';
    const processPath = path.join(tmpDir, 'workspace', 'shotlist.json');
    fs.mkdirSync(path.dirname(processPath), { recursive: true });
    fs.writeFileSync(processPath, '{}');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `NESTED_OUTPUT_VISIBILITY_TEST:${Buffer.from(JSON.stringify({
        tool: 'dispatch_to',
        path: processPath,
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const agentMsg = rows.find((row: any) => row.from === AGENT_ID && row.text === 'produced filter ok');
    expect(agentMsg?.produced).toBeUndefined();
    expect(streamProbe.dispatchResults.some((result) => result.includes(processPath))).toBe(true);
    expect(fs.existsSync(processPath)).toBe(true);
  });

  it('keeps hand-off files visible because the agent bubble is the final delivery', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-final-output-visible';
    const finalPath = path.join(tmpDir, 'workspace', 'final.pdf');
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, 'pdf');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `NESTED_OUTPUT_VISIBILITY_TEST:${Buffer.from(JSON.stringify({
        tool: 'hand_off_to',
        path: finalPath,
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const agentMsg = rows.find((row: any) => row.from === AGENT_ID && row.text === 'produced filter ok');
    expect(agentMsg?.produced).toEqual([finalPath]);
  });

  // `isQuiescent` reflects the in-memory queue/running state — exercised
  // implicitly by every bus-integration `waitForQuiescent` call. A
  // standalone tautological test (newly-empty bus is quiescent) wasn't
  // catching anything, so it was dropped.

  it('dropConv terminates the worker so it doesn\'t leak after conv delete', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    bus.subscribe(TEST_UID, TEST_CID, () => {});
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user', text: 'hello',
    });
    const stateBefore = bus._cidStateForTest(TEST_UID, TEST_CID);
    expect(stateBefore).toBeTruthy();

    bus.dropConv(TEST_UID, TEST_CID);
    const stateAfter = bus._cidStateForTest(TEST_UID, TEST_CID);
    expect(stateAfter).toBeNull();
    // Worker.terminated flag was set; the loop's `while (!w.terminated)`
    // now exits at the next wake. We can't observe the loop exit
    // directly, but isQuiescent reports true (since cid state is gone).
    expect(bus.isQuiescent(TEST_UID, TEST_CID)).toBe(true);
  });

  it('initialises a coding CLI conversation cwd from the agent project-dir setting without replaying on first dispatch', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const projectDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(projectDir);
    const agents = await import('../../../../src/main/features/agents');
    await agents.setAgentCliProjectDir(TEST_UID, AGENT_ID, projectDir);

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const cid = 'cid-coding-dir';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 看一下这个项目`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].cwd).toBe(projectDir);
    expect(cliRunMock.calls[0].prompt).toContain('看一下这个项目');
    expect(cliRunMock.calls[0].prompt).not.toContain('## Conversation so far');
    const st = await state.readState(TEST_UID, cid);
    expect(st.coding_project_dir).toBe(projectDir);
    expect(st.coding_project_dir_explicit).toBe(true);
  });

  it('asks for a project directory instead of silently falling back when a custom coding cwd vanished', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.inputs = [{ id: 'project_dir', type: 'directory', label: 'Project directory', required: true, default: '' }];
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const projectDir = path.join(tmpDir, 'repo-removed');
    fs.mkdirSync(projectDir);
    const agents = await import('../../../../src/main/features/agents');
    await agents.setAgentCliProjectDir(TEST_UID, AGENT_ID, projectDir);
    fs.rmSync(projectDir, { recursive: true, force: true });

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const cid = 'cid-coding-dir-missing';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 修一下这个项目`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(0);
    const st = await state.readState(TEST_UID, cid);
    expect(st.coding_project_dir).toBeUndefined();

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const formMsg = rows.find((row: any) => row?.form?.agent_id === AGENT_ID);
    expect(formMsg?.form?.fields?.map((f: any) => f.id)).toEqual(['project_dir']);
  });

  it('does not replay prior visible history when a CLI session resumes', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-coding-resume';
    const visibility = await import('../../../../src/main/features/group_chat/visibility');
    await visibility.appendVisible(TEST_UID, cid, {
      id: 'older-history',
      ts: '2026-05-19T00:00:00.000Z',
      from: 'user',
      to: [AGENT_ID],
      text: 'DO_NOT_PASS_WHEN_RESUMING',
    }, [AGENT_ID]);
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'codex', 'thread-123');

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 继续`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].resumeSessionId).toBe('thread-123');
    expect(cliRunMock.calls[0].prompt).not.toContain('DO_NOT_PASS_WHEN_RESUMING');
    expect(cliRunMock.calls[0].prompt).not.toContain('## Conversation so far');
  });

  it('bridges prior visible history when starting a fresh CLI session with existing context', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-coding-bridge';
    const visibility = await import('../../../../src/main/features/group_chat/visibility');
    await visibility.appendVisible(TEST_UID, cid, {
      id: 'older-history',
      ts: '2026-05-19T00:00:00.000Z',
      from: 'user',
      to: [AGENT_ID],
      text: 'PASS_WHEN_FRESH_WITH_PRIOR_CONTEXT',
    }, [AGENT_ID]);

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 换目录后继续`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[0].prompt).toContain('## Conversation so far');
    expect(cliRunMock.calls[0].prompt).toContain('PASS_WHEN_FRESH_WITH_PRIOR_CONTEXT');
    expect(cliRunMock.calls[0].prompt).toContain('换目录后继续');
  });
});

describe('group_chat bus › abort', () => {
  it('flips state.json to aborted + clears the queue', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    bus.subscribe(TEST_UID, TEST_CID, () => {});
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user', text: 'hi',
    });
    await bus.abort(TEST_UID, TEST_CID);
    const st = await state.readState(TEST_UID, TEST_CID);
    expect(st.status).toBe('aborted');
    expect(st.in_flight).toEqual([]);
    bus.dropConv(TEST_UID, TEST_CID);
  });
});

describe('group_chat bus › processItemsAreRoutingOnly (abort promotion guard)', () => {
  const toolEvent = (name: string) => ({ type: 'event' as const, event: { stream: 'tool', data: { name } } });
  const cliToolEvent = (tool: string) => ({ type: 'event' as const, event: { stream: 'cli', data: { type: 'tool-event', tool } } });

  it('is routing-only for a prep read + hand_off_to (aborted turn stays silent)', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    expect(bus.processItemsAreRoutingOnly([
      toolEvent('read_file'), toolEvent('read_file'), toolEvent('hand_off_to'),
    ])).toBe(true);
    // Runtime "总耗时" + progress lines (no tool name) are ignored.
    expect(bus.processItemsAreRoutingOnly([
      { type: 'progress', text: 'thinking…' },
      toolEvent('search_files'),
      cliToolEvent('dispatch_to'),
      { type: 'event', event: { stream: 'runtime', data: { phase: 'end' } } },
    ])).toBe(true);
  });

  it('is NOT routing-only when the trail did real work (keeps the persisted bubble)', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    expect(bus.processItemsAreRoutingOnly([toolEvent('plan_set'), toolEvent('hand_off_to')])).toBe(false);
    expect(bus.processItemsAreRoutingOnly([toolEvent('write_file'), toolEvent('hand_off_to')])).toBe(false);
    expect(bus.processItemsAreRoutingOnly([toolEvent('bash'), toolEvent('hand_off_to')])).toBe(false);
  });

  it('is NOT routing-only without a delegation tool (a read-only turn is preserved)', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    expect(bus.processItemsAreRoutingOnly([toolEvent('read_file')])).toBe(false);
    expect(bus.processItemsAreRoutingOnly([{ type: 'progress', text: 'x' }])).toBe(false);
    expect(bus.processItemsAreRoutingOnly([])).toBe(false);
  });
});
