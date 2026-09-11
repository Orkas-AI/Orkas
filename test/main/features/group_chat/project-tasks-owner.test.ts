import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * The `todo_tasks` runner handler must resolve `owner` (an agent display
 * NAME per the tool contract) against the project's BOUND agents before
 * persisting: `owner_agent_id` gets populated (stable across rename) and an
 * unknown / unbound owner fails closed listing the valid owners. The store
 * itself only validates an already-resolved id (project_tasks.ts contract:
 * "name→id resolution lives with the caller").
 *
 * We capture the REAL handler runner.ts builds by mocking the tool factory it
 * dynamically imports; buildRunner may fail later (no real provider in tests)
 * — the capture happens before that and is all we need.
 */

const captured = vi.hoisted(() => ({ handler: null as any }));

vi.mock('../../../../src/core-agent/src/tools/project-tasks-tool', () => ({
  createProjectTasksTool: (handler: any, _opts: any) => {
    captured.handler = handler;
    return {
      name: 'todo_tasks',
      description: 'stub',
      inputSchema: { type: 'object', properties: {}, required: [] },
      execute: async () => ({ content: '{}' }),
    };
  },
}));

let tmpDir: string;
let prevWs: string | undefined;
let prevKey: string | undefined;
const TEST_UID = 'uTasksOwner';
const BOUND_ID = 'aaa111bbb222';
const BOUND_NAME = 'Backend Dev';
const UNBOUND_ID = 'ccc333ddd444';
const UNBOUND_NAME = 'Reviewer';

function seedAgent(paths: any, id: string, name: string) {
  const dir = paths.agentDir(TEST_UID, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
    agent_id: id, name,
    description: 'agent', workflow: 'work',
    created_at: 't', updated_at: 't',
  }));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-tasks-owner-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Let buildRunner pass its auth gate without a configured entry.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder';
  captured.handler = null;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevKey;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setupHandler(): Promise<{ pid: string; projectTasks: any }> {
  const paths = await import('../../../../src/main/paths');
  seedAgent(paths, BOUND_ID, BOUND_NAME);
  seedAgent(paths, UNBOUND_ID, UNBOUND_NAME);
  const projects = await import('../../../../src/main/features/projects');
  const created = await projects.createProject(TEST_UID, 'Owner resolution');
  if (!created.ok) throw new Error('project setup failed');
  const pid = created.project.project_id;
  await projects.addAgentBinding(TEST_UID, pid, BOUND_ID);

  const state = await import('../../../../src/main/features/group_chat/state');
  const cid = 'c0ffee000001';
  const { buildRunner } = await import('../../../../src/main/model/core-agent/runner');
  // buildRunner may fail after the tool-injection phase (no usable model in
  // the test env) — the handler capture happens before that.
  await buildRunner({
    sessionId: state.buildGconvSessionId(cid),
    userId: TEST_UID,
    cid,
    projectId: pid,
  }).catch(() => {});
  if (!captured.handler) throw new Error('todo_tasks handler was not captured from buildRunner');
  const projectTasks = await import('../../../../src/main/features/project_tasks');
  return { pid, projectTasks };
}

describe('runner › todo_tasks owner resolution', () => {
  it('create with an owner display name resolves and persists owner_agent_id', async () => {
    const { pid, projectTasks } = await setupHandler();

    const r = await captured.handler.create({ title: 'Implement retries', owner: BOUND_NAME });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    const tasks = await projectTasks.listTasks(TEST_UID, pid);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].owner_agent).toBe(BOUND_NAME);
    expect(tasks[0].owner_agent_id).toBe(BOUND_ID);
  }, 30_000);

  it('owner name matching is space/case-insensitive (dispatch-target normalization)', async () => {
    const { pid, projectTasks } = await setupHandler();

    const r = await captured.handler.create({ title: 'Ship it', owner: 'backenddev' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const tasks = await projectTasks.listTasks(TEST_UID, pid);
    expect(tasks[0].owner_agent_id).toBe(BOUND_ID);
  }, 30_000);

  it('an unknown owner is rejected with the valid-owner list (fail closed)', async () => {
    const { pid, projectTasks } = await setupHandler();

    const r = await captured.handler.create({ title: 'Orphan work', owner: 'Nonexistent' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toContain('Nonexistent');
    expect(String(r.error)).toContain(BOUND_NAME); // lists the valid owners
    expect(await projectTasks.listTasks(TEST_UID, pid)).toHaveLength(0);
  }, 30_000);

  it('an existing but UNBOUND agent is rejected as owner', async () => {
    const { pid, projectTasks } = await setupHandler();

    const r = await captured.handler.create({ title: 'Cross-project work', owner: UNBOUND_NAME });
    expect(r.ok).toBe(false);
    expect(await projectTasks.listTasks(TEST_UID, pid)).toHaveLength(0);
  }, 30_000);

  it('update with an owner name also resolves to the bound id; unknown update owner is rejected', async () => {
    const { pid, projectTasks } = await setupHandler();

    const created = await captured.handler.create({ title: 'Unowned task' });
    expect(created.ok).toBe(true);
    const tid = created.task.id;

    const updated = await captured.handler.update(tid, { owner: BOUND_NAME });
    expect(updated.ok, JSON.stringify(updated)).toBe(true);
    const tasks = await projectTasks.listTasks(TEST_UID, pid);
    expect(tasks[0].owner_agent_id).toBe(BOUND_ID);

    const rejected = await captured.handler.update(tid, { owner: 'Nobody' });
    expect(rejected.ok).toBe(false);
    // Owner unchanged after the rejected update.
    const after = await projectTasks.listTasks(TEST_UID, pid);
    expect(after[0].owner_agent_id).toBe(BOUND_ID);
  }, 30_000);
});
