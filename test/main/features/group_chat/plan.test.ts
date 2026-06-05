import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cid01';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-plan-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('group_chat plan', () => {
  it('setPlan replaces the plan and preserves created_at across re-plans', async () => {
    const plan = await import('../../../../src/main/features/group_chat/plan');
    const r1 = await plan.setPlan(TEST_UID, TEST_CID, {
      steps: [
        { title: 'gather data', assignee: 'commander' },
        { title: 'analyze', assignee: 'commander' },
      ],
    });
    expect(r1.plan.steps).toHaveLength(2);
    expect(r1.plan.steps[0].title).toBe('gather data');
    const createdAt = r1.plan.created_at;

    const r2 = await plan.setPlan(TEST_UID, TEST_CID, {
      steps: [
        { title: 'gather data', assignee: 'commander' },
        { title: 'analyze', assignee: 'commander' },
        { title: 'report', assignee: 'commander' },
      ],
    });
    expect(r2.plan.steps).toHaveLength(3);
    expect(r2.plan.created_at).toBe(createdAt);
  });

  it('updateStep flips status + applies patch fields', async () => {
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.setPlan(TEST_UID, TEST_CID, {
      steps: [
        { title: 'gather data', assignee: 'commander', notes: 'crawl X' },
        { title: 'analyze', assignee: 'commander' },
      ],
    });
    const updated = await plan.updateStep(TEST_UID, TEST_CID, 1, 'done', {
      notes: 'crawled 50 pages',
      output_summary: '50 pages of raw HTML',
      output_files: ['raw/data.json'],
    });
    expect(updated?.steps[0].status).toBe('done');
    expect(updated?.steps[0].notes).toBe('crawled 50 pages');
    expect(updated?.steps[0].output_summary).toBe('50 pages of raw HTML');
    expect(updated?.steps[0].output_files).toEqual(['raw/data.json']);
    // Step 2 untouched.
    expect(updated?.steps[1].status).toBe('pending');
  });

  it('formatPlanAnnouncement renders human-readable list with assignee chips', async () => {
    const plan = await import('../../../../src/main/features/group_chat/plan');
    const r = await plan.setPlan(TEST_UID, TEST_CID, {
      steps: [
        { title: 'gather data', assignee: 'Writer' },
        { title: 'analyze', assignee: 'commander' },
      ],
    });
    const ann = plan.formatPlanAnnouncement(r.plan);
    expect(ann).toContain('1. gather data（@Writer）');
    expect(ann).toMatch(/2\. analyze（(我自己|me)）/);
  });

  it('formatPlanForPrompt encodes status icons + assignee + output_summary', async () => {
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.setPlan(TEST_UID, TEST_CID, {
      steps: [
        { title: 'a', assignee: 'commander' },
        { title: 'b', assignee: 'Writer' },
      ],
    });
    await plan.updateStep(TEST_UID, TEST_CID, 1, 'done', { output_summary: '完成 a' });
    const updated = await plan.readPlan(TEST_UID, TEST_CID);
    const text = plan.formatPlanForPrompt(updated);
    expect(text).toContain('✓ Step 1: a [done]');
    expect(text).toContain('完成 a');
    expect(text).toContain('○ Step 2: b [pending]');
    expect(text).toContain('→ Writer');
  });

  it('round-trips full schema through JSON', async () => {
    const plan = await import('../../../../src/main/features/group_chat/plan');
    const r = await plan.setPlan(TEST_UID, TEST_CID, {
      initial_message: '我要做个 X',
      steps: [
        {
          title: '需求挖掘', assignee: '需求挖掘师',
          input: '基于 {{user_initial_message}} 整理需求',
          wait_for: [],
        },
        {
          title: '方案设计', assignee: '方案设计师',
          input: '基于 {{step_1.output_summary}} 出方案',
        },
        {
          title: '收尾', assignee: 'commander',
          wait_for: [1, 2],
        },
      ],
    });
    expect(r.plan.initial_message).toBe('我要做个 X');
    expect(r.plan.steps[0].input).toContain('user_initial_message');
    expect(r.plan.steps[0].wait_for).toEqual([]);
    expect(r.plan.steps[2].wait_for).toEqual([1, 2]);

    // Re-read from disk to confirm full schema survives JSON round-trip.
    const re = await plan.readPlan(TEST_UID, TEST_CID);
    expect(re?.initial_message).toBe('我要做个 X');
    expect(re?.steps[0].assignee).toBe('需求挖掘师');
    expect(re?.steps[2].assignee).toBe('commander');
    expect(re?.steps[2].wait_for).toEqual([1, 2]);
  });

  it('normalizes later empty wait_for back to default serial order', async () => {
    const plan = await import('../../../../src/main/features/group_chat/plan');
    const r = await plan.setPlan(TEST_UID, TEST_CID, {
      steps: [
        { title: 'a', assignee: 'A', wait_for: [] },
        { title: 'b', assignee: 'B', wait_for: [] },
        { title: 'c', assignee: 'C', wait_for: [] },
      ],
    });

    expect(r.plan.steps[0].wait_for).toEqual([]);
    expect(r.plan.steps[1].wait_for).toBeUndefined();
    expect(r.plan.steps[2].wait_for).toBeUndefined();
    expect(plan.findReadySteps(r.plan).map((s) => s.index)).toEqual([1]);
  });

  it('ignores legacy parallel_group and serializes later empty wait_for', async () => {
    const plan = await import('../../../../src/main/features/group_chat/plan');
    const r = await plan.setPlan(TEST_UID, TEST_CID, {
      steps: [
        { title: 'a', assignee: 'A', wait_for: [] },
        { title: 'b', assignee: 'B', wait_for: [], parallel_group: 'g1' },
        { title: 'c', assignee: 'C', wait_for: [], parallel_group: 'g1' },
        { title: 'd', assignee: 'D', wait_for: [1, 2, 3] },
      ],
    });
    expect(r.plan.steps.some((s) => s.parallel_group)).toBe(false);
    expect(r.plan.steps[1].wait_for).toBeUndefined();
    expect(r.plan.steps[2].wait_for).toBeUndefined();
    expect(plan.findReadySteps(r.plan).map((s) => s.index)).toEqual([1]);

    // Mark a + b done; c is the next serial step → d not ready yet.
    await plan.updateStep(TEST_UID, TEST_CID, 1, 'done');
    await plan.updateStep(TEST_UID, TEST_CID, 2, 'done');
    const mid = await plan.readPlan(TEST_UID, TEST_CID);
    expect(plan.findReadySteps(mid!).map((s) => s.index)).toEqual([3]);

    // Mark c done → d becomes ready.
    await plan.updateStep(TEST_UID, TEST_CID, 3, 'done');
    const after = await plan.readPlan(TEST_UID, TEST_CID);
    expect(plan.findReadySteps(after!).map((s) => s.index)).toEqual([4]);
  });

  it('isPlanTerminal — done | failed | skipped count as terminal; in_progress / blocked do not', async () => {
    const plan = await import('../../../../src/main/features/group_chat/plan');
    const r = await plan.setPlan(TEST_UID, TEST_CID, {
      steps: [
        { title: 'a', assignee: 'A' },
        { title: 'b', assignee: 'B' },
      ],
    });
    expect(plan.isPlanTerminal(r.plan)).toBe(false);
    await plan.updateStep(TEST_UID, TEST_CID, 1, 'done');
    await plan.updateStep(TEST_UID, TEST_CID, 2, 'failed');
    const after = await plan.readPlan(TEST_UID, TEST_CID);
    expect(plan.isPlanTerminal(after!)).toBe(true);
  });
});
