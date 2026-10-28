import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../src/main/features/projects', () => ({
  projectExists: async () => true,
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-library-transfer-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules(); vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser('u1');
});

afterEach(async () => {
  await drainMainRuntimeForTest();
  if (previousWorkspace === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(root, { recursive: true, force: true });
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
