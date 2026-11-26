/**
 * Commander project continuity through the real runner assembly
 * (Common/docs/plans/commander-project-continuity.md §3.4, appendix A.1-A.2).
 *
 * The goal block sits in the stable prefix right after the project
 * instructions; Commander also gets how to use it and a named Agent the facts
 * only. The "since the user was last here" block rides the turn tail of the
 * project Commander replying to the user, once per run, and never on a turn
 * the host started to run a to-do. Real buildRunner wiring and stores; no
 * model or network call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

const uid = 'project-continuity-user';
let root: string;
let previous: string | undefined;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-continuity-e2e-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser(uid);
  const auth = await import('../../../src/main/features/auth');
  const profile = await auth.addApiKey('anthropic', 'synthetic-no-network-key', 'Fixture');
  await auth.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: profile.profileId });
});

afterEach(async () => {
  await (await import('../../../src/main/features/search/indexer')).flushAll();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const projects = await import('../../../src/main/features/projects');
  const chats = await import('../../../src/main/features/chats');
  const goals = await import('../../../src/main/features/project_goal');
  const tasks = await import('../../../src/main/features/project_tasks');
  const recap = await import('../../../src/main/features/project_recap');
  const { buildRunner } = await import('../../../src/main/model/core-agent/runner');
  const created = await projects.createProject(uid, '店铺运营');
  if (!created.ok) throw new Error('project fixture failed');
  const pid = created.project.project_id;
  const here = (await chats.createConversation(uid, { title: '今天', projectId: pid })).conversation_id;
  const elsewhere = (await chats.createConversation(uid, { title: '昨天', projectId: pid })).conversation_id;
  const build = (cid: string, extra: Record<string, unknown> = {}) => buildRunner({
    sessionId: extra.agentId ? `gmember-${cid}-${extra.agentId}` : `gconv-${cid}`,
    userId: uid, cid, projectId: pid, ...extra,
  });
  return { projects, chats, goals, tasks, recap, pid, here, elsewhere, build };
}

describe('project continuity › real runner assembly', () => {
  it('withholds an existing goal from new Commander and named Agent turns while keeping project rules', async () => {
    vi.stubEnv('ORKAS_PROJECT_RECAP_TAB_ENABLED', undefined);
    const { projects, goals, pid, here, build } = await fixture();
    expect((await projects.writeProjectInstructions(uid, pid, 'Keep applying this project rule.')).ok).toBe(true);
    expect((await goals.saveProjectGoal(uid, pid, { goal: 'Previously saved project objective' }, 'ui')).ok).toBe(true);
    for (const options of [{}, { agentId: 'a_writer' }]) {
      const built = await build(here, options);
      expect(built.resolvedSystemPrompt).toContain('Keep applying this project rule.');
      expect(built.resolvedSystemPrompt + built.turnEphemeral).not.toContain('Previously saved project objective');
    }
    expect(await goals.readProjectGoal(uid, pid)).toMatchObject({ goal: 'Previously saved project objective' });
  });

  it('puts the goal right after the project instructions: Commander with how to use it, a named Agent the facts only', async () => {
    vi.stubEnv('ORKAS_PROJECT_RECAP_TAB_ENABLED', '1');
    const { projects, goals, pid, here, build } = await fixture();
    expect((await projects.writeProjectInstructions(uid, pid, '报表金额一律用人民币元。')).ok).toBe(true);
    expect((await goals.saveProjectGoal(uid, pid, {
      goal: '三个月内把店铺月销\n做到 10 万', success_criteria: ['月销连续两个月不低于 10 万', '退货率不高于 5%'],
    }, 'ui')).ok).toBe(true);

    const commander = (await build(here)).resolvedSystemPrompt;
    const rules = commander.indexOf('## Project instructions (user-authored)');
    const goal = commander.indexOf('## Project goal (user-set)');
    expect(rules).toBeGreaterThanOrEqual(0);
    expect(goal).toBeGreaterThan(rules);
    expect(commander.slice(goal)).toMatch(/^## Project goal \(user-set\)\n\nGoal: 三个月内把店铺月销 做到 10 万\n/);
    expect(commander).toContain('Success criteria: 1) 月销连续两个月不低于 10 万; 2) 退货率不高于 5%\nStatus: active\n\n'
      + "- Plan, prioritize and report the project's work against this goal.\n"
      + '- When the evidence shows the goal is reached (every success criterion met, if any are set), propose marking it achieved and cite the evidence; mark it achieved only after the user agrees.');
    // The goal is stable configuration, never this turn's volatile tail.
    expect((await build(here)).turnEphemeral).not.toContain('## Project goal');

    const agent = (await build(here, { agentId: 'a_writer' })).resolvedSystemPrompt;
    expect(agent).toContain('Goal: 三个月内把店铺月销 做到 10 万');
    expect(agent).toContain('Status: active');
    expect(agent).not.toContain('propose marking it achieved');
    expect(agent).not.toContain("against this goal");

    expect((await goals.saveProjectGoal(uid, pid, { success_criteria: [], status: 'achieved' }, 'ui')).ok).toBe(true);
    expect((await build(here)).resolvedSystemPrompt).toContain('Success criteria: none set\nStatus: achieved');
    expect((await goals.saveProjectGoal(uid, pid, { goal: '' }, 'ui')).ok).toBe(true);
    expect((await build(here)).resolvedSystemPrompt).not.toContain('## Project goal');
  });

  it('tells the Commander the project news once per run, and never on a turn the host started to run a to-do', async () => {
    const { tasks, recap, pid, here, elsewhere, build } = await fixture();
    const created = await tasks.createTask(uid, pid, { content: 'Q4 新品清单' });
    if (!created.ok) throw new Error(created.error);
    await tasks.recordTaskExecution(uid, pid, created.task.id, elsewhere);
    expect((await tasks.updateTask(uid, pid, created.task.id, { status: 'review', note: '清单在资料库 q4-list.xlsx', note_kind: 'result' })).ok).toBe(true);
    // A digest covers the whole seconds before it; the user comes back in the next one.
    await new Promise((resolve) => setTimeout(resolve, 1020 - (Date.now() % 1000)));

    // A to-do run the host started may have no reader: no news, nothing recorded.
    const hostRun = await build(here, { hostTodoRun: true });
    expect(hostRun.turnEphemeral).not.toContain('## Since the user was last here');
    expect(recap.recapShownInCurrentRun(uid, here)).toBe(false);
    // A named Agent gets its work from the dispatch, not the news.
    expect((await build(here, { agentId: 'a_writer', outputDelivery: 'final' })).turnEphemeral).not.toContain('## Since the user was last here');

    const commander = await build(here);
    expect(commander.turnEphemeral).toContain('## Since the user was last here');
    expect(commander.turnEphemeral).toContain(`- Awaiting the user's review (1): ${created.task.id} "Q4 新品清单"`);
    expect(commander.turnEphemeral).toContain('note: "清单在资料库 q4-list.xlsx"');
    expect(commander.resolvedSystemPrompt).not.toContain('## Since the user was last here');
    expect(recap.recapShownInCurrentRun(uid, here)).toBe(true);
    // A later Commander turn of the same run has already told the user.
    expect((await build(here)).turnEphemeral).not.toContain('## Since the user was last here');
    // The record has not moved yet: that waits for the run to deliver.
    expect(await recap.readSeenAt(uid, pid, 'commander')).toBeNull();
  });
});
