import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; args: unknown[] }>,
  failDelete: '' as string,
  throwDelete: '' as string,
  activeUserId: 'u1',
  pauseProjectResolve: false,
  projectResolveStarted: null as null | (() => void),
  releaseProjectResolve: null as null | (() => void),
  pauseProjectCopy: false,
  projectCopyStarted: null as null | (() => void),
  releaseProjectCopy: null as null | (() => void),
}));

vi.mock('../../../src/main/features/users', () => ({
  getActiveUserId: () => state.activeUserId,
}));

vi.mock('../../../src/main/features/contexts', () => ({
  resolveContextEntryAbsPath: (rel: string, userId = state.activeUserId) => `/${userId}/global/${rel}`,
  copyContextEntryFromPath: (source: string, target: string, userId = state.activeUserId) => {
    state.calls.push({ op: 'copy-global', args: [userId, source, target] });
    if (target.includes('conflict')) return { ok: false, error: 'target_exists' };
    return { ok: true, path: target, fileCount: 1, bytes: 10 };
  },
  deleteContextTarget: (rel: string, userId = state.activeUserId) => {
    state.calls.push({ op: 'delete-global', args: [userId, rel] });
    if (state.throwDelete === `global:${rel}`) throw new Error('private global path');
    return state.failDelete === `global:${rel}` ? { ok: false, error: 'delete_failed' } : { ok: true };
  },
  renameContextEntry: (source: string, target: string, userId = state.activeUserId) => {
    state.calls.push({ op: 'move-global', args: [userId, source, target] });
    return { ok: true, src: source, dst: target };
  },
}));

vi.mock('../../../src/main/features/project_files', () => ({
  resolveProjectEntryAbsPath: async (_uid: string, pid: string, rel: string) => {
    if (state.pauseProjectResolve) {
      state.projectResolveStarted?.();
      await new Promise<void>((resolve) => { state.releaseProjectResolve = resolve; });
    }
    return {
      ok: true,
      absPath: `/projects/${pid}/${rel}`,
      type: rel.includes('.') ? 'file' : 'dir',
    };
  },
  copyProjectEntryFromPath: async (_uid: string, pid: string, source: string, target: string) => {
    state.calls.push({ op: 'copy-project', args: [pid, source, target] });
    if (state.pauseProjectCopy) {
      state.projectCopyStarted?.();
      await new Promise<void>((resolve) => { state.releaseProjectCopy = resolve; });
    }
    if (target.includes('unsupported')) return { ok: false, error: 'unsupported_destination' };
    return { ok: true, name: target, fileCount: 1, bytes: 10 };
  },
  deleteProjectEntry: async (_uid: string, pid: string, rel: string) => {
    state.calls.push({ op: 'delete-project', args: [pid, rel] });
    if (state.throwDelete === `project:${pid}:${rel}`) throw new Error('private project path');
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
  state.throwDelete = '';
  state.activeUserId = 'u1';
  state.pauseProjectResolve = false;
  state.projectResolveStarted = null;
  state.releaseProjectResolve = null;
  state.pauseProjectCopy = false;
  state.projectCopyStarted = null;
  state.releaseProjectCopy = null;
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
      args: ['u1', '/projects/p1/notes/report.md', 'imports/report.md'],
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
    expect(state.calls).toEqual([{ op: 'copy-global', args: ['u1', '/u1/global/note.md', 'archive/note.md'] }]);
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
    expect(state.calls).toEqual([{ op: 'copy-global', args: ['u1', '/projects/p1/conflict.md', 'conflict.md'] }]);
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

  it('rolls back the destination when source deletion throws unexpectedly', async () => {
    state.throwDelete = 'project:p1:note.md';
    const result = await transfer({
      mode: 'move',
      source: { scope: 'project', projectId: 'p1' },
      paths: ['note.md'],
      destination: { scope: 'global', dir: '' },
    });

    expect(result).toMatchObject({
      ok: true,
      succeeded: 0,
      failed: 1,
      results: [{ source: 'note.md', error: 'source_delete_failed' }],
    });
    expect(state.calls.map((row) => row.op)).toEqual([
      'copy-global',
      'delete-project',
      'delete-global',
    ]);
  });

  it('reports rollback failure without claiming that the move completed', async () => {
    state.failDelete = 'global:note.md';
    state.throwDelete = 'project:p1:note.md';
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
      results: [{ source: 'note.md', error: 'rollback_failed' }],
    });
  });

  it('rejects a stale account request without touching either Library', async () => {
    state.activeUserId = 'u2';

    const result = await transfer({
      mode: 'copy',
      source: { scope: 'global' },
      paths: ['note.md'],
      destination: { scope: 'project', projectId: 'p1', dir: '' },
    });

    expect(result).toEqual({ ok: false, error: 'account_changed' });
    expect(state.calls).toEqual([]);
  });

  it('stops before writing when the active account changes during source resolution', async () => {
    state.pauseProjectResolve = true;
    const started = new Promise<void>((resolve) => { state.projectResolveStarted = resolve; });
    const pending = transfer({
      mode: 'copy',
      source: { scope: 'project', projectId: 'p1' },
      paths: ['note.md'],
      destination: { scope: 'global', dir: '' },
    });

    await started;
    state.activeUserId = 'u2';
    state.releaseProjectResolve?.();
    const result = await pending;

    expect(result).toMatchObject({
      ok: true,
      succeeded: 0,
      failed: 1,
      results: [{ source: 'note.md', error: 'account_changed' }],
    });
    expect(state.calls).toEqual([]);
  });

  it('rolls back a completed destination copy if the account changes before source deletion', async () => {
    state.pauseProjectCopy = true;
    const started = new Promise<void>((resolve) => { state.projectCopyStarted = resolve; });
    const pending = transfer({
      mode: 'move',
      source: { scope: 'global' },
      paths: ['note.md'],
      destination: { scope: 'project', projectId: 'p1', dir: '' },
    });

    await started;
    state.activeUserId = 'u2';
    state.releaseProjectCopy?.();
    const result = await pending;

    expect(result).toMatchObject({
      ok: true,
      succeeded: 0,
      failed: 1,
      results: [{ source: 'note.md', error: 'account_changed' }],
    });
    expect(state.calls.map((call) => call.op)).toEqual(['copy-project', 'delete-project']);
  });

  it('rejects unsafe or unbounded requests before filesystem work', async () => {
    const cases = [
      {
        mode: 'copy',
        source: { scope: 'global' },
        paths: ['../private.md'],
        destination: { scope: 'project', projectId: 'p1', dir: '' },
      },
      {
        mode: 'copy',
        source: { scope: 'global' },
        paths: ['.hidden/note.md'],
        destination: { scope: 'project', projectId: 'p1', dir: '' },
      },
      {
        mode: 'copy',
        source: { scope: 'global' },
        paths: Array.from({ length: 101 }, (_, index) => `note-${index}.md`),
        destination: { scope: 'project', projectId: 'p1', dir: '' },
      },
    ];

    for (const request of cases) {
      const result = await transfer(request);
      expect(result.ok).toBe(false);
    }
    expect(state.calls).toEqual([]);
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
