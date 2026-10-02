/**
 * `project_setup`: the model-visible contract for giving this conversation's
 * work a project.
 *
 * The composition and the relocation are covered by conversation-filing and
 * chats-move-to-project. What only this layer can get wrong is what the model
 * is told and where the work lands: to-dos written into the account-wide backlog
 * instead of the new project would be invisible where the user was told to look,
 * and a receipt naming a project that was silently suffixed would make the reply
 * wrong. Both actions also have opposite preconditions, and neither can move the
 * conversation from inside the turn that calls it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../../src/main/features/agents', () => ({
  getAgent: async () => undefined,
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u-project-setup';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-setup-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  await (await import('../../../src/main/features/search/indexer')).flushAll();
  vi.restoreAllMocks();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function tool(cid: string, projectId: string | null = null) {
  const { createProjectSetupTool } = await import('../../../src/main/features/project_setup_tool');
  return createProjectSetupTool({ userId: UID, cid, projectId });
}

async function call(cid: string, input: unknown, projectId: string | null = null) {
  const executor = await tool(cid, projectId);
  const result = await executor.execute(input as never, {} as never);
  return { raw: result, body: JSON.parse(result.content as string) };
}

describe('project_setup › create', () => {
  it.each([false, true])('reports retained setup after filing fails and retries into the same project (with todos=%s)', async (withTodos) => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const tasks = await import('../../../src/main/features/project_tasks');
    const filing = await import('../../../src/main/features/conversation_filing');
    await projects.createProject(UID, 'Weekly report');
    const conv = await chats.createConversation(UID, { title: 'file after reply' });
    const cid = conv.conversation_id;
    const messages = path.join(tmpDir, UID, 'cloud', 'chats', `${cid}.jsonl`);
    fs.writeFileSync(messages, '{"from":"user","text":"weekly report"}\n');
    const failures: unknown[] = [];
    const successes = vi.fn();
    filing.onConversationFilingFailed((event) => failures.push(event));
    filing.onConversationFiled(successes);
    // One requested todo cannot be persisted. The failure receipt must count
    // successful writes, not the requested backlog or the existing project.
    if (withTodos) vi.spyOn(tasks, 'createTask').mockResolvedValueOnce({ ok: false, error: 'write_failed' } as never);
    const { body } = await call(cid, {
      action: 'create', name: 'Weekly report',
      ...(withTodos ? { todos: ['Unwritten item', 'Retained item'] } : {}),
    });
    const pid = body.project_id;
    const beforeTasks = await tasks.listTasks(UID, pid);
    expect(beforeTasks.map((task) => task.content)).toEqual(withTodos ? ['Retained item'] : []);
    // Exercise the actual relocation rollback: an existing destination cannot
    // be overwritten. Removing this obstacle makes the normal menu move legal.
    const obstacle = path.join(tmpDir, UID, 'cloud', 'projects', pid, 'chats', `${cid}.jsonl`);
    fs.mkdirSync(path.dirname(obstacle), { recursive: true });
    fs.writeFileSync(obstacle, 'destination must survive');
    await filing.drainConversationFiling(UID, cid);

    expect(failures).toEqual([{
      userId: UID, cid, projectId: pid, projectName: 'Weekly report 2', todosCreated: withTodos ? 1 : 0,
    }]);
    expect(successes).not.toHaveBeenCalled();
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBeFalsy();
    expect(fs.readFileSync(messages, 'utf8')).toBe('{"from":"user","text":"weekly report"}\n');
    expect(fs.readFileSync(obstacle, 'utf8')).toBe('destination must survive');
    expect((await projects.listProjects(UID)).map((p) => p.name).sort()).toEqual(['Weekly report', 'Weekly report 2']);
    expect(await tasks.listTasks(UID, pid)).toEqual(beforeTasks);
    await filing.drainConversationFiling(UID, cid);
    expect(failures).toHaveLength(1);
    expect(filing.hasPendingConversationFiling(UID, cid)).toBe(false);

    fs.unlinkSync(obstacle);
    expect((await chats.moveConversationToProject(UID, cid, pid)).ok).toBe(true);
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBe(pid);
    expect((await projects.listProjects(UID))).toHaveLength(2);
    expect(await tasks.listTasks(UID, pid)).toEqual(beforeTasks);
    expect(fs.readFileSync(obstacle, 'utf8')).toBe('{"from":"user","text":"weekly report"}\n');
  });

  it.each([false, true])('does not show a filing failure on success or cancellation (cancelled=%s)', async (cancelled) => {
    const chats = await import('../../../src/main/features/chats');
    const filing = await import('../../../src/main/features/conversation_filing');
    const failures = vi.fn();
    filing.onConversationFilingFailed(failures);
    const conv = await chats.createConversation(UID, { title: 'normal terminal' });
    const { body } = await call(conv.conversation_id, { action: 'create', name: 'Normal' });
    await filing.drainConversationFiling(UID, conv.conversation_id, cancelled);
    expect(failures).not.toHaveBeenCalled();
    expect((await chats.getConversationMetadata(UID, conv.conversation_id))?.project_id || '')
      .toBe(cancelled ? '' : body.project_id);
  });

  it('opens the new project with the to-dos it was given, not the account backlog', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projectTasks = await import('../../../src/main/features/project_tasks');
    const conv = await chats.createConversation(UID, { title: 'competitor watch' });
    const cid = conv.conversation_id;

    const { body } = await call(cid, {
      action: 'create',
      name: 'Competitor tracking',
      todos: ['List the competitors worth watching', 'Agree the weekly check scope'],
    });

    expect(body.ok).toBe(true);
    expect(body.todos_created).toBe(2);
    expect(body.applies).toBe('when_this_turn_ends');
    // In the project the user was told about, not the global backlog they were not.
    const inProject = await projectTasks.listTasks(UID, body.project_id);
    expect(inProject.map((task) => task.content).sort())
      .toEqual(['Agree the weekly check scope', 'List the competitors worth watching']);
    expect(await projectTasks.listTasks(UID, '')).toEqual([]);
  });

  it('reports the name the project actually got after a duplicate was suffixed', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    await projects.createProject(UID, 'Weekly report');
    const conv = await chats.createConversation(UID, { title: 'second weekly' });

    const { body } = await call(conv.conversation_id, { action: 'create', name: 'Weekly report' });

    // A reply that named the project the model asked for would be wrong.
    expect(body.ok).toBe(true);
    expect(body.project_name).toBe('Weekly report 2');
    const named = (await projects.listProjects(UID)).find((p) => p.project_id === body.project_id);
    expect(named?.name).toBe('Weekly report 2');
  });

  it('leaves the conversation where it is until the turn ends', async () => {
    const chats = await import('../../../src/main/features/chats');
    const conv = await chats.createConversation(UID, { title: 'mid-turn' });
    const cid = conv.conversation_id;

    const { body } = await call(cid, { action: 'create', name: 'Deferred' });

    expect(body.ok).toBe(true);
    // The relocation refuses while this turn holds the session files open, so
    // the tool must not claim the conversation already moved.
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBeFalsy();
    const filing = await import('../../../src/main/features/conversation_filing');
    expect(filing.hasPendingConversationFiling(UID, cid)).toBe(true);
  });

  it('refuses a conversation that already has a project without creating one', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const created = await projects.createProject(UID, 'Existing');
    const pid = (created as { project: any }).project.project_id;
    const conv = await chats.createConversation(UID, { title: 'already filed' });
    expect((await chats.moveConversationToProject(UID, conv.conversation_id, pid)).ok).toBe(true);

    const { raw, body } = await call(conv.conversation_id, { action: 'create', name: 'Second home' }, pid);

    expect({ isError: raw.isError, ok: body.ok, error: body.error })
      .toEqual({ isError: true, ok: false, error: 'already_in_project' });
    expect((await projects.listProjects(UID)).map((p) => p.name)).toEqual(['Existing']);
  });

  it('names the missing field instead of creating a project without one', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const conv = await chats.createConversation(UID, { title: 'nameless' });

    const { raw, body } = await call(conv.conversation_id, { action: 'create' });

    expect(raw.isError).toBe(true);
    expect(body.error).toContain('name');
    expect(await projects.listProjects(UID)).toEqual([]);
  });

  it('rejects an unbounded initial backlog before writing anything', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const conv = await chats.createConversation(UID, { title: 'too many' });

    const { raw, body } = await call(conv.conversation_id, {
      action: 'create',
      name: 'Bounded',
      todos: Array.from({ length: 11 }, (_unused, index) => `item ${index}`),
    });

    expect(raw.isError).toBe(true);
    expect(body.ok).toBe(false);
    expect(await projects.listProjects(UID)).toEqual([]);
  });
});

describe('project_setup › unfile', () => {
  it('queues the undo for the end of the turn', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    const created = await projects.createProject(UID, 'Filed here');
    const pid = (created as { project: any }).project.project_id;
    const conv = await chats.createConversation(UID, { title: 'undo me' });
    const cid = conv.conversation_id;
    expect((await chats.moveConversationToProject(UID, cid, pid)).ok).toBe(true);

    const { body } = await call(cid, { action: 'unfile' }, pid);

    expect(body).toMatchObject({ ok: true, action: 'unfile', left_project_id: pid, applies: 'when_this_turn_ends' });
    // Undoing moves the same bytes, so it cannot happen inside this turn either.
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBe(pid);
    expect(filing.hasPendingConversationFiling(UID, cid)).toBe(true);
  });

  it('refuses a conversation that is not in a project', async () => {
    const chats = await import('../../../src/main/features/chats');
    const filing = await import('../../../src/main/features/conversation_filing');
    const conv = await chats.createConversation(UID, { title: 'never filed' });

    const { raw, body } = await call(conv.conversation_id, { action: 'unfile' });

    expect({ isError: raw.isError, error: body.error }).toEqual({ isError: true, error: 'not_in_project' });
    expect(filing.hasPendingConversationFiling(UID, conv.conversation_id)).toBe(false);
  });

  it('reports the create-only fields it ignored', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const created = await projects.createProject(UID, 'Filed here');
    const pid = (created as { project: any }).project.project_id;
    const conv = await chats.createConversation(UID, { title: 'undo with extras' });
    expect((await chats.moveConversationToProject(UID, conv.conversation_id, pid)).ok).toBe(true);

    const { body } = await call(conv.conversation_id, { action: 'unfile', name: 'ignored' }, pid);

    expect(body.ok).toBe(true);
    expect(body.ignored_fields).toEqual(['name']);
  });
});
