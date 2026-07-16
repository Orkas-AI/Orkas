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

  it('rejects compacted history markers in artifact text files', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, {
      files: [
        {
          path: 'index.html',
          content:
            '[old tool input string compacted: original_size=13653 chars]\n' +
            'preview_head:\n<!doctype html><h1>stale preview</h1>',
        },
      ],
    });

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain('compacted conversation-history marker');
    expect(r.error).toContain('not an artifact or preview limitation');
    expect(fs.existsSync(cidDir())).toBe(false);
  });

  it('reports compacted history artifacts as unavailable without rewriting them', async () => {
    const m = await loadMod();
    const r = m.createArtifact(UID, CID, AGENT, { title: 'Ok app', files: MIN_FILES });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(m.inspectArtifactIndex(UID, CID, r.artifactId)).toEqual({ ok: true, status: 'ok' });

    const indexPath = path.join(cidDir(), r.artifactId, 'index.html');
    fs.writeFileSync(indexPath, '__orkas_compacted_tool_use', 'utf8');
    const inspected = m.inspectArtifactIndex(UID, CID, r.artifactId);
    expect(inspected).toMatchObject({
      ok: true,
      status: 'unavailable',
      marker: '__orkas_compacted_tool_use',
    });
    expect(fs.readFileSync(indexPath, 'utf8')).toBe('__orkas_compacted_tool_use');
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
