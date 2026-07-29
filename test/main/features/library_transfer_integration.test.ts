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
  vi.resetModules();
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
