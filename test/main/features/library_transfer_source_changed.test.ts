import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '',
  calls: [] as Array<{ op: string; args: unknown[] }>,
  duringCopy: null as null | (() => void),
}));

vi.mock('../../../src/main/features/users', () => ({
  getActiveUserId: () => 'u1',
}));

vi.mock('../../../src/main/features/contexts', () => ({
  resolveContextEntryAbsPath: (rel: string) => `${state.root}/${rel}`,
  copyContextEntryFromPath: (source: string, target: string) => {
    state.calls.push({ op: 'copy-global', args: [source, target] });
    return { ok: true, path: target, fileCount: 1, bytes: 10 };
  },
  deleteContextTarget: (rel: string, _uid: string, beforeDelete?: () => boolean) => {
    if (beforeDelete && !beforeDelete()) return { ok: false, error: 'source_changed' };
    state.calls.push({ op: 'delete-global', args: [rel] });
    fs.rmSync(path.join(state.root, rel), { recursive: true });
    return { ok: true };
  },
}));

vi.mock('../../../src/main/features/project_files', () => ({
  resolveProjectEntryAbsPath: async () => ({ ok: false, error: 'not_found' }),
  copyProjectEntryFromPath: async (_uid: string, _pid: string, source: string, target: string, onCopied?: (absolute: string) => void) => {
    state.calls.push({ op: 'copy-project', args: [source, target] });
    const absolute = path.join(state.root, 'project', target);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.cpSync(source, absolute, { recursive: true });
    onCopied?.(absolute);
    // Simulates a save after the operation records its actual copied revision.
    state.duringCopy?.();
    return { ok: true, name: target, fileCount: 1, bytes: 10 };
  },
  deleteProjectEntry: async (_uid: string, pid: string, rel: string, beforeDelete?: () => boolean) => {
    if (beforeDelete && !beforeDelete()) return { ok: false, error: 'source_changed' };
    state.calls.push({ op: 'delete-project', args: [pid, rel] });
    fs.rmSync(path.join(state.root, 'project', rel), { recursive: true });
    return { ok: true };
  },
}));

beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-transfer-'));
  state.calls.length = 0;
  state.duringCopy = null;
  vi.resetModules();
});

afterEach(() => {
  fs.rmSync(state.root, { recursive: true, force: true });
});

async function moveToProject(sourcePath: string) {
  const mod = await import('../../../src/main/features/library_transfer');
  return mod.transferLibraryEntries('u1', {
    mode: 'move',
    source: { scope: 'global' },
    paths: [sourcePath],
    destination: { scope: 'project', projectId: 'p1' },
  });
}

describe('library_transfer move when the source changes during the copy', () => {
  it('keeps both revisions when a file is edited mid-copy', async () => {
    const file = path.join(state.root, 'note.md');
    fs.writeFileSync(file, 'old');
    state.duringCopy = () => fs.writeFileSync(file, 'old and new edits');

    const result = await moveToProject('note.md');

    expect(result).toMatchObject({ ok: true, succeeded: 0, failed: 1 });
    expect((result as { results: Array<{ error?: string }> }).results[0].error).toBe('rollback_failed');
    expect(state.calls.map((row) => row.op)).toEqual(['copy-project']);
    expect(fs.readFileSync(file, 'utf8')).toBe('old and new edits');
    expect(fs.readFileSync(path.join(state.root, 'project/note.md'), 'utf8')).toBe('old');
  });

  it('keeps the source when a file is added to a moved folder mid-copy', async () => {
    const dir = path.join(state.root, 'folder');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'a.md'), 'a');
    state.duringCopy = () => fs.writeFileSync(path.join(dir, 'b.md'), 'b');

    const result = await moveToProject('folder');

    expect(result).toMatchObject({ ok: true, succeeded: 0, failed: 1 });
    expect(state.calls.map((row) => row.op)).toEqual(['copy-project']);
    expect(fs.readFileSync(path.join(dir, 'b.md'), 'utf8')).toBe('b');
    expect(fs.readFileSync(path.join(state.root, 'project/folder/a.md'), 'utf8')).toBe('a');
  });

  it('still deletes the source when nothing changed during the copy', async () => {
    fs.writeFileSync(path.join(state.root, 'note.md'), 'old');

    const result = await moveToProject('note.md');

    expect(result).toMatchObject({ ok: true, succeeded: 1, failed: 0 });
    expect(state.calls.map((row) => row.op)).toEqual(['copy-project', 'delete-global']);
    expect(fs.existsSync(path.join(state.root, 'note.md'))).toBe(false);
    expect(fs.readFileSync(path.join(state.root, 'project/note.md'), 'utf8')).toBe('old');
  });
});
