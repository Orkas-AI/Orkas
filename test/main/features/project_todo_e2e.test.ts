import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BrowserWindow } from 'electron';
import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';

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
 * The model-driven side is mocked — spawning the advance
 * conversation (chats.createConversation) and enqueuing its seed
 * (groupChat.send). Unlike fabric_pipeline_e2e (which INJECTS the fire), this
 * runs the real advance so the status flip, lease bookkeeping, and events are
 * all covered end to end.
 * The headless Electron window registry is empty; real browser binding must
 * return unavailable without throwing or preventing a task from running.
 */
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'final', text: '' }; yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));
// This deterministic trunk has no desktop window; browser input has its own suites.
vi.mock('../../../src/main/features/web_assist', () => ({
  bindHostStartedWebAssistConversation: vi.fn(() => false),
}));
vi.mock('../../../src/main/features/chats', () => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  getConversation: vi.fn(async () => null),
  getProjectConversationCounts: vi.fn(async () => new Map()),
}));
vi.mock('../../../src/main/features/group_chat', () => ({
  send: vi.fn(),
  setFloor: vi.fn(async () => ({ ok: true })),
  busIsQuiescent: vi.fn(() => true),
}));

let tmpDir: string;
let prevWs: string | undefined;
let convSeq: number;
const UID = 'uTODOE2E';
let AGENT: string;
let closeLogWorkers: () => Promise<void>;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-todo-e2e-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  convSeq = 0;
  // Each user journey owns its dispatch counts; resetModules does not clear hoisted mocks.
  vi.clearAllMocks();
  vi.resetModules();
  closeLogWorkers = await captureMainLogWorkers();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});
afterEach(async () => {
  await closeLogWorkers();
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
  vi.mocked(groupChat.busIsQuiescent).mockReturnValue(true);
  return {
    chats,
    groupChat,
    projects: await import('../../../src/main/features/projects'),
    pt: await import('../../../src/main/features/project_tasks'),
    drv: await import('../../../src/main/features/project_driver'),
    runner: await import('../../../src/main/features/project_driver_runner'),
  };
}

// Automatic dispatch fixtures opt in explicitly, just like the toolbar action.
async function startAutomaticTask(runner: Awaited<ReturnType<typeof load>>['runner'], pid: string, task: any) {
  const driver = await import('../../../src/main/features/project_driver');
  await driver.writeConfig(UID, pid, { enabled: true });
  return runner.advance(UID, pid, task);
}

async function seedProject(projects: any, name = 'Iterate'): Promise<string> {
  const agents = await import('../../../src/main/features/agents');
  const agent = await agents.createCustomAgent({ name: 'Owner' });
  if (!agent) throw new Error('agent fixture failed');
  AGENT = agent.agent_id;
  const r = await projects.createProject(UID, name);
  if (!r.ok) throw new Error('createProject failed');
  await projects.addAgentBinding(UID, r.project.project_id, AGENT);
  return r.project.project_id;
}

describe('project to-do › end-to-end', () => {
  it('saves the due day a model gives a to-do, clears it on an empty string, and refuses a malformed one', async () => {
    await load();
    const { createProjectTasksHandler } = await import('../../../src/main/features/project_tasks_tool_handler');
    const handler = createProjectTasksHandler(UID, '', 'c_due', new Map());
    const created = await handler.create({ content: 'Send the launch email', due_at: '2026-10-25' });
    expect(created).toMatchObject({ ok: true, task: { due_at: '2026-10-25' } });
    const tid = (created as { task: { id: string } }).task.id;
    expect(await handler.update(tid, { due_at: '2026-11-01' })).toMatchObject({ ok: true, task: { due_at: '2026-11-01' } });
    expect(await handler.update(tid, { due_at: 'Friday' })).toMatchObject({ ok: false, error: 'due_invalid' });
    expect((await handler.get(tid) as { task: { due_at?: string } }).task.due_at).toBe('2026-11-01');
    expect(await handler.update(tid, { due_at: '' })).toMatchObject({ ok: true });
    expect((await handler.get(tid) as { task: object }).task).not.toHaveProperty('due_at');
    expect(await handler.create({ content: 'Bad day', due_at: '2026-02-30' })).toMatchObject({ ok: false, error: 'due_invalid' });
  });


  it.each(['project', 'global'])('executes a synced %s backlog only on its bound installation, then hands it over after disable/re-enable', async scope => {
    const a = await load();
    const pid = scope === 'project' ? await seedProject(a.projects) : '';
    const created = await a.pt.createTask(UID, pid, { content: 'One automatic execution' });
    if (!created.ok) throw new Error('task fixture failed');
    const configA = await a.drv.writeConfig(UID, pid, { enabled: true });
    const pathsA = await import('../../../src/main/paths');
    const driverFileA = pid ? pathsA.projectDriverFile(UID, pid) : pathsA.userTodoDriverFile(UID);
    const rootB = path.join(tmpDir, 'installation-b');
    // Each device has its own stale todo snapshot and local lease/count. Only
    // cloud data is copied, exactly as sync does; machine identity is not copied.
    fs.cpSync(path.join(tmpDir, UID, 'cloud'), path.join(rootB, UID, 'cloud'), { recursive: true });
    expect(await a.runner.advanceProjectIfDue(UID, pid)).toBe('advanced');
    expect(a.groupChat.send).toHaveBeenCalledTimes(1);

    process.env.ORKAS_WORKSPACE_ROOT = rootB;
    vi.resetModules();
    const usersB = await import('../../../src/main/features/users');
    usersB.activateUser(UID);
    const b = await load();
    expect(b.drv.getCurrentDevice().id).not.toBe(configA.device_id);
    vi.mocked(b.groupChat.send).mockClear();
    expect((await b.pt.getTask(UID, pid, created.task.id))?.status).toBe('todo');
    expect(await b.runner.advanceProjectIfDue(UID, pid)).toBe('other_device');
    expect(b.groupChat.send).not.toHaveBeenCalled();
    expect(await b.drv.readState(UID, pid)).toEqual({});

    await b.drv.writeConfig(UID, pid, { enabled: false });
    const pathsB = await import('../../../src/main/paths');
    const driverFileB = pid ? pathsB.projectDriverFile(UID, pid) : pathsB.userTodoDriverFile(UID);
    fs.copyFileSync(driverFileB, driverFileA);
    expect(await a.runner.advanceProjectIfDue(UID, pid)).toBe('disabled');
    const configB = await b.drv.writeConfig(UID, pid, { enabled: true });
    expect(configB.device_id).toBe(b.drv.getCurrentDevice().id);
    fs.copyFileSync(driverFileB, driverFileA);
    expect(await a.runner.advanceProjectIfDue(UID, pid)).toBe('other_device');
    expect(await b.runner.advanceProjectIfDue(UID, pid)).toBe('advanced');
    expect(b.groupChat.send).toHaveBeenCalledTimes(1);
    expect(await b.pt.getTask(UID, pid, created.task.id)).toMatchObject({ status: 'progress', origin_cid: expect.any(String) });
  });

  it.each([
    ['global', 'manual'], ['global', 'automatic'],
    ['project', 'manual'], ['project', 'automatic'], ['project', 'legacy'],
  ])('persists and executes Commander in %s scope through %s dispatch without agent bindings', async (scope, mode) => {
    const { pt, runner, projects, groupChat } = await load();
    let pid = '';
    if (scope === 'project') {
      const project = await projects.createProject(UID, 'Commander work');
      if (!project.ok) throw new Error('project fixture failed');
      pid = project.project.project_id;
    }
    vi.useFakeTimers();
    try {
      const created = await pt.createTask(UID, pid, { content: 'Commander work',
        owner_agent_id: 'commander', owner_agent: 'Commander' });
      expect(created).toMatchObject({ ok: true, task: { owner_agent_id: 'commander' } });
      if (!created.ok) return;
      if (mode === 'legacy') {
        const { projectTaskFile } = await import('../../../src/main/paths');
        const file = projectTaskFile(UID, pid, created.task.id);
        const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
        delete stored.owner_agent_id;
        stored.owner_agent = 'commander';
        fs.writeFileSync(file, JSON.stringify(stored));
      }
      const fresh = await pt.getTask(UID, pid, created.task.id);
      if (mode !== 'legacy') expect(fresh).toMatchObject({ owner_agent_id: 'commander' });
      const result = mode !== 'automatic' ? await runner.runTaskNow(UID, pid, created.task.id)
        : await startAutomaticTask(runner, pid, fresh!);
      expect(result.ok).toBe(true);
      expect(groupChat.setFloor).toHaveBeenCalledWith(UID, result.cid, 'commander');
      expect(groupChat.send).toHaveBeenCalledWith(expect.objectContaining({ text: 'Commander work' }));
      expect(await pt.getTask(UID, pid, created.task.id)).toMatchObject({ status: 'progress',
        ...(mode !== 'legacy' ? { owner_agent_id: 'commander' } : { owner_agent: 'commander' }), origin_cid: result.cid });
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });

  it.each(['project', 'global'])('links a %s todo on its saved-from conversation (global only) or first execution; edits, completion and duplicate creation keep the link', async (scope) => {
    const { pt, runner, projects } = await load();
    const { createProjectTasksHandler } = await import('../../../src/main/features/project_tasks_tool_handler');
    const pid = scope === 'project' ? await seedProject(projects) : '';
    const creator = createProjectTasksHandler(UID, pid, 'c_creator', new Map());
    const created = await creator.create({ content: 'Execute only when requested' });
    expect(created.ok).toBe(true);
    const tid = created.task.id;
    // A global to-do saved from a conversation points back there; a project
    // backlog item links on its first run instead.
    if (scope === 'global') expect(created.task).toMatchObject({ origin_cid: 'c_creator' });
    else expect(created.task).not.toHaveProperty('origin_cid');
    expect((await creator.update(tid, { status: 'progress' })).ok).toBe(true);
    expect((await creator.complete(tid)).ok).toBe(true);
    if (scope === 'global') expect(await pt.getTask(UID, pid, tid)).toMatchObject({ origin_cid: 'c_creator' });
    else expect(await pt.getTask(UID, pid, tid)).not.toHaveProperty('origin_cid');
    await creator.update(tid, { status: 'todo' });

    // The saved-from conversation does not exist in this fixture, so the run
    // falls back to a new conversation and the link follows it.
    const first = await runner.runTaskNow(UID, pid, tid);
    expect(first.ok).toBe(true);
    expect((await import('../../../src/main/features/web_assist')).bindHostStartedWebAssistConversation).toHaveBeenCalledWith(UID, first.cid);
    expect(await pt.getTask(UID, pid, tid)).toMatchObject({ origin_cid: first.cid, status: 'progress' });
    const reused = await creator.create({ content: 'Execute only when requested' });
    expect(reused).toMatchObject({ ok: true, alreadyExists: true, task: { id: tid, origin_cid: first.cid } });
    await creator.update(tid, { content: 'Revised requirements', owner: '', status: 'todo' });
    const second = await startAutomaticTask(runner, pid, (await pt.getTask(UID, pid, tid))!);
    expect(second.ok).toBe(true);
    expect(second.cid).not.toBe(first.cid);
    const oldExecutor = createProjectTasksHandler(UID, pid, first.cid!, new Map());
    expect((await oldExecutor.update(tid, { status: 'review' })).ok).toBe(true);
    expect((await oldExecutor.complete(tid)).ok).toBe(true);
    expect((await creator.update(tid, { content: 'Final requirements' })).ok).toBe(true);
    vi.resetModules();
    const reloaded = await import('../../../src/main/features/project_tasks');
    expect(await reloaded.listTasks(UID, pid)).toEqual([expect.objectContaining({
      id: tid, content: 'Final requirements', status: 'done', origin_cid: second.cid,
    })]);
  });

  it.each([
    { mode: 'manual', scope: 'global' }, { mode: 'auto', scope: 'global' },
    { mode: 'manual', scope: 'project' }, { mode: 'auto', scope: 'project' },
  ])('dispatches an assigned $scope task through the selected agent for $mode processing', async ({ mode, scope }) => {
    const { pt, runner, groupChat, chats, projects } = await load();
    const agents = await import('../../../src/main/features/agents');
    const owner = await agents.createCustomAgent({ name: 'GlobalSpecialist' });
    if (!owner) throw new Error('agent fixture failed');
    const pid = scope === 'project' ? await seedProject(projects) : '';
    if (pid) await projects.addAgentBinding(UID, pid, owner.agent_id);
    const created = await pt.createTask(UID, pid, { content: 'Assigned work', owner_agent_id: owner.agent_id });
    if (!created.ok) throw new Error('task fixture failed');
    const run = () => mode === 'manual' ? runner.runTaskNow(UID, pid, created.task.id) : startAutomaticTask(runner, pid, created.task);
    const result = await run();
    expect(result.ok).toBe(true);
    expect(groupChat.setFloor).toHaveBeenCalledWith(UID, result.cid, owner.agent_id);
    expect(groupChat.send).toHaveBeenCalledWith(expect.objectContaining({ cid: result.cid, text: created.task.content }));
    expect(vi.mocked(groupChat.setFloor).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(groupChat.send).mock.invocationCallOrder[0]);
    expect(await pt.getTask(UID, pid, created.task.id)).toMatchObject({ owner_agent_id: owner.agent_id, status: 'progress', origin_cid: result.cid });

    // Losing the selected agent must not silently run the default assistant.
    await pt.updateTask(UID, pid, created.task.id, { status: 'todo' });
    vi.mocked(groupChat.setFloor).mockResolvedValueOnce({ ok: false, error: 'unknown agent' } as never);
    expect((await run()).ok).toBe(false);
    expect(groupChat.send).toHaveBeenCalledTimes(1);
    expect(chats.deleteConversation).toHaveBeenCalledWith(UID, 'c_2', pid || null);
    expect((await pt.getTask(UID, pid, created.task.id))?.status).toBe('todo');
    agents.setAgentEnabledForActiveUser(owner.agent_id, false);
    expect((await run()).ok).toBe(false);
    expect(groupChat.send).toHaveBeenCalledTimes(1);
    expect(chats.deleteConversation).toHaveBeenCalledWith(UID, 'c_3', pid || null);
    expect((await pt.getTask(UID, pid, created.task.id))?.status).toBe('todo');
  });
  it('processes a task again from review while preserving its brief and linking the latest execution', async () => {
    const { pt, runner, projects, groupChat } = await load();
    const pid = await seedProject(projects);
    const created = await pt.createTask(UID, pid, { content: 'Deliver and verify' });
    if (!created.ok) throw new Error('task fixture failed');
    await pt.uploadTaskAttachment(UID, pid, created.task.id, 'brief.txt', Buffer.from('Required delivery'));
    const first = await runner.runTaskNow(UID, pid, created.task.id);
    expect(first.ok).toBe(true);
    expect((await pt.getTask(UID, pid, created.task.id))?.status).toBe('progress');
    // These writes represent explicit executor tool updates after verification;
    // dispatching the conversation itself must not imply either outcome.
    expect((await pt.updateTask(UID, pid, created.task.id, { status: 'review' })).ok).toBe(true);
    const second = await runner.runTaskNow(UID, pid, created.task.id);
    expect(second.ok).toBe(true);
    expect(second.cid).not.toBe(first.cid);
    expect(await pt.getTask(UID, pid, created.task.id)).toMatchObject({
      status: 'review', origin_cid: second.cid,
    });
    expect(vi.mocked(groupChat.send).mock.calls.at(-1)?.[0]).toMatchObject({
      cid: second.cid, attachments: ['brief.txt'], model_text: expect.stringContaining('to done with todo_tasks'),
    });
    const { chatAttachmentDirForConversation } = await import('../../../src/main/util/project-layout');
    expect(fs.readFileSync(path.join(chatAttachmentDirForConversation(UID, second.cid!, pid), 'brief.txt'), 'utf8'))
      .toBe('Required delivery');
    expect((await pt.completeTask(UID, pid, created.task.id)).ok).toBe(true);
    const persisted = await pt.listTasks(UID, pid);
    expect(persisted).toEqual([expect.objectContaining({
      id: created.task.id, status: 'done', origin_cid: second.cid,
    })]);
    expect(pt.computeProgress(persisted)).toMatchObject({ done: 1, open: 0 });
    // Completed work cannot be dispatched or reopened by another run-now click.
    const sent = vi.mocked(groupChat.send).mock.calls.length;
    expect(await runner.runTaskNow(UID, pid, created.task.id)).toMatchObject({ ok: false, error: 'not_runnable' });
    expect(groupChat.send).toHaveBeenCalledTimes(sent);
    expect(await pt.listTasks(UID, pid)).toEqual(persisted);
  });

  it.each([
    { scope: 'project', competing: 'manual' },
    { scope: 'global', competing: 'manual' },
    { scope: 'project', competing: 'auto' },
    { scope: 'global', competing: 'auto' },
  ])('dispatches an assigned $scope task only once when a manual start overlaps $competing', async ({ scope, competing }) => {
    const { pt, runner, projects, chats, groupChat } = await load();
    const pid = scope === 'project' ? await seedProject(projects) : '';
    const agents = await import('../../../src/main/features/agents');
    const owner = pid ? { agent_id: AGENT } : await agents.createCustomAgent({ name: 'Owner' });
    if (!owner) throw new Error('agent fixture failed');
    const created = await pt.createTask(UID, pid, { content: 'One deliverable, one execution', owner_agent_id: owner.agent_id });
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
        : startAutomaticTask(runner, pid, created.task),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(groupChat.send).toHaveBeenCalledTimes(1);
    const winningCid = results.find((result) => result.ok)!.cid;
    expect(groupChat.setFloor).toHaveBeenCalledExactlyOnceWith(UID, winningCid, owner.agent_id);
    expect(await pt.getTask(UID, pid, created.task.id)).toMatchObject({
      status: 'progress', origin_cid: winningCid,
    });
    expect(chats.deleteConversation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chats.deleteConversation).mock.calls[0][1]).not.toBe(winningCid);
  });

  it.each(['project', 'global'])('can retry an unsent $scope task without losing its attachments', async (scope) => {
    const { pt, runner, projects, groupChat } = await load();
    const pid = scope === 'project' ? await seedProject(projects) : '';
    const created = await pt.createTask(UID, pid, { content: 'Retry with original brief' });
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
    const created = await pt.createTask(UID, pid, { content: 'Preserve the latest decision' });
    if (!created.ok) throw new Error('task fixture failed');
    vi.mocked(groupChat.send).mockImplementationOnce(async () => {
      expect((await pt.getTask(UID, pid, created.task.id))?.status).toBe('progress');
      expect((await pt.updateTask(UID, pid, created.task.id, { status })).ok).toBe(true);
      return { ok: false, error: 'send_failed' } as never;
    });
    expect((await runner.runTaskNow(UID, pid, created.task.id)).ok).toBe(false);
    expect(await pt.getTask(UID, pid, created.task.id)).toMatchObject({ status });
  });

  it('drives the whole backlog to progress and keeps advancing while conversations run', async () => {
    const { pt, drv, runner, projects } = await load();
    const pid = await seedProject(projects);
    await pt.createTask(UID, pid, { content: 'Design', owner_agent: 'Owner', owner_agent_id: AGENT });
    await pt.createTask(UID, pid, { content: 'Build' });
    await pt.createTask(UID, pid, { content: 'Ship' });
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
    const t1 = await pt.createTask(UID, pid, { content: 'Feature' });
    await pt.createTask(UID, pid, { content: 'Docs' });
    if (!t1.ok) throw new Error('seed');

    const changes: Array<{ uid: string; pid: string }> = [];
    pt.onTasksChanged((e: { uid: string; pid: string }) => changes.push(e));

    // Commander advances it, then a human review approves it.
    await pt.updateTask(UID, pid, t1.task.id, { status: 'progress' });
    await pt.updateTask(UID, pid, t1.task.id, { status: 'review' });
    const done = await pt.updateTask(UID, pid, t1.task.id, { status: 'done' });
    expect(done.ok).toBe(true);
    if (done.ok) {
      expect(done.task.status).toBe('done');
      expect(done.task.done_at).toBeTruthy();
      expect(done.task).not.toHaveProperty('result_ref');
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
    const t = await pt.createTask(UID, pid, { content: 'Analyze funnel', owner_agent: 'Owner', owner_agent_id: AGENT });
    if (!t.ok) throw new Error('seed');

    const res = await runner.runTaskNow(UID, pid, t.task.id);
    expect(res.ok).toBe(true);
    expect(res.cid).toBeTruthy();
    const after = await pt.getTask(UID, pid, t.task.id);
    expect(after?.status).toBe('progress');

    // Without an owner the same manual action routes through the project
    // commander, matching the automation-style run-now fallback.
    const bare = await pt.createTask(UID, pid, { content: 'no owner' });
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
    const t1 = await pt.createTask(UID, pid, { content: 'Brief', owner_agent: 'Owner', owner_agent_id: AGENT });
    if (!t1.ok) throw new Error('seed');
    await pt.uploadTaskAttachment(UID, pid, t1.task.id, 'brief.txt', Buffer.from('do X'));
    await pt.uploadTaskAttachment(UID, pid, t1.task.id, 'z-first.txt', Buffer.from('first'));
    await pt.updateTask(UID, pid, t1.task.id, { attachment_order: ['z-first.txt', 'brief.txt'] });
    const res = await runner.runTaskNow(UID, pid, t1.task.id);
    expect(res.ok).toBe(true);
    const runSend = vi.mocked(groupChat.send).mock.calls.at(-1)?.[0] as { attachments?: string[] };
    expect(runSend.attachments).toEqual(['z-first.txt', 'brief.txt']);
    // Resolve from the fresh module (paths pin the workspace root at load, so a
    // top-level import would use a stale root from before beforeEach ran).
    const { chatAttachmentDirForConversation } = await import('../../../src/main/util/project-layout');
    const dest = path.join(chatAttachmentDirForConversation(UID, String(res.cid), pid), 'brief.txt');
    expect(fs.readFileSync(dest, 'utf-8')).toBe('do X');

    // Driver advance carries them too (reads the task fresh, like the real loop).
    const t2 = await pt.createTask(UID, pid, { content: 'Spec', owner_agent_id: AGENT });
    if (!t2.ok) throw new Error('seed');
    await pt.uploadTaskAttachment(UID, pid, t2.task.id, 'spec.md', Buffer.from('# spec'));
    await pt.uploadTaskAttachment(UID, pid, t2.task.id, 'z-first.txt', Buffer.from('first'));
    await pt.updateTask(UID, pid, t2.task.id, { attachment_order: ['z-first.txt', 'spec.md'] });
    const fresh = await pt.getTask(UID, pid, t2.task.id);
    const adv = await startAutomaticTask(runner, pid, fresh!);
    expect(adv.ok).toBe(true);
    const advSend = vi.mocked(groupChat.send).mock.calls.at(-1)?.[0] as { attachments?: string[] };
    expect(advSend.attachments).toEqual(['z-first.txt', 'spec.md']);
  });
});
