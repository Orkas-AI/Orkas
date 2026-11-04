import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatHistoryTool } from '../../../../src/main/model/core-agent/chat-history-tools';
import { createExecutionPlanTool } from '../../../../src/core-agent/src/tools/execution-plan';
import { createProjectTasksTool } from '../../../../src/core-agent/src/tools/project-tasks-tool';
import { processSessionTool, processStartTool } from '../../../../src/core-agent/src/tools/process-session';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

afterEach(() => vi.restoreAllMocks());

describe('current-only model tool inputs', () => {
  it('rejects a flat history read instead of silently selecting recent records', async () => {
    const tool = createChatHistoryTool({ userId: 'retired-input-fixture' });
    const result = await tool.execute({ action: 'read', record_id: 'old-record' }, { state: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('unsupported_fields');
  });

  it.each([{ query: 'Cedar export', k: 5 }, { search: { query: 'Cedar export' }, k: 5 }])('rejects the observed top-level history k shape: %j', async selectors => {
    const tool = createChatHistoryTool({ userId: 'retired-input-fixture', currentCid: 'fixture', allowedScopes: ['current'] });
    const result = await tool.execute({ action: 'search', scope: 'current', ...selectors }, { state: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toMatchObject({ code: 'unsupported_fields', fields: expect.arrayContaining(['k']) });
  });

  it('does not clear a plan through an operation absent from the current snapshot contract', async () => {
    const controller = { get: vi.fn(), update: vi.fn(), clear: vi.fn() };
    const result = await createExecutionPlanTool(controller).execute({ action: 'clear' }, { state: {} });
    expect(result.isError).toBe(true);
    expect(controller.clear).not.toHaveBeenCalled();
    expect(controller.update).not.toHaveBeenCalled();
  });

  it.each(['set_statuses', 'set_status'])('rejects the retired %s plan action and no built-in instruction still teaches it', async action => {
    const controller = { get: vi.fn(), update: vi.fn(), clear: vi.fn() };
    const result = await createExecutionPlanTool(controller).execute({ action, status: 'completed' }, { state: {} });
    expect(result.isError).toBe(true);
    expect(controller.update).not.toHaveBeenCalled();
    // A Skill or prompt naming it would spend a model round on a rejected call.
    const search = spawnSync('git', ['grep', '-lw', action, '--', 'resources', 'src/main/prompts'], { encoding: 'utf8', timeout: 30_000 });
    expect(search.status, search.stderr).toBeLessThanOrEqual(1);
    expect(search.stdout.split('\n').filter(Boolean)).toEqual([]);
  });

  it.each([false, true])('does not create or edit a todo by translating retired text fields (mixed=%s)', async mixed => {
    const handler = { create: vi.fn(async () => ({ ok: true })), update: vi.fn(async () => ({ ok: true })) };
    for (const action of ['create', 'update']) {
      const result = await createProjectTasksTool(handler as any).execute({
        action, task_id: 'existing', title: 'Old title', detail: 'Old detail', ...(mixed ? { content: 'Current text' } : {}),
      }, { state: {} });
      expect(result.isError).toBe(true);
    }
    expect(handler.create).not.toHaveBeenCalled();
    expect(handler.update).not.toHaveBeenCalled();
  });

  it('does not launch a command through the retired process_session start action', async () => {
    const start = vi.spyOn(processStartTool, 'execute').mockResolvedValue({ content: 'fixture command started' });
    const result = await processSessionTool.execute({ action: 'start', command: 'fixture command' }, { state: {} });
    expect(result.isError).toBe(true);
    expect(start).not.toHaveBeenCalled();
  });
});
