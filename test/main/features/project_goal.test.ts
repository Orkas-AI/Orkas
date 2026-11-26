/**
 * Project goal store (Common/docs/plans/commander-project-continuity.md §3.2(1)).
 *
 * The goal is optional: a project without one has no goal.json and everything
 * else works the same. It lives in its own file because older clients rewrite
 * project.json with only the fields they know, so a goal stored there would be
 * lost the first time such a client renamed the project. What only this store
 * can get wrong: a refused value that still writes, a cleared goal that
 * survives on disk, a save that drops a field a newer version wrote, a repeated
 * save that churns sync, and a shared project that silently gains a goal its
 * members can never see.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u-project-goal';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-goal-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser(UID);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setup() {
  const projects = await import('../../../src/main/features/projects');
  const goals = await import('../../../src/main/features/project_goal');
  const { projectGoalFile, projectMetaFile } = await import('../../../src/main/paths');
  const created = await projects.createProject(UID, '店铺运营');
  if (!created.ok) throw new Error('project fixture failed');
  const pid = created.project.project_id;
  return { projects, goals, pid, file: projectGoalFile(UID, pid), meta: projectMetaFile(UID, pid) };
}

describe('project goal store', () => {
  it('saves a goal with or without criteria, reads it back, and treats a project without the file as having no goal', async () => {
    const { goals, pid, file } = await setup();
    expect(await goals.readProjectGoal(UID, pid)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
    const saved = await goals.saveProjectGoal(UID, pid, { goal: '  把店铺月销做到 10 万  ' }, 'ui');
    expect(saved).toMatchObject({ ok: true, action: 'set', goal: { goal: '把店铺月销做到 10 万', success_criteria: [], status: 'active', achieved_at: null } });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ goal: '把店铺月销做到 10 万', success_criteria: [], status: 'active' });
    expect(goals.readProjectGoalSync(UID, pid)).toEqual(await goals.readProjectGoal(UID, pid));
    const edited = await goals.saveProjectGoal(UID, pid, { success_criteria: ['  月销连续两个月不低于 10 万 '] }, 'ui');
    expect(edited).toMatchObject({ ok: true, action: 'edit', goal: { goal: '把店铺月销做到 10 万', success_criteria: ['月销连续两个月不低于 10 万'] } });
  });

  it('refuses an over-long goal, too many or blank or over-long criteria, a paused status and criteria with no goal, writing nothing', async () => {
    const { goals, pid, file } = await setup();
    const refused: string[] = [];
    for (const patch of [
      { goal: 'x'.repeat(401) },
      { goal: '目标', success_criteria: ['1', '2', '3', '4', '5', '6'] },
      { goal: '目标', success_criteria: ['x'.repeat(201)] },
      { goal: '目标', success_criteria: ['  '] },
      { goal: '目标', status: 'paused' },
      { success_criteria: ['只有标准'] },
      { status: 'achieved' },
    ]) {
      const result = await goals.saveProjectGoal(UID, pid, patch, 'agent');
      expect(result.ok).toBe(false);
      if (!result.ok) refused.push(result.error);
    }
    expect(fs.existsSync(file)).toBe(false);
    expect(refused).toEqual(['goal_too_long', 'criteria_too_many', 'criterion_too_long', 'criteria_invalid', 'status_invalid', 'goal_not_set', 'goal_not_set']);
    // The bounds themselves are accepted.
    expect((await goals.saveProjectGoal(UID, pid, { goal: 'x'.repeat(400), success_criteria: ['y'.repeat(200), '2', '3', '4', '5'] }, 'agent')).ok).toBe(true);
  });

  it('marks the goal achieved once, keeps that time on a repeat, reopens it, and clears it by deleting the file', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { goals, pid, file } = await setup();
    vi.setSystemTime(new Date('2026-11-16T08:00:00'));
    await goals.saveProjectGoal(UID, pid, { goal: '把店铺月销做到 10 万' }, 'ui');
    vi.setSystemTime(new Date('2026-11-20T09:00:00'));
    const achieved = await goals.saveProjectGoal(UID, pid, { status: 'achieved' }, 'agent');
    expect(achieved).toMatchObject({ ok: true, action: 'achieve', goal: { status: 'achieved' } });
    const at = (achieved as { goal: { achieved_at: string } }).goal.achieved_at;
    expect(Date.parse(at)).toBe(Date.parse('2026-11-20T09:00:00'));
    vi.setSystemTime(new Date('2026-11-21T09:00:00'));
    // Saving the same state again is not a change: nothing is written or reported.
    const before = fs.readFileSync(file, 'utf8');
    expect(await goals.saveProjectGoal(UID, pid, { status: 'achieved' }, 'ui')).toMatchObject({ ok: true, action: null });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    // An edit to an achieved goal keeps it achieved and keeps when it was reached.
    expect(await goals.saveProjectGoal(UID, pid, { goal: '把店铺月销做到 10 万元' }, 'ui'))
      .toMatchObject({ ok: true, action: 'edit', goal: { status: 'achieved', achieved_at: at } });
    expect(await goals.saveProjectGoal(UID, pid, { status: 'active' }, 'ui'))
      .toMatchObject({ ok: true, action: 'reopen', goal: { status: 'active', achieved_at: null } });
    expect(await goals.saveProjectGoal(UID, pid, { goal: '' }, 'ui')).toEqual({ ok: true, goal: null, action: 'clear' });
    expect(fs.existsSync(file)).toBe(false);
    expect(await goals.readProjectGoal(UID, pid)).toBeNull();
    // Clearing a project that has no goal is not a change either.
    expect(await goals.saveProjectGoal(UID, pid, { goal: '' }, 'ui')).toEqual({ ok: true, goal: null, action: null });
  });

  it('survives an older client rewriting project.json, reads an unreadable file as no goal, and keeps fields a newer version wrote', async () => {
    const { projects, goals, pid, file, meta } = await setup();
    await goals.saveProjectGoal(UID, pid, { goal: '把店铺月销做到 10 万', success_criteria: ['退货率不高于 5%'] }, 'ui');
    // An older client renaming the project writes only the fields it knows.
    const known = JSON.parse(fs.readFileSync(meta, 'utf8'));
    fs.writeFileSync(meta, JSON.stringify({ project_id: known.project_id, name: '店铺运营 2026', created_at: known.created_at, updated_at: known.updated_at }));
    expect((await projects.getProject(UID, pid))?.name).toBe('店铺运营 2026');
    expect(await goals.readProjectGoal(UID, pid)).toMatchObject({ goal: '把店铺月销做到 10 万', success_criteria: ['退货率不高于 5%'] });

    // A newer version's status and fields survive an edit from this one.
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), status: 'paused', attention: { kind: 'blocked' } }));
    expect(await goals.readProjectGoal(UID, pid)).toMatchObject({ status: 'active' });
    expect((await goals.saveProjectGoal(UID, pid, { goal: '把店铺月销做到 12 万' }, 'ui')).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ goal: '把店铺月销做到 12 万', status: 'paused', attention: { kind: 'blocked' } });

    fs.writeFileSync(file, '{"goal": "torn');
    expect(await goals.readProjectGoal(UID, pid)).toBeNull();
    expect(goals.readProjectGoalSync(UID, pid)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ goal: '   ', success_criteria: ['x'] }));
    expect(await goals.readProjectGoal(UID, pid)).toBeNull();
    // A synced file past the bounds is clipped for reading, never trusted whole.
    fs.writeFileSync(file, JSON.stringify({ goal: 'g'.repeat(500), success_criteria: ['c'.repeat(300), 1, '', '2', '3', '4', '5', '6'], status: 'achieved', achieved_at: '2026-11-01T08:00:00' }));
    const clipped = await goals.readProjectGoal(UID, pid);
    expect(clipped?.goal).toHaveLength(400);
    expect(clipped?.success_criteria).toEqual(['c'.repeat(200), '2', '3', '4', '5']);
    expect(clipped).toMatchObject({ status: 'achieved', achieved_at: '2026-11-01T08:00:00' });
  });

  it('refuses a missing project without writing a goal', async () => {
    const { goals, file } = await setup();
    expect(await goals.saveProjectGoal(UID, 'p_missing', { goal: '目标' }, 'ui')).toEqual({ ok: false, error: 'project_not_found' });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('tells listeners about each saved change and nothing else', async () => {
    const { goals, pid } = await setup();
    const changed: string[] = [];
    goals.onProjectGoalChanged((event) => changed.push(`${event.uid}:${event.projectId}`));
    await goals.saveProjectGoal(UID, pid, { goal: '目标' }, 'ui');
    await goals.saveProjectGoal(UID, pid, { goal: '目标' }, 'ui');
    await goals.saveProjectGoal(UID, pid, { goal: 'x'.repeat(401) }, 'ui');
    await goals.saveProjectGoal(UID, pid, { goal: '' }, 'ui');
    expect(changed).toEqual([`${UID}:${pid}`, `${UID}:${pid}`]);
  });
});
