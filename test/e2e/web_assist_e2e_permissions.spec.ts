import { createServer } from 'node:http';
import { expect, OrkasTestApp, test } from './fixtures/orkas';

test('website permission stays with its tab, grants only its trusted answer, and restores the live page', async ({}, info) => {
  test.setTimeout(90_000);
  const orkas = new OrkasTestApp(info, { seedLanguage: 'zh', softwareRendering: true });
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Consent fixture</title><h1>Website consent</h1><input value="Keep this form">');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await orkas.launch();
    const page = orkas.page!;
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { conversation } = await orkas.invoke<any>('conversations.create', { title: 'Permission browser' });
    const cid = conversation.conversation_id;
    await page.evaluate(async taskId => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', taskId);
      (window as any).ConversationInfo.openAndSetTab('browser', taskId);
    }, cid);
    const opened = await orkas.invoke<any>('webAssist.open', { conversationId: cid, url: origin + '/request?secret=fixture' });
    const tabId = opened.tab_id;
    await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.loading).toBe(false);
    const contentsId = await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView, dialog }) => {
      // A native modal is a regression; fail it without opening an OS dialog.
      (globalThis as any).nativeConsentCalls = 0;
      dialog.showMessageBox = (async () => { (globalThis as any).nativeConsentCalls++; throw new Error('Native consent is prohibited in this scenario'); }) as any;
      return BrowserWindow.getAllWindows()[0].contentView.children
        .filter(v => v instanceof WebContentsView).at(-1)!.webContents.id;
    });
    const run = (script: string) => orkas.electronApp!.evaluate(async ({ webContents }, args) => {
      return webContents.fromId(args.id)!.executeJavaScript(args.script, true);
    }, { id: contentsId, script });
    await run('window.permissionResult="pending"; void Notification.requestPermission().then(result => window.permissionResult=result); true');
    const prompt = page.locator('.web-assist-permission-prompt:not(.web-assist-page-dialog)');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(origin);
    await expect(prompt).toContainText('通知');
    await expect(prompt).not.toContainText('secret=fixture');
    await expect(prompt.locator('[data-act="deny-permission"]')).toBeFocused();
    await page.evaluate(() => (window as any).setLang('en'));
    await expect(prompt).toContainText('notifications');
    await page.evaluate(() => (window as any).setLang('zh'));
    await expect(prompt).toContainText('通知');
    const request = (await orkas.invoke<any>('webAssist.state')).state.tabs.find((tab: any) => tab.tab_id === tabId).permission_request;
    expect(await orkas.invoke('webAssist.permissionResponse', { tabId, requestId: 'stale-request', allowed: true })).toMatchObject({ handled: false });
    await expect(prompt).toBeVisible();
    expect(await run('window.permissionResult')).toBe('pending');
    await page.screenshot({ path: info.outputPath('website-permission.png') });
    // The task composer remains interactive while this page asks permission.
    await page.locator('#chat-input').fill('The rest of Orkas is available');
    await page.keyboard.press('Escape');
    await expect(prompt).toBeVisible();
    const other = await orkas.invoke<any>('webAssist.addTab', { conversationId: cid });
    const otherId = other.state.active_tab_id;
    await expect(prompt).toBeHidden();
    expect(await orkas.invoke('webAssist.permissionResponse', { tabId, requestId: request.id, allowed: true })).toMatchObject({ handled: false });
    await page.locator(`.web-assist-tab[data-tab-id="${tabId}"] .web-assist-tab-title`).click();
    await expect(prompt).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(prompt).toBeHidden();
    await expect.poll(() => run('window.permissionResult')).toBe('denied');
    await page.locator('[data-act="permissions"]').click();
    await run('window.permissionResult="pending"; void Notification.requestPermission().then(result => window.permissionResult=result); true');
    await expect(prompt).toBeVisible();
    await prompt.locator('[data-act="allow-permission"]').click();
    await expect(prompt).toBeHidden();
    await expect.poll(() => run('window.permissionResult')).toBe('granted');
    expect(await run('document.querySelector("input").value')).toBe('Keep this form');
    await expect.poll(async () => orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }, id) => {
      return BrowserWindow.getAllWindows()[0].contentView.children.some(view => view instanceof WebContentsView && view.webContents.id === id && view.getVisible());
    }, contentsId)).toBe(true);
    expect(await orkas.electronApp!.evaluate(() => (globalThis as any).nativeConsentCalls)).toBe(0);
    expect((await orkas.invoke<any>('webAssist.state')).state.tabs.some((tab: any) => tab.tab_id === otherId)).toBe(true);
    await page.locator('[data-act="permissions"]').click();
    await run('void Notification.requestPermission(); true');
    await expect(prompt).toBeVisible();
    const stale = (await orkas.invoke<any>('webAssist.state')).state.tabs.find((tab: any) => tab.tab_id === tabId).permission_request;
    await orkas.invoke('webAssist.navigateTo', { tabId, url: origin + '/next' });
    await expect(prompt).toBeHidden();
    expect(await orkas.invoke('webAssist.permissionResponse', { tabId, requestId: stale.id, allowed: true })).toMatchObject({ handled: false });
  } finally {
    await orkas.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
