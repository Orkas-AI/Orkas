import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Project Library indexer: queue lifecycle, reconcile diffing, and the
 * project-scoped concerns nothing else covers (deletion tombstone/epoch,
 * name/id safety). Asserted against the public API so the behaviour contract
 * survives an implementation change; per-kind extraction, chunk sizing, image
 * vision fallback and operation timeouts belong to the shared lower layers
 * and are covered once on the global-Library side.
 *
 * kb_embed is mocked so the 95MB ONNX model never loads.
 */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'projidx';
const PID = 'proj0001';

/** Counts real embed work so cache-hit / force cases have an oracle that does
 *  not depend on a timestamp advancing between two writes. */
const embedCalls = vi.hoisted(() => ({
  count: 0,
  blockNext: false,
  onBlocked: null as (() => void) | null,
  releaseBlocked: null as Promise<void> | null,
}));

vi.mock('../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => {
    embedCalls.count += 1;
    if (embedCalls.blockNext) {
      embedCalls.blockNext = false;
      embedCalls.onBlocked?.();
      if (embedCalls.releaseBlocked) await embedCalls.releaseBlocked;
    }
    // Sentinel drives the failure path without re-mocking per test.
    if (texts.some((t) => t.includes('__FAIL_EMBED__'))) {
      throw new Error('mocked embed failure');
    }
    return texts.map((t) => {
      const v = new Array(512).fill(0);
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      v[0] = (h % 1000) / 1000;
      v[1] = ((h >>> 8) & 0xff) / 100;
      return v;
    });
  },
  embedQuery: async () => new Array(512).fill(0),
  closeEmbedder: () => {},
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-projidx-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  embedCalls.count = 0;
  embedCalls.blockNext = false;
  embedCalls.onBlocked = null;
  embedCalls.releaseBlocked = null;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  try {
    const idx = await import('../../../src/main/features/project_library_indexer');
    idx._resetQueuesForTests();
    const vs = await import('../../../src/main/features/vec_store');
    vs.closeAllVecStores();
  } catch { /* ignore */ }
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function filesRoot(pid = PID): Promise<string> {
  const paths = await import('../../../src/main/paths');
  return paths.projectFilesDir(TEST_UID, pid);
}

/** `reconcile` refuses to touch a project that does not exist on disk. */
async function createProject(pid = PID): Promise<void> {
  const paths = await import('../../../src/main/paths');
  const meta = paths.projectMetaFile(TEST_UID, pid);
  fs.mkdirSync(path.dirname(meta), { recursive: true });
  fs.writeFileSync(meta, JSON.stringify({ project_id: pid, name: 'Test project' }));
  fs.mkdirSync(await filesRoot(pid), { recursive: true });
}

async function writeSource(rel: string, body: string, pid = PID): Promise<void> {
  const full = path.join(await filesRoot(pid), rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

async function indexer() {
  return import('../../../src/main/features/project_library_indexer');
}

function collectEvents(ev: { on: (e: string, fn: (x: unknown) => void) => void }): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  ev.on('status', (x) => events.push(x as Record<string, unknown>));
  return events;
}

describe('project_library_indexer › enqueue + processing', () => {
  it('vectorizes a new source file: pending → processing → ready', async () => {
    const idx = await indexer();
    const events = collectEvents(idx.projectLibraryEvents);
    await writeSource('notes.md', 'project alpha body');

    idx.enqueue(TEST_UID, PID, 'notes.md');
    await idx.drain(TEST_UID);

    expect(idx.getFileByPath(TEST_UID, PID, 'notes.md')).toMatchObject({
      status: 'ready',
      kind: 'text',
    });
    const seen = events.filter((e) => e.name === 'notes.md').map((e) => e.status);
    expect(seen).toContain('pending');
    expect(seen).toContain('processing');
    expect(seen[seen.length - 1]).toBe('ready');
    // Every event carries the project it belongs to; the renderer routes on it.
    expect(events.every((e) => e.projectId === PID)).toBe(true);
  });

  it('drops the row and emits deleted on op=delete', async () => {
    const idx = await indexer();
    await writeSource('gone.md', 'to be removed');
    idx.enqueue(TEST_UID, PID, 'gone.md');
    await idx.drain(TEST_UID);
    expect(idx.getFileByPath(TEST_UID, PID, 'gone.md')).toBeTruthy();

    const events = collectEvents(idx.projectLibraryEvents);
    idx.enqueue(TEST_UID, PID, 'gone.md', 'delete');
    await idx.drain(TEST_UID);

    expect(idx.getFileByPath(TEST_UID, PID, 'gone.md')).toBeNull();
    expect(events.some((e) => e.status === 'deleted' && e.name === 'gone.md')).toBe(true);
  });

  it('skips re-embedding unchanged content but re-embeds under force', async () => {
    const idx = await indexer();
    await writeSource('stable.md', 'unchanged body');
    idx.enqueue(TEST_UID, PID, 'stable.md');
    await idx.drain(TEST_UID);
    const first = idx.getFileByPath(TEST_UID, PID, 'stable.md')!;
    const afterFirst = embedCalls.count;
    expect(afterFirst).toBeGreaterThan(0);

    idx.enqueue(TEST_UID, PID, 'stable.md');
    await idx.drain(TEST_UID);
    const cached = idx.getFileByPath(TEST_UID, PID, 'stable.md')!;
    expect(cached.updated_at).toBe(first.updated_at);   // cache hit: no rewrite
    expect(embedCalls.count).toBe(afterFirst);          // and no embed work

    idx.enqueue(TEST_UID, PID, 'stable.md', 'upsert', { force: true });
    await idx.drain(TEST_UID);
    expect(idx.getFileByPath(TEST_UID, PID, 'stable.md')).toMatchObject({ status: 'ready' });
    // Force exists to re-embed identical content; a timestamp can tie within
    // the same millisecond, the embed count cannot.
    expect(embedCalls.count).toBe(afterFirst + 1);
  });

  it('marks a file failed with a stage-tagged event when embedding throws', async () => {
    const idx = await indexer();
    const events = collectEvents(idx.projectLibraryEvents);
    await writeSource('broken.md', 'body __FAIL_EMBED__ marker');

    idx.enqueue(TEST_UID, PID, 'broken.md');
    await idx.drain(TEST_UID);

    expect(idx.getFileByPath(TEST_UID, PID, 'broken.md')).toMatchObject({ status: 'failed' });
    const failure = events.find((e) => e.status === 'failed' && e.name === 'broken.md');
    expect(failure).toBeTruthy();
    expect(failure!.stage).toBe('embed');
    expect(String(failure!.errorCode)).toMatch(/^E_LIBRARY_/);
  });

  it('short-circuits an empty file to ready with zero chunks', async () => {
    const idx = await indexer();
    await writeSource('empty.md', '   \n  ');

    idx.enqueue(TEST_UID, PID, 'empty.md');
    await idx.drain(TEST_UID);

    expect(idx.getFileByPath(TEST_UID, PID, 'empty.md')).toMatchObject({ status: 'ready', chunks: 0 });
  });

  it('ignores unsupported extensions', async () => {
    const idx = await indexer();
    await writeSource('archive.zip', 'binary-ish');

    idx.enqueue(TEST_UID, PID, 'archive.zip');
    await idx.drain(TEST_UID);

    expect(idx.getFileByPath(TEST_UID, PID, 'archive.zip')).toBeNull();
  });

  it('rejects traversal and absolute names at admission, emitting nothing for them', async () => {
    const idx = await indexer();
    const events = collectEvents(idx.projectLibraryEvents);
    await writeSource('inside.md', 'legitimate body');
    idx.enqueue(TEST_UID, PID, 'inside.md');

    const rejected = ['../escape.md', '/etc/passwd', '.hidden.md', ''];
    for (const bad of rejected) idx.enqueue(TEST_UID, PID, bad);
    idx.enqueue(TEST_UID, '../other', 'inside.md');
    await idx.drain(TEST_UID);

    expect(idx.getFileByPath(TEST_UID, PID, 'inside.md')).toMatchObject({ status: 'ready' });
    expect(idx.listFiles(TEST_UID, PID).map((r) => r.rel_path)).toEqual(['inside.md']);
    // Admitting the job and failing later is not equivalent: the failure path
    // would broadcast a path outside the project to every status listener.
    const names = events.map((e) => String(e.name ?? ''));
    for (const bad of rejected) expect(names).not.toContain(bad);
    expect(events.every((e) => e.projectId === PID)).toBe(true);
  });
});

describe('project_library_indexer › reconcile', () => {
  it('enqueues new and changed files, leaves unchanged ones alone', async () => {
    const idx = await indexer();
    await createProject();
    await writeSource('a.md', 'first body');
    await writeSource('b.md', 'second body');

    const first = await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);
    expect(first.enqueuedUpsert).toBe(2);

    const unchanged = await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);
    expect(unchanged.enqueuedUpsert).toBe(0);
    expect(unchanged.unchanged).toBe(2);

    await writeSource('a.md', 'first body, revised');
    const changed = await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);
    expect(changed.enqueuedUpsert).toBe(1);
    expect(
      idx.readFileChunks(TEST_UID, PID, 'a.md').map((c) => c.content).join('\n'),
    ).toContain('revised');
  });

  it('enqueues a delete when the source disappears from disk', async () => {
    const idx = await indexer();
    await createProject();
    await writeSource('temp.md', 'short lived');
    await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);
    expect(idx.getFileByPath(TEST_UID, PID, 'temp.md')).toBeTruthy();

    fs.rmSync(path.join(await filesRoot(), 'temp.md'));
    const result = await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);

    expect(result.enqueuedDelete).toBe(1);
    expect(idx.getFileByPath(TEST_UID, PID, 'temp.md')).toBeNull();
  });

  it('skips dot-prefixed entries and unsupported files during the walk', async () => {
    const idx = await indexer();
    await createProject();
    await writeSource('visible.md', 'indexed body');
    await writeSource('.hidden/secret.md', 'must stay out');
    await writeSource('binary.zip', 'not indexable');

    const result = await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);

    expect(result.enqueuedUpsert).toBe(1);
    expect(idx.listFiles(TEST_UID, PID).map((r) => r.rel_path)).toEqual(['visible.md']);
  });

  it('re-enqueues a previously failed file once its content changes', async () => {
    const idx = await indexer();
    await createProject();
    await writeSource('flaky.md', 'body __FAIL_EMBED__ marker');
    await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);
    expect(idx.getFileByPath(TEST_UID, PID, 'flaky.md')).toMatchObject({ status: 'failed' });

    await writeSource('flaky.md', 'body now embeds cleanly');
    const retry = await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);

    expect(retry.enqueuedUpsert).toBe(1);
    expect(idx.getFileByPath(TEST_UID, PID, 'flaky.md')).toMatchObject({ status: 'ready' });
  });

  it('recovers a processing row orphaned by a crashed prior run', async () => {
    const idx = await indexer();
    const paths = await import('../../../src/main/paths');
    const vs = await import('../../../src/main/features/vec_store');
    await createProject();
    await writeSource('stuck.md', 'left mid-flight');

    // A crash leaves `processing` behind with no in-memory owner.
    const abs = path.join(await filesRoot(), 'stuck.md');
    const stat = fs.statSync(abs);
    // The real content hash: with a matching sha1 the only remaining reason to
    // re-enqueue is the orphaned `processing` status itself, so this case
    // isolates crash recovery instead of riding on a content change.
    const sha1 = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
    const store = vs.openVecStore(path.dirname(paths.projectLibraryVectorDbPath(TEST_UID, PID)));
    await store.setFileStatus('stuck.md', 'processing', {
      kind: 'text', bytes: stat.size, mtime: stat.mtimeMs / 1000, sha1,
    });

    const result = await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);

    expect(result.recoveredProcessing).toBe(1);
    expect(idx.getFileByPath(TEST_UID, PID, 'stuck.md')).toMatchObject({ status: 'ready' });
  });

  it('does not recover a processing snapshot after its live job becomes ready', async () => {
    const { openLibraryCorpus, closeLibraryCorpus } = await import('../../../src/main/features/library_corpus');
    const sourceRoot = path.join(tmpDir, 'race-source');
    const dbDir = path.join(tmpDir, 'race-index');
    fs.mkdirSync(sourceRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, 'race.md'), 'one indexing pass is enough');

    let notifyBlocked!: () => void;
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => { notifyBlocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseBlocked = resolve; });
    embedCalls.blockNext = true;
    embedCalls.onBlocked = notifyBlocked;
    embedCalls.releaseBlocked = release;

    const corpus = openLibraryCorpus({
      uid: TEST_UID,
      scope: 'project',
      sourceRoot,
      dbDir,
      imageSessionPrefix: 'race-test',
      emit: () => {},
    });
    try {
      corpus.enqueue('race.md');
      await blocked;
      expect(corpus.getFile('race.md')).toMatchObject({ status: 'processing' });

      // reconcile() takes its DB snapshot before its first filesystem-walk
      // await. Let the active embed finish only after that snapshot exists.
      const reconciling = corpus.reconcile();
      releaseBlocked();
      const result = await reconciling;
      await corpus.drain();

      expect(result).toMatchObject({ enqueuedUpsert: 0, recoveredProcessing: 0 });
      expect(corpus.getFile('race.md')).toMatchObject({ status: 'ready' });
      expect(embedCalls.count).toBe(1);
    } finally {
      releaseBlocked();
      await corpus.drain();
      closeLibraryCorpus(dbDir);
    }
  });

  it('does nothing for a project that does not exist', async () => {
    const idx = await indexer();
    const paths = await import('../../../src/main/paths');
    await writeSource('orphan.md', 'no project meta on disk');

    const result = await idx.reconcile(TEST_UID, PID);

    expect(result).toMatchObject({ enqueuedUpsert: 0, enqueuedDelete: 0 });
    // A missing project must not materialise derived state.
    expect(fs.existsSync(paths.projectLibraryVectorDbPath(TEST_UID, PID))).toBe(false);
  });
});

describe('project_library_indexer › retrieval is read-only', () => {
  it('does not index or hash sources on search — freshness is the writers\' job', async () => {
    const idx = await indexer();
    await createProject();
    await writeSource('indexed.md', 'body that was indexed');
    idx.enqueue(TEST_UID, PID, 'indexed.md');
    await idx.drain(TEST_UID);
    const embedsAfterIndexing = embedCalls.count;

    // A source added behind the indexer's back. A query must not adopt it:
    // reconciling here made every search stat and hash the whole project.
    await writeSource('behind-its-back.md', 'never enqueued');

    const vector = new Array(512).fill(0);
    vector[0] = 1;
    const hits = await idx.search(TEST_UID, PID, vector, { k: 10 });
    await idx.drain(TEST_UID);

    expect(hits.some((h) => h.rel_path === 'indexed.md')).toBe(true);
    expect(hits.some((h) => h.rel_path === 'behind-its-back.md')).toBe(false);
    expect(idx.getFileByPath(TEST_UID, PID, 'behind-its-back.md')).toBeNull();
    expect(embedCalls.count).toBe(embedsAfterIndexing);

    // The owning path still picks it up.
    await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);
    expect(idx.getFileByPath(TEST_UID, PID, 'behind-its-back.md')).toMatchObject({ status: 'ready' });
  });

  it('answers from a store built in this session without a reconcile', async () => {
    const idx = await indexer();
    await writeSource('fresh.md', 'freshly indexed body');
    idx.enqueue(TEST_UID, PID, 'fresh.md');
    await idx.drain(TEST_UID);

    const vector = new Array(512).fill(0);
    vector[0] = 1;
    // No project meta on disk: reconcile would refuse this project outright,
    // so a search that still answers proves it is not going through one.
    const hits = await idx.search(TEST_UID, PID, vector, { k: 5 });
    expect(hits.some((h) => h.rel_path === 'fresh.md')).toBe(true);
  });

  it('reconciling a project with no indexable sources creates no vector store', async () => {
    const idx = await indexer();
    const paths = await import('../../../src/main/paths');
    await createProject();
    await writeSource('notes.zip', 'unsupported payload');

    const result = await idx.reconcile(TEST_UID, PID);

    expect(result).toMatchObject({ enqueuedUpsert: 0, enqueuedDelete: 0 });
    // Boot maintenance reconciles every project; none may gain derived state
    // just by being looked at.
    expect(fs.existsSync(paths.projectLibraryVectorDbPath(TEST_UID, PID))).toBe(false);
  });
});

describe('project_library_indexer › project deletion lifecycle', () => {
  it('drops derived state and refuses further work for a deleted project', async () => {
    const idx = await indexer();
    const paths = await import('../../../src/main/paths');
    await createProject();
    await writeSource('doomed.md', 'indexed before deletion');
    idx.enqueue(TEST_UID, PID, 'doomed.md');
    await idx.drain(TEST_UID);
    expect(fs.existsSync(paths.projectLibraryVectorDbPath(TEST_UID, PID))).toBe(true);

    await idx.dropProjectIndex(TEST_UID, PID);

    expect(fs.existsSync(paths.projectLibraryVectorDbPath(TEST_UID, PID))).toBe(false);
    // Work enqueued after the drop must not recreate the store — that is what
    // the epoch/tombstone exists for.
    idx.enqueue(TEST_UID, PID, 'doomed.md');
    await idx.drain(TEST_UID);
    expect(fs.existsSync(paths.projectLibraryVectorDbPath(TEST_UID, PID))).toBe(false);
  });

  it('lets a sync restore resurrect the same project id through reconcile', async () => {
    const idx = await indexer();
    await createProject();
    await writeSource('restored.md', 'body that comes back');
    idx.enqueue(TEST_UID, PID, 'restored.md');
    await idx.drain(TEST_UID);
    await idx.dropProjectIndex(TEST_UID, PID);

    // Sync brings the project back; reconcile is the authoritative boundary.
    await createProject();
    await writeSource('restored.md', 'body that comes back');
    const result = await idx.reconcile(TEST_UID, PID);
    await idx.drain(TEST_UID);

    expect(result.enqueuedUpsert).toBe(1);
    expect(idx.getFileByPath(TEST_UID, PID, 'restored.md')).toMatchObject({ status: 'ready' });
  });
});
