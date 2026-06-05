import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'auto-task-sync-user';

let tmpDir: string;
let prevWs: string | undefined;
let dirty: Array<{ domain: string; relPath: string }>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-auto-sync-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  dirty = [];
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
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_1234abcd/config.json' },
    ]);
  });

  it('marks task attachment mutations dirty', async () => {
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    autoTasks._setSyncDirtyNotifierForTest((domain, relPath) => dirty.push({ domain, relPath }));

    await autoTasks.uploadAttachment(UID, 'at_abcdef12', 'brief.txt', Buffer.from('brief'));
    await autoTasks.deleteAttachment(UID, 'at_abcdef12', 'brief.txt');
    autoTasks.stopScheduler();

    expect(dirty).toEqual([
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_abcdef12/attachments/brief.txt' },
      { domain: 'auto_tasks', relPath: 'cloud/auto_tasks/at_abcdef12/attachments/brief.txt' },
    ]);
  });
});
