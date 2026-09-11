import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProjectTask, TaskStatus } from '../../../src/main/features/project_tasks';

// The runner imports side-effecting feature modules only for the live fire path
// (advance / runDriverTick). advanceProjectIfDue takes all of those through
// injected deps, so stub the modules to keep the orchestration test hermetic —
// the real fire/backlog/bus are never exercised here.
vi.mock('../../../src/main/features/chats', () => ({
  createConversation: vi.fn(), deleteConversation: vi.fn(),
}));
vi.mock('../../../src/main/features/group_chat', () => ({
  send: vi.fn(), busIsQuiescent: () => true,
}));
vi.mock('../../../src/main/features/projects', () => ({
  listProjects: vi.fn(async () => []),
  listProjectIds: vi.fn(async () => []),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'uRUN';
const PID = 'p_aabbccddeeff';
const NOW = new Date(2026, 6, 21, 10, 0, 0).getTime();

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-driverrun-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});
afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkTask(id: string, status: TaskStatus): ProjectTask {
  return { id, title: id, status, created_by: 'user', created_at: '2026-07-21T00:00:00.000Z', updated_at: '2026-07-21T00:00:00.000Z' };
}

const load = async () => ({
  runner: await import('../../../src/main/features/project_driver_runner'),
  drv: await import('../../../src/main/features/project_driver'),
});

function deps(over: Partial<{
  now: () => number;
  listTasks: () => Promise<ProjectTask[]>;
  isQuiescent: () => boolean;
  advance: (uid: string, pid: string, task: ProjectTask) => Promise<{ ok: boolean; cid?: string }>;
}> = {}) {
  return {
    now: () => NOW,
    listTasks: async () => [mkTask('t_1', 'todo')],
    isQuiescent: () => true,
    advance: vi.fn(async () => ({ ok: true, cid: 'c_new' })),
    ...over,
  };
}

describe('project_driver_runner › advanceProjectIfDue', () => {
  it('disabled project → no advance', async () => {
    const { runner } = await load();
    const advance = vi.fn(async () => ({ ok: true, cid: 'x' }));
    expect(await runner.advanceProjectIfDue(UID, PID, deps({ advance }))).toBe('disabled');
    expect(advance).not.toHaveBeenCalled();
  });

  it('enabled + actionable task → advances and persists the lease + count', async () => {
    const { runner, drv } = await load();
    await drv.writeConfig(UID, PID, { enabled: true });
    const advance = vi.fn(async () => ({ ok: true, cid: 'c_new' }));
    expect(await runner.advanceProjectIfDue(UID, PID, deps({ advance }))).toBe('advanced');
    expect(advance).toHaveBeenCalledWith(UID, PID, expect.objectContaining({ id: 't_1' }));
    const state = await drv.readState(UID, PID);
    expect(state.lease_cid).toBe('c_new');
    expect(state.advance_count).toBe(1);
  });

  it('an overlapping call for the same project fires the task once', async () => {
    // The tick and `projects.driver.set` both call advanceProjectIfDue with no
    // lock between them (2026-08-28 review E1-9).
    const { runner, drv } = await load();
    await drv.writeConfig(UID, PID, { enabled: true });
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const advance = vi.fn(async () => { await gate; return { ok: true, cid: 'c_new' }; });
    const first = runner.advanceProjectIfDue(UID, PID, deps({ advance }));
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await runner.advanceProjectIfDue(UID, PID, deps({ advance }));
    expect(second).toBe('running');
    release();
    expect(await first).toBe('advanced');
    expect(advance).toHaveBeenCalledTimes(1);
  });

  it('enabled + no actionable task → no advance', async () => {
    const { runner, drv } = await load();
    await drv.writeConfig(UID, PID, { enabled: true });
    const advance = vi.fn(async () => ({ ok: true, cid: 'x' }));
    expect(await runner.advanceProjectIfDue(UID, PID, deps({ advance, listTasks: async () => [mkTask('t_done', 'done')] }))).toBe('no_actionable_task');
    expect(advance).not.toHaveBeenCalled();
  });

  it('a still-running lease blocks the advance', async () => {
    const { runner, drv } = await load();
    await drv.writeConfig(UID, PID, { enabled: true });
    await drv.writeState(UID, PID, { lease_cid: 'c_old', lease_at: new Date(NOW - 60_000).toISOString() });
    const advance = vi.fn(async () => ({ ok: true, cid: 'x' }));
    expect(await runner.advanceProjectIfDue(UID, PID, deps({ advance, isQuiescent: () => false }))).toBe('running');
    expect(advance).not.toHaveBeenCalled();
  });

  it('a still-running lease no longer blocks once its task has left todo', async () => {
    const { runner, drv } = await load();
    await drv.writeConfig(UID, PID, { enabled: true });
    // The lease conversation is still busy, but the task it advanced already
    // moved to progress — the advance took effect, so proceed to the next.
    await drv.writeState(UID, PID, { lease_cid: 'c_old', lease_at: new Date(NOW - 60_000).toISOString(), lease_task_id: 't_prev' });
    const advance = vi.fn(async () => ({ ok: true, cid: 'c_new' }));
    const listTasks = async () => [mkTask('t_prev', 'progress'), mkTask('t_next', 'todo')];
    expect(await runner.advanceProjectIfDue(UID, PID, deps({ advance, listTasks, isQuiescent: () => false }))).toBe('advanced');
    expect(advance).toHaveBeenCalledWith(UID, PID, expect.objectContaining({ id: 't_next' }));
    const st = await drv.readState(UID, PID);
    expect(st.lease_task_id).toBe('t_next');
  });

  it('a failed fire records the count but no lease (no hammering, no stale lease)', async () => {
    const { runner, drv } = await load();
    await drv.writeConfig(UID, PID, { enabled: true });
    const advance = vi.fn(async () => ({ ok: false }));
    expect(await runner.advanceProjectIfDue(UID, PID, deps({ advance }))).toBe('advanced');
    const state = await drv.readState(UID, PID);
    expect(state.lease_cid).toBeUndefined();
    expect(state.advance_count).toBe(1);
  });

  it('emits an advance event with the new conversation so the renderer can surface it', async () => {
    const { runner, drv } = await load();
    await drv.writeConfig(UID, PID, { enabled: true });
    const events: Array<{ uid: string; pid: string; cid: string; conversation: unknown }> = [];
    runner.onAdvance((e) => events.push(e));
    const advance = vi.fn(async () => ({ ok: true, cid: 'c_new', conversation: { conversation_id: 'c_new', project_id: PID } }));
    expect(await runner.advanceProjectIfDue(UID, PID, deps({ advance }))).toBe('advanced');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ uid: UID, pid: PID, cid: 'c_new' });
    expect(events[0].conversation).toMatchObject({ conversation_id: 'c_new' });
  });

  it('does not emit an advance event when the fire fails', async () => {
    const { runner, drv } = await load();
    await drv.writeConfig(UID, PID, { enabled: true });
    const events: unknown[] = [];
    runner.onAdvance((e) => events.push(e));
    const advance = vi.fn(async () => ({ ok: false }));
    await runner.advanceProjectIfDue(UID, PID, deps({ advance }));
    expect(events).toHaveLength(0);
  });
});
