import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Project to-do trunk flow — deterministic end-to-end (no model).
 *
 * Exercises the REAL projects / todo_tasks / project_driver /
 * project_driver_runner layer through the whole to-do lifecycle: create +
 * assign, the auto-advance loop driving every task with the REAL advance
 * (todo→progress, keeping going while conversations still run), the human
 * review lifecycle (progress → review → done) and progress rollup, and the
 * change/advance notifications the renderer listens to.
 *
 * Only the genuinely model-driven side is mocked — spawning the advance
 * conversation (chats.createConversation) and enqueuing its seed
 * (groupChat.send). Unlike fabric_pipeline_e2e (which INJECTS the fire), this
 * runs the real advance so the status flip, lease bookkeeping, and events are
 * all covered end to end.
 */
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'final', text: '' }; yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));
vi.mock('../../../src/main/features/chats', () => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
}));
vi.mock('../../../src/main/features/group_chat', () => ({
  send: vi.fn(),
  setFloor: vi.fn(async () => ({ ok: true })),
  busIsQuiescent: () => true,
}));

let tmpDir: string;
let prevWs: string | undefined;
let convSeq: number;
const UID = 'uTODOE2E';
const AGENT = 'a1b2c3d4e5f6';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-todo-e2e-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  convSeq = 0;
  // Each user journey owns its dispatch counts; resetModules does not clear hoisted mocks.
  vi.clearAllMocks();
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});
afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Load real modules (post-reset) and wire the conversation/bus mocks on the same
// instances the runner uses, so the real advance's createConversation/send hit
// them. A unique cid per advance mirrors production (distinct leases + convs).
async function load() {
  const chats = await import('../../../src/main/features/chats');
  const groupChat = await import('../../../src/main/features/group_chat');
  vi.mocked(chats.createConversation).mockImplementation(async () => ({ conversation_id: `c_${++convSeq}` } as never));
  vi.mocked(chats.deleteConversation).mockResolvedValue(undefined as never);
  vi.mocked(groupChat.send).mockResolvedValue({ ok: true } as never);
  return {
    chats,
    groupChat,
    projects: await import('../../../src/main/features/projects'),
    pt: await import('../../../src/main/features/project_tasks'),
    drv: await import('../../../src/main/features/project_driver'),
    runner: await import('../../../src/main/features/project_driver_runner'),
  };
}

async function seedProject(projects: any, name = 'Iterate'): Promise<string> {
  const r = await projects.createProject(UID, name);
  if (!r.ok) throw new Error('createProject failed');
  await projects.addAgentBinding(UID, r.project.project_id, AGENT);
  return r.project.project_id;
}

describe('project to-do › end-to-end', () => {
  it.each(['manual', 'auto'])('dispatches a globally assigned task through the selected agent for %s processing', async (mode) => {
    const { pt, runner, groupChat, chats } = await load();
    const agents = await import('../../../src/main/features/agents');
    const owner = await agents.createCustomAgent({ name: 'GlobalSpecialist' });
    if (!owner) throw new Error('agent fixture failed');
    const created = await pt.createTask(UID, '', { title: 'Assigned global work', owner_agent_id: owner.agent_id });
    if (!created.ok) throw new Error('task fixture failed');
    const run = () => mode === 'manual' ? runner.runTaskNow(UID, '', created.task.id) : runner.advance(UID, '', created.task);
    const result = await run();
    expect(result.ok).toBe(true);
    expect(groupChat.setFloor).toHaveBeenCalledWith(UID, result.cid, owner.agent_id);
    expect(groupChat.send).toHaveBeenCalledWith(expect.objectContaining({ cid: result.cid, text: created.task.title }));
    expect(vi.mocked(groupChat.setFloor).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(groupChat.send).mock.invocationCallOrder[0]);
    expect(await pt.getTask(UID, '', created.task.id)).toMatchObject({ owner_agent_id: owner.agent_id, status: 'progress', origin_cid: result.cid });

    // Losing the selected agent must not silently run the default assistant.
    await pt.updateTask(UID, '', created.task.id, { status: 'todo' });
    vi.mocked(groupChat.setFloor).mockResolvedValueOnce({ ok: false, error: 'unknown agent' } as never);
    expect((await run()).ok).toBe(false);
    expect(groupChat.send).toHaveBeenCalledTimes(1);
    expect(chats.deleteConversation).toHaveBeenCalledWith(UID, 'c_2', null);
    expect((await pt.getTask(UID, '', created.task.id))?.status).toBe('todo');
    agents.setAgentEnabledForActiveUser(owner.agent_id, false);
    expect((await run()).ok).toBe(false);
    expect(groupChat.send).toHaveBeenCalledTimes(1);
    expect(chats.deleteConversation).toHaveBeenCalledWith(UID, 'c_3', null);
    expect((await pt.getTask(UID, '', created.task.id))?.status).toBe('todo');
  });
  it('processes a task again from review while preserving its brief and first conversation', async () => {
    const { pt, runner, projects, groupChat } = await load();
    const pid = await seedProject(projects);
    const created = await pt.createTask(UID, pid, { title: 'Deliver and verify' });
    if (!created.ok) throw new Error('task fixture failed');
    await pt.uploadTaskAttachment(UID, pid, created.task.id, 'brief.txt', Buffer.from('Required delivery'));
    const first = await runner.runTaskNow(UID, pid, created.task.id);
    expect(first.ok).toBe(true);
    expect((await pt.getTask(UID, pid, created.task.id))?.status).toBe('progress');
    // These writes represent explicit executor tool updates after verification;
    // dispatching the conversation itself must not imply either outcome.
    expect((await pt.updateTask(UID, pid, created.task.id, { status: 'review', result_ref: 'delivery-v1' })).ok).toBe(true);
    const second = await runner.runTaskNow(UID, pid, created.task.id);
    expect(second.ok).toBe(true);
    expect(second.cid).not.toBe(first.cid);
    expect(await pt.getTask(UID, pid, created.task.id)).toMatchObject({
      status: 'review', result_ref: 'delivery-v1', origin_cid: first.cid,
    });
    expect(vi.mocked(groupChat.send).mock.calls.at(-1)?.[0]).toMatchObject({
      cid: second.cid, attachments: ['brief.txt'], model_text: expect.stringContaining('to done with todo_tasks'),
    });
    const { chatAttachmentDirForConversation } = await import('../../../src/main/util/project-layout');
    expect(fs.readFileSync(path.join(chatAttachmentDirForConversation(UID, second.cid!, pid), 'brief.txt'), 'utf8'))
      .toBe('Required delivery');
    expect((await pt.completeTask(UID, pid, created.task.id, 'verified-delivery')).ok).toBe(true);
    const persisted = await pt.listTasks(UID, pid);
    expect(persisted).toEqual([expect.objectContaining({
      id: created.task.id, status: 'done', result_ref: 'verified-delivery', origin_cid: first.cid,
    })]);
    expect(pt.computeProgress(persisted)).toMatchObject({ done: 1, open: 0 });
  });

  it.each([
    { scope: 'project', competing: 'manual' },
    { scope: 'global', competing: 'manual' },
    { scope: 'project', competing: 'auto' },
    { scope: 'global', competing: 'auto' },
  ])('dispatches a $scope task only once when a manual start overlaps $competing', async ({ scope, competing }) => {
    const { pt, runner, projects, chats, groupChat } = await load();
    const pid = scope === 'project' ? await seedProject(projects) : '';
    const created = await pt.createTask(UID, pid, { title: 'One deliverable, one execution' });
    if (!created.ok) throw new Error('task fixture failed');
    // Both entry points reach conversation creation before either can claim
    // the task, as with a double click or a scheduler tick during a UI start.
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    let arrivals = 0;
    vi.mocked(chats.createConversation).mockImplementation(async () => {
      const cid = `c_overlap_${++arrivals}`;
      if (arrivals === 2) release();
      await bothArrived;
      return { conversation_id: cid } as never;
    });

    const results = await Promise.all([
      runner.runTaskNow(UID, pid, created.task.id),
      competing === 'manual'
        ? runner.runTaskNow(UID, pid, created.task.id)
        : runner.advance(UID, pid, created.task),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(groupChat.send).toHaveBeenCalledTimes(1);
    const winningCid = results.find((result) => result.ok)!.cid;
    expect(await pt.getTask(UID, pid, created.task.id)).toMatchObject({
      status: 'progress', origin_cid: winningCid,
    });
    expect(chats.deleteConversation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chats.deleteConversation).mock.calls[0][1]).not.toBe(winningCid);
  });

  it.each(['project', 'global'])('can retry an unsent $scope task without losing its attachments', async (scope) => {
    const { pt, runner, projects, groupChat } = await load();
    const pid = scope === 'project' ? await seedProject(projects) : '';
    const created = await pt.createTask(UID, pid, { title: 'Retry with original brief' });
    if (!created.ok) throw new Error('task fixture failed');
    expect((await pt.uploadTaskAttachment(UID, pid, created.task.id, 'brief.txt', Buffer.from('Original brief'))).ok).toBe(true);
    vi.mocked(groupChat.send).mockResolvedValueOnce({ ok: false, error: 'no_model' } as never);

    expect(await runner.runTaskNow(UID, pid, created.task.id)).toMatchObject({ ok: false, error: 'no_model' });
    expect(await pt.getTask(UID, pid, created.task.id)).toMatchObject({ status: 'todo', attachments: ['brief.txt'] });
    expect((await pt.getTask(UID, pid, created.task.id))?.origin_cid).toBeUndefined();
    const retried = await runner.runTaskNow(UID, pid, created.task.id);
    expect(retried.ok).toBe(true);
    expect(await pt.getTask(UID, pid, created.task.id)).toMatchObject({ status: 'progress', origin_cid: retried.cid });
    const { chatAttachmentDirForConversation } = await import('../../../src/main/util/project-layout');
    expect(fs.readFileSync(path.join(chatAttachmentDirForConversation(UID, retried.cid!, pid || null), 'brief.txt'), 'utf8'))
      .toBe('Original brief');
    expect(vi.mocked(groupChat.send).mock.calls.at(-1)?.[0]).toMatchObject({ cid: retried.cid, attachments: ['brief.txt'] });
  });

  it.each(['review', 'done'] as const)('does not undo a newer %s decision when dispatch reports failure late', async (status) => {
    const { pt, runner, projects, groupChat } = await load();
    const pid = await seedProject(projects);
    const created = await pt.createTask(UID, pid, { title: 'Preserve the latest decision' });
    if (!created.ok) throw new Error('task fixture failed');
    vi.mocked(groupChat.send).mockImplementationOnce(async () => {
      expect((await pt.getTask(UID, pid, created.task.id))?.status).toBe('progress');
      expect((await pt.updateTask(UID, pid, created.task.id, { status, result_ref: 'reviewed-result' })).ok).toBe(true);
      return { ok: false, error: 'send_failed' } as never;
    });
    expect((await runner.runTaskNow(UID, pid, created.task.id)).ok).toBe(false);
    expect(await pt.getTask(UID, pid, created.task.id)).toMatchObject({ status, result_ref: 'reviewed-result' });
  });

  it('drives the whole backlog to progress and keeps advancing while conversations run', async () => {
    const { pt, drv, runner, projects } = await load();
    const pid = await seedProject(projects);
    await pt.createTask(UID, pid, { title: 'Design', owner_agent: 'Owner', owner_agent_id: AGENT });
    await pt.createTask(UID, pid, { title: 'Build' });
    await pt.createTask(UID, pid, { title: 'Ship' });
    await drv.writeConfig(UID, pid, { enabled: true });

    const advances: Array<{ pid: string; cid: string }> = [];
    runner.onAdvance((e: { pid: string; cid: string }) => advances.push(e));

    // isQuiescent:false ⇒ the advance conversation is still "running". The loop
    // must still move to the next task (the lease releases once the advanced
    // task leaves todo), not stall on it.
    const deps = (nowMs: number) => ({
      now: () => nowMs,
      listTasks: (u: string, p: string) => pt.listTasks(u, p),
      isQuiescent: () => false,
      advance: runner.advance,
    });

    const outcomes: string[] = [];
    let clock = 1_000_000;
    for (let i = 0; i < 4; i += 1) {
      outcomes.push(await runner.advanceProjectIfDue(UID, pid, deps(clock)));
      clock += drv.MIN_ADVANCE_INTERVAL_MS;
    }

    // One advance per task, then nothing actionable (all progress).
    expect(outcomes).toEqual(['advanced', 'advanced', 'advanced', 'no_actionable_task']);
    const tasks = await pt.listTasks(UID, pid);
    expect(tasks.map((t: { status: string }) => t.status)).toEqual(['progress', 'progress', 'progress']);

    // Each advance created a distinct conversation the renderer can surface.
    expect(advances).toHaveLength(3);
    expect(new Set(advances.map((a) => a.cid)).size).toBe(3);
    expect(advances.every((a) => a.pid === pid)).toBe(true);
  });

  it('completes a task through the human review lifecycle and rolls up progress, notifying the UI', async () => {
    const { pt, projects } = await load();
    const pid = await seedProject(projects);
    const t1 = await pt.createTask(UID, pid, { title: 'Feature' });
    await pt.createTask(UID, pid, { title: 'Docs' });
    if (!t1.ok) throw new Error('seed');

    const changes: Array<{ uid: string; pid: string }> = [];
    pt.onTasksChanged((e: { uid: string; pid: string }) => changes.push(e));

    // Commander advances it, then a human review approves it.
    await pt.updateTask(UID, pid, t1.task.id, { status: 'progress' });
    await pt.updateTask(UID, pid, t1.task.id, { status: 'review' });
    const done = await pt.updateTask(UID, pid, t1.task.id, { status: 'done', result_ref: 'chat-42' });
    expect(done.ok).toBe(true);
    if (done.ok) {
      expect(done.task.status).toBe('done');
      expect(done.task.done_at).toBeTruthy();
      expect(done.task.result_ref).toBe('chat-42');
    }

    const progress = pt.computeProgress(await pt.listTasks(UID, pid));
    expect(progress).toMatchObject({ total: 2, done: 1, open: 1 });

    // Every write notified the UI so the open to-do list refreshes live.
    expect(changes.length).toBeGreaterThanOrEqual(3);
    expect(changes.every((c) => c.uid === UID && c.pid === pid)).toBe(true);
  });

  it('a manual run dispatches assigned and unassigned tasks and flips them progress', async () => {
    const { pt, runner, projects } = await load();
    const pid = await seedProject(projects);
    const t = await pt.createTask(UID, pid, { title: 'Analyze funnel', owner_agent: 'Owner', owner_agent_id: AGENT });
    if (!t.ok) throw new Error('seed');

    const res = await runner.runTaskNow(UID, pid, t.task.id);
    expect(res.ok).toBe(true);
    expect(res.cid).toBeTruthy();
    const after = await pt.getTask(UID, pid, t.task.id);
    expect(after?.status).toBe('progress');

    // Without an owner the same manual action routes through the project
    // commander, matching the automation-style run-now fallback.
    const bare = await pt.createTask(UID, pid, { title: 'no owner' });
    if (!bare.ok) throw new Error('seed');
    const unassigned = await runner.runTaskNow(UID, pid, bare.task.id);
    expect(unassigned.ok).toBe(true);
    expect((await pt.getTask(UID, pid, bare.task.id))?.status).toBe('progress');
  });

  it('carries a task\'s attachments into the conversation it starts (manual run + driver advance)', async () => {
    const { pt, runner, projects, groupChat } = await load();
    const pid = await seedProject(projects);

    // Manual run: file is copied into the new conversation's chat_attachments dir
    // and its name rides along in the send, exactly like a chat attachment.
    const t1 = await pt.createTask(UID, pid, { title: 'Brief', owner_agent: 'Owner', owner_agent_id: AGENT });
    if (!t1.ok) throw new Error('seed');
    await pt.uploadTaskAttachment(UID, pid, t1.task.id, 'brief.txt', Buffer.from('do X'));
    const res = await runner.runTaskNow(UID, pid, t1.task.id);
    expect(res.ok).toBe(true);
    const runSend = vi.mocked(groupChat.send).mock.calls.at(-1)?.[0] as { attachments?: string[] };
    expect(runSend.attachments).toEqual(['brief.txt']);
    // Resolve from the fresh module (paths pin the workspace root at load, so a
    // top-level import would use a stale root from before beforeEach ran).
    const { chatAttachmentDirForConversation } = await import('../../../src/main/util/project-layout');
    const dest = path.join(chatAttachmentDirForConversation(UID, String(res.cid), pid), 'brief.txt');
    expect(fs.readFileSync(dest, 'utf-8')).toBe('do X');

    // Driver advance carries them too (reads the task fresh, like the real loop).
    const t2 = await pt.createTask(UID, pid, { title: 'Spec' });
    if (!t2.ok) throw new Error('seed');
    await pt.uploadTaskAttachment(UID, pid, t2.task.id, 'spec.md', Buffer.from('# spec'));
    const fresh = await pt.getTask(UID, pid, t2.task.id);
    const adv = await runner.advance(UID, pid, fresh!);
    expect(adv.ok).toBe(true);
    const advSend = vi.mocked(groupChat.send).mock.calls.at(-1)?.[0] as { attachments?: string[] };
    expect(advSend.attachments).toEqual(['spec.md']);
  });
});
