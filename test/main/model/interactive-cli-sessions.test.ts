import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { notifyUserSwitch } from '../../../src/main/features/user-switch-hooks';
import {
  _resetInteractiveCliSessionsForTest,
  _setInteractiveCliBroadcastForTest,
  closeInteractiveCliSession,
  closeInteractiveCliSessionsForUser,
  listInteractiveCliSessions,
  readInteractiveCliSession,
  sendInteractiveCliInput,
  startInteractiveCliSession,
} from '../../../src/main/model/core-agent/interactive-cli-sessions';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
const tempRoots: string[] = [];

afterEach(() => {
  _resetInteractiveCliSessionsForTest();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function commandFor(script: string): string {
  if (process.platform === 'win32') {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    return `& ${quote(TEST_NODE)} -e ${quote(script)}`;
  }
  return `${JSON.stringify(TEST_NODE)} -e ${JSON.stringify(script)}`;
}

async function eventually<T>(
  read: () => T,
  ready: (value: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = read();
  while (!ready(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    value = read();
  }
  return value;
}

describe('interactive CLI session privacy boundary', () => {
  it.runIf(process.platform === 'win32')(
    'uses the configured Windows shell instead of passing PowerShell commands to cmd.exe',
    async () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-interactive-cli-shell-'));
      tempRoots.push(cwd);
      _setInteractiveCliBroadcastForTest(() => {});
      const command = `& ${JSON.stringify(TEST_NODE)} -e ${JSON.stringify("process.stdout.write('powershell-ok')")}`;
      const started = startInteractiveCliSession({
        uid: 'account-a',
        command,
        cwd,
        maxLifetimeMs: 30_000,
      });

      const terminal = await eventually(
        () => readInteractiveCliSession('account-a', started.session_id),
        (view) => view.status !== 'running',
      );

      expect(terminal).toMatchObject({
        status: 'exited',
        exit_code: 0,
      });
      expect(terminal.output).toContain('powershell-ok');
    },
  );

  it('account-tags every push event, isolates reads, and redacts echoed UI secrets', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-interactive-cli-'));
    tempRoots.push(cwd);
    const events: Array<{ channel: string; payload: Record<string, unknown> }> = [];
    _setInteractiveCliBroadcastForTest((channel, payload) => {
      events.push({ channel, payload: payload as Record<string, unknown> });
    });
    const script = [
      "process.stdout.write('Enter password: ');",
      "process.stdin.once('data', data => {",
      "  process.stdout.write('echo:' + data.toString().trim());",
      '  process.exit(0);',
      '});',
    ].join('');
    const started = startInteractiveCliSession({
      uid: 'account-a',
      command: commandFor(script),
      cwd,
      maxLifetimeMs: 30_000,
    });

    await eventually(
      () => readInteractiveCliSession('account-a', started.session_id),
      (view) => view.prompt_kind === 'secret',
    );
    sendInteractiveCliInput('account-a', started.session_id, 'secret-code-42', {
      sensitive: true,
    });
    const terminal = await eventually(
      () => readInteractiveCliSession('account-a', started.session_id),
      (view) => view.status !== 'running',
    );

    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every(({ channel }) => channel === 'interactive-cli:event')).toBe(true);
    expect(events.every(({ payload }) => payload.user_id === 'account-a')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('secret-code-42');
    expect(terminal.output).toContain('[redacted]');
    expect(terminal.output).not.toContain('secret-code-42');
    expect(listInteractiveCliSessions('account-b')).toEqual([]);
    expect(() => readInteractiveCliSession('account-b', started.session_id))
      .toThrow('interactive CLI session not found');
    expect(() => sendInteractiveCliInput('account-b', started.session_id, 'steal'))
      .toThrow('interactive CLI session not found');

    closeInteractiveCliSession('account-a', started.session_id);
  });

  it('kills every running old-account process before the active account changes', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-interactive-cli-switch-'));
    tempRoots.push(cwd);
    const events: Array<Record<string, unknown>> = [];
    _setInteractiveCliBroadcastForTest((_channel, payload) => {
      events.push(payload as Record<string, unknown>);
    });
    const started = startInteractiveCliSession({
      uid: 'account-a',
      command: commandFor('setInterval(() => {}, 1000)'),
      cwd,
      maxLifetimeMs: 30_000,
    });

    notifyUserSwitch('account-a', 'account-b');

    expect(readInteractiveCliSession('account-a', started.session_id)).toMatchObject({
      status: 'closed',
      signal: 'account_switch',
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'closed',
      session_id: started.session_id,
      user_id: 'account-a',
      signal: 'account_switch',
    }));
    expect(closeInteractiveCliSessionsForUser('account-a')).toBe(0);
  });
});
