import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Watchdog scans a uid's `_index.json` for cids → checks state.json +
// plan.md → pings commander when stale. We test by setting up the
// on-disk fixtures and exercising the bus.pingCommanderForWatchdog
// hook directly (the periodic interval timer would slow tests down).

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = '12345678';
const TEST_CID = 'cidwd';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-wd-'));
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

async function setupConvWithStalePlan(opts: {
  staleMinutes: number;
  status?: 'idle' | 'running' | 'aborted';
  inProgressStep?: boolean;
}) {
  const paths = await import('../../../../src/main/paths');
  const chatsDir = paths.userChatsDir(TEST_UID);
  fs.mkdirSync(chatsDir, { recursive: true });
  // Write _index.json so watchdog sees this cid.
  fs.writeFileSync(path.join(chatsDir, '_index.json'), JSON.stringify([
    { conversation_id: TEST_CID, title: 't', kind: 'normal', agent_id: '', skill_id: '',
      session_id: '', created_at: 't', updated_at: 't' },
  ]));
  const groupDir = paths.groupChatDir(TEST_UID, TEST_CID);
  fs.mkdirSync(groupDir, { recursive: true });
  // state.json with last_active_at staleMinutes ago.
  const lastActive = new Date(Date.now() - opts.staleMinutes * 60_000).toISOString();
  fs.writeFileSync(path.join(groupDir, 'state.json'), JSON.stringify({
    version: 1,
    status: opts.status || 'running',
    last_active_at: lastActive,
    in_flight: opts.status === 'running' ? ['agent-x'] : [],
  }));
  // plan.md — optionally an in_progress step.
  if (opts.inProgressStep !== false) {
    const plan = `---\ncreated_at: t\nupdated_at: t\n---\n\n## Step 1: do thing\nStatus: in_progress\nAssignee: writer\n\n`;
    fs.writeFileSync(path.join(groupDir, 'plan.md'), plan);
  }
  // members.json so commander actor exists.
  fs.writeFileSync(path.join(groupDir, 'members.json'), JSON.stringify({
    version: 1,
    actors: [
      { kind: 'commander', id: 'commander', name: 'Commander', joined_at: 't' },
      { kind: 'user', id: 'user', name: 'User', joined_at: 't' },
    ],
  }));
}

describe('group_chat watchdog › pingCommanderForWatchdog', () => {
  it('queues a system msg into commander worker when conv has stale plan', async () => {
    await setupConvWithStalePlan({ staleMinutes: 15 });
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const fired = await bus.pingCommanderForWatchdog(TEST_UID, TEST_CID, 'test-stall');
    expect(fired).toBe(true);
    // Worker should now have a queued or in-progress turn for commander.
    const state = bus._cidStateForTest(TEST_UID, TEST_CID);
    const worker = state?.workers.get('commander');
    expect(worker).toBeTruthy();
    // Either queue still has the item OR the worker just started running it.
    expect((worker?.queue.length || 0) + (worker?.running ? 1 : 0)).toBeGreaterThan(0);
    bus.dropConv(TEST_UID, TEST_CID);
  });

  it('refuses to ping when conv was aborted', async () => {
    await setupConvWithStalePlan({ staleMinutes: 15, status: 'aborted' });
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const fired = await bus.pingCommanderForWatchdog(TEST_UID, TEST_CID, 'test');
    expect(fired).toBe(false);
  });

  it('refuses to ping when commander already has work queued', async () => {
    await setupConvWithStalePlan({ staleMinutes: 15 });
    const bus = await import('../../../../src/main/features/group_chat/bus');
    // First ping queues something — second should be a no-op.
    const a = await bus.pingCommanderForWatchdog(TEST_UID, TEST_CID, 'first');
    const b = await bus.pingCommanderForWatchdog(TEST_UID, TEST_CID, 'second');
    expect(a).toBe(true);
    expect(b).toBe(false);
    bus.dropConv(TEST_UID, TEST_CID);
  });
});
