import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * End-to-end integration tests for the group_chat bus. We mock
 * `streamChatWithModel` with a programmable script keyed by session id,
 * so a single conversation can drive multiple actor turns deterministically:
 *
 *   - Commander gets script entry for `orkas-<uid>-gconv-<cid>`
 *   - Agent X gets script entry for `orkas-<uid>-gmember-<cid>-<X>`
 *
 * Each script entry is an array of stream events the mock yields in order.
 * After the script entry is consumed, the next call for that session
 * yields a default `{type:'final', text:''}` + done (so unscripted turns
 * don't hang).
 */

const _scripts = new Map<string, Array<any[]>>();
function _setScript(sessionId: string, events: any[]) {
  const arr = _scripts.get(sessionId) || [];
  arr.push(events);
  _scripts.set(sessionId, arr);
}
function _resetScripts() { _scripts.clear(); }

const modelAbortMock = vi.hoisted(() => vi.fn(() => 0));

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: any) {
    const sid = opts.sessionId || '';
    const queue = _scripts.get(sid) || [];
    const events = queue.shift() || [{ type: 'final', text: '' }];
    _scripts.set(sid, queue);
    for (const ev of events) {
      if (ev?.type === '__wait_for_abort__') {
        if (!opts.abortSignal?.aborted) {
          await new Promise<void>((resolve) => {
            opts.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        yield { type: 'error', text: 'aborted', aborted: true };
        continue;
      }
      yield ev;
    }
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: modelAbortMock,
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const AGENT_ID = 'b8c7d6a5e4f3';
const AGENT_NAME = 'Writer';

function newCid(): string {
  return 'c' + Math.random().toString(16).slice(2, 13);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-int-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  _resetScripts();
  modelAbortMock.mockClear();
  modelAbortMock.mockReturnValue(0);
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);

  // Seed a custom agent on disk (新目录形态:agents/<aid>/agent.json)。
  const paths = await import('../../../../src/main/paths');
  const dir = paths.agentDir(TEST_UID, AGENT_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
    agent_id: AGENT_ID, name: AGENT_NAME,
    description: 'Writes things', workflow: 'do stuff',
    created_at: 't', updated_at: 't',
  }));
});

afterEach(async () => {
  // Drop conv state so workers terminate before the tmpDir is rm'd —
  // otherwise a half-finished worker writes after dir removal and we get
  // ENOENT log noise.
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    // Drop all known cids — the bus state map is module-internal but
    // _cidStateForTest exposes per-cid; iterate via `_cids` indirectly
    // by scanning the chats dir.
    const paths = await import('../../../../src/main/paths');
    const dir = paths.userChatsDir(TEST_UID);
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && /^c[0-9a-f]{12}$/.test(e.name)) bus.dropConv(TEST_UID, e.name);
      }
    }
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 30));
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
  throw new Error(`bus did not quiesce within ${timeoutMs}ms`);
}

describe('group_chat bus integration › disabled skills', () => {
  it('does not let commander substitute another skill when user explicitly requests a disabled one', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const enabled = await import('../../../../src/main/features/component_enabled');
    const storage = await import('../../../../src/main/storage');

    const skillDir = path.join(paths.userSkillsDir(TEST_UID), 'arxiv-reader');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: "arxiv-reader"',
      'description_zh: "ArXiv reader"',
      'description_en: "ArXiv reader"',
      '---',
      '',
      '# ArXiv Reader',
    ].join('\n'));
    enabled.setSkillEnabled(TEST_UID, 'arxiv-reader', false);

    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: 'WRONG: substituted skill ran' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '使用 arxiv-reader 技能：最新论文' });
    await waitForQuiescent(TEST_UID, cid, 2000);

    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    expect(messages.some((m: any) => String(m.text || '').includes('WRONG'))).toBe(false);
    expect(messages.some((m: any) => String(m.text || '').includes('component.skill_disabled_request'))).toBe(false);
    expect(messages.some((m: any) => String(m.text || '').includes('arxiv-reader'))).toBe(true);
    expect(messages.some((m: any) => /停用|disabled/i.test(String(m.text || '')))).toBe(true);
  });
});

// SKIP 原因:这些 chain 测试依赖 commander 在 `final.text` 里写
// `@<agent>` 触发派活。现在 LLM 派活已迁到 `dispatch_to` 工具调用,
// commander/agent 散文里 `@` 不再触发(详见 docs/plans/dispatch-via-
// tool-call.md + CLAUDE.md §5)。要重新启用这些测试需扩展
// streamChatWithModel mock,让它能模拟 tool_use 事件并触发 bus 的
// runTurn 工具执行链(包括 dispatch_to 的 staging + 回合结束后的
// flush)。当前 mock 只 yield 文本事件,无工具执行。
// 单元层的 dispatch 路由不变量已被 router.test.ts 锁住:
//   - commander/agent 散文 `@` → r.to=[user],不触发
//   - user 文本 `@` → 仍触发对应 actor
describe.skip('group_chat bus integration › full commander → agent → commander chain', () => {
  it('user message → commander dispatches @<agent> → agent replies → commander acks back to user', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    // Commander's first turn: dispatch to agent (Writer).
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: `@${AGENT_NAME} 帮我写一段开场白` },
    ]);
    // Agent's turn: explicit `@指挥官` to escalate back to commander
    // (default route is now `user`; the agent must opt into reporting up).
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: 'final', text: '@指挥官 已完成开场白：欢迎来到群聊。' },
    ]);
    // Commander's second turn (woken by agent's report): summarize for user.
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: 'Writer 已交付开场白，效果如下：欢迎来到群聊。' },
    ]);

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '帮我开个头' });
    await waitForQuiescent(TEST_UID, cid, 3000);

    // Inspect persisted main jsonl — should have 4 messages:
    // user → commander, commander → agent, agent → commander, commander → user
    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ from: 'user', to: ['commander'] });
    expect(lines[1]).toMatchObject({ from: 'commander', to: [AGENT_ID] });
    expect(lines[2]).toMatchObject({ from: AGENT_ID, to: ['commander'] });
    expect(lines[3]).toMatchObject({ from: 'commander', to: ['user'] });

    // Auto-add roster: agent should be a member.
    const m = await state.readMembers(TEST_UID, cid);
    expect(m.actors.find((a) => a.id === AGENT_ID)).toBeTruthy();

    // Visibility slice for agent should hold only its own + commander→agent
    // messages, not the unrelated user→commander or commander→user ones.
    const slice = fs.readFileSync(paths.groupChatVisibilityFile(TEST_UID, cid, AGENT_ID), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(slice.map((m: any) => m.from)).toEqual(['commander', AGENT_ID]);
  }, 10_000);
});

describe.skip('group_chat bus integration › multi-recipient parallel dispatch', () => {
  it('@A @B in one commander turn dispatches to both, both produce replies independently', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    // Seed a SECOND custom agent.
    const paths = await import('../../../../src/main/paths');
    const otherId = 'a1a2a3a4a5a6';
    const otherName = 'Reviewer';
    const otherDir = paths.agentDir(TEST_UID, otherId);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'agent.json'), JSON.stringify({
      agent_id: otherId, name: otherName,
      description: '审稿', workflow: 'review',
      created_at: 't', updated_at: 't',
    }));

    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: `@${AGENT_NAME} 写稿；@${otherName} 准备审` },
    ]);
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: 'final', text: '稿件草稿就绪' },
    ]);
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, otherId), [
      { type: 'final', text: '审核标准已就位' },
    ]);
    // Commander's wake-ups for each agent reply: yield empty (silence).
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: '' },
    ]);
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: '' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '准备稿件' });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    // Commander's dispatch line should have both ids in to[].
    const dispatch = lines.find((m) => m.from === 'commander' && m.to.length === 2);
    expect(dispatch).toBeTruthy();
    expect(dispatch.to.sort()).toEqual([otherId, AGENT_ID].sort());

    // Both agents replied:
    expect(lines.find((m) => m.from === AGENT_ID)).toBeTruthy();
    expect(lines.find((m) => m.from === otherId)).toBeTruthy();
  }, 10_000);
});

describe('group_chat bus integration › abort sticky across worker post-cleanup', () => {
  it('abort also targets active core-agent sessions by conversation id', async () => {
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');

    await bus.abort(TEST_UID, cid);

    expect(modelAbortMock).toHaveBeenCalledWith(cid);
  });

  it('abort during a turn keeps state.aborted; subsequent worker reply does NOT un-stick', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    // Commander turn that yields nothing (we'll abort during it).
    // The mock generator yields events synchronously, so abort after
    // enqueue returns also runs after the turn already completed for
    // a one-event script. To race the abort we let the script be
    // larger — multiple events with awaits between would help, but
    // since the mock is sync we instead just abort *immediately* after
    // enqueue and verify the post-abort state is sticky.
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: 'commander reply' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'hello' });
    await bus.abort(TEST_UID, cid);
    // Wait long enough for any pending worker microtasks to settle.
    await new Promise((r) => setTimeout(r, 100));
    const st = await state.readState(TEST_UID, cid);
    expect(st.status).toBe('aborted');
  });

  it('abort during a live agent turn propagates to the worker AbortSignal', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    bus.subscribe(TEST_UID, cid, () => {});
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: '__wait_for_abort__' },
      { type: 'final', text: 'should not appear after abort' },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} long task`,
    });

    const start = Date.now();
    while (Date.now() - start < 1000) {
      const live = bus._cidStateForTest(TEST_UID, cid);
      const worker = live?.workers.get(AGENT_ID);
      if (worker?.running && worker.abortController) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(bus._cidStateForTest(TEST_UID, cid)?.workers.get(AGENT_ID)?.abortController).toBeTruthy();

    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 2000);

    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    expect(messages.some((m: any) => m.text.includes('should not appear after abort'))).toBe(false);
    const st = await state.readState(TEST_UID, cid);
    expect(st.status).toBe('aborted');
  });

  it('a NEW user message after abort clears the sticky aborted flag', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'first' });
    await bus.abort(TEST_UID, cid);
    let st = await state.readState(TEST_UID, cid);
    expect(st.status).toBe('aborted');

    // New user message — bus should clear aborted → idle and process normally.
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: 'second reply' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'second' });
    await waitForQuiescent(TEST_UID, cid, 2000);

    st = await state.readState(TEST_UID, cid);
    expect(st.status).not.toBe('aborted');
  });
});

// SKIP 这块的第二条:`fromActorId: 'commander'` 写 @<id> 在文本里——
// 现在 commander 文本 @ 不解析,@<id>→@<name> 的 rewrite 链也跟着断
// (rewrite 依赖 router 把 agent 加进 idToName)。dispatch_to 工具用名字调
// 而非 id,这条已是 dead semantic;留着第一条(@<name> 不变)。
describe('group_chat bus integration › @<id> rewrite is no-op when text already uses @<name>', () => {
  it('text "@Writer ..." stays "@Writer ..." after enqueue (rewrite only fires when text uses raw id)', async () => {
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const msg = await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'commander',
      text: `@${AGENT_NAME} 写一段`,
    });
    expect(msg.text).toBe(`@${AGENT_NAME} 写一段`);
    expect(msg.text).not.toContain(AGENT_ID); // hex id never appears
  });

  it.skip('[obsolete] text "@<id> ..." gets rewritten to "@<name> ..." in persisted msg', async () => {
    // dispatch_to 用名字传 to 字段,commander 不再走文本 @<id> 派活,
    // rewrite 链已 dead。详见 docs/plans/dispatch-via-tool-call.md。
  });
});

describe('group_chat bus integration › CJK + space-stripped name resolution', () => {
  it('resolves @<no-space-name> when stored agent name has spaces', async () => {
    const cid = newCid();
    const paths = await import('../../../../src/main/paths');
    // Seed an agent whose display name has internal whitespace.
    const aid = 'aaa1bbb2ccc3';
    const pmDir = paths.agentDir(TEST_UID, aid);
    fs.mkdirSync(pmDir, { recursive: true });
    fs.writeFileSync(path.join(pmDir, 'agent.json'), JSON.stringify({
      agent_id: aid, name: '产品 经理',
      description: 'PM', workflow: '...',
      created_at: 't', updated_at: 't',
    }));

    const bus = await import('../../../../src/main/features/group_chat/bus');
    // User types `@产品经理` (no space) — bus should resolve to the agent
    // even though the stored name has a space.
    const msg = await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: '@产品经理 帮我做需求文档',
    });
    expect(msg.to).toEqual([aid]);
  });
});

// SKIP 原因(以下 5 个 describe 块):依赖 commander 在 final.text 写
// `@<agent>` 触发派活。LLM 派活已迁到 `dispatch_to` 工具调用,文本 @
// (commander/agent) 不再触发。要重启用,需扩展 streamChatWithModel mock
// 让它能模拟 tool_use 事件并触发 bus runTurn 的工具执行链(包括
// dispatch_to 的 staging + 回合结束后的 flush)。当前 mock 只 yield 文本
// 事件,无工具执行能力。详见 docs/plans/dispatch-via-tool-call.md。
// router 层的不变量已被 router.test.ts 覆盖。
describe.skip('group_chat bus integration › form submit end-to-end', () => {
  it('agent form → markFormSubmittedAndDispatch returns encoded text → user replay routes back to agent', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');

    // Commander dispatches to agent.
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: `@${AGENT_NAME} 帮我做` },
    ]);
    // Agent emits a form (fenced agent-input-form block) asking for inputs.
    const formPayload = {
      fields: [
        { id: 'topic', label: '主题', type: 'text', required: true },
        { id: 'depth', label: '深度', type: 'select',
          options: [{ value: 'q', label: '快速' }, { value: 'd', label: '深度' }],
          default: 'q' },
      ],
    };
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: 'final', text: `请确认参数。\n\n\`\`\`agent-input-form\n${JSON.stringify(formPayload)}\n\`\`\`\n` },
    ]);
    // Commander receives nothing meaningful from the agent (the form-bearing
    // message routes to commander by default since agent didn't @user; this
    // is a quirk worth noting — commander could also @user to surface it).
    // For the test we just want commander to be silent so the user-driven
    // form submission can fire next.
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: '' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '请准备需求' });
    await waitForQuiescent(TEST_UID, cid, 3000);

    // The agent's reply should be persisted with `form` populated.
    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agentReply = lines.find((m) => m.from === AGENT_ID && m.form);
    expect(agentReply).toBeTruthy();
    expect(agentReply.form.agent_id).toBe(AGENT_ID);
    expect(agentReply.form.fields).toHaveLength(2);

    // User submits the form. Now stage agent's response to the submission.
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: 'final', text: '收到参数：主题=Orkas，深度=深度。开始干活。' },
    ]);
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: '' },
    ]);

    const submitRes = await groupChat.markFormSubmittedAndDispatch({
      userId: TEST_UID, cid, msgId: agentReply.id, formId: agentReply.form.form_id,
      values: { topic: 'Orkas', depth: 'd' },
    });
    expect(submitRes.ok).toBe(true);
    expect(submitRes.submission?.text).toContain('agent-input-submission');
    expect(submitRes.submission?.agent_id).toBe(AGENT_ID);

    // Renderer would now pipe submission.text via groupChat.send. We do that.
    await groupChat.send({
      userId: TEST_UID, cid, text: submitRes.submission!.text,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);

    // The user-replay message should have routed to the agent (because the
    // text starts with `@<agent_id>`).
    const lines2 = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const userReplay = lines2.find((m) => m.from === 'user'
      && m.text.includes('agent-input-submission'));
    expect(userReplay).toBeTruthy();
    expect(userReplay.to).toEqual([AGENT_ID]);

    // The form-bearing original agent message should now be marked submitted.
    const updatedAgentReply = lines2.find((m) => m.id === agentReply.id);
    expect(updatedAgentReply.form.submitted).toBe(true);
    expect(updatedAgentReply.form.values).toEqual({ topic: 'Orkas', depth: 'd' });

    // Agent should have a follow-up reply after consuming the submission.
    const agentFollowup = lines2.filter((m) => m.from === AGENT_ID).pop();
    expect(agentFollowup.text).toContain('收到参数');
  }, 10_000);
});

describe('group_chat bus integration › conversation delete cascade', () => {
  it('chats.deleteConversation removes ALL per-conv on-disk artifacts', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const chats = await import('../../../../src/main/features/chats');
    const paths = await import('../../../../src/main/paths');

    // Create the conv via the chats facade so the index gets a row.
    const conv = await chats.createConversation(TEST_UID, { title: '测试' });
    // Hijack the cid since chats.createConversation generates its own.
    const realCid = conv.conversation_id;

    _setScript(state.buildGconvSessionId(TEST_UID, realCid), [
      { type: 'final', text: `@${AGENT_NAME} 干活` },
    ]);
    _setScript(state.buildGmemberSessionId(TEST_UID, realCid, AGENT_ID), [
      { type: 'final', text: 'done' },
    ]);
    _setScript(state.buildGconvSessionId(TEST_UID, realCid), [
      { type: 'final', text: 'ack' },
    ]);

    bus.subscribe(TEST_UID, realCid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid: realCid, fromActorId: 'user', text: 'go' });
    await waitForQuiescent(TEST_UID, realCid, 3000);

    // Sanity — all the expected files exist before delete.
    const mainJsonl = path.join(paths.userChatsDir(TEST_UID), `${realCid}.jsonl`);
    const groupDir = paths.groupChatDir(TEST_UID, realCid);
    const cmdSession = paths.userSessionFile(TEST_UID, state.buildGconvSessionId(TEST_UID, realCid));
    const agentSession = paths.userSessionFile(TEST_UID, state.buildGmemberSessionId(TEST_UID, realCid, AGENT_ID));
    expect(fs.existsSync(mainJsonl)).toBe(true);
    expect(fs.existsSync(groupDir)).toBe(true);
    // Note: session jsonls are created lazily by core-agent's PersistentSession;
    // they may or may not exist depending on whether the session got opened.
    // That's covered by the eviction behaviour rather than by file existence
    // here. We only assert they're CLEANED UP if they did exist.
    const cmdSessionExisted = fs.existsSync(cmdSession);
    const agentSessionExisted = fs.existsSync(agentSession);

    await chats.deleteConversation(TEST_UID, realCid);

    expect(fs.existsSync(mainJsonl)).toBe(false);
    expect(fs.existsSync(groupDir)).toBe(false);
    if (cmdSessionExisted) expect(fs.existsSync(cmdSession)).toBe(false);
    if (agentSessionExisted) expect(fs.existsSync(agentSession)).toBe(false);
    // Bus state for this cid must also be gone.
    expect(bus._cidStateForTest(TEST_UID, realCid)).toBeNull();
  }, 10_000);
});

describe.skip('group_chat bus integration › agent reply with explicit @user reaches subscribers', () => {
  it('user sends naked → commander dispatches @<agent> → agent replies "@user ..." → subscriber sees agent message event', async () => {
    // Repro for the screenshot-bug "agent bubble missing": agent's reply
    // had `@user` (so router lands `to=[user]` directly, skipping the
    // commander hop). We need to confirm the bus still emits a `message`
    // event for that agent reply — if it didn't, the renderer would
    // never get a chance to finalize the agent's placeholder bubble.
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: `正好群里有 @${AGENT_NAME}，让它跟你对接！\n\n@${AGENT_NAME} 我想要开发一个软件` },
    ]);
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: 'final', text: '@user 好的，我来帮你梳理需求。' },
    ]);

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '我想要开发一个软件' });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const messageEvents = events.filter((e) => e.type === 'message');
    // Expected: 3 message events — user→commander, commander→agent, agent→user.
    expect(messageEvents).toHaveLength(3);
    const fromAgent = messageEvents.find((e) => e.msg.from === AGENT_ID);
    expect(fromAgent).toBeTruthy();
    expect(fromAgent.msg.to).toEqual(['user']);
    // Leading `@user` is now stripped by the bus (see leading-@-strip pass);
    // the addressee info is in `to` already, so the literal is noise.
    expect(fromAgent.msg.text.startsWith('@user')).toBe(false);
    expect(fromAgent.msg.text).toContain('好的');

    // state_changed events around the agent turn must include in_flight=[agent]
    // — this is what the renderer uses to mint the agent's placeholder bubble
    // BEFORE the message event lands. If this is missing, the message arrives
    // with no placeholder to finalize and the fallback `appendChatMessage` path
    // runs instead. Either is OK for display; we just want to lock down that
    // the renderer's primary path (state_changed → ensure → message → finalize)
    // sees the correct in_flight signal.
    const stateChanges = events.filter((e) => e.type === 'state_changed');
    const sawAgentInFlight = stateChanges.some(
      (e) => Array.isArray(e.state.in_flight) && e.state.in_flight.includes(AGENT_ID),
    );
    expect(sawAgentInFlight).toBe(true);
  }, 10_000);
});

describe.skip('group_chat bus integration › leading @<recipient> stripped from persisted text', () => {
  it('agent reply "@user 好的..." persists as "好的..." (recipient is in `to`, leading @ is noise)', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: `@${AGENT_NAME} 接力` },
    ]);
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: 'final', text: '@user 好的，我来帮你梳理需求。😊' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '开始' });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.to).toEqual(['user']);
    // Leading "@user" + the comma trailing it should be gone.
    expect(agentMsg.text).toBe('好的，我来帮你梳理需求。😊');
    // Embedded @-mentions later in the text should NOT be stripped — only
    // the very-leading run of recipient mentions counts as redundant noise.
    expect(agentMsg.text.startsWith('@')).toBe(false);
  }, 10_000);

  it('mid-prose @<recipient> ALSO stripped — strip applies whole-text now', async () => {
    // Earlier behavior was leading-only; users found mid-prose `@user` ("好的
    // @user，关于...") just as redundant since `to` already addresses them.
    // Strip is now whole-text for `@user` / `@commander` (and Chinese aliases).
    // Mid-prose `@<agent>` still survives — observers benefit from seeing
    // who got dispatched.
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: `@${AGENT_NAME} 干吧` },
    ]);
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: 'final', text: '收到 @user，我会同步给 @user' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '开始' });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg.text).not.toContain('@user');
    expect(agentMsg.text).toBe('收到，我会同步给');
  }, 10_000);
});

describe.skip('group_chat bus integration › agent default-route lands on user', () => {
  it('agent reply with no @-mention routes to [user] (commander only on explicit @<commander>)', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: `@${AGENT_NAME} 干吧` },
    ]);
    // Agent reply with no @-mention — should default to [user] now.
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: 'final', text: '已完成。' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '开始' });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.to).toEqual(['user']);
  }, 10_000);

  it('agent reply with `@指挥官` routes to commander (Chinese alias resolves)', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: `@${AGENT_NAME} 干吧` },
    ]);
    // Agent escalates to commander via Chinese alias.
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: 'final', text: '@指挥官 我这边卡住了，需要你协调。' },
    ]);
    // Commander replies (gets queued because alias resolves to commander).
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: '收到。' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '开始' });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.to).toEqual(['commander']);
    // Leading `@指挥官` is a recipient mention but it's a NAMED agent-style
    // alias, not the literal `commander` reserved id. Our strip pass only
    // peels `@user` / `@commander` literals, so `@指挥官` survives in the
    // text — that's fine, gives observers the routing context.
  }, 10_000);
});

describe.skip('group_chat bus integration › no shadow-tap on agent → user', () => {
  // The shadow-tap was removed: plan_executor's reconcile in runTurn
  // already wakes commander deterministically for plan-driven flows. For
  // non-plan @-mention dispatches, commander has no orchestration role and
  // staying asleep keeps the chat clean (no "commander chimes in to
  // re-paraphrase the agent's form" failure mode).
  it('non-plan agent → user reply does NOT wake commander (no extra turn)', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: `@${AGENT_NAME} 干吧` },
    ]);
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: 'final', text: '已完成。' },
    ]);
    // No 2nd commander script entry: if shadow-tap fired, the missing
    // script would trigger the mock's default empty-final + done, and the
    // empty final goes through the silent-commander path → still no
    // persisted message — but a turn-start log would prove the wake happened.

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '开始' });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    // Exactly 3 messages: user→commander, commander→agent, agent→user.
    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatchObject({ from: AGENT_ID, to: ['user'] });
    expect(lines.find((l: any) => l.text === '(no reply)')).toBeUndefined();
  }, 10_000);
});
