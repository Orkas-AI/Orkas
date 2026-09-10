import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';

const postJson = vi.hoisted(() => vi.fn());
const warnings = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/features/marketplace', async () => ({
  postJson,
  extractBundleSafely: (await import('../../../src/main/features/marketplace_bundle')).extractBundleSafely,
}));
vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: warnings, error: (...args: unknown[]) => { throw new Error(`Unexpected error log: ${args[0]}`); } }),
}));
vi.mock('electron', () => ({ app: { getVersion: () => '1.7.0' } }));

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-marketplace-urls-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  postJson.mockReset();
  warnings.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe.each(['agent', 'skill'] as const)('marketplace %s download address recovery', (kind) => {
  const plural = kind === 'agent' ? 'agents' : 'skills';
  const urlKey = kind === 'agent' ? 'agent_json_url' : 'bundle_url';
  const file = kind === 'agent' ? 'agent.json' : 'SKILL.md';
  const id = 'ab1234567890';
  const freshUrl = `https://marketplace.example.test/${id}/content`;
  const oldUrl = `https://marketplace.example.test/${id}/old`;
  const detailPath = `/marketplace/${plural}/${kind === 'agent' ? 'detail' : 'bundle'}`;

  async function setup(url: string, localVersion = '1.0.0') {
    const installs = await import('../../../src/main/features/marketplace_installs');
    const reconcile = await import('../../../src/main/features/marketplace_reconcile');
    const dir = path.join(root, 'u1', 'local', 'marketplace', plural, id);
    fs.mkdirSync(dir, { recursive: true });
    const localContent = kind === 'agent'
      ? JSON.stringify({ agent_id: id, name: 'Installed version' })
      : '---\nname: installed-version\n---\n';
    fs.writeFileSync(path.join(dir, file), localContent);
    fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify({
      version: localVersion, published_at: 100, installed_at: 100,
      seed_source: 'builtin', [urlKey]: url,
    }));
    const row = {
      id, version: '1.0.0', published_at: 100, installed_at: 100,
      seed_source: 'builtin', [urlKey]: url,
    };
    await installs.writeInstalls('u1', { version: 1, agents: [], skills: [], [plural]: [row] } as any);
    const content = kind === 'agent'
      ? Buffer.from(JSON.stringify({ agent_id: id, name: 'Updated version' }))
      : (() => {
        const zip = new AdmZip();
        zip.addFile('SKILL.md', Buffer.from('---\nname: updated-version\n---\n'));
        return zip.toBuffer();
      })();
    const fresh = { version: '2.0.0', published_at: 200, [urlKey]: freshUrl, create_uid: '0' };
    postJson.mockImplementation(async (endpoint: string) => {
      if (endpoint === `/marketplace/${plural}/list`) return { list: [{ id, version: '2.0.0', published_at: 200 }], total: 1 };
      if (endpoint === detailPath) return fresh;
      throw new Error('Unexpected marketplace endpoint');
    });
    const download = vi.fn(async (url: unknown) => {
      if (url === oldUrl) return new Response('not found', { status: 404 });
      if (url !== freshUrl) throw new TypeError('Invalid fixture download URL');
      return new Response(new Uint8Array(content));
    });
    vi.stubGlobal('fetch', download);
    await reconcile.checkServerUpdatesForInstalls('u1');
    postJson.mockClear();
    const beforeManifest = await installs.readInstalls('u1');
    const beforeMeta = fs.readFileSync(path.join(dir, '_install.json'), 'utf8');
    return { installs, reconcile, dir, localContent, beforeManifest, beforeMeta, fresh, download };
  }

  async function expectUpdated(ctx: Awaited<ReturnType<typeof setup>>) {
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ [`pulled_${plural}`]: 1, failed: [] });
    const rows = (await ctx.installs.readInstalls('u1'))[plural];
    expect(rows[0]).toMatchObject({ version: '2.0.0', [urlKey]: freshUrl });
    expect(JSON.parse(fs.readFileSync(path.join(ctx.dir, '_install.json'), 'utf8'))).toMatchObject({ version: '2.0.0', [urlKey]: freshUrl });
    expect(fs.readFileSync(path.join(ctx.dir, file), 'utf8')).toContain(kind === 'agent' ? 'Updated version' : 'updated-version');
  }

  it.each(['', 'not-a-url', 'file:///fixture'])('upgrades a builtin with unresolved address %j through detail lookup', async (url) => {
    const ctx = await setup(url);
    await expectUpdated(ctx);
    expect(postJson).toHaveBeenCalledExactlyOnceWith(detailPath, { id });
    expect(ctx.download).toHaveBeenCalledTimes(1);
    expect(ctx.download.mock.calls[0][0]).toBe(freshUrl);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('keeps a valid direct download free of additional detail requests', async () => {
    const ctx = await setup(freshUrl);
    await expectUpdated(ctx);
    expect(postJson).not.toHaveBeenCalled();
    expect(ctx.download).toHaveBeenCalledTimes(1);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('still refreshes a stale 404 address once', async () => {
    const ctx = await setup(oldUrl);
    await expectUpdated(ctx);
    expect(postJson).toHaveBeenCalledExactlyOnceWith(detailPath, { id });
    expect(ctx.download.mock.calls.map(call => call[0])).toEqual([oldUrl, freshUrl]);
    expect(warnings).not.toHaveBeenCalled();
  });

  it.each(['detail failure', 'invalid address', 'older version', 'incompatible version', 'download failure', 'corrupt content'] as const)(
    'preserves the old install on %s and completes a later retry', async (failure) => {
      const ctx = await setup('');
      if (failure === 'detail failure') postJson.mockRejectedValueOnce(new Error('Fixture detail unavailable'));
      if (failure === 'invalid address') postJson.mockResolvedValueOnce({ ...ctx.fresh, [urlKey]: '' });
      if (failure === 'older version') postJson.mockResolvedValueOnce({ ...ctx.fresh, version: '1.5.0' });
      if (failure === 'incompatible version') postJson.mockResolvedValueOnce({ ...ctx.fresh, min_app_version: '99.0.0' });
      if (failure === 'download failure') ctx.download.mockResolvedValueOnce(new Response('denied', { status: 403 }));
      if (failure === 'corrupt content') ctx.download.mockResolvedValueOnce(new Response('invalid content'));

      expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ [`pulled_${plural}`]: 0, failed: [`${kind}:${id}`] });
      expect(await ctx.installs.readInstalls('u1')).toEqual(ctx.beforeManifest);
      expect(fs.readFileSync(path.join(ctx.dir, '_install.json'), 'utf8')).toBe(ctx.beforeMeta);
      expect(fs.readFileSync(path.join(ctx.dir, file), 'utf8')).toBe(ctx.localContent);
      expect(postJson).toHaveBeenCalledExactlyOnceWith(detailPath, { id });
      expect(warnings).toHaveBeenCalledTimes(1);
      expect(warnings.mock.calls[0][0]).toContain(`${kind} ${id} pull failed:`);
      if (['detail failure', 'invalid address', 'older version'].includes(failure)) expect(ctx.download).not.toHaveBeenCalled();
      warnings.mockClear();
      await expectUpdated(ctx);
      expect(warnings).not.toHaveBeenCalled();
    },
  );

  it('does not download or change installation state if the account changes during detail lookup', async () => {
    const ctx = await setup('');
    let active = true;
    postJson.mockImplementationOnce(async () => { active = false; return ctx.fresh; });
    expect(await ctx.reconcile.reconcileInstalls('u1', { shouldContinue: () => active })).toMatchObject({ [`pulled_${plural}`]: 0, failed: [] });
    expect(ctx.download).not.toHaveBeenCalled();
    expect(await ctx.installs.readInstalls('u1')).toEqual(ctx.beforeManifest);
    expect(fs.readFileSync(path.join(ctx.dir, '_install.json'), 'utf8')).toBe(ctx.beforeMeta);
    expect(fs.readFileSync(path.join(ctx.dir, file), 'utf8')).toBe(ctx.localContent);
    expect(warnings).not.toHaveBeenCalled();
  });

  it('keeps a newer packaged builtin without resolving or downloading older content', async () => {
    const ctx = await setup('', '3.0.0');
    expect(await ctx.reconcile.reconcileInstalls('u1')).toMatchObject({ [`pulled_${plural}`]: 0, failed: [] });
    expect(postJson).not.toHaveBeenCalled();
    expect(ctx.download).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(ctx.dir, file), 'utf8')).toBe(ctx.localContent);
    expect(fs.readFileSync(path.join(ctx.dir, '_install.json'), 'utf8')).toBe(ctx.beforeMeta);
    expect(warnings).not.toHaveBeenCalled();
  });
});
