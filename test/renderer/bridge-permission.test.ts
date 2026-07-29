import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadBridge(
  choose: (args: any) => Promise<string | null>,
  invokeImpl: (channel: string, payload: any) => Promise<any> = async () => ({ handled: true }),
) {
  let push: ((info: any) => void) | null = null;
  const dialogs: any[] = [];
  const invoke = vi.fn(invokeImpl);
  const warn = vi.fn();
  const sandbox: any = {
    console,
    Promise,
    String,
    Array,
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
      orkas: {
        invoke,
        onPushEvent: vi.fn((name: string, handler: (info: any) => void) => {
          if (name === 'bridge:permission') push = handler;
        }),
      },
    },
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/bridge.js'), 'utf8');
  vm.runInContext(source, sandbox, { filename: 'bridge.js' });
  if (!push) throw new Error('bridge:permission handler was not registered');
  return { push, dialogs, invoke, warn };
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
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain('/Users/alice');
  });
});
