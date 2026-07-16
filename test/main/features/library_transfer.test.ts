import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; args: unknown[] }>,
  failDelete: '' as string,
}));

vi.mock('../../../src/main/features/contexts', () => ({
  resolveContextEntryAbsPath: (rel: string) => `/global/${rel}`,
  copyContextEntryFromPath: (source: string, target: string) => {
    state.calls.push({ op: 'copy-global', args: [source, target] });
    if (target.includes('conflict')) return { ok: false, error: 'target_exists' };
    return { ok: true, path: target, fileCount: 1, bytes: 10 };
  },
  deleteContextTarget: (rel: string) => {
    state.calls.push({ op: 'delete-global', args: [rel] });
    return state.failDelete === `global:${rel}` ? { ok: false, error: 'delete_failed' } : { ok: true };
  },
  renameContextEntry: (source: string, target: string) => {
    state.calls.push({ op: 'move-global', args: [source, target] });
    return { ok: true, src: source, dst: target };
  },
}));

vi.mock('../../../src/main/features/project_files', () => ({
  resolveProjectEntryAbsPath: async (_uid: string, pid: string, rel: string) => ({
    ok: true,
    absPath: `/projects/${pid}/${rel}`,
    type: rel.includes('.') ? 'file' : 'dir',
  }),
  copyProjectEntryFromPath: async (_uid: string, pid: string, source: string, target: string) => {
    state.calls.push({ op: 'copy-project', args: [pid, source, target] });
    if (target.includes('unsupported')) return { ok: false, error: 'unsupported_destination' };
    return { ok: true, name: target, fileCount: 1, bytes: 10 };
  },
  deleteProjectEntry: async (_uid: string, pid: string, rel: string) => {
    state.calls.push({ op: 'delete-project', args: [pid, rel] });
    return state.failDelete === `project:${pid}:${rel}` ? { ok: false, error: 'delete_failed' } : { ok: true };
  },
  renameProjectFile: async (_uid: string, pid: string, source: string, target: string) => {
    state.calls.push({ op: 'move-project', args: [pid, source, target] });
    return { ok: true, oldName: source, name: target, type: 'file' };
  },
}));

beforeEach(() => {
  state.calls.length = 0;
  state.failDelete = '';
  vi.resetModules();
});

async function transfer(request: any) {
  const mod = await import('../../../src/main/features/library_transfer');
  return mod.transferLibraryEntries('u1', request);
}

describe('library_transfer', () => {
  it('copies project entries into the global Library', async () => {
    const result = await transfer({
      mode: 'copy',
      source: { scope: 'project', projectId: 'p1' },
      paths: ['notes/report.md'],
      destination: { scope: 'global', dir: 'imports' },
    });

    expect(result).toMatchObject({ ok: true, succeeded: 1, failed: 0 });
    expect(state.calls).toContainEqual({
      op: 'copy-global',
      args: ['/projects/p1/notes/report.md', 'imports/report.md'],
    });
  });

  it('moves across projects by copying before deleting the source', async () => {
    const result = await transfer({
      mode: 'move',
      source: { scope: 'project', projectId: 'p1' },
      paths: ['folder'],
      destination: { scope: 'project', projectId: 'p2', dir: 'archive' },
    });

    expect(result).toMatchObject({ ok: true, succeeded: 1, failed: 0 });
    expect(state.calls.map((row) => row.op)).toEqual(['copy-project', 'delete-project']);
  });

  it('uses an in-place rename for a move within one Library', async () => {
    const result = await transfer({
      mode: 'move',
      source: { scope: 'project', projectId: 'p1' },
      paths: ['note.md'],
      destination: { scope: 'project', projectId: 'p1', dir: 'archive' },
    });

    expect(result).toMatchObject({ ok: true, succeeded: 1, failed: 0 });
    expect(state.calls).toEqual([{ op: 'move-project', args: ['p1', 'note.md', 'archive/note.md'] }]);
  });

  it('copies within one Library without deleting the source', async () => {
    const result = await transfer({
      mode: 'copy',
      source: { scope: 'global' },
      paths: ['note.md'],
      destination: { scope: 'global', dir: 'archive' },
    });

    expect(result).toMatchObject({ ok: true, succeeded: 1, failed: 0 });
    expect(state.calls).toEqual([{ op: 'copy-global', args: ['/global/note.md', 'archive/note.md'] }]);
  });

  it('reports unsupported destinations per item while allowing the rest of a batch', async () => {
    const result = await transfer({
      mode: 'copy',
      source: { scope: 'global' },
      paths: ['conflict.md', 'unsupported.mov'],
      destination: { scope: 'project', projectId: 'p1', dir: '' },
    });

    expect(result).toMatchObject({ ok: true, succeeded: 1, failed: 1 });
    expect(result.ok && result.results).toContainEqual(expect.objectContaining({
      source: 'unsupported.mov', ok: false, error: 'unsupported_destination',
    }));
  });

  it('does not overwrite a conflicting destination', async () => {
    const result = await transfer({
      mode: 'copy',
      source: { scope: 'project', projectId: 'p1' },
      paths: ['conflict.md'],
      destination: { scope: 'global', dir: '' },
    });

    expect(result).toMatchObject({
      ok: true,
      succeeded: 0,
      failed: 1,
      results: [{ source: 'conflict.md', ok: false, error: 'target_exists' }],
    });
    expect(state.calls).toEqual([{ op: 'copy-global', args: ['/projects/p1/conflict.md', 'conflict.md'] }]);
  });

  it('deduplicates children when their selected parent is transferred', async () => {
    const result = await transfer({
      mode: 'copy',
      source: { scope: 'global' },
      paths: ['folder/file.md', 'folder', 'other.md'],
      destination: { scope: 'project', projectId: 'p1', dir: '' },
    });

    expect(result).toMatchObject({ ok: true, succeeded: 2, failed: 0, skippedNested: 1 });
    expect(state.calls.filter((row) => row.op === 'copy-project')).toHaveLength(2);
  });

  it('keeps the source and rolls back the destination when source deletion fails', async () => {
    state.failDelete = 'global:note.md';
    const result = await transfer({
      mode: 'move',
      source: { scope: 'global' },
      paths: ['note.md'],
      destination: { scope: 'project', projectId: 'p1', dir: '' },
    });

    expect(result).toMatchObject({
      ok: true,
      succeeded: 0,
      failed: 1,
      results: [{ error: 'source_delete_failed' }],
    });
    expect(state.calls.map((row) => row.op)).toEqual(['copy-project', 'delete-global', 'delete-project']);
  });

  it('rejects copying a folder into its own descendant', async () => {
    const result = await transfer({
      mode: 'copy',
      source: { scope: 'global' },
      paths: ['folder'],
      destination: { scope: 'global', dir: 'folder/child' },
    });

    expect(result).toMatchObject({ ok: true, succeeded: 0, failed: 1, results: [{ error: 'invalid_target' }] });
    expect(state.calls).toEqual([]);
  });
});
