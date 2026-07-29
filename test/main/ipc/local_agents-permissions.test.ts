import { afterEach, describe, expect, it } from 'vitest';

import * as bashPermissions from '../../../src/main/model/core-agent/bash-permissions';
import { invokeHandlers } from '../../../src/main/ipc/local_agents';

type BashPermissionHandler = (
  payload: { request_id?: unknown; decision?: unknown },
) => Promise<{ handled: boolean }>;

type BridgePermissionHandler = (
  payload: { request_id?: unknown; allow?: unknown; always?: unknown },
) => Promise<{ handled: boolean }>;

const bashResponse = invokeHandlers['bash.permission_response'] as BashPermissionHandler;
const bridgeResponse = invokeHandlers['bridge.permission_response'] as BridgePermissionHandler;

afterEach(() => {
  bashPermissions._setBroadcastForTest(null);
  bashPermissions._resetForTest();
});

describe('ipc/local_agents permission responses', () => {
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

  it('rejects malformed bridge decisions and treats unknown ids as stale', async () => {
    await expect(bridgeResponse({ request_id: 'req-1', allow: 'yes' })).rejects.toThrow(/allow/);
    await expect(bridgeResponse({ allow: true })).rejects.toThrow(/request_id/);
    await expect(bridgeResponse({
      request_id: 'stale-bridge-request',
      allow: true,
      always: true,
    })).resolves.toEqual({ handled: false });
  });
});
