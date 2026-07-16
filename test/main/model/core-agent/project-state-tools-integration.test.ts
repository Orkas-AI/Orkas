import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCrossSessionMemoryTool, type MemoryTier } from '../../../../src/core-agent/src/tools/memory-tool';
import { createProjectInstructionsTool } from '../../../../src/core-agent/src/tools/project-instructions-tool';
import { createProjectTasksTool } from '../../../../src/core-agent/src/tools/project-tasks-tool';

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel() {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u-project-state-tools';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-state-tools-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setupProjectStateTools() {
  const [projects, memory, projectTasks] = await Promise.all([
    import('../../../../src/main/features/projects'),
    import('../../../../src/main/features/memory'),
    import('../../../../src/main/features/project_tasks'),
  ]);
  const created = await projects.createProject(UID, 'Tool integration');
  if (!created.ok) throw new Error(`create failed: ${created.error}`);
  const pid = created.project.project_id;
  const memoryScope = (tier: MemoryTier) => tier === 'project' ? { project: pid } as const : 'memory' as const;

  const instructionsTool = createProjectInstructionsTool({
    set: (instructions) => projects.writeProjectInstructions(UID, pid, instructions),
  });
  const memoryHandler = {
    add: (tier: MemoryTier, content: string) => memory.addEntry(UID, memoryScope(tier), content),
    replace: (tier: MemoryTier, oldText: string, content: string) => memory.replaceEntry(UID, memoryScope(tier), oldText, content),
    remove: (tier: MemoryTier, oldText: string) => memory.removeEntry(UID, memoryScope(tier), oldText),
    list: (tier: MemoryTier) => memory.listEntries(UID, memoryScope(tier)),
  };
  const memoryTool = createCrossSessionMemoryTool(memoryHandler, { includeProjectTier: true });
  const tasksTool = createProjectTasksTool({
    async list() {
      const tasks = await projectTasks.listTasks(UID, pid);
      return { ok: true, tasks: tasks.map(projectTasks.taskView), progress: projectTasks.computeProgress(tasks) };
    },
    async create(input) {
      const result = await projectTasks.createTask(UID, pid, {
        title: input.title,
        detail: input.detail,
        status: input.status,
        owner_agent: input.owner,
        created_by: 'Commander',
      });
      return result.ok
        ? { ok: true, task: projectTasks.taskView(result.task) }
        : { ok: false, error: result.error };
    },
    async update(taskId, patch) {
      const result = await projectTasks.updateTask(UID, pid, taskId, {
        title: patch.title,
        detail: patch.detail,
        status: patch.status,
        owner_agent: patch.owner,
        result_ref: patch.result_ref,
      });
      return result.ok
        ? { ok: true, task: projectTasks.taskView(result.task) }
        : { ok: false, error: result.error };
    },
    async complete(taskId, resultRef) {
      const result = await projectTasks.completeTask(UID, pid, taskId, resultRef);
      return result.ok
        ? { ok: true, task: projectTasks.taskView(result.task) }
        : { ok: false, error: result.error };
    },
  });
  return { projects, memory, projectTasks, pid, instructionsTool, memoryHandler, memoryTool, tasksTool };
}

describe('project state tools → durable feature stores', () => {
  it('round-trips instructions, durable memory, and task progress through real handlers', async () => {
    const state = await setupProjectStateTools();
    const ctx = {} as any;

    const instructions = await state.instructionsTool.execute({
      instructions: 'Goal: ship checkout.\nRule: customer copy is English.',
    }, ctx);
    expect(instructions.isError).toBe(false);
    expect(state.projects.formatProjectInstructionsForSystemPrompt(UID, state.pid))
      .toContain('customer copy is English');

    const remembered = await state.memoryTool.execute({
      action: 'add',
      target: 'project',
      content: 'The payment provider is Stripe.',
    }, ctx);
    expect(remembered.isError).toBe(false);
    expect(state.memory.formatForSystemPrompt(UID, undefined, state.pid)).toContain('The payment provider is Stripe.');

    const created = await state.tasksTool.execute({
      action: 'create',
      title: 'Implement webhook retries',
      detail: 'Retry transient failures three times.',
      owner: 'Backend',
    }, ctx);
    expect(created.isError).toBe(false);
    const taskId = JSON.parse(created.content).task.id as string;
    expect(await state.projectTasks.formatProjectStatusForTurn(UID, state.pid))
      .toContain('Implement webhook retries');

    const completed = await state.tasksTool.execute({
      action: 'complete',
      task_id: taskId,
      result_ref: 'chat-checkout-result',
    }, ctx);
    expect(completed.isError).toBe(false);
    const finalStatus = await state.projectTasks.formatProjectStatusForTurn(UID, state.pid);
    expect(finalStatus).toContain('Progress: 1/1 done, 0 open.');
    expect(finalStatus).toContain('No open tasks — all are done/cancelled.');
  });

  it('enforces sub-agent project-memory read-only mode against the same real store', async () => {
    const state = await setupProjectStateTools();
    state.memory.addEntry(UID, { project: state.pid }, 'Existing durable decision.');
    const tool = createCrossSessionMemoryTool(state.memoryHandler, {
      includeProjectTier: true,
      projectTierReadOnly: true,
    });
    const ctx = {} as any;

    const listed = await tool.execute({ action: 'list', target: 'project' }, ctx);
    expect(listed.isError).toBe(false);
    expect(JSON.parse(listed.content).entries).toEqual(['Existing durable decision.']);

    const rejected = await tool.execute({ action: 'add', target: 'project', content: 'Unauthorized write.' }, ctx);
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain('read-only');
    expect(state.memory.listEntries(UID, { project: state.pid }).entries)
      .toEqual(['Existing durable decision.']);
  });
});
