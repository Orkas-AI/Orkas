import { createServer } from 'node:http';
import * as path from 'node:path';
import { expect, OrkasTestApp, test as base } from './fixtures/orkas';

// This journey checks navigation and tool status; GPU overlay rendering has
// separate visual coverage and can emit mailbox errors in hidden fixtures.
const test = base.extend({
  modelOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { softwareRendering: true });
    try { await app.launch(); await use(app); } finally { await app.dispose(); }
  },
});

test('replacing an in-flight navigation does not show failure, while real failure remains visible until recovery', async ({ modelOrkas: orkas }) => {
  let slowRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/slow') { slowRequests++; return; }
    if (req.url === '/failure') { req.socket.destroy(); return; }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Navigation ready</title><h1>Current page loaded</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Navigation status' });
    const cid = created.conversation.conversation_id;
    await orkas.page!.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser');
    }, cid);
    const opened = await orkas.invoke<any>('webAssist.open', { conversationId: cid, url: origin + '/ready' });
    expect(opened.ok).toBe(true);
    await expect.poll(async () => {
      const tab = (await orkas.invoke<any>('webAssist.state', {})).state.tabs
        .find((tab: any) => tab.tab_id === opened.state.active_tab_id);
      return { url: tab?.address_url, loading: tab?.loading };
    }).toEqual({ url: origin + '/ready', loading: false });
    const nativeId = await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }, url) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView && v.webContents.getURL() === url) as InstanceType<typeof WebContentsView>;
      const page = view.webContents;
      const evidence = { rejected: [] as number[], failures: [] as number[] };
      (page as any).__navigationEvidence = evidence;
      const loadURL = page.loadURL.bind(page);
      page.loadURL = (...args) => {
        const promise = loadURL(...args);
        void promise.catch(error => { evidence.rejected.push(error.errno); });
        return promise;
      };
      page.on('did-fail-load', (_event, code, _description, _url, main) => {
        if (main) evidence.failures.push(code);
      });
      return page.id;
    }, origin + '/ready');
    const state = async () => (await orkas.invoke<any>('webAssist.state')).state;
    const browserRoot = path.resolve(__dirname, '../..');
    await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      const require = (process as any).mainModule.require;
      require(args.root + '/src/main/features/web_assist.ts')
        .bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
      require(args.root + '/src/main/features/web_assist_lifecycle.ts')
        .beginBrowserTaskRun('account-e2e', args.cid, 'navigation-wait');
      (globalThis as any).__navigationWaitTool = require(args.root + '/src/main/features/group_chat/browser_tool.ts')
        .buildConversationBrowserTool('account-e2e', args.cid);
    }, { root: browserRoot, cid });
    const wait = (condition: 'loaded' | 'text') => orkas.electronApp!.evaluate(async (_electron, input) => {
      const result = await (globalThis as any).__navigationWaitTool.execute(input, { state: {} });
      return { ...JSON.parse(result.content), isError: result.isError === true };
    }, { operation: 'wait', tab_id: opened.state.active_tab_id, wait_condition: condition,
      ...(condition === 'text' ? { text: 'Current page loaded' } : {}), timeout_ms: 500 });
    const document = () => orkas.electronApp!.evaluate(async ({ webContents }, id) => {
      const page = webContents.fromId(id)!;
      return { loading: page.isLoading(), title: page.getTitle(), text: await page.executeJavaScript('document.querySelector("h1")?.textContent') };
    }, nativeId);
    const evidence = () => orkas.electronApp!.evaluate(({ webContents }, id) => (webContents.fromId(id) as any).__navigationEvidence, nativeId);
    const address = orkas.page!.locator('.web-assist-address-input');
    const status = orkas.page!.locator('.web-assist-status');
    const navigate = async (pathname: string) => {
      await address.fill(origin + pathname);
      await address.press('Enter');
    };
    const ready = async () => {
      await expect.poll(document).toEqual({ loading: false, title: 'Navigation ready', text: 'Current page loaded' });
      await expect.poll(async () => (await state()).loading).toBe(false);
      expect((await state()).error_code).toBeUndefined();
      await expect(status).toHaveText('');
    };
    await ready();
    expect(await wait('loaded')).toMatchObject({ ok: true, isError: false });
    await navigate('/slow');
    await expect.poll(() => slowRequests).toBeGreaterThan(0);
    await navigate('/ready');
    await expect.poll(async () => (await evidence()).rejected).toContain(-3);
    await ready();

    const failureDiagnostics = orkas.rendererDiagnosticCheckpoint();
    await navigate('/failure');
    await expect.poll(async () => (await evidence()).failures).toContain(-324); // ERR_EMPTY_RESPONSE
    await expect.poll(async () => (await state()).error_code).toBe('page_load_failed');
    await expect.poll(async () => (await state()).loading).toBe(false);
    await expect(status).not.toHaveText('');
    for (const result of [await wait('loaded'), await wait('text')]) {
      expect(result).toMatchObject({ ok: false, code: 'page_load_failed', isError: true });
    }
    await navigate('/ready');
    await ready();
    expect(await wait('loaded')).toMatchObject({ ok: true, isError: false });
    expect(await wait('text')).toMatchObject({ ok: true, isError: false });
    await orkas.electronApp!.evaluate(async (_electron, args) => {
      const require = (process as any).mainModule.require;
      require(args.root + '/src/main/features/web_assist_lifecycle.ts')
        .finishBrowserTaskRun('account-e2e', args.cid, 'navigation-wait');
      delete (globalThis as any).__navigationWaitTool;
    }, { root: browserRoot, cid });
    await orkas.acknowledgeNavigationFailure(origin + '/failure', 'ERR_EMPTY_RESPONSE', failureDiagnostics);
  } finally {
    await orkas.invoke('webAssist.close', {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});


for (const transition of ['navigation', 'same-url-reload'] as const) {
  test(`text waits discard old document matches after ${transition} and keep legitimate navigation`, async ({ modelOrkas: orkas }) => {
    let missingStatus = false;
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Cache-Control', 'no-store');
      res.end(`<title>Wait freshness</title><h1>${missingStatus ? 'New document without status' : 'Fixture ready'}</h1>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const root = path.resolve(__dirname, '../..');
    let cid: string | undefined;
    try {
      cid = (await orkas.invoke<any>('conversations.create', { title: 'Wait freshness' })).conversation.conversation_id;
      await orkas.page!.evaluate(async id => {
        await (window as any).loadConversations();
        (window as any).setView('conversation', id);
        (window as any).ConversationInfo.openAndSetTab('browser');
      }, cid);
      const opened = await orkas.invoke<any>('webAssist.open', { conversationId: cid, url: origin + '/old' });
      expect(opened.ok).toBe(true);
      await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.loading).toBe(false);
      await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, args) => {
        await new Promise<void>(resolve => setImmediate(resolve));
        const require = (process as any).mainModule.require;
        const owner = BrowserWindow.getAllWindows()[0];
        const view = owner.contentView.children.find(v => v instanceof WebContentsView && v.webContents.getURL() === args.url) as any;
        const contents = view.webContents;
        const debuggerSession = contents.debugger;
        const original = debuggerSession.sendCommand.bind(debuggerSession);
        const evidence: any = { contents, original, debuggerSession };
        (globalThis as any).__waitFreshnessEvidence = evidence;
        // Delay delivery, not execution: Chromium computes the actual old DOM
        // result before navigation. Later polling remains unmodified.
        debuggerSession.sendCommand = async (method: string, params: any, ...rest: any[]) => {
          const result = await original(method, params, ...rest);
          if (evidence.gate && method === 'Runtime.evaluate' && typeof params?.expression === 'string'
            && params.expression.includes('const expected = String("Fixture ready")')) {
            evidence.gate = false;
            evidence.oldMatched = result.result?.value === true;
            evidence.captured = true;
            return new Promise(resolve => { evidence.release = () => resolve(result); });
          }
          return result;
        };
        require(args.root + '/src/main/features/web_assist.ts')
          .bindWebAssistConversation('account-e2e', args.cid, owner.webContents);
        require(args.root + '/src/main/features/web_assist_lifecycle.ts')
          .beginBrowserTaskRun('account-e2e', args.cid, 'wait-freshness');
        const tool = require(args.root + '/src/main/features/group_chat/browser_tool.ts')
          .buildConversationBrowserTool('account-e2e', args.cid);
        evidence.start = () => {
          evidence.captured = false;
          evidence.gate = true;
          evidence.pending = tool.execute({ operation: 'wait', tab_id: args.tabId,
            wait_condition: 'text', text: 'Fixture ready', timeout_ms: 5000 }, { state: {} })
            .then((result: any) => { evidence.waitResult = { ...JSON.parse(result.content), isError: result.isError === true }; });
        };
        evidence.start();
      }, { root, cid, tabId: opened.state.active_tab_id, url: origin + '/old' });
      const captured = () => orkas.electronApp!.evaluate(() => Boolean((globalThis as any).__waitFreshnessEvidence.captured));
      const releaseAfterNavigation = (url: string) => orkas.electronApp!.evaluate(async (_electron, target) => {
        const evidence = (globalThis as any).__waitFreshnessEvidence;
        await evidence.contents.loadURL(target);
        const text = await evidence.contents.executeJavaScript('document.querySelector("h1")?.textContent');
        evidence.release();
        await evidence.pending;
        return { oldMatched: evidence.oldMatched, currentMatched: String(text).includes('Fixture ready'), result: evidence.waitResult };
      }, url);
      await expect.poll(captured).toBe(true);
      missingStatus = true;
      const rejected = await releaseAfterNavigation(origin + (transition === 'navigation' ? '/new' : '/old'));
      expect(rejected.oldMatched).toBe(true);
      expect(rejected.currentMatched).toBe(false);
      expect(rejected.result).toMatchObject({ ok: false, code: 'wait_timeout', timeout_ms: 5000, isError: true });
      await orkas.electronApp!.evaluate(() => (globalThis as any).__waitFreshnessEvidence.start());
      await expect.poll(captured).toBe(true);
      missingStatus = false;
      const accepted = await releaseAfterNavigation(origin + '/success');
      expect(accepted.oldMatched).toBe(false);
      expect(accepted.currentMatched).toBe(true);
      expect(accepted.result).toMatchObject({ ok: true, condition: 'text', isError: false });
    } finally {
      await orkas.electronApp!.evaluate(async (_electron, args) => {
        const evidence = (globalThis as any).__waitFreshnessEvidence;
        if (evidence) {
          evidence.debuggerSession.sendCommand = evidence.original;
          evidence.release?.();
          delete (globalThis as any).__waitFreshnessEvidence;
        }
        if (args.cid) {
          const require = (process as any).mainModule.require;
          require(args.root + '/src/main/features/web_assist_lifecycle.ts')
            .finishBrowserTaskRun('account-e2e', args.cid, 'wait-freshness');
        }
      }, { root, cid }).catch(() => {});
      await orkas.invoke('webAssist.close', {});
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test('observe discards old DOM after same URL reload and permits fresh observation', async ({ modelOrkas: orkas }) => {
  let text = 'Before the page transition';
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.setHeader('Cache-Control', 'no-store');
    response.end(`<title>Observation diagnostic</title><h1>${text}</h1>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const root = path.resolve(__dirname, '../..');
  let cid: string | undefined;
  try {
    cid = (await orkas.invoke<any>('conversations.create', { title: 'Observation diagnostic' })).conversation.conversation_id;
    await orkas.page!.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser');
    }, cid);
    for (const scope of ['browser', 'connector'] as const) {
      text = 'Before the page transition';
      const url = origin + '/current';
      const opened = await orkas.invoke<any>('webAssist.open', { conversationId: cid, url });
      expect(opened.ok).toBe(true);
      await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.loading).toBe(false);
      const ready = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, args) => {
        await new Promise<void>(resolve => setImmediate(resolve));
        const require = (process as any).mainModule.require;
        const owner = BrowserWindow.getAllWindows()[0];
        const web = require(args.root + '/src/main/features/web_assist.ts');
        const lifecycle = require(args.root + '/src/main/features/web_assist_lifecycle.ts');
        web.bindWebAssistConversation('account-e2e', args.cid, owner.webContents);
        lifecycle.beginBrowserTaskRun('account-e2e', args.cid, 'observe-diagnostic');
        if (args.scope === 'connector') {
          const opened = await web.openControlledWebAssist('account-e2e', args.cid,
            { scope: 'connector_setup', scopeId: 'shop', url: args.url });
          if (!opened.ok) throw new Error('Diagnostic controlled page failed');
          const loaded = await web.waitForControlledWebAssist('account-e2e', args.cid, 'shop',
            { condition: 'loaded', timeoutMs: 5000 });
          if (!loaded.ok) throw new Error('Diagnostic controlled page was not ready');
        }
        const views = owner.contentView.children.filter(v => v instanceof WebContentsView && v.webContents.getURL() === args.url) as any[];
        const contents = views.at(-1).webContents;
        const tool = require(args.root + '/src/main/features/group_chat/browser_tool.ts')
          .buildConversationBrowserTool('account-e2e', args.cid);
        const observe = async () => {
          if (args.scope === 'connector') return web.observeControlledWebAssist('account-e2e', args.cid, 'shop');
          const result = await tool.execute({ operation: 'observe', tab_id: args.tabId }, { state: {} });
          return { ...JSON.parse(result.content), toolIsError: result.isError === true };
        };
        const steady = await observe();
        const debuggerSession = contents.debugger;
        const original = debuggerSession.sendCommand.bind(debuggerSession);
        const evidence: any = { contents, original, debuggerSession, observe, captured: false, gate: true };
        (globalThis as any).__observeFreshness = evidence;
        // Hold a result computed by real Chromium; do not inject DOM evidence.
        debuggerSession.sendCommand = async (method: string, params: any, ...rest: any[]) => {
          const result = await original(method, params, ...rest);
          if (evidence.gate && method === 'Runtime.evaluate' && params?.expression?.includes('elements_truncated:')) {
            evidence.gate = false;
            evidence.oldText = result.result?.value?.text;
            evidence.captured = true;
            return new Promise(resolve => { evidence.release = () => resolve(result); });
          }
          return result;
        };
        evidence.pending = observe();
        return { ok: steady.ok, hasBefore: String(steady.text).includes('Before the page transition') };
      }, { root, cid, scope, url, tabId: opened.state.active_tab_id });
      expect(ready).toEqual({ ok: true, hasBefore: true });
      await expect.poll(() => orkas.electronApp!.evaluate(() => Boolean((globalThis as any).__observeFreshness?.captured))).toBe(true);
      text = 'After the page transition';
      const result = await orkas.electronApp!.evaluate(async (_electron, url) => {
        const evidence = (globalThis as any).__observeFreshness;
        await evidence.contents.loadURL(url);
        const currentText = await evidence.contents.executeJavaScript('document.querySelector("h1")?.textContent');
        evidence.release();
        const result = await evidence.pending;
        const fresh = await evidence.observe();
        evidence.debuggerSession.sendCommand = evidence.original;
        delete (globalThis as any).__observeFreshness;
        return { currentText, oldCaptured: String(evidence.oldText).includes('Before the page transition'),
          oldReturned: String(result.text).includes('Before the page transition'), ok: result.ok, code: result.code, toolIsError: result.toolIsError,
          freshOk: fresh.ok, freshAfter: String(fresh.text).includes('After the page transition') };
      }, url);
      console.log('observe-reload-proof', JSON.stringify({ scope, ...result }));
      // A late old DOM result must not become current page evidence.
      expect(result).toMatchObject({ currentText: 'After the page transition', oldCaptured: true,
        oldReturned: false, ok: false, code: 'page_changed', freshOk: true, freshAfter: true });
      if (scope === 'browser') expect(result.toolIsError).toBe(true);
      await orkas.electronApp!.evaluate(async (_electron, args) => {
        const require = (process as any).mainModule.require;
        require(args.root + '/src/main/features/web_assist_lifecycle.ts')
          .finishBrowserTaskRun('account-e2e', args.cid, 'observe-diagnostic');
      }, { root, cid });
      await orkas.invoke('webAssist.close', {});
    }
  } finally {
    await orkas.electronApp!.evaluate(async (_electron, args) => {
      const evidence = (globalThis as any).__observeFreshness;
      if (evidence) {
        evidence.debuggerSession.sendCommand = evidence.original;
        evidence.release?.();
        await evidence.pending.catch(() => {});
        delete (globalThis as any).__observeFreshness;
      }
      if (args.cid) {
        const require = (process as any).mainModule.require;
        require(args.root + '/src/main/features/web_assist_lifecycle.ts')
          .finishBrowserTaskRun('account-e2e', args.cid, 'observe-diagnostic');
      }
    }, { root, cid }).catch(() => {});
    await orkas.invoke('webAssist.close', {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
