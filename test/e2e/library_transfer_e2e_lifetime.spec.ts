import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, expect, test as base, type Page } from '@playwright/test';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';
import { closeElectronFixture } from './fixtures/electron-cleanup';
import { ownFixtureServer } from './fixtures/server-cleanup';

// Standalone Electron renderer component fixture, generated only in its owned
// temporary profile. Reuse desktop log analysis/teardown; no private Web suite.
const rendererHost = String.raw`
const {app, BrowserWindow} = require('electron');
const fs = require('node:fs');
const record = (level, text, source = 'renderer') => fs.appendFileSync(
  process.env.ORKAS_E2E_RENDERER_LOG, JSON.stringify({level, text:String(text), source}) + '\n');
const show = process.env.PWDEBUG === '1' || process.env.ORKAS_E2E_SHOW_WINDOW === '1';
if (!show && process.platform === 'darwin') app.setActivationPolicy('accessory');
app.setPath('userData', process.env.ORKAS_E2E_USER_DATA_DIR);
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('proxy-server', 'http://127.0.0.1:1');
app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1');
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(() => ({action:'deny'}));
  contents.on('console-message', details => record(details.level, details.message));
  contents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') record('error',details.reason,'renderer-process');
  });
});
process.on('warning', warning => record('warning',warning.name,'node'));
app.whenReady().then(async () => {
  const target = process.env.ORKAS_E2E_RENDERER_URL;
  if (!/^http:\/\/127\.0\.0\.1:\d+\/$/.test(target || '')) throw new Error('Local renderer origin required');
  const win = new BrowserWindow({show,focusable:show,width:1280,height:900,
    webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,
      backgroundThrottling:false,offscreen:!show && process.platform === 'win32'}});
  record('info','isolated renderer host ready','fixture');
  await win.loadURL(target);
}).catch(error => { record('error',error.code || 'STARTUP_FAILED','startup'); app.exit(1); });
app.on('window-all-closed', () => app.quit());
`;

const renderer = path.resolve(__dirname, '../../src/renderer');
const assets = new Set(['style.css', ...['logger', 'i18n', 'icons', 'dropdown-placement', 'utils', 'library-transfer'].map(name => `modules/${name}.js`)]);
const test = base.extend<{ transferPage: Page }>({
  transferPage: async ({}, use, info) => {
    const tables = Object.fromEntries(['en', 'zh'].map(lang => [lang, JSON.parse(readFileSync(path.join(renderer, `locales/${lang}.json`), 'utf8'))]));
    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'");
        res.end(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"><link rel="stylesheet" href="/style.css"></head><body>
          <script src="/__boot.js"></script>
          ${['logger', 'i18n', 'icons', 'dropdown-placement', 'utils', 'library-transfer'].map(name => `<script src="/modules/${name}.js"></script>`).join('')}
          </body></html>`); return;
      }
      if (url.pathname === '/__boot.js') { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end('window.__orkasI18nBoot=' + JSON.stringify({ lang: 'en', tables })); return; }
      const file = url.pathname.slice(1);
      if (assets.has(file)) { res.setHeader('content-type', file.endsWith('.css') ? 'text/css' : 'text/javascript; charset=utf-8'); res.end(readFileSync(path.join(renderer, file))); return; }
      res.writeHead(404); res.end();
    });
    const dispose = ownFixtureServer(server);
    const profile = mkdtempSync(path.join(tmpdir(), 'orkas-transfer-ui-'));
    const hostFile = path.join(profile, 'renderer-host.cjs');
    const nativeLog = info.outputPath('renderer-native.jsonl');
    writeFileSync(hostFile, rendererHost); writeFileSync(nativeLog, '');
    const stdout: string[] = [], stderr: string[] = [];
    let app: Awaited<ReturnType<typeof _electron.launch>> | undefined;
    let page: Page | undefined;
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      app = await _electron.launch({ args: [hostFile],
        env: { ...process.env, ORKAS_E2E_RENDERER_URL: origin + '/', ORKAS_E2E_USER_DATA_DIR: profile, ORKAS_E2E_RENDERER_LOG: nativeLog } });
      app.process().stdout?.on('data', chunk => stdout.push(chunk.toString()));
      app.process().stderr?.on('data', chunk => stderr.push(chunk.toString()));
      await app.context().tracing.start({screenshots:true,snapshots:true});
      page = await app.firstWindow();
      const activePage = page;
      activePage.on('pageerror', error => stderr.push('[renderer:pageerror] ' + error.message + '\n'));
      page.setDefaultTimeout(5_000);
      await page.waitForLoadState('load');
      await page.waitForFunction(() => typeof (window as any).LibraryTransfer?.open === 'function');
      await page.evaluate(() => {
        const w = window as any;
        w.receipts = []; w.requests = []; w.logs = []; w.toasts = []; w.pending = [];
        w.projects = [{ project_id: 'p1', name: 'A long project title — 设计资料与跨项目资料整理' }];
        const tree = [{ type: 'dir', name: 'Archive', relPath: 'archive', children: [] }];
        w.apiFetch = async () => ({ json: async () => ({ ok: true, tree }) });
        w.orkas = {
          invoke: async (method: string, args: any) => {
            if (method === 'projects.list') {
              if (w.failProjects) throw new Error('PRIVATE_PROJECT_LIST_MARKER');
              return w.holdProjects ? new Promise(resolve => w.projectLoads.push(resolve)) : { projects: w.projects };
            }
            if (method === 'projects.files.tree') {
              if (w.failTree) return { error: 'PRIVATE_TREE_MARKER' };
              return w.holdTree ? new Promise(resolve => w.treeLoads.push(resolve)) : { tree };
            }
            if (method !== 'library.transfer') throw new Error('Unexpected fixture IPC');
            w.requests.push(structuredClone(args));
            return new Promise((resolve, reject) => w.pending.push({ resolve, reject }));
          },
          log: (record: any) => w.logs.push(record),
        };
        w.uiToast = (message: string, options: any) => w.toasts.push({ message, options });
        w.begin = (extra = {}) => w.LibraryTransfer.open({ source: { scope: 'global' }, paths: ['note.md'],
          onComplete: (result: any) => { w.receipts.push(result); if (w.failRefresh) throw new Error('PRIVATE_TRANSFER_CONTENT_MARKER'); }, ...extra });
        w.finish = (result = { ok: true, succeeded: 1, failed: 0, results: [{ ok: true, source: 'note.md', destination: 'archive/note.md' }] }) => w.pending.shift().resolve(result);
      });
      await use(page);
    } finally {
      const bridge = page && !page.isClosed() ? await page.evaluate(() => (window as any).logs || []).catch(() => []) : [];
      try {
        if (app) await closeElectronFixture(app, info.outputPath('renderer-trace.zip'));
      } finally {
        await dispose(); rmSync(profile, { recursive: true, force: true });
        const native = existsSync(nativeLog) ? readFileSync(nativeLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
        const raw = [
          ...native.map(row => `[renderer:${row.level}] ${row.text}`),
          ...bridge.map((row: any) => `[00:00:00.000] [${row.level}] [(renderer/${row.module})] ${row.message} ${JSON.stringify(row.data || {})}`),
          ...stdout.join('').split(/\r?\n/).filter(Boolean).map(line => `[main:stdout] ${line}`),
          ...stderr.join('').split(/\r?\n/).filter(Boolean).map(line => line.startsWith('[renderer:') ? line : `[main:stderr] ${line}`),
        ].join('\n');
        writeFileSync(info.outputPath('renderer-complete.log'), raw);
        const analysis = analyzeWebAppLogs(raw);
        writeFileSync(info.outputPath('log-analysis.json'), JSON.stringify(analysis, null, 2));
        await info.attach('renderer-log-analysis', {body:JSON.stringify(analysis),contentType:'application/json'});
        expect(analysis.passed, 'Review all native, renderer and bridge log findings').toBe(true);
        if (analysis.requiresReview) info.annotations.push({type:'renderer-log-warning',description:JSON.stringify(analysis.findings)});
      }
    }
  },
});
const confirm = (page: Page) => page.locator('[data-transfer-confirm]');
async function open(page: Page) { await page.evaluate(async () => { const w = window as any; w.handle = await w.begin(); }); await expect(confirm(page)).toBeEnabled(); }
async function chooseProject(page: Page) {
  await page.locator('[data-transfer-library] .ai-select-trigger').click();
  await page.locator('[role="option"][data-value="project:p1"]').click();
}

test('the in-flight request owns its mode, destination and receipt', async ({ transferPage: page }) => {
  await open(page); await page.locator('[data-folder-path="archive"]').click(); await confirm(page).click();
  // Actual controls used to remain editable while Main was still moving files.
  await page.locator('[data-transfer-mode="copy"]').evaluate((input: HTMLInputElement) => { input.click(); });
  await page.locator('[data-folder-path=""]').evaluate((button: HTMLButtonElement) => button.click());
  await page.evaluate(() => (window as any).finish());
  await expect(page.locator('#library-transfer-overlay')).toHaveCount(0);
  const state = await page.evaluate(() => { const w = window as any; return { requests: w.requests, receipts: w.receipts, toast: w.toasts.at(-1) }; });
  expect(state.requests).toEqual([{ mode: 'move', source: { scope: 'global' }, paths: ['note.md'], destination: { scope: 'global', dir: 'archive' } }]);
  expect(state.receipts[0]).toMatchObject({ mode: 'move', destination: state.requests[0].destination });
  expect(state.toast.message).toContain('Moved');
});

test('a destination reload cannot reopen the destructive submit while it is pending', async ({ transferPage: page }) => {
  await open(page); await confirm(page).click();
  // Attempt real native user selection if it is still available.
  if (await page.locator('[data-transfer-library] .ai-select-trigger').isEnabled()) await chooseProject(page);
  await expect(confirm(page)).toBeDisabled();
  await confirm(page).evaluate((button: HTMLButtonElement) => button.click());
  expect(await page.evaluate(() => (window as any).requests.length)).toBe(1);
  await page.evaluate(() => (window as any).finish());
  await expect(page.locator('#library-transfer-overlay')).toHaveCount(0);
});

test('only the latest open mounts', async ({ transferPage: page }) => {
  await page.evaluate(() => { const w = window as any; w.holdProjects = true; w.projectLoads = []; w.first = w.begin(); w.second = w.begin(); });
  await page.evaluate(async () => { const w = window as any; w.projectLoads[1]({ projects: w.projects }); await w.second; w.projectLoads[0]({ projects: w.projects }); await w.first; });
  await expect(page.locator('#library-transfer-overlay')).toHaveCount(1);
});

test('closing also disposes the portaled select', async ({ transferPage: page }) => {
  await open(page);
  await page.locator('[data-transfer-library] .ai-select-trigger').click();
  await expect(page.locator('body > .ai-select-popover')).toBeVisible();
  await page.evaluate(() => (window as any).handle.close());
  await expect(page.locator('#library-transfer-overlay')).toHaveCount(0);
  await expect(page.locator('body > .ai-select-popover')).toHaveCount(0);
});

test('closing a loading destination cannot affect the replacement dialog', async ({ transferPage: page }) => {
  await open(page);
  await page.evaluate(() => { const w = window as any; w.holdTree = true; w.treeLoads = []; });
  await chooseProject(page); await expect(confirm(page)).toBeDisabled();
  await page.locator('[data-transfer-cancel]').click(); await open(page);
  await page.evaluate(() => { const w = window as any; w.treeLoads[0]({ tree: [{ type: 'dir', name: 'Obsolete', relPath: 'obsolete' }] }); });
  await expect(confirm(page)).toBeEnabled();
  await expect(page.locator('[data-transfer-library]')).toHaveAttribute('data-value', 'global');
  await expect(page.locator('[data-folder-path="obsolete"]')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(page.locator('#library-transfer-overlay')).toHaveCount(0);
});

test('failed destination loading blocks submission and permits switching to a usable Library', async ({ transferPage: page }) => {
  await open(page); await page.evaluate(() => { (window as any).failTree = true; }); await chooseProject(page);
  await expect(confirm(page)).toBeDisabled(); await expect(page.locator('[data-transfer-error]')).toBeVisible();
  expect(await page.locator('[data-transfer-error]').textContent()).not.toContain('PRIVATE_TREE_MARKER');
  await page.locator('[data-transfer-library] .ai-select-trigger').click();
  await page.getByRole('option').filter({ hasText: 'Global' }).click();
  await expect(confirm(page)).toBeEnabled(); await expect(page.locator('[data-transfer-error]')).toBeHidden();
  expect(await page.evaluate(() => (window as any).requests.length)).toBe(0);
});

test('a project-list failure retains the usable global Library without raw error text', async ({ transferPage: page }) => {
  await page.evaluate(() => { (window as any).failProjects = true; }); await open(page);
  await page.locator('[data-transfer-library] .ai-select-trigger').click();
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.getByRole('option').click(); await confirm(page).click(); await page.evaluate(() => (window as any).finish());
  await expect(page.locator('#library-transfer-overlay')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).receipts.length)).toBe(1);
});

for (const outcome of ['rejection', 'failure', 'zero', 'partial']) {
  test(`${outcome} keeps the real retry/partial-result contract`, async ({ transferPage: page }) => {
    await open(page); await confirm(page).click();
    await page.evaluate(outcome => {
      const w = window as any;
      if (outcome === 'rejection') w.pending.shift().reject(new Error('PRIVATE_TRANSFER_CONTENT_MARKER'));
      else if (outcome === 'failure') w.finish({ ok: false, error: 'target_exists' });
      else w.finish({ ok: true, succeeded: outcome === 'partial' ? 1 : 0, failed: 1, results: [{ ok: false, error: 'target_exists' }] });
    }, outcome);
    if (outcome === 'partial') {
      await expect(page.locator('#library-transfer-overlay')).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).receipts.length)).toBe(1);
      expect(await page.evaluate(() => (window as any).toasts[0].options.variant)).toBe('warning');
    } else {
      await expect(confirm(page)).toBeEnabled(); await expect(page.locator('[data-transfer-error]')).toBeVisible();
      expect(await page.evaluate(() => (window as any).receipts.length)).toBe(0);
      await page.locator('[data-transfer-mode="copy"]').check(); await chooseProject(page);
      await page.locator('[data-folder-path="archive"]').click(); await confirm(page).click();
      await page.evaluate(() => (window as any).finish());
      await expect(page.locator('#library-transfer-overlay')).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).requests[1])).toMatchObject({ mode: 'copy', destination: { scope: 'project', projectId: 'p1', dir: 'archive' } });
    }
  });
}

test('a completed old transfer leaves the replacement dialog and reports only a closed refresh diagnostic', async ({ transferPage: page }) => {
  await open(page); await confirm(page).click(); await page.locator('[data-transfer-cancel]').click();
  await page.evaluate(() => { (window as any).failRefresh = true; });
  await open(page); await page.evaluate(() => (window as any).finish());
  await expect.poll(() => page.evaluate(() => (window as any).logs.length)).toBe(1);
  await expect(page.locator('#library-transfer-overlay')).toHaveCount(1);
  await expect(confirm(page)).toBeEnabled();
  const logs = await page.evaluate(() => (window as any).logs);
  expect(logs[0]).toMatchObject({ level: 'warn', module: 'library-transfer', message: 'refresh after library transfer failed' });
  expect(JSON.stringify(logs)).not.toContain('PRIVATE_TRANSFER_CONTENT_MARKER');
});

test('normal and narrow dialog layouts keep localized actions reachable while pending', async ({ transferPage: page }, info) => {
  for (const [lang, width, height] of [['en', 1280, 900], ['zh', 800, 600]] as const) {
    await page.setViewportSize({ width, height });
    // Locale is a shared lexical binding, setLang uses persistence; control that boundary.
    await page.evaluate(async lang => { const w = window as any; w.orkas.setLanguage = async () => ({ ok: true, language: lang }); await w.setLang(lang); }, lang);
    await open(page);
    await expect(page.locator('#library-transfer-title')).toHaveText(lang === 'zh' ? '移动或复制' : 'Move or copy');
    await expect(page.locator('[data-transfer-cancel]')).toHaveText(lang === 'zh' ? '取消' : 'Cancel');
    await chooseProject(page); await confirm(page).click();
    const bounds = await page.locator('.library-transfer-dialog').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
    await expect(page.locator('[data-transfer-cancel]')).toBeVisible(); await expect(confirm(page)).toBeVisible();
    await page.screenshot({ path: info.outputPath(`library-transfer-${lang}-${width}-pending.png`) });
    await page.evaluate(() => (window as any).finish()); await expect(page.locator('#library-transfer-overlay')).toHaveCount(0);
  }
});
