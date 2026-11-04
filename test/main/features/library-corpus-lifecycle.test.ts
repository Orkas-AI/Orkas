import { LIBRARY_READY_TIMEOUT_MS } from '../../helpers/latency-budget';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: (scope: string) => Object.fromEntries(
    ['info', 'debug', 'warn', 'error'].map(level => [level, (...args: unknown[]) =>
      console[level as 'info' | 'debug' | 'warn' | 'error'](`[${scope}]`, ...args)]),
  ),
}));

let root: string, previous: string | undefined;
let corpus: any, embed: any, indexer: any, vector: any;
let automatic = false;
let replies: Array<() => void>;
const uid = 'library-lifecycle-fixture';
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-library-lifetime-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules(); automatic = false; replies = [];
  corpus = await import('../../../src/main/features/library_corpus');
  embed = await import('../../../src/main/features/kb_embed');
  indexer = await import('../../../src/main/features/kb_indexer');
  vector = await import('../../../src/main/features/kb_vector');
  (await import('../../../src/main/features/users')).activateUser(uid);
});
afterEach(async () => {
  // The old implementation has no close API. Let its admitted fixture-only
  // work finish before releasing the fake dependency or deleting its root.
  automatic = true;
  replies.splice(0).forEach(reply => reply());
  try { await indexer.drain(uid); } catch { /* a closed owner cannot reopen */ }
  corpus._resetLibraryCorporaForTests();
  indexer._resetQueuesForTests();
  await (await import('../../helpers/drain-main-runtime')).drainMainRuntimeForTest();
  embed._setEmbedChannelFactoryForTest(null);
  vector.closeAllKb();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

function enqueueFiles() {
  let extracted = 0, channels = 0;
  const events: any[] = [];
  indexer.kbEvents.on('status', (event: any) => {
    events.push(event);
    if (event.stage === 'extract' && event.status === 'processing') extracted++;
  });
  embed._setEmbedChannelFactoryForTest(() => {
    channels++;
    let receive: (message: any) => void;
    return { onMessage: (cb: any) => { receive = cb; }, onExit() {}, kill() {},
      postMessage: (message: any) => {
        const reply = () => receive({ id: message.id, ok: true, vectors: message.texts.map(() => Array(512).fill(0.01)) });
        if (automatic) queueMicrotask(reply); else replies.push(reply);
      } };
  });
  const source = path.join(root, uid, 'cloud', 'contexts');
  fs.mkdirSync(source, { recursive: true });
  for (let i = 0; i < 20; i++) {
    fs.writeFileSync(path.join(source, `f${i}.md`), `# Document ${i}\nComplete body ${i}`);
    indexer.enqueue(uid, `f${i}.md`);
  }
  return { events, extracted: () => extracted, channels: () => channels, source };
}

it('backpressures extraction while retaining and eventually indexing every source', async () => {
  const state = enqueueFiles();
  await vi.waitFor(() => expect(state.extracted()).toBeGreaterThanOrEqual(2), { timeout: LIBRARY_READY_TIMEOUT_MS });
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(state.extracted()).toBeLessThanOrEqual(2);
  automatic = true; replies.splice(0).forEach(reply => reply());
  await indexer.drain(uid);
  expect(state.events.filter((event: any) => event.status === 'ready').map((event: any) => event.relPath).sort())
    .toEqual(Array.from({ length: 20 }, (_, i) => `f${i}.md`).sort());
  expect(fs.readdirSync(state.source).filter(name => name.endsWith('.md'))).toHaveLength(20);
});

it('saves and reads global/project Library sources while vector generation is blocked', async () => {
  const state = enqueueFiles();
  await vi.waitFor(() => expect(replies.length).toBe(1), { timeout: LIBRARY_READY_TIMEOUT_MS });
  const contexts = await import('../../../src/main/features/contexts');
  const projects = await import('../../../src/main/features/projects');
  const projectFiles = await import('../../../src/main/features/project_files');
  const projectIndexer = await import('../../../src/main/features/project_library_indexer');
  const created = await projects.createProject(uid, 'Local save during indexing');
  if (!created.ok) throw new Error('project fixture unavailable');
  const pid = created.project.project_id;
  try {
    expect(contexts.writeContextFile('new-local.md', 'New local source, separate from the indexed corpus.')).toMatchObject({ ok: true });
    const external = path.join(root, 'selected.md');
    fs.writeFileSync(external, 'Imported local source while native embedding is unavailable.');
    expect(await contexts.importContextFileFromPath('imported.md', external)).toMatchObject({ ok: true });
    expect(await projectFiles.uploadProjectFile(uid, pid, 'project.md', Buffer.from('Project local source.'))).toMatchObject({ ok: true });
    expect(fs.readFileSync(path.join(state.source, 'new-local.md'), 'utf8')).toContain('New local source');
    expect(fs.readFileSync(path.join(state.source, 'imported.md'), 'utf8')).toContain('Imported local source');
    expect(await projectFiles.readProjectTextFile(uid, pid, 'project.md')).toMatchObject({ content: 'Project local source.' });
    expect(replies).toHaveLength(1);
  } finally {
    automatic = true; replies.splice(0).forEach(reply => reply());
    await indexer.drain(uid);
    await projectIndexer.drain(uid, pid);
  }
  expect(vector.getFileByPath(uid, 'new-local.md')?.status).toBe('ready');
  expect(projectIndexer.getFileByPath(uid, pid, 'project.md')?.status).toBe('ready');
});

it('keeps late local source saves successful while derived indexing is closed, then reconciles them after resume', async () => {
  const state = enqueueFiles();
  await vi.waitFor(() => expect(replies.length).toBe(1), { timeout: LIBRARY_READY_TIMEOUT_MS });
  const projects = await import('../../../src/main/features/projects');
  const files = await import('../../../src/main/features/project_files');
  const contexts = await import('../../../src/main/features/contexts');
  const projectIndexer = await import('../../../src/main/features/project_library_indexer');
  const created = await projects.createProject(uid, 'Save during index shutdown');
  if (!created.ok) throw new Error('project fixture unavailable');
  const pid = created.project.project_id;
  await files.uploadProjectFile(uid, pid, 'existing.md', Buffer.from('Existing project source.'));
  corpus.closeAllLibraryCorpora();
  embed.closeEmbedder();
  let globalResult: unknown;
  try { globalResult = contexts.writeContextFile('late-global.md', 'Retained global source.'); }
  catch (error) { globalResult = { ok: false, error }; }
  const projectResult = await files.uploadProjectFile(uid, pid, 'late-project.md', Buffer.from('Retained project source.'))
    .catch(error => ({ ok: false, error }));
  automatic = true; replies.splice(0).forEach(reply => reply());
  await corpus.resumeLibraryAdmission();
  await indexer.drain(uid);
  await projectIndexer.drain(uid, pid);
  expect(globalResult).toMatchObject({ ok: true });
  expect(projectResult).toMatchObject({ ok: true });
  expect(fs.readFileSync(path.join(state.source, 'late-global.md'), 'utf8')).toBe('Retained global source.');
  expect(vector.getFileByPath(uid, 'late-global.md')?.status).toBe('ready');
  expect(projectIndexer.getFileByPath(uid, pid, 'late-project.md')?.status).toBe('ready');
});

it('keeps a committed source successful and processes it after a pending-status consumer throws', async () => {
  const state = enqueueFiles();
  automatic = true;
  const listener = (event: any) => {
    if (event.relPath === 'listener.md' && event.status === 'pending') throw new Error('injected unavailable status consumer');
  };
  indexer.kbEvents.on('status', listener);
  const contexts = await import('../../../src/main/features/contexts');
  let result: unknown;
  try { result = contexts.writeContextFile('listener.md', 'Retained source despite a broken derived status consumer.'); }
  catch (error) { result = { ok: false, error }; }
  indexer.kbEvents.off('status', listener);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    expect(result).toMatchObject({ ok: true });
    await Promise.race([indexer.drain(uid), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('admitted source did not complete')), 4000);
    })]);
    expect(fs.readFileSync(path.join(state.source, 'listener.md'), 'utf8')).toContain('Retained source');
    expect(vector.getFileByPath(uid, 'listener.md')?.status).toBe('ready');
  } finally {
    clearTimeout(timer);
    corpus._resetLibraryCorporaForTests();
  }
});

it('closes owners before dependencies, ignores late replies and resumes pending sources in a fresh lifetime', async () => {
  const state = enqueueFiles();
  await vi.waitFor(() => expect(replies.length).toBe(1), { timeout: LIBRARY_READY_TIMEOUT_MS });
  const draining = indexer.drain(uid);
  corpus.closeAllLibraryCorpora();
  embed.closeEmbedder();
  await draining;
  vector.closeAllKb();
  const count = state.events.length;
  replies.splice(0).forEach(reply => reply());
  await new Promise(resolve => setImmediate(resolve));
  expect(state.channels()).toBe(1);
  expect(state.events).toHaveLength(count);
  await expect(indexer.reconcile(uid)).rejects.toThrow(/closing/);
  automatic = true;
  await corpus.resumeLibraryAdmission();
  await indexer.drain(uid);
  expect(state.events.filter((event: any) => event.status === 'ready')).toHaveLength(20);
});

it('does not resurrect discarded or explicitly removed corpora after a failed exit', async () => {
  let discarded = false;
  const exists = vi.fn(async () => true);
  const removed = path.join(root, 'removed-index');
  for (const dbDir of [path.join(root, 'discarded-index'), removed]) {
    corpus.openLibraryCorpus({ uid, scope: 'project', sourceRoot: path.join(root, 'absent'), dbDir,
      imageSessionPrefix: 'fixture', emit: vi.fn(), exists,
      ...(dbDir === removed ? {} : { discarded: () => discarded }),
    });
  }
  corpus.closeAllLibraryCorpora();
  discarded = true;
  corpus.closeLibraryCorpus(removed);
  await corpus.resumeLibraryAdmission();
  expect(exists).not.toHaveBeenCalled();
  expect(fs.existsSync(removed)).toBe(false);
  expect(fs.existsSync(path.join(root, 'discarded-index'))).toBe(false);
});
