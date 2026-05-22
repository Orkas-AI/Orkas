import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// `saved_apps.ts` → `chats.ts` → `group_chat` pulls in `model/client`; mock it
// so nothing tries a real LLM call (the openForEditing path doesn't dispatch a
// worker, but the mock keeps the import graph inert and matches chats.test.ts).
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) { yield { type: 'final', text: '' }; yield { type: 'done' }; },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

const UID = 'u-savedapps-001';
const CID = 'conv-sa-1';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-savedapps-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function mods() {
  const savedApps = await import('../../../src/main/features/saved_apps');
  const chatArtifacts = await import('../../../src/main/features/chat_artifacts');
  return { savedApps, chatArtifacts };
}

const APPS_ROOT = () => path.join(tmpDir, UID, 'cloud', 'saved_apps');

/** Make a chat artifact and return its id. */
async function makeArtifact(title: string, extra: Array<{ path: string; content: string }> = []) {
  const { chatArtifacts } = await mods();
  const r = chatArtifacts.createArtifact(UID, CID, 'helper', {
    title,
    files: [{ path: 'index.html', content: `<!doctype html><h1>${title}</h1>` }, ...extra],
  });
  if (!r.ok) throw new Error(`createArtifact failed: ${(r as { error: string }).error}`);
  return r.artifactId;
}

describe('saved_apps › saveFromArtifact', () => {
  it('copies the bundle (sans source meta) + stamps a provenance meta', async () => {
    const aid = await makeArtifact('Tip calc', [{ path: 'assets/app.js', content: 'console.log(1)' }]);
    const { savedApps } = await mods();
    const r = savedApps.saveFromArtifact(UID, CID, aid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(r.title).toBe('Tip calc');
    const dir = path.join(APPS_ROOT(), r.id);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('<h1>Tip calc</h1>');
    expect(fs.existsSync(path.join(dir, 'assets', 'app.js'))).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '__orkas-meta.json'), 'utf8'));
    expect(meta.title).toBe('Tip calc');
    expect(meta.sourceCid).toBe(CID);
    expect(meta.sourceArtifactId).toBe(aid);
    expect(typeof meta.savedAt).toBe('string');
    // The source artifact's own meta name must not have been carried over verbatim
    // (it is, but rewritten) — agentId from the artifact meta should be gone.
    expect('agentId' in meta).toBe(false);
    // No leftover temp dir.
    expect(fs.readdirSync(APPS_ROOT()).some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('rejects a bad cid, a bad artifactId, and a missing artifact', async () => {
    const { savedApps } = await mods();
    expect(savedApps.saveFromArtifact(UID, '../evil', 'whatever').ok).toBe(false);
    expect(savedApps.saveFromArtifact(UID, CID, 'has/slash').ok).toBe(false);
    expect(savedApps.saveFromArtifact(UID, CID, 'Zm9vYmFyAA').ok).toBe(false); // well-formed id, no such dir
  });
});

describe('saved_apps › resolveSavedAppIndex', () => {
  it('resolves a real app and rejects bad / missing ids', async () => {
    const aid = await makeArtifact('Game');
    const { savedApps } = await mods();
    const saved = savedApps.saveFromArtifact(UID, CID, aid);
    if (!saved.ok) throw new Error('save failed');

    const ok = savedApps.resolveSavedAppIndex(UID, saved.id);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(fs.readFileSync(ok.absPath, 'utf8')).toContain('<h1>Game</h1>');

    const bad = savedApps.resolveSavedAppIndex(UID, '../etc');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('bad_input');

    const missing = savedApps.resolveSavedAppIndex(UID, 'Zm9vYmFyAA');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('not_found');
  });
});

describe('saved_apps › rename / delete', () => {
  it('renameSavedApp rewrites the meta title; empty title is refused', async () => {
    const aid = await makeArtifact('Old');
    const { savedApps } = await mods();
    const saved = savedApps.saveFromArtifact(UID, CID, aid);
    if (!saved.ok) throw new Error('save failed');

    expect(savedApps.renameSavedApp(UID, saved.id, '   ').ok).toBe(false);
    const r = savedApps.renameSavedApp(UID, saved.id, 'New name');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.title).toBe('New name');
    const meta = JSON.parse(fs.readFileSync(path.join(APPS_ROOT(), saved.id, '__orkas-meta.json'), 'utf8'));
    expect(meta.title).toBe('New name');
  });

  it('deleteSavedApp removes the directory', async () => {
    const aid = await makeArtifact('Doomed');
    const { savedApps } = await mods();
    const saved = savedApps.saveFromArtifact(UID, CID, aid);
    if (!saved.ok) throw new Error('save failed');
    const dir = path.join(APPS_ROOT(), saved.id);
    expect(fs.existsSync(dir)).toBe(true);
    expect(savedApps.deleteSavedApp(UID, saved.id).ok).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    // Idempotent — deleting again is still ok.
    expect(savedApps.deleteSavedApp(UID, saved.id).ok).toBe(true);
    // Bad id is refused.
    expect(savedApps.deleteSavedApp(UID, '../boom').ok).toBe(false);
  });
});

describe('saved_apps › listSavedApps', () => {
  it('lists A→Z by title and tolerates a corrupt meta (fallback title, still listed)', async () => {
    const { savedApps } = await mods();
    const a1 = await makeArtifact('Zebra');
    const a2 = await makeArtifact('alpha');
    const s1 = savedApps.saveFromArtifact(UID, CID, a1);
    const s2 = savedApps.saveFromArtifact(UID, CID, a2);
    if (!s1.ok || !s2.ok) throw new Error('save failed');
    // Corrupt one app's meta.
    fs.writeFileSync(path.join(APPS_ROOT(), s1.id, '__orkas-meta.json'), '{ not json');
    // A non-conforming directory name must be ignored.
    fs.mkdirSync(path.join(APPS_ROOT(), 'has space'), { recursive: true });

    const list = savedApps.listSavedApps(UID);
    expect(list.map((x) => x.id).sort()).toEqual([s1.id, s2.id].sort());
    // s2 ("alpha") sorts before s1 (corrupt → "Interactive app").
    expect(list[0].id).toBe(s2.id);
    expect(list[0].title).toBe('alpha');
    const corrupt = list.find((x) => x.id === s1.id);
    expect(corrupt?.title).toBe('Interactive app');
  });

  it('returns [] when the pool dir does not exist', async () => {
    const { savedApps } = await mods();
    // No save has happened, but activateUser mkdir's the skeleton including
    // saved_apps/ — remove it to exercise the missing-dir branch.
    fs.rmSync(APPS_ROOT(), { recursive: true, force: true });
    expect(savedApps.listSavedApps(UID)).toEqual([]);
  });
});

describe('saved_apps › openForEditing', () => {
  function attachDir(cid: string): string {
    return path.join(tmpDir, UID, 'cloud', 'chat_attachments', cid);
  }

  it('creates a conversation and bundles every source file into app-source.md', async () => {
    const { savedApps, chatArtifacts } = await mods();
    const chats = await import('../../../src/main/features/chats');
    const aid = await makeArtifact('Snake', [
      { path: 'assets/app.js', content: 'const SPEED = 7; // tweak me' },
      { path: 'style.css', content: 'body { background: #000 }' },
    ]);
    const saved = savedApps.saveFromArtifact(UID, CID, aid);
    if (!saved.ok) throw new Error('save failed');

    const before = (await chats.listConversations(UID)).length;
    const r = await savedApps.openForEditing(UID, saved.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const conv = r.conversation as { conversation_id: string };
    expect(typeof conv.conversation_id).toBe('string');
    expect(r.sourceFileName).toBe('app-source.md');
    expect((await chats.listConversations(UID)).length).toBe(before + 1);

    const bundlePath = path.join(attachDir(conv.conversation_id), r.sourceFileName);
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    expect(bundle).toContain('========== FILE: index.html ==========');
    expect(bundle).toContain('<h1>Snake</h1>');
    expect(bundle).toContain('========== FILE: assets/app.js ==========');
    expect(bundle).toContain('const SPEED = 7; // tweak me');
    expect(bundle).toContain('========== FILE: style.css ==========');
    expect(bundle).toContain('body { background: #000 }');
    // The source meta file must not be dumped into the bundle.
    expect(bundle).not.toContain('__orkas-meta.json');
    void chatArtifacts;
  });

  it('rejects a bad / missing appId and leaves no conversation behind', async () => {
    const { savedApps } = await mods();
    const chats = await import('../../../src/main/features/chats');
    const before = (await chats.listConversations(UID)).length;
    expect((await savedApps.openForEditing(UID, '../evil')).ok).toBe(false);
    expect((await savedApps.openForEditing(UID, 'Zm9vYmFyAA')).ok).toBe(false); // well-formed id, no such app
    expect((await chats.listConversations(UID)).length).toBe(before);
  });
});
