import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({ snapshot: vi.fn(), project: vi.fn() }));
vi.mock('../../../../src/main/features/group_chat/bus', async original => ({
  ...await original<any>(), liveDisplaySnapshot: fixture.snapshot,
}));
vi.mock('../../../../src/main/features/conversation_history_cache', async original => ({
  ...await original<any>(), projectLiveConversationHistoryRecords: fixture.project,
}));
let root: string, previous: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-display-snapshot-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules(); fixture.snapshot.mockReset(); fixture.project.mockReset();
});
afterEach(() => {
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const snapshot = (text = 'original', sequence = 10) => ({ sequence, active_turns: [], turns: [{
  actor: 'commander', turn_id: 'turn', records: [{ id: '', text, process: [{ type: 'progress', text: 'retained' }] }],
}] });

it('coalesces identical captured display work without reusing changed text, sequence, account or scope', async () => {
  let current = snapshot();
  fixture.snapshot.mockImplementation(() => structuredClone(current));
  const releases: Array<() => void> = [];
  fixture.project.mockImplementation((_uid, _source, records) => new Promise(resolve => releases.push(() => resolve(records))));
  const group = await import('../../../../src/main/features/group_chat');
  const first = group.displaySnapshot('u1', 'task');
  const duplicate = group.displaySnapshot('u1', 'task');
  expect(fixture.project).toHaveBeenCalledTimes(1);
  current = snapshot('replaced', 10);
  const replaced = group.displaySnapshot('u1', 'task');
  current = snapshot('replaced', 11);
  const advanced = group.displaySnapshot('u1', 'task');
  const otherAccount = group.displaySnapshot('u2', 'task');
  const otherScope = group.displaySnapshot('u1', 'task', 'project');
  expect(fixture.project).toHaveBeenCalledTimes(5);
  releases.forEach(release => release());
  expect(await first).toEqual(snapshot());
  expect(await duplicate).toEqual(snapshot());
  expect(await replaced).toEqual(snapshot('replaced', 10));
  expect(await advanced).toEqual(snapshot('replaced', 11));
  await Promise.all([otherAccount, otherScope]);
});

it('retries a failed projection rather than caching the error', async () => {
  fixture.snapshot.mockReturnValue(snapshot());
  fixture.project.mockRejectedValueOnce(new Error('injected projection failure'))
    .mockImplementation(async (_uid, _source, records) => records);
  const group = await import('../../../../src/main/features/group_chat');
  await expect(group.displaySnapshot('u1', 'task')).rejects.toThrow('injected');
  expect(await group.displaySnapshot('u1', 'task')).toEqual(snapshot());
});

it('does not merge changed active membership or a larger process trail at the same watermark', async () => {
  let current: any = snapshot();
  fixture.snapshot.mockImplementation(() => structuredClone(current));
  const releases: Array<() => void> = [];
  fixture.project.mockImplementation((_uid, _source, records) => new Promise(resolve => releases.push(() => resolve(records))));
  const group = await import('../../../../src/main/features/group_chat');
  const first = group.displaySnapshot('u1', 'task');
  current.active_turns = ['turn'];
  const active = group.displaySnapshot('u1', 'task');
  current.turns[0].records[0].process.push({ type: 'progress', text: 'second retained event' });
  const longer = group.displaySnapshot('u1', 'task');
  expect(fixture.project).toHaveBeenCalledTimes(3);
  releases.forEach(release => release());
  expect((await first).active_turns).toEqual([]);
  expect((await active).active_turns).toEqual(['turn']);
  expect((await longer).turns[0].records[0].process).toHaveLength(2);
});
