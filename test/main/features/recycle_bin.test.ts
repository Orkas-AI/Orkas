import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;

const UID = 'global-recycle-user';

async function acquireExclusiveWindowsLock(filePath: string): Promise<ChildProcessWithoutNullStreams> {
  const escapedPath = filePath.replace(/'/g, "''");
  const script = [
    `$stream = [System.IO.File]::Open('${escapedPath}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)`,
    `[Console]::Out.WriteLine('locked')`,
    `[Console]::Out.Flush()`,
    `[Console]::In.ReadLine() | Out-Null`,
    `$stream.Dispose()`,
  ].join('; ');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  await new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out acquiring Windows file lock: ${stderr}`));
    }, 10_000);
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (!stdout.includes('locked')) return;
      clearTimeout(timer);
      resolve();
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('exit', (code) => {
      if (stdout.includes('locked')) return;
      clearTimeout(timer);
      reject(new Error(`Windows file-lock helper exited with ${code}: ${stderr}`));
    });
  });
  return child;
}

async function releaseExclusiveWindowsLock(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 5_000);
  await closed;
  clearTimeout(timer);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-global-recycle-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('global recycle bin', () => {
  it.each(['app-file', 'app-directory', 'sync-file'] as const)(
    'rejects an ancestor symlink before a %s archive can import outside data',
    async (entry) => {
      const paths = await import('../../../src/main/paths');
      const recycle = await import('../../../src/main/features/recycle_bin');
      const outside = path.join(tmpDir, 'outside');
      const link = path.join(paths.userCloudRoot(UID), 'contexts', 'linked');
      await fsp.mkdir(outside);
      await fsp.mkdir(path.dirname(link), { recursive: true });
      await fsp.writeFile(path.join(outside, 'private.txt'), 'outside data');
      await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

      const relPath = 'cloud/contexts/linked/private.txt';
      if (entry === 'sync-file') {
        await expect(recycle.createRecycleBatch(UID, [relPath])).resolves.toBeNull();
      } else {
        await expect(recycle.createAppRecycleBatchForCloudEntry(
          UID, entry === 'app-file' ? relPath : 'cloud/contexts/linked', 'context',
        )).rejects.toThrow();
      }
      expect(await recycle.listRecycleBatches(UID)).toEqual([]);
      expect(await fsp.readFile(path.join(outside, 'private.txt'), 'utf8')).toBe('outside data');
    },
  );

  it.each(['destination', 'archive'] as const)(
    'retains a recoverable batch when its %s contains an ancestor symlink',
    async (side) => {
      const paths = await import('../../../src/main/paths');
      const recycle = await import('../../../src/main/features/recycle_bin');
      const relPath = 'cloud/contexts/folder/note.txt';
      const source = path.join(paths.userCloudRoot(UID), 'contexts', 'folder', 'note.txt');
      await fsp.mkdir(path.dirname(source), { recursive: true });
      await fsp.writeFile(source, 'recoverable original');
      const batch = await recycle.createAppRecycleBatchForCloudEntry(UID, relPath, 'context');
      expect(batch?.items.map((item) => item.path)).toEqual([relPath]);
      const archive = path.join(paths.userRecycleDir(UID), batch!.id, 'files', 'contexts', 'folder', 'note.txt');
      await fsp.rm(path.dirname(source), { recursive: true });
      const outside = path.join(tmpDir, 'outside');
      await fsp.mkdir(outside);
      const link = path.dirname(side === 'destination' ? source : archive);
      if (side === 'archive') {
        await fsp.rm(link, { recursive: true });
        await fsp.writeFile(path.join(outside, 'note.txt'), 'unrelated private data');
      }
      await fsp.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

      const blocked = await recycle.restoreRecycleBatch(UID, batch!.id);
      expect(blocked.restored_paths).toEqual([]);
      expect(blocked.skipped_paths).toEqual([]);
      expect(blocked.failed_paths).toEqual([relPath]);
      expect(blocked.reactivated_paths).toEqual([]);
      expect(await fsp.readdir(outside)).toEqual(side === 'archive' ? ['note.txt'] : []);
      expect(fs.existsSync(source)).toBe(false);
      if (side === 'archive') {
        expect(await fsp.readFile(path.join(outside, 'note.txt'), 'utf8')).toBe('unrelated private data');
      }
      expect((await recycle.listRecycleBatches(UID)).map((item) => item.id)).toEqual([batch!.id]);

      await fsp.unlink(link);
      if (side === 'archive') {
        await fsp.mkdir(link, { recursive: true });
        await fsp.writeFile(archive, 'recoverable original');
      }
      const retried = await recycle.restoreRecycleBatch(UID, batch!.id);
      expect(retried.failed_paths).toEqual([]);
      expect(retried.restored_paths).toEqual([relPath]);
      expect(await fsp.readFile(source, 'utf8')).toBe('recoverable original');
    },
  );

  it('does not restore relationship metadata through an ancestor symlink', async () => {
    const paths = await import('../../../src/main/paths');
    const recycle = await import('../../../src/main/features/recycle_bin');
    const relPath = 'cloud/contexts/note.txt';
    const source = path.join(paths.userCloudRoot(UID), 'contexts', 'note.txt');
    const pid = 'p_recovery';
    const projectFile = paths.projectMetaFile(UID, pid);
    await fsp.mkdir(path.dirname(source), { recursive: true });
    await fsp.writeFile(source, 'recoverable original');
    const batch = await recycle.createRecycleBatch(UID, [relPath], Date.now(), {
      project_rows: [{ project_id: pid, name: 'Recovered Project' }],
    });
    await fsp.rm(source);
    const outside = path.join(tmpDir, 'outside');
    await fsp.mkdir(outside);
    await fsp.mkdir(path.dirname(path.dirname(projectFile)), { recursive: true });
    await fsp.symlink(outside, path.dirname(projectFile), process.platform === 'win32' ? 'junction' : 'dir');

    const restored = await recycle.restoreRecycleBatch(UID, batch!.id);
    expect(restored.restored_paths).toEqual([relPath]);
    expect(restored.reactivated_paths).toEqual([]);
    expect(await fsp.readdir(outside)).toEqual([]);
    expect(await fsp.readFile(source, 'utf8')).toBe('recoverable original');

    await fsp.unlink(path.dirname(projectFile));
    const retried = await recycle.restoreRecycleBatch(UID, batch!.id);
    expect(retried.reactivated_paths).toContain(`cloud/projects/${pid}/project.json`);
    expect(JSON.parse(await fsp.readFile(projectFile, 'utf8')).name).toBe('Recovered Project');
  });

  it('archives app-deleted conversations with project membership, attachments, and sessions', async () => {
    const paths = await import('../../../src/main/paths');
    const {
      createAppRecycleBatchForConversation,
      restoreRecycleBatch,
    } = await import('../../../src/main/features/recycle_bin');

    const cid = 'task-a';
    const pid = 'p_project1';
    const relChat = `cloud/chats/${cid}.jsonl`;
    const relAttachment = `cloud/chat_attachments/${cid}/brief.md`;
    const relSession = `cloud/sessions/gconv-${cid}.jsonl`;
    const abs = (relPath: string) => path.join(paths.userCloudRoot(UID), ...relPath.slice('cloud/'.length).split('/'));
    const indexFile = path.join(paths.userCloudRoot(UID), 'chats', '_index.json');
    const projectFile = paths.projectMetaFile(UID, pid);

    for (const relPath of [relChat, relAttachment, relSession]) {
      await fsp.mkdir(path.dirname(abs(relPath)), { recursive: true });
    }
    await fsp.mkdir(path.dirname(indexFile), { recursive: true });
    await fsp.mkdir(path.dirname(projectFile), { recursive: true });
    await fsp.writeFile(abs(relChat), 'task body\n');
    await fsp.writeFile(abs(relAttachment), '# brief\n');
    await fsp.writeFile(abs(relSession), '{"role":"user"}\n');
    await fsp.writeFile(projectFile, JSON.stringify({
      project_id: pid,
      name: 'Project One',
      owner_uid: UID,
      created_at: '2026-05-29T09:00:00.000Z',
      updated_at: '2026-05-29T09:00:00.000Z',
    }, null, 2));
    await fsp.writeFile(indexFile, JSON.stringify([
      {
        conversation_id: cid,
        title: 'Task A',
        kind: 'normal',
        project_id: pid,
        session_id: `gconv-${cid}`,
        created_at: '2026-05-29T10:00:00.000Z',
        updated_at: '2026-05-29T10:00:00.000Z',
      },
    ], null, 2));

    const batch = await createAppRecycleBatchForConversation(UID, cid);
    expect(batch).toEqual(expect.objectContaining({
      source: 'app',
      reason: 'app_delete',
      kind: 'conversation',
    }));
    expect(batch?.display_items).toEqual([
      expect.objectContaining({
        category: 'conversation',
        title: 'Task A',
        id: cid,
      }),
    ]);
    expect(batch?.items.map((it) => it.path).sort()).toEqual(expect.arrayContaining([
      relChat,
      relAttachment,
      relSession,
    ].sort()));
    expect(batch?.metadata?.chat_index_rows?.[0]).toEqual(expect.objectContaining({
      conversation_id: cid,
      project_id: pid,
      session_id: `gconv-${cid}`,
    }));
    expect(batch?.metadata?.project_rows?.[0]?.name).toBe('Project One');

    await fsp.rm(abs(relChat));
    await fsp.rm(path.dirname(abs(relAttachment)), { recursive: true, force: true });
    await fsp.rm(abs(relSession));
    await fsp.rm(projectFile);
    await fsp.writeFile(indexFile, '[]');

    const restored = await restoreRecycleBatch(UID, batch!.id);

    expect(restored.restored_paths).toEqual(expect.arrayContaining([relChat, relAttachment, relSession]));
    expect(restored.reactivated_paths).toContain(`cloud/projects/${pid}/project.json`);
    expect(await fsp.readFile(abs(relAttachment), 'utf-8')).toBe('# brief\n');
    expect(await fsp.readFile(abs(relSession), 'utf-8')).toBe('{"role":"user"}\n');
    const indexRows = JSON.parse(await fsp.readFile(indexFile, 'utf-8'));
    expect(indexRows[0].project_id).toBe(pid);
    expect(JSON.parse(await fsp.readFile(projectFile, 'utf-8')).name).toBe('Project One');
  });

  it('ignores unpublished atomic-write siblings without dropping user .tmp files', async () => {
    const paths = await import('../../../src/main/paths');
    const {
      createAppRecycleBatchForConversation,
      restoreRecycleBatch,
    } = await import('../../../src/main/features/recycle_bin');

    const cid = 'task-atomic-write';
    const relChat = `cloud/chats/${cid}.jsonl`;
    const relGroupState = `cloud/chats/${cid}/state.json`;
    const relUserTmp = `cloud/chat_attachments/${cid}/operator-notes.tmp`;
    const relAtomicTmp = `${relGroupState}.1234.1786579200000.deadbeef.tmp`;
    const abs = (relPath: string) => path.join(
      paths.userCloudRoot(UID),
      ...relPath.slice('cloud/'.length).split('/'),
    );

    await Promise.all([
      fsp.mkdir(path.dirname(abs(relGroupState)), { recursive: true }),
      fsp.mkdir(path.dirname(abs(relUserTmp)), { recursive: true }),
    ]);
    await fsp.writeFile(abs(relChat), 'task body\n');
    await fsp.writeFile(abs(relGroupState), '{"status":"idle"}\n');
    await fsp.writeFile(abs(relUserTmp), 'user-owned draft\n');
    await fsp.writeFile(abs(relAtomicTmp), '{"status":"aborted"}\n');
    const lockChild = process.platform === 'win32'
      ? await acquireExclusiveWindowsLock(abs(relAtomicTmp))
      : null;
    if (!lockChild) await fsp.chmod(abs(relAtomicTmp), 0o000);

    const batch = await (async () => {
      try {
        return await createAppRecycleBatchForConversation(UID, cid);
      } finally {
        if (lockChild) await releaseExclusiveWindowsLock(lockChild);
        else await fsp.chmod(abs(relAtomicTmp), 0o600).catch(() => {});
      }
    })();
    const archivedPaths = batch?.items.map((item) => item.path) || [];

    expect(batch).not.toBeNull();
    expect(archivedPaths).toEqual(expect.arrayContaining([
      relChat,
      relGroupState,
      relUserTmp,
    ]));
    expect(archivedPaths).not.toContain(relAtomicTmp);

    await fsp.rm(abs(relChat));
    await fsp.rm(path.dirname(abs(relGroupState)), { recursive: true, force: true });
    await fsp.rm(path.dirname(abs(relUserTmp)), { recursive: true, force: true });

    const restored = await restoreRecycleBatch(UID, batch!.id);

    expect(restored.failed_paths).toEqual([]);
    expect(restored.restored_paths).toEqual(expect.arrayContaining([
      relChat,
      relGroupState,
      relUserTmp,
    ]));
    expect(restored.restored_paths).not.toContain(relAtomicTmp);
    expect(await fsp.readFile(abs(relGroupState), 'utf-8')).toBe('{"status":"idle"}\n');
    expect(await fsp.readFile(abs(relUserTmp), 'utf-8')).toBe('user-owned draft\n');
    expect(fs.existsSync(abs(relAtomicTmp))).toBe(false);
  });

  it('keeps an explicitly selected atomic-looking user file recoverable', async () => {
    const paths = await import('../../../src/main/paths');
    const {
      createAppRecycleBatchForCloudEntry,
      restoreRecycleBatch,
    } = await import('../../../src/main/features/recycle_bin');

    const relPath = 'cloud/contexts/user-state.json.1234.1786579200000.deadbeef.tmp';
    const target = path.join(paths.userCloudRoot(UID), 'contexts', path.basename(relPath));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, 'explicit user file\n');

    const batch = await createAppRecycleBatchForCloudEntry(UID, relPath, 'context');

    expect(batch?.items.map((item) => item.path)).toEqual([relPath]);
    await fsp.rm(target);

    const restored = await restoreRecycleBatch(UID, batch!.id);

    expect(restored.failed_paths).toEqual([]);
    expect(restored.restored_paths).toEqual([relPath]);
    expect(await fsp.readFile(target, 'utf-8')).toBe('explicit user file\n');
  });

  it('aborts a strict snapshot when a nested related directory cannot be enumerated', async () => {
    const paths = await import('../../../src/main/paths');
    const cid = 'task-unreadable-related-dir';
    const relChat = `cloud/chats/${cid}.jsonl`;
    const relAttachmentDir = `cloud/chat_attachments/${cid}`;
    const relUnreadableDir = `${relAttachmentDir}/private-nested`;
    const abs = (relPath: string) => path.join(
      paths.userCloudRoot(UID),
      ...relPath.slice('cloud/'.length).split('/'),
    );
    await Promise.all([
      fsp.mkdir(path.dirname(abs(relChat)), { recursive: true }),
      fsp.mkdir(abs(relUnreadableDir), { recursive: true }),
    ]);
    await fsp.writeFile(abs(relChat), 'task body\n');
    await fsp.writeFile(path.join(abs(relUnreadableDir), 'must-survive.txt'), 'private attachment\n');

    const actualFsp = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.doMock('node:fs/promises', () => ({
      ...actualFsp,
      readdir: vi.fn(async (target: fs.PathLike, options?: unknown) => {
        if (path.resolve(String(target)) === path.resolve(abs(relUnreadableDir))) {
          throw Object.assign(new Error('simulated directory read failure'), { code: 'EACCES' });
        }
        return (actualFsp.readdir as any)(target, options);
      }),
    }));
    vi.resetModules();

    try {
      const { createAppRecycleBatchForConversation } = await import('../../../src/main/features/recycle_bin');

      await expect(createAppRecycleBatchForConversation(UID, cid)).rejects.toMatchObject({
        code: 'EACCES',
      });
      expect(await fsp.readFile(path.join(abs(relUnreadableDir), 'must-survive.txt'), 'utf-8'))
        .toBe('private attachment\n');
      expect(fs.existsSync(paths.userRecycleDir(UID))).toBe(false);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('archives and restores project-contained conversations with attachments and sessions', async () => {
    const paths = await import('../../../src/main/paths');
    const {
      createAppRecycleBatchForConversation,
      restoreRecycleBatch,
    } = await import('../../../src/main/features/recycle_bin');

    const cid = 'task-project-a';
    const pid = 'p_project2';
    const relChat = `cloud/projects/${pid}/chats/${cid}.jsonl`;
    const relAttachment = `cloud/projects/${pid}/chat_attachments/${cid}/brief.md`;
    const relSession = `cloud/projects/${pid}/sessions/gconv-${cid}.jsonl`;
    const abs = (relPath: string) => path.join(paths.userCloudRoot(UID), ...relPath.slice('cloud/'.length).split('/'));
    const indexFile = paths.projectChatIndexFile(UID, pid);
    const projectFile = paths.projectMetaFile(UID, pid);

    for (const relPath of [relChat, relAttachment, relSession]) {
      await fsp.mkdir(path.dirname(abs(relPath)), { recursive: true });
    }
    await fsp.mkdir(path.dirname(indexFile), { recursive: true });
    await fsp.mkdir(path.dirname(projectFile), { recursive: true });
    await fsp.writeFile(abs(relChat), 'project task body\n');
    await fsp.writeFile(abs(relAttachment), '# project brief\n');
    await fsp.writeFile(abs(relSession), '{"role":"user","content":"hi"}\n');
    await fsp.writeFile(projectFile, JSON.stringify({
      project_id: pid,
      name: 'Project Two',
      owner_uid: UID,
      created_at: '2026-07-09T09:00:00.000Z',
      updated_at: '2026-07-09T09:00:00.000Z',
    }, null, 2));
    await fsp.writeFile(indexFile, JSON.stringify([
      {
        conversation_id: cid,
        title: 'Project Task A',
        kind: 'normal',
        project_id: pid,
        session_id: `gconv-${cid}`,
        created_at: '2026-07-09T10:00:00.000Z',
        updated_at: '2026-07-09T10:00:00.000Z',
      },
    ], null, 2));

    const batch = await createAppRecycleBatchForConversation(UID, cid);
    expect(batch?.display_items).toEqual([
      expect.objectContaining({
        category: 'conversation',
        title: 'Project Task A',
        id: cid,
      }),
    ]);
    expect(batch?.items.map((it) => it.path).sort()).toEqual(expect.arrayContaining([
      relChat,
      relAttachment,
      relSession,
    ].sort()));
    expect(batch?.metadata?.chat_index_rows?.[0]).toEqual(expect.objectContaining({
      conversation_id: cid,
      project_id: pid,
      session_id: `gconv-${cid}`,
    }));

    await fsp.rm(abs(relChat));
    await fsp.rm(path.dirname(abs(relAttachment)), { recursive: true, force: true });
    await fsp.rm(abs(relSession));
    await fsp.rm(projectFile);
    await fsp.writeFile(indexFile, '[]');

    const restored = await restoreRecycleBatch(UID, batch!.id);

    expect(restored.restored_paths).toEqual(expect.arrayContaining([relChat, relAttachment, relSession]));
    expect(restored.reactivated_paths).toContain(`cloud/projects/${pid}/project.json`);
    expect(restored.reactivated_paths).toContain(relChat);
    expect(await fsp.readFile(abs(relAttachment), 'utf-8')).toBe('# project brief\n');
    const indexRows = JSON.parse(await fsp.readFile(indexFile, 'utf-8'));
    expect(indexRows[0]).toEqual(expect.objectContaining({
      conversation_id: cid,
      project_id: pid,
      session_id: `gconv-${cid}`,
    }));
  });

  it('archives app-deleted auto tasks with project metadata and task attachments', async () => {
    const paths = await import('../../../src/main/paths');
    const {
      createAppRecycleBatchForAutoTask,
      restoreRecycleBatch,
    } = await import('../../../src/main/features/recycle_bin');

    const taskId = 'at_1234abcd';
    const pid = 'p_project1';
    const relConfig = `cloud/auto_tasks/${taskId}/config.json`;
    const relAttachment = `cloud/auto_tasks/${taskId}/attachments/input.txt`;
    const abs = (relPath: string) => path.join(paths.userCloudRoot(UID), ...relPath.slice('cloud/'.length).split('/'));
    const projectFile = paths.projectMetaFile(UID, pid);

    await fsp.mkdir(path.dirname(abs(relAttachment)), { recursive: true });
    await fsp.mkdir(path.dirname(projectFile), { recursive: true });
    await fsp.writeFile(abs(relConfig), JSON.stringify({
      id: taskId,
      enabled: true,
      content: 'Run the report',
      project_id: pid,
      schedule: { type: 'daily', hour: 9, minute: 0 },
      created_at: '2026-05-29T10:00:00.000Z',
      updated_at: '2026-05-29T10:00:00.000Z',
      attachments: ['input.txt'],
    }, null, 2));
    await fsp.writeFile(abs(relAttachment), 'input');
    await fsp.writeFile(projectFile, JSON.stringify({
      project_id: pid,
      name: 'Project One',
      owner_uid: UID,
      created_at: '2026-05-29T09:00:00.000Z',
      updated_at: '2026-05-29T09:00:00.000Z',
    }, null, 2));

    const batch = await createAppRecycleBatchForAutoTask(UID, taskId);

    expect(batch).toEqual(expect.objectContaining({
      source: 'app',
      reason: 'app_delete',
      kind: 'auto_task',
    }));
    expect(batch?.display_items).toEqual([
      expect.objectContaining({
        category: 'auto_task',
        title: 'Run the report',
        id: taskId,
      }),
    ]);
    expect(batch?.items.map((it) => it.path).sort()).toEqual([relAttachment, relConfig].sort());
    expect(batch?.metadata?.project_rows?.[0]?.project_id).toBe(pid);

    await fsp.rm(path.dirname(abs(relConfig)), { recursive: true, force: true });
    await fsp.rm(projectFile);

    const restored = await restoreRecycleBatch(UID, batch!.id);

    expect(restored.restored_paths.sort()).toEqual([relAttachment, relConfig].sort());
    expect(restored.reactivated_paths).toContain(`cloud/projects/${pid}/project.json`);
    expect(JSON.parse(await fsp.readFile(abs(relConfig), 'utf-8')).project_id).toBe(pid);
    expect(await fsp.readFile(abs(relAttachment), 'utf-8')).toBe('input');
    expect(JSON.parse(await fsp.readFile(projectFile, 'utf-8')).name).toBe('Project One');
  });

  it('archives app-deleted agents with a human-readable agent title', async () => {
    const paths = await import('../../../src/main/paths');
    const { createAppRecycleBatchForAgent } = await import('../../../src/main/features/recycle_bin');

    const agentId = 'agent123';
    const relAgent = `cloud/agents/${agentId}/agent.json`;
    const relChat = 'cloud/chats/task1.jsonl';
    const abs = (relPath: string) => path.join(paths.userCloudRoot(UID), ...relPath.slice('cloud/'.length).split('/'));
    const indexFile = path.join(paths.userCloudRoot(UID), 'chats', '_index.json');

    await fsp.mkdir(path.dirname(abs(relAgent)), { recursive: true });
    await fsp.writeFile(abs(relAgent), JSON.stringify({
      agent_id: agentId,
      name: 'Research Partner',
      description: '',
      workflow: 'Help research.',
    }, null, 2));
    await fsp.mkdir(path.dirname(abs(relChat)), { recursive: true });
    await fsp.writeFile(abs(relChat), 'task body\n');
    await fsp.mkdir(path.dirname(indexFile), { recursive: true });
    await fsp.writeFile(indexFile, JSON.stringify([
      {
        conversation_id: 'task1',
        title: 'Task One',
        kind: 'normal',
        agent_id: agentId,
        session_id: 'gconv-task1',
        created_at: '2026-06-01T10:00:00.000Z',
        updated_at: '2026-06-01T10:00:00.000Z',
      },
    ], null, 2));

    const batch = await createAppRecycleBatchForAgent(UID, agentId);

    expect(batch?.items.map((it) => it.path)).not.toContain(relChat);
    expect(batch?.display_items).toEqual([
      expect.objectContaining({
        category: 'agent',
        title: 'Research Partner',
        id: agentId,
      }),
    ]);
  });

  it.each(['Agent', 'Skill'] as const)(
    'fails an incomplete %s recycle snapshot instead of allowing an unrecoverable delete',
    async (kind) => {
      const paths = await import('../../../src/main/paths');
      const {
        createAppRecycleBatchForAgent,
        createAppRecycleBatchForSkill,
        listRecycleBatches,
      } = await import('../../../src/main/features/recycle_bin');

      const id = kind === 'Agent' ? 'keep-safe-agent' : 'keep-safe-skill';
      const resourceDir = kind === 'Agent'
        ? path.join(paths.userAgentsDir(UID), id)
        : path.join(paths.userSkillsDir(UID), id);
      const requiredFile = path.join(resourceDir, kind === 'Agent' ? 'agent.json' : 'SKILL.md');
      const protectedFile = path.join(resourceDir, 'references', 'locked.md');
      await fsp.mkdir(path.dirname(protectedFile), { recursive: true });
      await fsp.writeFile(requiredFile, kind === 'Agent'
        ? JSON.stringify({
            agent_id: id,
            name: id,
            description: 'Must remain recoverable',
            workflow: 'Protect user data.',
          })
        : [
            '---',
            `name: "${id}"`,
            'description: "Must remain recoverable"',
            '---',
            '',
            '# Workflow',
          ].join('\n'));
      await fsp.writeFile(protectedFile, 'must stay recoverable');
      const lockChild = process.platform === 'win32'
        ? await acquireExclusiveWindowsLock(protectedFile)
        : null;
      if (!lockChild) await fsp.chmod(protectedFile, 0o000);

      try {
        const createSnapshot = kind === 'Agent'
          ? createAppRecycleBatchForAgent
          : createAppRecycleBatchForSkill;
        await expect(createSnapshot(UID, id)).rejects.toMatchObject({
          code: 'recycle_archive_failed',
        });
        expect(await listRecycleBatches(UID)).toEqual([]);
        expect(await fsp.readFile(requiredFile, 'utf8')).toContain(
          kind === 'Agent' ? 'Protect user data.' : '# Workflow',
        );
      } finally {
        if (lockChild) await releaseExclusiveWindowsLock(lockChild);
        else await fsp.chmod(protectedFile, 0o600).catch(() => {});
      }
    },
  );

  it('fails an incomplete generic app-delete snapshot before the caller can remove the file', async () => {
    const paths = await import('../../../src/main/paths');
    const {
      createAppRecycleBatchForCloudEntry,
      listRecycleBatches,
    } = await import('../../../src/main/features/recycle_bin');
    const relPath = 'cloud/contexts/locked.txt';
    const target = path.join(paths.userCloudRoot(UID), 'contexts', 'locked.txt');
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, 'must stay recoverable');
    const lockChild = process.platform === 'win32'
      ? await acquireExclusiveWindowsLock(target)
      : null;
    if (!lockChild) await fsp.chmod(target, 0o000);

    try {
      await expect(createAppRecycleBatchForCloudEntry(UID, relPath, 'context'))
        .rejects.toMatchObject({ code: 'recycle_archive_failed' });
      expect(await listRecycleBatches(UID)).toEqual([]);
    } finally {
      if (lockChild) await releaseExclusiveWindowsLock(lockChild);
      else await fsp.chmod(target, 0o600).catch(() => {});
    }
    expect(await fsp.readFile(target, 'utf8')).toBe('must stay recoverable');
  });

  it('labels cloud-sync recycle batches with deleted object titles, not file counts', async () => {
    const paths = await import('../../../src/main/paths');
    const {
      createRecycleBatch,
      listRecycleBatches,
    } = await import('../../../src/main/features/recycle_bin');

    const taskId = 'at_abcdef12';
    const relConfig = `cloud/auto_tasks/${taskId}/config.json`;
    const abs = (relPath: string) => path.join(paths.userCloudRoot(UID), ...relPath.slice('cloud/'.length).split('/'));

    await fsp.mkdir(path.dirname(abs(relConfig)), { recursive: true });
    await fsp.writeFile(abs(relConfig), JSON.stringify({
      id: taskId,
      enabled: true,
      title: 'Daily Sales Digest',
      content: 'Summarize yesterday sales',
      schedule: { type: 'daily', hour: 9, minute: 0 },
      created_at: '2026-05-29T10:00:00.000Z',
      updated_at: '2026-05-29T10:00:00.000Z',
    }, null, 2));

    const batch = await createRecycleBatch(UID, [relConfig]);

    expect(batch?.source).toBe('cloud_sync');
    expect(batch?.display_items).toEqual([
      expect.objectContaining({
        category: 'auto_task',
        title: 'Daily Sales Digest',
        id: taskId,
      }),
    ]);

    await fsp.rm(abs(relConfig));
    const [listed] = await listRecycleBatches(UID);
    expect(listed.display_items?.[0]).toEqual(expect.objectContaining({
      category: 'auto_task',
      title: 'Daily Sales Digest',
      id: taskId,
    }));
  });

  it('labels project library, skill, and saved app entries with readable titles', async () => {
    const paths = await import('../../../src/main/paths');
    const { createRecycleBatch } = await import('../../../src/main/features/recycle_bin');

    const pid = 'p_library1';
    const relProjectFile = `cloud/projects/${pid}/files/specs/overview.md`;
    const relSkill = 'cloud/skills/skill_alpha/SKILL.md';
    const relSavedApp = 'cloud/saved_apps/app_alpha/__orkas-meta.json';
    const abs = (relPath: string) => path.join(paths.userCloudRoot(UID), ...relPath.slice('cloud/'.length).split('/'));
    const projectFile = paths.projectMetaFile(UID, pid);

    for (const relPath of [relProjectFile, relSkill, relSavedApp]) {
      await fsp.mkdir(path.dirname(abs(relPath)), { recursive: true });
    }
    await fsp.mkdir(path.dirname(projectFile), { recursive: true });
    await fsp.writeFile(projectFile, JSON.stringify({
      project_id: pid,
      name: 'Knowledge Hub',
      owner_uid: UID,
      created_at: '2026-06-01T09:00:00.000Z',
      updated_at: '2026-06-01T09:00:00.000Z',
    }, null, 2));
    await fsp.writeFile(abs(relProjectFile), '# Overview\n');
    await fsp.writeFile(abs(relSkill), '---\nname: Release Writer\n---\nWrite release notes.');
    await fsp.writeFile(abs(relSavedApp), JSON.stringify({
      id: 'app_alpha',
      title: 'Ops Dashboard',
    }, null, 2));

    const batch = await createRecycleBatch(UID, [relProjectFile, relSkill, relSavedApp]);

    expect(batch?.display_items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        category: 'project_file',
        title: 'specs/overview.md',
        detail: 'Knowledge Hub',
        path: relProjectFile,
      }),
      expect.objectContaining({
        category: 'skill',
        title: 'Release Writer',
        id: 'skill_alpha',
      }),
      expect.objectContaining({
        category: 'saved_app',
        title: 'Ops Dashboard',
        id: 'app_alpha',
      }),
    ]));
  });

  it('migrates legacy sync recycle batches into the global recycle bin', async () => {
    const paths = await import('../../../src/main/paths');
    const {
      listRecycleBatches,
      restoreRecycleBatch,
    } = await import('../../../src/main/features/recycle_bin');

    const batchId = '2026-05-29T12-00-00-000Z-legacy1';
    const relPath = 'cloud/memory/MEMORY.md';
    const legacyDir = path.join(paths.userSyncRecycleDir(UID), batchId);
    const legacyFile = path.join(legacyDir, 'files', 'memory', 'MEMORY.md');
    const restoredFile = path.join(paths.userCloudRoot(UID), 'memory', 'MEMORY.md');
    await fsp.mkdir(path.dirname(legacyFile), { recursive: true });
    await fsp.writeFile(legacyFile, 'legacy memory');
    await fsp.writeFile(path.join(legacyDir, 'batch.json'), JSON.stringify({
      id: batchId,
      source: 'app',
      reason: 'app_delete',
      kind: 'other',
      created_at_ms: Date.UTC(2026, 4, 29, 12, 0, 0),
      expires_at_ms: Date.UTC(2026, 4, 30, 12, 0, 0),
      items: [{ path: relPath, size: '13' }],
      total_bytes: 13,
      paths_preview: [relPath],
    }, null, 2));

    const [batch] = await listRecycleBatches(UID);

    expect(batch).toEqual(expect.objectContaining({
      id: batchId,
      source: 'cloud_sync',
      reason: 'remote_tombstone',
    }));
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.existsSync(path.join(paths.userRecycleDir(UID), batchId))).toBe(true);

    const restored = await restoreRecycleBatch(UID, batchId);

    expect(restored.restored_paths).toEqual([relPath]);
    expect(await fsp.readFile(restoredFile, 'utf-8')).toBe('legacy memory');
  });

  it('rejects unsafe recycle paths without echoing the raw payload', async () => {
    const {
      assertSafeCloudRelPath,
      createAppRecycleBatch,
      createRecycleBatch,
      listRecycleBatches,
    } = await import('../../../src/main/features/recycle_bin');

    const unsafePath = 'cloud/chats/../private-secret.jsonl';

    expect(() => assertSafeCloudRelPath(unsafePath)).toThrow('unsafe recycle path');
    try {
      assertSafeCloudRelPath(unsafePath);
    } catch (err) {
      expect((err as Error).message).not.toContain('private-secret');
    }
    await expect(createRecycleBatch(UID, [unsafePath])).resolves.toBeNull();
    await expect(createAppRecycleBatch(UID, [unsafePath], { kind: 'other' })).resolves.toBeNull();
    expect(await listRecycleBatches(UID)).toEqual([]);
  });

  it('does not recreate an empty project when every archived file is missing', async () => {
    const paths = await import('../../../src/main/paths');
    const projects = await import('../../../src/main/features/projects');
    const {
      createAppRecycleBatchForProject,
      restoreRecycleBatch,
    } = await import('../../../src/main/features/recycle_bin');

    const created = await projects.createProject(UID, 'Corrupt Recovery Project');
    if (!created.ok) throw new Error('project create failed');
    const projectId = created.project.project_id;
    const batch = await createAppRecycleBatchForProject(UID, projectId);
    if (!batch) throw new Error('recycle snapshot failed');
    const deleted = await projects.deleteProject(UID, projectId);
    expect(deleted.ok).toBe(true);

    for (const item of batch.items) {
      const archived = path.join(
        paths.userRecycleDir(UID),
        batch.id,
        'files',
        ...item.path.slice('cloud/'.length).split('/'),
      );
      await fsp.rm(archived, { recursive: true, force: true });
    }

    const restored = await restoreRecycleBatch(UID, batch.id);

    expect(restored.restored_paths).toEqual([]);
    expect(restored.skipped_paths).toEqual([]);
    expect(restored.failed_paths.sort()).toEqual(batch.items.map((item) => item.path).sort());
    expect(restored.reactivated_paths).toEqual([]);
    expect(await projects.listProjects(UID)).toEqual([]);
  });

  it('restores a project delete cascade while showing only the project in the recycle bin', async () => {
    const paths = await import('../../../src/main/paths');
    const projects = await import('../../../src/main/features/projects');
    const chats = await import('../../../src/main/features/chats');
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    const {
      createAppRecycleBatchForProject,
      listRecycleBatches,
      restoreRecycleBatch,
    } = await import('../../../src/main/features/recycle_bin');

    const createdProject = await projects.createProject(UID, 'Client Launch');
    if (!createdProject.ok) throw new Error('project create failed');
    const pid = createdProject.project.project_id;
    const conv = await chats.createConversation(UID, {
      title: 'Launch checklist',
      projectId: pid,
    });
    const task = await autoTasks.createTask(UID, {
      id: 'at_c0ffee12',
      title: 'Weekly launch report',
      content: 'Prepare the weekly launch report',
      project_id: pid,
      schedule: { type: 'weekly', weekday: 1, hour: 9, minute: 0 },
      attachments: ['brief.txt'],
    });
    if (!task.ok) throw new Error('task create failed');
    await autoTasks.uploadAttachment(UID, 'at_c0ffee12', 'brief.txt', Buffer.from('brief'));

    const batch = await createAppRecycleBatchForProject(UID, pid);
    expect(batch?.display_items).toEqual([
      expect.objectContaining({
        category: 'project',
        title: 'Client Launch',
        id: pid,
      }),
    ]);
    const batchFile = path.join(paths.userRecycleDir(UID), batch!.id, 'batch.json');
    const legacyBatch = JSON.parse(await fsp.readFile(batchFile, 'utf-8'));
    legacyBatch.display_items.push({
      category: 'auto_task',
      title: 'Weekly launch report',
      id: 'at_c0ffee12',
    });
    await fsp.writeFile(batchFile, JSON.stringify(legacyBatch, null, 2));
    const [listedProjectBatch] = await listRecycleBatches(UID);
    expect(listedProjectBatch.display_items).toEqual([
      expect.objectContaining({
        category: 'project',
        title: 'Client Launch',
        id: pid,
      }),
    ]);

    const deleted = await projects.deleteProject(UID, pid);
    expect(deleted.ok).toBe(true);
    expect(await projects.listProjects(UID)).toEqual([]);
    expect(await autoTasks.listTasks(UID, { projectId: pid })).toEqual([]);

    const restored = await restoreRecycleBatch(UID, batch!.id);
    expect(restored.failed_paths).toEqual([]);
    expect(restored.restored_paths).toEqual(expect.arrayContaining([
      `cloud/projects/${pid}/project.json`,
      `cloud/projects/${pid}/chats/${conv.conversation_id}.jsonl`,
      `cloud/projects/${pid}/auto_tasks/at_c0ffee12/config.json`,
      `cloud/projects/${pid}/auto_tasks/at_c0ffee12/attachments/brief.txt`,
    ]));
    expect(fs.existsSync(path.join(paths.userRecycleDir(UID), batch!.id))).toBe(true);
    const [batchAfterRestore] = await listRecycleBatches(UID);
    expect(batchAfterRestore.id).toBe(batch!.id);

    const restoredProjects = await projects.listProjects(UID);
    expect(restoredProjects).toEqual([
      expect.objectContaining({
        project_id: pid,
        name: 'Client Launch',
        conv_count: 1,
      }),
    ]);
    const restoredTasks = await autoTasks.listTasks(UID, { projectId: pid });
    expect(restoredTasks).toEqual([
      expect.objectContaining({
        id: 'at_c0ffee12',
        title: 'Weekly launch report',
        project_id: pid,
      }),
    ]);
    const attachmentPath = path.join(
      paths.userCloudRoot(UID),
      'projects',
      pid,
      'auto_tasks',
      'at_c0ffee12',
      'attachments',
      'brief.txt',
    );
    expect(await fsp.readFile(attachmentPath, 'utf-8')).toBe('brief');
  });

  it('fails a project recycle snapshot if any cascade file cannot be archived', async () => {
    const paths = await import('../../../src/main/paths');
    const projects = await import('../../../src/main/features/projects');
    const {
      createAppRecycleBatchForProject,
      listRecycleBatches,
    } = await import('../../../src/main/features/recycle_bin');

    const createdProject = await projects.createProject(UID, 'Do Not Lose Files');
    if (!createdProject.ok) throw new Error('project create failed');
    const pid = createdProject.project.project_id;
    const protectedFile = path.join(paths.projectFilesDir(UID, pid), 'locked.txt');
    await fsp.mkdir(path.dirname(protectedFile), { recursive: true });
    await fsp.writeFile(protectedFile, 'must stay recoverable');
    const lockChild = process.platform === 'win32'
      ? await acquireExclusiveWindowsLock(protectedFile)
      : null;
    if (!lockChild) await fsp.chmod(protectedFile, 0o000);

    try {
      await expect(createAppRecycleBatchForProject(UID, pid)).rejects.toMatchObject({
        code: 'recycle_archive_failed',
      });
      expect(await listRecycleBatches(UID)).toEqual([]);
      expect(await projects.getProject(UID, pid)).toEqual(expect.objectContaining({
        project_id: pid,
        name: 'Do Not Lose Files',
      }));
    } finally {
      if (lockChild) await releaseExclusiveWindowsLock(lockChild);
      else await fsp.chmod(protectedFile, 0o600).catch(() => {});
    }
  });
});
