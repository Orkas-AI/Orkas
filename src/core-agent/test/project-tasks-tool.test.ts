import { describe, it, expect } from 'vitest';
import { createProjectTasksTool } from '../src/tools/project-tasks-tool';
import type { ProjectTasksToolHandler, ProjectTasksProjectSelector } from '../src/tools/project-tasks-tool';

const ctx = {} as any;

function stubHandler(): { handler: ProjectTasksToolHandler; calls: any[] } {
  const calls: any[] = [];
  const handler: ProjectTasksToolHandler = {
    list: async (query) => { calls.push(['list', query]); return { ok: true, tasks: [{ id: 't_a', content: 'x', status: 'todo' }], progress: { total: 1, done: 0, open: 1 }, total: 1, next_offset: null }; },
    get: async (id) => { calls.push(['get', id]); return { ok: true, task: { id, content: 'x\nFull detail', status: 'todo' } }; },
    create: async (input) => { calls.push(['create', input]); return { ok: true, task: { id: 't_new', content: input.content, status: 'todo' } }; },
    update: async (id, patch) => { calls.push(['update', id, patch]); return { ok: true, task: { id, content: 'x', status: patch.status || 'todo' } }; },
    complete: async (id, ref) => { calls.push(['complete', id, ref]); return { ok: true, task: { id, content: 'x', status: 'done' } }; },
  };
  return { handler, calls };
}

describe('todo_tasks tool', () => {
  it('deletes only an explicitly identified task in the writable scope', async () => {
    const { handler } = stubHandler();
    const deleted: string[] = [];
    handler.delete = async (id) => { deleted.push(id); return { ok: true, task_id: id, deleted: true }; };
    const tool = createProjectTasksTool(handler);
    for (const input of [{ action: 'delete' }, { action: 'delete', task_id: '' },
      { action: 'delete', task_id: 't_a', project: 'foreign' }]) {
      expect((await tool.execute(input, ctx)).isError).toBe(true);
    }
    expect((await createProjectTasksTool(handler, { readOnly: true }).execute({ action: 'delete', task_id: 't_a' }, ctx)).isError).toBe(true);
    expect(deleted).toEqual([]);
    const result = await tool.execute({ action: 'delete', task_id: 't_a' }, ctx);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ ok: true, task_id: 't_a', deleted: true });
    expect(deleted).toEqual(['t_a']);
  });

  it('adds a file to an existing task and rejects missing operands, foreign scope and read-only writes', async () => {
    const { handler } = stubHandler();
    const calls: unknown[] = [];
    Object.assign(handler, { addAttachment: async (id: string, source: string) => {
      calls.push([id, source]);
      return { ok: true, task: { id, content: 'Review document', status: 'todo', attachments: ['brief.txt'] } };
    } });
    const tool = createProjectTasksTool(handler);
    const args = { action: 'add_attachment', task_id: 't_a', source_path: '/workspace/brief.txt' };
    const added = await tool.execute(args, ctx);
    expect(added.isError).toBeFalsy();
    expect(JSON.parse(added.content).task.attachments).toEqual(['brief.txt']);
    expect(calls).toEqual([['t_a', '/workspace/brief.txt']]);
    for (const bad of [{ ...args, task_id: '' }, { ...args, source_path: '' },
      { ...args, source_path: 42 }, { ...args, project: 'foreign' }]) {
      expect((await tool.execute(bad, ctx)).isError).toBe(true);
    }
    expect((await createProjectTasksTool(handler, { readOnly: true }).execute(args, ctx)).isError).toBe(true);
    expect(calls).toHaveLength(1);
  });
  it('accepts paged status queries and read-only detail retrieval, rejecting invalid query fields before IO', async () => {
    const { handler, calls } = stubHandler();
    const tool = createProjectTasksTool(handler, { readOnly: true });
    expect((await tool.execute({ action: 'list', offset: 20, limit: 50, status: 'review' }, ctx)).isError).toBeFalsy();
    expect(calls).toEqual([['list', { offset: 20, limit: 50, status: 'review' }]]);
    expect(JSON.parse((await tool.execute({ action: 'get', task_id: 't_a' }, ctx)).content).task.content).toBe('x\nFull detail');
    calls.length = 0;
    for (const args of [
      { action: 'list', offset: -1 }, { action: 'list', offset: 0.5 },
      { action: 'list', offset: Number.MAX_SAFE_INTEGER + 1 },
      { action: 'list', limit: 0 }, { action: 'list', limit: 51 },
      { action: 'list', limit: '20' }, { action: 'list', status: 'blocked' },
      { action: 'get' }, { action: 'get', task_id: ' ' },
    ]) expect((await tool.execute(args, ctx)).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it('list dispatches to handler.list and returns the backlog', async () => {
    const { handler, calls } = stubHandler();
    const res = await createProjectTasksTool(handler).execute({ action: 'list' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(calls[0][0]).toBe('list');
    expect(res.content).toContain('t_a');
    expect(JSON.parse(res.content)).not.toHaveProperty('ignored_fields');
  });

  it('reports other known fields omitted by the selected action without changing its effective inputs', async () => {
    const { handler, calls } = stubHandler();
    const tool = createProjectTasksTool(handler);
    const result = await tool.execute({ action: 'list', status: 'review', content: 'private unused work', owner: 'Writer' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content).ignored_fields).toEqual(['content', 'owner']);
    expect(result.content).not.toContain('private unused work');
    expect(calls).toEqual([['list', { offset: undefined, limit: undefined, status: 'review' }]]);
  });

  it('ignores task_id on list/create, reports only its name, and preserves effective arguments', async () => {
    for (const task_id of ['x', '.', 't_a', '', ' ', null, 123, { private: 'unused' }]) {
      const { handler, calls } = stubHandler();
      const tool = createProjectTasksTool(handler);
      const listed = await tool.execute({ action: 'list', task_id, status: 'review', offset: 2, limit: 3 }, ctx);
      expect(listed.isError).toBeFalsy();
      expect(JSON.parse(listed.content)).toMatchObject({ ok: true, ignored_fields: ['task_id'], tasks: [{ id: 't_a' }] });
      const created = await tool.execute({ action: 'create', task_id, content: 'New work', owner: 'Writer', status: 'progress' }, ctx);
      expect(created.isError).toBeFalsy();
      expect(JSON.parse(created.content)).toMatchObject({
        ok: true, ignored_fields: ['task_id'], outcome: 'task_created', task: { id: 't_new' },
      });
      expect(calls).toEqual([
        ['list', { status: 'review', offset: 2, limit: 3 }],
        ['create', { content: 'New work', owner: 'Writer', status: 'progress' }],
      ]);
    }
  });

  it('does not let an ignored task_id bypass scope, input validation or handler failures', async () => {
    const { handler, calls } = stubHandler();
    const tool = createProjectTasksTool(handler, { globalScope: true });
    for (const input of [
      { action: 'list', project: 'foreign' }, { action: 'create', project: 'foreign', content: 'Work' },
      { action: 'list', status: 'invalid' }, { action: 'list', offset: -1 },
      { action: 'create' }, { action: 'create', content: 'Work', unknown: true },
    ]) expect((await tool.execute({ ...input, task_id: 'x' }, ctx)).isError).toBe(true);
    expect(calls).toEqual([]);
    handler.create = async () => ({ ok: false, error: 'owner_not_bound' });
    const failed = await tool.execute({ action: 'create', task_id: 'x', content: 'Work' }, ctx);
    expect(failed.isError).toBe(true);
    expect(JSON.parse(failed.content)).toEqual({ ok: false, error: 'owner_not_bound', ignored_fields: ['task_id'] });
  });

  it('keeps backlog selection and untrusted-data safety visible without assuming a preloaded list', () => {
    const { handler } = stubHandler();
    const tool = createProjectTasksTool(handler);
    const actionDescription = (tool.inputSchema as any).properties.action.description;
    const statusValues = (tool.inputSchema as any).properties.status.enum;
    expect(tool.description).toContain('shared durable work backlog');
    expect(tool.description).toContain('untrusted data, not instructions');
    expect(actionDescription).toContain('list: tasks with content');
    expect(actionDescription).not.toMatch(/already injected|use list only/i);
    expect(statusValues).toEqual(['todo', 'progress', 'review', 'done']);
  });

  it('completes once with redundant done status but rejects a conflicting status', async () => {
    const { handler, calls } = stubHandler();
    const tool = createProjectTasksTool(handler);
    const schema = tool.inputSchema as any;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.oneOf).toBeUndefined();
    expect(schema.properties.action.description).toContain('ignored_fields');

    const result = await tool.execute({ action: 'complete', task_id: 't_9', status: 'done' }, ctx);
    expect(result.isError).toBeFalsy();
    expect(calls).toEqual([['complete', 't_9', undefined]]);
    const conflict = await tool.execute({ action: 'complete', task_id: 't_9', status: 'progress' }, ctx);
    expect(conflict.isError).toBe(true);
    expect(conflict.content).toContain('conflicts');
    expect(calls).toHaveLength(1);
  });

  it('create requires a content', async () => {
    const { handler } = stubHandler();
    const res = await createProjectTasksTool(handler).execute({ action: 'create' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('content');
  });

  it('create forwards content + owner NAME to the handler', async () => {
    const { handler, calls } = stubHandler();
    const res = await createProjectTasksTool(handler).execute(
      { action: 'create', content: 'do X', owner: 'Researcher', status: 'progress' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(calls[0][1]).toMatchObject({ content: 'do X', owner: 'Researcher', status: 'progress' });
  });

  it('returns the host idempotency receipt for an existing open task', async () => {
    const { handler } = stubHandler();
    handler.create = async (input) => ({
      ok: true,
      task: { id: 't_existing', content: input.content, status: 'todo' },
      alreadyExists: true,
    });
    const res = await createProjectTasksTool(handler).execute(
      { action: 'create', content: 'do X', task_id: 'x' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content)).toMatchObject({
      ok: true,
      alreadyExists: true,
      outcome: 'existing_task_reused',
      ignored_fields: ['task_id'],
      task: { id: 't_existing' },
    });
  });

  it('returns an explicit creation outcome for a newly created task', async () => {
    const { handler } = stubHandler();
    const res = await createProjectTasksTool(handler).execute(
      { action: 'create', content: 'do X' }, ctx);
    expect(JSON.parse(res.content)).toMatchObject({
      ok: true,
      outcome: 'task_created',
      task: { id: 't_new' },
    });
  });

  it('reports the failing action and constraint without prescribing another action', async () => {
    const { handler, calls } = stubHandler();
    const tool = createProjectTasksTool(handler);
    for (const action of ['get', 'update', 'complete']) {
      const result = await tool.execute({ action, ...(action === 'update' ? { status: 'done' } : {}) }, ctx);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toBe(`"task_id" is required for ${action}`);
    }
    const conflict = await tool.execute({ action: 'complete', task_id: 't_a', status: 'progress' }, ctx);
    expect(JSON.parse(conflict.content).error).toBe('complete conflicts with status; only done is valid');
    expect(calls).toEqual([]);
  });

  it('complete forwards task_id + result_ref', async () => {
    const { handler, calls } = stubHandler();
    await createProjectTasksTool(handler).execute({ action: 'complete', task_id: 't_9', result_ref: 'chat-1' }, ctx);
    expect(calls[0]).toEqual(['complete', 't_9', 'chat-1']);
  });

  it('rejects an unknown action', async () => {
    const { handler } = stubHandler();
    const res = await createProjectTasksTool(handler).execute({ action: 'frobnicate' }, ctx);
    expect(res.isError).toBe(true);
  });

  it('surfaces a handler failure as an error result', async () => {
    const handler: ProjectTasksToolHandler = {
      list: async () => ({ ok: false, tasks: [], progress: { total: 0, done: 0, open: 0 }, total: 0, next_offset: null }),
      get: async () => ({ ok: false, error: 'task_not_found' }),
      create: async () => ({ ok: false, error: 'owner_not_bound' }),
      update: async () => ({ ok: true }),
      complete: async () => ({ ok: true }),
    };
    const res = await createProjectTasksTool(handler).execute({ action: 'create', content: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('owner_not_bound');
  });
});

describe('todo_tasks tool › no set_goal (moved to project_instructions)', () => {
  it('no longer exposes set_goal or a goal field', async () => {
    const { handler } = stubHandler();
    const tool = createProjectTasksTool(handler);
    expect((tool.inputSchema as any).properties.action.enum).not.toContain('set_goal');
    expect((tool.inputSchema as any).properties.goal).toBeUndefined();
    // Calling it is just an unknown action now.
    const res = await tool.execute({ action: 'set_goal', goal: 'x' }, ctx);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('unknown action');
  });
});

describe('todo_tasks tool › task management by named Agents and CLI executors', () => {
  it('allows creation, edits, status/result updates, and completion in the bound project', async () => {
    const { handler, calls } = stubHandler();
    const tool = createProjectTasksTool(handler);
    const schema = tool.inputSchema as any;
    expect(schema.properties.action.enum).toEqual(['list', 'get', 'create', 'update', 'complete', 'add_attachment', 'delete']);
    expect(schema.properties).not.toHaveProperty('project');
    for (const field of ['content', 'owner']) expect(schema.properties).toHaveProperty(field);
    expect((await tool.execute({ action: 'update', task_id: 't_1', status: 'review', result_ref: 'artifact-1' }, ctx)).isError).toBeFalsy();
    expect(calls[0]).toEqual(['update', 't_1', expect.objectContaining({ status: 'review', result_ref: 'artifact-1' })]);
    expect((await tool.execute({ action: 'complete', task_id: 't_1', result_ref: 'artifact-1' }, ctx)).isError).toBeFalsy();
    expect(calls[1]).toEqual(['complete', 't_1', 'artifact-1']);
    expect((await tool.execute({ action: 'create', content: 'New item', owner: 'Writer' }, ctx)).isError).toBeFalsy();
    expect((await tool.execute({ action: 'update', task_id: 't_1', content: 'Revised\nDetails', owner: '' }, ctx)).isError).toBeFalsy();
    expect(calls[3]).toEqual(['update', 't_1', expect.objectContaining({ content: 'Revised\nDetails', owner: '' })]);
  });

  it('rejects scope overrides and malformed writes before calling storage', async () => {
    const { handler, calls } = stubHandler();
    const tool = createProjectTasksTool(handler);
    for (const input of [
      { action: 'create', content: 'new', project: 'foreign' },
      { action: 'update', task_id: 't_1', content: null, status: 'done' },
      { action: 'update', task_id: 't_1', detail: {} },
      { action: 'update', task_id: 't_1', owner: [] },
      { action: 'complete', task_id: 't_1', project: 'foreign' },
      { action: 'update', task_id: 't_1', status: 'success' },
      { action: 'update', task_id: 't_1', status: null },
      { action: 'complete', task_id: 't_1', result_ref: {} },
      { action: 'update', task_id: 't_1' },
      { action: 'complete', task_id: 123 },
    ]) expect((await tool.execute(input, ctx)).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe('todo_tasks tool › read-only workers', () => {
  it('exposes only list/get in the action schema and flags read-only in the description', () => {
    const { handler } = stubHandler();
    const tool = createProjectTasksTool(handler, { readOnly: true });
    expect((tool.inputSchema as any).properties.action.enum).toEqual(['list', 'get']);
    expect(tool.description).toContain('READ-ONLY');
  });

  it('allows list', async () => {
    const { handler, calls } = stubHandler();
    const res = await createProjectTasksTool(handler, { readOnly: true }).execute({ action: 'list' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(calls[0][0]).toBe('list');
    expect(res.content).toContain('t_a');
  });

  it('rejects create / update / complete without ever reaching the store', async () => {
    for (const action of ['create', 'update', 'complete'] as const) {
      const { handler, calls } = stubHandler();
      const res = await createProjectTasksTool(handler, { readOnly: true })
        .execute({ action, content: 'x', task_id: 't_1', result_ref: 'chat-1' }, ctx);
      expect(res.isError).toBe(true);
      expect(res.content).toContain('read-only');
      expect(calls).toHaveLength(0); // the write never touched the handler
    }
  });

  it('commander (default, readOnly omitted) keeps full write access', async () => {
    const { handler, calls } = stubHandler();
    const tool = createProjectTasksTool(handler);
    expect((tool.inputSchema as any).properties.action.enum).toEqual(['list', 'get', 'create', 'update', 'complete', 'add_attachment', 'delete']);
    const res = await tool.execute({ action: 'create', content: 'do X' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(calls[0][0]).toBe('create');
  });
});

describe('todo_tasks tool › explicit project selection', () => {
  it('discovers projects and executes against the resolved project without losing the mutation receipt', async () => {
    const { handler, calls } = stubHandler();
    const references: string[] = [];
    const project = { project_id: 'p_selected', name: 'Launch' };
    const tool = createProjectTasksTool({
      listProjects: async () => [project],
      resolveProject: async (reference) => {
        references.push(reference);
        return { ok: true, project, handler };
      },
    });
    expect(tool.description).not.toContain('READ-ONLY');
    expect((tool.inputSchema as any).properties.action.description).not.toMatch(/already injected/i);
    const discovery = await tool.execute({ action: 'list_projects' }, ctx);
    expect(JSON.parse(discovery.content)).toEqual({ ok: true, projects: [project] });
    const redundantDiscovery = await tool.execute({ action: 'list_projects', content: 'unused' }, ctx);
    expect(JSON.parse(redundantDiscovery.content)).toEqual({
      ok: true, projects: [project], ignored_fields: ['content'],
    });
    expect(references).toEqual([]);
    const created = await tool.execute({ action: 'create', project: 'Launch', content: 'Ship it', task_id: 'x' }, ctx);
    expect(references).toEqual(['Launch']);
    expect(JSON.parse(created.content)).toMatchObject({
      ok: true, project, outcome: 'task_created', task: { content: 'Ship it' }, ignored_fields: ['task_id'],
    });
    expect(calls).toHaveLength(1);
  });

  it('rejects a missing target and unrelated fields before lookup or mutation', async () => {
    const { handler, calls } = stubHandler();
    const lookups: string[] = [];
    const selector: ProjectTasksProjectSelector = {
      listProjects: async () => [],
      resolveProject: async (reference) => {
        lookups.push(reference);
        return { ok: true, project: { project_id: 'p_a', name: 'A' }, handler };
      },
    };
    const tool = createProjectTasksTool(selector);
    for (const input of [
      { action: 'create', content: 'x' },
      { action: 'create', project: 'A' },
      { action: 'complete', project: 'A', task_id: 't_a', status: 'progress' },
      { action: 'list_projects', project: 'A' },
    ]) {
      expect((await tool.execute(input, ctx)).isError).toBe(true);
    }
    expect(lookups).toEqual([]);
    expect(calls).toEqual([]);
    expect(() => createProjectTasksTool(selector, { readOnly: true })).toThrow('bound project');
  });

  it('preserves target-resolution failures instead of claiming an empty backlog or successful write', async () => {
    const candidates = [{ project_id: 'p_a', name: 'A' }, { project_id: 'p_b', name: 'A' }];
    const tool = createProjectTasksTool({
      listProjects: async () => candidates,
      resolveProject: async () => ({ ok: false, error: 'project_ambiguous', candidates }),
    });
    const result = await tool.execute({ action: 'create', project: 'A', content: 'x' }, ctx);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({ ok: false, error: 'project_ambiguous', candidates });
  });

  it('cannot retarget a bound project or discover other projects through the bound contract', async () => {
    for (const readOnly of [false, true]) {
      const { handler, calls } = stubHandler();
      const tool = createProjectTasksTool(handler, { readOnly });
      expect((tool.inputSchema as any).properties.project).toBeUndefined();
      expect((await tool.execute({ action: 'list', project: 'another' }, ctx)).isError).toBe(true);
      expect((await tool.execute({ action: 'list_projects' }, ctx)).isError).toBe(true);
      expect(calls).toEqual([]);
    }
  });
});


describe('todo_tasks › retired status', () => {
  it.each(['create', 'update'])('rejects retired states in %s before touching the backlog', async (action) => {
    const { handler, calls } = stubHandler();
    const tool = createProjectTasksTool(handler);
    for (const status of ['blocked', 'cancelled', 'in_progress', 'in_review']) {
      expect((tool.inputSchema as any).properties.status.enum).not.toContain(status);
      const result = await tool.execute({ action, status,
        ...(action === 'create' ? { content: 'Invalid task' } : { task_id: 't_existing' }),
      }, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('invalid task status');
      expect(calls).toEqual([]);
    }
  });
});

describe('todo_tasks › single content contract', () => {
  it('advertises only content and rejects empty, oversized or non-text edits before IO', async () => {
    const { handler, calls } = stubHandler();
    const tool = createProjectTasksTool(handler);
    const schema = tool.inputSchema as any;
    expect(schema.properties).not.toHaveProperty('title');
    expect(schema.properties).not.toHaveProperty('detail');
    expect(schema.properties.content.description).toContain('Required for create');
    for (const action of ['create', 'update']) {
      for (const content of ['', '  ', null, 3, 'x'.repeat(4001)]) {
        expect((await tool.execute({ action, content, ...(action === 'update' ? { task_id: 't_a' } : {}) }, ctx)).isError).toBe(true);
      }
    }
    expect(calls).toEqual([]);
    const content = 'Requirement\n' + '文'.repeat(1000);
    expect((await tool.execute({ action: 'create', content }, ctx)).isError).toBeFalsy();
    expect(calls[0]).toEqual(['create', { content, owner: undefined, status: undefined }]);
  });
});

it('validates only effective task parameters, preserving the bound target', async () => {
  const { handler, calls } = stubHandler();
  const tool = createProjectTasksTool(handler);
  expect((await tool.execute({ action: 'get', task_id: 't_a', limit: 'unused', content: {} }, ctx)).isError).toBeFalsy();
  expect(calls).toEqual([['get', 't_a']]);
  expect((await tool.execute({ action: 'complete', task_id: 't_a', project: 'foreign' }, ctx)).isError).toBe(true);
  expect(calls).toHaveLength(1);
});
