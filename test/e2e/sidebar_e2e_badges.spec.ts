import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

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
  fs.writeFileSync(file, `<!doctype html><html><head><base href="${pathToFileURL(renderer + path.sep).href}">
    <link rel="stylesheet" href="style.css"><script>
    window.createLogger=()=>console; window.t=(key,args)=>args?.n ? args.n+' running' : key;
    window.currentCid=null; window.currentView='conversation'; window.conversations=[];
    window.pendingConvs=new Map(); window.groupBusyConvs=new Map();
    window.isConvPending=cid=>pendingConvs.has(cid)||groupBusyConvs.has(cid);
    window.orkas={onPushEvent(){return ()=>{};}};
    </script><script src="modules/icons.js"></script><script src="modules/utils.js"></script>
    <script src="vendor/prosemirror/prosemirror.min.js"></script>
    <script src="modules/composer-input.js"></script>
    <script src="modules/conversation.js"></script></head><body>
    <span id="commander-running-chip"></span><span id="tasks-running-chip"></span>
    <span data-project-running-chip="project"></span>
    <div id="today-list"></div><div id="conversation-list"></div>
    <div id="conversation-action-menu" data-cid="c2"><button data-action="to-project"></button></div>
    </body></html>`);
  await page.goto(pathToFileURL(file).href);
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
