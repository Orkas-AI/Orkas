import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { expect, test } from './fixtures/orkas';

// A console exposes its report in ordinary cells and commits component state,
// not the DOM input value. HTTP receipts independently establish what it saved.
test('task browser reads a console report and submits the accepted field value', async ({ orkas }) => {
  const submissions: string[] = [];
  let completeDownload: (() => void) | undefined;
  const server = createServer((req, res) => {
    if (req.url === '/report.csv') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="index-report.csv"' });
      res.write('url,status\n');
      completeDownload = () => res.end('/blog/cloud-sync/,not indexed\n');
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { submissions.push(body); res.end('accepted'); });
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Console report</title>
      <h1>Index report</h1>
      <div>Discovered <span>104 pages</span></div>
      <table><tr><th>URL</th><th>Status</th></tr><tr><td>/blog/cloud-sync/</td><td>Not indexed</td></tr></table>
      <div role="tree"><div role="treeitem" tabindex="0" aria-expanded="false">blog</div></div>
      <div hidden>hidden-private-text</div><p>Public <span hidden>nested-private-text</span>summary</p>
      <input type="password" value="password-private-value"><textarea>draft-private-value</textarea>
      <div contenteditable="true">editor-private-value</div><pre>code-private-value</pre>
      <section id="shadow"></section><p>${'L'.repeat(1500)} paragraph-tail</p>
      <form><label>Inspect address<input id="address" value="initial"></label><button>Inspect</button></form>
      <label>Readonly field<input readonly value="original"></label>
      <label>Rejected field<input id="rejected" value="unchanged"></label>
      <a href="/report.csv">Download report</a>
      <p role="status" id="receipt"></p>
      <script>
        const field = document.getElementById('address');
        let state = 'initial';
        field.addEventListener('focus', () => { field.value = state; });
        field.addEventListener('input', event => {
          if (event instanceof InputEvent) state = field.value;
          else field.value = state;
        });
        document.querySelector('form').addEventListener('submit', async event => {
          event.preventDefault();
          await fetch('/inspect', {method:'POST', body:state, signal:AbortSignal.timeout(5000)});
          document.getElementById('receipt').textContent = 'Inspected: ' + state;
        });
        document.getElementById('shadow').attachShadow({mode:'open'}).innerHTML = '<div>Shadow report ready</div>';
        document.getElementById('rejected').addEventListener('input', event => {
          queueMicrotask(() => { event.target.value = 'unchanged'; });
        });
      </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Console inspection' })).conversation.conversation_id;
  const root = path.resolve(__dirname, '../..');
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await orkas.page!.evaluate(async id => {
      await (window as any).loadConversations();
      (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser');
    }, cid);
    await test.step('bind the native browser tool on the normal main event loop', () => orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      // Inspector evaluation can interrupt a lazy ESM import. Requiring the
      // same dependency on that stack reenters the loader and spins forever.
      await new Promise<void>(resolve => setImmediate(resolve));
      const require = (process as any).mainModule.require;
      require(args.root + '/src/main/features/web_assist.ts').bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
      require(args.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', args.cid, 'console-test');
      (globalThis as any).__consoleBrowser = require(args.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', args.cid);
    }, { root, cid }));
    const call = (input: Record<string, unknown>) => test.step(`browser ${input.operation} ${input.page_action || ''}`, () => orkas.electronApp!.evaluate(async (_electron, args) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      const result = await (globalThis as any).__consoleBrowser.execute(args, { state: {} });
      return JSON.parse(result.content);
    }, input));
    expect(await call({ operation: 'open', url: origin })).toMatchObject({ ok: true });
    expect(await call({ operation: 'wait' })).toMatchObject({ ok: true });
    let observed = await call({ operation: 'observe' });
    for (const text of ['104 pages', '/blog/cloud-sync/', 'Not indexed', 'Shadow report ready', 'paragraph-tail']) {
      expect.soft(observed.text).toContain(text);
    }
    expect.soft(observed.elements.some((entry: any) => entry.role === 'treeitem' && entry.label === 'blog')).toBe(true);
    expect.soft(observed.text).not.toContain('private-');
    expect.soft(JSON.stringify(observed)).not.toContain('private-value');
    const fill = async (text: string, label = 'Inspect address') => {
      observed = await call({ operation: 'observe' });
      const entry = observed.elements.find((entry: any) => entry.label === label);
      return call({ operation: 'act', page_id: observed.page_id, element_ref: entry.ref, page_action: 'fill', text });
    };
    for (const text of ['https://orkas.ai/blog/cloud-sync/', '日本語 & second', '']) {
      expect(await fill(text)).toMatchObject({ ok: true });
      observed = await call({ operation: 'observe' });
      const button = observed.elements.find((entry: any) => entry.label === 'Inspect');
      expect(await call({ operation: 'act', page_id: observed.page_id, element_ref: button.ref, page_action: 'click' })).toMatchObject({ ok: true });
      await expect.poll(() => submissions.at(-1)).toBe(text);
    }
    expect(await fill('must-not-change', 'Readonly field')).toMatchObject({ ok: false, code: 'element_readonly' });
    expect(await fill('must-not-claim-success', 'Rejected field')).toMatchObject({ ok: false, code: 'fill_rejected' });
    expect(submissions).toEqual(['https://orkas.ai/blog/cloud-sync/', '日本語 & second', '']);
    // The same explicit origin grant as the user's download approval; the model
    // only clicks the link and queries receipts through its existing tabs tool.
    expect(await orkas.invoke('webAssist.allowDownloadOrigin', { conversation_id: cid, origin })).toMatchObject({ ok: true });
    observed = await call({ operation: 'observe' });
    const download = observed.elements.find((entry: any) => entry.label === 'Download report');
    expect(await call({ operation: 'act', page_id: observed.page_id, element_ref: download.ref, page_action: 'click' })).toMatchObject({ ok: true });
    await expect.poll(async () => (await call({ operation: 'tabs' })).downloads.at(-1)?.state).toBe('downloading');
    expect((await call({ operation: 'tabs' })).downloads.at(-1)).not.toHaveProperty('path');
    completeDownload!();
    await expect.poll(async () => (await call({ operation: 'tabs' })).downloads.at(-1)?.state).toBe('saved');
    const saved = (await call({ operation: 'tabs' })).downloads.at(-1);
    expect(readFileSync(saved.path, 'utf8')).toBe('url,status\n/blog/cloud-sync/,not indexed\n');
  } finally {
    await orkas.invoke('webAssist.close', {});
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
