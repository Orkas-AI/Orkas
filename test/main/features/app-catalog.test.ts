import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;
let previousBuiltin: string | undefined;
const uid = 'catalog-user';
function app(id: string, title: string, options: { builtin?: boolean; user?: string; entry?: boolean; description?: string } = {}) {
  const folder = options.builtin ? path.join(root, 'builtin/apps', id)
    : path.join(root, options.user || uid, 'cloud/saved_apps', id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '__orkas-meta.json'), JSON.stringify({
    title, description: options.description || 'Useful app', appType: 'local', entry: 'index.html',
    version: '1.0.0', sourceCid: 'private-conversation', sourcePathKey: '/private/source',
  }));
  if (options.entry !== false) fs.writeFileSync(path.join(folder, 'index.html'), '<h1>App</h1>');
  return folder;
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-catalog-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  previousBuiltin = process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  process.env.ORKAS_BUILTIN_ROOT = path.join(root, 'builtin');
  vi.resetModules();
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  if (previousBuiltin === undefined) delete process.env.ORKAS_BUILTIN_ROOT;
  else process.env.ORKAS_BUILTIN_ROOT = previousBuiltin;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const active = { isActive: () => true };

describe('account application catalog', () => {
  it('list_apps returns exact navigation arguments without staging or launching, and preserves failures as tool errors', async () => {
    app('budget-target', 'Budget');
    const { buildListAppsTool } = await import('../../../src/main/features/group_chat/app_catalog_tool');
    const tool = buildListAppsTool(uid, active);
    expect(tool.name).toBe('list_apps');
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false, properties: {
      limit: { minimum: 1, maximum: 50, default: 20 }, offset: { minimum: 0, default: 0 },
    } });
    const reply = await tool.execute({ source: 'custom' }, { signal: new AbortController().signal } as any);
    expect(reply.isError).not.toBe(true);
    expect(JSON.parse(reply.content)).toMatchObject({ apps: [{ id: 'budget-target', navigation: { target_id: 'budget-target', action: 'configure' } }] });
    expect(await tool.execute({ user_id: 'another-account' }, {} as any)).toMatchObject({ isError: true });
    const controller = new AbortController(); controller.abort();
    const cancelled = await tool.execute({}, { signal: controller.signal } as any);
    expect(cancelled.isError).toBe(true);
    expect(JSON.parse(cancelled.content)).toMatchObject({ ok: false, code: 'E_CLOSED' });
  });

  it('discovers first-use built-ins and saved apps with exact per-app navigation and no private storage details', async () => {
    app('builtin-test-content', 'Content', { builtin: true });
    app('custom-budget', 'Budget');
    app('other-account', 'Private', { user: 'second-user' });
    const { listAppCatalog } = await import('../../../src/main/features/app_catalog');
    const result = await listAppCatalog(uid, {}, active);
    expect(result).toMatchObject({ ok: true, total: 2, next_offset: null });
    if (!result.ok) throw new Error('Catalog unavailable');
    expect(result.apps.map(row => row.id).sort()).toEqual(['builtin-test-content', 'custom-budget']);
    for (const row of result.apps) {
      expect(row.available).toBe(true);
      expect(row.navigation).toEqual({ surface_id: 'apps', action: 'configure', target_id: row.id });
    }
    expect(result.apps.find(row => row.id === 'builtin-test-content')?.source).toBe('builtin');
    expect(result.apps.find(row => row.id === 'custom-budget')?.source).toBe('custom');
    expect(JSON.stringify(result)).not.toMatch(/private-conversation|private\/source|sourceCid|absPath/);
  });

  it('keeps same-title targets distinct and pages the selected source without omissions', async () => {
    app('builtin-test-content', 'Same', { builtin: true });
    app('budget-a', 'Same'); app('budget-b', 'Same');
    const { listAppCatalog } = await import('../../../src/main/features/app_catalog');
    const first = await listAppCatalog(uid, { source: 'custom', limit: 1 }, active);
    const second = await listAppCatalog(uid, { source: 'custom', limit: 1, offset: 1 }, active);
    expect(first).toMatchObject({ ok: true, total: 2, next_offset: 1 });
    expect(second).toMatchObject({ ok: true, total: 2, next_offset: null });
    if (!first.ok || !second.ok) throw new Error('Catalog unavailable');
    expect([...first.apps, ...second.apps].map(row => row.id).sort()).toEqual(['budget-a', 'budget-b']);
    expect(await listAppCatalog(uid, { source: 'builtin' }, active)).toMatchObject({ total: 1, apps: [{ id: 'builtin-test-content' }] });
    expect(await listAppCatalog(uid, { offset: 99 }, active)).toMatchObject({ ok: true, total: 3, apps: [], next_offset: null });
  });

  it('uses bounded default and maximum pages for a larger catalog and reloads localized built-in names', async () => {
    for (let i = 0; i < 55; i++) app('item-' + String(i).padStart(3, '0'), 'App ' + String(i).padStart(3, '0'));
    const folder = app('builtin-test-content', 'Content', { builtin: true });
    fs.writeFileSync(path.join(folder, '__orkas-meta.json'), JSON.stringify({ title: 'Content', titleKey: 'apps.builtin_content_title', version: '1.0.0', appType: 'local' }));
    const { listAppCatalog } = await import('../../../src/main/features/app_catalog');
    const standard = await listAppCatalog(uid, { source: 'custom' }, active);
    expect(standard).toMatchObject({ total: 55, limit: 20, next_offset: 20 });
    if (!standard.ok) throw new Error('Catalog unavailable');
    expect(standard.apps).toHaveLength(20);
    const max = await listAppCatalog(uid, { source: 'custom', limit: 50 }, active);
    expect(max).toMatchObject({ total: 55, next_offset: 50 });
    if (!max.ok) throw new Error('Catalog unavailable');
    expect(max.apps).toHaveLength(50);
    const tail = await listAppCatalog(uid, { source: 'custom', offset: 50, limit: 50 }, active);
    if (!tail.ok) throw new Error('Catalog unavailable');
    expect(new Set([...max.apps, ...tail.apps].map(row => row.id)).size).toBe(55);
    expect(tail.next_offset).toBeNull();
    const i18n = await import('../../../src/main/i18n');
    i18n.setCurrentLang('zh');
    expect(await listAppCatalog(uid, { source: 'builtin' }, active)).toMatchObject({ apps: [{ title: '内容工作台' }] });
    i18n.setCurrentLang('en');
    expect(await listAppCatalog(uid, { source: 'builtin' }, active)).toMatchObject({ apps: [{ title: 'Content workspace' }] });
  });

  it('does not reveal applications through saved-directory or entry symlinks', async () => {
    const secret = app('outside-account', 'Private', { user: 'second-user' });
    const folder = app('entry-link', 'Link');
    fs.unlinkSync(path.join(folder, 'index.html'));
    // Windows directory junctions need no developer-mode file-symlink grant.
    if (process.platform !== 'win32') fs.symlinkSync(path.join(secret, 'index.html'), path.join(folder, 'index.html'));
    fs.symlinkSync(secret, path.join(root, uid, 'cloud/saved_apps', 'directory-link'), process.platform === 'win32' ? 'junction' : 'dir');
    const { listAppCatalog } = await import('../../../src/main/features/app_catalog');
    expect(await listAppCatalog(uid, { source: 'custom' }, active)).toMatchObject({ total: 1, apps: [{ id: 'entry-link', available: false, navigation: null }] });
  });

  it('distinguishes an empty catalog from an unavailable entry and reflects deletion on the next read', async () => {
    const { listAppCatalog } = await import('../../../src/main/features/app_catalog');
    expect(await listAppCatalog(uid, {}, active)).toMatchObject({ ok: true, total: 0, apps: [] });
    const folder = app('missing-entry', 'Broken', { entry: false });
    expect(await listAppCatalog(uid, {}, active)).toMatchObject({ ok: true, total: 1, apps: [{ id: 'missing-entry', available: false, navigation: null }] });
    fs.rmSync(folder, { recursive: true });
    expect(await listAppCatalog(uid, {}, active)).toMatchObject({ ok: true, total: 0, apps: [] });
  });

  it.each([
    { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: '2' }, { limit: null },
    { offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { source: 'all-accounts' }, { user_id: 'second-user' }, { project_id: 'other-project' },
  ])('rejects invalid bounds or scope overrides before reading: %j', async input => {
    const builtin = await import('../../../src/main/features/builtin_apps');
    const sync = vi.spyOn(builtin, 'syncBuiltinApps');
    const { listAppCatalog } = await import('../../../src/main/features/app_catalog');
    expect(await listAppCatalog(uid, input, active)).toMatchObject({ ok: false, code: 'E_APP_CATALOG_INPUT' });
    expect(sync).not.toHaveBeenCalled();
  });

  it('does not disclose the previous account or keep installing after cancellation or an account change', async () => {
    const builtin = await import('../../../src/main/features/builtin_apps');
    let current = true;
    const sync = vi.spyOn(builtin, 'syncBuiltinApps').mockImplementation(async (_uid, keepGoing) => {
      current = false;
      expect(keepGoing?.()).toBe(false);
      return { changed: 0, deferred: 0 };
    });
    const { listAppCatalog } = await import('../../../src/main/features/app_catalog');
    expect(await listAppCatalog(uid, {}, { isActive: () => current })).toMatchObject({ ok: false, code: 'E_CLOSED' });
    sync.mockClear();
    const abort = new AbortController(); abort.abort();
    expect(await listAppCatalog(uid, {}, { isActive: () => true, signal: abort.signal })).toMatchObject({ ok: false, code: 'E_CLOSED' });
    expect(sync).not.toHaveBeenCalled();
  });

  it('returns the last installed apps when refresh fails, but does not turn an unreadable list into an empty success', async () => {
    app('builtin-test-content', 'Content', { builtin: true });
    const builtin = await import('../../../src/main/features/builtin_apps');
    await builtin.syncBuiltinApps(uid);
    vi.spyOn(builtin, 'syncBuiltinApps').mockRejectedValue(new Error('/private/provider-secret'));
    const { listAppCatalog } = await import('../../../src/main/features/app_catalog');
    expect(await listAppCatalog(uid, {}, active)).toMatchObject({ ok: true, builtin_refresh: 'deferred', apps: [{ id: 'builtin-test-content' }] });
    vi.spyOn(builtin, 'listBuiltinApps').mockImplementation(() => { throw new Error('/private/provider-secret'); });
    const failed = await listAppCatalog(uid, {}, active);
    expect(failed).toMatchObject({ ok: false, code: 'E_APP_CATALOG_UNAVAILABLE' });
    expect(JSON.stringify(failed)).not.toContain('/private/provider-secret');
    expect(failed).not.toHaveProperty('apps');
  });

  it('bounds metadata explicitly and does not let a reserved built-in identity resolve as a custom app', async () => {
    app('long-metadata', 'x'.repeat(5000), { description: 'y'.repeat(5000) });
    app('builtin-test-content', 'Shadow');
    app('builtin-test-content', 'Content', { builtin: true });
    const { listAppCatalog } = await import('../../../src/main/features/app_catalog');
    const result = await listAppCatalog(uid, { limit: 50 }, active);
    if (!result.ok) throw new Error('Catalog unavailable');
    expect(result.total).toBe(2);
    expect(result.apps.filter(row => row.id === 'builtin-test-content')).toMatchObject([{ source: 'builtin', title: 'Content' }]);
    const long = result.apps.find(row => row.id === 'long-metadata')!;
    expect(long.title.length).toBe(160);
    expect(long.truncated_fields).toContain('title');
    expect(long.description.length).toBeLessThanOrEqual(240);
    expect(JSON.stringify(result).length).toBeLessThan(2000);
  });
});
