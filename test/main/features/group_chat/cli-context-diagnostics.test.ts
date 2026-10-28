import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureMainLogWorkers } from '../../../helpers/capture-main-log-workers';
import { expectTestLog } from '../../../helpers/test-log-analysis';

let workspace: string;
let previousWorkspace: string | undefined;
let closeLogs: () => Promise<void>;

beforeEach(async () => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-diagnostic-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = workspace;
  vi.resetModules();
  closeLogs = await captureMainLogWorkers();
});

afterEach(async () => {
  try { await closeLogs(); }
  finally {
    vi.restoreAllMocks();
    if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
    else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

it.each(['message', 'metadata'])('keeps CLI handback read-failure diagnostics private: %s', async kind => {
  const uid = 'diagnostic-user-private';
  const cid = 'conversation-private-sentinel';
  const aid = 'agent-private-sentinel';
  const privateDetail = 'unexpected confidential fixture detail';
  const failure = new Error(privateDetail);
  if (kind === 'metadata') Object.assign(failure, {
    name: 'private-exception-name', code: 'private-exception-code', status: 'private-exception-status',
  });
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
  const state = await import('../../../../src/main/features/group_chat/state');
  const read = vi.spyOn(state, 'readState').mockRejectedValue(failure);
  const { default: electronLog } = await import('electron-log/main');
  const records: unknown[][] = [];
  const hook = (message: any) => {
    if (message.scope === 'group_chat.bus' && message.level === 'warn') records.push(message.data);
    return message;
  };
  electronLog.hooks.push(hook);
  try {
    expectTestLog({ level: 'warn', source: 'group_chat.bus', message: /cli handback state unavailable/ });
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const plan = await bus._buildCliContextPlanForTest(uid, cid, {
      agent_id: aid, name: 'Fixture agent', workflow: '', inputs: [],
      runtime: { kind: 'cli', cli: 'hermes' },
    } as any, {
      actor: { id: aid, kind: 'agent' }, turnId: 'turn', msgId: 'message',
      fromActorId: 'user', llmPayload: 'Retain this task.',
    } as any, [], undefined, { language: 'en' });
    expect(read).toHaveBeenCalledWith(uid, cid);
    expect(plan.turnPrompt).toContain('Retain this task.');
    await closeLogs();
    closeLogs = async () => {};
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(['cli handback state unavailable', {
      cid: 'conv...inel', agent_id: 'agen...inel',
      error: { message_hash: expect.stringMatching(/^[a-f0-9]{12}$/), message_chars: privateDetail.length },
    }]);
    const logs = fs.readdirSync(path.join(workspace, 'logs')).filter(name => name.endsWith('.log'))
      .map(name => fs.readFileSync(path.join(workspace, 'logs', name), 'utf8')).join('\n');
    expect(logs).toContain('cli handback state unavailable');
    for (const value of [uid, cid, aid, privateDetail, 'private-exception-name', 'private-exception-code', 'private-exception-status']) {
      expect(JSON.stringify(records)).not.toContain(value);
      expect(logs).not.toContain(value);
    }
  } finally {
    const index = electronLog.hooks.indexOf(hook);
    if (index >= 0) electronLog.hooks.splice(index, 1);
  }
});
