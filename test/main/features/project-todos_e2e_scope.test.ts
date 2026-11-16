import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const uid = 'project-scope-user';
let root: string, previous: string | undefined;
let tools: Map<string, any>, cid: string;
const ctx = () => ({ workingDir: root, state: {} });
const call = async (name: string, input: unknown, context = ctx()) => {
  const raw = await tools.get(name).execute(input, context);
  return { raw, body: JSON.parse(raw.content) };
};
const setup = async (todos: string[] = []) => {
  const result = await call('project_setup', { action: 'create', name: 'Release work', todos });
  expect(result.body.ok).toBe(true);
  return result.body.project_id as string;
};
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-todo-e2e-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser(uid);
  const auth = await import('../../../src/main/features/auth');
  const profile = await auth.addApiKey('anthropic', 'synthetic-no-network-key', 'Fixture');
  await auth.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: profile.profileId });
  cid = (await (await import('../../../src/main/features/chats')).createConversation(uid, { title: 'Release work' })).conversation_id;
  const { buildRunner } = await import('../../../src/main/model/core-agent/runner');
  const built = await buildRunner({ sessionId: 'gconv-project-todo-scope', userId: uid, cid });
  tools = (built.runner as any).tools;
  expect((await call('tool_load', { groups: ['management.projects', 'management.todos'] })).raw.isError).toBeFalsy();
});
afterEach(async () => {
  await (await import('../../../src/main/features/search/indexer')).flushAll();
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

// Real buildRunner wiring, native/programmatic tools and stores; no model or GUI call.
it.each(['direct', 'programmatic'])('delivers initial and later project work through %s calls before filing, without global writes', async route => {
  const tasks = await import('../../../src/main/features/project_tasks');
  const chats = await import('../../../src/main/features/chats');
  const filing = await import('../../../src/main/features/conversation_filing');
  const pid = await setup(['Check release']);
  expect((await chats.getConversationMetadata(uid, cid))?.project_id).toBeFalsy();
  if (route === 'programmatic') {
    const receipt = await tools.get('run_program').execute({ code: 'const r = await tools.todo_tasks({action:"create",content:"Publish notes"}); json(r);' }, ctx());
    expect(receipt.isError).toBeFalsy();
    expect(receipt.content).toContain('task_created');
  } else expect((await call('todo_tasks', { action: 'create', content: 'Publish notes' })).body.ok).toBe(true);
  const later = (await tasks.listTasks(uid, pid)).find(t => t.content === 'Publish notes');
  expect(later).toBeDefined();
  expect(await tasks.listTasks(uid, '')).toEqual([]);
  expect((await call('todo_tasks', { action: 'create', content: 'Publish notes' })).body.outcome).toBe('existing_task_reused');
  expect((await call('todo_tasks', { action: 'update', task_id: later!.id, status: 'review' })).body.ok).toBe(true);
  expect((await call('todo_tasks', { action: 'get', project: pid, task_id: later!.id })).body.task.status).toBe('review');
  expect((await call('todo_tasks', { action: 'complete', task_id: later!.id })).body.ok).toBe(true);
  await filing.drainConversationFiling(uid, cid);
  expect((await chats.getConversationMetadata(uid, cid))?.project_id).toBe(pid);
  expect((await tasks.listTasks(uid, pid)).map(t => t.content).sort()).toEqual(['Check release', 'Publish notes']);
  expect(await tasks.listTasks(uid, '')).toEqual([]);
});

it('honors explicit global operations before and after setup while keeping global task IDs out of the new default', async () => {
  const tasks = await import('../../../src/main/features/project_tasks');
  const global = (await call('todo_tasks', { action: 'create', content: 'Personal work' })).body.task;
  const pid = await setup();
  expect((await call('todo_tasks', { action: 'create', content: 'Project work' })).body.ok).toBe(true);
  const rejected = await call('todo_tasks', { action: 'complete', task_id: global.id });
  expect(rejected.raw.isError).toBe(true);
  expect((await tasks.getTask(uid, '', global.id))?.status).toBe('todo');
  expect((await call('todo_tasks', { action: 'complete', project: '__global__', task_id: global.id })).body.ok).toBe(true);
  expect((await call('todo_tasks', { action: 'create', project: '__global__', content: 'Another personal item' })).body.ok).toBe(true);
  const globalProgram = await tools.get('run_program').execute({ code: 'json(await tools.todo_tasks({action:"create",project:"__global__",content:"Programmatic personal item"}));' }, ctx());
  expect(globalProgram.isError).toBeFalsy();
  expect((await tasks.listTasks(uid, pid)).map(t => t.content)).toEqual(['Project work']);
  expect((await tasks.listTasks(uid, '')).map(t => t.content).sort()).toEqual(['Another personal item', 'Personal work', 'Programmatic personal item']);
});

it.each(['foreign-project', 'other-conversation', 'deleted', 'owner-changed', 'account-changed', 'cancelled'])('rejects %s without creating project or global tasks', async failure => {
  const tasks = await import('../../../src/main/features/project_tasks');
  const projects = await import('../../../src/main/features/projects');
  const filing = await import('../../../src/main/features/conversation_filing');
  const pid = await setup();
  let project: string | undefined;
  let context: any = ctx();
  if (failure === 'foreign-project') {
    const other = await projects.createProject(uid, 'Unrelated');
    if (!other.ok) throw new Error('fixture failed');
    project = other.project.project_id;
  }
  if (failure === 'other-conversation') {
    const { buildRunner } = await import('../../../src/main/model/core-agent/runner');
    const otherCid = (await (await import('../../../src/main/features/chats')).createConversation(uid, { title: 'Other work' })).conversation_id;
    tools = ((await buildRunner({ sessionId: 'gconv-other-todo-scope', userId: uid, cid: otherCid })).runner as any).tools;
    project = pid;
  }
  if (['deleted', 'owner-changed'].includes(failure)) {
    const { projectMetaFile } = await import('../../../src/main/paths');
    const file = projectMetaFile(uid, pid);
    if (failure === 'deleted') fs.unlinkSync(file);
    else {
      // Public projects derive ownership from their local user root. Exercise the
      // resolver's foreign-owner refusal without inventing shared metadata.
      const read = projects.getProject;
      vi.spyOn(projects, 'getProject').mockImplementation(async (...args) => {
        const project = await read(...args);
        return args[1] === pid && project ? { ...project, owner_uid: 'other-account' } : project;
      });
    }
  }
  if (failure === 'account-changed') (await import('../../../src/main/features/users')).activateUser('other-account');
  if (failure === 'cancelled') {
    const abort = new AbortController(); abort.abort(); context.signal = abort.signal;
    await filing.drainConversationFiling(uid, cid, true);
  }
  expect((await call('todo_tasks', { action: 'create', content: 'Must not be written', ...(project ? { project } : {}) }, context)).raw.isError).toBe(true);
  expect(await tasks.listTasks(uid, '')).toEqual([]);
  if (!['deleted'].includes(failure)) expect(await tasks.listTasks(uid, pid)).toEqual([]);
});

it('retains saved project work on filing failure and refuses stale calls instead of falling back to global', async () => {
  const tasks = await import('../../../src/main/features/project_tasks');
  const chats = await import('../../../src/main/features/chats');
  const filing = await import('../../../src/main/features/conversation_filing');
  const pid = await setup();
  expect((await call('todo_tasks', { action: 'create', content: 'Saved work' })).body.ok).toBe(true);
  vi.spyOn(chats, 'moveConversationToProject').mockResolvedValueOnce({ ok: false, error: 'move_failed' });
  await filing.drainConversationFiling(uid, cid);
  expect((await call('todo_tasks', { action: 'create', content: 'Stale work' })).raw.isError).toBe(true);
  expect((await tasks.listTasks(uid, pid)).map(t => t.content)).toEqual(['Saved work']);
  expect(await tasks.listTasks(uid, '')).toEqual([]);
});

it('keeps later tasks and scoped attachments in the renamed new project, and deletes from that same target', async () => {
  const tasks = await import('../../../src/main/features/project_tasks');
  const pid = await setup();
  expect((await call('project_setup', { action: 'rename', name: 'Approved release' })).body.project_id).toBe(pid);
  const created = (await call('todo_tasks', { action: 'create', content: 'Review notes' })).body;
  expect(created.project).toEqual({ project_id: pid, name: 'Approved release' });
  const workspace = (await import('../../../src/main/features/user_workspace')).getWorkspacePath(uid);
  fs.mkdirSync(workspace, { recursive: true });
  const source = path.join(workspace, 'notes.txt'); fs.writeFileSync(source, 'Synthetic release notes');
  expect((await call('todo_tasks', { action: 'add_attachment', task_id: created.task.id, source_path: source })).body.task.attachments).toEqual(['notes.txt']);
  expect((await call('todo_tasks', { action: 'list' })).body.tasks).toContainEqual(expect.objectContaining({ id: created.task.id }));
  expect((await call('todo_tasks', { action: 'delete', task_id: created.task.id })).body.deleted).toBe(true);
  expect(await tasks.listTasks(uid, pid)).toEqual([]);
  expect(await tasks.listTasks(uid, '')).toEqual([]);
});

it('rejects malformed targets and invalid writes without falling back to another backlog', async () => {
  const tasks = await import('../../../src/main/features/project_tasks');
  const pid = await setup();
  for (const project of [null, 42, {}, '', ' ']) {
    expect((await call('todo_tasks', { action: 'create', project, content: 'Wrong' })).raw.isError).toBe(true);
  }
  for (const content of ['', 'x'.repeat(4001)]) {
    expect((await call('todo_tasks', { action: 'create', content })).raw.isError).toBe(true);
  }
  expect(await tasks.listTasks(uid, pid)).toEqual([]);
  expect(await tasks.listTasks(uid, '')).toEqual([]);
});

it('does not grant an existing-project move the new-project exception, and a failed setup leaves explicit global work usable', async () => {
  const projects = await import('../../../src/main/features/projects');
  const tasks = await import('../../../src/main/features/project_tasks');
  expect((await call('project_setup', { action: 'create' })).raw.isError).toBe(true);
  const target = await projects.createProject(uid, 'Existing project');
  if (!target.ok) throw new Error('fixture failed');
  expect((await call('project_setup', { action: 'move_conversation', target_project: target.project.project_id })).body.ok).toBe(true);
  expect((await call('todo_tasks', { action: 'create', project: target.project.project_id, content: 'Denied' })).raw.isError).toBe(true);
  expect((await call('todo_tasks', { action: 'create', project: '__global__', content: 'Personal' })).body.ok).toBe(true);
  expect(await tasks.listTasks(uid, target.project.project_id)).toEqual([]);
  expect((await tasks.listTasks(uid, '')).map(t => t.content)).toEqual(['Personal']);
});

it('stops a write when deferred creation is cancelled during target validation', async () => {
  const projects = await import('../../../src/main/features/projects');
  const tasks = await import('../../../src/main/features/project_tasks');
  const filing = await import('../../../src/main/features/conversation_filing');
  const pid = await setup();
  const read = projects.getProject;
  vi.spyOn(projects, 'getProject').mockImplementationOnce(async (...args) => {
    const project = await read(...args);
    await filing.drainConversationFiling(uid, cid, true);
    return project;
  });
  expect((await call('todo_tasks', { action: 'create', content: 'Cancelled work' })).raw.isError).toBe(true);
  expect((await call('todo_tasks', { action: 'create', content: 'Stale work' })).raw.isError).toBe(true);
  expect(await tasks.listTasks(uid, pid)).toEqual([]);
  expect(await tasks.listTasks(uid, '')).toEqual([]);
});

it.each(['update', 'delete', 'add_attachment'])('stops %s when its scope is cancelled during asynchronous preparation', async action => {
  const tasks = await import('../../../src/main/features/project_tasks');
  const filing = await import('../../../src/main/features/conversation_filing');
  const pid = await setup();
  const created = (await call('todo_tasks', { action: 'create', content: 'Keep original work' })).body.task;
  const workspace = (await import('../../../src/main/features/user_workspace')).getWorkspacePath(uid);
  fs.mkdirSync(workspace, { recursive: true });
  const source = path.join(workspace, 'cancelled.txt'); fs.writeFileSync(source, 'Do not copy');
  const read = tasks.getTask;
  vi.spyOn(tasks, 'getTask').mockImplementationOnce(async (...args) => {
    const task = await read(...args);
    await filing.drainConversationFiling(uid, cid, true);
    return task;
  });
  const result = await call('todo_tasks', { action, task_id: created.id,
    ...(action === 'update' ? { status: 'done' } : {}),
    ...(action === 'add_attachment' ? { source_path: source } : {}),
  });
  expect(result.raw.isError).toBe(true);
  expect(await tasks.getTask(uid, pid, created.id)).toMatchObject({ content: 'Keep original work', status: 'todo' });
  expect(await tasks.listTaskAttachments(uid, pid, created.id)).toEqual([]);
  expect(await tasks.listTasks(uid, '')).toEqual([]);
  expect((await call('todo_tasks', { action: 'create', project: '__global__', content: 'Explicit personal work' })).body.ok).toBe(true);
  expect((await tasks.listTasks(uid, '')).map(t => t.content)).toEqual(['Explicit personal work']);
});

it.each(['update', 'complete', 'delete', 'add_attachment'])('keeps task bytes when %s is queued behind a write and its creation scope is then cancelled', async action => {
  const tasks = await import('../../../src/main/features/project_tasks');
  const filing = await import('../../../src/main/features/conversation_filing');
  const paths = await import('../../../src/main/paths');
  const pid = await setup();
  const created = (await call('todo_tasks', { action: 'create', content: 'Original reviewed work' })).body.task;
  const workspace = (await import('../../../src/main/features/user_workspace')).getWorkspacePath(uid);
  fs.mkdirSync(workspace, { recursive: true });
  const source = path.join(workspace, 'queued.txt'); fs.writeFileSync(source, 'Do not copy after cancellation');
  let release!: () => void;
  const held = new Promise<void>(r => { release = r; });
  const filename = paths.projectTaskFile(uid, pid, created.id);
  const storage = await import('../../../src/main/storage');
  const originalRead = storage.readJson;
  let holding = false;
  vi.spyOn(storage, 'readJson').mockImplementation(async (...args: any[]) => {
    if (!holding && String(args[0]) === filename) { holding = true; await held; }
    return (originalRead as any)(...args);
  });
  // The first real store update owns its task mutex while its read is held.
  const holder = tasks.updateTask(uid, pid, created.id, { content: 'Keep the independent update' });
  let pending: ReturnType<typeof call>;
  try {
  await expect.poll(() => holding, { timeout: 3000 }).toBe(true);
  const method = action === 'add_attachment' ? 'uploadTaskAttachment' : action === 'delete' ? 'deleteTask' : 'updateTask';
  let didQueue = false;
  const originalWrite = tasks[method];
  vi.spyOn(tasks, method as any).mockImplementation((...args: any[]) => {
    const result = (originalWrite as any)(...args); didQueue = true; return result;
  });
  pending = call('todo_tasks', { action, task_id: created.id,
    ...(action === 'update' ? { status: 'done' } : {}),
    ...(action === 'add_attachment' ? { source_path: source } : {}),
  });
  await expect.poll(() => didQueue, { timeout: 3000 }).toBe(true);
  await filing.drainConversationFiling(uid, cid, true);
  } finally { release(); }
  expect((await holder).ok).toBe(true);
  expect((await pending).raw.isError).toBe(true);
  expect(await tasks.getTask(uid, pid, created.id)).toMatchObject({ content: 'Keep the independent update', status: 'todo' });
  expect(await tasks.listTaskAttachments(uid, pid, created.id)).toEqual([]);
  expect(await tasks.listTasks(uid, '')).toEqual([]);
});

it('keeps a cancelled project empty when creation scope changes during the store existence read', async () => {
  const tasks = await import('../../../src/main/features/project_tasks');
  const filing = await import('../../../src/main/features/conversation_filing');
  const projects = await import('../../../src/main/features/projects');
  const pid = await setup();
  vi.spyOn(projects, 'projectExists').mockImplementationOnce(async () => {
    await filing.drainConversationFiling(uid, cid, true);
    return true;
  });
  expect((await call('todo_tasks', { action: 'create', content: 'Do not save after cancellation' })).raw.isError).toBe(true);
  expect(await tasks.listTasks(uid, pid)).toEqual([]);
  expect(await tasks.listTasks(uid, '')).toEqual([]);
});
