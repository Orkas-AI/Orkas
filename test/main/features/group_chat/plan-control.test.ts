import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

function newCid(): string { return 'c' + Math.random().toString(16).slice(2, 13); }

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-plan-control-'));
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

async function seedPlan(cid: string) {
  const plan = await import('../../../../src/main/features/group_chat/plan');
  await plan.setPlan(TEST_UID, cid, {
    steps: [
      { title: 'collect', assignee: 'commander', wait_for: [] },
      { title: 'review', assignee: 'commander' },
    ],
  });
  return plan;
}

async function controlAction(cid: string) {
  const groupChat = await import('../../../../src/main/features/group_chat');
  const res = await groupChat.readPlanForCid(TEST_UID, cid);
  expect(res.ok).toBe(true);
  return res.control?.action ?? null;
}

async function readPlanPayload(cid: string) {
  const groupChat = await import('../../../../src/main/features/group_chat');
  const res = await groupChat.readPlanForCid(TEST_UID, cid);
  expect(res.ok).toBe(true);
  return res;
}

describe('group_chat plan control state', () => {
  it('shows stop while the runtime is running, including in_flight-only snapshots', async () => {
    const state = await import('../../../../src/main/features/group_chat/state');

    const runningCid = newCid();
    await seedPlan(runningCid);
    await state.setStatus(TEST_UID, runningCid, 'running');
    expect(await controlAction(runningCid)).toBe('stop');

    const inFlightCid = newCid();
    await seedPlan(inFlightCid);
    await state.markInFlight(TEST_UID, inFlightCid, 'commander', true);
    expect(await controlAction(inFlightCid)).toBe('stop');
  });

  it('shows continue for recoverable plan states when no worker is active', async () => {
    const failedCid = newCid();
    let plan = await seedPlan(failedCid);
    await plan.updateStep(TEST_UID, failedCid, 1, 'failed', { failure_reason: 'network failed' });
    expect(await controlAction(failedCid)).toBe('continue');

    const staleCid = newCid();
    plan = await seedPlan(staleCid);
    await plan.updateStep(TEST_UID, staleCid, 1, 'in_progress');
    expect(await controlAction(staleCid)).toBe('continue');

    const readyCid = newCid();
    await seedPlan(readyCid);
    expect(await controlAction(readyCid)).toBe('continue');
  });

  it('hides the control for fully completed plans', async () => {
    const cid = newCid();
    const plan = await seedPlan(cid);
    await plan.updateStep(TEST_UID, cid, 1, 'done');
    await plan.updateStep(TEST_UID, cid, 2, 'skipped', { failure_reason: 'not needed' });

    expect(await controlAction(cid)).toBeNull();
  });

  it('does not return a fully completed plan even when a new worker is active', async () => {
    const state = await import('../../../../src/main/features/group_chat/state');
    const cid = newCid();
    const plan = await seedPlan(cid);
    await plan.updateStep(TEST_UID, cid, 1, 'done');
    await plan.updateStep(TEST_UID, cid, 2, 'done');
    await state.markInFlight(TEST_UID, cid, 'some-agent', true);

    const payload = await readPlanPayload(cid);
    expect(payload.plan).toBeNull();
    expect(payload.control?.action).toBeNull();
  });
});
