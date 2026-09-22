import path from 'node:path';
import { cpSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createPackageWithOptions } from '@electron/asar';
import { expect, test, OrkasTestApp } from './fixtures/orkas';

const pcRoot = path.resolve(__dirname, '../..');
let previousKeepLogs: string | undefined;
test.beforeEach(() => {
  previousKeepLogs = process.env.ORKAS_E2E_KEEP_LOGS;
  process.env.ORKAS_E2E_KEEP_LOGS = '1';
});
test.afterEach(async ({}, info) => {
  if (previousKeepLogs === undefined) delete process.env.ORKAS_E2E_KEEP_LOGS;
  else process.env.ORKAS_E2E_KEEP_LOGS = previousKeepLogs;
  const file = info.outputPath('electron-main.log');
  expect(existsSync(file), 'Retain all main, renderer and cleanup logs on success too').toBe(true);
});

test('shows preparation before full results, searches partial history, and resumes after a real Electron restart', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const app = new OrkasTestApp(testInfo, { configuredModel: false });
  try {
    await app.launch();
    await app.invoke('config.setLanguage', { language: 'zh' });
    await app.page!.evaluate(() => (window as any).setLang('zh'));
    const created = await app.invoke<{ conversation: { conversation_id: string } }>('conversations.create', {
      title: 'Search recovery fixture',
    });
    const cid = created.conversation.conversation_id;
    const prefix = await app.electronApp!.evaluate(async (_electron, input) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const ix = require(`${input.root}/src/main/features/search/indexer.ts`);
      const boot = require(`${input.root}/src/main/util/boot_init.ts`);
      boot.configureBootAdmission({ isRuntimeBusy: () => true });
      await ix.flushAll();
      const uid = require(`${input.root}/src/main/features/users.ts`).getActiveUserId();
      const paths = require(`${input.root}/src/main/paths.ts`);
      const layout = require(`${input.root}/src/main/util/project-layout.ts`);
      const fs = require('node:fs');
      const file = layout.conversationMessageReadFile(uid, input.cid);
      fs.writeFileSync(file, Array.from({ length: 70 }, (_, i) => JSON.stringify({
        role: 'user', content: i === 69 ? 'suffixmarker' : `prefixmarker row${i}`, time: '2026-09-20T00:00:00Z',
      })).join('\n') + '\n');
      const store = require(`${input.root}/src/main/features/search/chat_store.ts`);
      store.docCount(uid);
      const Database = require(`${input.root}/node_modules/better-sqlite3`);
      const db = new Database(store.chatStorePath(uid));
      db.exec("DELETE FROM chat_meta WHERE key IN ('migration_complete', 'source_stamp')");
      db.close();
      fs.writeFileSync(paths.userChatsIndexPath(uid), '{}');
      ix.invalidateChatsIndex(uid);
      const { ChatRebuildWorker } = require(`${input.root}/src/main/features/search/chat-rebuild.ts`);
      const original = ChatRebuildWorker.prototype.rebuildBatch;
      const controller = new AbortController();
      ChatRebuildWorker.prototype.rebuildBatch = async function(file: unknown) {
        const batch = await original.call(this, file);
        controller.abort();
        return batch;
      };
      try { await ix.reconcileChatsIndex(uid, controller.signal); }
      finally { ChatRebuildWorker.prototype.rebuildBatch = original; }
      return { count: store.docCount(uid), next: store.readRebuildCursor(uid, input.cid)?.next,
        id: store.postingsFor(uid, 'row0')[0]?.doc, legacy: fs.existsSync(paths.userChatsIndexPath(uid)) };
    }, { root: pcRoot, cid });
    expect(prefix).toMatchObject({ count: 16, next: 16, legacy: true });
    expect(prefix.id).toBeGreaterThan(0);
    expect(await app.invoke('search.status')).toMatchObject({ ok: true, chat_index_complete: false });
    expect(await app.invoke('search.global', { query: 'suffixmarker', scope: 'chat' }))
      .toMatchObject({ ok: true, chat_index_complete: false, results: [] });

    let page = app.page!;
    // Hold only delivery of the real global request. Status uses the actual
    // renderer shim/preload/IPC handler; no search or status response is faked.
    await page.evaluate(() => {
      const app = window as any;
      const original = app.apiFetch;
      app.__searchRelease = null;
      const gate = new Promise<void>(resolve => { app.__searchRelease = resolve; });
      app.apiFetch = async (url: string, options: unknown) => {
        if (url === '/api/search/global') await gate;
        return original(url, options);
      };
    });
    await page.locator('#sidebar-search-btn').click();
    const notice = page.locator('#search-body .is-status');
    const copy = '正在准备中，结果暂不完整，请稍后重试。';
    await expect(notice).toHaveText(copy);
    await page.locator('#search-input').fill('prefixmarker');
    const loading = page.locator('#search-body .search-loading');
    await expect(loading).toHaveText('加载中…');
    await expect(loading.locator('.search-loading-spinner')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('search-loading.png') });
    await expect(notice).toHaveText(copy);
    await expect(page.locator('#search-body .search-result')).toHaveCount(0);
    await page.evaluate(() => (window as any).__searchRelease());
    await expect(page.locator('#search-body .search-result').first()).toBeVisible();
    await expect(notice).toHaveText(copy);
    await expect(loading).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('partial-search.png') });
    await page.locator('#search-close-btn').click();

    page = await app.relaunch();
    // Startup owns resumption; no manual repair invocation after relaunch.
    // Low-memory hosts start the deferred phase after 6s, then admit disk
    // work after another 30s. Allow that documented boot budget, not a query
    // repair that would hide a broken startup continuation.
    await expect.poll(async () => app.invoke('search.status'), { timeout: 60_000 })
      .toMatchObject({ ok: true, chat_index_complete: true });
    const resumed = await app.electronApp!.evaluate((_electron, root) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const uid = require(`${root}/src/main/features/users.ts`).getActiveUserId();
      const store = require(`${root}/src/main/features/search/chat_store.ts`);
      return { count: store.docCount(uid), prefixId: store.postingsFor(uid, 'row0')[0]?.doc,
        legacy: require('node:fs').existsSync(require(`${root}/src/main/paths.ts`).userChatsIndexPath(uid)) };
    }, pcRoot);
    expect(resumed).toEqual({ count: 70, prefixId: prefix.id, legacy: false });
    await page.locator('#sidebar-search-btn').click();
    await page.locator('#search-input').fill('suffixmarker');
    await expect(page.locator('#search-body .search-result').first()).toBeVisible();
    await expect(page.locator('#search-body [role="status"]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('complete-search.png') });
    expect(app.modelRequests).toHaveLength(0);
  } finally { await app.dispose(); }
});

test('runs rebuild and snippet workers from an ASAR with the shipped dependency layout', async ({}, testInfo) => {
  const app = new OrkasTestApp(testInfo, { configuredModel: false });
  try {
    const source = path.join(app.root, 'package-source');
    const archive = path.join(app.root, 'fixture.asar');
    const pkg = JSON.parse(readFileSync(path.join(pcRoot, 'package.json'), 'utf8'));
    mkdirSync(source, { recursive: true });
    cpSync(path.join(pcRoot, 'src/main'), path.join(source, 'src/main'), { recursive: true });
    cpSync(path.join(pcRoot, 'package.json'), path.join(source, 'package.json'));
    cpSync(path.join(pcRoot, 'tsconfig.json'), path.join(source, 'tsconfig.json'));
    const dependencies = ['tsx', 'get-tsconfig', 'resolve-pkg-maps', 'esbuild',
      `@esbuild/${process.platform}-${process.arch}`, 'better-sqlite3', 'bindings',
      'file-uri-to-path', 'electron-log', 'async-mutex', 'tslib'];
    for (const name of dependencies) {
      cpSync(path.join(pcRoot, 'node_modules', name), path.join(source, 'node_modules', name),
        { recursive: true, dereference: true });
    }
    // Use the actual packaging rules, not a test-only unpack-all workaround.
    // asar matches absolute filenames; electron-builder's patterns are relative.
    const unpack = pkg.build.asarUnpack.map((pattern: string) => path.join(source, pattern).replaceAll('\\', '/'));
    await createPackageWithOptions(source, archive, { unpack: `{${unpack.join(',')}}` });
    const esbuild = path.join(`${archive}.unpacked`, 'node_modules', '@esbuild',
      `${process.platform}-${process.arch}`, ...(process.platform === 'win32' ? ['esbuild.exe'] : ['bin', 'esbuild']));
    expect(existsSync(esbuild)).toBe(true);
    await app.launch();
    const result = await app.electronApp!.evaluate(async (_electron, input) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const old = process.env.ESBUILD_BINARY_PATH;
      process.env.ESBUILD_BINARY_PATH = input.esbuild;
      const { ChatRebuildWorker } = require(`${input.archive}/src/main/features/search/chat-rebuild.ts`);
      // The host already has its reader/logger loaded. Only the new worker
      // executes the packaged copy; loading a second main logger registers
      // duplicate Electron IPC handlers and is not a real packaging path.
      const store = require(`${input.sourceRoot}/src/main/features/search/chat_store.ts`);
      const paths = require(`${input.sourceRoot}/src/main/paths.ts`);
      const fs = require('node:fs');
      const file = require('node:path').join(paths.userChatsDir('packaged-fixture'), 'source.jsonl');
      fs.mkdirSync(require('node:path').dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ role: 'user', content: 'packagedmarker', time: 't' }) + '\n');
      const stat = fs.statSync(file);
      store.docCount('packaged-fixture');
      const worker = new ChatRebuildWorker('packaged-fixture');
      const { Worker } = require('node:worker_threads');
      let snippetWorker: import('node:worker_threads').Worker | undefined;
      try {
        const batch = await worker.rebuildBatch({ file, fileKey: 'source', mtime: stat.mtimeMs, size: stat.size });
        snippetWorker = new Worker(`${input.archive}/src/main/features/search/chat-snippet-entry.js`, {
          execArgv: [], env: { ...process.env },
        });
        const snippet = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Packaged snippet worker did not respond')), 10_000);
          snippetWorker.once('error', (error: Error) => { clearTimeout(timeout); reject(error); });
          snippetWorker.once('message', (message: any) => { clearTimeout(timeout); resolve(message.rows[0]?.[1]?.snippet); });
          snippetWorker.postMessage({ id: 1, file, indexes: [0], tokens: ['packagedmarker'] });
        });
        return { complete: batch.complete, count: store.docCount('packaged-fixture'),
          matches: store.postingsFor('packaged-fixture', 'packagedmarker').length, snippet };
      } finally {
        await snippetWorker?.terminate();
        await worker.close();
        store.closeAllChatStores();
        if (old === undefined) delete process.env.ESBUILD_BINARY_PATH;
        else process.env.ESBUILD_BINARY_PATH = old;
      }
    }, { archive, esbuild, sourceRoot: pcRoot });
    expect(result).toEqual({ complete: true, count: 1, matches: 1, snippet: 'packagedmarker' });
  } finally { await app.dispose(); }
});
