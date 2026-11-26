import { createServer } from 'node:http';
import { mkdirSync, truncateSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, OrkasTestApp, test as base } from './fixtures/orkas';

// This native directory-enumeration journey needs an activatable owner from
// creation. Showing a fixture created non-focusable cannot establish it on macOS.
const test = base.extend({
  modelOrkas: async ({}, use, testInfo) => {
    const app = new OrkasTestApp(testInfo, { nativeWindowVisible: true });
    try { await app.launch(); await use(app); } finally { await app.dispose(); }
  },
});

// Website receipts and actual DOM state are independent of tool success flags.
test('task browser reaches frames, native files, options, keys and popup POST forms', async ({ modelOrkas: orkas }) => {
  const uploads: Array<{ bytes: number; files: number; trustedChange: boolean }> = [];
  let postBody = '';
  const server = createServer((request, response) => {
    if (request.url === '/upload') {
      let bytes = 0, files = 0, tail = '';
      request.on('data', chunk => {
        bytes += chunk.length;
        const text = tail + chunk.toString('latin1');
        files += (text.match(/filename="[^"]+"/g) || []).length;
        tail = text.slice(-128).replace(/filename="[^"]+"/g, '');
      });
      request.on('end', () => {
        uploads.push({ bytes, files, trustedChange: request.headers['x-trusted-change'] === 'true' });
        response.end('uploaded');
      });
      return;
    }
    if (request.url === '/posted') {
      request.on('data', chunk => { postBody += chunk.toString(); });
      request.on('end', () => { response.setHeader('Content-Type', 'text/html'); response.end('<title>POST receipt</title><input aria-label="Popup input">'); });
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    const port = (server.address() as { port: number }).port;
    if (request.url === '/child') {
      response.end(`<!doctype html><input aria-label="Child"><button onclick="window.clicks=(window.clicks||0)+1">Child button</button>
        <input type="file" multiple aria-label="Files"><input type="file" webkitdirectory aria-label="Folder">
        <script>document.querySelectorAll('input[type=file]').forEach(input=>input.addEventListener('change',async event=>{const data=new FormData();for(const file of input.files)data.append('files',file);await fetch('/upload',{method:'POST',headers:{'X-Trusted-Change':String(event.isTrusted)},body:data})}))</script>`);
      return;
    }
    response.end(`<!doctype html><style>iframe{width:450px;height:260px}#scroll{width:100px;height:60px;overflow:auto}#scroll div{width:500px;height:500px}</style>
      <input aria-label="Main"><input aria-label="OTP" autocomplete="one-time-code" style="width:150px;height:30px">
      <div contenteditable="" aria-label="Empty editor"></div><div contenteditable="plaintext-only" aria-label="Plain editor"></div>
      <select aria-label="Many" multiple onchange="window.selectionChanges=(window.selectionChanges||0)+1">${Array.from({ length: 120 }, (_, i) => `<option value="v${i}">Duplicate</option>`).join('')}<optgroup label="Unavailable" disabled><option value="blocked">Unavailable choice</option></optgroup></select>
      <div id="scroll" aria-label="Scroll"><div></div></div><iframe src="http://localhost:${port}/child"></iframe>
      <form method="POST" target="_blank" action="/posted"><input name="draft" value="exact-post"><button>Popup submit</button></form>`);
  });
  await new Promise<void>(resolve => server.listen(0, '::', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const cid = (await orkas.invoke<any>('conversations.create', { title: 'Browser capabilities' })).conversation.conversation_id;
    await orkas.page!.evaluate(async id => {
      await (window as any).loadConversations(); (window as any).setView('conversation', id);
      (window as any).ConversationInfo.openAndSetTab('browser');
    }, cid);
    await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      await new Promise<void>(resolve => setImmediate(resolve));
      const req = (process as any).mainModule.require;
      req(args.root + '/src/main/features/web_assist.ts').bindWebAssistConversation('account-e2e', args.cid, BrowserWindow.getAllWindows()[0].webContents);
      req(args.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', args.cid, 'capability-run');
      (globalThis as any).__capabilityTool = req(args.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', args.cid);
    }, { cid, root: path.resolve(__dirname, '../..') });
    const call = async (input: Record<string, unknown>): Promise<any> => {
      const result = await orkas.electronApp!.evaluate(async (_e, input) => {
        await new Promise<void>(resolve => setImmediate(resolve));
        return (globalThis as any).__capabilityTool.execute(input, {});
      }, input);
      return { ...JSON.parse(result.content), images: result.images };
    };
    const opened = await call({ operation: 'open', url: origin }); const tabId = opened.active_tab_id;
    expect(await call({ operation: 'wait', tab_id: tabId })).toMatchObject({ ok: true });
    const observe = (frame_id?: string) => call({ operation: 'observe', tab_id: tabId, ...(frame_id ? { frame_id } : {}) });
    const act = (observation: any, label: string, page_action: string, extras = {}) => call({ operation: 'act', tab_id: tabId, page_id: observation.page_id,
      element_ref: observation.elements.find((e: any) => e.label === label).ref, page_action, ...extras });
    let main = await observe(); expect(main.elements.some((e: any) => e.label === 'Empty editor')).toBe(true);
    expect(main.elements.some((e: any) => e.label === 'Plain editor')).toBe(true);
    const many = main.elements.find((e: any) => e.label === 'Many'); expect(many.option_count).toBe(121);
    const options = await call({ operation: 'options', tab_id: tabId, page_id: main.page_id, element_ref: many.ref, option_offset: 80 });
    expect(options.options.at(-2)).toMatchObject({ value: 'v119' });
    expect(await act(main, 'Many', 'select', { values: ['v0', 'v119'] })).toMatchObject({ ok: true });
    const rejected = await act(main, 'Many', 'select', { values: ['v0', 'blocked'] });
    const selection = await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      return wc.executeJavaScript('({values:Array.from(document.querySelector("select").selectedOptions).map(o=>o.value),changes:window.selectionChanges,disabled:document.querySelector("option[value=blocked]").matches(":disabled")})');
    }, origin + '/');
    // Chromium's disabled state, retained values and event count are the oracle.
    expect({ rejected, selection, option: options.options.at(-1) }).toMatchObject({
      rejected: { ok: false, code: 'element_disabled' },
      selection: { values: ['v0', 'v119'], changes: 1, disabled: true },
      option: { value: 'blocked', disabled: true },
    });
    await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
      await webContents.getAllWebContents().find(wc => wc.getURL() === url)!
        .executeJavaScript('document.querySelector("optgroup").disabled=false');
    }, origin + '/');
    main = await observe();
    expect(await act(main, 'Many', 'select', { values: ['blocked'] })).toMatchObject({ ok: true });
    expect(await call({ operation: 'read_value', tab_id: tabId, page_id: main.page_id,
      element_ref: main.elements.find((e: any) => e.label === 'Many').ref })).toMatchObject({ value: 'blocked', selected_options: ['Unavailable choice'] });
    expect(await act(main, 'Many', 'select', { values: ['v0', 'v119'] })).toMatchObject({ ok: true });
    expect(await act(main, 'Scroll', 'scroll', { direction: 'right' })).toMatchObject({ ok: true });
    expect(await act(main, 'OTP', 'fill', { text: '987654' })).toMatchObject({ ok: true });
    expect(await call({ operation: 'read_value', tab_id: tabId, page_id: main.page_id, element_ref: main.elements.find((e: any) => e.label === 'OTP').ref })).toMatchObject({ ok: false, code: 'value_not_readable' });
    const screenshot = await call({ operation: 'screenshot', tab_id: tabId }); expect(screenshot.ok, JSON.stringify({ ok: screenshot.ok, code: screenshot.code })).toBe(true); expect(screenshot.images).toHaveLength(1);
    // A screenshot must contain opaque black pixels across the visible OTP box.
    const masked = await orkas.electronApp!.evaluate(async ({ webContents }, args) => {
      const req = (process as any).mainModule.require; const sharp = req(args.root + '/node_modules/sharp');
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === args.origin + '/')!;
      const box = await wc.executeJavaScript('(()=>{const r=document.querySelector("input[autocomplete]").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,vw:innerWidth,vh:innerHeight,scroll:document.getElementById("scroll").scrollLeft,selected:Array.from(document.querySelector("select").selectedOptions).map(o=>o.value)}})()');
      const { data, info } = await sharp(Buffer.from(args.data, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const x = Math.floor((box.x + box.width / 2) * info.width / box.vw), y = Math.floor((box.y + box.height / 2) * info.height / box.vh);
      return { pixel: Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)), scroll: box.scroll, selected: box.selected };
    }, { origin, data: screenshot.images[0].data, root: path.resolve(__dirname, '../..') });
    expect(masked).toMatchObject({ pixel: [0, 0, 0], selected: ['v0', 'v119'] }); expect(masked.scroll).toBeGreaterThan(0);
    const frame = main.frames.find((f: any) => f.display_url.endsWith('/child')); expect(frame).toBeTruthy();
    // The frame inventory identifies frames by origin and path and reports the total.
    expect(main.frame_count).toBe(main.frames.length);
    expect(main.frames.every((f: any) => !/[?#]/.test(f.display_url))).toBe(true);
    let child = await observe(frame.frame_id);
    expect(await act(child, 'Child', 'fill', { text: 'exact child' })).toMatchObject({ ok: true });
    expect(await act(child, 'Child', 'press', { keys: 'x' })).toMatchObject({ ok: true });
    child = await observe(frame.frame_id);
    expect(await call({ operation: 'read_value', tab_id: tabId, page_id: child.page_id, element_ref: child.elements.find((e: any) => e.label === 'Child').ref })).toMatchObject({ value: 'exact childx' });
    const dir = path.join(orkas.userWorkspaceRoot, 'capability-files'); mkdirSync(dir, { recursive: true });
    const files = Array.from({ length: 25 }, (_, i) => { const file = path.join(dir, `file-${i}.txt`); writeFileSync(file, `exact-${i}`); return file; });
    truncateSync(files[0], 55 * 1024 * 1024);
    expect(await act(child, 'Files', 'upload', { file_paths: files })).toMatchObject({ ok: true, file_count: 25 });
    await expect.poll(() => uploads.length).toBe(1); expect(uploads[0].files).toBe(25); expect(uploads[0].bytes).toBeGreaterThan(55 * 1024 * 1024);
    const folder = path.join(orkas.userWorkspaceRoot, 'selected-directory'); mkdirSync(folder); writeFileSync(path.join(folder, 'nested.txt'), 'folder evidence');
    await expect(orkas.page!.locator('.web-assist-shell')).toBeVisible();
    await orkas.page!.locator(`.web-assist-tab[data-tab-id="${tabId}"]`).click();
    await orkas.invoke('webAssist.layout', { x: 0, y: 0, width: 600, height: 500 });
    await orkas.electronApp!.evaluate(async ({ BrowserWindow }) => {
      // Directory enumeration requires real native visibility/activation. The
      // owner must also be focusable at creation; CSS visibility is insufficient.
      const win = BrowserWindow.getAllWindows()[0]; win.restore(); win.show(); win.focus();
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    });
    const directoryResult = await act(child, 'Folder', 'upload', { file_paths: [folder] });
    expect(directoryResult, JSON.stringify(directoryResult)).toMatchObject({ ok: true, file_count: 1 });
    await expect.poll(() => uploads.length).toBe(2); expect(uploads[1]).toMatchObject({ files: 1, trustedChange: true });
    main = await observe(); expect(await act(main, 'Popup submit', 'click')).toMatchObject({ ok: true });
    await expect.poll(() => postBody).toBe('draft=exact-post');
    let popup: any;
    await expect.poll(async () => { const tabs = await call({ operation: 'tabs' }); popup = tabs.tabs.find((tab: any) => tab.display_url.endsWith('/posted')); return !!popup; }).toBe(true);
    expect(await call({ operation: 'wait', tab_id: popup.tab_id })).toMatchObject({ ok: true }); expect((await call({ operation: 'observe', tab_id: popup.tab_id })).elements.some((e: any) => e.label === 'Popup input')).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
