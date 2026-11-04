import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from './fixtures/orkas';


for (const kind of ['blob', 'data']) {
  test(`page-generated ${kind} CSV stays out of user messages until explicitly selected, including restart`, async ({ modelOrkas: orkas }, testInfo) => {
    const csv = 'url,status\nhttps://example.com/report,indexed\n';
    const server = createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><title>Report export</title><button id="export">Export CSV</button><script>
        document.getElementById('export').onclick = () => {
          const link = document.createElement('a');
          link.href = ${kind === 'blob' ? `URL.createObjectURL(new Blob([${JSON.stringify(csv)}], {type:'text/csv'}))` : `'data:text/csv;charset=utf-8,' + encodeURIComponent(${JSON.stringify(csv)})`};
          link.download = 'site-export.csv';
          document.body.append(link); link.click(); link.remove();
        };
      </script>`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      let page = orkas.page!;
      await page.setViewportSize(kind === 'blob' ? { width: 1440, height: 900 } : { width: 800, height: 600 });
      await page.evaluate(lang => (window as any).setLang(lang), kind === 'blob' ? 'en' : 'zh');
      const cid = (await orkas.invoke<any>('conversations.create', { title: 'Generated report download' })).conversation.conversation_id;
      await page.evaluate(async ({ cid, origin }) => {
        await (window as any).loadConversations();
        (window as any).setView('conversation', cid);
        await (window as any).WebAssist.openForModel({ url: origin });
      }, { cid, origin });
      await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.loading).toBe(false);
      const nativeId = await orkas.electronApp!.evaluate(({ BrowserWindow, WebContentsView }) => {
        const view = BrowserWindow.getAllWindows()[0].contentView.children.find(item => item instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
        return view.webContents.id;
      });
      const trigger = () => orkas.electronApp!.evaluate(async ({ webContents }, id) => {
        await webContents.fromId(id)!.executeJavaScript('document.getElementById("export").click(); void 0', true);
      }, nativeId);
      await trigger();
      const prompt = page.locator('.web-assist-download-prompt');
      await expect(prompt).toBeHidden();
      await expect.poll(async () => (await orkas.invoke<any>('webAssist.downloads', { conversation_id: cid })).downloads.at(-1).state).toBe('saved');
      const file = await orkas.invoke<any>('attachments.absPath', { cid, name: 'site-export.csv' });
      expect(file.ok).toBe(true);
      expect(readFileSync(file.path, 'utf8')).toBe(csv);
      expect(JSON.parse(readFileSync(join(dirname(file.path), '.generated-attachments.json'), 'utf8'))).toEqual(['site-export.csv']);
      expect((await orkas.invoke<any>('conversations.attachments.list', { cid })).items).toEqual([]);
      await expect(prompt).toBeHidden();
      await page.locator('#conversation-info-close').click();
      await page.locator('#chat-input').fill('Analyze the concentrated downloads.');
      await page.locator('#chat-send-btn').click();
      await expect(page.locator('#chat-history .chat-message.user')).toHaveCount(1);
      await expect(page.locator('#chat-history .chat-message.user .chat-msg-attach')).toHaveCount(0);
      await expect(page.locator('#chat-history .chat-message.assistant', { hasText: 'Hello from the local E2E model.' })).toHaveCount(1);
      await expect(page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);

      // A later explicit selection is a separate user input. It and an
      // independent draft must survive a real process restart without the
      // original browser file being resurrected alongside them.
      const notes = orkas.createFixtureFile('my-notes.txt', 'user draft');
      await orkas.selectFilesOnNextDialog([notes, file.path]);
      await page.locator('#chat-attach-btn').click();
      const selected = (await orkas.invoke<any>('conversations.attachments.list', { cid })).items.map((item: any) => item.name);
      expect(selected).toHaveLength(2);
      expect(selected).toContain('my-notes.txt');
      expect(selected).not.toContain('site-export.csv');
      page = await orkas.relaunch();
      await page.locator(`#conversation-list .conv-item[data-cid="${cid}"]`).click();
      await expect(page.locator('#chat-attachments .chat-attach-chip')).toHaveCount(2);
      await page.locator('#chat-input').fill('Use the two files I selected.');
      await page.locator('#chat-send-btn').click();
      const second = page.locator('#chat-history .chat-message.user').nth(1);
      await expect(second.locator('.chat-msg-attach .chat-attach-label')).toHaveCount(2);
      expect((await second.locator('.chat-msg-attach .chat-attach-label').allTextContents()).sort()).toEqual(selected.sort());
      await expect(page.locator('#chat-history .chat-message.assistant', { hasText: 'Hello from the local E2E model.' })).toHaveCount(2);
      expect(readFileSync(file.path, 'utf8')).toBe(csv);
      await page.screenshot({ path: testInfo.outputPath('download-saved.png') });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

test('an interrupted browser download never becomes a draft, removes its partial file and permits explicit selection on retry', async ({ orkas }) => {
  const server = createServer((req, res) => {
    if (req.url === '/download') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="partial.csv"', 'Content-Length': '1000000' });
      res.write('unfinished,rows\n');
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Interrupted export</title><a id="export" href="/download">Export CSV</a>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const cid = (await orkas.invoke<any>('conversations.create', { title: 'Interrupted export' })).conversation.conversation_id;
    await orkas.page!.evaluate(async ({ cid, origin }) => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', cid);
      await (window as any).WebAssist.openForModel({ url: origin });
    }, { cid, origin });
    await expect.poll(async () => (await orkas.invoke<any>('webAssist.state')).state.loading).toBe(false);
    await orkas.electronApp!.evaluate(async ({ BrowserWindow, WebContentsView }) => {
      const view = BrowserWindow.getAllWindows()[0].contentView.children.find(item => item instanceof WebContentsView) as InstanceType<typeof WebContentsView>;
      view.webContents.session.once('will-download', (_event, item) => { (globalThis as any).__interruptedDownload = item; });
      await view.webContents.executeJavaScript('document.getElementById("export").click(); void 0', true);
    });
    await expect.poll(async () => (await orkas.invoke<any>('webAssist.downloads', { conversation_id: cid })).downloads.at(-1)?.state).toBe('downloading');
    const partial = await orkas.invoke<any>('attachments.absPath', { cid, name: 'partial.csv' });
    expect(partial.ok).toBe(true);
    expect((await orkas.invoke<any>('conversations.attachments.list', { cid })).items).toEqual([]);
    await orkas.electronApp!.evaluate(() => {
      (globalThis as any).__interruptedDownload.cancel();
      delete (globalThis as any).__interruptedDownload;
    });
    await expect.poll(async () => (await orkas.invoke<any>('webAssist.downloads', { conversation_id: cid })).downloads.at(-1)?.state).toBe('failed');
    expect(existsSync(partial.path)).toBe(false);
    expect((await orkas.invoke<any>('conversations.attachments.list', { cid })).items).toEqual([]);
    expect(await orkas.invoke<any>('conversations.attachments.upload', { cid, name: 'partial.csv', data: Buffer.from('complete,user input').toString('base64') }))
      .toMatchObject({ ok: true, info: { name: 'partial.csv' } });
    expect((await orkas.invoke<any>('conversations.attachments.list', { cid })).items.map((item: any) => item.name)).toEqual(['partial.csv']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
