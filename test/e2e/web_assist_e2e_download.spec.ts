import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { expect, test } from './fixtures/orkas';

for (const kind of ['blob', 'data']) {
  test(`page-generated ${kind} CSV shows a usable site grant and saves on retry`, async ({ orkas }, testInfo) => {
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
      const page = orkas.page!;
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
      await expect(prompt).toBeVisible();
      await expect(prompt.locator('.web-assist-download-origin')).toHaveText(origin);
      await expect(prompt.locator('.web-assist-download-filename')).toHaveText('site-export.csv');
      await prompt.locator('[data-act="allow-download"]').click();
      await expect(prompt).toBeHidden();
      const granted = await orkas.invoke<any>('webAssist.downloads', { conversation_id: cid });
      expect(granted.allowed_origins).toEqual([origin]);
      expect(granted.downloads.map((entry: any) => entry.state)).toEqual(['refused']);
      await trigger();
      await expect.poll(async () => (await orkas.invoke<any>('webAssist.downloads', { conversation_id: cid })).downloads.at(-1).state).toBe('saved');
      const file = await orkas.invoke<any>('attachments.absPath', { cid, name: 'site-export.csv' });
      expect(file.ok).toBe(true);
      expect(readFileSync(file.path, 'utf8')).toBe(csv);
      await expect(prompt).toBeHidden();
      await page.screenshot({ path: testInfo.outputPath('download-granted.png') });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}
