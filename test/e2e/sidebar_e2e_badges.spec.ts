import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { loadRetainedFilePage } from './fixtures/retained-file-page';

test.use({ launchOptions: { executablePath: process.env.ORKAS_E2E_BROWSER_PATH } });
const renderer = path.resolve(__dirname, '../../src/renderer');
const logs = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }, info) => {
  const unexpected = logs.get(page) || [];
  const audit = { captured: unexpected.length, unexpected };
  fs.writeFileSync(info.outputPath('browser-log-audit.json'), JSON.stringify(audit));
  expect(unexpected).toEqual([]);
});
async function setup(page: Page, count: number) {
  const captured: string[] = [];
  logs.set(page, captured);
  page.on('console', m => captured.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', e => captured.push(`error: ${e.message}`));
  const file = test.info().outputPath('sidebar.html');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><base href="${pathToFileURL(renderer + path.sep).href}">
    <link rel="stylesheet" href="style.css"><script>
    window.createLogger=()=>console; window.t=(key,args)=>args?.n ? args.n+' running' : key;
    window.currentCid=null; window.currentView='conversation'; window.conversations=[];
    window.pendingConvs=new Map(); window.groupBusyConvs=new Map();
    window.isConvPending=cid=>pendingConvs.has(cid)||groupBusyConvs.has(cid);
    window.setGroupConversationBusy=(cid,busy)=>busy ? groupBusyConvs.set(cid,true) : groupBusyConvs.delete(cid);
    window.pushHandlers=new Map();
    window.orkas={onPushEvent(name,fn){pushHandlers.set(name,fn);return ()=>{};}};
    </script><script src="modules/icons.js"></script><script src="modules/utils.js"></script>
    <script src="vendor/prosemirror/prosemirror.min.js"></script>
    <script src="modules/composer-input.js"></script>
    <script src="modules/conv-bucket.js"></script>
    <script src="modules/cli_async_input.js"></script>
    <script src="modules/local_agent_user_input.js"></script>
    <script src="modules/conversation.js"></script><script src="modules/projects.js"></script></head><body>
    <span id="commander-running-chip"></span><span id="tasks-running-chip"></span>
    <span data-project-running-chip="project"></span>
    <div id="today-list"></div><div id="conversation-list"></div>
    <div id="conversation-action-menu" data-cid="c2"><button data-action="to-project"></button></div>
    </body></html>`);
  await loadRetainedFilePage(page, file);
  await page.evaluate(count => {
    const w = window as any;
    w.metadataVisits = 0;
    w.conversations = Array.from({ length: count }, (_, i) => {
      const cid = `c${i}`;
      const c = { title: `Task ${i}`, status: i % 4 === 1 ? 'failed' : i % 4 === 3 ? 'blocked' : 'done',
        project_id: i < count / 2 ? 'project' : null, origin_auto_task_id: i % 4 === 2 ? 'scheduled' : undefined };
      Object.defineProperty(c, 'conversation_id', { enumerable: true, get() { w.metadataVisits++; return cid; } });
      if (i % 4 === 2) w.pendingConvs.set(cid, { aborted: false });
      return c;
    });
    const html = w.conversations.map((c: any) => w._renderConversationSidebarItem(c)).join('');
    document.getElementById('today-list')!.innerHTML = html;
    document.getElementById('conversation-list')!.innerHTML = html;
  }, count);
}

for (const count of [120, 600, 1200]) {
  test(`bulk refresh keeps ${count} task states correct with bounded full-document scans`, async ({ page }, info) => {
    await setup(page, count);
    const measured = await page.evaluate(() => {
      const w = window as any;
      const query = document.querySelectorAll.bind(document);
      let scans = 0;
      document.querySelectorAll = ((selector: string) => { scans++; return query(selector); }) as any;
      w.metadataVisits = 0;
      const begin = performance.now();
      try { w._refreshAllConvBadges(); }
      finally { document.querySelectorAll = query as any; }
      return { ms: performance.now() - begin, scans, metadataVisits: w.metadataVisits };
    });
    fs.writeFileSync(info.outputPath('sidebar-performance.json'), JSON.stringify({ count, ...measured }));
    await expect(page.locator('.conv-status-badge.is-streaming')).toHaveCount(count / 2);
    await expect(page.locator('.conv-item-status-label.is-failed')).toHaveCount(count / 2);
    await expect(page.locator('.conv-item-status-label.is-blocked')).toHaveCount(count / 2);
    await expect(page.locator('#commander-running-chip')).toHaveText(`${count / 4} running`);
    await expect(page.locator('#tasks-running-chip')).toHaveText(`${count / 8} running`);
    await expect(page.locator('[data-project-running-chip]')).toHaveText(`${count / 8} running`);
    await expect(page.locator('[data-action="to-project"]')).toHaveAttribute('aria-disabled', 'true');
    // The outcome checks above reject an implementation that simply skips
    // work; these budgets reject scanning all DOM/metadata again for each row.
    expect(measured.scans).toBeLessThanOrEqual(6);
    expect(measured.metadataVisits).toBeLessThanOrEqual(count * 8);
  });
}

test('repeated refresh preserves live indicators, rename focus and status transitions in every copy', async ({ page }) => {
  await setup(page, 8);
  await page.evaluate(() => {
    const w = window as any;
    w._refreshAllConvBadges();
    w.originalBadges = [...document.querySelectorAll('.conv-status-badge')];
    const title = document.querySelector('#today-list [data-cid="c0"] .conv-item-title')!;
    const input = document.createElement('input');
    input.className = 'conv-item-title-input'; input.value = 'draft 尚未提交';
    title.replaceWith(input); input.focus(); input.setSelectionRange(6, 8);
    w.renameInput = input;
    for (let i = 0; i < 5; i++) w._refreshAllConvBadges();
  });
  expect(await page.evaluate(() => {
    const w = window as any;
    return { badgesConnected: w.originalBadges.every((b: Element) => b.isConnected),
      focused: document.activeElement === w.renameInput, draft: w.renameInput.value,
      selection: [w.renameInput.selectionStart, w.renameInput.selectionEnd] };
  })).toEqual({ badgesConnected: true, focused: true, draft: 'draft 尚未提交', selection: [6, 8] });
  await page.evaluate(() => {
    const w = window as any;
    w.pendingConvs.set('c2', { aborted: true });
    w.conversations[2].status = 'blocked';
    w.pendingConvs.delete('c6');
    w.conversations[6].status = 'failed';
    w._refreshAllConvBadges();
  });
  await expect(page.locator('[data-cid="c2"] .conv-status-badge')).toHaveCount(0);
  await expect(page.locator('[data-cid="c2"] .conv-item-status-label.is-blocked')).toHaveCount(2);
  await expect(page.locator('[data-cid="c6"] .conv-item-status-label.is-failed')).toHaveCount(2);
  await expect(page.locator('#commander-running-chip')).toBeHidden();
  // A later single-task event and a newly mounted mirror must see fresh DOM,
  // not cached row references from a preceding bulk refresh.
  await page.evaluate(() => {
    const w = window as any;
    document.getElementById('conversation-list')!.innerHTML = w._renderConversationSidebarItem(w.conversations[2]);
    w.pendingConvs.set('c2', { aborted: false });
    w._updateConvSidebarBadge('c2');
  });
  await expect(page.locator('[data-cid="c2"] .conv-status-badge')).toHaveCount(2);
});

test('background CLI questions show attention in every sidebar copy and clear after answer, withdrawal or stop', async ({ page }, info) => {
  await setup(page, 8);
  const index = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const sidebar = index.slice(index.indexOf('<aside class="sidebar">'), index.indexOf('</aside>') + 8);
  const locales = Object.fromEntries(['en', 'zh'].map(lang => [lang,
    JSON.parse(fs.readFileSync(path.join(renderer, 'locales', `${lang}.json`), 'utf8'))]));
  await page.evaluate(({ sidebar, locales }) => {
    const w = window as any;
    document.body.innerHTML = `<div class="app-container">${sidebar}<main class="main-content"><div id="chat-cli-questions" hidden></div></main></div>`;
    w.lang = 'zh';
    w.t = (key: string, args: any) => {
      const value = locales[w.lang][key] || key;
      return value.replace(/\{(\w+)\}/g, (_: string, name: string) => String(args?.[name] ?? ''));
    };
    w.localizeSidebar = () => document.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = w.t((el as HTMLElement).dataset.i18n);
    });
    w.localizeSidebar();
    w.orkas.invoke = async (_: string, data: any) => ({ ok: true, message: {
      cli_answer: { message_id: data.message_id, answers: data.answers },
    } });
    w.conversations = [
      { conversation_id: 'a', title: '需要确认的任务 · A very long task title for sidebar clipping checks', last_active_at: new Date().toISOString() },
      { conversation_id: 'b', title: 'Another running task', last_active_at: new Date().toISOString() },
      { conversation_id: 'p', title: 'Project task', project_id: 'project', last_active_at: new Date().toISOString() },
      { conversation_id: 'old', title: 'Historical unanswered question', created_at: '2020-01-01' },
    ];
    const render = (rows: any[]) => rows.map(c => w._renderConversationSidebarItem(c)).join('');
    document.getElementById('today-list')!.innerHTML = render(w.selectRecentConversations(w.conversations));
    document.getElementById('conversation-list')!.innerHTML = render(w.conversations.filter((c: any) => !c.project_id));
    document.getElementById('projects-list')!.innerHTML = w._renderProjectRow({ project_id: 'project', name: 'CLI project' }, []);
    w.pendingConvs.clear();
    for (const cid of ['a', 'b', 'p']) w.pendingConvs.set(cid, { aborted: false });
    w.CliAsyncInput.showConversation('b');
    w.question = { id: 'q', from: 'agent', turn_id: 'turn', cli_question: { questions: [{ title: 'Which scope?', options: ['Current'] }] } };
    w.CliAsyncInput.observe('old', w.question);
    w._handleGroupBusEvent('a', null, { type: 'state_changed', state: { status: 'running', in_flight: ['agent'] },
      active_turns: [{ actor: 'agent', turn_id: 'turn', steerable: true }] });
    w._handleGroupBusEvent('a', null, { type: 'message', msg: w.question });
  }, { sidebar, locales });
  const labels = page.locator('[data-cid="a"] .conv-item-status-label.is-waiting');
  await expect(labels).toHaveCount(2);
  await expect(labels.first()).toHaveText('待回答');
  await expect(page.locator('[data-cid="a"] .conv-status-badge')).toHaveCount(0);
  await expect(page.locator('[data-cid="old"] .conv-item-status-label.is-waiting')).toHaveCount(0);
  await expect(page.locator('#today-running-chip')).toHaveCount(0);
  await expect(page.locator('#tasks-running-chip')).toHaveText('执行中 1');
  await expect(page.locator('.sidebar-btn-running-chip.is-waiting')).toHaveCount(0);
  await expect(page.locator('#commander-running-chip')).toHaveText('执行中 2');
  expect(await page.evaluate(() => [...(window as any)._sidebarRunningConversationIds()])).toEqual(['b', 'p']);
  for (const [lang, width, height] of [['zh', 1280, 800], ['en', 800, 600]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(lang => {
      const w = window as any;
      w.lang = lang; w.localizeSidebar(); window.dispatchEvent(new CustomEvent('i18n-change'));
    }, lang);
    await expect(labels.first()).toHaveText(lang === 'zh' ? '待回答' : 'Needs answer');
    await expect(page.locator('.sidebar-section-toggle, .project-row, #new-chat-btn')
      .filter({ hasText: lang === 'zh' ? '待回答' : 'Needs answer' })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`waiting-${lang}.png`) });
  }
  await page.evaluate(() => {
    const w = window as any;
    document.getElementById('today-list')!.hidden = true;
    w.CliAsyncInput.showConversation('a');
    w.CliAsyncInput.showQuestion(w.question, { cid: 'a' });
  });
  await page.locator('#chat-cli-questions textarea').fill('Current folder');
  await page.locator('#chat-cli-questions .btn-primary').click();
  await expect(labels).toHaveCount(0);
  await expect(page.locator('[data-cid="a"] .conv-status-badge.is-streaming')).toHaveCount(2);
  await page.evaluate(() => {
    const w = window as any;
    w.pushHandlers.get('local-agent:user-input')({ cid: 'p', request_id: 'blocking', questions: [{ id: 'q', question: 'Which branch?' }] });
  });
  await expect(page.locator('[data-project-running-chip]')).toBeHidden();
  await expect(page.locator('[data-cid="p"] .conv-item-status-label.is-waiting')).toHaveText('Needs answer');
  await page.evaluate(() => { document.getElementById('today-list')!.hidden = false; });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: info.outputPath('waiting-project-en.png') });
  await page.evaluate(() => (window as any).pushHandlers.get('local-agent:user-input_cancelled')({ request_ids: ['blocking'] }));
  await expect(page.locator('[data-project-running-chip]')).toHaveText('1 running');
  await page.evaluate(() => {
    const w = window as any;
    w.CliAsyncInput.observe('a', { ...w.question, id: 'q2' });
    w._handleGroupBusEvent('a', null, { type: 'aborted' });
  });
  await expect(labels).toHaveCount(0);
  await expect(page.locator('#tasks-running-chip')).toHaveText('2 running');
});

test('task status stays at the trailing edge beside the menu when replies become unread', async ({ page }, info) => {
  await setup(page, 0);
  await page.addScriptTag({ path: path.join(renderer, 'modules/cli_async_input.js') });
  await page.addScriptTag({ path: path.join(renderer, 'modules/task-unread.js') });
  const index = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const sidebar = index.slice(index.indexOf('<aside class="sidebar">'), index.indexOf('</aside>') + 8);
  const locales = Object.fromEntries(['zh', 'en', 'ar'].map(lang => [lang,
    JSON.parse(fs.readFileSync(path.join(renderer, 'locales', `${lang}.json`), 'utf8'))]));
  await page.evaluate(({ sidebar, locales }) => {
    const w = window as any;
    document.body.innerHTML = `<div class="app-container">${sidebar}<main class="main-content"></main></div>`;
    w.currentUserId = 'sidebar-layout-fixture';
    w.currentView = 'new-chat';
    w.CliAsyncInput.waitingCount = (cid: string) => cid.startsWith('waiting-') ? 1 : 0;
    w.renderLayout = (lang: string) => {
      w.t = (key: string) => locales[lang][key] || key;
      document.querySelectorAll('[data-i18n]').forEach(el => {
        el.textContent = w.t((el as HTMLElement).dataset.i18n);
      });
      w.conversations = ['failed', 'blocked', 'waiting', 'done'].flatMap(status => ['short', 'long'].map(length => ({
        conversation_id: `${status}-${length}`, status,
        title: length === 'short' ? (lang === 'zh' ? '任务' : 'Task') : '需要处理的长任务标题 · A long task title that must truncate safely',
      })));
      document.getElementById('today-list')!.innerHTML = w.conversations.map((c: any) => w._renderConversationSidebarItem(c)).join('');
      document.getElementById('projects-list')!.innerHTML = `<div class="project-conv-list">${w.conversations.map((c: any) =>
        w._renderConversationSidebarItem(c, { nested: true })).join('')}</div>`;
      w.TaskUnread.refresh();
      w.hydrateUiIcons(document.body);
    };
  }, { sidebar, locales });
  const assertGeometry = async () => {
    const rows = await page.locator('.sidebar-conversation-nav .conv-item').evaluateAll(items => items.map(item => {
      const row = item.querySelector('.conv-item-row')!;
      const title = row.querySelector('.conv-item-title')!;
      const label = row.querySelector('.conv-item-status-label');
      const dot = row.querySelector('.task-unread-dot');
      const actions = row.querySelector('.conv-item-actions')!;
      const gap = parseFloat(getComputedStyle(row).columnGap);
      const rtl = getComputedStyle(row).direction === 'rtl';
      const rowRect = row.getBoundingClientRect();
      const actionRect = actions.getBoundingClientRect();
      const labelRect = label?.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const dotRect = dot?.getBoundingClientRect();
      return {
        cid: (item as HTMLElement).dataset.cid,
        statusGap: labelRect ? (rtl ? labelRect.left - actionRect.right : actionRect.left - labelRect.right) - gap : 0,
        dotGap: dotRect ? (rtl ? titleRect.left - dotRect.right : dotRect.left - titleRect.right) - gap : 0,
        titleWidth: title.getBoundingClientRect().width,
        overflow: Math.max(rowRect.left - actionRect.left, actionRect.right - rowRect.right),
      };
    }));
    for (const row of rows) {
      expect(Math.abs(row.statusGap), `${row.cid}: status beside trailing menu`).toBeLessThan(1);
      expect(Math.abs(row.dotGap), `${row.cid}: unread dot beside title`).toBeLessThan(1);
      expect(row.titleWidth, `${row.cid}: readable title space`).toBeGreaterThan(0);
      expect(row.overflow, `${row.cid}: no row overflow`).toBeLessThanOrEqual(1);
    }
  };
  for (const [lang, width, height, sidebarWidth] of [['zh', 1280, 800, 180], ['en', 800, 600, 280], ['ar', 1000, 700, 280]] as const) {
    await page.setViewportSize({ width, height });
    await page.evaluate(({ lang, sidebarWidth }) => {
      const w = window as any;
      document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
      document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidth}px`);
      w.renderLayout(lang);
    }, { lang, sidebarWidth });
    await assertGeometry();
    await page.evaluate(() => {
      const w = window as any;
      for (const c of w.conversations) w._markConversationUnread(c.conversation_id, { finishedAt: Date.now() });
      w._refreshAllConvBadges();
    });
    await expect(page.locator('.conv-item.has-unread')).toHaveCount(16);
    await assertGeometry();
    const failed = page.locator('#today-list [data-cid="failed-short"]');
    await failed.hover();
    await failed.locator('.conv-item-menu').focus();
    await assertGeometry();
    await page.screenshot({ path: info.outputPath(`status-alignment-${lang}.png`) });
    await page.locator('.project-conv-list').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`status-alignment-project-${lang}.png`) });
    await page.evaluate(() => {
      const w = window as any;
      for (const c of w.conversations) w.TaskUnread.markRead(c.conversation_id);
    });
    await expect(page.locator('.conv-item.has-unread')).toHaveCount(0);
    await assertGeometry();
  }
});
