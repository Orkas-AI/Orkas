import { createServer } from 'node:http';
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { expect, OrkasTestApp, test } from './fixtures/orkas';

test('website login survives app restart and website logout stays logged out', async ({ orkas }) => {
  test.setTimeout(120_000);
  const partitionedRequests: boolean[] = [];
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/login') res.setHeader('Set-Cookie', [
      'login=fixture; HttpOnly; SameSite=Lax; Path=/',
      'partitioned=isolated; Secure; HttpOnly; SameSite=None; Partitioned; Path=/',
    ]);
    if (req.url === '/logout') res.setHeader('Set-Cookie', 'login=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/');
    const signedIn = (req.headers.cookie || '').split('; ').includes('login=fixture');
    if (req.url === '/account') partitionedRequests.push((req.headers.cookie || '').includes('partitioned=isolated'));
    res.end(`<title>Login fixture</title><h1>${signedIn ? 'Signed in' : 'Signed out'}</h1>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Browser login' });
    const cid = created.conversation.conversation_id;
    const open = async (pathname: string) => {
      const result = await orkas.invoke<any>('webAssist.open', { conversationId: cid, url: origin + pathname });
      expect(result.ok).toBe(true);
      await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.loading).toBe(false);
    };
    const text = () => orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const views = BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v instanceof WebContentsView);
      const view = views[views.length - 1] as InstanceType<typeof WebContentsView>;
      return view.webContents.executeJavaScript('document.querySelector("h1").textContent');
    });
    await open('/login');
    await open('/account');
    expect(await text()).toBe('Signed in');
    expect(partitionedRequests.at(-1)).toBe(true);
    await orkas.relaunch();
    await open('/account');
    expect(await text()).toBe('Signed in');
    // Electron cannot round-trip CHIPS scope: never restore it as an ordinary cookie.
    expect(partitionedRequests.at(-1)).toBe(false);
    await open('/logout');
    await orkas.relaunch();
    await open('/account');
    expect(await text()).toBe('Signed out');
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const location of ['temporary', 'home'] as const) {
  test(`persistent website login remains usable after a full app restart (${location})`, async ({}, testInfo) => {
    test.setTimeout(90_000);
    const orkas = new OrkasTestApp(testInfo, { rootParent: location === 'home' ? homedir() : tmpdir() });
    const server = createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'text/html');
      if (req.url === '/login') res.setHeader('Set-Cookie', 'persistent-login=fixture; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/');
      const signedIn = (req.headers.cookie || '').split('; ').includes('persistent-login=fixture');
      res.end(`<title>Persistent login fixture</title><h1>${signedIn ? 'Signed in' : 'Signed out'}</h1>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      await orkas.launch();
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Persistent browser login' });
      const cid = created.conversation.conversation_id;
      const open = async (pathname: string) => {
        const result = await orkas.invoke<any>('webAssist.open', { conversationId: cid, url: origin + pathname });
        expect(result.ok).toBe(true);
        await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.loading).toBe(false);
      };
      const text = () => orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
        const views = BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v instanceof WebContentsView);
        const view = views[views.length - 1] as InstanceType<typeof WebContentsView>;
        return view.webContents.executeJavaScript('document.querySelector("h1").textContent');
      });
      await open('/login');
      await open('/account');
      expect(await text()).toBe('Signed in');
      await orkas.relaunch();
      await open('/account');
      expect(await text()).toBe('Signed in');
    } finally {
      await orkas.dispose();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test('task browser routes pages, resources and popup login through its launch proxy and bypasses local services', async ({ orkas }) => {
  const proxied: string[] = [];
  let directLoads = 0;
  let leakedAuthorization = false;
  const proxy = createServer((req, res) => {
    if (req.headers['proxy-authorization'] !== `Basic ${Buffer.from('fixture:proxy-password').toString('base64')}`) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="browser-fixture"' });
      res.end();
      return;
    }
    const pathname = new URL(req.url!).pathname;
    proxied.push(pathname);
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/asset.js') {
      res.setHeader('Content-Type', 'text/javascript');
      res.end('document.title = "Proxy page ready";');
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end(pathname === '/start'
        ? '<title>Loading</title><script src="/asset.js"></script><iframe src="/frame"></iframe>'
        : `<title>Proxy ${pathname}</title><h1>Loaded via proxy</h1>`);
    }
  });
  const direct = createServer((req, res) => {
    directLoads++;
    leakedAuthorization ||= !!req.headers['proxy-authorization'] || !!req.headers.authorization;
    res.end('<title>Local service ready</title>');
  });
  await Promise.all([proxy, direct].map(server => new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))));
  try {
    const proxyPort = (proxy.address() as { port: number }).port;
    const directUrl = `http://127.0.0.1:${(direct.address() as { port: number }).port}/bypass`;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Browser proxy' });
    const cid = created.conversation.conversation_id;
    await orkas.page!.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
    }, cid);
    const opened = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      process.env.HTTP_PROXY = `http://fixture:proxy-password@127.0.0.1:${args.proxyPort}`;
      process.env.HTTPS_PROXY = process.env.HTTP_PROXY;
      process.env.NO_PROXY = 'localhost,127.0.0.1,::1,internal.test:8443';
      const web = (process as any).mainModule.require(args.modulePath);
      const sender = BrowserWindow.getAllWindows()[0].webContents;
      web.bindWebAssistConversation('account-e2e', args.cid, sender);
      return web.openWebAssist('account-e2e', sender, { conversationId: args.cid, url: 'http://browser-proxy.invalid/start' });
    }, { cid, proxyPort, modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') });
    expect(opened.ok).toBe(true);
    const parentId = await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
      const parent = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      return parent.webContents.id;
    });
    const title = () => orkas.electronApp!.evaluate(({ webContents }, id) => webContents.fromId(id)?.getTitle(), parentId);
    await expect.poll(title).toBe('Proxy page ready');
    await expect.poll(() => proxied.includes('/frame')).toBe(true);
    const routes = await orkas.electronApp!.evaluate(async ({ webContents }, id) => {
      const ses = webContents.fromId(id)!.session;
      return Promise.all(['https://accounts.google.com/', 'http://sub.internal.test:8443/', 'http://sub.internal.test:8080/'].map(url => ses.resolveProxy(url)));
    }, parentId);
    expect(routes).toEqual([`PROXY 127.0.0.1:${proxyPort}`, 'DIRECT', `PROXY 127.0.0.1:${proxyPort}`]);
    for (const [pathname, features] of [['/tab', ''], ['/popup', 'width=480,height=600']]) {
      await orkas.electronApp!.evaluate(async ({ webContents }, args) => {
        await webContents.fromId(args.parentId)!.executeJavaScript(`window.open(${JSON.stringify(args.pathname)}, '_blank', ${JSON.stringify(args.features)}); void 0`, true);
      }, { parentId, pathname, features });
      await expect.poll(() => proxied.includes(pathname)).toBe(true);
      await expect.poll(async () => orkas.electronApp!.evaluate(({ webContents }, expected) => (
        webContents.getAllWebContents().some(page => page.getTitle() === `Proxy ${expected}`)
      ), pathname)).toBe(true);
    }
    expect(proxied).toEqual(expect.arrayContaining(['/start', '/asset.js', '/frame', '/tab', '/popup']));
    await orkas.invoke('webAssist.navigateTo', { tabId: opened.state.active_tab_id, url: directUrl });
    await expect.poll(title).toBe('Local service ready');
    expect(directLoads).toBeGreaterThan(0);
    expect(leakedAuthorization).toBe(false);
    expect(proxied).not.toContain('/bypass');
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await orkas.invoke('webAssist.navigateTo', { tabId: opened.state.active_tab_id, url: 'http://browser-proxy.invalid/unavailable' });
    await expect.poll(async () => (await orkas.invoke<{ state: { tabs: Array<{ tab_id: string; error_code?: string }> } }>('webAssist.state', {})).state.tabs.find(tab => tab.tab_id === opened.state.active_tab_id)?.error_code).toBe('page_load_failed');
    expect(proxied).not.toContain('/unavailable');
  } finally {
    await orkas.invoke('webAssist.close', {});
    await orkas.electronApp!.evaluate(() => {
      delete process.env.HTTP_PROXY;
      delete process.env.HTTPS_PROXY;
    });
    for (const server of [proxy, direct]) {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }
});

test('task browser blocks requests when proxy setup fails instead of using a reachable direct route', async ({ orkas }) => {
  let received = 0;
  const server = createServer((_req, res) => { received++; res.end('<title>Unexpected direct request</title>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/must-not-leak`;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Proxy failure' });
    const opened = await orkas.electronApp!.evaluate(async ({ BrowserWindow, session }, args) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const paths = require(args.pathsModule);
      const dir = paths.userWebAssistProfileDir('account-e2e');
      require('node:fs').mkdirSync(dir, { recursive: true });
      const ses = session.fromPath(dir, { cache: true });
      // Fault injection: Chromium cannot apply the requested proxy. No request may escape on its old route.
      ses.setProxy = async () => { throw new Error('Fixture proxy setup failure'); };
      process.env.HTTP_PROXY = 'http://127.0.0.1:8080';
      const web = require(args.webModule);
      return web.openWebAssist('account-e2e', BrowserWindow.getAllWindows()[0].webContents, { conversationId: args.cid, url: args.url });
    }, {
      cid: created.conversation.conversation_id, url,
      pathsModule: path.resolve(__dirname, '../../src/main/paths.ts'),
      webModule: path.resolve(__dirname, '../../src/main/features/web_assist.ts'),
    });
    expect(opened.ok).toBe(true);
    await expect.poll(async () => (await orkas.invoke<{ state: { error_code?: string } }>('webAssist.state', {})).state.error_code).toBe('page_load_failed');
    expect(received).toBe(0);
  } finally {
    await orkas.invoke('webAssist.close', {});
    await orkas.electronApp!.evaluate(() => { delete process.env.HTTP_PROXY; });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('idle task pages release native contents and lazily restore cookies, storage and identity', async ({ orkas }) => {
  let loads = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/work')) loads++;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Idle workspace</title><h1>Resume work</h1><input id="draft" aria-label="Draft">');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/work?item=7`;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Idle browser' });
    const cid = created.conversation.conversation_id;
    await orkas.page!.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
    }, cid);
    const input = { cid, url, modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') };
    const opened = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      const web = (process as any).mainModule.require(args.modulePath);
      web.bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
      return web.openModelWebAssist('account-e2e', args.cid, { url: args.url });
    }, input);
    expect(opened.ok).toBe(true);
    const inventory = () => orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }, args) => {
      const web = (process as any).mainModule.require(args.modulePath);
      const owner = BrowserWindow.getAllWindows()[0];
      return { ...web.listModelWebAssistTabs('account-e2e', args.cid), nativeCount: owner.contentView.children.filter(v => v instanceof WebContentsView).length };
    }, input);
    await expect.poll(async () => (await inventory()).tabs[0]?.loading).toBe(false);
    const nativeId = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, args) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      await view.webContents.executeJavaScript("localStorage.setItem('fixture', 'retained'); document.cookie = 'fixture=retained; SameSite=Lax';");
      return view.webContents.id;
    }, input);
    const observe = () => orkas.electronApp!.evaluate(async (_electron, args) => {
      return (process as any).mainModule.require(args.modulePath).observeModelWebAssist('account-e2e', args.cid, args.tabId);
    }, { ...input, tabId: opened.active_tab_id });
    const before = await observe();
    expect(before.ok).toBe(true);
    // Switching to Attachments must not cause state events to wake the browser.
    await orkas.page!.evaluate(() => (window as any).ConversationInfo.openAndSetTab('attachments'));
    const reclaim = () => orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      const web = (process as any).mainModule.require(args.modulePath);
      const owner = BrowserWindow.getAllWindows()[0];
      web.layoutWebAssist(owner.webContents, { visible: false });
      await web.reclaimIdleWebAssistPages(Date.now() + 600_000, owner.id);
    }, input);
    await reclaim();
    await expect.poll(async () => (await inventory()).nativeCount).toBe(0);
    expect((await inventory()).tabs).toMatchObject([{ tab_id: opened.active_tab_id, suspended: true }]);
    await inventory();
    expect(loads).toBe(1);
    const destroyed = await orkas.electronApp!.evaluate(({ webContents }, id) => !webContents.fromId(id), nativeId);
    expect(destroyed).toBe(true);
    // Actual model access recreates contents while leaving the user's chosen panel alone.
    await observe();
    await expect.poll(async () => (await inventory()).tabs[0]?.loading).toBe(false);
    const after = await observe();
    const hiddenLayout = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const v = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      return { visible: v.getVisible(), width: await v.webContents.executeJavaScript('innerWidth') };
    });
    expect(hiddenLayout.visible).toBe(false);
    expect(hiddenLayout.width).toBeGreaterThan(0);
    expect(after).toMatchObject({ ok: true, tab_id: opened.active_tab_id });
    expect(after.text).toContain('Resume work');
    expect(after.page_id).not.toBe(before.page_id);
    expect(loads).toBe(2);
    const restored = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      return { id: view.webContents.id, url: view.webContents.getURL(), values: await view.webContents.executeJavaScript("({ local: localStorage.getItem('fixture'), cookie: document.cookie })") };
    });
    expect(restored.id).not.toBe(nativeId);
    expect(restored.url).toBe(url);
    expect(restored.values).toEqual({ local: 'retained', cookie: 'fixture=retained' });
    // Script-driven form editing must also protect unsaved work, without keyboard events.
    await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      await view.webContents.executeJavaScript("document.querySelector('#draft').value = 'private unsaved draft'");
    });
    await reclaim();
    expect((await inventory()).nativeCount).toBe(1);
    expect(loads).toBe(2);
    await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      await view.webContents.executeJavaScript("document.querySelector('#draft').value = ''");
    });
    // Tab-scoped storage cannot be copied into recovery records; retain it instead.
    await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      await view.webContents.executeJavaScript("sessionStorage.setItem('transient', 'fixture')");
    });
    await reclaim();
    expect((await inventory()).nativeCount).toBe(1);
    await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      await view.webContents.executeJavaScript('sessionStorage.clear()');
    });
    await reclaim();
    await expect.poll(async () => (await inventory()).nativeCount).toBe(0);
    await orkas.page!.evaluate(() => (window as any).ConversationInfo.openAndSetTab('browser'));
    await expect.poll(async () => (await inventory()).nativeCount).toBe(1);
    await expect.poll(() => loads).toBe(3);
    await expect(orkas.page!.locator('.web-assist-tab.is-suspended')).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('task browser opens ordinary pages as tabs while preserving web navigation semantics', async ({ orkas }) => {
  const requests: Array<{ path: string; method: string; body: string; ua: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: req.url!, method: req.method!, body, ua: req.headers['user-agent'] || '' });
      res.setHeader('Content-Type', 'text/html');
      if (req.url !== '/') {
        res.end('<title>Business page</title><h1>Account balance</h1>');
        return;
      }
      res.end(`<!doctype html><title>Shop console</title>
        <a id="ordinary" href="/balance" target="_blank">View balance</a>
        <form action="/statement" method="post" target="_blank"><input name="period" value="month"><button id="submit">Statement</button></form>
        <button id="named" onclick="window.child = window.open('', 'business-detail'); child.document.write('<title>Draft</title><h1>Draft</h1>');">Named page</button>
        <button id="no-popup" onclick="window.open('/no-popup', '_blank', 'popup=no,width=480,height=620')">No popup</button>`);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/`;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Browser navigation' });
    const cid = created.conversation.conversation_id;
    await orkas.page!.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
    }, cid);
    const input = { cid, url, modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') };
    const opened = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      const web = (process as any).mainModule.require(args.modulePath);
      const owner = BrowserWindow.getAllWindows()[0];
      web.bindWebAssistConversation('account-e2e', args.cid, owner.webContents);
      return web.openModelWebAssist('account-e2e', args.cid, { url: args.url });
    }, input);
    expect(opened.ok).toBe(true);
    const inventory = () => orkas.electronApp!.evaluate(({ BrowserWindow }, args) => {
      const web = (process as any).mainModule.require(args.modulePath);
      return { ...web.listModelWebAssistTabs('account-e2e', args.cid), windows: BrowserWindow.getAllWindows().length };
    }, input);
    const click = (selector: string, middle = false) => orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, args) => {
      const parent = BrowserWindow.getAllWindows().find(win => !win.getParentWindow())!.contentView.children
        .find(view => view instanceof WebContentsView && view.webContents.getURL() === args.url) as InstanceType<typeof WebContentsView>;
      if (args.middle) {
        const point = await parent.webContents.executeJavaScript(`(() => { const r = document.querySelector(${JSON.stringify(args.selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        parent.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'middle', clickCount: 1 });
        parent.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'middle', clickCount: 1 });
      } else {
        await parent.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(args.selector)}).click()`, true);
      }
    }, { url, selector, middle });
    await expect.poll(async () => (await inventory()).tabs[0]?.page_title).toBe('Shop console');
    await click('#ordinary');
    await expect(orkas.page!.locator('.web-assist-tab')).toHaveCount(2);
    const state = await inventory();
    expect(state.windows).toBe(1);
    const business = state.tabs.find((tab: any) => tab.tab_id !== opened.active_tab_id);
    await expect.poll(async () => (await inventory()).tabs.find((tab: any) => tab.tab_id === business.tab_id)?.display_url).toBe(url + 'balance');
    expect(state.active_tab_id).toBe(business.tab_id);
    // Renderer selection and actual native content must agree, not just the tool result.
    await expect(orkas.page!.locator('.web-assist-tab.is-active')).toContainText('Business page');
    const observed = await orkas.electronApp!.evaluate(async (_electron, args) => {
      const web = (process as any).mainModule.require(args.modulePath);
      return web.observeModelWebAssist('account-e2e', args.cid, args.tabId);
    }, { ...input, tabId: business.tab_id });
    expect(observed.text).toContain('Account balance');
    await click('#submit');
    await expect.poll(() => requests.find(request => request.path === '/statement')).toMatchObject({ method: 'POST', body: 'period=month' });
    await expect(orkas.page!.locator('.web-assist-tab')).toHaveCount(3);
    await click('#named');
    await expect(orkas.page!.locator('.web-assist-tab')).toHaveCount(4);
    await expect.poll(async () => orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
      const draft = BrowserWindow.getAllWindows()[0].contentView.children
        .find(view => view instanceof WebContentsView && view.webContents.getTitle() === 'Draft');
      return draft?.getVisible();
    })).toBe(true);
    await expect(orkas.page!.locator('.web-assist-external-btn')).toBeDisabled();
    const named = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, args) => {
      const owner = BrowserWindow.getAllWindows()[0];
      const parent = owner.contentView.children.find(view => view instanceof WebContentsView && view.webContents.getURL() === args.url) as InstanceType<typeof WebContentsView>;
      return parent.webContents.executeJavaScript(`(() => { const same = window.open('', 'business-detail') === child; const connected = child.opener === window; const childUa = child.navigator.userAgent; child.location.href = '/named'; return { same, connected, ua: navigator.userAgent, childUa }; })()`, true);
    }, input);
    expect(named).toMatchObject({ same: true, connected: true });
    expect(named.ua).not.toMatch(/Electron\/|Orkas\//i);
    expect(named.ua).toMatch(/Chrome\//);
    // UA is diagnostic evidence, not a new fingerprint policy: Electron guests
    // can still expose the default UA before the per-page override takes effect.
    console.log('[web-assist UA]', {
      page: named.ua, initialChild: named.childUa,
      firstRequest: requests.find(request => request.path === '/balance')!.ua,
    });
    await click('#no-popup');
    await expect(orkas.page!.locator('.web-assist-tab')).toHaveCount(5);
    expect((await inventory()).windows).toBe(1);
    // Switch to the opener and middle-click a real anchor. Background opening
    // must keep that selected page, while adding an independently usable tab.
    await orkas.invoke('webAssist.activateTab', { tabId: opened.active_tab_id });
    await expect(orkas.page!.locator('.web-assist-tab.is-active')).toContainText('Shop console');
    await click('#ordinary', true);
    await expect(orkas.page!.locator('.web-assist-tab')).toHaveCount(6);
    expect((await inventory()).active_tab_id).toBe(opened.active_tab_id);
    await expect(orkas.page!.locator('.web-assist-tab.is-active')).toContainText('Shop console');
    await orkas.invoke('webAssist.closeTab', { tabId: opened.active_tab_id });
    await expect(orkas.page!.locator('.web-assist-tab')).toHaveCount(5);
    expect((await inventory()).windows).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('task completion only closes explicitly temporary native tabs and resumes an unmarked login', async ({ orkas }) => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Lifecycle page</title><h1>Browser lifecycle</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Tab lifecycle' });
    const cid = created.conversation.conversation_id;
    const page = orkas.page!;
    await page.evaluate(async taskId => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', taskId);
    }, cid);
    // Exercise the real native-view disposal/renderer push path with no live model.
    // Bus integration independently proves which production terminal invokes it.
    const input = {
      cid, url: `http://127.0.0.1:${address.port}/`,
      webPath: path.resolve(__dirname, '../../src/main/features/web_assist.ts'),
      lifecyclePath: path.resolve(__dirname, '../../src/main/features/web_assist_lifecycle.ts'),
    };
    const initial = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      const web = (process as any).mainModule.require(args.webPath);
      const lifecycle = (process as any).mainModule.require(args.lifecyclePath);
      const sender = BrowserWindow.getAllWindows()[0].webContents;
      web.bindWebAssistConversation('account-e2e', args.cid, sender);
      lifecycle.beginBrowserTaskRun('account-e2e', args.cid, 'e2e-first');
      await web.openWebAssist('account-e2e', sender, { conversationId: args.cid, url: args.url + 'user' });
      const temporary = await web.openModelWebAssist('account-e2e', args.cid, { url: args.url + 'temporary' });
      const mark = web.retainModelWebAssistTab('account-e2e', args.cid, temporary.active_tab_id, 'temporary');
      const login = await web.openControlledWebAssist('account-e2e', args.cid, {
        scope: 'connector_setup', scopeId: 'fixture-shop', url: args.url + 'handoff',
      });
      return { mark, login, state: web.webAssistState(sender) };
    }, input);
    expect(initial.mark.ok).toBe(true);
    expect(initial.login.ok).toBe(true);
    await expect(page.locator('.web-assist-tab')).toHaveCount(3);
    const nativePaths = () => orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => (
      BrowserWindow.getAllWindows()[0].contentView.children
        .filter(view => view instanceof WebContentsView)
        .map(view => view.webContents.getURL())
        .map(url => url ? new URL(url).pathname : '').sort()
    ));
    await expect.poll(nativePaths).toEqual(['/handoff', '/temporary', '/user']);
    await orkas.electronApp!.evaluate((_electron, args) => {
      (process as any).mainModule.require(args.lifecyclePath).finishBrowserTaskRun('account-e2e', args.cid, 'e2e-first');
    }, input);
    await expect(page.locator('.web-assist-tab')).toHaveCount(2);
    await expect.poll(nativePaths).toEqual(['/handoff', '/user']);
    const resumed = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, args) => {
      const lifecycle = (process as any).mainModule.require(args.lifecyclePath);
      const web = (process as any).mainModule.require(args.webPath);
      // Stand in for the user's login navigation, without a retain call.
      const login = BrowserWindow.getAllWindows()[0].contentView.children
        .find(view => view instanceof WebContentsView && view.webContents.getURL() === args.url + 'handoff') as InstanceType<typeof WebContentsView>;
      await login.webContents.loadURL(args.url + 'applications');
      lifecycle.beginBrowserTaskRun('account-e2e', args.cid, 'e2e-second');
      const loaded = await web.waitForControlledWebAssist('account-e2e', args.cid, 'fixture-shop', { condition: 'loaded' });
      if (!loaded.ok) throw new Error(JSON.stringify(loaded));
      const observed = await web.observeControlledWebAssist('account-e2e', args.cid, 'fixture-shop');
      lifecycle.finishBrowserTaskRun('account-e2e', args.cid, 'e2e-second');
      return observed;
    }, input);
    expect(resumed, JSON.stringify(resumed)).toMatchObject({ ok: true, tab_id: initial.login.state.active_tab_id, display_url: input.url + 'applications' });
    await expect(page.locator('.web-assist-tab')).toHaveCount(2);
    await expect.poll(nativePaths).toEqual(['/applications', '/user']);
    const closed = await orkas.electronApp!.evaluate((_electron, args) => {
      return (process as any).mainModule.require(args.webPath)
        .closeModelWebAssistTab('account-e2e', args.cid, args.tabId);
    }, { ...input, tabId: resumed.tab_id });
    expect(closed.ok).toBe(true);
    await expect(page.locator('.web-assist-tab')).toHaveCount(1);
    await expect.poll(nativePaths).toEqual(['/user']);
    await orkas.invoke('webAssist.close', {});
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('task browser caps its visible strip at ten while keeping user and connector handoff pages', async ({ orkas }) => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Capacity fixture</title><h1>Ready</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as { port: number };
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Browser capacity' });
    const cid = created.conversation.conversation_id;
    await orkas.page!.evaluate(async taskId => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', taskId);
    }, cid);
    const result = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, args) => {
      const web = (process as any).mainModule.require(args.webPath);
      const owner = BrowserWindow.getAllWindows()[0];
      web.bindWebAssistConversation('account-e2e', args.cid, owner.webContents);
      await web.openWebAssist('account-e2e', owner.webContents, { conversationId: args.cid, url: args.url + 'user' });
      const login = await web.openControlledWebAssist('account-e2e', args.cid, {
        scope: 'connector_setup', scopeId: 'fixture-shop', url: args.url + 'login',
      });
      await web.waitForControlledWebAssist('account-e2e', args.cid, 'fixture-shop', { condition: 'loaded' });
      const results: any[] = [];
      for (let index = 0; index < 9; index++) {
        const opened = await web.openModelWebAssist('account-e2e', args.cid, { url: args.url + index });
        if (!opened.ok) throw new Error(JSON.stringify(opened));
        const loaded = await web.waitForModelWebAssist('account-e2e', args.cid, { tabId: opened.active_tab_id, condition: 'loaded' });
        if (!loaded.ok) throw new Error(JSON.stringify(loaded));
        results.push(opened);
      }
      return {
        login, results, tabs: web.listModelWebAssistTabs('account-e2e', args.cid),
        paths: owner.contentView.children.filter(view => view instanceof WebContentsView)
          .map(view => new URL(view.webContents.getURL()).pathname).sort(),
      };
    }, { cid, url: `http://127.0.0.1:${port}/`, webPath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') });
    expect(result.login.ok).toBe(true);
    expect(result.tabs.tab_limit).toBe(10);
    expect(result.tabs.tabs).toHaveLength(10);
    expect(result.results[8].closed_tab_ids).toEqual([result.results[0].active_tab_id]);
    expect(result.paths).toEqual(['/1', '/2', '/3', '/4', '/5', '/6', '/7', '/8', '/login', '/user']);
    await expect(orkas.page!.locator('.web-assist-tab')).toHaveCount(10);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('task browser keeps an authorization popup separate and reconnects it to its opener', async ({ orkas }) => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/authorize') {
      res.end(`<!doctype html><title>Provider authorization</title>
        <h1>Provider authorization</h1>
        <button id="authorize">Authorize</button>
        <script>
          document.querySelector('#authorize').addEventListener('click', () => {
            window.opener.postMessage({ type: 'authorized' }, location.origin);
            window.close();
          });
        </script>`);
      return;
    }
    res.end(`<!doctype html><title>Provider settings</title>
      <h1>Provider settings</h1>
      <button id="open-auth">Connect account</button>
      <p id="auth-result">Not connected</p>
      <script>
        document.querySelector('#open-auth').addEventListener('click', () => {
          const popup = window.open('', 'provider-oauth', 'width=480,height=620');
          if (popup) popup.location.href = '/authorize';
        });
        window.addEventListener('message', (event) => {
          if (event.origin === location.origin && event.data?.type === 'authorized') {
            document.querySelector('#auth-result').textContent = 'Connected';
          }
        });
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const parentUrl = `http://127.0.0.1:${address.port}/`;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>(
      'conversations.create',
      { title: 'Authorization popup' },
    );
    const cid = created.conversation.conversation_id;
    await orkas.page!.evaluate(async taskId => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', taskId);
    }, cid);
    const input = { cid, parentUrl, modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') };
    const opened = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      const owner = BrowserWindow.getAllWindows()[0];
      const web = (process as any).mainModule.require(args.modulePath);
      web.bindWebAssistConversation('account-e2e', args.cid, owner.webContents);
      return web.openWebAssist('account-e2e', owner.webContents, {
        conversationId: args.cid,
        url: args.parentUrl,
        label: 'Provider settings',
      });
    }, input);
    expect(opened).toMatchObject({ ok: true });
    await expect.poll(async () => orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
      const owner = BrowserWindow.getAllWindows().find(win => !win.getParentWindow())!;
      const parent = owner.contentView.children.find(child => child instanceof WebContentsView);
      return parent?.webContents.getTitle();
    })).toBe('Provider settings');

    const requestedPopupSize = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const owner = BrowserWindow.getAllWindows().find(win => !win.getParentWindow())!;
      const parent = owner.contentView.children.find(child => child instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      const created = new Promise(resolve => parent.webContents.once('did-create-window', (_popup, details) => {
        resolve([details.options.width, details.options.height]);
      }));
      await parent.webContents.executeJavaScript('document.querySelector("#open-auth").click()', true);
      return created;
    });
    expect(requestedPopupSize).toEqual([480, 620]);
    await expect.poll(async () => orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView, screen }) => {
      const owner = BrowserWindow.getAllWindows().find(win => !win.getParentWindow())!;
      const popup = BrowserWindow.getAllWindows().find(win => win.getParentWindow()?.id === owner.id);
      const parent = owner.contentView.children.find(child => child instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      if (!popup) return null;
      const scale = screen.getDisplayMatching(popup.getBounds()).scaleFactor;
      // Windows native frame conversion yields 480x622 at 125% DPI, but 480x620 at 100%.
      // Keep the requested dimensions exact above; allow only a small native rounding delta.
      const tolerance = process.platform === 'win32' && !Number.isInteger(scale) ? 2 : 0;
      return {
        title: popup.webContents.getTitle(),
        parent: popup.getParentWindow()?.id === owner.id,
        sharedSession: popup.webContents.session === parent?.webContents.session,
        sizeWithinTolerance: popup.getSize().every((value, index) => Math.abs(value - [480, 620][index]) <= tolerance),
      };
    })).toEqual({
      title: 'Provider authorization',
      parent: true,
      sharedSession: true,
      sizeWithinTolerance: true,
    });
    await expect.poll(async () => orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }, expectedUrl) => {
      const owner = BrowserWindow.getAllWindows().find(win => !win.getParentWindow())!;
      const parent = owner.contentView.children.find(child => child instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      return parent.webContents.getURL() === expectedUrl;
    }, parentUrl)).toBe(true);

    await orkas.electronApp!.evaluate(async ({ BrowserWindow }) => {
      const popup = BrowserWindow.getAllWindows().find(win => !!win.getParentWindow())!;
      await popup.webContents.executeJavaScript('document.querySelector("#authorize").click()', true);
    });
    await expect.poll(async () => orkas.electronApp!.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows().filter(win => !!win.getParentWindow()).length
    ))).toBe(0);
    await expect.poll(async () => orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const owner = BrowserWindow.getAllWindows().find(win => !win.getParentWindow())!;
      const parent = owner.contentView.children.find(child => child instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      return parent.webContents.executeJavaScript('document.querySelector("#auth-result").textContent');
    })).toBe('Connected');

    await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const owner = BrowserWindow.getAllWindows().find(win => !win.getParentWindow())!;
      const parent = owner.contentView.children.find(child => child instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      await parent.webContents.executeJavaScript('document.querySelector("#open-auth").click()', true);
    });
    await expect.poll(async () => orkas.electronApp!.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows().filter(win => !!win.getParentWindow()).length
    ))).toBe(1);
    await orkas.invoke('webAssist.close', {});
    await expect.poll(async () => orkas.electronApp!.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows().filter(win => !!win.getParentWindow()).length
    ))).toBe(0);
  } finally {
    await orkas.electronApp?.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.getParentWindow()) win.close();
      }
    });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('task-details browser supports tabs, address navigation, resizing, and view recovery', async ({ orkas }, testInfo) => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Setup console</title><h1>Application setup</h1><label>Application name<input></label><button type="button">Purchase now</button>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const page = orkas.page!;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>(
      'conversations.create',
      { title: 'Browser E2E' },
    );
    const cid = created.conversation.conversation_id;
    expect(cid).not.toBe('');
    await page.evaluate(async taskId => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', taskId);
    }, cid);
    const opened = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, input) => {
      const owner = BrowserWindow.getAllWindows()[0];
      const web = (process as any).mainModule.require(input.modulePath);
      web.bindWebAssistConversation('account-e2e', input.cid, owner.webContents);
      return web.openModelWebAssist('account-e2e', input.cid, {
        url: input.url, label: 'Browser E2E',
      });
    }, { cid, url: `http://127.0.0.1:${address.port}/`, modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') });
    expect(opened.ok).toBe(true);
    await expect.poll(async () => {
      const result = await orkas.invoke<{ state: { page_title: string; loading: boolean } }>('webAssist.state', {});
      return { title: result.state.page_title, loading: result.state.loading };
    }).toEqual({ title: 'Setup console', loading: false });
    const openedTabId = (opened as { active_tab_id: string }).active_tab_id;
    const observed = await orkas.electronApp!.evaluate(async (_electron, input) => {
      const web = (process as any).mainModule.require(input.modulePath);
      return web.observeModelWebAssist('account-e2e', input.cid, input.tabId);
    }, { cid, tabId: openedTabId, modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') });
    expect(observed).toMatchObject({ ok: true, title: 'Setup console' });
    expect(observed.text).toContain('Application setup');
    const native = () => orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
      const views = BrowserWindow.getAllWindows()[0].contentView.children
        .filter(child => child instanceof WebContentsView);
      const visible = views.find(view => view.getVisible());
      const measured = visible || views[0];
      return measured ? { visible: !!visible, bounds: measured.getBounds(), id: measured.webContents.id } : null;
    });
    const details = page.locator('#conversation-info-panel');
    const browser = details.locator('.web-assist-shell');
    await expect(details).toBeVisible();
    await expect(details.locator('[data-info-tab="browser"]')).toHaveClass(/is-active/);
    await expect(browser).toBeVisible();
    await expect(browser.locator('.web-assist-status')).toHaveCSS('font-size', '13px');
    await expect(browser.locator('.web-assist-status')).toHaveCSS('text-align', 'center');
    await expect.poll(async () => (await native())?.visible).toBe(true);
    // Use the actual close/tab controls: ongoing model operations must not
    // undo the user's view choice, and the native page remains usable hidden.
    await page.locator('#conversation-info-close').click();
    const hiddenObservation = await orkas.electronApp!.evaluate(async (_electron, input) => {
      const web = (process as any).mainModule.require(input.modulePath);
      return web.observeModelWebAssist('account-e2e', input.cid, input.tabId);
    }, { cid, tabId: openedTabId, modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') });
    expect(hiddenObservation.ok).toBe(true);
    await expect(details).toBeHidden();
    await expect.poll(async () => (await native())?.visible).toBe(false);
    await page.locator('#conversation-info-toggle').click();
    await details.locator('[data-info-tab="attachments"]').click();
    const field = hiddenObservation.elements.find((element: { label: string }) => element.label === 'Application name');
    const hiddenAction = await orkas.electronApp!.evaluate(async (_electron, input) => {
      const web = (process as any).mainModule.require(input.modulePath);
      return web.actOnModelWebAssist('account-e2e', input.cid, {
        tabId: input.tabId, pageId: input.pageId, elementRef: input.ref,
        action: 'fill', text: 'Hidden-page draft',
      });
    }, { cid, tabId: openedTabId, pageId: hiddenObservation.page_id, ref: field.ref,
      modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') });
    expect(hiddenAction).toMatchObject({ ok: true, outcome: 'acted' });
    // Independent page oracle: a tool success envelope alone cannot prove
    // the draft was entered in the still-hidden native page.
    const draftValue = await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }, url) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children
        .find(child => child instanceof WebContentsView && child.webContents.getURL() === url) as InstanceType<typeof WebContentsView>;
      return view.webContents.executeJavaScript('document.querySelector("input").value');
    }, `http://127.0.0.1:${address.port}/`);
    expect(draftValue).toBe('Hidden-page draft');
    const hiddenWait = await orkas.electronApp!.evaluate(async (_electron, input) => {
      const web = (process as any).mainModule.require(input.modulePath);
      return web.waitForModelWebAssist('account-e2e', input.cid, {
        tabId: input.tabId, condition: 'text', text: 'Application setup', timeoutMs: 1000,
      });
    }, { cid, tabId: openedTabId, modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') });
    expect(hiddenWait).toMatchObject({ ok: true, condition: 'text' });
    await expect(details.locator('[data-info-tab="attachments"]')).toHaveClass(/is-active/);
    await expect(browser).toBeHidden();
    await expect.poll(async () => (await native())?.visible).toBe(false);
    // The conversation controller invokes this at the next request boundary.
    await page.evaluate(taskId => (window as any).WebAssist.beginTaskTurn(taskId), cid);
    await orkas.electronApp!.evaluate(async (_electron, input) => {
      const web = (process as any).mainModule.require(input.modulePath);
      return web.observeModelWebAssist('account-e2e', input.cid, input.tabId);
    }, { cid, tabId: openedTabId, modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') });
    await expect(details.locator('[data-info-tab="browser"]')).toHaveClass(/is-active/);
    await expect.poll(async () => (await native())?.visible).toBe(true);
    const modelOpened = await orkas.electronApp!.evaluate(async (_electron, input) => {
      const web = (process as any).mainModule.require(input.modulePath);
      return web.openModelWebAssist('account-e2e', input.cid, {
        url: input.url,
        label: 'Model-opened tab',
      });
    }, {
      cid,
      url: `http://127.0.0.1:${address.port}/model-opened`,
      modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts'),
    });
    expect(modelOpened).toMatchObject({ ok: true });
    const modelTabId = String(modelOpened.active_tab_id || '');
    await expect(page.locator('.web-assist-tab')).toHaveCount(2);
    await expect.poll(async () => orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }, expectedId) => {
      const views = BrowserWindow.getAllWindows()[0].contentView.children
        .filter(child => child instanceof WebContentsView);
      const selected = views.find(view => view.webContents.getURL().includes('/model-opened'));
      return {
        active: selected?.getVisible() === true,
        tabIdPresent: expectedId.length === 12,
      };
    }, modelTabId)).toEqual({ active: true, tabIdPresent: true });
    const closedModelTab = await orkas.electronApp!.evaluate(async (_electron, input) => {
      const web = (process as any).mainModule.require(input.modulePath);
      return web.closeModelWebAssistTab('account-e2e', input.cid, input.tabId);
    }, {
      cid,
      tabId: modelTabId,
      modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts'),
    });
    expect(closedModelTab).toMatchObject({ ok: true, closed: true });
    await expect(page.locator('.web-assist-tab')).toHaveCount(1);
    await expect.poll(async () => (await native())?.visible).toBe(true);
    const chat = await page.locator('#panel-conversation .chat-main-pane').boundingBox();
    const box = (await browser.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(chat!.x + chat!.width - 1);
    expect(chat!.width).toBeGreaterThan(250);
    expect((await native())!.bounds.x).toBeGreaterThanOrEqual(Math.floor(box.x));
    const handle = page.locator('#conversation-info-resize');
    const grip = (await handle.boundingBox())!;
    const pageBeforeResize = (await native())!.id;
    const resizeDocument = () => orkas.electronApp!.evaluate(({ webContents }, id) => (
      webContents.fromId(id)!.executeJavaScript('({ timeOrigin: performance.timeOrigin, draft: document.querySelector("input")?.value })')
    ), pageBeforeResize);
    const documentBeforeResize = await resizeDocument();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 100);
    await page.mouse.down();
    await page.mouse.move(grip.x + 85, grip.y + 100);
    // Assert while the pointer is still held, not only after release.
    await expect.poll(async () => (await native())?.bounds.width).toBeLessThan(box.width - 40);
    expect((await native())?.visible).toBe(true);
    expect((await native())?.id).toBe(pageBeforeResize);
    await page.mouse.move(grip.x - 40, grip.y + 100);
    await expect.poll(async () => (await native())?.bounds.width).toBeGreaterThan(box.width);
    expect((await native())?.visible).toBe(true);
    await page.mouse.move(grip.x + 85, grip.y + 100);
    await page.mouse.up();
    await expect.poll(async () => (await browser.boundingBox())!.width).toBeLessThan(box.width - 40);
    const resizedWidth = (await browser.boundingBox())!.width;
    await expect.poll(async () => (await native())?.visible).toBe(true);
    // An unrelated overlay outside the browser must not blank its viewport.
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.id = 'browser-occlusion-fixture';
      overlay.className = 'modal-overlay';
      overlay.style.cssText = 'position:fixed;inset:auto;left:0;top:0;width:1px;height:1px;display:block';
      document.body.appendChild(overlay);
      return new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    expect((await native())?.visible).toBe(true);
    await page.evaluate(() => {
      const overlay = document.getElementById('browser-occlusion-fixture')!;
      const rect = document.querySelector('.web-assist-native-host')!.getBoundingClientRect();
      overlay.style.left = `${rect.left + 10}px`;
      overlay.style.top = `${rect.top + 10}px`;
      overlay.style.width = '20px';
      overlay.style.height = '20px';
    });
    await expect.poll(async () => (await native())?.visible).toBe(false);
    await page.evaluate(() => document.getElementById('browser-occlusion-fixture')!.remove());
    await expect.poll(async () => (await native())?.visible).toBe(true);
    expect((await native())?.id).toBe(pageBeforeResize);
    expect(await resizeDocument()).toEqual(documentBeforeResize);
    await page.evaluate(() => (window as any).ConversationInfo.openAndSetTab('files'));
    await expect(browser).toBeHidden();
    await expect.poll(async () => (await native())?.visible).toBe(false);
    await page.evaluate(() => (window as any).ConversationInfo.openAndSetTab('browser'));
    await expect(browser).toBeVisible();

    await page.locator('.web-assist-add-tab').click();
    await expect(page.locator('.web-assist-tab')).toHaveCount(2);
    await page.locator('.web-assist-address-input').fill(`http://127.0.0.1:${address.port}/second`);
    await page.locator('.web-assist-address-input').press('Enter');
    await expect.poll(async () => {
      const result = await orkas.invoke<{ state: { display_url: string } }>('webAssist.state', {});
      return result.state.display_url;
    }).toContain('/second');
    const activeState = await orkas.invoke<{ state: { active_tab_id: string } }>('webAssist.state', {});
    const modelObservation = await orkas.electronApp!.evaluate(async (_electron, input) => {
      const web = (process as any).mainModule.require(input.modulePath);
      return web.observeModelWebAssist('account-e2e', input.cid, input.tabId);
    }, {
      cid,
      tabId: activeState.state.active_tab_id,
      modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts'),
    });
    expect(modelObservation).toMatchObject({ ok: true, untrusted_content: true });
    const inputRef = (modelObservation.elements as Array<{ ref: string; label: string }>)
      .find(element => element.label === 'Application name')?.ref;
    expect(inputRef).toBeTruthy();
    const purchase = (modelObservation.elements as Array<{
      ref: string;
      label: string;
      requires_user_action: boolean;
    }>).find(element => element.label === 'Purchase now');
    expect(purchase).toMatchObject({ requires_user_action: true });
    const blockedAction = await orkas.electronApp!.evaluate(async (_electron, input) => {
      const web = (process as any).mainModule.require(input.modulePath);
      return web.actOnModelWebAssist('account-e2e', input.cid, {
        tabId: input.tabId,
        pageId: input.pageId,
        elementRef: input.elementRef,
        action: 'click',
      });
    }, {
      cid,
      tabId: activeState.state.active_tab_id,
      pageId: modelObservation.page_id,
      elementRef: purchase!.ref,
      modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts'),
    });
    expect(blockedAction).toMatchObject({
      ok: false, code: 'user_action_required', reason: 'high_impact_action',
    });
    const modelAction = await orkas.electronApp!.evaluate(async (_electron, input) => {
      const web = (process as any).mainModule.require(input.modulePath);
      return web.actOnModelWebAssist('account-e2e', input.cid, {
        tabId: input.tabId,
        pageId: input.pageId,
        elementRef: input.elementRef,
        action: 'fill',
        text: 'Orkas shared browser',
      });
    }, {
      cid,
      tabId: activeState.state.active_tab_id,
      pageId: modelObservation.page_id,
      elementRef: inputRef,
      modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts'),
    });
    expect(modelAction).toMatchObject({ ok: true, outcome: 'acted' });
    await page.locator('.web-assist-tab-close').last().click();
    await expect(page.locator('.web-assist-tab')).toHaveCount(1);

    await page.evaluate(() => (window as any).setView('connectors'));
    await expect(browser).toBeHidden();
    await expect.poll(async () => (await native())?.visible).toBe(false);
    await page.evaluate(cid => (window as any).setView('conversation', cid), cid);
    await page.evaluate(() => (window as any).ConversationInfo.openAndSetTab('browser'));
    await expect.poll(async () => (await native())?.visible).toBe(true);
    expect((await browser.boundingBox())!.width).toBe(resizedWidth);

    await page.evaluate(async taskId => {
      await (window as any).openAgentDetail('commander', {
        returnTarget: { view: 'conversation', id: taskId },
      });
    }, cid);
    await expect(page.locator('#panel-agents')).toHaveClass(/resource-detail-overlay/);
    await expect(page.locator('#agents-detail-view')).toBeVisible();
    await expect.poll(async () => (await native())?.visible).toBe(false);
    await page.locator('#agents-back-btn').click();
    await expect(page.locator('#panel-agents')).not.toHaveClass(/resource-detail-overlay/);
    await expect.poll(async () => (await native())?.visible).toBe(true);

    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.id = 'web-assist-e2e-overlay';
      overlay.className = 'modal-overlay open';
      document.body.appendChild(overlay);
    });
    await expect.poll(async () => (await native())?.visible).toBe(false);
    await page.evaluate(() => document.getElementById('web-assist-e2e-overlay')?.remove());
    await expect.poll(async () => (await native())?.visible).toBe(true);
    const state = await orkas.invoke<{ state: { conversation_id: string; assistant_controlled: boolean } }>('webAssist.state', {});
    expect(state.state).toMatchObject({ conversation_id: cid, assistant_controlled: true });
    await page.screenshot({ path: testInfo.outputPath('conversation-browser-panel.png') });
    await orkas.invoke('webAssist.close', {});
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
