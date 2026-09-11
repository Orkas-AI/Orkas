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
  it('requires a fresh one-time decision for unresolved paths even after a task grant', async () => {
    const granted = ask({ reasons: ['sensitive_path'] });
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    expect(await granted).toBe('allow_run');

    const uncertain = ask({ reasons: ['sensitive_path'], unresolvedPaths: true });
    expect(permissionPushes()).toHaveLength(2);
    expect(permissionPushes()[1].payload).toMatchObject({ unresolved_paths: true, can_allow_run: false });
    bp.respond(permissionPushes()[1].payload.request_id, 'allow_run');
    expect(await uncertain).toBe('allow_once');

    const next = ask({ reasons: [], unresolvedPaths: true });
    expect(permissionPushes()).toHaveLength(3);
    bp.respond(permissionPushes()[2].payload.request_id, 'deny');
    expect(await next).toBe('deny');
  });

  it('carries the irreversible finding to the dialog, and omits it otherwise', async () => {
    const withFinding = ask({ irreversible: ['recursive_delete', 'recursive_delete'] });
    expect(permissionPushes()[0].payload.irreversible).toEqual(['recursive_delete']);
    bp.respond(permissionPushes()[0].payload.request_id, 'deny');
    await withFinding;

    pushed = [];
    const plain = ask();
    // An ordinary sensitive prompt must not grow an empty array the dialog
    // would have to special-case.
    expect(permissionPushes()[0].payload).not.toHaveProperty('irreversible');
    bp.respond(permissionPushes()[0].payload.request_id, 'deny');
    await plain;
  });

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

  it.each([
    'network_egress',
    'destructive',
    'sensitive_path',
    'system_package_change',
  ] as const)('allows %s for the current task and skips later same-scope prompts', async (reason) => {
    const first = ask({ reasons: [reason] });
    expect(permissionPushes()[0].payload.can_allow_run).toBe(true);
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    expect(await first).toBe('allow_run');

    const second = ask({ reasons: [reason] });
    expect(await second).toBe('allow_run');
    expect(permissionPushes()).toHaveLength(1);
  });

  it('allows the top-level Commander to use a task grant despite its empty wire agent id', async () => {
    const first = ask({ agentId: '', agentName: 'Commander', reasons: ['destructive'] });
    expect(permissionPushes()[0].payload.agent_id).toBe('');
    expect(permissionPushes()[0].payload.can_allow_run).toBe(true);
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    expect(await first).toBe('allow_run');

    const second = ask({ agentId: '', agentName: 'Commander', reasons: ['destructive'] });
    expect(await second).toBe('allow_run');
    expect(permissionPushes()).toHaveLength(1);
  });

  it('does not widen an unidentified anonymous actor into a task grant', async () => {
    const first = ask({ agentId: '', agentName: '', reasons: ['destructive'] });
    expect(permissionPushes()[0].payload.can_allow_run).toBe(false);
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    expect(await first).toBe('allow_once');

    const second = ask({ agentId: '', agentName: '', reasons: ['destructive'] });
    expect(permissionPushes()).toHaveLength(2);
    bp.respond(permissionPushes()[1].payload.request_id, 'deny');
    expect(await second).toBe('deny');
  });

  it.each(['priv_esc', 'external_mutation'] as const)(
    'keeps %s exact-command only and narrows a stale allow_run response',
    async (reason) => {
      const first = ask({ reasons: [reason] });
      expect(permissionPushes()[0].payload.can_allow_run).toBe(false);
      bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
      expect(await first).toBe('allow_once');

      const second = ask({ reasons: [reason] });
      expect(permissionPushes()).toHaveLength(2);
      bp.respond(permissionPushes()[1].payload.request_id, 'deny');
      expect(await second).toBe('deny');
    },
  );

  it('requires a new prompt when a task-granted command adds a stricter category', async () => {
    const first = ask({ reasons: ['network_egress'] });
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    expect(await first).toBe('allow_run');

    const stricter = ask({ reasons: ['network_egress', 'external_mutation'] });
    expect(permissionPushes()).toHaveLength(2);
    expect(permissionPushes()[1].payload.can_allow_run).toBe(false);
    bp.respond(permissionPushes()[1].payload.request_id, 'deny');
    expect(await stricter).toBe('deny');
  });

  it('keeps structured external mutation details while enforcing one-time approval', async () => {
    const first = ask({
      command: 'ssh deploy@app "systemctl restart api"',
      reasons: ['network_egress', 'external_mutation'],
      externalMutations: [{ kind: 'service_change', action: 'restart', target: 'api' }],
    });
    expect(permissionPushes()[0].payload.external_mutations).toEqual([
      { kind: 'service_change', action: 'restart', target: 'api' },
    ]);
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    expect(await first).toBe('allow_once');

  });

  it('does not settle an already queued same-category request when a task grant is created', async () => {
    const first = ask({
      command: 'rm first.txt',
      reasons: ['destructive'],
    });
    const second = ask({
      command: 'rm second.txt',
      reasons: ['destructive'],
    });
    const requests = permissionPushes();
    let secondSettled = false;
    second.then(() => { secondSettled = true; });

    bp.respond(requests[0].payload.request_id, 'allow_run');
    expect(await first).toBe('allow_run');
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    bp.respond(requests[1].payload.request_id, 'deny');
    expect(await second).toBe('deny');
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

  it('cancelForCid denies pending requests and permits a fresh request afterward', async () => {
    const p1 = ask();
    bp.cancelForCid('c1');
    expect(await p1).toBe('deny');
    expect(pushed).toContainEqual(expect.objectContaining({
      channel: 'bash:permission_cancelled',
      payload: expect.objectContaining({ cid: 'c1' }),
    }));

    const p2 = ask();
    bp.cancelForCid('c1');
    expect(await p2).toBe('deny');
    const p3 = ask();
    expect(permissionPushes()).toHaveLength(3);
    bp.respond(permissionPushes()[2].payload.request_id, 'deny');
    await p3;
  });

  it('cancelForCid clears task grants', async () => {
    const first = ask({ reasons: ['network_egress'] });
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    expect(await first).toBe('allow_run');

    bp.cancelForCid('c1');
    const afterCancel = ask({ reasons: ['network_egress'] });
    expect(permissionPushes()).toHaveLength(2);
    bp.respond(permissionPushes()[1].payload.request_id, 'deny');
    expect(await afterCancel).toBe('deny');
  });

  it('does not share task grants with another agent or conversation', async () => {
    const first = ask({ reasons: ['network_egress'] });
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    expect(await first).toBe('allow_run');

    const otherAgent = ask({ agentId: 'a2', reasons: ['network_egress'] });
    const otherConversation = ask({ cid: 'c2', reasons: ['network_egress'] });
    expect(permissionPushes()).toHaveLength(3);
    bp.respond(permissionPushes()[1].payload.request_id, 'deny');
    bp.respond(permissionPushes()[2].payload.request_id, 'deny');
    expect(await otherAgent).toBe('deny');
    expect(await otherConversation).toBe('deny');
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

  it('cancelForUid denies only that account and permits a fresh request afterward', async () => {
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

    const afterCancel = ask({ uid: 'u1', cid: 'c-after-cancel' });
    expect(permissionPushes()).toHaveLength(3);
    bp.respond(permissionPushes()[1].payload.request_id, 'allow_once');
    expect(await pendingU2).toBe('allow_once');
    bp.respond(permissionPushes()[2].payload.request_id, 'deny');
    expect(await afterCancel).toBe('deny');
  });

  it('cancelForUid clears task grants for the previous account', async () => {
    const first = ask({ reasons: ['sensitive_path'] });
    bp.respond(permissionPushes()[0].payload.request_id, 'allow_run');
    expect(await first).toBe('allow_run');

    bp.cancelForUid('u1');
    const afterSwitch = ask({ reasons: ['sensitive_path'] });
    expect(permissionPushes()).toHaveLength(2);
    bp.respond(permissionPushes()[1].payload.request_id, 'deny');
    expect(await afterSwitch).toBe('deny');
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
