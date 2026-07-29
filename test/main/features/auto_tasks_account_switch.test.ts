import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  send: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock('electron', () => ({
  powerMonitor: {
    getSystemIdleState: vi.fn(() => 'active'),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));
vi.mock('../../../src/main/features/chats', () => ({
  createConversation: (...args: unknown[]) => runtime.createConversation(...args),
  deleteConversation: (...args: unknown[]) => runtime.deleteConversation(...args),
}));
vi.mock('../../../src/main/features/group_chat', () => ({
  send: (...args: unknown[]) => runtime.send(...args),
}));
vi.mock('../../../src/main/features/agents', () => ({
  getAgent: (...args: unknown[]) => runtime.getAgent(...args),
}));

const ACCOUNT_A = 'automation-account-a';
const ACCOUNT_B = 'automation-account-b';
const ACCOUNT_C = 'automation-account-c';
let tempRoot = '';
let priorWorkspaceRoot: string | undefined;

async function flushAsyncWork(): Promise<void> {
  // The full OSS suite exercises several native/runtime-heavy files in
  // parallel. Give account-switch hooks enough real event-loop turns to
  // settle even when the worker is briefly starved.
  for (let index = 0; index < 40; index += 1) {
    await Promise.resolve();
    await realDelay(0);
  }
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-auto-account-switch-'));
  priorWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tempRoot;
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-25T10:00:00.000Z'));
  vi.resetModules();
  runtime.createConversation.mockReset();
  runtime.deleteConversation.mockReset();
  runtime.send.mockReset();
  runtime.getAgent.mockReset();
  runtime.createConversation.mockResolvedValue({ conversation_id: 'cid-account-b' });
  runtime.deleteConversation.mockResolvedValue(true);
  runtime.send.mockResolvedValue({ ok: true });
  runtime.getAgent.mockResolvedValue(null);
});

afterEach(async () => {
  const autoTasks = await import('../../../src/main/features/auto_tasks');
  autoTasks.stopScheduler();
  vi.useRealTimers();
  if (priorWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = priorWorkspaceRoot;
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.resetModules();
});

describe('automation scheduler account ownership', () => {
  it('cancels account A timers and arms account B tasks during an in-process switch', async () => {
    const users = await import('../../../src/main/features/users');
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    users.activateUser(ACCOUNT_A);
    const dueAt = new Date(Date.now() + 60_000).toISOString();

    const accountATask = await autoTasks.createTask(ACCOUNT_A, {
      id: 'at_aaaabbbb',
      content: 'must not run after leaving account A',
      schedule: { type: 'one_time', at: dueAt },
    });
    const accountBTask = await autoTasks.createTask(ACCOUNT_B, {
      id: 'at_ccccdddd',
      content: 'run only for active account B',
      schedule: { type: 'one_time', at: dueAt },
    });
    expect(accountATask.ok).toBe(true);
    expect(accountBTask.ok).toBe(true);
    autoTasks.stopScheduler();
    autoTasks.startScheduler();
    await autoTasks.rescheduleAllForTest(ACCOUNT_A);

    expect(autoTasks.armedDueAtForTest('at_aaaabbbb')).toBe(Date.parse(dueAt));
    expect(autoTasks.armedDueAtForTest('at_ccccdddd')).toBeNull();

    users.activateUser(ACCOUNT_B);
    await flushAsyncWork();

    expect(autoTasks.armedDueAtForTest('at_aaaabbbb')).toBeNull();
    expect(autoTasks.armedDueAtForTest('at_ccccdddd')).toBe(Date.parse(dueAt));

    const lateAccountAMutation = await autoTasks.createTask(ACCOUNT_A, {
      // Account-scoped ids may collide. A late mutation must neither arm A
      // nor cancel B's live timer with the same id.
      id: 'at_ccccdddd',
      content: 'old account mutation completed after the switch',
      schedule: { type: 'one_time', at: dueAt },
    });
    expect(lateAccountAMutation.ok).toBe(true);
    expect(autoTasks.armedDueAtForTest('at_ccccdddd')).toBe(Date.parse(dueAt));
    expect((await autoTasks.deleteTask(ACCOUNT_A, 'at_ccccdddd')).ok).toBe(true);
    expect(autoTasks.armedDueAtForTest('at_ccccdddd')).toBe(Date.parse(dueAt));

    await vi.advanceTimersByTimeAsync(61_000);
    await flushAsyncWork();

    expect(runtime.createConversation).toHaveBeenCalledOnce();
    expect(runtime.createConversation.mock.calls[0]?.[0]).toBe(ACCOUNT_B);
    expect(runtime.send).toHaveBeenCalledOnce();
    expect((await autoTasks.getTask(ACCOUNT_A, 'at_aaaabbbb'))).toMatchObject({
      enabled: true,
      content: 'must not run after leaving account A',
    });
    expect((await autoTasks.getTask(ACCOUNT_A, 'at_aaaabbbb'))?.last_run_at).toBeUndefined();
    expect((await autoTasks.getTask(ACCOUNT_B, 'at_ccccdddd'))).toMatchObject({
      enabled: false,
      content: 'run only for active account B',
    });
  });

  it('does not let a superseded account reschedule finish after a newer switch', async () => {
    const users = await import('../../../src/main/features/users');
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    users.activateUser(ACCOUNT_A);
    const dueAt = new Date(Date.now() + 60_000).toISOString();
    for (const [uid, id] of [
      [ACCOUNT_A, 'at_1111aaaa'],
      [ACCOUNT_B, 'at_2222bbbb'],
      [ACCOUNT_C, 'at_3333cccc'],
    ] as const) {
      const created = await autoTasks.createTask(uid, {
        id,
        content: `task for ${uid}`,
        schedule: { type: 'one_time', at: dueAt },
      });
      expect(created.ok).toBe(true);
    }
    autoTasks.stopScheduler();
    autoTasks.startScheduler();
    await autoTasks.rescheduleAllForTest(ACCOUNT_A);

    users.activateUser(ACCOUNT_B);
    users.activateUser(ACCOUNT_C);
    await flushAsyncWork();

    expect(autoTasks.armedDueAtForTest('at_1111aaaa')).toBeNull();
    expect(autoTasks.armedDueAtForTest('at_2222bbbb')).toBeNull();
    expect(autoTasks.armedDueAtForTest('at_3333cccc')).toBe(Date.parse(dueAt));

    await vi.advanceTimersByTimeAsync(61_000);
    await flushAsyncWork();
    expect(runtime.createConversation).toHaveBeenCalledOnce();
    expect(runtime.createConversation.mock.calls[0]?.[0]).toBe(ACCOUNT_C);
  });
});
