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
    // The first to-do is this conversation's next step, so opening or running
    // it returns here; the rest of the backlog links on its first run.
    expect(inProject.find((task) => task.content === 'List the competitors worth watching'))
      .toMatchObject({ origin_cid: cid });
    expect(inProject.find((task) => task.content === 'Agree the weekly check scope'))
      .not.toHaveProperty('origin_cid');
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

  it('keeps project creation, already-filed refusal and unfiling independently recoverable', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const conv = await chats.createConversation(UID, { title: 'project recovery' });
    const created = await call(conv.conversation_id, { action: 'create', name: 'Launch plan', todos: ['Draft the brief'] });
    expect(created.body.ok).toBe(true);

    const existing = await projects.createProject(UID, 'Existing');
    const filed = await chats.createConversation(UID, { title: 'already filed' });
    const pid = (existing as { project: { project_id: string } }).project.project_id;
    expect((await chats.moveConversationToProject(UID, filed.conversation_id, pid)).ok).toBe(true);
    const refused = await call(filed.conversation_id, { action: 'create', name: 'Second home' }, pid);
    expect(refused.body).toMatchObject({ ok: false, error: 'already_in_project' });
    // Validation errors and undoing are not creations.
    await call(conv.conversation_id, { action: 'create' });
    await call(conv.conversation_id, { action: 'remove_conversation' });

    expect(await projects.listProjects(UID)).toHaveLength(2);
  });

  it('saves the goal it is given as the project instructions every conversation receives, and refuses an unbounded one', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const changed: string[] = [];
    projects.onProjectInstructionsChanged((event) => { changed.push(`${event.uid}:${event.projectId}`); });
    const conv = await chats.createConversation(UID, { title: 'goal' });
    const { body } = await call(conv.conversation_id, {
      action: 'create', name: 'Launch plan', todos: ['Draft the brief'],
      goal: '  三个月内把 Lumen 的上线邮件、定价页和发布会物料全部准备好。  ',
    });
    expect(body.ok).toBe(true);
    expect(body.goal_saved).toBe(true);
    // The rail and the open project page learn about the write from the host.
    expect(await projects.readProjectInstructions(UID, body.project_id))
      .toMatchObject({ ok: true, content: '三个月内把 Lumen 的上线邮件、定价页和发布会物料全部准备好。' });
    expect(changed).toEqual([`${UID}:${body.project_id}`]);

    // No goal means no instructions, not an empty placeholder.
    const plain = await chats.createConversation(UID, { title: 'plain' });
    const noGoal = await call(plain.conversation_id, { action: 'create', name: 'Plain' });
    expect(noGoal.body.ok).toBe(true);
    expect(noGoal.body).not.toHaveProperty('goal_saved');
    expect((await projects.readProjectInstructions(UID, noGoal.body.project_id) as { content?: string }).content || '').toBe('');

    // A goal past the bound is refused before any project exists.
    const over = await chats.createConversation(UID, { title: 'over' });
    const refused = await call(over.conversation_id, { action: 'create', name: 'Too long', goal: 'x'.repeat(401) });
    expect(refused.raw.isError).toBe(true);
    expect((await projects.listProjects(UID)).map((project) => project.name)).not.toContain('Too long');
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

describe('project_setup › remove_conversation', () => {
  it('queues the undo for the end of the turn', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    const created = await projects.createProject(UID, 'Filed here');
    const pid = (created as { project: any }).project.project_id;
    const conv = await chats.createConversation(UID, { title: 'undo me' });
    const cid = conv.conversation_id;
    expect((await chats.moveConversationToProject(UID, cid, pid)).ok).toBe(true);

    const { body } = await call(cid, { action: 'remove_conversation' }, pid);

    expect(body).toMatchObject({ ok: true, action: 'remove_conversation', left_project_id: pid, applies: 'when_this_turn_ends' });
    // Undoing moves the same bytes, so it cannot happen inside this turn either.
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBe(pid);
    expect(filing.hasPendingConversationFiling(UID, cid)).toBe(true);
  });

  it('refuses a conversation that is not in a project', async () => {
    const chats = await import('../../../src/main/features/chats');
    const filing = await import('../../../src/main/features/conversation_filing');
    const conv = await chats.createConversation(UID, { title: 'never filed' });

    const { raw, body } = await call(conv.conversation_id, { action: 'remove_conversation' });

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

    const { body } = await call(conv.conversation_id, { action: 'remove_conversation', name: 'ignored' }, pid);

    expect(body.ok).toBe(true);
    expect(body.ignored_fields).toEqual(['name']);
  });
});

describe('project_setup › move_conversation', () => {
  async function fixture() {
    const projects = await import('../../../src/main/features/projects');
    const chats = await import('../../../src/main/features/chats');
    const filing = await import('../../../src/main/features/conversation_filing');
    const created = await projects.createProject(UID, 'Aurora 发布计划');
    if (!created.ok) throw new Error('project setup failed');
    const conv = await chats.createConversation(UID, { title: 'Existing project target' });
    return { projects, chats, filing, pid: created.project.project_id, cid: conv.conversation_id };
  }

  it.each(['name', 'id'])('moves the same conversation and bytes into an existing project by %s without modifying its resources', async selector => {
    const { projects, chats, filing, pid, cid } = await fixture();
    const tasks = await import('../../../src/main/features/project_tasks');
    await projects.writeProjectInstructions(UID, pid, 'Keep the standing goal');
    await tasks.createTask(UID, pid, { content: 'Keep the original backlog' });
    const projectBefore = await projects.getProject(UID, pid);
    const tasksBefore = await tasks.listTasks(UID, pid);
    const bindingsBefore = await projects.resolveProjectScope(UID, pid);
    const source = path.join(tmpDir, UID, 'cloud', 'chats', `${cid}.jsonl`);
    fs.writeFileSync(source, '{"from":"user","text":"keep this history"}\n');
    const input = { action: 'move_conversation', target_project: selector === 'name' ? 'Aurora 发布计划' : pid };
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await call(cid, input)).body).toMatchObject({ ok: true, action: 'move_conversation', project_id: pid, applies: 'when_this_turn_ends' });
    }
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBeFalsy();
    // A conflicting operation cannot replace the reserved destination.
    expect((await call(cid, { action: 'remove_conversation' })).raw.isError).toBe(true);
    expect((await call(cid, { action: 'create', name: 'Unrequested project' })).raw.isError).toBe(true);
    await filing.drainConversationFiling(UID, cid);
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBe(pid);
    expect(fs.readFileSync(path.join(tmpDir, UID, 'cloud', 'projects', pid, 'chats', `${cid}.jsonl`), 'utf8'))
      .toBe('{"from":"user","text":"keep this history"}\n');
    expect(await projects.listProjectIds(UID)).toEqual([pid]);
    expect(await projects.getProject(UID, pid)).toEqual(projectBefore);
    expect(await tasks.listTasks(UID, pid)).toEqual(tasksBefore);
    expect(await projects.resolveProjectScope(UID, pid)).toEqual(bindingsBefore);
    expect((await projects.readProjectInstructions(UID, pid) as any).content).toBe('Keep the standing goal');
    expect((await call(cid, input, pid)).body).toMatchObject({ ok: true, applies: 'now', project_id: pid });
  });

  it('advertises current movement/removal and rejects the retired unfile action', async () => {
    const { cid, pid, chats, filing } = await fixture();
    const schema = (await tool(cid)).inputSchema as any;
    expect(schema.properties.action.enum).toEqual(['create', 'rename', 'move_conversation', 'remove_conversation']);
    expect(schema.properties.target_project.description).toMatch(/exact.*name|name.*exact/i);
    expect((await call(cid, { action: 'move_conversation' })).raw.isError).toBe(true);
    expect((await call(cid, { action: 'unfile' }, pid)).raw.isError).toBe(true);
    await chats.moveConversationToProject(UID, cid, pid);
    expect((await call(cid, { action: 'remove_conversation' }, pid)).body)
      .toMatchObject({ ok: true, action: 'remove_conversation', applies: 'when_this_turn_ends' });
    await filing.drainConversationFiling(UID, cid);
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBeFalsy();
    expect(await (await import('../../../src/main/features/projects')).listProjectIds(UID)).toEqual([pid]);
  });

  it('reserves removal before metadata reads so concurrent moves cannot replace its destination', async () => {
    const { cid, pid, chats, filing } = await fixture();
    await chats.moveConversationToProject(UID, cid, pid);
    const original = chats.getConversationMetadata;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(chats, 'getConversationMetadata').mockImplementationOnce(async (...args) => {
      entered();
      await gate;
      return original(...args);
    });
    const removal = call(cid, { action: 'remove_conversation' }, pid);
    await reading;
    const competing = await call(cid, { action: 'move_conversation', target_project: pid });
    release();
    expect((await removal).body.ok).toBe(true);
    expect(competing.body).toMatchObject({ ok: false, error: 'relocation_pending' });
    await filing.drainConversationFiling(UID, cid);
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBeFalsy();
  });

  it.each(['create', 'rename', 'remove_conversation'])('rejects a destination on %s without silently performing a different mutation', async action => {
    const { cid, pid, projects, filing, chats } = await fixture();
    expect((await call(cid, { action, target_project: pid, name: 'Unexpected project' })).raw.isError).toBe(true);
    expect(await projects.listProjectIds(UID)).toEqual([pid]);
    expect((await projects.getProject(UID, pid))?.name).toBe('Aurora 发布计划');
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBeFalsy();
    expect(filing.hasPendingConversationFiling(UID, cid)).toBe(false);
  });

  it.each(['missing', 'foreign', 'ambiguous', 'other-project'])('rejects %s without creating or moving anything', async failure => {
    const { projects, chats, filing, pid, cid } = await fixture();
    const paths = await import('../../../src/main/paths');
    let target = 'Aurora 发布计划';
    if (failure === 'missing') target = 'No such project';
    if (failure === 'foreign') {
      const foreign = await projects.createProject('other-account', 'Foreign target');
      if (!foreign.ok) throw new Error('foreign setup failed');
      target = foreign.project.project_id;
    }
    if (failure === 'ambiguous') vi.spyOn(projects, 'listProjectNameRows').mockResolvedValue([
      { project_id: pid, name: target }, { project_id: 'p_another', name: target },
    ]);
    if (failure === 'other-project') {
      const other = await projects.createProject(UID, 'Already filed');
      if (!other.ok) throw new Error('project setup failed');
      await chats.moveConversationToProject(UID, cid, other.project.project_id);
    }
    const before = await chats.getConversationMetadata(UID, cid);
    const ids = await projects.listProjectIds(UID);
    const result = await call(cid, { action: 'move_conversation', target_project: target });
    expect(result.raw.isError).toBe(true);
    expect(result.body.error).toBe({ missing: 'project_not_found', foreign: 'project_not_found', ambiguous: 'project_ambiguous', 'other-project': 'already_in_project' }[failure]);
    expect(await chats.getConversationMetadata(UID, cid)).toEqual(before);
    expect(await projects.listProjectIds(UID)).toEqual(ids);
    expect(filing.hasPendingConversationFiling(UID, cid)).toBe(false);
  });

  it.each(['cancel', 'deleted', 'collision'])('preserves the conversation when pending movement encounters %s', async failure => {
    const { projects, chats, filing, pid, cid } = await fixture();
    const failed = vi.fn(); filing.onConversationFilingFailed(failed);
    const source = path.join(tmpDir, UID, 'cloud', 'chats', `${cid}.jsonl`);
    fs.writeFileSync(source, 'source bytes\n');
    expect((await call(cid, { action: 'move_conversation', target_project: pid })).body.ok).toBe(true);
    const paths = await import('../../../src/main/paths');
    if (failure === 'deleted') fs.rmSync(path.dirname(paths.projectMetaFile(UID, pid)), { recursive: true, force: true });
    if (failure === 'collision') {
      const dest = path.join(tmpDir, UID, 'cloud', 'projects', pid, 'chats', `${cid}.jsonl`);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, 'keep destination\n');
    }
    await filing.drainConversationFiling(UID, cid, failure === 'cancel');
    await filing.drainConversationFiling(UID, cid);
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBeFalsy();
    expect(fs.readFileSync(source, 'utf8')).toBe('source bytes\n');
    expect(filing.hasPendingConversationFiling(UID, cid)).toBe(false);
    if (failure === 'cancel') expect(failed).not.toHaveBeenCalled();
    else expect(failed).toHaveBeenCalledExactlyOnceWith({ userId: UID, cid, kind: 'move', projectId: pid });
  });
});

describe('project_setup › rename', () => {
  async function filedProject(name = 'Original') {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const created = await projects.createProject(UID, name);
    if (!created.ok) throw new Error('fixture project creation failed');
    const pid = created.project.project_id;
    const conv = await chats.createConversation(UID, { title: 'Rename this work' });
    await chats.moveConversationToProject(UID, conv.conversation_id, pid);
    return { chats, projects, pid, cid: conv.conversation_id };
  }

  it('renames the existing project durably without replacing its work or moving the conversation', async () => {
    const { chats, projects, pid, cid } = await filedProject();
    const tasks = await import('../../../src/main/features/project_tasks');
    await tasks.createTask(UID, pid, { content: 'Keep this backlog' });
    const beforeTasks = await tasks.listTasks(UID, pid);
    const beforeConversation = await chats.getConversationMetadata(UID, cid);
    const filing = await import('../../../src/main/features/conversation_filing');
    const renamed = vi.fn();
    filing.onConversationProjectRenamed(renamed);
    const executor = await tool(cid, pid);
    expect((executor.inputSchema as any).properties.action.enum).toContain('rename');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await executor.execute({ action: 'rename', name: 'Release readiness', todos: ['Ignored'] }, {} as never);
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content as string)).toMatchObject({
        ok: true, action: 'rename', project_id: pid, project_name: 'Release readiness',
        applies: 'now', ignored_fields: ['todos'],
      });
    }
    const { projectMetaFile } = await import('../../../src/main/paths');
    expect(JSON.parse(fs.readFileSync(projectMetaFile(UID, pid), 'utf8'))).toMatchObject({ project_id: pid, name: 'Release readiness' });
    expect((await projects.listProjects(UID)).map(p => [p.project_id, p.name])).toEqual([[pid, 'Release readiness']]);
    expect(await tasks.listTasks(UID, pid)).toEqual(beforeTasks);
    expect(await chats.getConversationMetadata(UID, cid)).toEqual(beforeConversation);
    expect(renamed).toHaveBeenCalledWith({ userId: UID, projectId: pid, name: 'Release readiness' });
  });

  it.each([false, true])('renames a newly created project before deferred filing completes (filing fails=%s)', async fails => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    const conv = await chats.createConversation(UID, { title: 'Create then correct the name' });
    const cid = conv.conversation_id;
    const { body: created } = await call(cid, { action: 'create', name: 'Draft' });
    const failures = vi.fn();
    filing.onConversationFilingFailed(failures);
    const { body } = await call(cid, { action: 'rename', name: 'Approved plan' });
    expect(body).toMatchObject({ ok: true, project_id: created.project_id, project_name: 'Approved plan', applies: 'now' });
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBeFalsy();
    if (fails) vi.spyOn(chats, 'moveConversationToProject').mockResolvedValueOnce({ ok: false, error: 'move_failed' });
    await filing.drainConversationFiling(UID, cid);
    expect((await projects.listProjects(UID)).map(p => p.name)).toEqual(['Approved plan']);
    if (fails) expect(failures).toHaveBeenCalledWith(expect.objectContaining({ projectId: created.project_id, projectName: 'Approved plan' }));
    else expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBe(created.project_id);
  });

  it('refuses duplicate or empty names without changing either project', async () => {
    const { projects, pid, cid } = await filedProject();
    await projects.createProject(UID, 'Taken');
    for (const [name, error] of [['taken', 'name_dup'], ['   ', 'name_empty']]) {
      const result = await call(cid, { action: 'rename', name }, pid);
      expect(result.raw.isError).toBe(true);
      expect(result.body).toMatchObject({ ok: false, error });
    }
    expect((await call(cid, { action: 'rename' }, pid)).raw.isError).toBe(true);
    expect((await projects.listProjects(UID)).map(p => p.name).sort()).toEqual(['Original', 'Taken']);
  });

  it('cannot retarget another project or resurrect a missing conversation', async () => {
    const { projects, pid, cid } = await filedProject();
    const chats = await import('../../../src/main/features/chats');
    const loose = await chats.createConversation(UID, { title: 'No project' });
    expect((await call(loose.conversation_id, { action: 'rename', name: 'Other' })).body)
      .toMatchObject({ ok: false, error: 'not_in_project' });
    expect((await call(loose.conversation_id, { action: 'rename', name: 'Other', project_id: pid })).raw.isError).toBe(true);
    expect((await call('missing_conversation', { action: 'rename', name: 'Other' }, pid)).body)
      .toMatchObject({ ok: false, error: 'not_found' });
    expect((await projects.getProject(UID, pid))?.name).toBe('Original');
    expect((await chats.getConversationMetadata(UID, cid))?.project_id).toBe(pid);
  });

});
