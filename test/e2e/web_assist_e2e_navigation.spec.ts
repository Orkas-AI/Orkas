import { createServer } from 'node:http';
import { expect, test } from './fixtures/orkas';

test('replacing an in-flight navigation does not show failure, while real failure remains visible until recovery', async ({ orkas }) => {
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
    await expect.poll(async () => (await orkas.invoke<any>('webAssist.state', {})).state.tabs
      .find((tab: any) => tab.tab_id === opened.state.active_tab_id)?.address_url).toBe(origin + '/ready');
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
    await navigate('/slow');
    await expect.poll(() => slowRequests).toBeGreaterThan(0);
    await navigate('/ready');
    await expect.poll(async () => (await evidence()).rejected).toContain(-3);
    await ready();

    await navigate('/failure');
    await expect.poll(async () => (await evidence()).failures).toContain(-324); // ERR_EMPTY_RESPONSE
    await expect.poll(async () => (await state()).error_code).toBe('page_load_failed');
    await expect.poll(async () => (await state()).loading).toBe(false);
    await expect(status).not.toHaveText('');
    await navigate('/ready');
    await ready();
  } finally {
    await orkas.invoke('webAssist.close', {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
