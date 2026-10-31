import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

const hooks = vi.hoisted(() => ({ beforeProjectAccess: null as null | (() => void) }));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/main/features/projects', () => ({
  projectExists: async () => { hooks.beforeProjectAccess?.(); return true; },
  getProject: async () => ({ project_id: 'p1' }),
}));

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: vi.fn(),
  kbEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock('../../../src/main/features/project_library_indexer', () => ({
  enqueue: vi.fn(),
}));

vi.mock('../../../src/main/features/search', () => ({
  upsertContext: vi.fn(),
  dropContext: vi.fn(),
}));

let root: string;
let previousWorkspace: string | undefined;

function globalPath(rel: string): string {
  return path.join(root, 'u1', 'cloud', 'contexts', rel);
}

function projectPath(rel: string): string {
  return path.join(root, 'u1', 'cloud', 'projects', 'p1', 'contexts', rel);
}

function seed(target: string, content: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}

beforeEach(async () => {
  hooks.beforeProjectAccess = null;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-library-transfer-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules(); vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser('u1');
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await drainMainRuntimeForTest();
  if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(root, { recursive: true, force: true });
});

it.each(['file', 'folder'] as const)('preserves a %s edited during awaited project source deletion', async (kind) => {
  const entry = kind === 'file' ? 'latest.md' : 'folder';
  const relative = kind === 'file' ? entry : `${entry}/latest.md`;
  seed(projectPath(relative), 'Copied revision');
  const transfer = await import('../../../src/main/features/library_transfer');
  let edited = false;
  hooks.beforeProjectAccess = () => {
    if (!edited && fs.existsSync(globalPath(entry))) {
      edited = true;
      seed(projectPath(relative), 'Saved during deletion preparation');
    }
  };

  const result = await transfer.transferLibraryEntries('u1', {
    mode: 'move', source: { scope: 'project', projectId: 'p1' }, paths: [entry], destination: { scope: 'global' },
  });

  expect(edited).toBe(true);
  expect(fs.existsSync(projectPath(relative))).toBe(true);
  expect(fs.readFileSync(projectPath(relative), 'utf8')).toBe('Saved during deletion preparation');
  expect(fs.existsSync(globalPath(entry))).toBe(false);
  expect(result).toMatchObject({ ok: true, succeeded: 0, failed: 1, results: [{ error: 'source_delete_failed' }] });
});

it('fails closed when source metadata cannot establish a revision', async () => {
  const source = globalPath('unreadable.md');
  seed(source, 'Source must survive');
  const transfer = await import('../../../src/main/features/library_transfer');
  const nodeFs = (await import('node:fs')).default;
  const promises = (await import('node:fs/promises')).default;
  const stat = nodeFs.statSync;
  const lstat = promises.lstat;
  let syncFailures = 0;
  vi.spyOn(nodeFs, 'statSync').mockImplementation(((filename: any, ...args: any[]) => {
    if (String(filename) === source && syncFailures++ < 2) {
      throw Object.assign(new Error('Injected metadata read failure'), { code: 'EIO' });
    }
    return (stat as any)(filename, ...args);
  }) as any);
  vi.spyOn(promises, 'lstat').mockImplementation(((filename: any, ...args: any[]) => {
    if (String(filename) === source) {
      return Promise.reject(Object.assign(new Error('Injected revision read failure'), { code: 'EIO' }));
    }
    return (lstat as any)(filename, ...args);
  }) as any);
  syncBuiltinESMExports();

  const result = await transfer.transferLibraryEntries('u1', {
    mode: 'move', source: { scope: 'global' }, paths: ['unreadable.md'], destination: { scope: 'project', projectId: 'p1' },
  });

  expect(fs.existsSync(source)).toBe(true);
  expect(fs.readFileSync(source, 'utf8')).toBe('Source must survive');
  expect(fs.existsSync(projectPath('unreadable.md'))).toBe(false);
  expect(result).toMatchObject({ ok: true, succeeded: 0, failed: 1 });
});

it('rejects a nested symlink without scanning the directory it points to', async () => {
  const outside = path.join(root, 'outside');
  seed(path.join(outside, 'unrelated.md'), 'Outside document');
  fs.mkdirSync(projectPath('folder'), { recursive: true });
  const linked = projectPath('folder/linked');
  fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const transfer = await import('../../../src/main/features/library_transfer');
  const nodeFs = (await import('node:fs')).default;
  const promises = (await import('node:fs/promises')).default;
  const readdir = nodeFs.readdirSync;
  const opendir = promises.opendir;
  let traversedLink = false;
  const observe = (filename: unknown) => {
    const value = String(filename);
    if (value === linked || value.startsWith(`${linked}${path.sep}`)) traversedLink = true;
  };
  vi.spyOn(nodeFs, 'readdirSync').mockImplementation(((filename: any, ...args: any[]) => {
    observe(filename); return (readdir as any)(filename, ...args);
  }) as any);
  vi.spyOn(promises, 'opendir').mockImplementation(((filename: any, ...args: any[]) => {
    observe(filename); return (opendir as any)(filename, ...args);
  }) as any);
  syncBuiltinESMExports();

  const result = await transfer.transferLibraryEntries('u1', {
    mode: 'move', source: { scope: 'project', projectId: 'p1' }, paths: ['folder'], destination: { scope: 'global' },
  });

  expect(traversedLink).toBe(false);
  expect(result).toMatchObject({ ok: true, succeeded: 0, failed: 1 });
  expect(fs.existsSync(projectPath('folder'))).toBe(true);
  expect(fs.readFileSync(path.join(outside, 'unrelated.md'), 'utf8')).toBe('Outside document');
  expect(fs.existsSync(globalPath('folder'))).toBe(false);
});

it('preserves a replacement source even when its size and mtime match the copied file', async () => {
  const source = globalPath('same.md');
  seed(source, 'old');
  const timestamp = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(source, timestamp, timestamp);
  const transfer = await import('../../../src/main/features/library_transfer');
  const nodeFs = (await import('node:fs')).default;
  const copy = nodeFs.copyFileSync;
  let edited = false;
  vi.spyOn(nodeFs, 'copyFileSync').mockImplementation(((from: any, to: any, mode: any) => {
    copy(from, to, mode);
    if (String(from) === source && !edited) {
      edited = true;
      fs.writeFileSync(`${source}.replacement`, 'new');
      fs.renameSync(`${source}.replacement`, source);
      fs.utimesSync(source, timestamp, timestamp);
    }
  }) as any);
  syncBuiltinESMExports();

  const result = await transfer.transferLibraryEntries('u1', {
    mode: 'move', source: { scope: 'global' }, paths: ['same.md'], destination: { scope: 'project', projectId: 'p1' },
  });

  expect(edited).toBe(true);
  expect(fs.existsSync(source)).toBe(true);
  expect(fs.readFileSync(source, 'utf8')).toBe('new');
  expect(fs.existsSync(projectPath('same.md'))).toBe(false);
  expect(result).toMatchObject({ ok: true, succeeded: 0, failed: 1 });
});

it.each(['global', 'project'] as const)('retains the complete copy after a %s source is partially deleted', async (scope) => {
  const source = scope === 'global' ? globalPath : projectPath;
  const destination = scope === 'global' ? projectPath : globalPath;
  seed(source('folder/first.md'), 'First original');
  seed(source('folder/second.md'), 'Second original');
  const transfer = await import('../../../src/main/features/library_transfer');
  const nodeFs = (await import('node:fs')).default;
  const remove = nodeFs.rmSync;
  let interrupted = false;
  vi.spyOn(nodeFs, 'rmSync').mockImplementation(((target: any, ...args: any[]) => {
    if (String(target) === source('folder') && !interrupted) {
      interrupted = true;
      fs.unlinkSync(source('folder/first.md'));
      throw Object.assign(new Error('Injected partial deletion'), { code: 'EACCES' });
    }
    return (remove as any)(target, ...args);
  }) as any);
  syncBuiltinESMExports();

  const result = await transfer.transferLibraryEntries('u1', {
    mode: 'move', paths: ['folder'],
    source: scope === 'global' ? { scope: 'global' } : { scope: 'project', projectId: 'p1' },
    destination: scope === 'global' ? { scope: 'project', projectId: 'p1' } : { scope: 'global' },
  });

  expect(interrupted).toBe(true);
  expect(fs.existsSync(destination('folder/first.md'))).toBe(true);
  expect(fs.readFileSync(destination('folder/first.md'), 'utf8')).toBe('First original');
  expect(fs.readFileSync(destination('folder/second.md'), 'utf8')).toBe('Second original');
  expect(result).toMatchObject({ ok: true, succeeded: 0, failed: 1, results: [{ error: 'rollback_failed' }] });
});

describe('library_transfer filesystem lifecycle', () => {
  it('moves bytes from the global Library to one project destination', async () => {
    seed(globalPath('inbox/plan.md'), '# durable transfer\n');
    fs.mkdirSync(projectPath('archive'), { recursive: true });
    const transfer = await import('../../../src/main/features/library_transfer');

    const result = await transfer.transferLibraryEntries('u1', {
      mode: 'move',
      source: { scope: 'global' },
      paths: ['inbox/plan.md'],
      destination: { scope: 'project', projectId: 'p1', dir: 'archive' },
    });

    expect(result).toMatchObject({
      ok: true,
      succeeded: 1,
      failed: 0,
      results: [{
        source: 'inbox/plan.md',
        destination: 'archive/plan.md',
        ok: true,
      }],
    });
    expect(fs.existsSync(globalPath('inbox/plan.md'))).toBe(false);
    expect(fs.readFileSync(projectPath('archive/plan.md'), 'utf8')).toBe('# durable transfer\n');
  });

  it('preserves both source and existing destination when a move conflicts', async () => {
    seed(globalPath('plan.md'), 'source version');
    seed(projectPath('plan.md'), 'existing destination');
    const transfer = await import('../../../src/main/features/library_transfer');

    const result = await transfer.transferLibraryEntries('u1', {
      mode: 'move',
      source: { scope: 'global' },
      paths: ['plan.md'],
      destination: { scope: 'project', projectId: 'p1', dir: '' },
    });

    expect(result).toMatchObject({
      ok: true,
      succeeded: 0,
      failed: 1,
      results: [{ source: 'plan.md', error: 'target_exists' }],
    });
    expect(fs.readFileSync(globalPath('plan.md'), 'utf8')).toBe('source version');
    expect(fs.readFileSync(projectPath('plan.md'), 'utf8')).toBe('existing destination');
  });
});


it.each([
  ['global', 'file'], ['global', 'directory'],
  ['project', 'file'], ['project', 'directory'],
] as const)('preserves move sources and concurrent destinations when copying into %s loses a %s allocation race', async (destinationScope, kind) => {
  const destination = destinationScope === 'global' ? globalPath : projectPath;
  const source = destinationScope === 'global' ? projectPath : globalPath;
  const name = kind === 'file' ? 'source.md' : 'source-folder';
  const sourceFile = kind === 'file' ? source(name) : source(`${name}/copied.md`);
  const target = destination(`archive/${name}`);
  const winner = kind === 'file' ? target : path.join(target, 'winner.md');
  seed(sourceFile, 'Preserved move source'); fs.mkdirSync(destination('archive'), { recursive: true });
  const transfer = await import('../../../src/main/features/library_transfer');
  const nodeFs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const exists = nodeFs.existsSync; let checks = 0; let injected = false;
  const spy = vi.spyOn(nodeFs, 'existsSync').mockImplementation((filename: any) => {
    const present = exists(filename);
    if (String(filename) === target && ++checks === (destinationScope === 'global' ? 1 : 2) && !present) {
      if (kind === 'directory') fs.mkdirSync(target);
      fs.writeFileSync(winner, 'Preserved destination winner'); injected = true;
    }
    return present;
  }); syncBuiltinESMExports();
  let result: any;
  try {
    result = await transfer.transferLibraryEntries('u1', {
      mode: 'move', paths: [name],
      source: destinationScope === 'global' ? { scope: 'project', projectId: 'p1' } : { scope: 'global' },
      destination: destinationScope === 'global' ? { scope: 'global', dir: 'archive' }
        : { scope: 'project', projectId: 'p1', dir: 'archive' },
    });
  } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  expect(injected).toBe(true);
  expect({
    result: { ok: result.ok, succeeded: result.succeeded, failed: result.failed, error: result.results[0]?.error },
    source: fs.existsSync(sourceFile) ? fs.readFileSync(sourceFile, 'utf8') : null,
    winner: fs.existsSync(winner) ? fs.readFileSync(winner, 'utf8') : null,
    names: kind === 'directory' && fs.existsSync(target) ? fs.readdirSync(target).sort() : [],
  }).toEqual({
    result: { ok: true, succeeded: 0, failed: 1, error: 'target_exists' },
    source: 'Preserved move source', winner: 'Preserved destination winner',
    names: kind === 'directory' ? ['winner.md'] : [],
  });
  const kb = await import('../../../src/main/features/kb_indexer');
  const projects = await import('../../../src/main/features/project_library_indexer');
  expect(kb.enqueue).not.toHaveBeenCalled(); expect(projects.enqueue).not.toHaveBeenCalled();
});


it('continues a same-Library move batch after a recoverable parent-directory failure', async () => {
  seed(globalPath('blocked.md'), 'Preserved failed source');
  seed(globalPath('ready.md'), 'Successful move source');
  fs.mkdirSync(globalPath('archive'), { recursive: true });
  const transfer = await import('../../../src/main/features/library_transfer');
  const nodeFs = (await import('node:fs')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const mkdir = nodeFs.mkdirSync; let failed = false;
  const spy = vi.spyOn(nodeFs, 'mkdirSync').mockImplementation(((directory: any, ...args: any[]) => {
    if (String(directory) === globalPath('archive') && !failed) {
      failed = true; throw Object.assign(new Error('Injected parent failure'), { code: 'EACCES' });
    }
    return (mkdir as any)(directory, ...args);
  }) as any); syncBuiltinESMExports();
  let result: any;
  try {
    result = await transfer.transferLibraryEntries('u1', {
      mode: 'move', source: { scope: 'global' }, paths: ['blocked.md', 'ready.md'],
      destination: { scope: 'global', dir: 'archive' },
    });
  } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  expect(failed).toBe(true);
  expect(result).toMatchObject({ ok: true, succeeded: 1, failed: 1, results: [
    { source: 'blocked.md', ok: false, error: 'transfer_failed' },
    { source: 'ready.md', ok: true },
  ] });
  expect(fs.readFileSync(globalPath('blocked.md'), 'utf8')).toBe('Preserved failed source');
  expect(fs.existsSync(globalPath('archive/blocked.md'))).toBe(false);
  expect(fs.existsSync(globalPath('ready.md'))).toBe(false);
  expect(fs.readFileSync(globalPath('archive/ready.md'), 'utf8')).toBe('Successful move source');
  const kb = await import('../../../src/main/features/kb_indexer');
  expect(kb.enqueue).toHaveBeenCalledTimes(2);
  expect(kb.enqueue).toHaveBeenNthCalledWith(1, 'u1', 'ready.md', 'delete');
  expect(kb.enqueue).toHaveBeenNthCalledWith(2, 'u1', 'archive/ready.md', 'upsert');
});
