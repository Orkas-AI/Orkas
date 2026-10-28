import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const uid = 'revision-user', cid = 'revision-chat', agent = 'builder';
let root: string, previous: string | undefined;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-art-revision-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser(uid);
});
afterEach(() => { process.env.ORKAS_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
const files = (body: string) => [{ path: 'index.html', content: `<!doctype html><button>${body}</button>` }];
const directory = (id: string) => path.join(root, uid, 'cloud/chat_artifacts', cid, id);

it.each(['local', 'web'] as const)('corrects a %s app without changing its identity, type, title or save destination', async appType => {
  const m = await import('../../../src/main/features/chat_artifacts');
  const saved = await import('../../../src/main/features/saved_apps');
  const first = await m.createArtifact(uid, cid, agent, { title: 'Chat', appType, files: files('Draft') });
  if (!first.ok) throw new Error(first.error);
  const kept = await saved.saveFromArtifact(uid, cid, first.artifactId);
  if (!kept.ok) throw new Error(kept.error);
  const before = m.readArtifactMeta(uid, cid, first.artifactId)!;
  const corrected = await m.createArtifact(uid, cid, agent, { artifactId: first.artifactId, files: files('Corrected') } as any);
  expect(corrected).toMatchObject({ ok: true, artifactId: first.artifactId, revision: 2 });
  expect(fs.readdirSync(path.dirname(directory(first.artifactId)))).toEqual([first.artifactId]);
  expect(fs.readFileSync(path.join(directory(first.artifactId), 'index.html'), 'utf8')).toContain('Corrected');
  expect(m.readArtifactMeta(uid, cid, first.artifactId)).toMatchObject({ ...before, revision: 2 });
  const savedDir = path.join(root, uid, 'cloud/saved_apps', kept.id);
  expect(fs.readFileSync(path.join(savedDir, 'index.html'), 'utf8')).toContain('Draft');
  expect(await saved.saveFromArtifact(uid, cid, first.artifactId, 'auto')).toMatchObject({ ok: true, id: kept.id });
  expect(fs.readFileSync(path.join(savedDir, 'index.html'), 'utf8')).toContain('Corrected');
});

it('keeps intentionally separate apps independent even when titles match', async () => {
  const m = await import('../../../src/main/features/chat_artifacts');
  const a = await m.createArtifact(uid, cid, agent, { title: 'Chat', files: files('One') });
  const b = await m.createArtifact(uid, cid, agent, { title: 'Chat', files: files('Two') });
  if (!a.ok || !b.ok) throw new Error('fixture creation failed');
  expect(a.artifactId).not.toBe(b.artifactId);
  expect(fs.readdirSync(path.dirname(directory(a.artifactId)))).toHaveLength(2);
});

it('rejects foreign, missing and malformed revision targets and type conversion without creating or changing an app', async () => {
  const m = await import('../../../src/main/features/chat_artifacts');
  const first = await m.createArtifact(uid, cid, agent, { files: files('Keep') });
  if (!first.ok) throw new Error(first.error);
  for (const [user, chat, actor, id, extra] of [
    [uid, cid, 'other', first.artifactId, {}], [uid, 'other', agent, first.artifactId, {}],
    ['other', cid, agent, first.artifactId, {}], [uid, cid, agent, 'missing', {}],
    [uid, cid, agent, '../escape', {}], [uid, cid, agent, '', {}],
    [uid, cid, agent, first.artifactId, { appType: 'web' }],
  ] as const) {
    expect(await m.createArtifact(user, chat, actor, { artifactId: id, files: files('Wrong'), ...extra } as any)).toMatchObject({ ok: false });
  }
  expect(fs.readFileSync(path.join(directory(first.artifactId), 'index.html'), 'utf8')).toContain('Keep');
  expect(fs.readdirSync(path.dirname(directory(first.artifactId)))).toEqual([first.artifactId]);
});

it('retains the prior app when staging finalization fails and permits an explicit correction afterward', async () => {
  const m = await import('../../../src/main/features/chat_artifacts');
  const first = await m.createArtifact(uid, cid, agent, { files: files('Keep') });
  if (!first.ok) throw new Error(first.error);
  const input = { artifactId: first.artifactId, files: files('Fixed') };
  const failed = await (m.createArtifact as any)(uid, cid, agent, input, async () => { throw new Error('fixture finalization failure'); });
  expect(failed).toMatchObject({ ok: false });
  expect(fs.readFileSync(path.join(directory(first.artifactId), 'index.html'), 'utf8')).toContain('Keep');
  expect(await m.createArtifact(uid, cid, agent, input as any)).toMatchObject({ ok: true, artifactId: first.artifactId, revision: 2 });
});

it('does not activate a staged correction after a competing correction changed the original', async () => {
  const m = await import('../../../src/main/features/chat_artifacts');
  const first = await m.createArtifact(uid, cid, agent, { files: files('Keep') });
  if (!first.ok) throw new Error(first.error);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let staged = false;
  const slow = (m.createArtifact as any)(uid, cid, agent, { artifactId: first.artifactId, files: files('Stale') }, async () => { staged = true; await gate; });
  await vi.waitFor(() => expect(staged).toBe(true));
  expect(await m.createArtifact(uid, cid, agent, { artifactId: first.artifactId, files: files('Latest') } as any)).toMatchObject({ ok: true });
  release(); expect(await slow).toMatchObject({ ok: false });
  expect(fs.readFileSync(path.join(directory(first.artifactId), 'index.html'), 'utf8')).toContain('Latest');
  expect(fs.readdirSync(path.dirname(directory(first.artifactId)))).toEqual([first.artifactId]);
});
