import { captureMainLogWorkers } from '../../helpers/capture-main-log-workers';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const UID = 'u-artifact-001';
const CID = 'conv-art-1';
const AGENT = 'helper';

let tmpDir: string;
let prevWs: string | undefined;

let closeLogWorkers: () => Promise<void>;
beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chatart-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  closeLogWorkers = await captureMainLogWorkers();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  await closeLogWorkers();
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
it.each(['local','web'] as const)('accepts a valid base64 manifest for a %s artifact while preserving the host permission boundary',async appType=>{
  const m=await loadMod(),manifest={sdkVersion:1,capabilities:['data'],data:{version:1,tables:[]}};
  const result=await m.createArtifact(UID,CID,AGENT,{appType,files:[...MIN_FILES,{path:'orkas-app.json',content:Buffer.from(JSON.stringify(manifest)).toString('base64'),encoding:'base64'}]});
  expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error);
  const saved=JSON.parse(fs.readFileSync(path.join(cidDir(),result.artifactId,'orkas-app.json'),'utf8'));
  expect(saved).toMatchObject(manifest);expect(m.readArtifactMeta(UID,CID,result.artifactId)?.appType).toBe(appType);
  if(appType==='web')expect(saved.minimumClient).toBe('1.9.0');
  const denied=await m.createArtifact(UID,CID,AGENT,{appType:'web',files:[...MIN_FILES,{path:'orkas-app.json',content:Buffer.from(JSON.stringify({sdkVersion:1,capabilities:['ai']})).toString('base64'),encoding:'base64'}]});
  expect(denied).toMatchObject({ok:false,error:'web applications cannot use host interfaces: declared local-only capabilities ai; web apps may declare only data'});
  const missing=await m.createArtifact(UID,CID,AGENT,{appType,files:[...MIN_FILES,{path:'orkas-app.json',content:JSON.stringify({sdkVersion:1,capabilities:['data']})}]});
  expect(missing).toMatchObject({ok:false,error:'data definition is required'});
});

// 2026-10-15 live regression: an opaque manifest rejection made authors drop
// the declaration instead of correcting it. Each rejection names its cause,
// stays bounded, and creates nothing.
const PREFIX = 'invalid application interface declaration in orkas-app.json: ';
const TABLE = (fields: unknown, access: unknown = { read: ['body'], insert: ['body'] }) =>
  ({ sdkVersion: 1, capabilities: ['data'], data: { version: 1, tables: [{ id: 'notes', name: 'notes', fields, access }] } });
const BODY = [{ id: 'body', name: 'body', type: 'string' }];
it.each([
  ['non-UTF-8 bytes', { content: Buffer.from([0x7b, 0xff, 0xfe, 0x7d]).toString('base64'), encoding: 'base64' }, 'must be UTF-8 text'],
  ['malformed JSON', { content: '{"sdkVersion":1,' }, 'must be valid JSON'],
  ['a non-object root', { content: '[]' }, 'root must be object, received array'],
  ['a missing sdkVersion', { content: JSON.stringify({ capabilities: [] }) }, 'sdkVersion is required'],
  ['an unsupported sdkVersion', { content: JSON.stringify({ sdkVersion: 2, capabilities: [] }) }, 'sdkVersion must be 1'],
  ['an unknown capability', { content: JSON.stringify({ sdkVersion: 1, capabilities: ['storage', 'shell'] }) },
    'capabilities[1] must be one of storage, appFiles, files, ai, library, connectors, data'],
  ['capabilities as an object', { content: JSON.stringify({ sdkVersion: 1, capabilities: { data: true } }) }, 'capabilities must be array, received object'],
  ['invented top-level fields', { content: JSON.stringify({ sdkVersion: 1, capabilities: [], name: 'Notes', version: '1' }) },
    'root has unsupported field(s) name, version'],
  ['an unknown field type', { content: JSON.stringify(TABLE([{ id: 'body', name: 'body', type: 'text' }])) },
    'data.tables[0].fields[0].type must be one of string, number, integer, boolean, json, timestamp'],
  ['an access list naming an undeclared field', { content: JSON.stringify(TABLE(BODY, { read: ['body', 'createdBy'], insert: ['body'] })) },
    'data: Unknown or duplicate access field'],
] as const)('names the cause of a manifest with %s and creates no artifact', async (_label, file, cause) => {
  const m = await loadMod();
  for (const appType of ['local', 'web'] as const) {
    const result = await m.createArtifact(UID, CID, AGENT, { appType, files: [...MIN_FILES, { path: 'orkas-app.json', ...file }] });
    expect(result.ok).toBe(false); if (result.ok) return;
    expect(result.error.startsWith(PREFIX)).toBe(true);
    expect(result.error).toContain(cause);
  }
  expect(fs.existsSync(cidDir()) ? fs.readdirSync(cidDir()) : []).toEqual([]);
});

it('bounds a rejection with many issues and never echoes non-identifier keys or rejected values', async () => {
  const m = await loadMod();
  const secret = '/Users/test/private notes ' + 'x'.repeat(400);
  const manifest = { sdkVersion: 2, capabilities: ['shell-' + secret, 'a', 'b', 'c'], data: 'tables', [secret]: 1, extra_field: true };
  const result = await m.createArtifact(UID, CID, AGENT, { files: [...MIN_FILES, { path: 'orkas-app.json', content: JSON.stringify(manifest) }] });
  expect(result.ok).toBe(false); if (result.ok) return;
  expect(result.error.startsWith(PREFIX)).toBe(true);
  // Invented members come first; repeated reasons share one entry.
  expect(result.error).toContain('root has unsupported field(s) extra_field, 1 other key(s)');
  expect(result.error).toContain('capabilities[0], capabilities[1], capabilities[2] (+1 more) must be one of');
  expect(result.error).toMatch(/\(\+1 more\)$/);
  expect(result.error).not.toContain('someone');
  expect(result.error).not.toContain('shell-');
  expect(result.error.length).toBeLessThanOrEqual(600);
  expect(fs.existsSync(cidDir()) ? fs.readdirSync(cidDir()) : []).toEqual([]);
});

it('names the local-only capabilities a web manifest declared', async () => {
  const m = await loadMod();
  const result = await m.createArtifact(UID, CID, AGENT, { appType: 'web', files: [...MIN_FILES,
    { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['data', 'storage', 'ai'], data: { version: 1, tables: [] } }) }] });
  expect(result).toEqual({ ok: false, error: 'web applications cannot use host interfaces: declared local-only capabilities storage, ai; web apps may declare only data' });
  expect(fs.existsSync(cidDir()) ? fs.readdirSync(cidDir()) : []).toEqual([]);
});


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
    const r = (await m.createArtifact(UID, CID, AGENT, {
      title: 'Sized',
      files: [{ path: 'index.html', content: '<!doctype html><html><head><title>a</title></head><body><button>go</button></body></html>' }],
    }));
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
    const r = (await m.createArtifact(UID, CID, AGENT, { title: 'Own bridge', files: [{ path: 'index.html', content: authored }] }));
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
    const r = (await m.createArtifact(UID, CID, AGENT, { title: 'Self sizing', files: [{ path: 'index.html', content: authored }] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readEntry(path.join(cidDir(), r.artifactId))).not.toContain(m.BRIDGE_RELPATH);
  });

  it('places the tag in a fragment that has no head or body', async () => {
    const m = await loadMod();
    const r = (await m.createArtifact(UID, CID, AGENT, {
      title: 'Fragment',
      files: [{ path: 'index.html', content: '<h1>hi</h1><button>go</button>' }],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const html = readEntry(path.join(cidDir(), r.artifactId));
    expect(html).toContain('<h1>hi</h1>');
    expect(html).toContain(m.BRIDGE_SCRIPT_TAG);
  });

  it('only touches the entry file', async () => {
    const m = await loadMod();
    const helper = 'export const value = 1;\n';
    const r = (await m.createArtifact(UID, CID, AGENT, {
      title: 'Multi',
      files: [
        { path: 'index.html', content: '<!doctype html><html><body><button>go</button></body></html>' },
        { path: 'app.js', content: helper },
      ],
    }));
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
    const r = (await m.createArtifact(UID, CID, AGENT, { title: 'Tip calc', files: MIN_FILES }));
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
    const r = (await m.createArtifact(UID, CID, AGENT, {
      title: 'Dash',
      files: [
        { path: 'index.html', content: '<!doctype html><script src="assets/app.js"></script>' },
        { path: 'assets/app.js', content: 'console.log(1)' },
        { path: 'style.css', content: 'body{margin:0}' },
      ],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const dir = path.join(cidDir(), r.artifactId);
    expect(fs.existsSync(path.join(dir, 'assets', 'app.js'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'style.css'))).toBe(true);
  });

  it('discards one failed candidate without removing sibling artifacts', async () => {
    const m = await loadMod();
    const first = (await m.createArtifact(UID, CID, AGENT, { title: 'First', files: MIN_FILES }));
    const second = (await m.createArtifact(UID, CID, AGENT, { title: 'Second', files: MIN_FILES }));
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
    const r = (await m.createArtifact(UID, CID, AGENT, {
      files: [
        { path: 'index.html', content: '<!doctype html><img src="logo.png">' },
        { path: 'logo.png', content: pngB64, encoding: 'base64' },
      ],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const buf = fs.readFileSync(path.join(cidDir(), r.artifactId, 'logo.png'));
    expect([...buf.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('rejects: no index.html', async () => {
    const m = await loadMod();
    const r = (await m.createArtifact(UID, CID, AGENT, { files: [{ path: 'main.html', content: 'x' }] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/index\.html/);
  });

  it('rejects: empty / non-array files', async () => {
    const m = await loadMod();
    expect(((await m.createArtifact(UID, CID, AGENT, { files: [] })) as { ok: boolean }).ok).toBe(false);
    expect(((await m.createArtifact(UID, CID, AGENT, { files: 'nope' as unknown as [] })) as { ok: boolean }).ok).toBe(false);
  });

  it('rejects: path traversal in a file path', async () => {
    const m = await loadMod();
    const r = (await m.createArtifact(UID, CID, AGENT, {
      files: [{ path: 'index.html', content: 'x' }, { path: '../escape.js', content: 'x' }],
    }));
    expect(r.ok).toBe(false);
  });

  it('rejects: absolute file path', async () => {
    const m = await loadMod();
    const r = (await m.createArtifact(UID, CID, AGENT, {
      files: [{ path: 'index.html', content: 'x' }, { path: '/etc/passwd', content: 'x' }],
    }));
    // leading slash is stripped → "etc/passwd" with no extension → unsupported ext
    expect(r.ok).toBe(false);
  });

  it('rejects: reserved __orkas-meta.json / __orkas/ paths', async () => {
    const m = await loadMod();
    expect(((await m.createArtifact(UID, CID, AGENT, { files: [{ path: 'index.html', content: 'x' }, { path: '__orkas-meta.json', content: '{}' }] })) as { ok: boolean }).ok).toBe(false);
    expect(((await m.createArtifact(UID, CID, AGENT, { files: [{ path: 'index.html', content: 'x' }, { path: '__orkas/bridge.js', content: 'x' }] })) as { ok: boolean }).ok).toBe(false);
  });

  it('rejects: disallowed extension', async () => {
    const m = await loadMod();
    const r = (await m.createArtifact(UID, CID, AGENT, {
      files: [{ path: 'index.html', content: 'x' }, { path: 'evil.exe', content: 'AA==', encoding: 'base64' }],
    }));
    expect(r.ok).toBe(false);
  });

  it('publishes a large multi-file app completely without blocking host progress', async () => {
    const m = await loadMod();
    const files = [{ path: 'index.html', content: '<h1>Large app</h1>' },
      ...Array.from({ length: 25 }, (_, i) => ({ path: `assets/f${i}.js`, content: String(i) + 'x'.repeat(300 * 1024) }))];
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    const r = await m.createArtifact(UID, CID, AGENT, { files });
    clearInterval(timer);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(r.error);
    expect(ticks).toBeGreaterThan(0);
    for (const file of files.slice(1)) {
      const served = m.resolveArtifactFilePath(UID, CID, r.artifactId, file.path);
      expect(served.ok).toBe(true);
      expect(fs.readFileSync(path.join(cidDir(), r.artifactId, file.path), 'utf8')).toBe(file.content);
    }
    expect(fs.readdirSync(cidDir())).toEqual([r.artifactId]);
  });

  it('cleans staged files on an incomplete write and allows a fresh creation', async () => {
    const m = await loadMod();
    // A file/directory collision happens after index.html has been staged.
    const failed = await m.createArtifact(UID, CID, AGENT, { files: [
      ...MIN_FILES, { path: 'asset.js', content: 'file' }, { path: 'asset.js/child.js', content: 'cannot write' },
    ] });
    expect(failed.ok).toBe(false);
    expect(fs.readdirSync(cidDir())).toEqual([]);
    const retry = await m.createArtifact(UID, CID, AGENT, { files: MIN_FILES });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(retry.error);
    expect(fs.readdirSync(cidDir())).toEqual([retry.artifactId]);
  });

  it('rejects: utf8-encoded content for a binary extension', async () => {
    const m = await loadMod();
    const r = (await m.createArtifact(UID, CID, AGENT, { files: [{ path: 'index.html', content: '<x>' }, { path: 'logo.png', content: 'not base64 binary' }] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/base64/);
  });

  it('rejects: duplicate file paths (case-insensitive)', async () => {
    const m = await loadMod();
    const r = (await m.createArtifact(UID, CID, AGENT, { files: [{ path: 'index.html', content: 'x' }, { path: 'Index.HTML', content: 'y' }] }));
    expect(r.ok).toBe(false);
  });
});

describe('chat_artifacts › resolveArtifactFilePath', () => {
  async function seed() {
    const m = await loadMod();
    const r = (await m.createArtifact(UID, CID, AGENT, {
      files: [
        { path: 'index.html', content: '<!doctype html><h1>hi</h1>' },
        { path: 'assets/app.js', content: 'console.log(2)' },
      ],
    }));
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
    expect((await m.createArtifact(UID, CID, AGENT, { files: MIN_FILES })).ok).toBe(true);
    expect((await m.createArtifact(UID, CID, AGENT, { files: MIN_FILES })).ok).toBe(true);
    expect(fs.existsSync(cidDir())).toBe(true);
    const n = await m.purgeByCid(UID, CID);
    expect(n).toBe(2);
    expect(fs.existsSync(cidDir())).toBe(false);
    // Idempotent.
    expect(await m.purgeByCid(UID, CID)).toBe(0);
  });
});

it('creates and serves the same media/model/font resources accepted by saved apps', async () => {
  const mod=await loadMod();
  const resources=[['sound.mp3','audio/mpeg'],['movie.mp4','video/mp4'],['scene.glb','model/gltf-binary'],['font.otf','font/otf'],['image.avif','image/avif']];
  const created=await mod.createArtifact(UID,CID,AGENT,{files:[...MIN_FILES,...resources.map(([name])=>({path:name,content:'AAE=',encoding:'base64'}))]});
  expect(created.ok).toBe(true);if(!created.ok)throw new Error(created.error);
  for(const [name,mime] of resources){
    const result=mod.resolveArtifactFilePath(UID,CID,created.artifactId,name);
    expect(result).toMatchObject({ok:true,mime});
    if(result.ok)expect(fs.readFileSync(result.absPath)).toEqual(Buffer.from([0,1]));
  }
});


describe('chat_artifacts › application type for bubble labels', () => {
  it.each(['local', 'web'] as const)('returns the actual %s bundle type during preview inspection', async appType => {
    const m = await loadMod();
    const created = await m.createArtifact(UID, CID, AGENT, { appType, files: MIN_FILES });
    if (!created.ok) throw new Error(created.error);
    expect(await m.inspectArtifactIndex(UID, CID, created.artifactId)).toEqual({ ok: true, status: 'ok', appType });
  });

  it('identifies a legacy bundle as local and does not label a missing preview', async () => {
    const m = await loadMod();
    const created = await m.createArtifact(UID, CID, AGENT, { files: MIN_FILES });
    if (!created.ok) throw new Error(created.error);
    const dir = path.join(cidDir(), created.artifactId);
    fs.writeFileSync(path.join(dir, '__orkas-meta.json'), JSON.stringify({ title: 'Legacy app' }));
    expect(await m.inspectArtifactIndex(UID, CID, created.artifactId)).toEqual({ ok: true, status: 'ok', appType: 'local' });
    fs.rmSync(path.join(dir, 'index.html'));
    const missing = await m.inspectArtifactIndex(UID, CID, created.artifactId);
    expect(missing).toMatchObject({ ok: true, status: 'unavailable' });
    expect(missing).not.toHaveProperty('appType');
  });
});

describe('chat_artifacts › application type input', () => {
  // Sync notification is loaded through CommonJS require and cannot be
  // intercepted here; it is sent only after the staged directory is renamed,
  // so an absent directory is the observable no-publication oracle.
  it('stores the legacy cloud alias as a web application with the web declaration', async () => {
    const m = await loadMod();
    const created = await m.createArtifact(UID, CID, AGENT, { appType: 'cloud', files: MIN_FILES });
    expect(created.ok).toBe(true); if (!created.ok) return;
    expect(m.readArtifactMeta(UID, CID, created.artifactId)?.appType).toBe('web');
    expect(JSON.parse(fs.readFileSync(path.join(cidDir(), created.artifactId, '__orkas-meta.json'), 'utf8')).appType).toBe('web');
  });

  it.each([['desktop'], ['Web'], [1], [{ type: 'web' }]])('rejects unknown type %j without creating an artifact', async appType => {
    const m = await loadMod();
    const result = await m.createArtifact(UID, CID, AGENT, { appType, files: MIN_FILES });
    expect(result).toEqual({ ok: false, error: 'app type must match the task or editing source' });
    expect(fs.existsSync(cidDir()) ? fs.readdirSync(cidDir()) : []).toEqual([]);
    expect(m.listArtifacts(UID, CID)).toEqual([]);
  });

  it('gives a web artifact without a declaration the empty data-only declaration and leaves its entry bytes unchanged', async () => {
    const m = await loadMod();
    const html = '<!doctype html><html><head><title>Web</title></head><body><p>Plain</p></body></html>';
    const created = await m.createArtifact(UID, CID, AGENT, { appType: 'web', files: [{ path: 'index.html', content: html }] });
    expect(created.ok).toBe(true); if (!created.ok) return;
    const dir = path.join(cidDir(), created.artifactId);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'orkas-app.json'), 'utf8'))).toEqual({ sdkVersion: 1, minimumClient: '1.9.0', capabilities: [] });
    expect(fs.readFileSync(path.join(dir, 'index.html'))).toEqual(Buffer.from(html, 'utf8'));
    // The local default keeps its auto-sizing bridge; only web skips it.
    const local = await m.createArtifact(UID, CID, AGENT, { files: [{ path: 'index.html', content: html }] });
    expect(local.ok).toBe(true); if (!local.ok) return;
    expect(fs.readFileSync(path.join(cidDir(), local.artifactId, 'index.html'), 'utf8')).toContain(m.BRIDGE_RELPATH);
    expect(fs.existsSync(path.join(cidDir(), local.artifactId, 'orkas-app.json'))).toBe(false);
  });
});
