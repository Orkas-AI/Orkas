import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadBridge(
  choose: (args: any) => Promise<string | null>,
  invokeImpl: (channel: string, payload: any) => Promise<any> = async () => ({ handled: true }),
) {
  let push: ((info: any) => void) | null = null;
  let cancel: ((info: any) => void) | null = null;
  const dialogs: any[] = [];
  const invoke = vi.fn(invokeImpl);
  const warn = vi.fn();
  const monitor = { event: vi.fn(), error: vi.fn() };
  const sandbox: any = {
    console,
    Promise,
    String,
    Array,
    AbortController,
    createLogger: () => ({ warn, info() {}, error() {} }),
    t: (key: string, vars: Record<string, unknown> = {}) => {
      if (key === 'bridge.permission.message') {
        return `${vars.agent} wants ${vars.tool} through ${vars.connector}`;
      }
      return key;
    },
    uiChoice: vi.fn(async (args: any) => {
      dialogs.push(args);
      return choose(args);
    }),
    window: {
      Monitor: true,
      orkas: {
        invoke,
        onPushEvent: vi.fn((name: string, handler: (info: any) => void) => {
          if (name === 'bridge:permission') push = handler;
          if (name === 'bridge:permission_cancelled') cancel = handler;
        }),
      },
    },
    Monitor: monitor,
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/bridge.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'bridge.js' });
  if (!push) throw new Error('bridge:permission handler was not registered');
  if (!cancel) throw new Error('bridge:permission_cancelled handler was not registered');
  return { push, cancel, dialogs, invoke, warn, monitor };
}

async function flushQueue(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

describe('renderer connector bridge permission queue', () => {
  it('maps explicit choices and cancellation to the exact fail-closed response', async () => {
    const choices = ['allow_once', 'allow_always', null];
    const harness = loadBridge(async () => choices.shift() as string | null);

    harness.push({ request_id: 'r1', agent_name: 'Agent', connector_name: 'Mail', tool_name: 'send' });
    harness.push({ request_id: 'r2', agent_name: 'Agent', connector_name: 'Mail', tool_name: 'read' });
    harness.push({ request_id: 'r3', agent_name: 'Agent', connector_name: 'Mail', tool_name: 'delete' });
    await flushQueue();

    expect(harness.invoke.mock.calls).toEqual([
      ['bridge.permission_response', { request_id: 'r1', allow: true, always: false }],
      ['bridge.permission_response', { request_id: 'r2', allow: true, always: true }],
      ['bridge.permission_response', { request_id: 'r3', allow: false, always: false }],
    ]);
    expect(harness.monitor.event.mock.calls.map((call) => [call[0], call[1].decision, call[1].result]))
      .toEqual([
        ['connector_bridge_permission_result', 'allow_once', 'success'],
        ['connector_bridge_permission_result', 'allow_always', 'success'],
        ['connector_bridge_permission_result', 'deny', 'success'],
      ]);
    expect(JSON.stringify(harness.monitor.event.mock.calls)).not.toContain('request_id');
  });

  it('shows concurrent requests in FIFO order without overlapping dialogs', async () => {
    const resolvers: Array<(choice: string | null) => void> = [];
    let active = 0;
    let maxActive = 0;
    const harness = loadBridge(() => new Promise((resolve) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      resolvers.push((choice) => {
        active -= 1;
        resolve(choice);
      });
    }));

    harness.push({ request_id: 'first', agent_name: 'First', connector_name: 'A', tool_name: 'read' });
    harness.push({ request_id: 'second', agent_name: 'Second', connector_name: 'B', tool_name: 'write' });
    await Promise.resolve();
    expect(harness.dialogs).toHaveLength(1);

    resolvers[0]('allow_once');
    await flushQueue();
    expect(harness.dialogs).toHaveLength(2);
    resolvers[1](null);
    await flushQueue();

    expect(maxActive).toBe(1);
    expect(harness.dialogs.map((dialog) => dialog.message)).toEqual([
      'First wants read through A',
      'Second wants write through B',
    ]);
  });

  it('denies a broken dialog, continues the queue, and never logs private error text', async () => {
    let calls = 0;
    const harness = loadBridge(async () => {
      calls += 1;
      if (calls === 1) throw new Error('/Users/test/private/dialog-state.json');
      return 'allow_once';
    });

    harness.push({ request_id: 'broken', agent_name: 'A', connector_name: 'C', tool_name: 'one' });
    harness.push({ request_id: 'next', agent_name: 'B', connector_name: 'C', tool_name: 'two' });
    harness.push({ request_id: ' ', agent_name: 'ignored' });
    await flushQueue();

    expect(harness.invoke.mock.calls).toEqual([
      ['bridge.permission_response', { request_id: 'broken', allow: false, always: false }],
      ['bridge.permission_response', { request_id: 'next', allow: true, always: false }],
    ]);
    expect(harness.monitor.event).toHaveBeenNthCalledWith(
      1,
      'connector_bridge_permission_result',
      expect.objectContaining({
        result: 'failure',
        decision: 'deny',
        effective_decision: 'deny',
        error_code: 'dialog_failed',
        error_type: 'ui',
      }),
    );
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain('/Users/alice');
  });

  it('closes a request cancelled by main without sending a stale response or blocking the queue', async () => {
    let call = 0;
    const harness = loadBridge(async (args) => {
      call += 1;
      if (call > 1) return 'allow_once';
      return new Promise<string | null>((resolve) => {
        args.signal.addEventListener('abort', () => resolve(null), { once: true });
      });
    });

    harness.push({ request_id: 'cancelled', agent_name: 'A', connector_name: 'C', tool_name: 'one' });
    harness.push({ request_id: 'next', agent_name: 'B', connector_name: 'C', tool_name: 'two' });
    await Promise.resolve();
    harness.cancel({ request_ids: ['cancelled'], cid: 'c1' });
    await flushQueue();

    expect(harness.invoke.mock.calls).toEqual([
      ['bridge.permission_response', { request_id: 'next', allow: true, always: false }],
    ]);
    expect(harness.monitor.event).toHaveBeenCalledOnce();
    expect(harness.monitor.event).toHaveBeenCalledWith(
      'connector_bridge_permission_result',
      expect.objectContaining({ result: 'success', decision: 'allow_once' }),
    );
  });

  it('reports remember-for-connector persistence failure without claiming durable authorization', async () => {
    const harness = loadBridge(
      async () => 'allow_always',
      async () => ({ handled: true, always_saved: false }),
    );

    harness.push({ request_id: 'remember', agent_name: 'A', connector_name: 'C', tool_name: 'one' });
    await flushQueue();

    expect(harness.monitor.event).toHaveBeenCalledWith(
      'connector_bridge_permission_result',
      expect.objectContaining({
        result: 'failure',
        decision: 'allow_always',
        effective_decision: 'allow_once',
        error_code: 'remember_failed',
        error_type: 'storage',
      }),
    );
  });

  it('reports one bounded terminal row when response delivery fails', async () => {
    const harness = loadBridge(
      async () => 'allow_once',
      async () => { throw new Error('/Users/test/private/bridge-token.json'); },
    );

    harness.push({
      request_id: 'private-request-id',
      agent_name: 'Private Agent',
      connector_name: 'Private Connector',
      tool_name: 'private_tool',
    });
    await flushQueue();

    expect(harness.monitor.event).toHaveBeenCalledOnce();
    expect(harness.monitor.event).toHaveBeenCalledWith(
      'connector_bridge_permission_result',
      expect.objectContaining({
        result: 'failure',
        decision: 'allow_once',
        error_code: 'response_failed',
        error_type: 'ipc',
      }),
    );
    expect(harness.monitor.error).not.toHaveBeenCalled();
    const diagnostics = JSON.stringify([
      harness.monitor.event.mock.calls,
      harness.monitor.error.mock.calls,
      harness.warn.mock.calls,
    ]);
    expect(diagnostics).not.toContain('/Users/alice');
    expect(diagnostics).not.toContain('private-request-id');
    expect(diagnostics).not.toContain('Private Connector');
  });
});
