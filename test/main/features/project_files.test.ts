import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMinimalPptx, makeMinimalXlsx } from '../../fixtures/make-minimal-office';

let tmpDir: string;
let prevWs: string | undefined;

const enqueueCalls: Array<{ userId: string; projectId: string; name: string; op: string }> = [];

vi.mock('../../../src/main/features/projects', () => ({
  projectExists: async () => true,
}));

vi.mock('../../../src/main/features/project_library_indexer', () => ({
  enqueue: (userId: string, projectId: string, name: string, op = 'upsert') => {
    enqueueCalls.push({ userId, projectId, name, op });
  },
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-files-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  enqueueCalls.length = 0;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('project_files › modern Office support', () => {
  it('accepts spreadsheets and presentations into project files', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    const sheet = await projectFiles.uploadProjectFile('u1', 'p1', 'sources/scores.xlsx', makeMinimalXlsx());
    const deck = await projectFiles.uploadProjectFile('u1', 'p1', 'slides.pptx', makeMinimalPptx());

    expect(sheet.ok).toBe(true);
    expect(deck.ok).toBe(true);
    expect((sheet as any).info.kind).toBe('spreadsheet');
    expect((deck as any).info.kind).toBe('presentation');
    expect(enqueueCalls).toContainEqual({ userId: 'u1', projectId: 'p1', name: 'sources/scores.xlsx', op: 'upsert' });
    expect(enqueueCalls).toContainEqual({ userId: 'u1', projectId: 'p1', name: 'slides.pptx', op: 'upsert' });
  });

  it('renders project Office previews', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    await projectFiles.uploadProjectFile('u1', 'p1', 'scores.xlsx', makeMinimalXlsx({
      rows: [['Name'], ['Ada']],
    }));

    const preview = await projectFiles.readProjectOfficeHtml('u1', 'p1', 'scores.xlsx');
    expect(preview.ok).toBe(true);
    expect((preview as any).kind).toBe('spreadsheet');
    expect((preview as any).html).toContain('Ada');
    expect((preview as any).html).toContain('office-preview office-spreadsheet');
  });
});

describe('project_files › async project tree', () => {
  it('returns a stable nested tree while filtering hidden and unsupported files', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    const rootFile = await projectFiles.uploadProjectFile('u1', 'p1', '10.md', Buffer.from('ten'));
    await projectFiles.uploadProjectFile('u1', 'p1', '2.md', Buffer.from('two'));
    await projectFiles.uploadProjectFile('u1', 'p1', 'notes/readme.txt', Buffer.from('nested'));
    expect(rootFile.ok).toBe(true);

    const root = path.dirname((rootFile as any).info.path);
    fs.writeFileSync(path.join(root, '.hidden.md'), 'hidden');
    fs.writeFileSync(path.join(root, 'ignored.bin'), 'binary');
    fs.mkdirSync(path.join(root, '.hidden-dir'));
    fs.writeFileSync(path.join(root, '.hidden-dir', 'secret.md'), 'secret');

    const tree = await projectFiles.listProjectFileTree('u1', 'p1');

    expect(tree.map((node) => node.name)).toEqual(['notes', '2.md', '10.md']);
    expect(tree[0]).toMatchObject({
      name: 'notes',
      relPath: 'notes',
      type: 'dir',
      children: [expect.objectContaining({
        name: 'readme.txt',
        relPath: 'notes/readme.txt',
        type: 'file',
        kind: 'text',
      })],
    });
  });

  it('reuses a warm tree and invalidates it after a supported write', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    await projectFiles.uploadProjectFile('u1', 'p1', 'first.md', Buffer.from('first'));
    await projectFiles.listProjectFileTree('u1', 'p1');

    const root = path.dirname((await projectFiles.listProjectFileTree('u1', 'p1'))[0].path);
    fs.writeFileSync(path.join(root, 'out-of-band.md'), 'external');
    const warm = await projectFiles.listProjectFileTree('u1', 'p1');
    expect(warm.map((node) => node.name)).toEqual(['first.md']);

    await projectFiles.uploadProjectFile('u1', 'p1', 'second.md', Buffer.from('second'));
    const refreshed = await projectFiles.listProjectFileTree('u1', 'p1');
    expect(refreshed.map((node) => node.name)).toEqual(['first.md', 'out-of-band.md', 'second.md']);
  });
});

describe('project_files › file-system moves', () => {
  it('moves a file into another folder and re-enqueues both paths', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    await projectFiles.createProjectDir('u1', 'p1', 'inbox');
    await projectFiles.createProjectDir('u1', 'p1', 'archive');
    await projectFiles.uploadProjectFile('u1', 'p1', 'inbox/note.md', Buffer.from('# note'));
    enqueueCalls.length = 0;

    const moved = await projectFiles.renameProjectFile('u1', 'p1', 'inbox/note.md', 'archive/note.md');

    expect(moved.ok).toBe(true);
    const root = path.join(tmpDir, 'u1', 'cloud', 'projects', 'p1', 'contexts');
    expect(fs.existsSync(path.join(root, 'inbox/note.md'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'archive/note.md'), 'utf8')).toBe('# note');
    expect(enqueueCalls).toContainEqual({ userId: 'u1', projectId: 'p1', name: 'inbox/note.md', op: 'delete' });
    expect(enqueueCalls).toContainEqual({ userId: 'u1', projectId: 'p1', name: 'archive/note.md', op: 'upsert' });
  });

  it('moves a folder recursively and rejects moving it into itself', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    await projectFiles.createProjectDir('u1', 'p1', 'inbox/nested');
    await projectFiles.createProjectDir('u1', 'p1', 'archive');
    await projectFiles.uploadProjectFile('u1', 'p1', 'inbox/nested/note.md', Buffer.from('# note'));

    const invalid = await projectFiles.renameProjectFile('u1', 'p1', 'inbox', 'inbox/nested/inbox');
    expect(invalid.ok).toBe(false);

    const moved = await projectFiles.renameProjectFile('u1', 'p1', 'inbox', 'archive/inbox');
    expect(moved.ok).toBe(true);
    const root = path.join(tmpDir, 'u1', 'cloud', 'projects', 'p1', 'contexts');
    expect(fs.existsSync(path.join(root, 'inbox'))).toBe(false);
    expect(fs.readFileSync(path.join(root, 'archive/inbox/nested/note.md'), 'utf8')).toBe('# note');
  });

  it('keeps the source when the target already exists', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    await projectFiles.createProjectDir('u1', 'p1', 'inbox');
    await projectFiles.createProjectDir('u1', 'p1', 'archive');
    await projectFiles.uploadProjectFile('u1', 'p1', 'inbox/note.md', Buffer.from('source'));
    await projectFiles.uploadProjectFile('u1', 'p1', 'archive/note.md', Buffer.from('target'));

    const moved = await projectFiles.renameProjectFile('u1', 'p1', 'inbox/note.md', 'archive/note.md');

    expect(moved.ok).toBe(false);
    const root = path.join(tmpDir, 'u1', 'cloud', 'projects', 'p1', 'contexts');
    expect(fs.readFileSync(path.join(root, 'inbox/note.md'), 'utf8')).toBe('source');
    expect(fs.readFileSync(path.join(root, 'archive/note.md'), 'utf8')).toBe('target');
  });
});

describe('project_files › copyProjectEntryFromPath', () => {
  it('copies an external folder recursively into a project Library', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    const source = path.join(tmpDir, 'external');
    fs.mkdirSync(path.join(source, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(source, 'nested', 'note.md'), '# note');
    const root = path.join(tmpDir, 'u1', 'cloud', 'projects', 'p1', 'contexts');
    fs.mkdirSync(path.join(root, 'imports'), { recursive: true });
    enqueueCalls.length = 0;

    const copied = await projectFiles.copyProjectEntryFromPath('u1', 'p1', source, 'imports/external');

    expect(copied).toMatchObject({ ok: true, fileCount: 1 });
    expect(fs.readFileSync(path.join(root, 'imports/external/nested/note.md'), 'utf8')).toBe('# note');
    expect(enqueueCalls).toContainEqual({
      userId: 'u1', projectId: 'p1', name: 'imports/external/nested/note.md', op: 'upsert',
    });
  });

  it('rejects an unsupported source file for the project destination', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    const source = path.join(tmpDir, 'unsupported.exe');
    fs.writeFileSync(source, 'binary');

    const copied = await projectFiles.copyProjectEntryFromPath('u1', 'p1', source, 'unsupported.exe');

    expect(copied).toMatchObject({ ok: false });
  });

  it('does not recreate a missing destination folder', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    const source = path.join(tmpDir, 'note.md');
    fs.writeFileSync(source, '# note');

    const copied = await projectFiles.copyProjectEntryFromPath('u1', 'p1', source, 'missing/note.md');

    expect(copied).toMatchObject({ ok: false, error: 'not_found' });
  });
});
