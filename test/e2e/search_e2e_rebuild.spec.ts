import { finished } from 'node:stream/promises';
import type { Locator } from '@playwright/test';
import path from 'node:path';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createPackageWithOptions } from '@electron/asar';
import { expect, test, OrkasTestApp } from './fixtures/orkas';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';
import { formatProcessLogSummary } from '../../scripts/model-eval-log-policy.mjs';
import { installEmptyLibrarySearch } from './fixtures/empty-library-search';
import { checkLatencyBudget, FIRST_REQUEST_LATENCY_LIMIT_MS } from '../helpers/latency-budget';

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
  const raw = readFileSync(file, 'utf8');
  let debuggerDisconnects = 0;
  const classified = raw.split(/\r?\n/).map(line => {
    // dispose() has already verified process exit. This exact Playwright
    // debugger lifecycle line is not an application error; raw logs stay intact.
    if (line === '[main:stderr] Waiting for the debugger to disconnect...') {
      debuggerDisconnects++;
      return '[main:stdout] [playwright-debugger] disconnect';
    }
    // Explicit fixture events are stdout, not continuations of preceding stderr.
    if (line.startsWith('[fixture-cleanup] ')) return `[main:stdout] ${line}`;
    return line;
  }).join('\n');
  const analysis = { ...analyzeWebAppLogs(classified), phase: 'search-rebuild', debuggerDisconnects };
  writeFileSync(info.outputPath('log-analysis.json'), JSON.stringify(analysis, null, 2));
  expect(analysis.passed, 'Review log-analysis.json for errors or incomplete coverage').toBe(true);
  if (analysis.requiresReview) console.info(formatProcessLogSummary(analysis));
});

test('searches automations and to-dos in distinct categories and reveals their current entries', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false, seedLanguage: 'zh' });
  try {
    await app.launch();
    await installEmptyLibrarySearch(app, pcRoot);
    const page = app.page!;
    const { project } = await app.invoke<any>('projects.create', { name: 'Search project' });
    const { task: todo } = await app.invoke<any>('projects.tasks.create', {
      projectId: project.project_id, content: 'Polaris 待办检查清单',
    });
    const { task: automation } = await app.invoke<any>('autoTasks.create', {
      title: 'Polaris 自动化报告', content: 'Prepare weekly summary', enabled: false,
      project_id: project.project_id, schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(todo?.id).toBeTruthy();
    expect(automation?.id).toBeTruthy();
    await page.locator('#sidebar-search-btn').click();
    await page.locator('#search-input').fill('Polaris');
    await expect(page.locator('#search-submit-hint')).toHaveText('按 Enter 开始搜索');
    await page.locator('#search-input').dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    // Prove there is no delayed auto-search or IME confirmation submission.
    await page.waitForTimeout(300);
    await expect(page.locator('#search-body .search-result')).toHaveCount(0);
    expect(await app.electronApp!.evaluate(() => (globalThis as any).__emptyLibrarySearchQueries)).toBe(0);
    await page.screenshot({ path: info.outputPath('search-zh-draft.png') });
    await page.locator('#search-input').press('Enter');
    const results = page.locator('#search-body .search-result');
    await expect(results).toHaveCount(2);
    await expect(page.locator('#search-submit-hint')).toHaveText('按 Enter 开始搜索');
    await expect(results.locator('.search-result-kind')).toHaveText(['待办', '自动化']);
    await expect(results.locator('.search-result-project')).toHaveText(['Search project', 'Search project']);
    await page.screenshot({ path: info.outputPath('search-zh-populated.png') });
    await page.locator('.search-tab[data-tab="automation"]').click();
    await expect(results).toHaveCount(1);
    await app.invoke('autoTasks.update', { taskId: automation.id, updates: { title: 'Polaris 更新后的自动化' } });
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-overlay')).toBeVisible();
    await expect(results).toHaveCount(1);
    await expect(results).toContainText('Polaris 更新后的自动化');
    await expect(page.locator('#search-submit-hint')).toHaveText('按 Enter 开始搜索');
    await results.click();
    await expect(page.locator('#search-overlay')).toBeHidden();
    await expect(page.locator(`.auto-row[data-task-id="${automation.id}"].is-highlighted`)).toBeVisible();
    await page.locator('#sidebar-search-btn').click();
    await page.locator('#search-input').fill('Polaris');
    await page.locator('#search-input').press('Enter');
    await expect(results).toHaveCount(2);
    await page.locator('.search-tab[data-tab="todo"]').click();
    await expect(results).toHaveCount(1);
    await results.click();
    await expect(page.locator(`.project-todo-item[data-tid="${todo.id}"].is-highlighted`)).toBeVisible();
    await page.evaluate(() => { (window as any).setLang('en'); });
    await expect(page.locator('#todos-btn')).toHaveText('To-do');
    await page.setViewportSize({ width: 900, height: 640 });
    await app.invoke('projects.tasks.update', {
      projectId: project.project_id, taskId: todo.id,
      content: 'Polaris ' + 'long checklist content '.repeat(20),
    });
    await page.locator('#sidebar-search-btn').click();
    await page.locator('#search-input').fill('Polaris');
    await page.locator('#search-input').press('Enter');
    await expect(results).toHaveCount(2);
    await expect(results.locator('.search-result-kind')).toHaveText(['To-do', 'Automation']);
    await page.screenshot({ path: info.outputPath('search-en-narrow.png') });
    await page.locator('.search-tab[data-tab="todo"]').click();
    await page.locator('#search-input').fill('No matching record');
    await expect(page.locator('#search-submit-hint')).toHaveText('Press Enter to search');
    await page.locator('#search-input').press('Enter');
    await expect(results).toHaveCount(0);
    await expect(page.locator('#search-body')).toContainText('No results');
    await page.screenshot({ path: info.outputPath('search-en-empty.png') });
    await page.locator('#search-input').press('Escape');
    await expect(page.locator('#search-overlay')).toBeHidden();
  } finally {
    await app.dispose();
  }
});

test('keeps cleaned conversations out of search previews, enrichment and restart while permitting recycle restore', async ({}, info) => {
  test.setTimeout(90_000);
  const app = new OrkasTestApp(info, { configuredModel: false, seedLanguage: 'zh' });
  const titles = ['电商领域已清理', '电商领域保留'];
  try {
    await app.launch();
    await installEmptyLibrarySearch(app, pcRoot);
    const cids: string[] = [];
    for (const title of titles) cids.push((await app.invoke<any>('conversations.create', { title })).conversation.conversation_id);
    const chatRoot = path.join(app.workspaceRoot, 'account-e2e', 'cloud', 'chats');
    const indexFile = path.join(chatRoot, '_index.json');
    const rows = JSON.parse(readFileSync(indexFile, 'utf8'));
    const old = '2020-01-01T00:00:00Z';
    for (const row of rows) {
      row.created_at = row.updated_at = old;
      writeFileSync(path.join(chatRoot, row.conversation_id, 'meta.json'), JSON.stringify(row));
      writeFileSync(path.join(chatRoot, `${row.conversation_id}.jsonl`), JSON.stringify({ from: 'user', text: row.title, ts: old }) + '\n');
    }
    writeFileSync(indexFile, JSON.stringify(rows));
    await app.electronApp!.evaluate(async (_, root) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      req(`${root}/src/main/features/chats.ts`).invalidateConversationCaches('account-e2e');
      await req(`${root}/src/main/features/search/indexer.ts`).reconcileChatsIndex('account-e2e');
    }, pcRoot);
    const before = await app.invoke<any>('search.global', { query: '电商领域', scope: 'chat' });
    expect(before.results.map((row: any) => row.cid).sort()).toEqual([...cids].sort());
    const preview = await app.invoke<any>('conversations.cleanup.preview', { expectedUserId: 'account-e2e', days: 90, protectedIds: [] });
    expect(preview.rows.map((row: any) => row.cid)).toContain(cids[0]);
    expect(await app.invoke('conversations.cleanup.remove', { expectedUserId: 'account-e2e', token: preview.token, cid: cids[0] }))
      .toMatchObject({ ok: true, status: 'deleted' });
    expect(existsSync(path.join(chatRoot, `${cids[0]}.jsonl`))).toBe(false);
    expect(JSON.parse(readFileSync(indexFile, 'utf8')).find((row: any) => row.conversation_id === cids[0]).deleted_at).toBeTruthy();
    // Recreate the exact stale committed state observed during a delayed index
    // repair / late sync payload, without replacing any search or cleanup reply.
    writeFileSync(path.join(chatRoot, `${cids[0]}.jsonl`), JSON.stringify({ from: 'user', text: titles[0], ts: old }) + '\n');
    await app.electronApp!.evaluate((_, input) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      req(`${input.root}/src/main/features/search/chat_store.ts`).replaceConversation('account-e2e', input.cid,
        [{ cid: input.cid, msgIndex: 0, role: 'user', time: '', text: input.title }], { mtime: 1, size: 1, next: 1 });
    }, { root: pcRoot, cid: cids[0], title: titles[0] });
    for (const includeChatSnippets of [false, true]) {
      expect((await app.invoke<any>('search.global', { query: '电商领域', scope: 'chat', includeChatSnippets })).results.map((row: any) => row.cid))
        .toEqual([cids[1]]);
    }
    const checkUI = async () => {
      const page = app.page!;
      await page.locator('#sidebar-search-btn').click();
      await page.locator('#search-input').fill('电商领域');
      await page.locator('#search-input').press('Enter');
      for (const scope of ['all', 'chat']) {
        await page.locator(`.search-tab[data-tab="${scope}"]`).click();
        await expect(page.locator('#search-body .search-result-title')).toHaveText([titles[1]]);
      }
      await expect(page.locator('#search-body .search-result-snippet')).toContainText(titles[1]);
    };
    await checkUI();
    await app.page!.screenshot({ path: info.outputPath('search-cleaned-zh.png') });
    await app.relaunch();
    await installEmptyLibrarySearch(app, pcRoot);
    await checkUI();
    await app.page!.locator('#search-input').press('Escape');
    const { batches } = await app.invoke<any>('recycle.list');
    expect(batches).toHaveLength(1);
    // The late payload already exists: normal recycle collision policy skips
    // that file and retains the batch with its expected partial-restore warning.
    expect(await app.invoke('recycle.restore', { id: batches[0].id })).toMatchObject({ ok: true, failed: 0, skipped: 1, reactivated: 1 });
    await app.electronApp!.evaluate(async (_, root) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      await req(`${root}/src/main/features/search/indexer.ts`).reconcileChatsIndex('account-e2e');
    }, pcRoot);
    expect((await app.invoke<any>('search.global', { query: '电商领域', scope: 'chat' })).results.map((row: any) => row.cid).sort())
      .toEqual([...cids].sort());
  } finally { await app.dispose(); }
});

test('deletes legacy project payloads through real cleanup and keeps them gone after restart with recoverable backups', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false, seedLanguage: 'zh' });
  try {
    await app.launch(); await installEmptyLibrarySearch(app, pcRoot);
    const pid = (await app.invoke<any>('projects.create', { name: 'Legacy deletion regression' })).project.project_id;
    const cids: string[] = [];
    for (const title of ['电商领域旧任务一', '电商领域旧任务二']) cids.push((await app.invoke<any>('conversations.create', { title, projectId: pid })).conversation.conversation_id);
    const retained = (await app.invoke<any>('conversations.create', { title: '电商领域保留任务' })).conversation.conversation_id;
    const legacyFiles = await app.electronApp!.evaluate(async (_, input) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const fs = req('node:fs'), path = req('node:path');
      const paths = req(`${input.root}/src/main/paths.ts`);
      const indexer = req(`${input.root}/src/main/features/search/indexer.ts`);
      await indexer.flushAll();
      const globalRoot = paths.userChatsDir('account-e2e');
      const files: string[] = [];
      for (const [index, cid] of input.cids.entries()) {
        const canonical = paths.projectChatJsonlFile('account-e2e', input.pid, cid);
        const body = JSON.stringify({ role: 'user', content: '电商领域清理回归', time: '2026-05-23T12:26:00' }) + '\n';
        fs.writeFileSync(canonical, body);
        const legacy = path.join(globalRoot, `${cid}.jsonl`);
        fs.writeFileSync(legacy, body); files.push(legacy);
        const group = path.join(globalRoot, cid);
        fs.cpSync(paths.projectGroupChatDir('account-e2e', input.pid, cid), group, { recursive: true }); files.push(group);
        const attachments = paths.chatAttachmentDir('account-e2e', cid);
        fs.mkdirSync(attachments, { recursive: true }); fs.writeFileSync(path.join(attachments, 'draft.txt'), 'legacy attachment'); files.push(attachments);
        const context = path.join(paths.userSessionsDir('account-e2e'), `gconv-${cid}.jsonl.context.json`);
        fs.mkdirSync(path.dirname(context), { recursive: true }); fs.writeFileSync(context, '{}'); files.push(context);
        if (index === 0) fs.unlinkSync(canonical); // legacy-only and duplicated layouts
      }
      fs.writeFileSync(path.join(globalRoot, `${input.retained}.jsonl`), JSON.stringify({ role: 'user', content: '电商领域保留', time: '2026-05-23T12:26:00' }) + '\n');
      req(`${input.root}/src/main/features/conversation_deletions.ts`).invalidateTaskDeletions('account-e2e');
      await indexer.reconcileChatsIndex('account-e2e');
      return files;
    }, { root: pcRoot, pid, cids, retained });
    expect((await app.invoke<any>('search.global', { query: '电商领域', scope: 'chat' })).results.map((row: any) => row.cid).sort())
      .toEqual([...cids, retained].sort());
    expect(await app.invoke('projects.delete', { projectId: pid })).toMatchObject({ ok: true, deleted_convs: 2 });
    for (const file of legacyFiles) expect(existsSync(file), 'Deletion must remove the source, not merely hide its search hit').toBe(false);
    const check = async () => {
      const page = app.page!;
      await page.locator('#sidebar-search-btn').click(); await page.locator('#search-input').fill('电商领域');
    await page.locator('#search-input').press('Enter');
      for (const scope of ['all', 'chat']) {
        await page.locator(`.search-tab[data-tab="${scope}"]`).click();
        await expect(page.locator('#search-body .search-loading-spinner')).toHaveCount(0);
        await expect(page.locator('#search-body .search-result-title')).toHaveText(['电商领域保留任务']);
      }
    };
    await check(); await app.page!.screenshot({ path: info.outputPath('search-after-legacy-delete.png') });
    await app.relaunch(); await installEmptyLibrarySearch(app, pcRoot); await check();
    for (const file of legacyFiles) expect(existsSync(file)).toBe(false);
    await app.page!.locator('#search-input').press('Escape');
    const { batches } = await app.invoke<any>('recycle.list'); expect(batches).toHaveLength(1);
    expect(await app.invoke('recycle.restore', { id: batches[0].id })).toMatchObject({ ok: true, skipped: 0, failed: 0 });
    for (const file of legacyFiles) expect(existsSync(file)).toBe(true);
    await app.electronApp!.evaluate(async (_, root) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      await req(`${root}/src/main/features/search/indexer.ts`).reconcileChatsIndex('account-e2e');
    }, pcRoot);
    expect((await app.invoke<any>('search.global', { query: '电商领域', scope: 'chat' })).results.map((row: any) => row.cid).sort())
      .toEqual([...cids, retained].sort());
  } finally { await app.dispose(); }
});

test('excludes May 23 legacy transcripts belonging to a removed project from search and rebuild', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false, seedLanguage: 'zh' });
  const title = '电商领域保留任务';
  try {
    await app.launch();
    await installEmptyLibrarySearch(app, pcRoot);
    const cid = (await app.invoke<any>('conversations.create', { title })).conversation.conversation_id;
    await app.electronApp!.evaluate(async (_, input) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const fs = req('node:fs'), path = req('node:path');
      const paths = req(`${input.root}/src/main/paths.ts`);
      const indexer = req(`${input.root}/src/main/features/search/indexer.ts`);
      await indexer.flushAll();
      const globalRoot = paths.userChatsDir('account-e2e');
      const orphanRoot = paths.projectChatsDir('account-e2e', 'removed-project');
      fs.mkdirSync(orphanRoot, { recursive: true });
      const rows = [0, 1, 2].map(index => ({ conversation_id: `orphan-may23-${index}`,
        title: `Removed project task ${index}`, project_id: 'removed-project', kind: 'normal',
        created_at: '2026-05-23T10:00:00', updated_at: '2026-05-23T20:00:00' }));
      fs.writeFileSync(path.join(orphanRoot, '_index.json'), JSON.stringify(rows));
      for (const row of [...rows, { conversation_id: input.cid }]) {
        fs.writeFileSync(path.join(globalRoot, `${row.conversation_id}.jsonl`), JSON.stringify({ role: 'user', content: '电商领域', time: '2026-05-23T12:26:00' }) + '\n');
      }
      req(`${input.root}/src/main/features/chats.ts`).invalidateConversationCaches('account-e2e');
      req(`${input.root}/src/main/features/conversation_deletions.ts`).invalidateTaskDeletions('account-e2e');
      await indexer.reconcileChatsIndex('account-e2e');
      const store = req(`${input.root}/src/main/features/search/chat_store.ts`);
      for (const row of rows) store.replaceConversation('account-e2e', row.conversation_id,
        [{ cid: row.conversation_id, msgIndex: 0, role: 'user', time: '', text: '电商领域' }], { mtime: 1, size: 1, next: 1 });
    }, { root: pcRoot, cid });
    const check = async () => {
      for (const scope of ['all', 'chat']) for (const includeChatSnippets of [false, true]) {
        const page = await app.invoke<any>('search.global', { query: '电商领域', scope, includeChatSnippets, includeLibraryContent: false });
        expect(page.results.filter((row: any) => row.kind === 'chat').map((row: any) => row.cid)).toEqual([cid]);
      }
      const page = app.page!;
      await page.locator('#sidebar-search-btn').click();
      await page.locator('#search-input').fill('电商领域');
      await page.locator('#search-input').press('Enter');
      for (const scope of ['all', 'chat']) {
        await page.locator(`.search-tab[data-tab="${scope}"]`).click();
        await expect(page.locator('#search-body .search-result-title')).toHaveText([title]);
      }
      await expect(page.locator('#search-body .search-result-snippet')).toContainText('电商领域');
    };
    await check();
    await app.page!.screenshot({ path: info.outputPath('search-orphan-project-zh.png') });
    await app.relaunch();
    await installEmptyLibrarySearch(app, pcRoot);
    await check();
    const indexed = await app.electronApp!.evaluate(async (_, root) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      await req(`${root}/src/main/features/search/indexer.ts`).reconcileChatsIndex('account-e2e');
      return req(`${root}/src/main/features/search/chat_store.ts`)._allDocsForTests('account-e2e').map((row: any) => row.cid);
    }, pcRoot);
    expect(indexed).toContain(cid);
    expect(indexed.some((id: string) => id.startsWith('orphan-may23-'))).toBe(false);
  } finally { await app.dispose(); }
});

test('finds connector cards without authorization and keeps every category reachable in narrow localized windows', async ({}, info) => {
  test.setTimeout(90_000);
  const app = new OrkasTestApp(info, { configuredModel: false, seedLanguage: 'zh' });
  try {
    await app.launch();
    await installEmptyLibrarySearch(app, pcRoot);
    const name = 'Search connector ' + 'Long account integration '.repeat(4);
    await app.electronApp!.evaluate(async (_electron, input) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const handlers = req(`${input.root}/src/main/ipc/connectors.ts`).invokeHandlers;
      (globalThis as any).__searchConnectorAuthorizations = 0;
      for (const method of ['connectors.start_oauth', 'connectors.authorize_custom', 'connectors.open_local_cli_auth_url']) {
        handlers[method] = () => {
          (globalThis as any).__searchConnectorAuthorizations++;
          throw new Error('Authorization is prohibited in the search navigation fixture');
        };
      }
      const uid = req(`${input.root}/src/main/features/users.ts`).getActiveUserId();
      const now = new Date().toISOString();
      await req(`${input.root}/src/main/features/connectors/registry.ts`).upsert(uid, {
        id: 'custom-search-navigation', origin: 'custom', display_name: input.name,
        transport: { kind: 'streamable-http', url: 'https://example.test/private-query-token' },
        enabled_subtools: null, tools_cache: [], tools_cached_at: 0,
        status: { kind: 'disconnected' }, created_at: now, updated_at: now,
      });
    }, { root: pcRoot, name });
    const page = app.page!;
    await app.invoke('projects.tasks.create', { content: 'Search connector review checklist' });
    await app.invoke('autoTasks.create', {
      title: 'Search connector daily review', content: 'Summarize availability', enabled: false,
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    await page.locator('#sidebar-search-btn').click();
    await page.locator('#search-input').fill('Search connector');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-body .search-result-kind')).toHaveText(['待办', '自动化', '连接器']);
    await page.screenshot({ path: info.outputPath('search-connectors-all-zh.png') });
    for (const [language, width, height] of [['zh', 1280, 800], ['en', 900, 640], ['de', 620, 520], ['ar', 620, 520]] as const) {
      await page.evaluate(language => (window as any).setLang(language), language);
      await page.setViewportSize({ width, height });
      expect(await page.locator('#search-tabs [role="tab"]').evaluateAll(tabs =>
        tabs.map(tab => (tab as HTMLElement).dataset.tab))).toEqual([
        'all', 'chat', 'todo', 'automation', 'agent', 'skill', 'connector', 'context',
      ]);
      // Locale/viewport changes retain the already submitted results.
      const tab = page.locator('.search-tab[data-tab="connector"]');
      await tab.click();
      await expect(tab).toHaveAttribute('aria-selected', 'true');
      await expect(tab).toBeInViewport();
      const result = page.locator('#search-body .search-result');
      await expect(result).toHaveCount(1);
      const title = result.locator('.search-result-title');
      await expect(title).toHaveAttribute('title', name);
      await expect(result).not.toContainText('private-query-token');
      const geometry = await page.evaluate(() => {
        const modal = document.querySelector('.search-modal')!;
        const head = document.querySelector('.search-result-head')!;
        const tabBar = document.querySelector('.search-tabs')!;
        const tabs = Array.from(document.querySelectorAll<HTMLElement>('.search-tab'));
        return { modalOverflow: modal.scrollWidth > modal.clientWidth,
          headOverflow: head.scrollWidth > head.clientWidth,
          verticalTabScroll: getComputedStyle(tabBar).overflowY !== 'hidden' && tabBar.scrollHeight > tabBar.clientHeight,
          tabRows: new Set(tabs.map(tab => tab.offsetTop)).size };
      });
      expect(geometry).toEqual({ modalOverflow: false, headOverflow: false, verticalTabScroll: false, tabRows: 1 });
      await page.screenshot({ path: info.outputPath(`search-connectors-${language}-${width}.png`) });
    }
    // Observe inside the renderer while navigation runs. Cross-process polling
    // after click settling can miss the transient cue during catalog repaints.
    const followConnectorResult = async (result: Locator, id: string) => {
      const cue = page.waitForFunction(id => {
        const card = document.querySelector<HTMLElement>(`.connector-card[data-id="${id}"].is-highlighted`);
        if (!card) return false;
        const bounds = card.getBoundingClientRect();
        const visible = getComputedStyle(card).visibility === 'visible' && bounds.width > 0 && bounds.height > 0;
        return visible ? { id: card.dataset.id, highlighted: card.classList.contains('is-highlighted'), visible } : false;
      }, id, { timeout: 10_000 });
      const [observed] = await Promise.all([cue, result.click()]);
      expect(await observed.jsonValue()).toEqual({ id, highlighted: true, visible: true });
      await observed.dispose();
    };
    await followConnectorResult(page.locator('#search-body .search-result'), 'custom-search-navigation');
    await expect(page.locator('#search-overlay')).toBeHidden();
    await page.evaluate(() => (window as any).setLang('en'));
    await page.setViewportSize({ width: 900, height: 640 });
    await page.locator('#sidebar-search-btn').click();
    await page.locator('#search-input').fill('GitHub');
    await page.locator('#search-input').press('Enter');
    await page.locator('.search-tab[data-tab="connector"]').click();
    const catalogResult = page.locator('#search-body .search-result').filter({ has: page.locator('.search-result-title[title="GitHub"]') });
    await expect(catalogResult).toBeVisible();
    await expect(catalogResult.locator('.search-result-snippet')).toContainText('repositories');
    await page.screenshot({ path: info.outputPath('search-connectors-catalog-en.png') });
    await followConnectorResult(catalogResult, 'github');
    expect(await app.electronApp!.evaluate(() => (globalThis as any).__searchConnectorAuthorizations)).toBe(0);
  } finally {
    await app.dispose();
  }
});

test('expands connector results safely, recovers from empty categories, and preserves account isolation after restart', async ({}, info) => {
  test.setTimeout(90_000);
  const app = new OrkasTestApp(info, { configuredModel: false, seedLanguage: 'en' });
  const unsafeName = 'Aster lifecycle <img src=x onerror="window.__searchNameExecuted=true"> & "review"';
  try {
    await app.launch();
    await installEmptyLibrarySearch(app, pcRoot);
    await app.electronApp!.evaluate(async (_electron, input) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const uid = req(`${input.root}/src/main/features/users.ts`).getActiveUserId();
      const registry = req(`${input.root}/src/main/features/connectors/registry.ts`);
      const now = new Date().toISOString();
      for (let index = 0; index < 11; index++) {
        await registry.upsert(uid, {
          id: `custom-lifecycle-${index}`, origin: 'custom',
          display_name: index === 0 ? input.unsafeName : `Aster lifecycle ${index}`,
          transport: { kind: 'streamable-http', url: 'https://example.test/mcp' },
          enabled_subtools: null, tools_cache: [], tools_cached_at: 0,
          status: { kind: 'disconnected' }, created_at: now, updated_at: now,
        });
      }
    }, { root: pcRoot, unsafeName });
    let page = app.page!;
    await page.locator('#sidebar-search-btn').click();
    await page.locator('#search-input').fill('Aster lifecycle');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-body .search-result')).toHaveCount(10);
    await expect(page.locator('.search-show-more[data-goto="connector"]')).toContainText('(11)');
    await page.locator('.search-show-more[data-goto="connector"]').click();
    await expect(page.locator('.search-tab[data-tab="connector"]')).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#search-body .search-result')).toHaveCount(11);
    const title = page.locator('#search-body .search-result-title').filter({ hasText: unsafeName });
    await expect(title).toHaveText(unsafeName);
    await expect(title).toHaveAttribute('title', unsafeName);
    await expect(page.locator('#search-body img, #search-body script')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__searchNameExecuted)).toBeUndefined();
    await page.screenshot({ path: info.outputPath('search-connectors-expanded-safe-name.png') });

    await page.locator('.search-tab[data-tab="todo"]').click();
    await expect(page.locator('#search-body .search-result')).toHaveCount(0);
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-overlay')).toBeVisible();
    await page.locator('.search-tab[data-tab="connector"]').click();
    await expect(page.locator('#search-body .search-result')).toHaveCount(11);
    await page.locator('#search-input').fill('unmatched lifecycle query');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-body')).toContainText('No results');
    await page.locator('#search-input').fill('');
    await expect(page.locator('#search-tabs')).toBeHidden();
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-overlay')).toBeVisible();
    await page.locator('#search-input').fill('Aster lifecycle');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-body .search-result')).toHaveCount(11);
    await page.locator('#search-input').press('Escape');

    page = await app.relaunch();
    await installEmptyLibrarySearch(app, pcRoot);
    await page.locator('#sidebar-search-btn').click();
    await page.locator('#search-input').fill('Aster lifecycle');
    await page.locator('#search-input').press('Enter');
    await page.locator('.search-tab[data-tab="connector"]').click();
    await expect(page.locator('#search-body .search-result')).toHaveCount(11);
    await expect(page.locator('#search-body img, #search-body script')).toHaveCount(0);
    page = await app.switchLocalUser('search-second-account', { nickname: 'Search second account', email: 'search-second@example.test' });
    await installEmptyLibrarySearch(app, pcRoot);
    await page.locator('#sidebar-search-btn').click();
    await expect(page.locator('.search-history-item')).toHaveCount(0);
    await page.locator('#search-input').fill('Aster lifecycle');
    await page.locator('#search-input').press('Enter');
    // A fresh account may still be preparing chat history on All. Its
    // connector category has no chat-index dependency and must be empty.
    await page.locator('.search-tab[data-tab="connector"]').click();
    await expect(page.locator('#search-body')).toContainText('No results');
    await expect(page.locator('#search-body .search-result')).toHaveCount(0);
    // An empty custom category must not be mistaken for an unavailable catalog.
    await page.locator('#search-input').fill('GitHub');
    await page.locator('#search-input').press('Enter');
    await page.locator('.search-tab[data-tab="connector"]').click();
    await expect(page.locator('#search-body .search-result-title').filter({ hasText: /^GitHub$/ })).toBeVisible();
  } finally {
    await app.dispose();
  }
});

test('shows cold chat matches within the input latency budget while snippet reads are held', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false, seedLanguage: 'en' });
  try {
    await app.launch();
    await installEmptyLibrarySearch(app, pcRoot);
    const created = await app.invoke<any>('conversations.create', { title: 'Cold history search fixture' });
    const cid = created.conversation.conversation_id;
    await app.electronApp!.evaluate(async (_electron, input) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const uid = req(`${input.root}/src/main/features/users.ts`).getActiveUserId();
      const indexer = req(`${input.root}/src/main/features/search/indexer.ts`);
      await indexer.flushAll();
      const file = req(`${input.root}/src/main/util/project-layout.ts`).conversationMessageReadFile(uid, input.cid);
      const fs = req('node:fs');
      const rows = Array.from({ length: 200 }, (_, index) => ({
        id: `cold-message-${index}`, role: 'user', content: `Coldneedle result body ${index}`,
        time: new Date(Date.UTC(2026, 9, 29, 0, 0, index)).toISOString(),
      }));
      fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
      indexer.invalidateChatsIndex(uid);
      await indexer.reconcileChatsIndex(uid);
      const { Worker } = req('node:worker_threads');
      const original = Worker.prototype.postMessage;
      const held: Array<() => void> = [];
      (globalThis as any).__coldSearchReads = 0;
      const fsp = req('node:fs/promises');
      const originalStat = fsp.stat;
      (globalThis as any).__coldSearchSourceStats = [];
      fsp.stat = async function(target: any, ...args: any[]) {
        const started = performance.now();
        try { return await originalStat.call(this, target, ...args); }
        finally {
          if (String(target) === file) (globalThis as any).__coldSearchSourceStats.push(performance.now() - started);
        }
      };
      Worker.prototype.postMessage = function(message: any, ...args: any[]) {
        if (message.file === file && Array.isArray(message.indexes)) {
          (globalThis as any).__coldSearchReads++;
          held.push(() => original.call(this, message, ...args));
        } else original.call(this, message, ...args);
      };
      (globalThis as any).__releaseColdSearchReads = () => {
        Worker.prototype.postMessage = original;
        fsp.stat = originalStat;
        for (const release of held.splice(0)) release();
      };
    }, { root: pcRoot, cid });
    await app.invoke('projects.tasks.create', { content: 'Coldneedle checklist' });
    const page = app.page!;
    await page.setViewportSize({ width: 900, height: 640 });
    await page.locator('#sidebar-search-btn').click();
    await expect(page.locator('#search-input')).toBeFocused();
    await page.evaluate(() => {
      document.getElementById('search-input')!.addEventListener('input', () => {
        const started = performance.now();
        const observer = new MutationObserver(() => {
          if (document.querySelector('#search-body .search-result-kind.is-chat')) {
            (window as any).__coldSearchPaintMs = performance.now() - started;
            observer.disconnect();
          }
        });
        observer.observe(document.getElementById('search-body')!, { childList: true, subtree: true });
      }, { once: true });
    });
    await page.locator('#search-input').fill('Coldneedle');
    await page.locator('#search-input').press('Enter');
    const chats = page.locator('#search-body .search-result').filter({ has: page.locator('.is-chat') });
    // No arbitrary sleep simulates a fast disk: the real source-read boundary
    // stays blocked until after the first paint and category switch are proven.
    await expect(chats).toHaveCount(10, { timeout: 3000 });
    const firstPaintMs = await page.evaluate(() => (window as any).__coldSearchPaintMs);
    checkLatencyBudget('global-search-cold-chat-first-paint', { elapsedMs: firstPaintMs }, FIRST_REQUEST_LATENCY_LIMIT_MS);
    await expect(page.locator('#search-body')).toContainText('Coldneedle checklist');
    await expect.poll(() => app.electronApp!.evaluate(() => (globalThis as any).__coldSearchReads)).toBeGreaterThan(0);
    await expect(chats.locator('.search-result-snippet')).toHaveCount(0);
    await page.locator('.search-tab[data-tab="chat"]').click();
    await expect(chats).toHaveCount(199); // The 200-result quota also reserves the matching to-do.
    await expect(page.locator('#search-body [role="status"]').filter({ hasText: 'Loading' })).toBeVisible();
    await page.locator('#search-input').focus();
    await page.screenshot({ path: info.outputPath('search-cold-chat-pending.png') });
    await app.electronApp!.evaluate(() => (globalThis as any).__releaseColdSearchReads());
    await expect(chats.first().locator('.search-result-snippet')).toBeVisible();
    expect(await chats.locator('.search-result-snippet').count()).toBeLessThan(199);
    await chats.last().scrollIntoViewIfNeeded();
    await expect(chats.last().locator('.search-result-snippet')).toBeVisible();
    await expect(chats).toHaveCount(199);
    await expect(page.locator('#search-body')).toContainText('Coldneedle result body');
    await expect(page.locator('#search-input')).toBeFocused();
    await expect(page.locator('#search-body .search-loading-spinner')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('search-cold-chat-complete.png') });
    const sourceStatMs = await app.electronApp!.evaluate(() => (globalThis as any).__coldSearchSourceStats);
    writeFileSync(info.outputPath('performance.json'), JSON.stringify({ firstPaintMs, sourceStatMs, sourceReplyHeldUntilAfterPaint: true,
      matchingChats: 200, visibleExpandedChats: 199, finalResults: 200 }));
  } finally {
    await app.electronApp?.evaluate(() => (globalThis as any).__releaseColdSearchReads?.()).catch(() => {});
    await app.dispose();
  }
});

test('paints local hits before held semantic retrieval and preserves selection when body results arrive', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false, seedLanguage: 'en' });
  try {
    await app.launch();
    for (let index = 0; index < 8; index++) {
      await app.invoke('projects.tasks.create', { content: 'Performance marker checklist ' + 'long entry '.repeat(15) + index });
    }
    await app.electronApp!.evaluate(async (_electron, root) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const uid = req(`${root}/src/main/features/users.ts`).getActiveUserId();
      const vector = new Array(512).fill(0); vector[0] = 1;
      await req(`${root}/src/main/features/kb_vector.ts`).upsertFile(uid, {
        relPath: 'semantic-only.md', kind: 'text', bytes: 40, mtime: 1, sha1: 'performance-fixture',
        chunks: [{ title: 'Library body match', content: 'Performance marker is stored only in this document body.', embedding: vector }],
      });
      const now = new Date().toISOString();
      await req(`${root}/src/main/features/connectors/registry.ts`).upsert(uid, {
        id: 'custom-performance', origin: 'custom', display_name: 'Performance marker connector',
        transport: { kind: 'streamable-http', url: 'https://example.test/mcp' },
        enabled_subtools: null, tools_cache: [], tools_cached_at: 0,
        status: { kind: 'disconnected' }, created_at: now, updated_at: now,
      });
      (globalThis as any).__searchEmbedCalls = 0;
      let reply: (message: any) => void;
      req(`${root}/src/main/features/kb_embed.ts`)._setEmbedChannelFactoryForTest(() => ({
        postMessage: (message: any) => {
          (globalThis as any).__searchEmbedCalls++;
          (globalThis as any).__releaseSearchEmbed = () => reply({ id: message.id, ok: true, vectors: [vector] });
        }, onMessage: (callback: any) => { reply = callback; }, onExit: () => {}, kill: () => {},
      }));
    }, pcRoot);
    const page = app.page!;
    await page.setViewportSize({ width: 900, height: 640 });
    await page.locator('#sidebar-search-btn').click();
    await expect(page.locator('#search-input')).toBeFocused();
    await page.evaluate(() => {
      const start = performance.now();
      const observer = new MutationObserver(() => {
        if (document.querySelector('#search-body .search-result')) {
          (window as any).__searchFirstPaintMs = performance.now() - start; observer.disconnect();
        }
      });
      observer.observe(document.getElementById('search-body')!, { childList: true, subtree: true });
    });
    await page.locator('#search-input').fill('Performance marker');
    await page.locator('#search-input').press('Enter');
    const results = page.locator('#search-body .search-result');
    await expect(results).toHaveCount(9);
    await expect(page.locator('#search-body [role="status"]').filter({ hasText: 'Loading' })).toBeVisible();
    const spinnerBox = await page.locator('#search-body .search-loading-spinner').boundingBox();
    expect(spinnerBox?.width, 'Inline progress keeps the existing visible spinner size').toBeGreaterThanOrEqual(12);
    expect(spinnerBox?.height).toBeGreaterThanOrEqual(12);
    await page.screenshot({ path: info.outputPath('search-progressive-pending-top.png') });
    await expect.poll(() => app.electronApp!.evaluate(() => (globalThis as any).__searchEmbedCalls)).toBe(1);
    // The model boundary has not replied: these hits must come from the real
    // local resource/IPC path, not a complete response supplied by the fixture.
    await expect(page.locator('#search-body')).not.toContainText('Library body match');
    // Modules can arrive in either order. Navigate explicitly to the connector
    // instead of assuming which resource was auto-selected by the first module.
    await page.locator('#search-input').press('ArrowDown');
    for (let move = 0; move < 9 && await page.locator('.search-result.active .search-result-title').textContent() !== 'Performance marker connector'; move++) {
      await page.locator('#search-input').press('ArrowDown');
    }
    await expect(page.locator('.search-result.active .search-result-title')).toHaveText('Performance marker connector');
    await expect(page.locator('.search-result.active')).toBeInViewport();
    await page.screenshot({ path: info.outputPath('search-progressive-local-results.png') });
    const firstPaintMs = await page.evaluate(() => (window as any).__searchFirstPaintMs);
    await app.electronApp!.evaluate(() => (globalThis as any).__releaseSearchEmbed());
    await expect(results).toHaveCount(10);
    await expect(page.locator('#search-body')).toContainText('Library body match');
    await expect(page.locator('.search-result.active .search-result-title')).toHaveText('Performance marker connector');
    await expect(page.locator('.search-result.active')).toBeInViewport();
    await expect(page.locator('#search-input')).toBeFocused();
    await expect(page.locator('#search-body .search-loading-spinner')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('search-progressive-complete.png') });
    const evidence = JSON.stringify({ firstPaintMs, semanticReplyHeldUntilAfterLocalPaint: true, finalHits: 10 });
    writeFileSync(info.outputPath('performance.json'), evidence);
    await info.attach('search-first-paint', {
      body: Buffer.from(evidence),
      contentType: 'application/json',
    });
  } finally { await app.dispose(); }
});

test('shows preparation before full results, searches partial history, and resumes after a real Electron restart', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const app = new OrkasTestApp(testInfo, { configuredModel: false });
  try {
    await app.launch();
    await installEmptyLibrarySearch(app, pcRoot);
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
    // The preparation/loading assertions below intentionally verify Chinese.
    // Establish that language through the real UI preference before searching.
    await page.evaluate(async () => { await (window as any).setLang('zh'); });
    // Hold only delivery of the real global request. Status uses the actual
    // renderer shim/preload/IPC handler; chat search/status remain real while
    // the unrelated Library semantic provider is explicitly fixture-only.
    await page.evaluate(() => {
      const app = window as any;
      app.__searchRelease = null;
      const gate = new Promise<void>(resolve => { app.__searchRelease = resolve; });
      const progressive = app._runProgressiveSearch;
      app._runProgressiveSearch = async (...args: unknown[]) => { await gate; return progressive(...args); };
    });
    await page.locator('#sidebar-search-btn').click();
    const copy = '正在准备中，结果暂不完整，请稍后重试。';
    // Index coverage and semantic retrieval have separate status rows. Keep
    // this case's oracle specific to the promised first-build notice.
    const notice = page.locator('#search-body .is-status').filter({ hasText: copy });
    await expect(notice).toHaveText(copy);
    await page.locator('#search-input').fill('prefixmarker');
    await page.locator('#search-input').press('Enter');
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
    await installEmptyLibrarySearch(app, pcRoot);
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
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-body .search-result').first()).toBeVisible();
    await expect(page.locator('#search-body [role="status"]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('complete-search.png') });
    await page.locator('#search-close-btn').click();

    // A built index that loses verification (here a sync invalidation) while
    // agent work keeps its repair waiting is not announced: opening search and
    // searching stay quiet, and the status check queues the catch-up.
    await app.electronApp!.evaluate((_electron, root) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      require(`${root}/src/main/util/boot_init.ts`).configureBootAdmission({ isRuntimeBusy: () => true });
      const uid = require(`${root}/src/main/features/users.ts`).getActiveUserId();
      require(`${root}/src/main/features/search/indexer.ts`).invalidateChatsIndex(uid);
    }, pcRoot);
    expect(await app.invoke('search.status'))
      .toMatchObject({ ok: true, chat_index_complete: false, chat_index_building: false });
    await page.locator('#sidebar-search-btn').click();
    // Let the overlay's own status request settle before checking for silence.
    await page.evaluate(() => (window as any).apiFetch('/api/search/status').then((r: any) => r.json()));
    await expect(page.locator('#search-body [role="status"]')).toHaveCount(0);
    await page.locator('#search-input').fill('prefixmarker');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-body .search-result').first()).toBeVisible();
    await expect(page.locator('#search-body [role="status"]')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('catch-up-search.png') });
    await app.electronApp!.evaluate((_electron, root) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      require(`${root}/src/main/util/boot_init.ts`).configureBootAdmission({ isRuntimeBusy: () => false });
    }, pcRoot);
    await expect.poll(async () => app.invoke('search.status'), { timeout: 30_000 })
      .toMatchObject({ ok: true, chat_index_complete: true });
    expect(app.modelRequests).toHaveLength(0);
    expect(await app.electronApp!.evaluate(() => (globalThis as any).__emptyLibrarySearchQueries)).toBeGreaterThan(0);
  } finally { await app.dispose(); }
});

test('runs rebuild, live indexing and snippet workers from an ASAR with the shipped dependency layout', async ({}, testInfo) => {
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
    await finished(await createPackageWithOptions(source, archive, { unpack: `{${unpack.join(',')}}` }));
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
        const storage = require(`${input.sourceRoot}/src/main/storage.ts`);
        const appended = await storage.appendJsonlAtomic(file, { from: 'assistant', text: 'packagedlivemarker', ts: 't2' }, true);
        const liveComplete = await worker.indexMessage({ cid: 'source', msgIndex: appended.msgIndex, source: appended.source });
        await worker.compact();
        snippetWorker = new Worker(`${input.archive}/src/main/features/search/chat-snippet-entry.js`, {
          execArgv: [], env: { ...process.env },
        });
        const snippet = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Packaged snippet worker did not respond')), 10_000);
          snippetWorker.once('error', (error: Error) => { clearTimeout(timeout); reject(error); });
          snippetWorker.once('message', (message: any) => { clearTimeout(timeout); resolve(message.rows[0]?.[1]?.snippet); });
          snippetWorker.postMessage({ id: 1, file, indexes: [0], tokens: ['packagedmarker'], source: { userId: 'packaged-fixture', cid: 'source' } });
        });
        return { complete: batch.complete, liveComplete, liveMatches: store.postingsFor('packaged-fixture', 'packagedlivemarker').length, count: store.docCount('packaged-fixture'),
          matches: store.postingsFor('packaged-fixture', 'packagedmarker').length, snippet };
      } finally {
        await snippetWorker?.terminate();
        await worker.close();
        store.closeAllChatStores();
        if (old === undefined) delete process.env.ESBUILD_BINARY_PATH;
        else process.env.ESBUILD_BINARY_PATH = old;
      }
    }, { archive, esbuild, sourceRoot: pcRoot });
    expect(result).toEqual({ complete: true, liveComplete: true, liveMatches: 1, count: 2, matches: 1, snippet: 'packagedmarker' });
  } finally { await app.dispose(); }
});

// The first click on a result that is still filling must open it. Status and
// summaries move rows by more than their height, and a new module replaces them.
test('opens the pressed result when a page lands between press and release', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false, seedLanguage: 'en' });
  try {
    await app.launch();
    await installEmptyLibrarySearch(app, pcRoot);
    const todos: Array<{ id: string }> = [];
    for (let index = 0; index < 4; index++) {
      const { task } = await app.invoke<any>('projects.tasks.create', { content: `Pressmarker checklist ${index}` });
      todos.push(task);
    }
    const page = app.page!;
    await page.setViewportSize({ width: 900, height: 640 });
    const landings: Array<[string, string]> = [
      ['the same page again', ''],
      ['progress status', "_searchPendingKinds = ['chat'];"],
      ['summaries above the row', "_searchResults = _searchResults.map(row => ({ ...row, snippet: 'Pressmarker summary body' }));"],
      ['a new result', "_searchResults = [{ kind: 'todo', id: 't_000000000000', name: 'Pressmarker newcomer', status: 'todo', project_id: '', score: 1000 }, ..._searchResults];"],
    ];
    for (const [landing, change] of landings) {
      await page.locator('#sidebar-search-btn').click();
      await page.locator('#search-input').fill('Pressmarker');
      await page.locator('#search-input').press('Enter');
      const rows = page.locator('#search-body .search-result');
      await expect(rows).toHaveCount(4);
      await expect(page.locator('#search-body .search-loading-spinner')).toHaveCount(0);
      const target = rows.nth(2);
      const title = await target.locator('.search-result-title').textContent();
      const todo = todos[Number(title!.trim().slice(-1))];
      const box = (await target.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.evaluate(code => {
        (0, eval)(code);
        (window as any)._renderSearchResults('Pressmarker');
      }, change);
      await page.mouse.up();
      await expect(page.locator('#search-overlay'), `A click after ${landing} opens the result`).toBeHidden();
      await expect(page.locator(`.project-todo-item[data-tid="${todo.id}"].is-highlighted`), landing).toBeVisible();
      await page.evaluate(() => (0, eval)('_searchPendingKinds = [];'));
    }
    // A draft keystroke leaves the rows the pointer may be on.
    await page.locator('#sidebar-search-btn').click();
    await page.locator('#search-input').fill('Pressmarker');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-body .search-result')).toHaveCount(4);
    await expect(page.locator('#search-body .search-loading-spinner')).toHaveCount(0);
    await page.evaluate(() => { (document.querySelector('#search-body .search-result') as any).__sameNode = true; });
    await page.locator('#search-input').pressSequentially(' more');
    expect(await page.evaluate(() => (document.querySelector('#search-body .search-result') as any).__sameNode)).toBe(true);
    await page.screenshot({ path: info.outputPath('search-draft-keeps-rows.png') });
    await page.locator('#search-input').press('Escape');
  } finally {
    await app.dispose();
  }
});

test('publishes independent modules and chat enrichment while automation and Library work are held', async ({}, info) => {
  const app = new OrkasTestApp(info, { configuredModel: false, seedLanguage: 'en' });
  try {
    await app.launch();
    const cid = (await app.invoke<any>('conversations.create', { title: 'GitHub parallel conversation' })).conversation.conversation_id;
    const automation = (await app.invoke<any>('autoTasks.create', { title: 'GitHub delayed automation', content: 'GitHub automation',
      enabled: false, schedule: { type: 'daily', hour: 9, minute: 0 } })).task.id;
    await app.invoke('projects.tasks.create', { content: 'GitHub independent checklist' });
    await app.electronApp!.evaluate(async (_, input) => {
      const req = (process as any).mainModule.require.bind((process as any).mainModule);
      const uid = req(`${input.root}/src/main/features/users.ts`).getActiveUserId();
      const layout = req(`${input.root}/src/main/util/project-layout.ts`);
      const indexer = req(`${input.root}/src/main/features/search/indexer.ts`);
      await indexer.flushAll();
      const fs = req('node:fs'), fsp = req('node:fs/promises');
      const file = layout.conversationMessageReadFile(uid, input.cid);
      fs.writeFileSync(file, JSON.stringify({ id: 'parallel-message', role: 'user', content: 'GitHub enriched body' }) + '\n');
      indexer.invalidateChatsIndex(uid); await indexer.reconcileChatsIndex(uid);
      const state = globalThis as any;
      const config = layout.findAutoTaskLocation(uid, input.automation).configFile;
      const originalRead = fsp.readFile;
      let releaseAuto!: () => void, releaseLibrary!: () => void;
      const autoGate = new Promise<void>(resolve => { releaseAuto = resolve; });
      const libraryGate = new Promise<void>(resolve => { releaseLibrary = resolve; });
      state.__parallelAutoReads = 0;
      fsp.readFile = async function(target: any, ...args: any[]) {
        if (String(target) === config) { state.__parallelAutoReads++; await autoGate; }
        return originalRead.call(this, target, ...args);
      };
      req('node:module').syncBuiltinESMExports();
      req(`${input.root}/src/main/features/search/index.ts`).__searchTestHooks.setLibraryContentSearchProvider({
        hasSources: async () => true, embedQuery: async () => { await libraryGate; return [1]; },
        searchGlobal: () => [{ rel_path: 'parallel-source.md', chunk_idx: 0, content: 'GitHub delayed Library body', score: .9 }],
        listProjects: async () => [], searchProject: () => [],
      });
      state.__releaseParallelAuto = () => { releaseAuto(); fsp.readFile = originalRead; req('node:module').syncBuiltinESMExports(); };
      state.__releaseParallelLibrary = releaseLibrary;
    }, { root: pcRoot, cid, automation });
    const page = app.page!;
    await page.setViewportSize({ width: 900, height: 640 });
    await page.locator('#sidebar-search-btn').click(); await page.locator('#search-input').fill('GitHub');
    await page.locator('#search-input').press('Enter');
    await expect(page.locator('#search-body')).toContainText('GitHub independent checklist');
    await expect.poll(() => app.electronApp!.evaluate(() => (globalThis as any).__parallelAutoReads)).toBeGreaterThan(0);
    await expect(page.locator('#search-body')).not.toContainText('GitHub delayed automation');
    const chat = page.locator('#search-body .search-result').filter({ hasText: 'GitHub parallel conversation' });
    await expect(chat.locator('.search-result-snippet')).toContainText('GitHub enriched body');
    await expect(page.locator('#search-body')).not.toContainText('GitHub delayed Library body');
    await page.screenshot({ path: info.outputPath('parallel-modules-pending.png') });
    await app.electronApp!.evaluate(() => (globalThis as any).__releaseParallelAuto());
    await expect(page.locator('#search-body')).toContainText('GitHub delayed automation');
    await app.electronApp!.evaluate(() => (globalThis as any).__releaseParallelLibrary());
    await expect(page.locator('#search-body')).toContainText('GitHub delayed Library body');
    await expect(page.locator('#search-body .search-loading-spinner')).toHaveCount(0);
    await expect(page.locator('#search-input')).toBeFocused();
    await page.screenshot({ path: info.outputPath('parallel-modules-complete.png') });
  } finally {
    await app.electronApp?.evaluate(() => {
      (globalThis as any).__releaseParallelAuto?.(); (globalThis as any).__releaseParallelLibrary?.();
    }).catch(() => {});
    await app.dispose();
  }
});
