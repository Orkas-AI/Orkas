import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as bp from '../../../../src/main/model/core-agent/bash-permissions';

// Capture the `bash:permission` push so we can answer it the way the renderer
// would, without an Electron IPC bridge.
let pushed: Array<{ channel: string; payload: any }> = [];

beforeEach(() => {
  pushed = [];
  bp._resetForTest();
  bp._setBroadcastForTest((channel, payload) => { pushed.push({ channel, payload }); });
});

afterEach(() => {
  bp._setBroadcastForTest(null);
  bp._resetForTest();
  vi.useRealTimers();
});

function ask(over: Partial<Parameters<typeof bp.requestBashDecision>[0]> = {}) {
  return bp.requestBashDecision({
    uid: 'u1', cid: 'c1', agentId: 'a1', agentName: 'Agent',
    command: 'rm -rf /', reasons: ['destructive'],
    ...over,
  });
}

function permissionPushes() {
  return pushed.filter((item) => item.channel === 'bash:permission');
}

describe('bash-permissions', () => {
  it('pushes a request and resolves with the user verdict (allow_once)', async () => {
    const p = ask();
    expect(pushed).toHaveLength(1);
    const id = pushed[0].payload.request_id;
    expect(bp.respond(id, 'allow_once')).toBe(true);
    expect(await p).toBe('allow_once');
  });

  it('deny verdict resolves to deny', async () => {
    const p = ask();
    bp.respond(pushed[0].payload.request_id, 'deny');
    expect(await p).toBe('deny');
  });

  it('fails closed when no renderer broadcast channel is available', async () => {
    let requestId = '';
    bp._setBroadcastForTest((_channel, payload) => {
      requestId = (payload as bp.BashPermissionInfo).request_id;
      return false;
    });
    await expect(ask()).resolves.toBe('deny');
    expect(pushed).toHaveLength(0);
    expect(bp.respond(requestId, 'allow_run')).toBe(false);
  });

  it('fails closed when broadcasting the permission request throws', async () => {
    bp._setBroadcastForTest(() => {
      throw new Error('renderer was destroyed');
    });
    await expect(ask()).resolves.toBe('deny');
    expect(pushed).toHaveLength(0);
  });

  it('allow_run grants the category for the rest of the run (no second prompt)', async () => {
    const p1 = ask();
    bp.respond(pushed[0].payload.request_id, 'allow_run');
    expect(await p1).toBe('allow_run');

    // same (cid, agentId, category) → silent allow, no new push
    const p2 = ask();
    expect(await p2).toBe('allow_run');
    expect(pushed).toHaveLength(1); // still just the first prompt
  });

  it('allow_run also settles same-category requests that were already queued concurrently', async () => {
    const first = ask({ command: 'rm first.txt', reasons: ['destructive'] });
    const second = ask({ command: 'rm second.txt', reasons: ['destructive'] });
    const requests = permissionPushes();
    let secondDecision: bp.BashDecision | undefined;
    second.then((decision) => { secondDecision = decision; });
    expect(requests).toHaveLength(2);

    bp.respond(requests[0].payload.request_id, 'allow_run');
    expect(await first).toBe('allow_run');
    await Promise.resolve();
    expect(secondDecision).toBe('allow_run');
    expect(pushed).toContainEqual(expect.objectContaining({
      channel: 'bash:permission_cancelled',
      payload: expect.objectContaining({
        request_ids: [requests[1].payload.request_id],
        cid: 'c1',
      }),
    }));
  });

  it('allow_run leaves an already-queued request for another risk category pending', async () => {
    const destructive = ask({ command: 'rm first.txt', reasons: ['destructive'] });
    const network = ask({ command: 'curl https://example.invalid', reasons: ['network_egress'] });
    const requests = permissionPushes();
    let networkSettled = false;
    network.then(() => { networkSettled = true; });

    bp.respond(requests[0].payload.request_id, 'allow_run');
    expect(await destructive).toBe('allow_run');
    await Promise.resolve();
    expect(networkSettled).toBe(false);

    bp.respond(requests[1].payload.request_id, 'deny');
    expect(await network).toBe('deny');
  });

  it('allow_run leaves an already-queued request from another agent pending', async () => {
    const firstAgent = ask({ agentId: 'a1', command: 'rm first.txt' });
    const secondAgent = ask({ agentId: 'a2', command: 'rm second.txt' });
    const requests = permissionPushes();
    let secondAgentSettled = false;
    secondAgent.then(() => { secondAgentSettled = true; });

    bp.respond(requests[0].payload.request_id, 'allow_run');
    expect(await firstAgent).toBe('allow_run');
    await Promise.resolve();
    expect(secondAgentSettled).toBe(false);

    bp.respond(requests[1].payload.request_id, 'deny');
    expect(await secondAgent).toBe('deny');
  });

  it('run grant does not cover a different category', async () => {
    const p1 = ask({ reasons: ['destructive'] });
    bp.respond(pushed[0].payload.request_id, 'allow_run');
    await p1;

    const p2 = ask({ reasons: ['network_egress'] });
    expect(pushed).toHaveLength(2); // a fresh prompt was raised
    bp.respond(pushed[1].payload.request_id, 'deny');
    expect(await p2).toBe('deny');
  });

  it('run grant is scoped to the cid — a different conversation re-prompts', async () => {
    const p1 = ask({ cid: 'c1' });
    bp.respond(pushed[0].payload.request_id, 'allow_run');
    await p1;

    const p2 = ask({ cid: 'c2' });
    expect(pushed).toHaveLength(2);
    bp.respond(pushed[1].payload.request_id, 'deny');
    await p2;
  });

  it('run grant is scoped to the uid even when cid and agent ids collide', async () => {
    const p1 = ask({ uid: 'u1', cid: 'same-cid', agentId: 'same-agent' });
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    await p1;

    const p2 = ask({ uid: 'u2', cid: 'same-cid', agentId: 'same-agent' });
    expect(permissionPushes()).toHaveLength(2);
    bp.respond(permissionPushes()[1].payload.request_id, 'deny');
    expect(await p2).toBe('deny');
  });

  it('run grant is scoped to the agent — another agent in the same conversation re-prompts', async () => {
    const p1 = ask({ agentId: 'a1' });
    bp.respond(pushed[0].payload.request_id, 'allow_run');
    await p1;

    const p2 = ask({ agentId: 'a2' });
    expect(pushed).toHaveLength(2);
    bp.respond(pushed[1].payload.request_id, 'deny');
    expect(await p2).toBe('deny');
  });

  it('ignores stale response ids without settling the live request', async () => {
    const p = ask();
    let settled = false;
    p.then(() => { settled = true; });

    expect(bp.respond('stale-request-id', 'allow_run')).toBe(false);
    await Promise.resolve();
    expect(settled).toBe(false);

    expect(bp.respond(pushed[0].payload.request_id, 'deny')).toBe(true);
    expect(await p).toBe('deny');
  });

  it('cancelForCid denies pending requests and clears run grants', async () => {
    const p1 = ask();
    bp.cancelForCid('c1');
    expect(await p1).toBe('deny');
    expect(pushed).toContainEqual(expect.objectContaining({
      channel: 'bash:permission_cancelled',
      payload: expect.objectContaining({ cid: 'c1' }),
    }));

    // a previously-granted run scope would be cleared too: grant then cancel
    const p2 = ask();
    bp.respond(permissionPushes()[1].payload.request_id, 'allow_run');
    await p2;
    bp.cancelForCid('c1');
    const p3 = ask();
    expect(permissionPushes()).toHaveLength(3); // re-prompted, run grant was dropped
    bp.respond(permissionPushes()[2].payload.request_id, 'deny');
    await p3;
  });

  it('cancelForCid leaves another conversation pending', async () => {
    const p1 = ask({ cid: 'c1' });
    const p2 = ask({ cid: 'c2' });
    let secondSettled = false;
    p2.then(() => { secondSettled = true; });

    bp.cancelForCid('c1');
    expect(await p1).toBe('deny');
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    bp.respond(pushed[1].payload.request_id, 'allow_once');
    expect(await p2).toBe('allow_once');
  });

  it('cancelForUid denies only that account and invalidates its grants', async () => {
    const granted = ask({ uid: 'u1', cid: 'c-granted' });
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    await granted;

    const pendingU1 = ask({ uid: 'u1', cid: 'c-pending' });
    const pendingU2 = ask({ uid: 'u2', cid: 'c-other' });
    let u2Settled = false;
    pendingU2.then(() => { u2Settled = true; });

    bp.cancelForUid('u1');
    expect(await pendingU1).toBe('deny');
    await Promise.resolve();
    expect(u2Settled).toBe(false);
    expect(pushed).toContainEqual(expect.objectContaining({
      channel: 'bash:permission_cancelled',
      payload: expect.objectContaining({ uid: 'u1' }),
    }));

    const afterGrant = ask({ uid: 'u1', cid: 'c-granted' });
    expect(permissionPushes()).toHaveLength(4);
    bp.respond(permissionPushes()[2].payload.request_id, 'allow_once');
    expect(await pendingU2).toBe('allow_once');
    bp.respond(permissionPushes()[3].payload.request_id, 'deny');
    expect(await afterGrant).toBe('deny');
  });

  it('does not auto-deny while waiting for user action', async () => {
    vi.useFakeTimers();
    const p = ask();
    let settled = false;
    p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 10);
    await Promise.resolve();
    expect(settled).toBe(false);
    bp.respond(pushed[0].payload.request_id, 'deny');
    expect(await p).toBe('deny');
  });

  it('emits waiting heartbeats while the approval dialog is pending', async () => {
    vi.useFakeTimers();
    const onWaiting = vi.fn();
    const p = ask({ onWaiting });
    expect(onWaiting).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(onWaiting).toHaveBeenCalledTimes(2);
    bp.respond(pushed[0].payload.request_id, 'allow_once');
    expect(await p).toBe('allow_once');
  });

  it('contains waiting callback failures and still requires an explicit verdict', async () => {
    const p = ask({ onWaiting: () => { throw new Error('progress listener failed'); } });
    expect(pushed).toHaveLength(1);
    bp.respond(pushed[0].payload.request_id, 'deny');
    expect(await p).toBe('deny');
  });

  it('truncates an oversized command in the push payload', async () => {
    const big = 'echo ' + 'x'.repeat(2000);
    const p = ask({ command: big, reasons: ['network_egress'] });
    expect(pushed[0].payload.command.length).toBeLessThan(big.length);
    bp.respond(pushed[0].payload.request_id, 'deny');
    await p;
  });
});
