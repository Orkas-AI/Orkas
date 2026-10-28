import { createServer } from 'node:http';
import { expect, OrkasTestApp, test as base } from './fixtures/orkas';

// These journeys verify browser chrome and navigation, not GPU overlays.
// Hidden native pages can otherwise emit Chromium mailbox errors.
const test = base.extend({
  orkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { softwareRendering: true });
    try { await app.launch(); await use(app); } finally { await app.dispose(); }
  },
});

test('a scheme-less loopback address recovers after its local service becomes ready', async ({ orkas }) => {
  let pageRequests = 0;
  const server = createServer((req, res) => {
    if (req.url === '/ready?item=one') pageRequests++;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    res.end('<title>Local service ready</title><h1>Local service ready</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const page = orkas.page!;
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Local service startup' })).conversation.conversation_id;
  try {
    await page.evaluate(async id => {
      const app = window as any;
      await app.loadConversations(); app.setView('conversation', id);
      app.ConversationInfo.openAndSetTab('browser');
    }, cid);
    await expect(page.locator('.web-assist-tab')).toHaveCount(1);
    const tabId = (await orkas.invoke<any>('webAssist.state')).state.active_tab_id;
    const nativeId = await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView && v.webContents.getURL() === '') as InstanceType<typeof WebContentsView>;
      (globalThis as any).__loopbackNetErrors = [];
      view.webContents.on('did-fail-load', (_event, code) => (globalThis as any).__loopbackNetErrors.push(code));
      return view.webContents.id;
    });
    const address = page.locator('.web-assist-address-input');
    const input = `127.0.0.1:${port}/ready?item=one#board`;
    await address.fill(input); await address.press('Enter');
    await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.error_code).toBe('page_load_failed');
    expect(await orkas.electronApp!.evaluate(() => (globalThis as any).__loopbackNetErrors)).toContain(-102);
    const root = require('node:path').resolve(__dirname, '../..');
    await orkas.electronApp!.evaluate(({ BrowserWindow }, args) => {
      const require = (process as any).mainModule.require;
      require(args.root + '/src/main/features/web_assist.ts').bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
      require(args.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', args.cid, 'loopback-startup');
      (globalThis as any).__loopbackWaitTool = require(args.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', args.cid);
    }, { root, cid });
    const wait = () => orkas.electronApp!.evaluate(async (_electron, tabId) => {
      const result = await (globalThis as any).__loopbackWaitTool.execute({ operation: 'wait', tab_id: tabId, wait_condition: 'loaded', timeout_ms: 500 }, { state: {} });
      return { ...JSON.parse(result.content), isError: result.isError === true };
    }, tabId);
    expect(await wait()).toMatchObject({ ok: false, code: 'page_load_failed', isError: true });
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    // Service readiness alone must not turn an un-retried error document into success.
    expect(await wait()).toMatchObject({ ok: false, code: 'page_load_failed', isError: true });
    expect(pageRequests).toBe(0);
    await address.fill(input); await address.press('Enter');
    await expect.poll(async () => {
      const state = (await orkas.invoke<any>('webAssist.state')).state;
      return { url: state.tabs.find((tab: any) => tab.tab_id === tabId)?.address_url, loading: state.loading, error: state.error_code || null };
    }).toEqual({ url: `http://${input}`, loading: false, error: null });
    expect(await wait()).toMatchObject({ ok: true, isError: false });
    expect(await orkas.electronApp!.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('document.querySelector("h1")?.textContent'), nativeId)).toBe('Local service ready');
    expect(pageRequests).toBe(1);
    await orkas.electronApp!.evaluate((_electron, args) => {
      const require = (process as any).mainModule.require;
      require(args.root + '/src/main/features/web_assist_lifecycle.ts').finishBrowserTaskRun('account-e2e', args.cid, 'loopback-startup');
      delete (globalThis as any).__loopbackWaitTool;
    }, { root, cid });
  } finally {
    await orkas.invoke('webAssist.close', {});
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('scrolled browser tabs stay in place through page updates, activation and tab changes', async ({ orkas }) => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Scroll fixture ready</title><h1>Ready</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const page = orkas.page!;
  try {
    const cid = (await orkas.invoke<any>('conversations.create', { title: 'Browser tab scrolling' })).conversation.conversation_id;
    await page.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser');
    }, cid);
    const tabs = page.locator('.web-assist-tab');
    await expect(tabs).toHaveCount(1);
    for (let index = 0; index < 9; index++) {
      expect(await orkas.invoke<any>('webAssist.addTab', { conversationId: cid })).toMatchObject({ ok: true });
    }
    await expect(tabs).toHaveCount(10);
    const state = (await orkas.invoke<any>('webAssist.state')).state;
    const tabId = state.active_tab_id;
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/ready`;
    expect(await orkas.invoke<any>('webAssist.navigateTo', { tabId, url })).toMatchObject({ ok: true });
    const active = page.locator(`.web-assist-tab[data-tab-id="${tabId}"]`);
    await expect(active).toHaveText('Scroll fixture ready');
    const nativeId = await orkas.electronApp!.evaluate(({ webContents }, url) => (
      webContents.getAllWebContents().find(contents => contents.getURL() === url)!.id
    ), url);
    const strip = page.locator('.web-assist-tabs');
    const scroll = () => strip.evaluate(node => node.scrollLeft);
    const left = await strip.evaluate(node => {
      node.scrollLeft = 240;
      return node.scrollLeft;
    });
    expect(left).toBe(240); // Real overflow, away from either scroll boundary.
    await orkas.electronApp!.evaluate(async ({ webContents }, id) => {
      await webContents.fromId(id)!.executeJavaScript('document.title = "Scroll fixture updated"; void 0');
    }, nativeId);
    await expect(active).toHaveText('Scroll fixture updated');
    expect(await scroll()).toBe(left);
    // Observe several frames so a delayed layout/status update cannot undo it.
    expect(await strip.evaluate(async node => {
      const samples: number[] = [];
      for (let frame = 0; frame < 10; frame++) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        samples.push(node.scrollLeft);
      }
      return samples;
    })).toEqual(Array(10).fill(left));

    // A state update during a pointer gesture must retain the clicked target.
    const targetId = await tabs.nth(3).getAttribute('data-tab-id');
    const target = page.locator(`.web-assist-tab[data-tab-id="${targetId}"]`);
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + 15, box.y + box.height / 2);
    await page.mouse.down();
    await orkas.electronApp!.evaluate(async ({ webContents }, id) => {
      await webContents.fromId(id)!.executeJavaScript('document.title = "Scroll fixture clicked"; void 0');
    }, nativeId);
    await expect(active).toHaveText('Scroll fixture clicked');
    await page.mouse.up();
    await expect(target).toHaveAttribute('aria-selected', 'true');
    await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.active_tab_id).toBe(targetId);
    expect(await scroll()).toBe(left);

    expect(await orkas.invoke<any>('webAssist.addTab', { conversationId: cid })).toMatchObject({ ok: true });
    await expect(tabs).toHaveCount(11);
    expect(await scroll()).toBe(left);
    const lastId = await tabs.last().getAttribute('data-tab-id');
    expect(await orkas.invoke<any>('webAssist.closeTab', { tabId: lastId })).toMatchObject({ ok: true });
    await expect(tabs).toHaveCount(10);
    expect(await scroll()).toBe(left);

    // Keyboard focus survives unrelated page updates and still closes its tab.
    const close = target.locator('.web-assist-tab-close');
    await close.focus();
    const focusedLeft = await scroll();
    const firstId = await tabs.first().getAttribute('data-tab-id');
    expect(await orkas.invoke<any>('webAssist.closeTab', { tabId: firstId })).toMatchObject({ ok: true });
    await expect(tabs).toHaveCount(9);
    await expect(close).toBeFocused();
    expect(await scroll()).toBe(focusedLeft);
    await orkas.electronApp!.evaluate(async ({ webContents }, id) => {
      await webContents.fromId(id)!.executeJavaScript('document.title = "Scroll fixture focused"; void 0');
    }, nativeId);
    await expect(active).toHaveText('Scroll fixture focused');
    await expect(close).toBeFocused();
    expect(await scroll()).toBe(focusedLeft);
    await close.press('Enter');
    await expect(page.locator(`.web-assist-tab[data-tab-id="${targetId}"]`)).toHaveCount(0);
    await expect(tabs).toHaveCount(8);
    expect(await scroll()).toBe(focusedLeft);
  } finally {
    await orkas.invoke('webAssist.close', {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

for (const kind of ['URL', 'search'] as const) {
  test(`browser address stays visible while a ${kind} waits for its first response`, async ({ orkas }) => {
    const cid = (await orkas.invoke<any>('conversations.create', { title: 'Pending browser address' })).conversation.conversation_id;
    const page = orkas.page!;
    let nativeId: number | undefined;
    try {
      await page.evaluate(async id => {
        await (window as any).loadConversations();
        (window as any).setView('conversation', id);
        (window as any).ConversationInfo.openAndSetTab('browser');
      }, cid);
      await expect(page.locator('.web-assist-tab')).toHaveCount(1);
      // Hold a real Chromium document response in this isolated browser session.
      // Search remains deterministic and never contacts the public search service.
      nativeId = await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView && v.webContents.getURL() === '') as InstanceType<typeof WebContentsView>;
        let release!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const gate = { release, requested: '' };
        (view.webContents as any).__addressResponseGate = gate;
        view.webContents.session.protocol.handle('https', async request => {
          gate.requested = request.url;
          await pending;
          return new Response('<title>Address ready</title><h1>Navigation completed</h1>', {
            headers: { 'Content-Type': 'text/html' },
          });
        });
        return view.webContents.id;
      });
      const address = page.locator('.web-assist-address-input');
      const destination = kind === 'URL' ? 'https://address.example.test/slow?item=1#section'
        : 'https://www.bing.com/search?q=%E4%B8%8A%E6%B5%B7+%E5%A4%A9%E6%B0%94';
      await address.fill(kind === 'URL' ? destination : '上海 天气');
      await address.evaluate((node: HTMLInputElement) => {
        const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!;
        (node as any).__addressUpdates = [];
        Object.defineProperty(node, 'value', {
          configurable: true,
          get() { return native.get!.call(this); },
          set(value) { (this as any).__addressUpdates.push(value); native.set!.call(this, value); },
        });
      });
      await address.press('Enter');
      await expect.poll(() => orkas.electronApp!.evaluate(({ webContents }, id) =>
        Boolean((webContents.fromId(id) as any).__addressResponseGate.requested), nativeId!),
      ).toBe(true);
      expect(await orkas.electronApp!.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), nativeId)).toBe('');
      await expect(address).toHaveValue(destination);
      expect(await address.evaluate((node: HTMLInputElement) => (node as any).__addressUpdates)).not.toContain('');
      // Blurring or changing tabs must keep the accepted address while loading.
      await page.locator('.web-assist-add-tab').click();
      await expect(address).toHaveValue('');
      await page.locator('.web-assist-tab').first().click();
      await expect(address).toHaveValue(destination);
      await address.evaluate((node: HTMLInputElement) => { (node as any).__addressUpdates = []; });
      const samples = await address.evaluate(async (node: HTMLInputElement) => {
        const values: string[] = [];
        for (let frame = 0; frame < 30; frame++) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          values.push(node.value);
        }
        return values;
      });
      expect(samples).toEqual(Array(30).fill(destination));
      await orkas.electronApp!.evaluate(({ webContents }, id) => (webContents.fromId(id) as any).__addressResponseGate.release(), nativeId);
      await expect.poll(() => orkas.electronApp!.evaluate(({ webContents }, id) => webContents.fromId(id)!.getTitle(), nativeId!)).toBe('Address ready');
      await expect(address).toHaveValue(destination);
      expect(await address.evaluate((node: HTMLInputElement) => (node as any).__addressUpdates)).not.toContain('');
    } finally {
      if (nativeId !== undefined) await orkas.electronApp!.evaluate(({ webContents }, id) => {
        const contents = webContents.fromId(id);
        if (contents) {
          (contents as any).__addressResponseGate.release();
          contents.session.protocol.unhandle('https');
        }
      }, nativeId);
      await orkas.invoke('webAssist.close', {});
    }
  });
}

for (const key of ['Enter', 'Space']) {
  test(`focused browser close button closes its own tab with ${key}`, async ({ orkas }) => {
    const cid = (await orkas.invoke<any>('conversations.create', { title: 'Keyboard browser tabs' })).conversation.conversation_id;
    const page = orkas.page!;
    try {
      await page.evaluate(async id => {
        await (window as any).loadConversations();
        (window as any).setView('conversation', id);
        (window as any).ConversationInfo.openAndSetTab('browser');
      }, cid);
      const tabs = page.locator('.web-assist-tab');
      await expect(tabs).toHaveCount(1);
      const firstId = await tabs.first().getAttribute('data-tab-id');
      await page.locator('.web-assist-add-tab').click();
      await expect(tabs).toHaveCount(2);
      const secondId = await tabs.last().getAttribute('data-tab-id');
      const first = page.locator(`.web-assist-tab[data-tab-id="${firstId}"]`);
      // The tab itself retains keyboard activation; its nested button closes.
      await first.press(key);
      await expect(first).toHaveAttribute('aria-selected', 'true');
      await page.locator(`.web-assist-tab[data-tab-id="${secondId}"]`).click();
      await first.locator('.web-assist-tab-close').press(key);
      await expect(first).toHaveCount(0);
      await expect(tabs).toHaveCount(1);
      await expect(tabs.first()).toHaveAttribute('data-tab-id', secondId!);
    } finally {
      await orkas.invoke('webAssist.close', {});
    }
  });
}

test('browser address preserves query, fragment and long redirects through editing and tab switching', async ({ orkas }) => {
  const destination = `/work?item=one&item=two&encoded=%2F%26&long=${'a'.repeat(2200)}#section`;
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url!);
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/redirect') { res.writeHead(302, { Location: destination }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Address fixture</title><h1>Address ready</h1>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const created = await orkas.invoke<{ conversation: { conversation_id: string } }>('conversations.create', { title: 'Browser address' });
    const cid = created.conversation.conversation_id;
    await orkas.page!.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser');
    }, cid);
    const opened = await orkas.invoke<any>('webAssist.open', { conversationId: cid, url: origin + '/start?keep=1#initial' });
    expect(opened.ok).toBe(true);
    await expect.poll(async () => {
      const tab = (await orkas.invoke<any>('webAssist.state', {})).state.tabs
        .find((tab: any) => tab.tab_id === opened.state.active_tab_id);
      return { url: tab?.address_url, loading: tab?.loading };
    }).toEqual({ url: origin + '/start?keep=1#initial', loading: false });
    const nativeId = await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }, url) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView && v.webContents.getURL() === url) as InstanceType<typeof WebContentsView>;
      return view.webContents.id;
    }, origin + '/start?keep=1#initial');
    const page = orkas.page!;
    const address = page.locator('.web-assist-address-input');
    const actualUrl = () => orkas.electronApp!.evaluate(({ webContents }, id) => webContents.fromId(id)!.getURL(), nativeId);
    await expect(address).toHaveValue(origin + '/start?keep=1#initial');
    await address.fill(origin + '/redirect');
    await address.press('Enter');
    const complete = origin + destination;
    await expect.poll(actualUrl).toBe(complete);
    await expect(address).toBeFocused();
    await expect(address).toHaveValue(complete);
    // Native text selection is the source of ordinary address-bar copy.
    const selected = await address.evaluate((node: HTMLInputElement) => {
      node.select();
      return node.value.slice(node.selectionStart!, node.selectionEnd!);
    });
    expect(selected).toBe(complete);
    expect(requests).toContain(destination.split('#')[0]);
    // Re-submitting a fragment URL may stay in the same document without HTTP.
    // Observe the actual browser submission without changing Chromium behavior.
    await orkas.electronApp!.evaluate(({ webContents }, id) => {
      const contents = webContents.fromId(id)! as Electron.WebContents & { addressSubmissions: string[] };
      contents.addressSubmissions = [];
      const loadURL = contents.loadURL.bind(contents);
      contents.loadURL = (url, options) => {
        contents.addressSubmissions.push(url);
        return loadURL(url, options);
      };
    }, nativeId);
    await address.press('Enter');
    await expect.poll(() => orkas.electronApp!.evaluate(({ webContents }, id) =>
      (webContents.fromId(id)! as Electron.WebContents & { addressSubmissions: string[] }).addressSubmissions,
    nativeId)).toContain(complete);
    await expect.poll(actualUrl).toBe(complete);
    await expect(address).toHaveValue(complete);

    await address.fill(origin + '/draft?edit=1#draft');
    const spa = origin + '/work?spa=1#route';
    await orkas.electronApp!.evaluate(async ({ webContents }, args) => {
      await webContents.fromId(args.id)!.executeJavaScript(`history.pushState(null, '', ${JSON.stringify(args.url)}); void 0`);
    }, { id: nativeId, url: spa });
    await expect.poll(actualUrl).toBe(spa);
    await expect(address).toHaveValue(origin + '/draft?edit=1#draft');
    await address.press('Escape');
    await expect(address).toHaveValue(spa);
    await page.locator('.web-assist-add-tab').click();
    await expect(address).toHaveValue('');
    await page.locator(`.web-assist-tab[data-tab-id="${opened.state.active_tab_id}"]`).click();
    await expect(address).toHaveValue(spa);
    expect(await actualUrl()).toBe(spa);
  } finally {
    await orkas.invoke('webAssist.close', {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('empty task browsers keep one blank new tab and preserve existing pages across reopening and task switches', async ({ orkas }) => {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Retained page</title><input aria-label="Draft">');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = orkas.page!;
    const createTask = async () => (await orkas.invoke<any>('conversations.create', { title: 'Default browser tab' })).conversation.conversation_id as string;
    const cid = await createTask();
    const otherCid = await createTask();
    const show = (taskId: string) => page.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser');
    }, taskId);
    const state = async () => (await orkas.invoke<any>('webAssist.state', {})).state;
    const taskTabs = async (id: string) => (await state()).tabs.filter((tab: any) => tab.conversation_id === id);
    const tabs = page.locator('.web-assist-tab');
    const address = page.locator('.web-assist-address-input');
    await show(cid);
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.locator('.web-assist-tab-title')).toHaveText('New tab');
    await expect(address).toHaveValue('');
    const firstId = (await taskTabs(cid))[0].tab_id;
    const blankNative = await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
      const views = BrowserWindow.getAllWindows()[0].contentView.children.filter(v => v instanceof WebContentsView);
      return views.map(v => ({ url: v.webContents.getURL(), history: v.webContents.navigationHistory.getAllEntries().length }));
    });
    expect(blankNative).toEqual([{ url: '', history: 0 }]);
    // No navigation is initiated just to display the local new-tab surface.
    await page.locator('#conversation-info-close').click();
    await page.locator('#conversation-info-toggle').click();
    await expect(tabs).toHaveCount(1);
    expect((await taskTabs(cid))[0].tab_id).toBe(firstId);
    await page.locator('.web-assist-add-tab').click();
    await expect(tabs).toHaveCount(2);
    await page.locator('.web-assist-tab.is-active .web-assist-tab-close').click();
    await expect(tabs).toHaveCount(1);
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/keep?item=1#section`;
    await address.fill(url);
    await address.press('Enter');
    await expect.poll(async () => {
      const tab = (await taskTabs(cid))[0];
      return { url: tab?.address_url, loading: tab?.loading };
    }).toEqual({ url, loading: false });
    const nativeId = await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }, target) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(v => v instanceof WebContentsView && v.webContents.getURL() === target) as InstanceType<typeof WebContentsView>;
      await view.webContents.executeJavaScript('document.querySelector("input").value = "Saved draft"');
      return view.webContents.id;
    }, url);
    await show(otherCid);
    await expect.poll(async () => (await taskTabs(otherCid)).length).toBe(1);
    await expect(tabs).toHaveCount(1);
    await expect(address).toHaveValue('');
    await show(cid);
    await expect(address).toHaveValue(url);
    await expect(tabs).toHaveCount(1);
    expect((await taskTabs(cid))[0].tab_id).toBe(firstId);
    expect(await orkas.electronApp!.evaluate(({ webContents }, id) => webContents.fromId(id)!.executeJavaScript('document.querySelector("input").value'), nativeId)).toBe('Saved draft');
    await tabs.locator('.web-assist-tab-close').click();
    await expect(address).toHaveValue('');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.locator('.web-assist-tab-title')).toHaveText('New tab');
    expect((await taskTabs(cid))[0].tab_id).not.toBe(firstId);
    expect(await orkas.electronApp!.evaluate(({ webContents }, id) => webContents.fromId(id) === undefined, nativeId)).toBe(true);
    expect(await taskTabs(otherCid)).toHaveLength(1);
  } finally {
    await orkas.invoke('webAssist.close', {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
