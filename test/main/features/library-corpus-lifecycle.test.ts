import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  await vi.waitFor(() => expect(state.extracted()).toBeGreaterThanOrEqual(2));
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(state.extracted()).toBeLessThanOrEqual(2);
  automatic = true; replies.splice(0).forEach(reply => reply());
  await indexer.drain(uid);
  expect(state.events.filter((event: any) => event.status === 'ready').map((event: any) => event.relPath).sort())
    .toEqual(Array.from({ length: 20 }, (_, i) => `f${i}.md`).sort());
  expect(fs.readdirSync(state.source).filter(name => name.endsWith('.md'))).toHaveLength(20);
});

it('closes owners before dependencies, ignores late replies and resumes pending sources in a fresh lifetime', async () => {
  const state = enqueueFiles();
  await vi.waitFor(() => expect(replies.length).toBe(1));
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
