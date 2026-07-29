import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'auto-task-sync-user';

let tmpDir: string;
let prevWs: string | undefined;
let dirty: Array<{ domain: string; relPath: string }>;
let deleted: string[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-auto-sync-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  dirty = [];
  deleted = [];
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.resetModules();
});

describe('auto tasks sync dirty notifications', () => {
  it('marks task config mutations dirty', async () => {
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    autoTasks._setSyncDirtyNotifierForTest((domain, relPath) => dirty.push({ domain, relPath }));
    autoTasks._setSyncDeletedNotifierForTest((relPath) => deleted.push(relPath));

    const created = await autoTasks.createTask(UID, {
      id: 'at_1234abcd',
      content: 'hello',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    await autoTasks.updateTask(UID, 'at_1234abcd', { title: 'Greeting' });
    await autoTasks.setTaskEnabled(UID, 'at_1234abcd', false);
    await autoTasks.deleteTask(UID, 'at_1234abcd');
    autoTasks.stopScheduler();

    expect(dirty).toEqual([
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_1234abcd/config.json' },
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_1234abcd/config.json' },
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_1234abcd/config.json' },
    ]);
    expect(deleted).toEqual(['cloud/auto_tasks/at_1234abcd/config.json']);
  });

  it('marks task attachment mutations dirty', async () => {
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    autoTasks._setSyncDirtyNotifierForTest((domain, relPath) => dirty.push({ domain, relPath }));
    autoTasks._setSyncDeletedNotifierForTest((relPath) => deleted.push(relPath));

    await autoTasks.uploadAttachment(UID, 'at_abcdef12', 'brief.txt', Buffer.from('brief'));
    await autoTasks.deleteAttachment(UID, 'at_abcdef12', 'brief.txt');
    autoTasks.stopScheduler();

    expect(dirty).toEqual([
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_abcdef12/attachments/brief.txt' },
    ]);
    expect(deleted).toEqual(['cloud/auto_tasks/at_abcdef12/attachments/brief.txt']);
  });

  it('marks an owned legacy device-binding migration dirty', async () => {
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    const device = await import('../../../src/main/util/device');
    const paths = await import('../../../src/main/paths');
    device._setDeviceFingerprintForTests({
      id: '11:22:33:44:55:66',
      name: 'Legacy workstation',
    });
    try {
      const created = await autoTasks.createTask(UID, {
        id: 'at_1357ace0',
        content: 'migrate this task',
        schedule: { type: 'daily', hour: 9, minute: 0 },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const configFile = paths.autoTaskConfigFile(UID, created.task.id);
      fs.writeFileSync(configFile, JSON.stringify({
        ...created.task,
        device_id: '11:22:33:44:55:66',
      }));
      dirty = [];
      autoTasks._setSyncDirtyNotifierForTest((domain, relPath) => dirty.push({ domain, relPath }));

      const tasks = await autoTasks.listTasks(UID);

      expect(tasks[0].device_id).toBe(created.task.device_id);
      expect(dirty).toEqual([{
        domain: 'auto_tasks',
        relPath: 'cloud/auto_tasks/at_1357ace0/config.json',
      }]);
    } finally {
      device._setDeviceFingerprintForTests(null);
      autoTasks.stopScheduler();
    }
  });
});
