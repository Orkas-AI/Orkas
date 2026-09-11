import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as agents from '../../../src/main/features/agents';
import * as users from '../../../src/main/features/users';
import * as bashPermissions from '../../../src/main/model/core-agent/bash-permissions';
import * as cliPermissions from '../../../src/main/features/local_agents/cli_permissions';
import * as cliUserInput from '../../../src/main/features/local_agents/cli_user_input';
import { invokeHandlers } from '../../../src/main/ipc/local_agents';

type BashPermissionHandler = (
  payload: { request_id?: unknown; decision?: unknown },
) => Promise<{ handled: boolean; decision?: string }>;

type CliPermissionHandler = (
  payload: { request_id?: unknown; decision?: unknown; permission_policy?: unknown },
  ctx: { userId: string },
) => Promise<{
  handled: boolean;
  decision?: string;
  policy_saved?: boolean;
  permission_policy?: string;
}>;

const bashResponse = invokeHandlers['bash.permission_response'] as BashPermissionHandler;
const cliResponseHandler = invokeHandlers['localAgents.permissionResponse'] as CliPermissionHandler;
const cliResponse = (payload: Parameters<CliPermissionHandler>[0]) => (
  cliResponseHandler(payload, { userId: 'u1' })
);
const cliUserInputResponse = invokeHandlers['localAgents.userInputResponse'] as (
  payload: { request_id?: unknown; answers?: unknown; cancelled?: unknown },
  ctx: { userId: string },
) => Promise<{ handled: boolean; cancelled?: boolean }>;

beforeEach(() => users.activateUser('u1'));

afterEach(() => {
  bashPermissions._setBroadcastForTest(null);
  bashPermissions._resetForTest();
  cliPermissions._resetForTest();
  cliUserInput._resetForTest();
  vi.restoreAllMocks();
});

describe('ipc/local_agents permission responses', () => {
  it('does not expose removed model-catalog or legacy bridge-permission handlers', () => {
    expect(invokeHandlers).not.toHaveProperty('localAgents.listModels');
    expect(invokeHandlers).not.toHaveProperty('bridge.permission_response');
    expect(invokeHandlers).toHaveProperty('localAgents.runtimeOptions');
  });

  it('rejects malformed bash decisions before they reach the pending-request map', async () => {
    await expect(bashResponse({ decision: 'deny' })).rejects.toThrow(/request_id/);
    await expect(bashResponse({ request_id: 'req-1', decision: 'always' })).rejects.toThrow(/decision/);
    await expect(bashResponse({ request_id: 42, decision: 'deny' })).rejects.toThrow(/request_id/);
  });

  it('resolves a real bash request once and reports a replay as stale', async () => {
    let requestId = '';
    bashPermissions._setBroadcastForTest((_channel, payload) => {
      requestId = (payload as { request_id: string }).request_id;
    });
    const pending = bashPermissions.requestBashDecision({
      uid: 'u1',
      cid: 'c1',
      agentId: 'a1',
      agentName: 'Agent',
      command: 'rm -f report.txt',
      reasons: ['destructive'],
    });
    expect(requestId).not.toBe('');

    await expect(bashResponse({ request_id: requestId, decision: 'deny' })).resolves.toEqual({ handled: true });
    await expect(pending).resolves.toBe('deny');
    await expect(bashResponse({ request_id: requestId, decision: 'allow_run' })).resolves.toEqual({ handled: false });
  });

  it('validates external CLI permission responses and reports stale requests', async () => {
    await expect(cliResponse({ decision: 'deny' })).rejects.toThrow(/request_id/);
    await expect(cliResponse({ request_id: 'req-1', decision: 'always' })).rejects.toThrow(/decision/);
    await expect(cliResponse({ request_id: 'req-1', decision: 'allow_session' })).rejects.toThrow(/decision/);
    await expect(cliResponse({
      request_id: 'stale-cli-request',
      decision: 'deny',
    })).resolves.toEqual({ handled: false });
  });

  it('validates and delivers structured CLI user input only for its owning account', async () => {
    await expect(cliUserInputResponse({ answers: {} }, { userId: 'u1' }))
      .rejects.toThrow(/request_id/);
    await expect(cliUserInputResponse({ request_id: 'request-1', answers: [] }, { userId: 'u1' }))
      .rejects.toThrow(/answers/);

    let requestId = '';
    cliUserInput._setBroadcastForTest((channel, payload) => {
      if (channel === 'local-agent:user-input') requestId = String((payload as any).request_id || '');
    });
    const pending = cliUserInput.requestUserInput({
      uid: 'u1', cid: 'c1', runId: 'run-input', agentId: 'a1', agentName: 'Agent', cli: 'codex',
      request: { id: 'native-1', questions: [{ id: 'target', question: 'Choose target' }] },
    });

    await expect(cliUserInputResponse({
      request_id: requestId, answers: { target: ['wrong owner'] },
    }, { userId: 'u2' })).resolves.toEqual({ handled: false });
    await expect(cliUserInputResponse({
      request_id: requestId, answers: { target: ['staging'] },
    }, { userId: 'u1' })).resolves.toEqual({ handled: true, cancelled: false });
    await expect(pending).resolves.toEqual({
      cancelled: false, answers: { target: ['staging'] },
    });
  });

  it('delivers a validated external CLI decision to the pending request exactly once', async () => {
    let requestId = '';
    cliPermissions._setBroadcastForTest((channel, payload) => {
      if (channel === 'local-agent:permission') {
        requestId = (payload as { request_id: string }).request_id;
      }
    });
    const pending = cliPermissions.requestPermission({
      uid: 'u1',
      cid: 'c1',
      runId: 'run-1',
      agentId: 'a1',
      agentName: 'Agent',
      cli: 'codex',
      request: { tool: 'command', command: 'npm test' },
    });

    await expect(cliResponse({
      request_id: requestId,
      decision: 'allow_run',
    })).resolves.toEqual({
      handled: true,
      decision: 'allow_run',
      policy_saved: true,
      permission_policy: 'inherit',
    });
    await expect(pending).resolves.toBe('allow_once');
    await expect(cliResponse({
      request_id: requestId,
      decision: 'deny',
    })).resolves.toEqual({ handled: false });
  });

  it('persists a changed CLI permission level without dropping other runtime overrides', async () => {
    const deliveries: Array<{ channel: string; payload: any }> = [];
    cliPermissions._setBroadcastForTest((channel, payload) => {
      deliveries.push({ channel, payload });
    });
    const getAgent = vi.spyOn(agents, 'getAgent').mockResolvedValue({
      agent_id: 'a1',
      source: 'custom',
      runtime: {
        kind: 'cli',
        cli: 'codex',
        model_override: 'gpt-test',
        thinking_level: 'high',
      },
    } as any);
    const updateAgent = vi.spyOn(agents, 'updateAgentSpec').mockResolvedValue({
      agent_id: 'a1',
      runtime: {
        kind: 'cli',
        cli: 'codex',
        model_override: 'gpt-test',
        thinking_level: 'high',
        permission_policy: 'full_access',
      },
    } as any);
    const pending = cliPermissions.requestPermission({
      uid: 'u1',
      cid: 'c1',
      runId: 'run-policy-change',
      agentId: 'a1',
      agentName: 'Agent',
      cli: 'codex',
      permissionPolicy: 'ask',
      request: { tool: 'command', command: 'npm test' },
    });
    const concurrentTask = cliPermissions.requestPermission({
      uid: 'u1',
      cid: 'c2',
      runId: 'run-policy-change-concurrent',
      agentId: 'a1',
      agentName: 'Agent',
      cli: 'codex',
      permissionPolicy: 'ask',
      request: { tool: 'command', command: 'git status' },
    });
    const requestIds = deliveries
      .filter(entry => entry.channel === 'local-agent:permission')
      .map(entry => String(entry.payload.request_id));

    await expect(cliResponse({
      request_id: requestIds[0],
      decision: 'allow_once',
      permission_policy: 'full_access',
    })).resolves.toEqual({
      handled: true,
      decision: 'allow_run',
      policy_saved: true,
      permission_policy: 'full_access',
    });
    expect(getAgent).toHaveBeenCalledWith('a1');
    expect(updateAgent).toHaveBeenCalledWith('a1', {
      runtime: {
        kind: 'cli',
        cli: 'codex',
        model_override: 'gpt-test',
        thinking_level: 'high',
        permission_policy: 'full_access',
      },
    });
    await expect(pending).resolves.toBe('allow_once');
    await expect(concurrentTask).resolves.toBe('allow_once');
    expect(deliveries).toContainEqual({
      channel: 'local-agent:permission_cancelled',
      payload: { request_ids: [requestIds[1]] },
    });
  });

  it('restores the CLI default by removing only the explicit permission override', async () => {
    let requestId = '';
    cliPermissions._setBroadcastForTest((channel, payload) => {
      if (channel === 'local-agent:permission') requestId = String((payload as any).request_id || '');
    });
    vi.spyOn(agents, 'getAgent').mockResolvedValue({
      agent_id: 'a1',
      source: 'custom',
      runtime: {
        kind: 'cli',
        cli: 'codex',
        model_override: 'gpt-test',
        thinking_level: 'high',
        custom_args: ['--profile', 'review'],
        permission_policy: 'ask',
      },
    } as any);
    const updateAgent = vi.spyOn(agents, 'updateAgentSpec').mockResolvedValue({
      agent_id: 'a1',
      runtime: {
        kind: 'cli',
        cli: 'codex',
        model_override: 'gpt-test',
        thinking_level: 'high',
        custom_args: ['--profile', 'review'],
      },
    } as any);
    const pending = cliPermissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-restore-default', agentId: 'a1', agentName: 'Agent',
      cli: 'codex', permissionPolicy: 'ask', request: { tool: 'command', command: 'npm test' },
    });

    await expect(cliResponse({
      request_id: requestId,
      decision: 'allow_once',
      permission_policy: 'inherit',
    })).resolves.toEqual({
      handled: true,
      decision: 'allow_once',
      policy_saved: true,
      permission_policy: 'inherit',
    });
    expect(updateAgent).toHaveBeenCalledWith('a1', {
      runtime: {
        kind: 'cli',
        cli: 'codex',
        model_override: 'gpt-test',
        thinking_level: 'high',
        custom_args: ['--profile', 'review'],
      },
    });
    await expect(pending).resolves.toBe('allow_once');
  });

  it('does not persist a permission-level selection when the operation is denied', async () => {
    let requestId = '';
    cliPermissions._setBroadcastForTest((channel, payload) => {
      if (channel === 'local-agent:permission') requestId = String((payload as any).request_id || '');
    });
    const getAgent = vi.spyOn(agents, 'getAgent');
    const updateAgent = vi.spyOn(agents, 'updateAgentSpec');
    const pending = cliPermissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-deny-policy-change', agentId: 'a1', agentName: 'Agent',
      cli: 'claude', permissionPolicy: 'ask', request: { tool: 'Bash' },
    });

    await expect(cliResponse({
      request_id: requestId,
      decision: 'deny',
      permission_policy: 'full_access',
    })).resolves.toMatchObject({
      handled: true,
      decision: 'deny',
      permission_policy: 'full_access',
    });
    expect(getAgent).not.toHaveBeenCalled();
    expect(updateAgent).not.toHaveBeenCalled();
    await expect(pending).resolves.toBe('deny');
  });

  it('claims a permission response before persistence so concurrent replays cannot double-write', async () => {
    let requestId = '';
    cliPermissions._setBroadcastForTest((channel, payload) => {
      if (channel === 'local-agent:permission') requestId = String((payload as any).request_id || '');
    });
    vi.spyOn(agents, 'getAgent').mockResolvedValue({
      agent_id: 'a1',
      source: 'custom',
      runtime: { kind: 'cli', cli: 'codex', permission_policy: 'ask' },
    } as any);
    let resolveSave!: (value: any) => void;
    const savePending = new Promise<any>((resolve) => { resolveSave = resolve; });
    const updateAgent = vi.spyOn(agents, 'updateAgentSpec').mockImplementation(async () => savePending);
    const pending = cliPermissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-concurrent-response', agentId: 'a1', agentName: 'Agent',
      cli: 'codex', permissionPolicy: 'ask', request: { tool: 'command', command: 'npm test' },
    });

    const firstResponse = cliResponse({
      request_id: requestId,
      decision: 'allow_once',
      permission_policy: 'full_access',
    });
    await vi.waitFor(() => expect(updateAgent).toHaveBeenCalledTimes(1));
    await expect(cliResponse({
      request_id: requestId,
      decision: 'deny',
      permission_policy: 'ask',
    })).resolves.toEqual({ handled: false });

    resolveSave({
      agent_id: 'a1',
      runtime: { kind: 'cli', cli: 'codex', permission_policy: 'full_access' },
    });
    await expect(firstResponse).resolves.toEqual({
      handled: true,
      decision: 'allow_run',
      policy_saved: true,
      permission_policy: 'full_access',
    });
    expect(updateAgent).toHaveBeenCalledTimes(1);
    await expect(pending).resolves.toBe('allow_once');
  });

  it('denies the CLI operation when a changed permission level cannot be persisted', async () => {
    const deliveries: Array<{ channel: string; payload: any }> = [];
    cliPermissions._setBroadcastForTest((channel, payload) => {
      deliveries.push({ channel, payload });
    });
    vi.spyOn(agents, 'getAgent').mockResolvedValue({
      agent_id: 'a1',
      source: 'custom',
      runtime: { kind: 'cli', cli: 'claude', permission_policy: 'ask' },
    } as any);
    vi.spyOn(agents, 'updateAgentSpec').mockResolvedValue(null);
    const pending = cliPermissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-save-failure', agentId: 'a1', agentName: 'Agent',
      cli: 'claude', permissionPolicy: 'ask', request: { tool: 'Bash' },
    });
    const concurrentTask = cliPermissions.requestPermission({
      uid: 'u1', cid: 'c2', runId: 'run-save-failure-concurrent', agentId: 'a1', agentName: 'Agent',
      cli: 'claude', permissionPolicy: 'ask', request: { tool: 'Bash' },
    });
    const requestIds = deliveries
      .filter(entry => entry.channel === 'local-agent:permission')
      .map(entry => String(entry.payload.request_id));

    await expect(cliResponse({
      request_id: requestIds[0],
      decision: 'allow_once',
      permission_policy: 'full_access',
    })).resolves.toEqual({
      handled: true,
      decision: 'deny',
      policy_saved: false,
      permission_policy: 'full_access',
    });
    await expect(pending).resolves.toBe('deny');
    expect(deliveries.filter(entry => entry.channel === 'local-agent:permission_cancelled'))
      .toHaveLength(0);
    await expect(cliResponse({
      request_id: requestIds[1],
      decision: 'deny',
    })).resolves.toMatchObject({ handled: true, decision: 'deny' });
    await expect(concurrentTask).resolves.toBe('deny');
  });

  it('fails closed when Renderer returns a permission level the CLI does not support', async () => {
    let requestId = '';
    cliPermissions._setBroadcastForTest((_channel, payload) => {
      requestId = String((payload as any).request_id || '');
    });
    const pending = cliPermissions.requestPermission({
      uid: 'u1', cid: 'c1', runId: 'run-invalid-policy', agentId: 'a1', agentName: 'Agent',
      cli: 'openclaw', permissionPolicy: 'inherit', request: { tool: 'execute' },
    });

    await expect(cliResponse({
      request_id: requestId,
      decision: 'allow_once',
      permission_policy: 'full_access',
    })).resolves.toEqual({
      handled: true,
      decision: 'deny',
      policy_saved: false,
      permission_policy: 'full_access',
    });
    await expect(pending).resolves.toBe('deny');
  });
});
