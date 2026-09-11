import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Collaboration-fabric end-to-end loop (deterministic, no model).
 *
 * Drives a realistic product-dev backlog through the whole fabric — the P3
 * driver picks the next actionable task (honoring dependencies + guardrails),
 * the "commander" turn advances it on the board, the P1 human review gate
 * approves or requests changes, and progress rolls up — using the REAL
 * projects / todo_tasks / project_driver / runner feature layer. Only the one
 * genuinely model-driven step, spawning the advance conversation, is injected
 * (via the runner's `deps.advance`), because the real commander's decisions are
 * covered separately by the L4 benchmark. Everything else is exercised for real.
 *
 * Code-task deliverables are represented as `result_ref` pointers (PR refs) — the
 * code-vertical convention (code lives in the repo, not 资料库). The 资料库
 * write-back tool (`library_save`) is unit-tested in library-save-tool.test.ts.
 */

// Mock the model client (projects cascade + any transitive import) and the
// runner's live-fire feature deps, which the modules import but this test never
// calls (the fire is injected).
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel() { yield { type: 'final', text: '' }; yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));
vi.mock('../../../src/main/features/chats', () => ({
  createConversation: vi.fn(), deleteConversation: vi.fn(),
}));
vi.mock('../../../src/main/features/group_chat', () => ({
  send: vi.fn(), busIsQuiescent: () => true,
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'uE2E';
const BOUND = 'a1b2c3d4e5f6';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-fabric-e2e-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});
afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const load = async () => ({
  projects: await import('../../../src/main/features/projects'),
  pt: await import('../../../src/main/features/project_tasks'),
  drv: await import('../../../src/main/features/project_driver'),
  runner: await import('../../../src/main/features/project_driver_runner'),
});

describe('fabric pipeline e2e', () => {
  it('drives a product-dev backlog: driver → review → decideReview → done, honoring deps + guardrails', async () => {
    const { projects, pt, drv, runner } = await load();

    // 1. Project + a bound dev agent + driver enabled.
    const created = await projects.createProject(UID, 'ProductDev');
    if (!created.ok) throw new Error('createProject failed');
    const pid = created.project.project_id;
    await projects.addAgentBinding(UID, pid, BOUND);
    await drv.writeConfig(UID, pid, { enabled: true });

    // 2. Seed the engineering backlog: a bug (A) and a feature (B) that depends
    //    on the bug fix. B must not be actionable until A is resolved.
    const A = await pt.createTask(UID, pid, { title: '修复登录跳转 bug', owner_agent: 'Dev', owner_agent_id: BOUND });
    const B = await pt.createTask(UID, pid, { title: '实现新导出功能', depends_on: [A.ok ? A.task.id : ''], owner_agent: 'Dev', owner_agent_id: BOUND });
    if (!A.ok || !B.ok) throw new Error('seed failed');
    expect(pt.computeProgress(await pt.listTasks(UID, pid))).toMatchObject({ total: 2, done: 0, open: 2 });

    // Injected driver seams: real backlog, controllable clock + conversation
    // liveness, and a stubbed fire that records which task the driver picked.
    let clock = new Date(2026, 0, 1, 10, 0, 0).getTime();
    let convoRunning = false; // whether the fired advance's conversation is still working
    const fired: string[] = [];
    const deps = {
      now: () => clock,
      listTasks: (u: string, p: string) => pt.listTasks(u, p),
      isQuiescent: () => !convoRunning,
      advance: async (_u: string, _p: string, task: import('../../../src/main/features/project_tasks').ProjectTask) => {
        fired.push(task.id); convoRunning = true; return { ok: true, cid: 'c_' + task.id };
      },
    };

    // 3. Driver advance #1 → must pick A (B is blocked by its dependency).
    expect(await runner.advanceProjectIfDue(UID, pid, deps)).toBe('advanced');
    expect(fired).toEqual([A.task.id]);
    expect((await drv.readState(UID, pid)).lease_cid).toBe('c_' + A.task.id);

    // 4. skip-if-running: while A's conversation is still working, the next tick
    //    must NOT fire another advance.
    clock += 3 * 60 * 1000; // past the cooldown, so 'running' is the reason, not cooldown
    expect(await runner.advanceProjectIfDue(UID, pid, deps)).toBe('running');
    expect(fired).toEqual([A.task.id]);

    // 5. The commander turn works A on the board: progress → deliver → review.
    //    Deliverable is a PR ref (code lives in the repo).
    await pt.updateTask(UID, pid, A.task.id, { status: 'progress' });
    await pt.updateTask(UID, pid, A.task.id, { status: 'review', result_ref: 'pr#101' });
    convoRunning = false; // the advance conversation finished its turn

    // 6. A awaits human review and B is still dep-blocked → nothing actionable.
    clock += 3 * 60 * 1000;
    expect(await runner.advanceProjectIfDue(UID, pid, deps)).toBe('no_actionable_task');
    expect(fired).toEqual([A.task.id]);
    expect(pt.computeProgress(await pt.listTasks(UID, pid))).toMatchObject({ total: 2, done: 0, open: 2, by_status: expect.objectContaining({ review: 1 }) });

    // 7. Human approves A → done. Progress rolls up; B's dependency is now resolved.
    const decA = await pt.decideReview(UID, pid, A.task.id, 'approved');
    expect(decA.ok).toBe(true);
    if (decA.ok) expect(decA.task.status).toBe('done');
    expect(pt.computeProgress(await pt.listTasks(UID, pid))).toMatchObject({ total: 2, done: 1, open: 1 });

    // 8. Driver advance #2 → now B is actionable.
    clock += 3 * 60 * 1000;
    expect(await runner.advanceProjectIfDue(UID, pid, deps)).toBe('advanced');
    expect(fired).toEqual([A.task.id, B.task.id]);
    await pt.updateTask(UID, pid, B.task.id, { status: 'progress' });
    await pt.updateTask(UID, pid, B.task.id, { status: 'review', result_ref: 'pr#102' });
    convoRunning = false;

    // 9. Human requests changes on B → back to progress (not done).
    const decB1 = await pt.decideReview(UID, pid, B.task.id, 'changes_requested');
    expect(decB1.ok).toBe(true);
    if (decB1.ok) expect(decB1.task.status).toBe('progress');
    expect(pt.computeProgress(await pt.listTasks(UID, pid))).toMatchObject({ total: 2, done: 1, open: 1 });

    // 10. Rework → review again → approve → done. Backlog complete.
    await pt.updateTask(UID, pid, B.task.id, { status: 'review', result_ref: 'pr#102-v2' });
    const decB2 = await pt.decideReview(UID, pid, B.task.id, 'approved');
    expect(decB2.ok).toBe(true);
    if (decB2.ok) expect(decB2.task.status).toBe('done');
    expect(pt.computeProgress(await pt.listTasks(UID, pid))).toMatchObject({ total: 2, done: 2, open: 0 });

    // 11. Backlog complete → the driver has nothing left to advance.
    clock += 3 * 60 * 1000;
    expect(await runner.advanceProjectIfDue(UID, pid, deps)).toBe('no_actionable_task');
    expect(fired).toEqual([A.task.id, B.task.id]);
  });

  it('a disabled driver never advances, even with an actionable backlog', async () => {
    const { projects, pt, drv, runner } = await load();
    const created = await projects.createProject(UID, 'P2');
    if (!created.ok) throw new Error('createProject failed');
    const pid = created.project.project_id;
    await pt.createTask(UID, pid, { title: 'ready task' });
    await drv.writeConfig(UID, pid, { enabled: false }); // opt-in default OFF
    const advance = vi.fn(async () => ({ ok: true, cid: 'x' }));
    expect(await runner.advanceProjectIfDue(UID, pid, {
      now: () => Date.now(), listTasks: (u, p) => pt.listTasks(u, p), isQuiescent: () => true, advance,
    })).toBe('disabled');
    expect(advance).not.toHaveBeenCalled();
  });
});
