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

// High-fidelity Office rendering has its own deterministic engine contract
// tests. Keep project filesystem tests independent of the bundled binary.
vi.mock('../../../src/main/features/office/office_engine', () => ({
  officeCliAvailable: () => false,
  runOfficeCli: vi.fn(),
  closeOfficeFile: vi.fn(),
}));

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-files-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  enqueueCalls.length = 0;
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('project_files › explicit versioned replacement', () => {
  it('preserves create-only saves and protects a newer user edit from a stale save', async () => {
    const files = await import('../../../src/main/features/project_files');
    await files.uploadProjectFile('u1', 'p1', 'report.md', Buffer.from('Original'));
    const working = path.join(tmpDir, 'working.md');
    const checkout = await files.checkoutProjectFile('u1', 'p1', 'report.md', working);
    expect(checkout.ok).toBe(true);
    if (!checkout.ok) throw new Error('checkout failed');
    expect(fs.readFileSync(working, 'utf8')).toBe('Original');
    fs.writeFileSync(working, 'Agent revision');
    expect(await files.copyProjectEntryFromPath('u1', 'p1', working, 'report.md'))
      .toMatchObject({ ok: false, error: 'target_exists' });
    expect(await files.checkoutProjectFile('u1', 'p1', 'report.md', working)).toMatchObject({ ok: false });
    expect(fs.readFileSync(working, 'utf8')).toBe('Agent revision');
    const saved = await files.replaceProjectFileFromPath('u1', 'p1', working, 'report.md', checkout.revision);
    expect(saved.ok).toBe(true);
    expect(await files.readProjectTextFile('u1', 'p1', 'report.md')).toMatchObject({ content: 'Agent revision' });
    if (!saved.ok) throw new Error('save failed');
    await files.updateProjectTextFile('u1', 'p1', 'report.md', 'Newer user edit');
    expect(await files.replaceProjectFileFromPath('u1', 'p1', working, 'report.md', saved.revision))
      .toMatchObject({ ok: false, error: expect.stringContaining('conflict') });
    expect(await files.readProjectTextFile('u1', 'p1', 'report.md')).toMatchObject({ content: 'Newer user edit' });
    expect(enqueueCalls.filter((call) => call.name === 'report.md')).toHaveLength(3);
  });

  it('binds revisions to the project and supports binary deliverables without text conversion', async () => {
    const files = await import('../../../src/main/features/project_files');
    const original = Buffer.from([0, 255, 12, 200]);
    for (const pid of ['p1', 'p2']) await files.uploadProjectFile('u1', pid, 'report.pdf', original);
    const working = path.join(tmpDir, 'working.pdf');
    const checkout = await files.checkoutProjectFile('u1', 'p1', 'report.pdf', working);
    if (!checkout.ok) throw new Error('checkout failed');
    expect(fs.readFileSync(working)).toEqual(original);
    fs.writeFileSync(working, Buffer.from([0, 254, 200]));
    expect(await files.replaceProjectFileFromPath('u1', 'p2', working, 'report.pdf', checkout.revision))
      .toMatchObject({ ok: false, error: expect.stringContaining('conflict') });
    const [one, two] = await Promise.all([
      files.replaceProjectFileFromPath('u1', 'p1', working, 'report.pdf', checkout.revision),
      files.replaceProjectFileFromPath('u1', 'p1', working, 'report.pdf', checkout.revision),
    ]);
    expect([one.ok, two.ok].sort()).toEqual([false, true]);
    const resolved = await files.resolveProjectFileAbsPath('u1', 'p1', 'report.pdf');
    if (!resolved.ok) throw new Error('resolve failed');
    expect(fs.readFileSync(resolved.absPath)).toEqual(Buffer.from([0, 254, 200]));
    expect(await files.checkoutProjectFile('u1', 'p1', '../ORKAS.md', path.join(tmpDir, 'escape.md')))
      .toMatchObject({ ok: false });
  });
});

describe('project_files › diagnostic privacy', () => {
  async function captureDiagnostics(): Promise<unknown[][]> {
    const logger = await import('../../../src/main/logger');
    const original = logger.createLogger;
    const records: unknown[][] = [];
    vi.spyOn(logger, 'createLogger').mockImplementation((scope) => {
      const scoped = original(scope);
      if (scope !== 'project_files') return scoped;
      const capture = (message: string, ...args: unknown[]) => {
        records.push([message, ...args].map((value) => logger.redact(value)));
      };
      return { info: capture, warn: capture, error: capture, debug: capture };
    });
    return records;
  }

  it('keeps Library names and cache error content private through edit, move, and delete', async () => {
    const records = await captureDiagnostics();
    const indexer = await import('../../../src/main/features/file_indexer');
    vi.spyOn(indexer, 'invalidateFileCache').mockImplementation(() => {
      throw new Error('Confidential acquisition excerpt');
    });
    const projectFiles = await import('../../../src/main/features/project_files');
    const name = 'Private diligence notes.md';
    const renamed = 'Private signed agreement.md';
    const uploaded = await projectFiles.uploadProjectFile('u1', 'p1', name, Buffer.from('original'));
    expect(uploaded.ok).toBe(true);
    expect(await projectFiles.updateProjectTextFile('u1', 'p1', name, 'revised'))
      .toMatchObject({ ok: true });
    expect(await projectFiles.renameProjectFile('u1', 'p1', name, renamed))
      .toMatchObject({ ok: true, name: renamed });
    expect(await projectFiles.readProjectTextFile('u1', 'p1', renamed))
      .toMatchObject({ ok: true, content: 'revised' });
    expect(await projectFiles.deleteProjectFile('u1', 'p1', renamed)).toEqual({ ok: true });
    expect(await projectFiles.listProjectFiles('u1', 'p1')).toEqual([]);
    expect(records).toHaveLength(4);
    const emitted = JSON.stringify(records);
    for (const privateText of [name, renamed, 'Confidential acquisition excerpt', tmpDir]) {
      expect(emitted).not.toContain(privateText);
    }
  });

  it('keeps recursive Library deletion diagnostics private without preventing deletion', async () => {
    const records = await captureDiagnostics();
    const indexer = await import('../../../src/main/features/file_indexer');
    vi.spyOn(indexer, 'invalidateFileCache').mockImplementation(() => {
      throw new Error('Confidential source fragment');
    });
    const projectFiles = await import('../../../src/main/features/project_files');
    const name = 'Private archive/Private source.md';
    expect((await projectFiles.uploadProjectFile('u1', 'p1', name, Buffer.from('original'))).ok).toBe(true);
    records.length = 0;
    expect(await projectFiles.deleteProjectEntry('u1', 'p1', 'Private archive')).toEqual({ ok: true });
    expect(await projectFiles.listProjectFiles('u1', 'p1')).toEqual([]);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toMatch(/Private archive|Private source|Confidential source fragment/);
  });

  it.each(['docx', 'xlsx'] as const)('keeps malformed %s preview diagnostics private and preserves the source', async (ext) => {
    const records = await captureDiagnostics();
    const projectFiles = await import('../../../src/main/features/project_files');
    const name = `Private acquisition.${ext}`;
    const source = Buffer.from('invalid document');
    const uploaded = await projectFiles.uploadProjectFile('u1', 'p1', name, source);
    if (!uploaded.ok) throw new Error('upload failed');
    records.length = 0;
    const result = ext === 'docx'
      ? await projectFiles.readProjectDocxHtml('u1', 'p1', name)
      : await projectFiles.readProjectOfficeHtml('u1', 'p1', name);
    expect(result).toMatchObject({ ok: false });
    expect(fs.readFileSync(uploaded.info.path)).toEqual(source);
    expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(name);
  });
});

describe('project_files › modern Office support', () => {
  it('imports a local file by path and enqueues the copied target', async () => {
    const source = path.join(tmpDir, 'picked.md');
    fs.writeFileSync(source, '# picked project file', 'utf8');
    const projectFiles = await import('../../../src/main/features/project_files');

    const result = await projectFiles.importProjectFileFromPath('u1', 'p1', 'imports/picked.md', source);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'u1', 'cloud', 'projects', 'p1', 'contexts', 'imports', 'picked.md'), 'utf8'))
      .toBe('# picked project file');
    expect(enqueueCalls).toContainEqual({ userId: 'u1', projectId: 'p1', name: 'imports/picked.md', op: 'upsert' });
  });

  it('allocates distinct names for concurrent path imports into one project', async () => {
    const first = path.join(tmpDir, 'first.md');
    const second = path.join(tmpDir, 'second.md');
    fs.writeFileSync(first, 'first', 'utf8');
    fs.writeFileSync(second, 'second', 'utf8');
    const projectFiles = await import('../../../src/main/features/project_files');

    const [a, b] = await Promise.all([
      projectFiles.importProjectFileFromPath('u1', 'p1', 'same.md', first),
      projectFiles.importProjectFileFromPath('u1', 'p1', 'same.md', second),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const names = [(a as any).info.relPath, (b as any).info.relPath];
    expect(new Set(names).size).toBe(2);
    expect(names).toContain('same.md');
    expect(names.some((name) => /^same-\d{8}-\d{6}(?:-\d+)?\.md$/.test(name))).toBe(true);
  });

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

  it('rejects a folder containing invalid UTF-8 without publishing a partial copy', async () => {
    const projectFiles = await import('../../../src/main/features/project_files');
    const source = path.join(tmpDir, 'corrupt-folder');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'good.md'), '# good');
    fs.writeFileSync(path.join(source, 'corrupt.txt'), Buffer.from([0xff, 0xfe]));
    const root = path.join(tmpDir, 'u1', 'cloud', 'projects', 'p1', 'contexts');
    fs.mkdirSync(path.join(root, 'imports'), { recursive: true });

    const copied = await projectFiles.copyProjectEntryFromPath(
      'u1', 'p1', source, 'imports/corrupt-folder',
    );

    expect(copied).toMatchObject({ ok: false, error: 'unsupported_destination' });
    expect(fs.existsSync(path.join(root, 'imports/corrupt-folder'))).toBe(false);
    expect(enqueueCalls).toEqual([]);
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

describe('project_files › path safety', () => {
  type ProjectFiles = typeof import('../../../src/main/features/project_files');
  it.each([
    { goal: 'read a file', run: (files: ProjectFiles) => files.readProjectTextFile('u1', 'p1', 'linked/note.md') },
    { goal: 'edit a file', run: (files: ProjectFiles) => files.updateProjectTextFile('u1', 'p1', 'linked/note.md', 'replaced') },
    { goal: 'upload a file', run: (files: ProjectFiles) => files.uploadProjectFile('u1', 'p1', 'linked/new.md', Buffer.from('new')) },
    { goal: 'create a folder', run: (files: ProjectFiles) => files.createProjectDir('u1', 'p1', 'linked/new-folder') },
    { goal: 'delete a file', run: (files: ProjectFiles) => files.deleteProjectFile('u1', 'p1', 'linked/note.md') },
    { goal: 'delete a folder', run: (files: ProjectFiles) => files.deleteProjectEntry('u1', 'p1', 'linked/folder') },
    { goal: 'move an outside file in', run: (files: ProjectFiles) => files.renameProjectFile('u1', 'p1', 'linked/note.md', 'moved.md') },
    { goal: 'move a Library file out', run: (files: ProjectFiles) => files.renameProjectFile('u1', 'p1', 'local.md', 'linked/moved.md') },
    { goal: 'copy a file out', run: (files: ProjectFiles) => files.copyProjectEntryFromPath('u1', 'p1', path.join(tmpDir, 'picked.md'), 'linked/copied.md') },
    { goal: 'resolve a transfer source', run: (files: ProjectFiles) => files.resolveProjectEntryAbsPath('u1', 'p1', 'linked/folder') },
  ])('refuses to $goal through an ancestor symlink', async ({ run }) => {
    const files = await import('../../../src/main/features/project_files');
    const root = path.join(tmpDir, 'u1', 'cloud', 'projects', 'p1', 'contexts');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(outside, 'folder'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'note.md'), 'private outside content');
    fs.writeFileSync(path.join(outside, 'folder', 'nested.md'), 'private nested content');
    fs.writeFileSync(path.join(root, 'local.md'), 'local source');
    fs.writeFileSync(path.join(tmpDir, 'picked.md'), 'picked source');
    fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');

    expect(await run(files)).toMatchObject({ ok: false });
    expect(fs.readFileSync(path.join(outside, 'note.md'), 'utf8')).toBe('private outside content');
    expect(fs.readFileSync(path.join(outside, 'folder', 'nested.md'), 'utf8')).toBe('private nested content');
    expect(fs.readdirSync(outside).sort()).toEqual(['folder', 'note.md']);
    expect(fs.readFileSync(path.join(root, 'local.md'), 'utf8')).toBe('local source');
    expect(enqueueCalls).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a project Library symlink before it can read or overwrite an outside file',
    async () => {
      const projectFiles = await import('../../../src/main/features/project_files');
      const root = path.join(tmpDir, 'u1', 'cloud', 'projects', 'p1', 'contexts');
      fs.mkdirSync(root, { recursive: true });
      const outside = path.join(tmpDir, 'outside.md');
      fs.writeFileSync(outside, 'outside');
      fs.symlinkSync(outside, path.join(root, 'leak.md'));

      expect(await projectFiles.resolveProjectFileAbsPath('u1', 'p1', 'leak.md'))
        .toMatchObject({ ok: false, error: 'symlink_not_supported' });
      expect(await projectFiles.readProjectTextFile('u1', 'p1', 'leak.md'))
        .toMatchObject({ ok: false, error: 'symlink_not_supported' });
      expect(await projectFiles.updateProjectTextFile('u1', 'p1', 'leak.md', 'overwritten'))
        .toMatchObject({ ok: false, error: 'symlink_not_supported' });
      expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
    },
  );
});
