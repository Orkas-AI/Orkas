import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test as base, OrkasTestApp } from './fixtures/orkas';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';

// Keep every native stream on successful cases too. Unexpected errors or
// incomplete analysis fail the case; recoverable warnings remain reviewable.
const test = base.extend({
  orkas: async ({}, use, info) => {
    const previous = process.env.ORKAS_E2E_KEEP_LOGS;
    process.env.ORKAS_E2E_KEEP_LOGS = '1';
    const app = new OrkasTestApp(info, { });
    try { await app.launch(); await use(app); }
    finally {
      try { await app.dispose(); }
      finally {
        if (previous === undefined) delete process.env.ORKAS_E2E_KEEP_LOGS;
        else process.env.ORKAS_E2E_KEEP_LOGS = previous;
        const logPath = info.outputPath('electron-main.log');
        expect(existsSync(logPath)).toBe(true);
        const analysis = analyzeWebAppLogs(readFileSync(logPath, 'utf8'));
        writeFileSync(info.outputPath('log-analysis.json'), JSON.stringify(analysis, null, 2));
        expect(analysis.passed, 'Review retained connector browser log findings').toBe(true);
      }
    }
  },
});

const root = path.resolve(__dirname, '../..');
const connectorId = 'fixture-shop';

async function prepare(orkas: OrkasTestApp, url: string) {
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Connector browser continuity' })).conversation.conversation_id;
  await orkas.page!.evaluate(async id => {
    await (window as any).loadConversations();
    (window as any).setView('conversation', id);
  }, cid);
  await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
    await new Promise<void>(resolve => setImmediate(resolve));
    const req = (process as any).mainModule.require;
    const web = req(args.root + '/src/main/features/web_assist.ts');
    web.bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
    req(args.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', args.cid, 'connector-browser-run');
    const entry = { id: args.connectorId, display_name: 'Fixture shop', category: 'commerce', auth_mode: 'local_api',
      connection_setup: { requirement: 'provider_application', guide_url: args.url }, allowed_tools: [] };
    (globalThis as any).__connectorBrowserTools = {
      setup: req(args.root + '/src/main/features/group_chat/connector_setup_tool.ts').buildConnectorSetupTool({
        uid: 'account-e2e', language: 'en', stageConfigure: () => ({ ok: true }),
        dependencies: { catalog: () => [entry], instances: () => [], enabledSnapshot: () => ({ connectors: {} }) },
        openGuide: input => web.openControlledWebAssist('account-e2e', args.cid, {
          scope: 'connector_setup', scopeId: input.connectorId, url: input.url,
        }),
        observePage: id => web.observeControlledWebAssist('account-e2e', args.cid, id),
        actPage: (id, input, signal) => {
          const lifetime = { signal, isActive: () => req(args.root + '/src/main/features/web_assist_lifecycle.ts')
            .browserTaskRunId('account-e2e', args.cid) === 'connector-browser-run' };
          if (['back', 'forward', 'reload', 'close'].includes(input.page_action)) {
            return web.navigateControlledWebAssist('account-e2e', args.cid, id, input.page_action, lifetime);
          }
          return web.actOnControlledWebAssist('account-e2e', args.cid, id, {
            pageId: input.page_id, elementRef: input.element_ref, action: input.page_action, text: input.text,
          }, lifetime);
        },
        waitPage: (id, input, signal) => web.waitForControlledWebAssist('account-e2e', args.cid, id, {
          condition: input.wait_condition || 'loaded', text: input.text, timeoutMs: input.timeout_ms,
        }, { signal, isActive: () => req(args.root + '/src/main/features/web_assist_lifecycle.ts')
          .browserTaskRunId('account-e2e', args.cid) === 'connector-browser-run' }),
      }),
      browser: req(args.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', args.cid),
    };
  }, { root, cid, url, connectorId });
  const call = async (tool: 'setup' | 'browser', input: Record<string, unknown>): Promise<any> => {
    const result = await orkas.electronApp!.evaluate(async (_electron, args) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      return (globalThis as any).__connectorBrowserTools[args.tool].execute(args.input, {});
    }, { tool, input });
    return { ...JSON.parse(result.content), images: result.images, isError: result.isError };
  };
  const setup = (input: Record<string, unknown>) => call('setup', { connector_id: connectorId, ...input });
  const browser = (input: Record<string, unknown>) => call('browser', input);
  expect(await setup({ operation: 'show' })).toMatchObject({ ok: true, web_assist: { opened: true } });
  expect(await setup({ operation: 'page_wait' })).toMatchObject({ ok: true });
  const initial = await setup({ operation: 'page_observe' });
  expect(initial.ok).toBe(true);
  return { cid, setup, browser, initial, tabId: initial.tab_id as string };
}

test('connector setup continues through browser readback, visual navigation and an embedded application form', async ({ orkas }) => {
  const consoleHits: Array<{ app: string; trusted: boolean }> = [];
  const saved: string[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/console?')) {
      const query = new URL(request.url, 'http://localhost').searchParams;
      consoleHits.push({ app: query.get('app') || '', trusted: query.get('trusted') === 'true' });
      response.end('Console reached'); return;
    }
    if (request.url === '/save') {
      let body = '';
      request.on('data', chunk => { body += chunk.toString(); });
      request.on('end', () => { saved.push(body); response.end('Saved'); });
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/application') {
      response.end(`<!doctype html><form><input aria-label="Callback"><button>Save application</button></form>
        <script>document.querySelector('form').addEventListener('submit',async event=>{event.preventDefault();
          await fetch('/save',{method:'POST',body:document.querySelector('input').value});})</script>`);
      return;
    }
    response.end(`<!doctype html><style>body{margin:0}input{position:absolute;left:80px;top:10px;width:240px;height:30px}
      #console{position:absolute;left:80px;top:80px;width:150px;height:40px;background:#ccc}
      iframe{display:none;position:absolute;left:80px;top:160px;width:450px;height:220px}</style>
      <input aria-label="Application name"><div id="console">Console</div><iframe src="/application"></iframe>
      <script>document.getElementById('console').addEventListener('click',event=>{
        fetch('/console?app='+encodeURIComponent(document.querySelector('input').value)+'&trusted='+event.isTrusted);
        document.querySelector('iframe').style.display='block';})</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    const { cid, setup, browser, initial, tabId } = await prepare(orkas, url);
    const field = initial.elements.find((element: any) => element.label === 'Application name');
    expect(await setup({ operation: 'page_act', page_id: initial.page_id, element_ref: field.ref,
      page_action: 'fill', text: 'Pending application' })).toMatchObject({ ok: true });
    expect(await browser({ operation: 'read_value', tab_id: tabId, page_id: initial.page_id, element_ref: field.ref }))
      .toMatchObject({ ok: true, value: 'Pending application' });
    expect(await setup({ operation: 'page_observe' })).toMatchObject({ ok: true, tab_id: tabId });
    expect(await setup({ operation: 'show' })).toMatchObject({ web_assist: { opened: true } });
    expect((await browser({ operation: 'tabs' })).tabs.map((tab: any) => tab.tab_id)).toEqual([tabId]);

    const observation = await browser({ operation: 'observe', tab_id: tabId });
    // The site's listener-only div has no DOM control ref; native pixels/input
    // must reach it without a user click or a second configuration page.
    expect(observation.elements.some((element: any) => element.label === 'Console')).toBe(false);
    const screenshot = await browser({ operation: 'screenshot', tab_id: tabId });
    expect(screenshot.ok, JSON.stringify({ ok: screenshot.ok, code: screenshot.code })).toBe(true);
    expect(screenshot.images).toHaveLength(1);
    const click = { operation: 'act', tab_id: tabId, page_id: screenshot.page_id, page_action: 'click', point: [140, 100] };
    expect(await browser(click)).toMatchObject({ ok: true });
    await expect.poll(() => consoleHits).toEqual([{ app: 'Pending application', trusted: true }]);
    expect(await browser(click)).toMatchObject({ ok: false, code: 'stale_page' });
    expect(await setup({ operation: 'page_observe' })).toMatchObject({ ok: true, tab_id: tabId });
    expect(consoleHits).toHaveLength(1);

    const main = await browser({ operation: 'observe', tab_id: tabId });
    const frameId = main.frames.find((frame: any) => frame.display_url === url + 'application').frame_id;
    const form = await browser({ operation: 'observe', tab_id: tabId, frame_id: frameId });
    expect(await browser({ operation: 'act', tab_id: tabId, page_id: form.page_id,
      element_ref: form.elements.find((element: any) => element.label === 'Callback').ref,
      page_action: 'fill', text: 'Exact callback draft' })).toMatchObject({ ok: true });
    const submit = { operation: 'page_act', page_id: form.page_id,
      element_ref: form.elements.find((element: any) => element.label === 'Save application').ref, page_action: 'click' };
    expect(await setup(submit)).toMatchObject({ ok: true });
    await expect.poll(() => saved).toEqual(['Exact callback draft']);
    expect(await setup(submit)).toMatchObject({ ok: false, code: 'stale_page', isError: true });
    await orkas.electronApp!.evaluate((_electron, args) => {
      (process as any).mainModule.require(args.root + '/src/main/features/web_assist_lifecycle.ts')
        .finishBrowserTaskRun('account-e2e', args.cid, 'connector-browser-run');
    }, { root, cid });
    expect(await browser({ operation: 'observe', tab_id: tabId })).toMatchObject({ ok: false, code: 'task_run_ended' });
    await orkas.electronApp!.evaluate((_electron, args) => {
      const req = (process as any).mainModule.require;
      req(args.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', args.cid, 'connector-browser-resumed');
      (globalThis as any).__connectorBrowserTools.browser = req(args.root + '/src/main/features/group_chat/browser_tool.ts')
        .buildConversationBrowserTool('account-e2e', args.cid);
    }, { root, cid });
    expect(await setup({ operation: 'show' })).toMatchObject({ web_assist: { opened: true } });
    expect((await browser({ operation: 'tabs' })).tabs.map((tab: any) => tab.tab_id)).toEqual([tabId]);
    expect(saved).toEqual(['Exact callback draft']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('connector continuity keeps foreign tasks isolated and explicit browser destinations unbound', async ({ orkas }) => {
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html'); response.end('<input aria-label="Application name">');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    const { cid, setup, browser, initial, tabId } = await prepare(orkas, url);
    const otherCid = (await orkas.invoke<any>('conversations.create', { title: 'Other setup task' })).conversation.conversation_id;
    const foreign = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      const web = (process as any).mainModule.require(args.root + '/src/main/features/web_assist.ts');
      web.bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
      const opened = await web.openControlledWebAssist('account-e2e', args.cid, { scope: 'connector_setup', scopeId: args.connectorId, url: args.url });
      if (opened.ok) {
        const loaded = await web.waitForControlledWebAssist('account-e2e', args.cid, args.connectorId, { condition: 'loaded' });
        if (!loaded.ok) throw new Error(JSON.stringify({ code: loaded.code }));
      }
      return opened;
    }, { root, cid: otherCid, connectorId, url: url + 'foreign' });
    expect(foreign.ok).toBe(true);
    expect(await browser({ operation: 'observe', tab_id: foreign.state.active_tab_id }))
      .toMatchObject({ ok: false, code: 'unknown_tab' });
    expect(await setup({ operation: 'page_observe' })).toMatchObject({ ok: true, tab_id: tabId });
    expect(await browser({ operation: 'navigate', tab_id: tabId, navigation: 'goto', url: 'file:///private' }))
      .toMatchObject({ ok: false });
    expect(await setup({ operation: 'page_observe' })).toMatchObject({ ok: true, tab_id: tabId });
    expect(await browser({ operation: 'navigate', tab_id: tabId, navigation: 'goto', url: url + 'unrelated' }))
      .toMatchObject({ ok: true });
    expect(await browser({ operation: 'wait', tab_id: tabId })).toMatchObject({ ok: true });
    expect(await setup({ operation: 'page_observe' })).toMatchObject({ ok: false, code: 'scope_mismatch', isError: true });
    expect(await browser({ operation: 'act', tab_id: tabId, page_id: initial.page_id,
      element_ref: initial.elements[0].ref, page_action: 'fill', text: 'Stale write' }))
      .toMatchObject({ ok: false, code: 'stale_page' });
    const other = await orkas.electronApp!.evaluate(async (_electron, args) => (
      (process as any).mainModule.require(args.root + '/src/main/features/web_assist.ts')
        .observeControlledWebAssist('account-e2e', args.cid, args.connectorId)
    ), { root, cid: otherCid, connectorId });
    expect(other, JSON.stringify({ ok: other.ok, code: other.code })).toMatchObject({ ok: true, tab_id: foreign.state.active_tab_id });
    expect((await browser({ operation: 'tabs' })).tabs.map((tab: any) => tab.tab_id)).toEqual([tabId]);
    expect(cid).not.toBe(otherCid);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('setup restart preserves the native draft when another debugger makes page observation unavailable', async ({ orkas }) => {
  let pageLoads = 0;
  const server = createServer((_request, response) => {
    pageLoads += 1;
    response.setHeader('Content-Type', 'text/html');
    response.end('<input aria-label="Application name">');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    const { setup, browser, initial, tabId } = await prepare(orkas, url);
    expect(await setup({ operation: 'page_act', page_id: initial.page_id,
      element_ref: initial.elements[0].ref, page_action: 'fill', text: 'Retained application draft' })).toMatchObject({ ok: true });
    const loadedBefore = pageLoads;
    await orkas.electronApp!.evaluate(async ({ webContents }, args) => {
      const contents = webContents.getAllWebContents().find(contents => contents.getURL() === args.url)!;
      const protocol = (process as any).mainModule.require(args.root + '/src/main/features/web_assist_protocol.ts');
      if (contents.debugger.isAttached()) contents.debugger.detach();
      await new Promise<void>(resolve => setImmediate(resolve));
      if (protocol.ownsWebAssistDebugger(contents)) throw new Error('Fixture debugger ownership did not clear');
      contents.debugger.attach('1.3');
      (globalThis as any).__connectorObservationFault = contents;
    }, { root, url });
    expect(await setup({ operation: 'page_observe' })).toMatchObject({ ok: false, code: 'observation_failed' });
    expect(await setup({ operation: 'show' })).toMatchObject({ ok: true, web_assist: { opened: true },
      connector: { connection: { configured: false, status: 'not_configured' } } });
    expect((await browser({ operation: 'tabs' })).tabs.map((tab: any) => tab.tab_id)).toEqual([tabId]);
    const retained = await orkas.electronApp!.evaluate(async (_electron, args) => {
      const contents = (globalThis as any).__connectorObservationFault;
      const protocol = (process as any).mainModule.require(args.root + '/src/main/features/web_assist_protocol.ts');
      return { value: await contents.executeJavaScript('document.querySelector("input").value'),
        debuggerAttached: contents.debugger.isAttached(), debuggerOwned: protocol.ownsWebAssistDebugger(contents) };
    }, { root });
    expect(retained).toEqual({ value: 'Retained application draft', debuggerAttached: true, debuggerOwned: false });
    expect(pageLoads).toBe(loadedBefore);
    expect(await setup({ operation: 'page_act', page_id: initial.page_id,
      element_ref: initial.elements[0].ref, page_action: 'fill', text: 'Stale replacement' }))
      .toMatchObject({ ok: false, code: 'stale_page' });
    await orkas.electronApp!.evaluate(() => {
      (globalThis as any).__connectorObservationFault.debugger.detach();
      delete (globalThis as any).__connectorObservationFault;
    });
    const resumed = await setup({ operation: 'page_observe' });
    expect(resumed).toMatchObject({ ok: true, tab_id: tabId });
    expect(await browser({ operation: 'read_value', tab_id: tabId, page_id: resumed.page_id,
      element_ref: resumed.elements[0].ref })).toMatchObject({ ok: true, value: 'Retained application draft' });
  } finally {
    await orkas.electronApp!.evaluate(() => {
      const contents = (globalThis as any).__connectorObservationFault;
      if (contents && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
      delete (globalThis as any).__connectorObservationFault;
    });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('connector setup resumes after native login and OTP handback without losing a draft or repeating submission', async ({ orkas }) => {
  const logins: boolean[] = [];
  const loginAttempts: boolean[] = [];
  const verifications: Array<{ trusted: boolean; draft: string }> = [];
  const saved: Array<{ trusted: boolean; draft: string }> = [];
  let loginLoads = 0;
  let applicationLoads = 0;
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.method === 'POST') {
      let body = '';
      request.on('data', chunk => { body += chunk.toString(); });
      request.on('end', () => {
        const data = new URLSearchParams(body);
        if (request.url === '/login') {
          loginAttempts.push(data.get('password') === 'shopsecret');
          if (data.get('password') !== 'shopsecret') { response.writeHead(403); response.end(); return; }
          logins.push(data.get('trusted') === 'true');
          response.writeHead(303, { 'Set-Cookie': 'fixture_shop_login=1; Path=/; SameSite=Lax', Location: '/application' });
          response.end(); return;
        }
        if (!request.headers.cookie?.includes('fixture_shop_login=1')) { response.writeHead(403); response.end(); return; }
        const receipt = { trusted: data.get('trusted') === 'true', draft: data.get('draft') || '' };
        if (request.url === '/verify' && data.get('code') === '741852') {
          verifications.push(receipt); response.end('Verification complete'); return;
        }
        if (request.url === '/save' && verifications.length === 1) {
          saved.push(receipt); response.end('Application saved'); return;
        }
        response.writeHead(403); response.end();
      });
      return;
    }
    if (!request.headers.cookie?.includes('fixture_shop_login=1')) {
      loginLoads += 1;
      response.end(`<!doctype html><form method="POST" action="/login">
        <label>Shop password<input name="password" type="password" autocomplete="current-password"></label>
        <input name="trusted" type="hidden"><button>Log in</button></form>
        <script>document.querySelector('form').addEventListener('submit',event=>{
          document.querySelector('[name=trusted]').value=String(event.isTrusted);});</script>`);
      return;
    }
    applicationLoads += 1;
    response.end(`<!doctype html><form id="application"><label>Application name<input id="draft"></label>
      <button>Save application</button></form><section id="challenge" hidden>
      <form id="verification"><label>Verification code<input id="code" autocomplete="one-time-code"></label>
      <button>Verify code</button></form></section><output id="result"></output><script>
      let verified=false;
      application.addEventListener('submit',async event=>{event.preventDefault();
        if(!verified){challenge.hidden=false;return;}
        result.textContent=await (await fetch('/save',{method:'POST',body:new URLSearchParams({draft:draft.value,trusted:event.isTrusted})})).text();});
      verification.addEventListener('submit',async event=>{event.preventDefault();
        const response=await fetch('/verify',{method:'POST',body:new URLSearchParams({code:code.value,draft:draft.value,trusted:event.isTrusted})});
        if(response.ok){verified=true;challenge.hidden=true;result.textContent=await response.text();}});
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  try {
    const { setup, browser, initial, tabId } = await prepare(orkas, url);
    await orkas.page!.evaluate(() => (window as any).ConversationInfo.openAndSetTab('browser'));
    await expect(orkas.page!.locator('.web-assist-shell')).toBeVisible();
    // The runner starts an invisible, non-focusable window. A real human step
    // needs a painted native widget; DOM visibility alone does not provide one.
    await orkas.electronApp!.evaluate(({ BrowserWindow }) => {
      const owner = BrowserWindow.getAllWindows()[0];
      owner.setFocusable(true); owner.show(); owner.focus();
    });
    // The human actor uses Electron input, so the production activity lease and
    // trusted provider events run. DOM access only positions this fixture actor.
    const human = (selector: string, text?: string) => orkas.electronApp!.evaluate(async ({ BrowserWindow, webContents }, args) => {
      const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(args.url))!;
      contents.focus();
      const point = await contents.executeJavaScript(`(() => {
        const element=document.querySelector(${JSON.stringify(args.selector)}); element.focus();
        if(element.select) element.select(); const rect=element.getBoundingClientRect();
        return {x:rect.x+rect.width/2,y:rect.y+rect.height/2,width:window.innerWidth};
      })()`);
      if (args.text !== undefined) {
        for (const character of args.text) {
          contents.sendInputEvent({ type: 'keyDown', keyCode: character });
          contents.sendInputEvent({ type: 'char', keyCode: character });
          contents.sendInputEvent({ type: 'keyUp', keyCode: character });
        }
      } else {
        // The emulated desktop is scaled into the native drawer. Position the
        // human pointer in widget coordinates without an assistant input marker.
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find(view =>
          (view as any).webContents === contents)!;
        const scale = view.getBounds().width / point.width;
        const position = { x: Math.round(point.x * scale), y: Math.round(point.y * scale) };
        contents.sendInputEvent({ type: 'mouseMove', ...position });
        contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 });
        contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 });
      }
    }, { url, selector, text });
    const password = initial.elements.find((element: any) => element.label === 'Shop password');
    expect(await browser({ operation: 'read_value', tab_id: tabId, page_id: initial.page_id, element_ref: password.ref }))
      .toMatchObject({ ok: false, code: 'value_not_readable' });
    await human('[name=password]', 'shopsecret');
    await expect.poll(() => orkas.electronApp!.evaluate(async ({ webContents }, args) => {
      const contents = webContents.getAllWebContents().find(contents => contents.getURL().startsWith(args.url))!;
      return contents.executeJavaScript('document.querySelector("[name=password]").value === "shopsecret"');
    }, { url })).toBe(true);
    await expect.poll(async () => (await browser({ operation: 'tabs' })).tabs[0].user_controlled).toBe(true);
    expect(await setup({ operation: 'page_act', page_id: initial.page_id,
      element_ref: initial.elements.find((element: any) => element.label === 'Log in').ref, page_action: 'click' }))
      .toMatchObject({ ok: false, code: 'user_controlled', isError: true });
    expect(logins).toEqual([]);
    await human('button');
    await expect.poll(() => logins).toEqual([true]);
    expect(loginAttempts).toEqual([true]);
    // The human returns to the conversation after login. Keep the page's full
    // idle lease; only native focus changes, as when typing an acknowledgement.
    await orkas.electronApp!.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.focus());
    expect(await setup({ operation: 'show' })).toMatchObject({ web_assist: { opened: true } });
    expect((await browser({ operation: 'tabs' })).tabs.map((tab: any) => tab.tab_id)).toEqual([tabId]);
    const loginReady = await setup({ operation: 'page_wait' });
    expect(loginReady, `Login continuation: ${loginReady.code || 'ready'}; timeout=${loginReady.timeout_ms || 0}`)
      .toMatchObject({ ok: true });
    const application = await setup({ operation: 'page_observe' });
    expect(application).toMatchObject({ ok: true, tab_id: tabId });
    expect(await setup({ operation: 'page_act', page_id: initial.page_id, element_ref: password.ref,
      page_action: 'fill', text: 'Stale login input' })).toMatchObject({ ok: false, code: 'stale_page', isError: true });
    const draft = application.elements.find((element: any) => element.label === 'Application name');
    expect(await setup({ operation: 'page_act', page_id: application.page_id, element_ref: draft.ref,
      page_action: 'fill', text: 'Retained merchant application' })).toMatchObject({ ok: true });
    const save = { operation: 'page_act', page_id: application.page_id,
      element_ref: application.elements.find((element: any) => element.label === 'Save application').ref, page_action: 'click' };
    expect(await setup(save)).toMatchObject({ ok: true });
    expect(saved).toEqual([]);
    const challenge = await setup({ operation: 'page_observe' });
    const code = challenge.elements.find((element: any) => element.label === 'Verification code');
    expect(code).toBeTruthy();
    expect(await browser({ operation: 'read_value', tab_id: tabId, page_id: challenge.page_id, element_ref: code.ref }))
      .toMatchObject({ ok: false, code: 'value_not_readable' });
    await human('#code', '741852');
    await expect.poll(async () => (await browser({ operation: 'tabs' })).tabs[0].user_controlled).toBe(true);
    expect(await setup({ operation: 'page_act', page_id: challenge.page_id,
      element_ref: challenge.elements.find((element: any) => element.label === 'Verify code').ref, page_action: 'click' }))
      .toMatchObject({ ok: false, code: 'user_controlled', isError: true });
    const duringInput = await setup({ operation: 'page_observe' });
    expect(await browser({ operation: 'read_value', tab_id: tabId, page_id: duringInput.page_id,
      element_ref: duringInput.elements.find((element: any) => element.label === 'Verification code').ref }))
      .toMatchObject({ ok: false, code: 'user_controlled' });
    expect(verifications).toEqual([]);
    await human('#verification button');
    await expect.poll(() => verifications).toEqual([{ trusted: true, draft: 'Retained merchant application' }]);
    expect(await setup({ operation: 'show' })).toMatchObject({ web_assist: { opened: true } });
    // Recovery must also work with this task hidden, without another chrome click.
    await orkas.page!.evaluate(() => (window as any).setView('connectors'));
    expect(await setup({ operation: 'page_wait', wait_condition: 'text', text: 'Verification complete' })).toMatchObject({ ok: true });
    expect(await setup({ operation: 'page_act', page_id: duringInput.page_id, element_ref: code.ref,
      page_action: 'fill', text: 'Stale verification input' })).toMatchObject({ ok: false, code: 'stale_page', isError: true });
    const resumed = await setup({ operation: 'page_observe' });
    expect(resumed).toMatchObject({ ok: true, tab_id: tabId });
    expect(await browser({ operation: 'read_value', tab_id: tabId, page_id: resumed.page_id,
      element_ref: resumed.elements.find((element: any) => element.label === 'Application name').ref }))
      .toMatchObject({ ok: true, value: 'Retained merchant application' });
    const submit = { operation: 'page_act', page_id: resumed.page_id,
      element_ref: resumed.elements.find((element: any) => element.label === 'Save application').ref, page_action: 'click' };
    expect(await setup(submit)).toMatchObject({ ok: true });
    await expect.poll(() => saved).toEqual([{ trusted: true, draft: 'Retained merchant application' }]);
    expect(await setup({ operation: 'page_wait', wait_condition: 'text', text: 'Application saved' })).toMatchObject({ ok: true });
    expect(await setup(submit)).toMatchObject({ ok: false, code: 'stale_page', isError: true });
    expect(logins).toEqual([true]);
    expect(verifications).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(loginLoads).toBe(1);
    expect(applicationLoads).toBe(1);
    expect((await browser({ operation: 'tabs' })).tabs.map((tab: any) => tab.tab_id)).toEqual([tabId]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const interruption of ['abort', 'new task run'] as const) {
  test(`connector input withheld after ${interruption} while native pointer preparation is pending`, async ({ orkas }) => {
    const saved: Array<{ draft: string; trusted: boolean }> = [];
    const server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      if (request.url === '/save') {
        let body = '';
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => { saved.push(JSON.parse(body)); response.end('Saved'); });
      } else response.end(`<!doctype html><input aria-label="Application name"><button>Save application</button>
        <script>document.querySelector('button').addEventListener('click',event=>fetch('/save',{method:'POST',
          body:JSON.stringify({draft:document.querySelector('input').value,trusted:event.isTrusted})}));</script>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    try {
      const { cid, setup, browser, initial, tabId } = await prepare(orkas, url);
      expect(await setup({ operation: 'page_act', page_id: initial.page_id,
        element_ref: initial.elements.find((e: any) => e.label === 'Application name').ref,
        page_action: 'fill', text: 'Retained interrupted draft' })).toMatchObject({ ok: true });
      await orkas.electronApp!.evaluate(({ webContents }, args) => {
        const contents = webContents.getAllWebContents().find(contents => contents.getURL() === args.url)!;
        const original = contents.debugger.sendCommand.bind(contents.debugger);
        const controller = new AbortController();
        (globalThis as any).__connectorCancellation = { controller, contents, original };
        contents.debugger.sendCommand = async (method, params, sessionId) => {
          const result = await original(method, params, sessionId);
          if (method === 'Runtime.evaluate' && params.expression.includes('const preparePointer = true')) {
            contents.debugger.sendCommand = original;
            await new Promise<void>(resolve => { (globalThis as any).__connectorCancellation.release = resolve; });
          }
          return result;
        };
        (globalThis as any).__connectorCancellation.pending = (globalThis as any).__connectorBrowserTools.setup.execute({
          operation: 'page_act', connector_id: args.connectorId, page_id: args.pageId, element_ref: args.ref, page_action: 'click',
        }, { signal: controller.signal });
      }, { url, connectorId, pageId: initial.page_id, ref: initial.elements.find((e: any) => e.label === 'Save application').ref });
      await expect.poll(() => orkas.electronApp!.evaluate(() => typeof (globalThis as any).__connectorCancellation.release),
        { intervals: [5], timeout: 2000 }).toBe('function');
      const stopped = await orkas.electronApp!.evaluate(async (_electron, args) => {
        const pending = (globalThis as any).__connectorCancellation;
        if (args.interruption === 'abort') pending.controller.abort();
        else {
          const lifecycle = (process as any).mainModule.require(args.root + '/src/main/features/web_assist_lifecycle.ts');
          lifecycle.finishBrowserTaskRun('account-e2e', args.cid, 'connector-browser-run');
          lifecycle.beginBrowserTaskRun('account-e2e', args.cid, 'connector-browser-next-run');
        }
        pending.release();
        const result = await pending.pending;
        return { ...JSON.parse(result.content), isError: result.isError };
      }, { root, cid, interruption });
      expect(stopped).toMatchObject({ ok: false, code: 'task_run_ended', isError: true });
      expect(saved).toEqual([]);
      if (interruption === 'new task run') {
        expect(await setup({ operation: 'page_act', page_action: 'reload' }))
          .toMatchObject({ ok: false, code: 'task_run_ended', isError: true });
      }
      await orkas.electronApp!.evaluate((_electron, args) => {
        (globalThis as any).__connectorBrowserTools.browser = (process as any).mainModule.require(
          args.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', args.cid);
      }, { root, cid });
      const resumed = await browser({ operation: 'observe', tab_id: tabId });
      expect(await browser({ operation: 'read_value', tab_id: tabId, page_id: resumed.page_id,
        element_ref: resumed.elements.find((e: any) => e.label === 'Application name').ref }))
        .toMatchObject({ ok: true, value: 'Retained interrupted draft' });
      expect(await browser({ operation: 'act', tab_id: tabId, page_id: resumed.page_id,
        element_ref: resumed.elements.find((e: any) => e.label === 'Save application').ref, page_action: 'click' }))
        .toMatchObject({ ok: true });
      await expect.poll(() => saved).toEqual([{ draft: 'Retained interrupted draft', trusted: true }]);
    } finally {
      await orkas.electronApp!.evaluate(() => {
        const pending = (globalThis as any).__connectorCancellation;
        if (pending) { pending.controller.abort(); pending.release?.(); pending.contents.debugger.sendCommand = pending.original; }
        delete (globalThis as any).__connectorCancellation;
      });
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

for (const tool of ['setup', 'browser'] as const) for (const interruption of ['abort', 'new task run'] as const) {
  test(`${tool} wait discards native readiness after ${interruption} and keeps the draft`, async ({ orkas }, info) => {
    let loads = 0;
    const server = createServer((_request, response) => {
      loads++; response.setHeader('Content-Type', 'text/html');
      response.end('<h2>Provider ready</h2><input aria-label="Application name">');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
    try {
      const { cid, setup, browser, initial, tabId } = await prepare(orkas, url);
      expect(await setup({ operation: 'page_act', page_id: initial.page_id,
        element_ref: initial.elements.find((element: any) => element.label === 'Application name').ref,
        page_action: 'fill', text: 'Retained waiting draft' })).toMatchObject({ ok: true });
      await orkas.electronApp!.evaluate((_electron, args) => {
        const req = (process as any).mainModule.require;
        const contents = req('electron').webContents.getAllWebContents().find((item: any) => item.getURL() === args.url);
        const original = contents.debugger.sendCommand.bind(contents.debugger);
        const controller = new AbortController();
        const pending: any = { contents, original, controller };
        (globalThis as any).__connectorWaitCancellation = pending;
        contents.debugger.sendCommand = async (method, params, sessionId) => {
          const result = await original(method, params, sessionId);
          if (method === 'Runtime.evaluate' && params.expression.includes('body.includes(expected)')) {
            contents.debugger.sendCommand = original;
            pending.matched = result.result?.value === true;
            await new Promise<void>(resolve => { pending.release = resolve; });
          }
          return result;
        };
        pending.result = (globalThis as any).__connectorBrowserTools[args.tool].execute({
          operation: args.tool === 'setup' ? 'page_wait' : 'wait',
          ...(args.tool === 'setup' ? { connector_id: args.connectorId } : {}),
          wait_condition: 'text', text: 'Provider ready', timeout_ms: 5000,
        }, { signal: controller.signal });
      }, { url, tool, connectorId });
      await expect.poll(() => orkas.electronApp!.evaluate(() => typeof (globalThis as any).__connectorWaitCancellation.release),
        { intervals: [5], timeout: 2000 }).toBe('function');
      const stopped = await orkas.electronApp!.evaluate(async (_electron, args) => {
        const pending = (globalThis as any).__connectorWaitCancellation;
        if (!pending.matched) throw new Error('Native readiness fixture did not match');
        if (args.interruption === 'abort') pending.controller.abort();
        else {
          const lifecycle = (process as any).mainModule.require(args.root + '/src/main/features/web_assist_lifecycle.ts');
          lifecycle.finishBrowserTaskRun('account-e2e', args.cid, 'connector-browser-run');
          lifecycle.beginBrowserTaskRun('account-e2e', args.cid, 'connector-browser-next-run');
        }
        // Cancellation must finish while the native acknowledgement remains
        // withheld, rather than merely discarding it once the fixture releases.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const started = Date.now();
        try {
          const result = await Promise.race([pending.result, new Promise<any>(resolve => {
            timer = setTimeout(() => resolve({ content: JSON.stringify({ ok: false, code: 'fixture_stop_deadline' }), isError: true }), 1000);
          })]);
          return { ...JSON.parse(result.content), isError: result.isError, elapsedMs: Date.now() - started };
        } finally { clearTimeout(timer); }
      }, { root, cid, interruption });
      writeFileSync(info.outputPath('wait-stop-evidence.json'), JSON.stringify({ tool, interruption,
        code: stopped.code, elapsedMs: stopped.elapsedMs, nativeReceiptWithheld: true }, null, 2));
      expect(stopped).toMatchObject({ ok: false, code: 'task_run_ended', isError: true });
      expect(stopped.elapsedMs).toBeLessThan(1000);
      await orkas.electronApp!.evaluate(() => (globalThis as any).__connectorWaitCancellation.release());
      await orkas.electronApp!.evaluate((_electron, args) => {
        (globalThis as any).__connectorBrowserTools.browser = (process as any).mainModule.require(
          args.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', args.cid);
      }, { root, cid });
      expect(await browser({ operation: 'wait', wait_condition: 'text', text: 'Provider ready' })).toMatchObject({ ok: true });
      const resumed = await browser({ operation: 'observe', tab_id: tabId });
      expect(await browser({ operation: 'read_value', tab_id: tabId, page_id: resumed.page_id,
        element_ref: resumed.elements.find((element: any) => element.label === 'Application name').ref }))
        .toMatchObject({ ok: true, value: 'Retained waiting draft' });
      expect(loads).toBe(1);
    } finally {
      await orkas.electronApp!.evaluate(() => {
        const pending = (globalThis as any).__connectorWaitCancellation;
        if (pending) { pending.controller.abort(); pending.release?.(); pending.contents.debugger.sendCommand = pending.original; }
        delete (globalThis as any).__connectorWaitCancellation;
      });
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
