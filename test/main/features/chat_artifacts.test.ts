import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'u-artifact-001';
const CID = 'conv-art-1';
const AGENT = 'helper';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chatart-'));
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

async function loadMod() {
  return import('../../../src/main/features/chat_artifacts');
}

function cidDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'chat_artifacts', CID);
}

const MIN_FILES = [{ path: 'index.html', content: '<!doctype html><h1>hi</h1>' }];

/**
 * 2026-08-26: the host cannot measure a cross-origin iframe, so an artifact
 * that never posts `resize` stays at the 420px default for its whole life.
 * That was opt-in via `__orkas/bridge.js` and nobody opted in — three
 * consecutive artifacts in one conversation shipped `100vh` layouts with zero
 * height reporting and rendered about 39% clipped. Auto-sizing is now the
 * default; these tests are the reason it has to stay that way.
 */
describe('chat_artifacts › bridge injection', () => {
  function readEntry(dir: string): string {
    return fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  }

  it('gives an ordinary artifact the auto-sizing bridge without being asked', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, {
      title: 'Sized',
      files: [{ path: 'index.html', content: '<!doctype html><html><head><title>a</title></head><body><button>go</button></body></html>' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = readEntry(path.join(cidDir(), r.artifactId));
    expect(html).toContain(m.BRIDGE_SCRIPT_TAG);
    // In <head>, so the reporter is live before first paint rather than after
    // the layout the user already saw.
    expect(html.indexOf(m.BRIDGE_RELPATH)).toBeLessThan(html.indexOf('</head>'));
    expect(html).toContain('<button>go</button>');
  });

  it('does not inject twice when the artifact already loads the bridge', async () => {
    const m = await loadMod();
    const authored = `<!doctype html><html><head>${m.BRIDGE_SCRIPT_TAG}</head><body><button>go</button></body></html>`;
    const r = m.createArtifact(UID, CID, AGENT, { title: 'Own bridge', files: [{ path: 'index.html', content: authored }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = readEntry(path.join(cidDir(), r.artifactId));
    expect(html.split(m.BRIDGE_RELPATH).length - 1).toBe(1);
  });

  it('leaves an artifact that already reports its own height alone', async () => {
    // Two writers on one frame height would fight; the artifact wins.
    const m = await loadMod();
    const authored = '<!doctype html><html><head><script>'
      + 'parent.postMessage({ __orkasArtifact: true, type: "resize", height: 300 }, "*");'
      + '</script></head><body><button>go</button></body></html>';
    const r = m.createArtifact(UID, CID, AGENT, { title: 'Self sizing', files: [{ path: 'index.html', content: authored }] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readEntry(path.join(cidDir(), r.artifactId))).not.toContain(m.BRIDGE_RELPATH);
  });

  it('places the tag in a fragment that has no head or body', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, {
      title: 'Fragment',
      files: [{ path: 'index.html', content: '<h1>hi</h1><button>go</button>' }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = readEntry(path.join(cidDir(), r.artifactId));
    expect(html).toContain('<h1>hi</h1>');
    expect(html).toContain(m.BRIDGE_SCRIPT_TAG);
  });

  it('only touches the entry file', async () => {
    const m = await loadMod();
    const helper = 'export const value = 1;\n';
    const r = m.createArtifact(UID, CID, AGENT, {
      title: 'Multi',
      files: [
        { path: 'index.html', content: '<!doctype html><html><body><button>go</button></body></html>' },
        { path: 'app.js', content: helper },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dir = path.join(cidDir(), r.artifactId);
    expect(fs.readFileSync(path.join(dir, 'app.js'), 'utf8')).toBe(helper);
    expect(readEntry(dir)).toContain(m.BRIDGE_SCRIPT_TAG);
  });

  it('reports the real content height, which is the whole point of injecting it', async () => {
    const m = await loadMod();
    // The bridge is what turns a 420px frame into a fitted one. Pin the
    // behaviour, not just the tag: a bridge that stopped posting `resize`
    // would leave the tag in place and the artifact clipped again.
    expect(m.BRIDGE_JS).toContain('scrollHeight');
    expect(m.BRIDGE_JS).toContain("post('resize'");
  });
});

describe('chat_artifacts › createArtifact', () => {
  it('accepts a minimal one-file app, stamps meta, returns the id', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, { title: 'Tip calc', files: MIN_FILES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.artifactId).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(r.title).toBe('Tip calc');
    const dir = path.join(cidDir(), r.artifactId);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('<h1>hi</h1>');
    const meta = JSON.parse(fs.readFileSync(path.join(dir, '__orkas-meta.json'), 'utf8'));
    expect(meta.title).toBe('Tip calc');
    expect(meta.agentId).toBe(AGENT);
    expect(typeof meta.createdAt).toBe('string');
    // No leftover temp dir.
    expect(fs.readdirSync(cidDir()).some((n) => n.includes('.tmp-'))).toBe(false);
  });

  it('accepts a multi-file app with a nested asset', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, {
      title: 'Dash',
      files: [
        { path: 'index.html', content: '<!doctype html><script src="assets/app.js"></script>' },
        { path: 'assets/app.js', content: 'console.log(1)' },
        { path: 'style.css', content: 'body{margin:0}' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dir = path.join(cidDir(), r.artifactId);
    expect(fs.existsSync(path.join(dir, 'assets', 'app.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'style.css'))).toBe(true);
  });

  it('discards one failed candidate without removing sibling artifacts', async () => {
    const m = await loadMod();
    const first = m.createArtifact(UID, CID, AGENT, { title: 'First', files: MIN_FILES });
    const second = m.createArtifact(UID, CID, AGENT, { title: 'Second', files: MIN_FILES });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(m.discardArtifact(UID, CID, first.artifactId)).toEqual({ ok: true, deleted: true });
    expect(fs.existsSync(path.join(cidDir(), first.artifactId))).toBe(false);
    expect(fs.existsSync(path.join(cidDir(), second.artifactId, 'index.html'))).toBe(true);
  });

  it('does not expose validation details when a discard identity is invalid', async () => {
    const m = await loadMod();

    expect(m.discardArtifact(UID, CID, '../private-artifact')).toEqual({
      ok: false,
      error: 'invalid artifact identity',
    });
  });

  it('accepts base64-encoded binary content for an image asset', async () => {
    const m = await loadMod();
    const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const r = m.createArtifact(UID, CID, AGENT, {
      files: [
        { path: 'index.html', content: '<!doctype html><img src="logo.png">' },
        { path: 'logo.png', content: pngB64, encoding: 'base64' },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const buf = fs.readFileSync(path.join(cidDir(), r.artifactId, 'logo.png'));
    expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('rejects: no index.html', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, { files: [{ path: 'main.html', content: 'x' }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/index\.html/);
  });

  it('rejects: empty / non-array files', async () => {
    const m = await loadMod();
    expect((m.createArtifact(UID, CID, AGENT, { files: [] }) as { ok: boolean }).ok).toBe(false);
    expect((m.createArtifact(UID, CID, AGENT, { files: 'nope' as unknown as [] }) as { ok: boolean }).ok).toBe(false);
  });

  it('rejects: path traversal in a file path', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, {
      files: [{ path: 'index.html', content: 'x' }, { path: '../escape.js', content: 'x' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects: absolute file path', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, {
      files: [{ path: 'index.html', content: 'x' }, { path: '/etc/passwd', content: 'x' }],
    });
    // leading slash is stripped → "etc/passwd" with no extension → unsupported ext
    expect(r.ok).toBe(false);
  });

  it('rejects: reserved __orkas-meta.json / __orkas/ paths', async () => {
    const m = await loadMod();
    expect((m.createArtifact(UID, CID, AGENT, { files: [{ path: 'index.html', content: 'x' }, { path: '__orkas-meta.json', content: '{}' }] }) as { ok: boolean }).ok).toBe(false);
    expect((m.createArtifact(UID, CID, AGENT, { files: [{ path: 'index.html', content: 'x' }, { path: '__orkas/bridge.js', content: 'x' }] }) as { ok: boolean }).ok).toBe(false);
  });

  it('rejects: disallowed extension', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, {
      files: [{ path: 'index.html', content: 'x' }, { path: 'evil.exe', content: 'AA==', encoding: 'base64' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects: too many files', async () => {
    const m = await loadMod();
    const files = [{ path: 'index.html', content: 'x' }];
    for (let i = 0; i < 25; i++) files.push({ path: `f${i}.js`, content: 'x' });
    const r = m.createArtifact(UID, CID, AGENT, { files });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/too many files/);
  });

  it('rejects: a single file over the per-file cap', async () => {
    const m = await loadMod();
    const big = 'a'.repeat(300 * 1024);
    const r = m.createArtifact(UID, CID, AGENT, { files: [{ path: 'index.html', content: '<x>' }, { path: 'big.js', content: big }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/per-file cap/);
  });

  it('rejects: bundle over the total cap', async () => {
    const m = await loadMod();
    const chunk = 'a'.repeat(200 * 1024);
    const r = m.createArtifact(UID, CID, AGENT, {
      files: [
        { path: 'index.html', content: '<x>' },
        { path: 'a.js', content: chunk },
        { path: 'b.js', content: chunk },
        { path: 'c.js', content: chunk },
        { path: 'd.js', content: chunk },
        { path: 'e.js', content: chunk },
        { path: 'f.js', content: chunk },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/total cap/);
  });

  it('rejects: utf8-encoded content for a binary extension', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, { files: [{ path: 'index.html', content: '<x>' }, { path: 'logo.png', content: 'not base64 binary' }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/base64/);
  });

  it('rejects: duplicate file paths (case-insensitive)', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, { files: [{ path: 'index.html', content: 'x' }, { path: 'Index.HTML', content: 'y' }] });
    expect(r.ok).toBe(false);
  });
});

describe('chat_artifacts › resolveArtifactFilePath', () => {
  async function seed() {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, {
      files: [
        { path: 'index.html', content: '<!doctype html><h1>hi</h1>' },
        { path: 'assets/app.js', content: 'console.log(2)' },
      ],
    });
    if (!r.ok) throw new Error('seed failed: ' + r.error);
    return { m, artifactId: r.artifactId };
  }

  it('resolves index.html (explicit and via empty relpath)', async () => {
    const { m, artifactId } = await seed();
    for (const rel of ['index.html', '', '/']) {
      const got = m.resolveArtifactFilePath(UID, CID, artifactId, rel);
      expect(got.ok).toBe(true);
      if (!got.ok) continue;
      expect(got.absPath.endsWith(`${path.sep}index.html`)).toBe(true);
      expect(got.mime).toMatch(/text\/html/);
    }
  });

  it('resolves a nested asset with the right mime', async () => {
    const { m, artifactId } = await seed();
    const got = m.resolveArtifactFilePath(UID, CID, artifactId, 'assets/app.js');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.mime).toMatch(/javascript/);
  });

  it('rejects a served asset symlink that escapes the artifact root', async () => {
    const { m, artifactId } = await seed();
    const outside = path.join(tmpDir, 'outside.js');
    const linked = path.join(cidDir(), artifactId, 'assets', 'app.js');
    fs.writeFileSync(outside, 'secret');
    fs.rmSync(linked);
    fs.symlinkSync(outside, linked);

    const got = m.resolveArtifactFilePath(UID, CID, artifactId, 'assets/app.js');
    expect(got.ok).toBe(false);
    if (!got.ok) expect(got.code).toBe('forbidden');
  });

  it('rejects: path traversal (../)', async () => {
    const { m, artifactId } = await seed();
    const got = m.resolveArtifactFilePath(UID, CID, artifactId, '../../etc/passwd');
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.code).toBe('bad_input'); // safeRelPath rejects ".." segments before disk
  });

  it('rejects: absolute path', async () => {
    const { m, artifactId } = await seed();
    const got = m.resolveArtifactFilePath(UID, CID, artifactId, '/etc/passwd');
    expect(got.ok).toBe(false);
  });

  it('rejects: missing file', async () => {
    const { m, artifactId } = await seed();
    const got = m.resolveArtifactFilePath(UID, CID, artifactId, 'nope.js');
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.code).toBe('not_found');
  });

  it('rejects: a bare directory name (no served extension)', async () => {
    const { m, artifactId } = await seed();
    const got = m.resolveArtifactFilePath(UID, CID, artifactId, 'assets');
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.code).toBe('forbidden'); // no served extension
  });

  it('rejects: disallowed extension on the request', async () => {
    const { m, artifactId } = await seed();
    const got = m.resolveArtifactFilePath(UID, CID, artifactId, 'shell.exe');
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.code).toBe('forbidden');
  });

  it('rejects: bad cid / bad artifactId', async () => {
    const { m, artifactId } = await seed();
    expect((m.resolveArtifactFilePath(UID, 'bad/cid', artifactId, 'index.html') as { ok: boolean }).ok).toBe(false);
    expect((m.resolveArtifactFilePath(UID, CID, 'bad/id', 'index.html') as { ok: boolean }).ok).toBe(false);
    expect((m.resolveArtifactFilePath(UID, CID, '..', 'index.html') as { ok: boolean }).ok).toBe(false);
  });

  it('rejects: anything under the reserved __orkas/ prefix', async () => {
    const { m, artifactId } = await seed();
    const got = m.resolveArtifactFilePath(UID, CID, artifactId, '__orkas/secrets.js');
    expect(got.ok).toBe(false);
  });
});

describe('chat_artifacts › purgeByCid', () => {
  it('removes the whole chat_artifacts/<cid>/ tree', async () => {
    const m = await loadMod();
    expect(m.createArtifact(UID, CID, AGENT, { files: MIN_FILES }).ok).toBe(true);
    expect(m.createArtifact(UID, CID, AGENT, { files: MIN_FILES }).ok).toBe(true);
    expect(fs.existsSync(cidDir())).toBe(true);
    const n = await m.purgeByCid(UID, CID);
    expect(n).toBe(2);
    expect(fs.existsSync(cidDir())).toBe(false);
    // Idempotent.
    expect(await m.purgeByCid(UID, CID)).toBe(0);
  });
});
