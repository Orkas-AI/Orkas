import { afterEach, describe, expect, it, vi } from 'vitest';

import * as permissions from '../../../../src/main/features/local_agents/cli_permissions';
import { notifyUserSwitch } from '../../../../src/main/features/user-switch-hooks';

afterEach(() => permissions._resetForTest());

describe('local_agents/cli_permissions', () => {
  it('auto-allows fixed OpenCode full access without opening a renderer prompt', async () => {
    const broadcast = vi.fn();
    permissions._setBroadcastForTest(broadcast);

    await expect(permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-opencode-full', agentId: 'a1', agentName: 'Agent',
      cli: 'opencode', request: { tool: 'execute', command: 'npm test' },
    })).resolves.toBe('allow_once');
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('fails closed when no renderer can receive the request', async () => {
    permissions._setBroadcastForTest(() => false);
    await expect(permissions.requestPermission({
      uid: 'u1',
      cid: 'c1',
      runId: 'run-1',
      agentId: 'a1',
      agentName: 'Agent',
      cli: 'claude',
      request: { tool: 'Bash', command: 'git status' },
    })).resolves.toBe('deny');
  });

  it('delivers a user decision once and rejects stale replays', async () => {
    let requestId = '';
    permissions._setBroadcastForTest((_channel, payload) => {
      requestId = String((payload as any).request_id || '');
    });
    const pending = permissions.requestPermission({
      uid: 'u1',
      cid: 'c1',
      runId: 'run-1',
      agentId: 'a1',
      agentName: 'Agent',
      cli: 'codex',
      request: { tool: 'command', command: 'npm test' },
    });

    expect(permissions.respond(requestId, 'allow_run')).toEqual({
      handled: true,
      decision: 'allow_run',
    });
    // Native session authority is deliberately narrower than the Orkas task
    // grant so a later task cannot inherit this decision.
    await expect(pending).resolves.toBe('allow_once');
    expect(permissions.respond(requestId, 'deny')).toEqual({ handled: false });
  });

  it('claims a renderer response once while Agent policy persistence is in flight', async () => {
    let requestId = '';
    permissions._setBroadcastForTest((_channel, payload) => {
      requestId = String((payload as any).request_id || '');
    });
    const pending = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-claim', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      permissionPolicy: 'ask', request: { tool: 'command', command: 'npm test' },
    });

    expect(permissions.beginResponse(requestId, 'u2')).toBeNull();
    expect(permissions.beginResponse(requestId, 'u1')).toEqual({
      uid: 'u1', agentId: 'a1', cli: 'codex', permissionPolicy: 'ask',
    });
    expect(permissions.beginResponse(requestId, 'u1')).toBeNull();
    expect(permissions.respond(requestId, 'deny')).toEqual({ handled: true, decision: 'deny' });
    await expect(pending).resolves.toBe('deny');
  });

  it('bounds renderer previews without changing the approval subject', async () => {
    let delivered: { channel: string; payload: any } | null = null;
    permissions._setBroadcastForTest((channel, payload) => {
      delivered = { channel, payload };
    });
    const command = `run-${'x'.repeat(900)}\u0000\u0007`;
    const pending = permissions.requestPermission({
      uid: 'u1',
      cid: 'conversation-1',
      runId: 'run-1',
      agentId: 'agent-1',
      agentName: `Reviewer ${'n'.repeat(200)}`,
      conversationTitle: `Release ${'q'.repeat(200)}\u0000\u0007`,
      cli: 'codex',
      request: {
        id: 'upstream-private-id',
        tool: `command-${'t'.repeat(200)}`,
        description: 'Inspect the selected project',
        command,
        subject: '/selected/project',
      },
    });

    expect(delivered?.channel).toBe('local-agent:permission');
    expect(delivered?.payload).toMatchObject({
      cid: 'conversation-1',
      agent_id: 'agent-1',
      cli: 'codex',
      description: 'Inspect the selected project',
      subject: '/selected/project',
      can_allow_run: true,
      permission_policy: 'inherit',
      permission_policies: ['inherit', 'ask', 'full_access'],
    });
    expect(delivered?.payload).not.toHaveProperty('id');
    expect(delivered?.payload.agent_name).toHaveLength(161);
    expect(delivered?.payload.conversation_title).toHaveLength(161);
    expect(delivered?.payload.conversation_title).not.toMatch(/[\u0000\u0007]/);
    expect(delivered?.payload.tool).toHaveLength(161);
    expect(delivered?.payload.command).toHaveLength(801);
    expect(delivered?.payload.command).not.toMatch(/[\u0000\u0007]/);

    permissions.respond(delivered!.payload.request_id, 'deny');
    await expect(pending).resolves.toBe('deny');
  });

  it('auto-allows later requests in the same task without granting the native CLI session', async () => {
    const requestIds: string[] = [];
    permissions._setBroadcastForTest((_channel, payload) => {
      const requestId = String((payload as any).request_id || '');
      if (requestId) requestIds.push(requestId);
    });
    const first = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-1', agentId: 'a1', agentName: 'Agent', cli: 'claude',
      request: { tool: 'Read' },
    });
    expect(permissions.respond(requestIds[0], 'allow_run')).toEqual({
      handled: true,
      decision: 'allow_run',
    });
    await expect(first).resolves.toBe('allow_once');

    await expect(permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-1', agentId: 'a1', agentName: 'Agent', cli: 'claude',
      request: { tool: 'Bash' },
    })).resolves.toBe('allow_once');
    expect(requestIds).toHaveLength(1);

    const otherRun = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-2', agentId: 'a1', agentName: 'Agent', cli: 'claude',
      request: { tool: 'Bash' },
    });
    expect(requestIds).toHaveLength(2);
    permissions.respond(requestIds[1], 'deny');
    await expect(otherRun).resolves.toBe('deny');

    permissions.cancelForRun('run-1');
    const laterTask = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-1', agentId: 'a1', agentName: 'Agent', cli: 'claude',
      request: { tool: 'Bash' },
    });
    expect(requestIds).toHaveLength(3);
    permissions.respond(requestIds[2], 'deny');
    await expect(laterTask).resolves.toBe('deny');
  });

  it('keeps allow-once bounded and asks again for the next operation', async () => {
    const requestIds: string[] = [];
    permissions._setBroadcastForTest((channel, payload) => {
      if (channel === 'local-agent:permission') {
        requestIds.push(String((payload as any).request_id || ''));
      }
    });

    const first = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-once', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      request: { tool: 'command', command: 'git add .' },
    });
    permissions.respond(requestIds[0], 'allow_once');
    await expect(first).resolves.toBe('allow_once');

    const second = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-once', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      request: { tool: 'command', command: 'git commit -m test' },
    });
    expect(requestIds).toHaveLength(2);
    permissions.respond(requestIds[1], 'deny');
    await expect(second).resolves.toBe('deny');
  });

  it('covers already queued requests when the user allows the whole task', async () => {
    const deliveries: Array<{ channel: string; payload: any }> = [];
    permissions._setBroadcastForTest((channel, payload) => {
      deliveries.push({ channel, payload });
    });

    const first = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-concurrent', agentId: 'a1', agentName: 'Agent', cli: 'hermes',
      request: { tool: 'execute', command: 'git add .' },
    });
    const second = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-concurrent', agentId: 'a1', agentName: 'Agent', cli: 'hermes',
      request: { tool: 'execute', command: 'git commit -m test' },
    });
    const requestIds = deliveries
      .filter(entry => entry.channel === 'local-agent:permission')
      .map(entry => String(entry.payload.request_id));

    expect(permissions.respond(requestIds[0], 'allow_run')).toEqual({
      handled: true,
      decision: 'allow_run',
    });
    await expect(first).resolves.toBe('allow_once');
    await expect(second).resolves.toBe('allow_once');
    expect(deliveries).toContainEqual({
      channel: 'local-agent:permission_cancelled',
      payload: { request_ids: [requestIds[1]] },
    });
    expect(permissions.respond(requestIds[1], 'deny')).toEqual({ handled: false });

    await expect(permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-concurrent', agentId: 'a1', agentName: 'Agent', cli: 'hermes',
      request: { tool: 'execute', command: 'git status' },
    })).resolves.toBe('allow_once');
    expect(deliveries.filter(entry => entry.channel === 'local-agent:permission')).toHaveLength(2);
  });

  it('applies saved full access only to active tasks for the same account and Agent', async () => {
    const deliveries: Array<{ channel: string; payload: any }> = [];
    permissions._setBroadcastForTest((channel, payload) => {
      deliveries.push({ channel, payload });
    });
    permissions.registerRun({
      uid: 'u1', runId: 'run-owner-1', agentId: 'a1', cli: 'codex', permissionPolicy: 'ask',
    });
    permissions.registerRun({
      uid: 'u1', runId: 'run-owner-2', agentId: 'a1', cli: 'codex', permissionPolicy: 'ask',
    });
    permissions.registerRun({
      uid: 'u1', runId: 'run-owner-later', agentId: 'a1', cli: 'codex', permissionPolicy: 'ask',
    });
    permissions.registerRun({
      uid: 'u1', runId: 'run-other-agent', agentId: 'a2', cli: 'codex', permissionPolicy: 'ask',
    });
    permissions.registerRun({
      uid: 'u2', runId: 'run-other-account', agentId: 'a1', cli: 'codex', permissionPolicy: 'ask',
    });

    const first = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-owner-1', agentId: 'a1', agentName: 'Agent 1', cli: 'codex',
      permissionPolicy: 'ask', request: { tool: 'command', command: 'git fetch' },
    });
    const alreadyQueued = permissions.requestPermission({
      uid: 'u1', cid: 'c2', runId: 'run-owner-2', agentId: 'a1', agentName: 'Agent 1', cli: 'codex',
      permissionPolicy: 'ask', request: { tool: 'command', command: 'git status' },
    });
    const otherAgent = permissions.requestPermission({
      uid: 'u1', cid: 'c3', runId: 'run-other-agent', agentId: 'a2', agentName: 'Agent 2', cli: 'codex',
      permissionPolicy: 'ask', request: { tool: 'command', command: 'git status' },
    });
    const otherAccount = permissions.requestPermission({
      uid: 'u2', cid: 'c4', runId: 'run-other-account', agentId: 'a1', agentName: 'Agent 1', cli: 'codex',
      permissionPolicy: 'ask', request: { tool: 'command', command: 'git status' },
    });
    const requestIds = deliveries
      .filter(entry => entry.channel === 'local-agent:permission')
      .map(entry => String(entry.payload.request_id));

    expect(permissions.beginResponse(requestIds[0], 'u1')).toMatchObject({ agentId: 'a1' });
    permissions.updateActiveAgentPermissionPolicy({
      uid: 'u1', agentId: 'a1', cli: 'codex', permissionPolicy: 'full_access',
    });
    expect(permissions.respond(requestIds[0], 'allow_run')).toEqual({
      handled: true,
      decision: 'allow_run',
    });
    await expect(first).resolves.toBe('allow_once');
    await expect(alreadyQueued).resolves.toBe('allow_once');
    expect(deliveries).toContainEqual({
      channel: 'local-agent:permission_cancelled',
      payload: { request_ids: [requestIds[1]] },
    });

    await expect(permissions.requestPermission({
      uid: 'u1', cid: 'c5', runId: 'run-owner-later', agentId: 'a1', agentName: 'Agent 1', cli: 'codex',
      permissionPolicy: 'ask', request: { tool: 'command', command: 'git log -1' },
    })).resolves.toBe('allow_once');
    expect(deliveries.filter(entry => entry.channel === 'local-agent:permission')).toHaveLength(4);

    expect(permissions.respond(requestIds[2], 'deny')).toEqual({ handled: true, decision: 'deny' });
    await expect(otherAgent).resolves.toBe('deny');
    expect(permissions.respond(requestIds[3], 'deny')).toEqual({ handled: true, decision: 'deny' });
    await expect(otherAccount).resolves.toBe('deny');
  });

  it('does not cover another account even when a run id collides', async () => {
    const deliveries: Array<{ channel: string; payload: any }> = [];
    permissions._setBroadcastForTest((channel, payload) => {
      deliveries.push({ channel, payload });
    });

    const owner = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'shared-run-id', agentId: 'a1', agentName: 'Agent 1', cli: 'claude',
      request: { tool: 'Bash', command: 'git status' },
    });
    const otherAccount = permissions.requestPermission({
      uid: 'u2', cid: 'c2', runId: 'shared-run-id', agentId: 'a2', agentName: 'Agent 2', cli: 'claude',
      request: { tool: 'Bash', command: 'git status' },
    });
    const requestIds = deliveries
      .filter(entry => entry.channel === 'local-agent:permission')
      .map(entry => String(entry.payload.request_id));

    permissions.respond(requestIds[0], 'allow_run');
    await expect(owner).resolves.toBe('allow_once');
    expect(deliveries.filter(entry => entry.channel === 'local-agent:permission_cancelled')).toHaveLength(0);
    expect(permissions.respond(requestIds[1], 'deny')).toEqual({
      handled: true,
      decision: 'deny',
    });
    await expect(otherAccount).resolves.toBe('deny');
  });

  it('cancels only the abandoned run and makes its renderer response stale', async () => {
    const deliveries: Array<{ channel: string; payload: any }> = [];
    permissions._setBroadcastForTest((channel, payload) => {
      deliveries.push({ channel, payload });
    });

    const cancelled = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-2', agentId: 'a1', agentName: 'Agent', cli: 'hermes',
      request: { tool: 'execute' },
    });
    const survivor = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-3', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      request: { tool: 'command' },
    });
    const permissionPayloads = deliveries
      .filter(entry => entry.channel === 'local-agent:permission')
      .map(entry => entry.payload);
    const cancelledId = permissionPayloads[0].request_id;
    const survivorId = permissionPayloads[1].request_id;

    permissions.cancelForRun('run-2');
    await expect(cancelled).resolves.toBe('deny');
    expect(deliveries).toContainEqual({
      channel: 'local-agent:permission_cancelled',
      payload: { request_ids: [cancelledId] },
    });
    expect(permissions.respond(cancelledId, 'allow_once')).toEqual({ handled: false });
    expect(permissions.respond(survivorId, 'allow_once')).toEqual({
      handled: true,
      decision: 'allow_once',
    });
    await expect(survivor).resolves.toBe('allow_once');
  });

  it('denies the previous account while preserving another account request', async () => {
    const requestIds: string[] = [];
    permissions._setBroadcastForTest((channel, payload) => {
      if (channel === 'local-agent:permission') requestIds.push((payload as any).request_id);
    });
    const previousAccount = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-u1', agentId: 'a1', agentName: 'Agent', cli: 'claude',
      request: { tool: 'Read' },
    });
    const nextAccount = permissions.requestPermission({
      uid: 'u2', cid: 'c2', runId: 'run-u2', agentId: 'a2', agentName: 'Agent', cli: 'codex',
      request: { tool: 'command' },
    });

    notifyUserSwitch('u1', 'u2');

    await expect(previousAccount).resolves.toBe('deny');
    expect(permissions.respond(requestIds[0], 'allow_once')).toEqual({ handled: false });
    expect(permissions.respond(requestIds[1], 'allow_run')).toEqual({
      handled: true,
      decision: 'allow_run',
    });
    await expect(nextAccount).resolves.toBe('allow_once');
  });

  it('revokes a task grant when its account is switched out', async () => {
    const requestIds: string[] = [];
    permissions._setBroadcastForTest((channel, payload) => {
      if (channel === 'local-agent:permission') requestIds.push((payload as any).request_id);
    });
    const first = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-u1', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      request: { tool: 'command' },
    });
    permissions.respond(requestIds[0], 'allow_run');
    await expect(first).resolves.toBe('allow_once');

    notifyUserSwitch('u1', 'u2');
    const afterSwitch = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-u1', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      request: { tool: 'command' },
    });
    expect(requestIds).toHaveLength(2);
    permissions.respond(requestIds[1], 'deny');
    await expect(afterSwitch).resolves.toBe('deny');
  });

  it('denies an unanswered request at the host deadline and makes the late renderer reply stale', async () => {
    // The wait is bounded by the host: a user who stepped away must not come
    // back to a prompt whose caller gave up long ago. Ten minutes matches the
    // bridge's previous deny-on-timeout.
    vi.useFakeTimers();
    try {
      const deliveries: Array<{ channel: string; payload: any }> = [];
      permissions._setBroadcastForTest((channel, payload) => { deliveries.push({ channel, payload }); });
      const decision = permissions.requestPermission({
        uid: 'u1', cid: 'c1', runId: 'run-deadline', agentId: 'a1', agentName: 'Agent', cli: 'claude',
        request: { tool: 'Bash', command: 'rm -rf build' },
      });
      const requestId = deliveries[0].payload.request_id as string;

      vi.advanceTimersByTime(permissions.permissionResponseTimeoutMs() - 1);
      expect(deliveries.some((entry) => entry.channel === 'local-agent:permission_cancelled')).toBe(false);
      vi.advanceTimersByTime(1);

      await expect(decision).resolves.toBe('deny');
      expect(deliveries).toContainEqual({
        channel: 'local-agent:permission_cancelled',
        payload: { request_ids: [requestId] },
      });
      expect(permissions.respond(requestId, 'allow_run')).toEqual({ handled: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a claimed renderer response ahead of the deadline', async () => {
    // The user answered in time; persisting a policy change may outlast the
    // deadline and must still finish through that answer.
    vi.useFakeTimers();
    try {
      let requestId = '';
      permissions._setBroadcastForTest((_channel, payload) => {
        requestId = requestId || String((payload as any).request_id || '');
      });
      const decision = permissions.requestPermission({
        uid: 'u1', cid: 'c1', runId: 'run-claimed', agentId: 'a1', agentName: 'Agent', cli: 'codex',
        request: { tool: 'command', command: 'npm test' },
      });
      let settled: string | null = null;
      void decision.then((value) => { settled = value; });

      expect(permissions.beginResponse(requestId, 'u1')).toMatchObject({ uid: 'u1', agentId: 'a1' });
      vi.advanceTimersByTime(permissions.permissionResponseTimeoutMs() * 2);
      await Promise.resolve();
      expect(settled).toBeNull();

      expect(permissions.respond(requestId, 'allow_once')).toEqual({ handled: true, decision: 'allow_once' });
      await expect(decision).resolves.toBe('allow_once');
    } finally {
      vi.useRealTimers();
    }
  });

  it('withdraws a request when its caller stops waiting', async () => {
    // A bridge client that timed out or received an MCP cancel has already
    // told the model the call failed; a later "allow" must not run it.
    const deliveries: Array<{ channel: string; payload: any }> = [];
    permissions._setBroadcastForTest((channel, payload) => { deliveries.push({ channel, payload }); });
    const controller = new AbortController();
    const decision = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-abort', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      permissionKind: 'connector', request: { tool: 'GMAIL_SEND_EMAIL', description: 'Gmail' },
      signal: controller.signal,
    });
    const requestId = deliveries[0].payload.request_id as string;

    controller.abort();
    await expect(decision).resolves.toBe('deny');
    expect(deliveries).toContainEqual({
      channel: 'local-agent:permission_cancelled',
      payload: { request_ids: [requestId] },
    });
    expect(permissions.respond(requestId, 'allow_run')).toEqual({ handled: false });

    // Already withdrawn before asking: no prompt reaches the renderer at all.
    const aborted = new AbortController();
    aborted.abort();
    const before = deliveries.length;
    await expect(permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-abort-2', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      request: { tool: 'command', command: 'npm test' }, signal: aborted.signal,
    })).resolves.toBe('deny');
    expect(deliveries).toHaveLength(before);
  });

  it('still prompts for a connector action under full access and does not sweep it up in a full-access upgrade', async () => {
    // Full access covers the CLI's own files and shell; a connector action
    // reaches the user's external accounts through Orkas and always gets a
    // fresh answer or an explicit task grant.
    const deliveries: Array<{ channel: string; payload: any }> = [];
    permissions._setBroadcastForTest((channel, payload) => { deliveries.push({ channel, payload }); });
    permissions.registerRun({ uid: 'u1', runId: 'run-full', agentId: 'a1', cli: 'codex', permissionPolicy: 'full_access' });

    await expect(permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-full', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      permissionPolicy: 'full_access', request: { tool: 'command', command: 'npm test' },
    })).resolves.toBe('allow_once');
    expect(deliveries).toHaveLength(0);

    const connector = permissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-full', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      permissionPolicy: 'full_access', permissionKind: 'connector',
      request: { tool: 'GMAIL_SEND_EMAIL', description: 'Gmail' },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].payload).toMatchObject({ permission_kind: 'connector', permission_policy: 'full_access' });

    // Re-saving full access resolves native prompts, never a connector one.
    permissions.updateActiveAgentPermissionPolicy({ uid: 'u1', agentId: 'a1', cli: 'codex', permissionPolicy: 'full_access' });
    let settled: string | null = null;
    void connector.then((value) => { settled = value; });
    await Promise.resolve();
    expect(settled).toBeNull();
    expect(deliveries.some((entry) => entry.channel === 'local-agent:permission_cancelled')).toBe(false);

    expect(permissions.respond(deliveries[0].payload.request_id, 'deny')).toEqual({ handled: true, decision: 'deny' });
    await expect(connector).resolves.toBe('deny');
  });
});
