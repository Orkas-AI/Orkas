import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

type InvokeFn = (
  event: unknown,
  request: { channel: string; payload?: unknown },
) => Promise<{ ok: boolean; error?: string } & Record<string, unknown>>;

let invokeHandler: InvokeFn | null = null;
let tempRoot: string;
let previousWorkspaceRoot: string | undefined;
const TEST_UID = 'draft-preview-user';
let attachments: typeof import('../../../src/main/features/chat_attachments');
const { ipcWarnings } = vi.hoisted(() => ({ ipcWarnings: vi.fn() }));
vi.mock('../../../src/main/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/logger')>();
  return { ...actual, createLogger: (scope: string) => {
    const logger = actual.createLogger(scope);
    if (scope !== 'ipc') return logger;
    return { ...logger, warn: (...args: Parameters<typeof logger.warn>) => {
      ipcWarnings(...args);
      logger.warn(...args);
    } };
  } };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getVersion: vi.fn(() => '1.6.5'),
    on: vi.fn(),
    off: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, handler: InvokeFn) => {
      if (channel === 'orkas.invoke') invokeHandler = handler;
    },
    on: vi.fn(),
  },
  shell: {
    openExternal: vi.fn(async () => undefined),
    openPath: vi.fn(async () => ''),
    showItemInFolder: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
}));

beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-draft-preview-'));
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tempRoot;
  invokeHandler = null;
  vi.resetModules();

  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
  attachments = await import('../../../src/main/features/chat_attachments');
  const ipc = await import('../../../src/main/ipc/index');
  ipc.register();
});

afterAll(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function call(channel: string, payload: unknown): ReturnType<InvokeFn> {
  if (!invokeHandler) throw new Error('invoke handler not registered');
  return invokeHandler({ sender: trustedIpcSender() }, { channel, payload });
}

describe('IPC draft attachment preview scope', () => {
  async function uploadAndResolve(cid: string, name: string, body: string): Promise<string> {
    await expect(attachments.uploadAttachment(
      TEST_UID,
      cid,
      name,
      Buffer.from(body),
    )).resolves.toMatchObject({ ok: true });
    const resolved = attachments.resolveAttachmentAbsPath(TEST_UID, cid, name);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.error);
    return resolved.absPath;
  }

  it.each([
    ['contexts.attachToDraft', { cid: '', relPath: 'private-marker.md' }, 'input_validation'],
    ['contexts.attachToDraft', { cid: 'main_chat', relPath: 'private-marker.md' }, 'source_resolve'],
    ['projects.files.attachToDraft', { cid: 'main_chat', projectId: '', name: 'private-marker.md' }, 'input_validation'],
  ])('returns bounded stage information for %s failures without creating draft files', async (channel, payload, stage) => {
    const result = await call(channel, payload);
    expect(result).toMatchObject({ ok: false, failure_stage: stage,
      failure_kind: stage === 'source_resolve' ? 'not_found' : 'operation_failed' });
    expect(result.error).toBeTypeOf('string');
    expect(fs.existsSync(path.join(tempRoot, TEST_UID, 'local/chat_attachment_drafts/main_chat'))).toBe(false);
  });

  async function libraryFixture(scope: 'global' | 'project', tag: string, ext = 'pdf') {
    const paths = await import('../../../src/main/paths');
    const name = `private-${tag}.${ext}`;
    let root: string;
    let channel: string;
    let payload: Record<string, unknown>;
    if (scope === 'global') {
      root = paths.userContextsDir(TEST_UID);
      channel = 'contexts.attachToDraft';
      payload = { cid: 'main_chat', relPath: name };
    } else {
      const created = await call('projects.create', { name: `Diagnostic fixture ${tag}` });
      expect(created.ok).toBe(true);
      const projectId = (created.project as { project_id: string }).project_id;
      root = paths.projectFilesDir(TEST_UID, projectId);
      channel = 'projects.files.attachToDraft';
      payload = { cid: `projchat-${projectId}`, projectId, name };
    }
    fs.mkdirSync(root, { recursive: true });
    const source = path.join(root, name);
    fs.writeFileSync(source, `unique bytes ${scope} ${tag}`);
    return { source, channel, payload };
  }

  it.each(['global', 'project'] as const)('preserves %s Library copy errors and permits a clean deduplicated retry', async (scope) => {
    const fixture = await libraryFixture(scope, 'copy');
    const cid = String(fixture.payload.cid);
    const existingPath = await uploadAndResolve(cid, `existing-${scope}.txt`, 'keep existing attachment');
    const before = attachments.listPendingAttachments(TEST_UID, cid);
    for (const [errno, expected] of [['ENOSPC', 'disk_full'], ['EACCES', 'permission_denied'], ['EPERM', 'permission_denied'], ['ENOENT', 'not_found'], ['ENOTDIR', 'not_found'], ['EIO', 'operation_failed']]) {
      // An opaque message proves the diagnostic comes from errno, not text guessing.
      const copy = vi.spyOn(fs.promises, 'copyFile').mockRejectedValueOnce(Object.assign(new Error('opaque failure'), { code: errno }));
      try {
        const result = await call(fixture.channel, fixture.payload);
        expect(copy).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({ ok: false, code: 'E_UNKNOWN', error: 'opaque failure', failure_stage: 'attachment_import', failure_kind: expected });
        expect(attachments.listPendingAttachments(TEST_UID, cid)).toEqual(before);
        expect(fs.readFileSync(existingPath, 'utf8')).toBe('keep existing attachment');
        expect(fs.readFileSync(fixture.source, 'utf8')).toBe(`unique bytes ${scope} copy`);
      } finally { copy.mockRestore(); }
    }
    const first = await call(fixture.channel, fixture.payload);
    const repeat = await call(fixture.channel, fixture.payload);
    expect(first.ok).toBe(true);
    expect(repeat).toEqual(first);
    expect(attachments.listPendingAttachments(TEST_UID, String(fixture.payload.cid)).filter((file) => file.name === path.basename(fixture.source))).toHaveLength(1);
  });

  it.each(['global', 'project'] as const)('reports %s disk-full once in the main log without private error text', async (scope) => {
    const fixture = await libraryFixture(scope, 'log');
    const cid = String(fixture.payload.cid);
    const before = attachments.listPendingAttachments(TEST_UID, cid);
    const start = ipcWarnings.mock.calls.length;
    const copy = vi.spyOn(fs.promises, 'copyFile').mockRejectedValue(
      Object.assign(new Error('ENOSPC: PRIVATE_FILE_PATH'), { code: 'ENOSPC' }),
    );
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await call(fixture.channel, fixture.payload)).toMatchObject({
          ok: false, code: 'E_STORAGE_FULL', error: 'ENOSPC: PRIVATE_FILE_PATH',
          failure_stage: 'attachment_import', failure_kind: 'disk_full',
        });
        expect(attachments.listPendingAttachments(TEST_UID, cid)).toEqual(before);
      }
      const records = ipcWarnings.mock.calls.slice(start);
      expect(records).toEqual([['invoke returned failure', {
        channel: fixture.channel, code: 'E_STORAGE_FULL',
        failure_stage: 'attachment_import', failure_kind: 'disk_full',
      }]]);
      expect(JSON.stringify(records)).not.toContain('PRIVATE_FILE_PATH');
    } finally { copy.mockRestore(); }
    expect((await call(fixture.channel, fixture.payload)).ok).toBe(true);
  });

  it.each(['global', 'project'] as const)('recovers when a %s source disappears between resolution and import', async (scope) => {
    const fixture = await libraryFixture(scope, 'disappeared');
    const cid = String(fixture.payload.cid);
    const before = attachments.listPendingAttachments(TEST_UID, cid);
    const bytes = fs.readFileSync(fixture.source);
    const stat = nativeFs.statSync;
    let sourceStats = 0;
    const spy = vi.spyOn(nativeFs, 'statSync').mockImplementation(((target: fs.PathLike, ...args: any[]) => {
      // Global resolution stats once; project resolution uses lstat. Delete at
      // the import boundary and let the real filesystem produce ENOENT.
      if (String(target) === fixture.source && ++sourceStats === (scope === 'global' ? 2 : 1)) fs.unlinkSync(fixture.source);
      return (stat as any)(target, ...args);
    }) as any);
    syncBuiltinESMExports();
    try {
      expect(await call(fixture.channel, fixture.payload)).toMatchObject({
        ok: false, error: 'file not found', failure_stage: 'attachment_import', failure_kind: 'not_found',
      });
      expect(fs.existsSync(fixture.source)).toBe(false);
      expect(attachments.listPendingAttachments(TEST_UID, cid)).toEqual(before);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    fs.writeFileSync(fixture.source, bytes);
    const first = await call(fixture.channel, fixture.payload);
    expect(first.ok).toBe(true);
    expect(await call(fixture.channel, fixture.payload)).toEqual(first);
    const resolved = attachments.resolveAttachmentAbsPath(TEST_UID, cid, (first.info as { name: string }).name);
    if (!resolved.ok) throw new Error('restored attachment missing');
    expect(fs.readFileSync(resolved.absPath)).toEqual(bytes);
    expect(attachments.listPendingAttachments(TEST_UID, cid)).toHaveLength(before.length + 1);
  });

  it.each(['pdf', 'txt'])('retains %s read failures during hashing or UTF-8 validation', async (ext) => {
    const fixture = await libraryFixture('global', `read-${ext}`, ext);
    const read = nativeFs.createReadStream;
    const spy = vi.spyOn(nativeFs, 'createReadStream').mockImplementation((target, options) => {
      const stream = read(target, options);
      if (String(target) === fixture.source) stream.destroy(Object.assign(new Error('opaque read failure'), { code: 'EACCES' }));
      return stream;
    });
    syncBuiltinESMExports();
    try {
      expect(await call(fixture.channel, fixture.payload)).toMatchObject({
        ok: false, code: 'E_UNKNOWN', error: 'opaque read failure',
        failure_stage: 'attachment_import', failure_kind: 'permission_denied',
      });
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect((await call(fixture.channel, fixture.payload)).ok).toBe(true);
  });

  it.each(['global', 'project'] as const)('retains %s source access failure while preserving its existing caller error', async (scope) => {
    const fixture = await libraryFixture(scope, 'source');
    const method = scope === 'global' ? 'statSync' : 'lstatSync';
    const original = nativeFs[method];
    const spy = vi.spyOn(nativeFs, method).mockImplementation(((target: fs.PathLike, ...args: any[]) => {
      if (String(target) === fixture.source) throw Object.assign(new Error('PRIVATE_PATH'), { code: 'EACCES' });
      return (original as any)(target, ...args);
    }) as any);
    const exists = nativeFs.existsSync;
    const existsSpy = scope === 'global' ? vi.spyOn(nativeFs, 'existsSync').mockImplementation((target) => String(target) === fixture.source ? false : exists(target)) : null;
    syncBuiltinESMExports();
    try {
      const result = await call(fixture.channel, fixture.payload);
      expect(result).toMatchObject({ ok: false, failure_stage: 'source_resolve', failure_kind: 'permission_denied', code: scope === 'global' ? 'ENOENT' : 'E_UNKNOWN' });
      expect(result.error).not.toContain('PRIVATE_PATH');
    } finally { spy.mockRestore(); existsSpy?.mockRestore(); syncBuiltinESMExports(); }
  });

  it('stats and reads a completed Commander composer attachment', async () => {
    const absPath = await uploadAndResolve(
      'main_chat',
      'commander-draft.md',
      '# Commander draft\n',
    );

    await expect(call('workspace.statPath', {
      path: absPath,
      cid: 'main_chat',
    })).resolves.toMatchObject({ ok: true, exists: true, isFile: true });
    await expect(call('produced.readText', {
      path: absPath,
      cid: 'main_chat',
    })).resolves.toMatchObject({ ok: true, text: '# Commander draft\n' });
  });

  it('stats and reads a completed Project composer attachment', async () => {
    const cid = 'projchat-project-preview';
    const absPath = await uploadAndResolve(cid, 'project-draft.md', '# Project draft\n');

    await expect(call('workspace.statPath', {
      path: absPath,
      cid,
    })).resolves.toMatchObject({ ok: true, exists: true, isFile: true });
    await expect(call('produced.readText', {
      path: absPath,
      cid,
    })).resolves.toMatchObject({ ok: true, text: '# Project draft\n' });
  });

  it('preserves preview access for a sent conversation attachment', async () => {
    const cid = 'conversation-preview';
    const absPath = await uploadAndResolve(cid, 'sent-note.md', '# Sent note\n');

    await expect(call('workspace.statPath', {
      path: absPath,
      cid,
    })).resolves.toMatchObject({ ok: true, exists: true, isFile: true });
    await expect(call('produced.readText', {
      path: absPath,
      cid,
    })).resolves.toMatchObject({ ok: true, text: '# Sent note\n' });
  });

  it('rejects cross-draft preview even when both files exist', async () => {
    const commanderPath = await uploadAndResolve('main_chat', 'isolated-main.md', 'main');
    const projectCid = 'projchat-isolated-project';
    const projectPath = await uploadAndResolve(projectCid, 'isolated-project.md', 'project');

    await expect(call('workspace.statPath', {
      path: projectPath,
      cid: 'main_chat',
    })).resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
    await expect(call('workspace.statPath', {
      path: commanderPath,
      cid: projectCid,
    })).resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
  });

  it('rejects a draft path when cid is omitted', async () => {
    const absPath = await uploadAndResolve(
      'main_chat',
      'missing-cid.md',
      'must stay scoped',
    );

    await expect(call('workspace.statPath', {
      path: absPath,
    })).resolves.toMatchObject({ ok: false, error: 'path is outside the user workspace' });
  });
});
