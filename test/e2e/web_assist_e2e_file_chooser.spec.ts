import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test as base, OrkasTestApp } from './fixtures/orkas';
import { analyzeWebAppLogs } from './fixtures/web-app-log-analysis';

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
        const file = info.outputPath('electron-main.log');
        expect(existsSync(file)).toBe(true);
        const analysis = analyzeWebAppLogs(readFileSync(file, 'utf8'));
        writeFileSync(info.outputPath('log-analysis.json'), JSON.stringify(analysis, null, 2));
        expect(analysis.passed, 'Review file-transfer log findings').toBe(true);
      }
    }
  },
});

test('a removed iframe cannot discard a pending root file upload', async ({ orkas }, info) => {
  const receipts: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/upload') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { receipts.push(body); res.end('received'); });
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><input type="file"><script>document.querySelector("input").onchange=e=>{window.upload=(async()=>{const response=await fetch("/upload",{method:"POST",body:await e.target.files[0].text()});return response.text()})()}</script>');
  });
  await new Promise<void>(resolve => server.listen(0, '::', resolve));
  const port = (server.address() as { port: number }).port;
  const file = orkas.createWorkspaceFile('retained-upload.txt', 'retained-upload-字节');
  try {
    const result = await orkas.electronApp!.evaluate(async ({ BrowserWindow }, args) => {
      const req = (process as any).mainModule.require;
      const protocol = req(args.root + '/src/main/features/web_assist_protocol.ts');
      const { withOperationTimeout } = req(args.root + '/src/main/util/operation-timeout.ts');
      const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const contents = win.webContents;
      let selectionOpened!: () => void;
      const opened = new Promise<void>(resolve => { selectionOpened = resolve; });
      protocol.attachWebAssistFileChoosers(contents, () => 'isolated-upload-run', selectionOpened);
      const originalSend = contents.debugger.sendCommand.bind(contents.debugger);
      let releaseSetup!: () => void;
      const heldSetup = new Promise<void>(resolve => { releaseSetup = resolve; });
      let setupEntered!: () => void;
      const entered = new Promise<void>(resolve => { setupEntered = resolve; });
      let removedSession = '';
      let uploadCommands = 0;
      const bounded = (promise: Promise<any>) => withOperationTimeout(promise, {
        timeoutMs: 5000, code: 'test_native_event_timeout', stage: 'native iframe upload regression',
      });
      try {
        await win.loadURL(args.url);
        await protocol.webAssistFrames(contents);
        await contents.executeJavaScript('document.querySelector("input").click()', true);
        await bounded(opened);
        const selection = protocol.webAssistFileChooser(contents);
        if (!selection) throw new Error('Root upload selection missing');
        contents.debugger.sendCommand = (async (method: string, params: any, sessionId?: string) => {
          if (method === 'Runtime.enable' && sessionId) {
            removedSession = sessionId;
            setupEntered();
            await heldSetup;
          }
          if (method === 'DOM.setFileInputFiles') uploadCommands++;
          return originalSend(method, params, sessionId);
        }) as any;
        await contents.executeJavaScript(`(() => { const frame=document.createElement('iframe'); frame.id='transient'; frame.src=${JSON.stringify(args.child)}; document.body.append(frame); })()`);
        await bounded(entered);
        const refresh = protocol.refreshWebAssistFileChoosers(contents);
        // Let refresh reach the pending child setup, then retire the actual
        // Chromium target before its delayed protocol command is dispatched.
        await new Promise<void>(resolve => setImmediate(resolve));
        const detached = new Promise<void>(resolve => {
          const listener = (_event: unknown, method: string, params: any) => {
            if (method !== 'Target.detachedFromTarget' || params.sessionId !== removedSession) return;
            contents.debugger.removeListener('message', listener); resolve();
          };
          contents.debugger.on('message', listener);
        });
        await contents.executeJavaScript('document.getElementById("transient").remove()');
        await bounded(detached);
        releaseSetup();
        await refresh;
        const retained = protocol.webAssistFileChooser(contents) === selection;
        const attached = contents.debugger.isAttached();
        const count = await protocol.setWebAssistInputFiles(contents, selection, [args.file]);
        await bounded(contents.executeJavaScript('window.upload'));
        protocol.clearWebAssistFileChooser(contents);
        return { retained, attached, count, uploadCommands };
      } finally {
        releaseSetup();
        contents.debugger.sendCommand = originalSend;
        win.destroy();
      }
    }, { root: path.resolve(__dirname, '../..'), url: `http://127.0.0.1:${port}/`, child: `http://localhost:${port}/child`, file });
    writeFileSync(info.outputPath('retired-frame-upload.json'), JSON.stringify(result, null, 2));
    expect(result).toEqual({ retained: true, attached: true, count: 1, uploadCommands: 1 });
    await expect.poll(() => receipts).toEqual(['retained-upload-字节']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('AI attachment buttons yield upload targets, transfer exact bytes once and release stale selections', async ({ orkas }) => {
  test.setTimeout(90_000);
  const receipts: string[] = [];
  const server = createServer((req, res) => {
    if (req.url === '/upload') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => { receipts.push(body); res.end('received'); }); return;
    }
    res.setHeader('Content-Type', 'text/html');
    const port = (server.address() as { port: number }).port;
    res.end(`<!doctype html><title>File chooser journey</title><script>
      window.clicks = 0;
      function attach(detached) {
        window.clicks++;
        const input = document.createElement('input'); input.type = 'file'; input.multiple = true;
        input.style.display = 'none';
        input.oncancel = event => { window.cancels=(window.cancels||0)+1; window.trustedCancel=event.isTrusted; };
        input.onchange = async () => { for (const file of input.files) await fetch('/upload', {method:'POST',body:await file.text()}); window.uploads=(window.uploads||0)+1; };
        if (!detached) { document.body.append(input); window.lastInput=input; }
        input.click();
      }
      async function nativePicker(kind) {
        try { await window[{open:'showOpenFilePicker',save:'showSaveFilePicker',directory:'showDirectoryPicker'}[kind]](); window.pickerResult='selected'; }
        catch(error) { window.pickerResult=error.name; }
      }
    </script><button onclick="attach(false)">Attach</button><button onclick="attach(true)">Detached attach</button>
    <button onclick="window.lastInput.showPicker()">Reopen selected</button>
    <button onclick="nativePicker('open')">Open picker</button><button onclick="nativePicker('save')">Save picker</button><button onclick="nativePicker('directory')">Directory picker</button>
    ${req.url === '/child' ? '' : `<iframe src="http://localhost:${port}/child"></iframe>`}
    <a href="/report" download="report.txt">Download</a>`);
  });
  await new Promise<void>(resolve => server.listen(0, '::', resolve));
  const cid = (await orkas.invoke<any>('conversations.create', { title: 'Picker-free transfers' })).conversation.conversation_id;
  const args = { cid, root: path.resolve(__dirname, '../..'), url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` };
  const call = (input: Record<string, unknown>): Promise<any> => orkas.electronApp!.evaluate(async (_electron, input) => {
    const result = await (globalThis as any).__fileChooserTool.execute(input, {});
    return JSON.parse(result.content);
  }, input);
  try {
    await orkas.electronApp!.evaluate(async ({ BrowserWindow, dialog }, a) => {
      const req = (process as any).mainModule.require;
      // Fail promptly if choose_files still attempts human interaction. The
      // website's Chromium file chooser is not controlled by this JS API.
      (globalThis as any).__originalFileDialog = dialog.showOpenDialog;
      (globalThis as any).__fileDialogCalls = 0;
      dialog.showOpenDialog = (async () => { (globalThis as any).__fileDialogCalls++; return { canceled: true, filePaths: [] }; }) as any;
      req(a.root + '/src/main/features/web_assist.ts').bindWebAssistConversation('account-e2e', a.cid, BrowserWindow.getAllWindows()[0].webContents);
      req(a.root + '/src/main/features/web_assist_lifecycle.ts').beginBrowserTaskRun('account-e2e', a.cid, 'files');
      (globalThis as any).__fileChooserTool = req(a.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', a.cid);
    }, args);
    expect(await call({ operation: 'choose_files' })).toMatchObject({ ok: false, code: 'file_paths_required' });
    expect(await orkas.electronApp!.evaluate(() => (globalThis as any).__fileDialogCalls)).toBe(0);
    const tab = (await call({ operation: 'open', url: args.url })).active_tab_id;
    expect(await call({ operation: 'wait', tab_id: tab })).toMatchObject({ ok: true });
    const file = path.join(orkas.userWorkspaceRoot, 'exact-upload.txt'); writeFileSync(file, 'exact-upload-字节');
    let main = await call({ operation: 'observe', tab_id: tab });
    const child = main.frames.find((frame: any) => frame.display_url.endsWith('/child'));
    for (const [frameId, label] of [[undefined, 'Attach'], [undefined, 'Detached attach'], [child.frame_id, 'Attach']]) {
      const before = await call({ operation: 'observe', tab_id: tab, ...(frameId ? { frame_id: frameId } : {}) });
      const clicked = await call({ operation: 'act', tab_id: tab, page_id: before.page_id,
        element_ref: before.elements.find((e: any) => e.label === label).ref, page_action: 'click' });
      expect(clicked, JSON.stringify(clicked)).toMatchObject({ ok: true });
      expect(await call({ operation: 'wait', tab_id: tab })).toMatchObject({ dialog_type: 'file_chooser', condition_matched: false });
      expect(await call({ operation: 'screenshot', tab_id: tab })).toMatchObject({ dialog_type: 'file_chooser' });
      const pending = await call({ operation: 'observe', tab_id: tab });
      expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, dialog_type: 'file_chooser' });
      expect(pending.elements[0]).toMatchObject({ input_type: 'file' });
      if (label === 'Detached attach') {
        // A model round can take long enough for the unattached input to be
        // collected. Retaining a backend node number alone is insufficient.
        await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
          await webContents.getAllWebContents().find(wc => wc.getURL() === url)!.debugger.sendCommand('HeapProfiler.collectGarbage');
        }, args.url);
      }
      const upload = { operation: 'act', tab_id: tab, page_id: pending.page_id, element_ref: pending.elements[0].ref, page_action: 'upload' };
      // A denied source must not select anything or consume the pending target.
      expect(await call({ ...upload, file_paths: [path.join(args.root, 'CLAUDE.md')] })).toMatchObject({ ok: false, code: 'upload_files_unavailable' });
      const count = receipts.length;
      const uploaded = await call({ ...upload, file_paths: [file] });
      expect(uploaded, JSON.stringify({ label, uploaded })).toMatchObject({ ok: true, file_count: 1 });
      await expect.poll(() => receipts.length).toBe(count + 1);
      expect(receipts.at(-1)).toBe('exact-upload-字节');
      expect(await call({ ...upload, file_paths: [file] })).toMatchObject({ ok: false, code: 'stale_page' });
    }
    expect(receipts).toEqual(Array(3).fill('exact-upload-字节'));
    main = await call({ operation: 'observe', tab_id: tab });
    await call({ operation: 'act', tab_id: tab, page_id: main.page_id,
      element_ref: main.elements.find((e: any) => e.label === 'Reopen selected').ref, page_action: 'click' });
    let retained = await call({ operation: 'observe', tab_id: tab });
    expect(retained.dialog_type).toBe('file_chooser');
    expect(await call({ operation: 'act', tab_id: tab, page_id: retained.page_id,
      element_ref: retained.elements.find((e: any) => e.label === 'Cancel').ref, page_action: 'click' })).toMatchObject({ ok: true });
    expect(await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
      return webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript('({files:window.lastInput.files.length,trusted:window.trustedCancel})');
    }, args.url)).toEqual({ files: 1, trusted: true });
    // Cancel a new target, then verify normal page work remains possible.
    main = await call({ operation: 'observe', tab_id: tab });
    await call({ operation: 'act', tab_id: tab, page_id: main.page_id, element_ref: main.elements.find((e: any) => e.label === 'Attach').ref, page_action: 'click' });
    const pending = await call({ operation: 'observe', tab_id: tab });
    expect(await call({ operation: 'act', tab_id: tab, page_id: pending.page_id, page_action: 'press', keys: 'Escape' })).toMatchObject({ ok: true });
    expect((await call({ operation: 'observe', tab_id: tab })).dialog_type).toBeUndefined();
    expect(receipts).toHaveLength(3);
    expect(await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
      return webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript('window.cancels');
    }, args.url)).toBe(2);
    for (const kind of ['open', 'save', 'directory']) {
      const page = await call({ operation: 'observe', tab_id: tab });
      const label = kind[0].toUpperCase() + kind.slice(1) + ' picker';
      const result = await call({ operation: 'act', tab_id: tab, page_id: page.page_id,
        element_ref: page.elements.find((e: any) => e.label === label).ref, page_action: 'click' });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, native_file_picker: { kind, state: 'cancelled' } });
      expect(await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
        return webContents.getAllWebContents().find(wc => wc.getURL() === url)!.executeJavaScript('window.pickerResult');
      }, args.url)).toBe('AbortError');
    }
    main = await call({ operation: 'observe', tab_id: tab });
    expect(await call({ operation: 'act', tab_id: tab, page_id: main.page_id,
      element_ref: main.elements.find((e: any) => e.label === 'Attach').ref, page_action: 'click' })).toMatchObject({ ok: true });
    let opened: any;
    await expect.poll(async () => { opened = await call({ operation: 'observe', tab_id: tab }); return opened.dialog_type; }).toBe('file_chooser');
    await orkas.electronApp!.evaluate(async (_e, a) => {
      const life = (process as any).mainModule.require(a.root + '/src/main/features/web_assist_lifecycle.ts');
      life.finishBrowserTaskRun('account-e2e', a.cid, 'files');
      life.beginBrowserTaskRun('account-e2e', a.cid, 'files-next');
    }, args);
    expect(await call({ operation: 'observe', tab_id: tab })).toMatchObject({ ok: false, code: 'task_run_ended' });
    await orkas.electronApp!.evaluate((_e, a) => {
      (globalThis as any).__fileChooserTool = (process as any).mainModule.require(a.root + '/src/main/features/group_chat/browser_tool.ts').buildConversationBrowserTool('account-e2e', a.cid);
    }, args);
    expect((await call({ operation: 'observe', tab_id: tab })).dialog_type).toBeUndefined();
    expect(await call({ operation: 'act', tab_id: tab, page_id: opened.page_id, element_ref: opened.elements[0].ref,
      page_action: 'upload', file_paths: [file] })).toMatchObject({ ok: false, code: 'stale_page' });
    const facts = await orkas.electronApp!.evaluate(async ({ webContents }, url) => {
      const wc = webContents.getAllWebContents().find(wc => wc.getURL() === url)!;
      return wc.executeJavaScript('({clicks:window.clicks,uploads:window.uploads})');
    }, args.url);
    expect(facts).toEqual({ clicks: 4, uploads: 2 });
    expect(receipts).toHaveLength(3);
  } finally {
    await orkas.electronApp?.evaluate(({ dialog }, a) => {
      if ((globalThis as any).__originalFileDialog) dialog.showOpenDialog = (globalThis as any).__originalFileDialog;
      (process as any).mainModule.require(a.root + '/src/main/features/web_assist_lifecycle.ts').finishBrowserTaskRun('account-e2e', a.cid, 'files');
      (process as any).mainModule.require(a.root + '/src/main/features/web_assist_lifecycle.ts').finishBrowserTaskRun('account-e2e', a.cid, 'files-next');
    }, args);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
