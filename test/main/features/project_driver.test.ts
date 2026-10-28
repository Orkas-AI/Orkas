import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { ProjectTask, TaskStatus } from '../../../src/main/features/project_tasks';
import * as driver from '../../../src/main/features/project_driver';

function mkTask(id: string, status: TaskStatus, depends_on?: string[]): ProjectTask {
  return {
    id, content: id, status, created_by: 'user',
    created_at: '2026-07-21T00:00:00.000Z', updated_at: '2026-07-21T00:00:00.000Z',
    ...(depends_on ? { depends_on } : {}),
  };
}

const CFG_ON: driver.DriverConfig = { enabled: true, max_advances_per_day: 20 };
// A fixed local-time clock so the daily-cap date is machine-TZ-independent.
const DAY1 = new Date(2026, 6, 21, 10, 0, 0).getTime();
const DAY2 = new Date(2026, 6, 22, 10, 0, 0).getTime();

describe('project_driver › nextActionableTask', () => {
  it('picks the first todo whose deps are all resolved, in backlog order', () => {
    const tasks = [
      mkTask('t_a', 'progress'),
      mkTask('t_b', 'todo'),
      mkTask('t_c', 'todo'),
    ];
    expect(driver.nextActionableTask(tasks)?.id).toBe('t_b');
  });

  it('advances the actionable todo due soonest before undated ones, keeping backlog order among equals', () => {
    const dated = (id: string, due_at: string, depends_on?: string[]) => ({ ...mkTask(id, 'todo', depends_on), due_at });
    const tasks = [
      mkTask('t_first', 'todo'),
      dated('t_later', '2026-11-02'),
      dated('t_soon', '2026-10-25'),
      dated('t_blocked_sooner', '2026-10-20', ['t_open']),
      mkTask('t_open', 'progress'),
    ];
    // The soonest due date wins over backlog position; a dated task whose
    // dependency is still open does not count.
    expect(driver.nextActionableTask(tasks)?.id).toBe('t_soon');
    // Without dates the first actionable task in backlog order is chosen.
    expect(driver.nextActionableTask([mkTask('t_a', 'todo'), mkTask('t_b', 'todo')])?.id).toBe('t_a');
    // Equal dates fall back to backlog order too.
    expect(driver.nextActionableTask([dated('t_x', '2026-10-25'), dated('t_y', '2026-10-25')])?.id).toBe('t_x');
  });

  it('skips non-todo statuses (progress / review / done)', () => {
    for (const s of ['progress', 'review', 'done'] as TaskStatus[]) {
      expect(driver.nextActionableTask([mkTask('t_x', s)])).toBeNull();
    }
    expect(driver.nextActionableTask([])).toBeNull();
  });

  it('honors depends_on: a todo with an OPEN dependency is not actionable', () => {
    const dep = mkTask('t_dep', 'progress');
    const t = mkTask('t_main', 'todo', ['t_dep']);
    expect(driver.nextActionableTask([dep, t])).toBeNull();
    dep.status = 'done';
    expect(driver.nextActionableTask([dep, t])?.id).toBe('t_main');
    dep.status = 'todo'; // A reopened dependency must be worked before its dependent.
    expect(driver.nextActionableTask([t, dep])?.id).toBe('t_dep');
  });

  it('treats a missing dependency id as resolved (stale ref cannot deadlock)', () => {
    expect(driver.nextActionableTask([mkTask('t_m', 'todo', ['t_gone'])])?.id).toBe('t_m');
  });
});

describe('project_driver › decideAdvance guardrails', () => {
  const actionable = [mkTask('t_1', 'todo')];

  it('disabled → no advance, state untouched', () => {
    const state = { last_advance_at: 'x' };
    const r = driver.decideAdvance({ enabled: false, max_advances_per_day: 20 }, state, DAY1, actionable, false);
    expect(r.decision).toEqual({ advance: false, reason: 'disabled' });
    expect(r.nextState).toBe(state);
  });

  it('a fresh, still-running lease blocks the advance', () => {
    const state = { lease_cid: 'c1', lease_at: new Date(DAY1 - 60_000).toISOString() };
    const r = driver.decideAdvance(CFG_ON, state, DAY1, actionable, true);
    expect(r.decision).toEqual({ advance: false, reason: 'running' });
    expect(r.nextState.lease_cid).toBe('c1');
  });

  it('releases the lease when the advance conversation is quiescent, then advances', () => {
    const state = { lease_cid: 'c1', lease_at: new Date(DAY1 - 60_000).toISOString() };
    const r = driver.decideAdvance(CFG_ON, state, DAY1, actionable, false);
    expect(r.decision.advance).toBe(true);
    expect(r.nextState.lease_cid).toBeUndefined();
  });

  it('releases a stuck lease (aged past TTL) even if it still reports running', () => {
    const state = { lease_cid: 'c1', lease_at: new Date(DAY1 - (driver.STUCK_LEASE_TTL_MS + 1000)).toISOString() };
    const r = driver.decideAdvance(CFG_ON, state, DAY1, actionable, true);
    expect(r.decision.advance).toBe(true);
    expect(r.nextState.lease_cid).toBeUndefined();
  });

  it('cooldown: too soon since the last advance → no advance', () => {
    const state = { last_advance_at: new Date(DAY1 - (driver.MIN_ADVANCE_INTERVAL_MS - 1000)).toISOString() };
    const r = driver.decideAdvance(CFG_ON, state, DAY1, actionable, false);
    expect(r.decision).toEqual({ advance: false, reason: 'cooldown' });
  });

  it('daily cap: at the cap → no advance; a new local day resets the count', () => {
    const capped = { advance_date: '2026-07-21', advance_count: 20 };
    expect(driver.decideAdvance(CFG_ON, capped, DAY1, actionable, false).decision)
      .toEqual({ advance: false, reason: 'daily_cap' });
    // Same state, but the clock is the next day → count resets, advance allowed.
    const r = driver.decideAdvance(CFG_ON, capped, DAY2, actionable, false);
    expect(r.decision.advance).toBe(true);
    expect(r.nextState.advance_count).toBe(1);
    expect(r.nextState.advance_date).toBe('2026-07-22');
  });

  it('no actionable task → no advance', () => {
    const r = driver.decideAdvance(CFG_ON, {}, DAY1, [mkTask('t_d', 'done')], false);
    expect(r.decision).toEqual({ advance: false, reason: 'no_actionable_task' });
  });

  it('all clear → advance, records count + timestamp', () => {
    const r = driver.decideAdvance(CFG_ON, { advance_date: '2026-07-21', advance_count: 3 }, DAY1, actionable, false);
    expect(r.decision).toEqual({ advance: true, task: actionable[0] });
    expect(r.nextState.advance_count).toBe(4);
    expect(r.nextState.last_advance_at).toBe(new Date(DAY1).toISOString());
  });
});

describe('project_driver › config + state IO', () => {
  let tmpDir: string;
  let prevWs: string | undefined;
  const UID = 'uDRV';
  const PID = 'p_112233445566';

  // paths.ts freezes WS_ROOT at import, so reset + dynamic-import per test to
  // pick up the fresh tmpDir (mirrors project_tasks.test.ts).
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-driver-'));
    prevWs = process.env.ORKAS_WORKSPACE_ROOT;
    process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.env.ORKAS_WORKSPACE_ROOT = prevWs;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const load = () => import('../../../src/main/features/project_driver');

  it('config defaults to disabled when absent, round-trips, and clamps the cap', async () => {
    const drv = await load();
    expect(await drv.readConfig(UID, PID)).toEqual({ enabled: false, max_advances_per_day: drv.DEFAULT_MAX_ADVANCES_PER_DAY });
    const w = await drv.writeConfig(UID, PID, { enabled: true, max_advances_per_day: 9999 });
    expect(w.enabled).toBe(true);
    expect(w.max_advances_per_day).toBe(200); // clamped to cap
    expect(await drv.readConfig(UID, PID)).toEqual(w);
    const lowered = await drv.writeConfig(UID, PID, { max_advances_per_day: 0 });
    expect(lowered).toEqual({ ...w, max_advances_per_day: 1 }); // owner and enabled preserved, floor 1
  });

  it.each([PID, ''])('binds enables to the caller and allows another device to disable then take over (%s)', async pid => {
    const drv = await load();
    const machine = await import('../../../src/main/features/machine_device_id');
    const device = await import('../../../src/main/util/device');
    const identity = vi.spyOn(machine, 'getDeviceId').mockReturnValue('device-a');
    vi.spyOn(device, 'getCurrentDevice').mockReturnValue({ id: 'legacy-a', name: 'Desktop A' });
    const a = await drv.writeConfig(UID, pid, { enabled: true });
    expect(a).toMatchObject({ enabled: true, device_id: 'device-a', device_name: 'Desktop A' });
    expect(drv.runsOnCurrentDevice(await drv.readConfig(UID, pid))).toBe(true);

    // A synced file keeps its owner even when edited from another installation.
    identity.mockReturnValue('device-b');
    vi.mocked(device.getCurrentDevice).mockReturnValue({ id: 'legacy-b', name: 'Laptop B' });
    const edited = await drv.writeConfig(UID, pid, { max_advances_per_day: 7 });
    expect(edited).toMatchObject({ device_id: 'device-a', device_name: 'Desktop A', max_advances_per_day: 7 });
    expect(drv.runsOnCurrentDevice(edited)).toBe(false);
    expect(await drv.writeConfig(UID, pid, { enabled: false })).toEqual({ enabled: false, max_advances_per_day: 7 });
    const b = await drv.writeConfig(UID, pid, { enabled: true });
    expect(b).toMatchObject({ enabled: true, device_id: 'device-b', device_name: 'Laptop B' });
    expect(drv.runsOnCurrentDevice(await drv.readConfig(UID, pid))).toBe(true);
    identity.mockReturnValue('device-a');
    expect(drv.runsOnCurrentDevice(await drv.readConfig(UID, pid))).toBe(false);
  });

  it('pauses old opt-ins without claiming them on read, then binds an explicit re-enable', async () => {
    const drv = await load();
    const { projectDriverFile } = await import('../../../src/main/paths');
    const file = projectDriverFile(UID, PID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy = JSON.stringify({ enabled: true, max_advances_per_day: 4 });
    fs.writeFileSync(file, legacy);
    const old = await drv.readConfig(UID, PID);
    expect(old).toEqual({ enabled: false, max_advances_per_day: 4 });
    expect(drv.runsOnCurrentDevice(old)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(legacy);
    // The displayed switch is already off, so one enable action is enough.
    const rebound = await drv.writeConfig(UID, PID, { enabled: true });
    expect(rebound).toMatchObject({ enabled: true, device_id: drv.getCurrentDevice().id });
  });

  it('config file lives under cloud/, state file under local/ (never synced)', async () => {
    const drv = await load();
    await drv.writeConfig(UID, PID, { enabled: true });
    await drv.writeState(UID, PID, { advance_count: 2, advance_date: '2026-07-21' });
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'projects', PID, 'driver.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, UID, 'local', 'projects', PID, 'driver-state.json'))).toBe(true);
  });

  it('stores the account-global backlog driver outside the task-json directory', async () => {
    const drv = await load();
    await drv.writeConfig(UID, '', { enabled: true });
    await drv.writeState(UID, '', { advance_count: 1, advance_date: '2026-07-21' });
    expect(await drv.readConfig(UID, '')).toMatchObject({ enabled: true });
    expect(await drv.readState(UID, '')).toMatchObject({ advance_count: 1 });
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'config', 'todo-driver.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, UID, 'local', 'config', 'todo-driver-state.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'tasks', 'todo-driver.json'))).toBe(false);
  });

  it('state defaults to empty and round-trips tolerantly', async () => {
    const drv = await load();
    expect(await drv.readState(UID, PID)).toEqual({});
    await drv.writeState(UID, PID, { last_advance_at: 'iso', advance_count: 5, advance_date: '2026-07-21', lease_cid: 'c9', lease_at: 'iso2' });
    expect(await drv.readState(UID, PID)).toEqual({ last_advance_at: 'iso', advance_count: 5, advance_date: '2026-07-21', lease_cid: 'c9', lease_at: 'iso2' });
  });
});
