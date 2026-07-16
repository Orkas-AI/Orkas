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
const attachDir = (cid: string) => path.join(tmpDir, UID, 'cloud', 'chat_attachments', cid);

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

describe('saved_apps › saveFromPath', () => {
  it('saves the whole app bundle when given a nested resource file', async () => {
    const root = path.join(tmpDir, 'workspace', 'snake');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Snake</title><script src="assets/app.js"></script>');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{}');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log(1)');
    fs.mkdirSync(path.join(root, 'node_modules', 'skip'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'skip', 'big.js'), 'nope');

    const { savedApps } = await mods();
    const inspected = savedApps.inspectBundleFromPath(path.join(root, 'assets', 'app.js'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(inspected).toMatchObject({ ok: true, canSave: true, rootDir: root, entry: 'index.html', title: 'Snake' });
    const r = savedApps.saveFromPath(UID, path.join(root, 'assets', 'app.js'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dir = path.join(APPS_ROOT(), r.id);
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'styles.css'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'assets', 'app.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'node_modules', 'skip', 'big.js'))).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '__orkas-meta.json'), 'utf8'));
    expect(meta.title).toBe('Snake');
    expect(meta.sourcePath).toBe(root);
  });

  it('copies supported static resources and skips hidden, symlinked, excluded, and unsupported files', async () => {
    const root = path.join(tmpDir, 'workspace', 'assets-app');
    const outside = path.join(tmpDir, 'outside');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Assets</title>');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{}');
    fs.writeFileSync(path.join(root, 'site.webmanifest'), '{"name":"Assets"}');
    fs.writeFileSync(path.join(root, 'sound.mp3'), 'fake mp3');
    fs.writeFileSync(path.join(root, 'model.glb'), 'fake glb');
    fs.writeFileSync(path.join(root, 'assets', 'logo.png'), 'fake png');
    fs.writeFileSync(path.join(root, 'archive.zip'), 'skip zip');
    fs.writeFileSync(path.join(root, '.env'), 'skip hidden');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'skip package');
    fs.writeFileSync(path.join(outside, 'linked.txt'), 'skip symlink');
    fs.symlinkSync(path.join(outside, 'linked.txt'), path.join(root, 'linked.txt'));

    const { savedApps } = await mods();
    const r = savedApps.saveFromPath(UID, path.join(root, 'styles.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dir = path.join(APPS_ROOT(), r.id);
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'styles.css'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'site.webmanifest'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'sound.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'model.glb'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'assets', 'logo.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'archive.zip'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'node_modules', 'pkg', 'index.js'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'linked.txt'))).toBe(false);
  });

  it('keeps images as bundle resources but never treats an image as a save trigger', async () => {
    const root = path.join(tmpDir, 'workspace', 'image-assets');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Image assets</title>');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{}');
    const imageNames = [
      'logo.svg', 'frame.png', 'photo.jpg', 'photo.jpeg', 'cover.webp',
      'animation.gif', 'poster.avif', 'bitmap.bmp', 'favicon.ico',
    ];
    for (const name of imageNames) fs.writeFileSync(path.join(root, 'assets', name), 'fake image');

    const { savedApps } = await mods();
    for (const name of imageNames) {
      expect(savedApps.inspectBundleFromPath(path.join(root, 'assets', name), { fenceRoots: [path.join(tmpDir, 'workspace')] }))
        .toMatchObject({ ok: true, canSave: false });
    }
    expect(savedApps.saveFromPath(UID, path.join(root, 'assets', 'frame.png'), { fenceRoots: [path.join(tmpDir, 'workspace')] }).ok)
      .toBe(false);

    const saved = savedApps.saveFromPath(UID, path.join(root, 'styles.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    for (const name of imageNames) {
      expect(fs.existsSync(path.join(APPS_ROOT(), saved.id, 'assets', name))).toBe(true);
    }
  });

  it('keeps non-source assets in the bundle without treating them as save triggers', async () => {
    const root = path.join(tmpDir, 'workspace', 'resource-assets');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Resource assets</title>');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{}');
    const resourceNames = [
      'data.json', 'site.webmanifest', 'font.woff', 'font.woff2', 'font.ttf',
      'module.wasm', 'sound.mp3', 'sound.wav', 'sound.ogg', 'clip.mp4', 'clip.webm',
      'model.glb', 'model.gltf', 'notes.txt', 'readme.md', 'table.csv', 'feed.xml',
    ];
    for (const name of resourceNames) fs.writeFileSync(path.join(root, name), `fake ${name}`);

    const { savedApps } = await mods();
    for (const name of resourceNames) {
      expect(savedApps.inspectBundleFromPath(path.join(root, name), { fenceRoots: [path.join(tmpDir, 'workspace')] }))
        .toMatchObject({ ok: true, canSave: false });
    }

    const saved = savedApps.saveFromPath(UID, path.join(root, 'styles.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    for (const name of resourceNames) {
      expect(fs.existsSync(path.join(APPS_ROOT(), saved.id, name))).toBe(true);
    }
  });

  it('supports non-index HTML entries', async () => {
    const root = path.join(tmpDir, 'workspace', 'arcade');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'game.html'), '<!doctype html><title>Arcade Game</title><link rel="stylesheet" href="styles.css">');
    fs.writeFileSync(path.join(root, 'styles.css'), 'body{}');
    fs.writeFileSync(path.join(root, 'assets', 'game.js'), 'console.log(1)');
    fs.writeFileSync(path.join(root, 'assets', 'logo.png'), 'fake png');

    const { savedApps } = await mods();
    const inspectedFromResource = savedApps.inspectBundleFromPath(path.join(root, 'assets', 'game.js'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(inspectedFromResource).toMatchObject({ ok: true, canSave: true, rootDir: root, entry: 'game.html', title: 'Arcade Game' });
    const inspectedFromDir = savedApps.inspectBundleFromPath(root, { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(inspectedFromDir).toMatchObject({ ok: true, canSave: true, rootDir: root, entry: 'game.html' });

    const r = savedApps.saveFromPath(UID, path.join(root, 'styles.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dir = path.join(APPS_ROOT(), r.id);
    expect(fs.existsSync(path.join(dir, 'game.html'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(false);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '__orkas-meta.json'), 'utf8'));
    expect(meta.entry).toBe('game.html');
    const resolved = savedApps.resolveSavedAppIndex(UID, r.id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.absPath).toBe(path.join(dir, 'game.html'));
    const edit = await savedApps.openForEditing(UID, r.id);
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    const conv = edit.conversation as { conversation_id: string };
    const bundlePath = path.join(attachDir(conv.conversation_id), edit.sourceFileName);
    const bundle = fs.readFileSync(bundlePath, 'utf8');
    expect(bundle).toContain('current entry HTML is `game.html`');
    expect(bundle).toContain('========== FILE: game.html ==========');
    expect(bundle).toContain('========== FILE: assets/game.js ==========');
    expect(bundle).toContain('[binary asset: assets/logo.png');
  });

  it('prefers index.html for a directory but uses the clicked HTML file as the entry', async () => {
    const root = path.join(tmpDir, 'workspace', 'multi-html');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Main</title>');
    fs.writeFileSync(path.join(root, 'game.html'), '<!doctype html><title>Game</title>');

    const { savedApps } = await mods();
    expect(savedApps.inspectBundleFromPath(root, { fenceRoots: [path.join(tmpDir, 'workspace')] }))
      .toMatchObject({ ok: true, canSave: true, entry: 'index.html', title: 'Main' });
    const inspectedGame = savedApps.inspectBundleFromPath(path.join(root, 'game.html'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(inspectedGame).toMatchObject({ ok: true, canSave: true, entry: 'game.html', title: 'Game' });
    const saved = savedApps.saveFromPath(UID, path.join(root, 'game.html'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const resolved = savedApps.resolveSavedAppIndex(UID, saved.id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.absPath).toBe(path.join(APPS_ROOT(), saved.id, 'game.html'));
  });

  it('refuses unsupported files and folders without an HTML entry', async () => {
    const root = path.join(tmpDir, 'workspace', 'docs');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'report.pdf'), 'fake');
    fs.writeFileSync(path.join(root, 'notes.md'), '# notes');

    const { savedApps } = await mods();
    expect(savedApps.inspectBundleFromPath(path.join(root, 'report.pdf'), { fenceRoots: [path.join(tmpDir, 'workspace')] }))
      .toMatchObject({ ok: true, canSave: false });
    expect(savedApps.inspectBundleFromPath(root, { fenceRoots: [path.join(tmpDir, 'workspace')] }))
      .toMatchObject({ ok: true, canSave: false });
    expect(savedApps.saveFromPath(UID, path.join(root, 'report.pdf'), { fenceRoots: [path.join(tmpDir, 'workspace')] }).ok)
      .toBe(false);
  });

  it('does not cross the allowed fence while looking for an HTML entry', async () => {
    const workspace = path.join(tmpDir, 'workspace');
    const app = path.join(workspace, 'app');
    fs.mkdirSync(path.join(app, 'src'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><title>Outside</title>');
    fs.writeFileSync(path.join(app, 'src', 'app.js'), 'console.log(1)');

    const { savedApps } = await mods();
    expect(savedApps.inspectBundleFromPath(path.join(app, 'src', 'app.js'), { fenceRoots: [app] }))
      .toMatchObject({ ok: true, canSave: false });
  });

  it('refuses bundles over the file-count limit and leaves no temp app directory', async () => {
    const root = path.join(tmpDir, 'workspace', 'too-many-files');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>Too many</title>');
    for (let i = 0; i < 300; i += 1) {
      fs.writeFileSync(path.join(root, `file-${String(i).padStart(3, '0')}.css`), 'body{}');
    }

    const { savedApps } = await mods();
    const inspected = savedApps.inspectBundleFromPath(path.join(root, 'file-000.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(inspected).toMatchObject({ ok: true, canSave: false });
    if (inspected.ok && !inspected.canSave) expect(inspected.reason).toContain('too many files');
    const r = savedApps.saveFromPath(UID, path.join(root, 'file-000.css'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(r.ok).toBe(false);
    const names = fs.readdirSync(APPS_ROOT());
    expect(names.some((n) => n.includes('.tmp-'))).toBe(false);
    expect(names.length).toBe(0);
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

  it('falls back to index.html for legacy or corrupt meta', async () => {
    const aid = await makeArtifact('Legacy');
    const { savedApps } = await mods();
    const saved = savedApps.saveFromArtifact(UID, CID, aid);
    if (!saved.ok) throw new Error('save failed');
    const dir = path.join(APPS_ROOT(), saved.id);
    fs.writeFileSync(path.join(dir, '__orkas-meta.json'), '{ not json');

    const resolved = savedApps.resolveSavedAppIndex(UID, saved.id);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.absPath).toBe(path.join(dir, 'index.html'));
    const edit = await savedApps.openForEditing(UID, saved.id);
    expect(edit.ok).toBe(true);
  });
});

describe('saved_apps › resolveSavedAppFilePath', () => {
  it('resolves the configured entry and sibling assets for chat-app://saved', async () => {
    const { savedApps } = await mods();
    const root = path.join(tmpDir, 'workspace', 'calculator');
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'calculator.html'), '<!doctype html><title>Calc</title><script src="assets/app.js"></script>');
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'console.log("calc")');
    const saved = savedApps.saveFromPath(UID, path.join(root, 'calculator.html'), { fenceRoots: [path.join(tmpDir, 'workspace')] });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const entry = savedApps.resolveSavedAppFilePath(UID, saved.id, '');
    expect(entry.ok).toBe(true);
    if (entry.ok) {
      expect(entry.absPath).toBe(path.join(APPS_ROOT(), saved.id, 'calculator.html'));
      expect(entry.entry).toBe('calculator.html');
      expect(entry.mime).toMatch(/text\/html/);
    }

    const js = savedApps.resolveSavedAppFilePath(UID, saved.id, 'assets/app.js');
    expect(js.ok).toBe(true);
    if (js.ok) {
      expect(js.absPath).toBe(path.join(APPS_ROOT(), saved.id, 'assets', 'app.js'));
      expect(js.mime).toMatch(/javascript/);
    }
  });

  it('rejects traversal, metadata, and unsupported extensions', async () => {
    const aid = await makeArtifact('Guard');
    const { savedApps } = await mods();
    const saved = savedApps.saveFromArtifact(UID, CID, aid);
    if (!saved.ok) throw new Error('save failed');
    fs.writeFileSync(path.join(APPS_ROOT(), saved.id, 'shell.exe'), 'nope');

    const traversal = savedApps.resolveSavedAppFilePath(UID, saved.id, '../index.html');
    expect(traversal.ok).toBe(false);
    if (!traversal.ok) expect(traversal.code).toBe('bad_input');

    const meta = savedApps.resolveSavedAppFilePath(UID, saved.id, '__orkas-meta.json');
    expect(meta.ok).toBe(false);
    if (!meta.ok) expect(meta.code).toBe('not_found');

    const exe = savedApps.resolveSavedAppFilePath(UID, saved.id, 'shell.exe');
    expect(exe.ok).toBe(false);
    if (!exe.ok) expect(exe.code).toBe('forbidden');
  });

  it('rejects an app resource symlink that escapes the saved bundle', async () => {
    const aid = await makeArtifact('Symlink guard', [{ path: 'assets/app.js', content: 'safe' }]);
    const { savedApps } = await mods();
    const saved = savedApps.saveFromArtifact(UID, CID, aid);
    if (!saved.ok) throw new Error('save failed');
    const outside = path.join(tmpDir, 'outside.js');
    const linked = path.join(APPS_ROOT(), saved.id, 'assets', 'app.js');
    fs.writeFileSync(outside, 'secret');
    fs.rmSync(linked);
    fs.symlinkSync(outside, linked);

    const resolved = savedApps.resolveSavedAppFilePath(UID, saved.id, 'assets/app.js');
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.code).toBe('forbidden');
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
