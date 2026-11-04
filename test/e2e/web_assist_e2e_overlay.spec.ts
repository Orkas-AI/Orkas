import { createServer } from 'node:http';
import path from 'node:path';
import sharp from 'sharp';
import { expect, test } from './fixtures/orkas';

test('every declared floating family hides native pixels while model input and screenshots remain live', async ({ modelOrkas: orkas }, testInfo) => {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><style>html{background:rgb(37,190,119)} input,button{font-size:20px}</style>
      <title>Hidden browser fixture</title><h1>${req.url === '/next' ? 'Next page' : 'Original page'}</h1>
      <input id="draft" aria-label="Draft" value="Original unsaved draft"><button id="continue">Continue</button>
      <script>window.tick=0;window.clicks=0;window.trusted=false;window.keys=[];setInterval(()=>window.tick++,100);
      document.querySelector('input').onkeydown=e=>window.keys.push([e.key,e.isTrusted]);
      document.querySelector('button').onclick=e=>{window.clicks++;window.trusted=e.isTrusted};</script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const page = orkas.page!;
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const created = await orkas.invoke<any>('conversations.create', { title: 'Floating UI and background browser' });
    const cid = created.conversation.conversation_id;
    await page.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
    }, cid);
    const opened = await orkas.invoke<any>('webAssist.open', { conversationId: cid, url: origin + '/work' });
    const tabId = opened.state.active_tab_id;
    await page.evaluate(id => (window as any).ConversationInfo.openAndSetTab('browser', id), cid);
    await expect(page.locator('.web-assist-shell')).not.toHaveClass(/is-loading/);
    const native = () => orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
      const owner = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/renderer/index.html'))!;
      return owner.contentView.children.filter(view => view instanceof WebContentsView).map(view => ({
        id: (view as InstanceType<typeof WebContentsView>).webContents.id, visible: view.getVisible(), bounds: view.getBounds(),
      }));
    });
    await expect.poll(async () => (await native()).some(view => view.visible)).toBe(true);
    await expect.poll(async () => {
      const host = (await page.locator('.web-assist-native-host').boundingBox())!;
      const bounds = (await native()).find(view => view.visible)!.bounds;
      return Math.max(...(['x', 'y', 'width', 'height'] as const).map(key => Math.abs(bounds[key] - host[key])));
    }).toBeLessThanOrEqual(1);
    const original = (await native()).find(view => view.visible)!;
    const documentState = () => orkas.electronApp!.evaluate(async ({ webContents }, id) => webContents.fromId(id)!.executeJavaScript(
      '({draft:document.querySelector("input").value,tick:window.tick,clicks:window.clicks,trusted:window.trusted,keys:window.keys,timeOrigin:performance.timeOrigin,title:document.querySelector("h1").textContent})',
    ), original.id);
    const before = await documentState();
    // This name is deliberately absent from all production selectors. The
    // floating-layer declaration, not feature inventory, owns participation.
    await page.evaluate(() => {
      const style = document.createElement('style'); style.id = 'new-floating-style';
      style.textContent = '.never-seen-floating-family{--orkas-ui-layer:overlay;position:fixed;z-index:16000;left:20px;top:80px;width:280px;height:160px;background:white}';
      document.head.appendChild(style);
      const first = document.createElement('section'); first.id = 'first-floating'; first.className = 'never-seen-floating-family';
      first.innerHTML = '<input id="floating-input" aria-label="Floating draft" value="Panel draft"><button id="close-floating">Close</button>';
      first.querySelector('button')!.onclick = () => first.remove(); document.body.appendChild(first);
    });
    await expect.poll(async () => (await native()).every(view => !view.visible)).toBe(true);
    await expect(page.locator('#first-floating')).toHaveCSS('opacity', '1');
    await page.locator('#floating-input').focus();
    await page.screenshot({ path: testInfo.outputPath('floating-ui-browser-hidden.png') });
    const scope = { cid, tabId, modulePath: path.resolve(__dirname, '../../src/main/features/web_assist.ts') };
    const observed = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      const web = (process as any).mainModule.require(args.modulePath);
      const owner = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().includes('/renderer/index.html'))!;
      // Direct deterministic tool execution needs the same task-owner binding
      // normally established when the host starts the model turn.
      web.bindWebAssistConversation('account-e2e', args.cid, owner.webContents);
      return web.observeModelWebAssist('account-e2e', args.cid, args.tabId);
    }, scope);
    expect(observed).toMatchObject({ ok: true });
    const fill = observed.elements.find((element: any) => element.label === 'Draft');
    expect(fill).toBeTruthy();
    const act = (elementRef: string, action: string, text?: string) => orkas.electronApp!.evaluate(async (_electron, args) => (
      (process as any).mainModule.require(args.modulePath).actOnModelWebAssist('account-e2e', args.cid, {
        tabId: args.tabId, pageId: args.pageId, elementRef: args.elementRef, action: args.action, ...(args.text ? { text: args.text } : {}),
      })
    ), { ...scope, pageId: observed.page_id, elementRef, action, text });
    expect(await act(fill.ref, 'fill', 'Written by model while hidden')).toMatchObject({ ok: true, outcome: 'acted' });
    // A fresh observation protects real input from a stale page reference.
    const nextObserved = await orkas.electronApp!.evaluate(async (_electron, args) => (
      (process as any).mainModule.require(args.modulePath).observeModelWebAssist('account-e2e', args.cid, args.tabId)
    ), scope);
    const clicked = await orkas.electronApp!.evaluate(async (_electron, args) => (
      (process as any).mainModule.require(args.modulePath).actOnModelWebAssist('account-e2e', args.cid, {
        tabId: args.tabId, pageId: args.pageId, elementRef: args.ref, action: 'click',
      })
    ), { ...scope, pageId: nextObserved.page_id, ref: nextObserved.elements.find((element: any) => element.label === 'Continue').ref });
    expect(clicked).toMatchObject({ ok: true, outcome: 'acted' });
    const keyboardObserved = await orkas.electronApp!.evaluate(async (_electron, args) => (
      (process as any).mainModule.require(args.modulePath).observeModelWebAssist('account-e2e', args.cid, args.tabId)
    ), scope);
    const keyed = await orkas.electronApp!.evaluate(async (_electron, args) => (
      (process as any).mainModule.require(args.modulePath).actOnModelWebAssist('account-e2e', args.cid, {
        tabId: args.tabId, pageId: args.pageId, elementRef: args.ref, action: 'press', keys: 'End',
      })
    ), { ...scope, pageId: keyboardObserved.page_id, ref: keyboardObserved.elements.find((element: any) => element.label === 'Draft').ref });
    expect(keyed).toMatchObject({ ok: true, outcome: 'acted' });
    expect((await documentState()).keys).toEqual([['End', true]]);
    expect(await documentState()).toMatchObject({ draft: 'Written by model while hidden', clicks: 1, trusted: true, timeOrigin: before.timeOrigin });
    await expect(page.locator('#floating-input')).toBeFocused();
    await expect(page.locator('#floating-input')).toHaveValue('Panel draft');
    expect((await native())[0]).toMatchObject({ id: original.id, visible: false, bounds: original.bounds });
    expect((await documentState()).tick).toBeGreaterThan(before.tick);
    const screenshot = await orkas.electronApp!.evaluate(async (_electron, args) => (
      (process as any).mainModule.require(args.modulePath).screenshotModelWebAssist('account-e2e', args.cid, { tabId: args.tabId })
    ), scope);
    expect(JSON.parse(screenshot.content).ok).toBe(true);
    const pixels = await sharp(Buffer.from(screenshot.images![0].data, 'base64')).ensureAlpha().raw().toBuffer();
    expect([...pixels.subarray(0, 3)].every((value, index) => Math.abs(value - [37, 190, 119][index]) <= 5)).toBe(true);
    await expect(page.locator('.web-assist-native-host img')).toHaveCount(0);
    expect((await native())[0].visible).toBe(false);

    // A second independently declared surface keeps the browser hidden after
    // the first is removed, including an abnormal DOM removal rather than close.
    await page.evaluate(() => {
      const next = document.createElement('div'); next.id = 'second-floating'; next.setAttribute('role', 'menu');
      next.style.cssText = 'position:fixed;left:40px;top:280px;width:100px;height:100px;background:white'; document.body.appendChild(next);
    });
    await page.locator('#close-floating').click();
    await expect(page.locator('#first-floating')).toHaveCount(0);
    expect((await native())[0].visible).toBe(false);
    await page.evaluate(() => document.getElementById('second-floating')!.remove());
    await expect.poll(async () => (await native())[0].visible).toBe(true);
    expect((await native())[0]).toMatchObject({ id: original.id, visible: true });
    // Model status adds existing browser chrome. Restoration follows the
    // current host rectangle rather than reviving the pre-operation layout.
    await expect.poll(async () => {
      const host = (await page.locator('.web-assist-native-host').boundingBox())!;
      const restored = (await native())[0].bounds;
      return Math.max(...(['x', 'y', 'width', 'height'] as const).map(key => Math.abs(restored[key] - host[key])));
    }).toBeLessThanOrEqual(1);
    expect(await documentState()).toMatchObject({ draft: 'Written by model while hidden', timeOrigin: before.timeOrigin });

    // Rapid replacement, a model navigation and old trusted layout messages
    // cannot remove the current layer's native presentation suppression.
    await page.evaluate(async () => {
      for (let i = 0; i < 8; i++) {
        const element = document.createElement('div'); element.className = 'ui-overlay';
        element.style.cssText = 'position:fixed;width:80px;height:80px'; document.body.appendChild(element);
        await Promise.resolve(); element.remove();
      }
      const final = document.createElement('div'); final.id = 'final-floating'; final.className = 'ui-overlay';
      final.style.cssText = 'position:fixed;width:80px;height:80px'; document.body.appendChild(final);
    });
    await expect.poll(async () => (await native())[0].visible).toBe(false);
    expect(await orkas.electronApp!.evaluate(async (_electron, args) => (
      (process as any).mainModule.require(args.modulePath).navigateModelWebAssist('account-e2e', args.cid, { tabId: args.tabId, action: 'goto', url: args.url })
    ), { ...scope, url: origin + '/next' })).toMatchObject({ ok: true });
    await expect.poll(async () => (await documentState()).title).toBe('Next page');
    expect((await native())[0].visible).toBe(false);
    await orkas.invoke('webAssist.layout', { ...original.bounds, overlayRevision: 0 });
    expect((await native())[0].visible).toBe(false);
    // Closing the drawer is a separate user choice and survives release.
    await page.evaluate(() => (window as any).ConversationInfo.close());
    await page.evaluate(() => document.getElementById('final-floating')!.remove());
    await expect(page.locator('.web-assist-shell')).toBeHidden();
    expect((await native())[0].visible).toBe(false);
    await page.evaluate(id => (window as any).ConversationInfo.openAndSetTab('browser', id), cid);
    await expect.poll(async () => (await native())[0].visible).toBe(true);
    expect((await native())[0].id).toBe(original.id);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
