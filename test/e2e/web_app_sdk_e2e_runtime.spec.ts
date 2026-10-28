import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { openSidebarEntry, expect, test } from './fixtures/orkas';


test('ordinary artifact messages lose trust after the same iframe navigates to an external origin', async ({ modelOrkas: orkas }) => {
  const external=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<script>parent.postMessage({__orkasArtifact:true,type:"probe"},"*")</script>');});
  await new Promise<void>(resolve=>external.listen(0,'127.0.0.1',resolve));
  try{
    const entry=orkas.createWorkspaceFile('ordinary-origin/index.html','<script>parent.postMessage({__orkasArtifact:true,type:"probe"},"*")</script>');
    const saved:any=await orkas.invoke('savedApps.saveFromPath',{path:entry,title:'Origin fixture'});expect(saved.ok).toBe(true);
    const opened:any=await orkas.invoke('webApps.open',{source:{appId:saved.id}});
    const ordinaryOrigin = 'chat-app://' + new URL(opened.url).host;
    await orkas.page.evaluate(url=>{
      const frame=document.createElement('iframe');frame.id='origin-probe';frame.src=url;
      frame.setAttribute('sandbox',(window as any).OrkasArtifactSecurity.SANDBOX);
      (window as any).originEvidence=[];
      window.addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.data?.type==='probe')
        (window as any).originEvidence.push({trusted:(window as any).OrkasArtifactSecurity.trustedArtifactMessage(event,frame),origin:event.origin});});
      document.body.append(frame);
    },opened.url);
    await expect.poll(()=>orkas.page.evaluate(()=>(window as any).originEvidence)).toEqual([{trusted:true,origin:ordinaryOrigin}]);
    const url=`http://127.0.0.1:${(external.address() as AddressInfo).port}/`;
    // Navigate inside the document: the host's src attribute and WindowProxy stay unchanged.
    await orkas.page.locator('#origin-probe').contentFrame().locator('body').evaluate((_node,url)=>{location.href=url;},url);
    await expect.poll(()=>orkas.page.evaluate(()=>(window as any).originEvidence)).toEqual([
      {trusted:true,origin:ordinaryOrigin},{trusted:false,origin:new URL(url).origin},
    ]);
    expect(orkas.modelRequests).toHaveLength(0);
  }finally{await new Promise<void>(resolve=>external.close(()=>resolve()));}
});

test('bundled SDK starter works through visible controls and uses ordinary model calls and recovers from existing export targets', async ({ modelOrkas: orkas }, info) => {
  const source = path.resolve(__dirname, '../../resources/builtin/system/skills/web-app-sdk/assets/starter');
  const entry = orkas.createWorkspaceFile('sdk-starter/index.html', readFileSync(path.join(source, 'index.html'), 'utf8'));
  orkas.createWorkspaceFile('sdk-starter/orkas-app.json', readFileSync(path.join(source, 'orkas-app.json'), 'utf8'));
  const app: any = await orkas.invoke('savedApps.saveFromPath', {path:entry,title:'SDK starter'});
  expect(app.ok).toBe(true);
  await openSidebarEntry(orkas.page, '#apps-btn');
  const preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());
  const frame = preview.locator('.saved-app-viewer-frame').contentFrame();
  await expect(frame.locator('#status')).toContainText('Ready.');
  await expect(frame.getByRole('note')).toContainText('Selected files are read-only');
  const input = orkas.createWorkspaceFile('starter-source.txt', 'A useful note from a selected file.');
  await orkas.selectFilesOnNextDialog([input]);
  await preview.evaluate(() => {
    (window as any).hostInputEvidence = [];
    for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
      const target = event.target as HTMLElement;
      (window as any).hostInputEvidence.push({ type, tag: target.tagName, id: target.id, className: target.className });
    }, true);
  });
  await frame.locator('body').evaluate(() => {
    (window as any).inputEvidence = [];
    for (const type of ['pointerdown', 'pointerup', 'click', 'focusin']) document.addEventListener(type, event => {
      const target = event.target as HTMLElement;
      (window as any).inputEvidence.push({ type, target: target.id, focused: document.hasFocus(), trusted: event.isTrusted });
    }, true);
  });
  const nativeWindow = await orkas.electronApp!.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('file:'))!;
    return { visible: win.isVisible(), focused: win.isFocused(), minimized: win.isMinimized(), webContentsFocused: win.webContents.isFocused() };
  });
  await frame.getByRole('button', {name:'Open text file'}).click();
  try { await expect(frame.locator('#draft')).toHaveValue('A useful note from a selected file.'); }
  finally {
    const evidence = {
      nativeWindow,
      frame: await frame.locator('body').evaluate(() => ({ events: (window as any).inputEvidence,
        status: document.querySelector('#status')?.textContent, buttonDisabled: (document.querySelector('#open') as HTMLButtonElement).disabled })),
      host: await preview.evaluate(() => ({ events: (window as any).hostInputEvidence, focused: document.hasFocus() })),
    };
    writeFileSync(info.outputPath('starter-input-evidence.json'), JSON.stringify(evidence, null, 2));
    await info.attach('starter-input-evidence', { contentType: 'application/json', path: info.outputPath('starter-input-evidence.json') });
  }
  await frame.getByRole('button', {name:'Save draft'}).click();
  await expect(frame.locator('#status')).toHaveText('Draft saved.');
  await frame.getByRole('button', {name:'Summarize',exact:true}).click();
  await expect(frame.locator('#status')).toHaveText('Summary ready.');
  await expect(frame.locator('#output')).toHaveText('Hello from the local E2E model.');
  expect(orkas.modelRequests).toHaveLength(1);
  await orkas.electronApp!.evaluate(({dialog}, file) => { (dialog as any).showSaveDialog = async () => ({canceled:false,filePath:file}); }, input);
  await frame.getByRole('button', {name:'Export result'}).click();
  await expect(frame.locator('#status')).toContainText('choose a new export filename');
  expect(readFileSync(input, 'utf8')).toBe('A useful note from a selected file.');
  const exported = path.join(orkas.userWorkspaceRoot, 'starter-export.txt');
  await orkas.electronApp!.evaluate(({dialog}, file) => { (dialog as any).showSaveDialog = async () => ({canceled:false,filePath:file}); }, exported);
  await frame.getByRole('button', {name:'Export result'}).click();
  await expect(frame.locator('#status')).toHaveText('Export saved.');
  expect(readFileSync(exported, 'utf8')).toBe('Hello from the local E2E model.');
  await orkas.closePreview(preview);
  const reopenedPage = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());
  const reopened = reopenedPage.locator('.saved-app-viewer-frame').contentFrame();
  await expect(reopened.locator('#draft')).toHaveValue('A useful note from a selected file.');
  expect(orkas.modelRequests).toHaveLength(1);
});

const html='<!doctype html><html><head><script src="__orkas/sdk.js"></script></head><body><h1>SDK App</h1></body></html>';
async function seed(orkas: any, folder: string, source = html) {
  const entry=orkas.createWorkspaceFile(folder+'/index.html',source);
  orkas.createWorkspaceFile(folder+'/orkas-app.json',JSON.stringify({sdkVersion:1,capabilities:['storage','appFiles','files','ai','library']}));
  return orkas.invoke('savedApps.saveFromPath',{path:entry,title:folder});
}
async function mount(orkas: any, id: string) {
  await openSidebarEntry(orkas.page, '#apps-btn');
  const preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${id}"]`).click());
  const frame=preview.locator('.saved-app-viewer-frame').contentFrame();
  await expect(frame.locator('h1')).toHaveText('SDK App');
  return frame;
}
test('SDK app loads external code and assets and calls an API without losing host isolation', async ({ modelOrkas: orkas }) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Test');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    if (request.url === '/app.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end('window.externalCodeLoaded = true;');
    } else if (request.url === '/app.css') {
      response.setHeader('Content-Type', 'text/css');
      response.end('#remote-style { color: rgb(1, 2, 3); }');
    } else if (request.url === '/pixel.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"><rect width="7" height="9" fill="blue"/></svg>');
    } else if (request.url === '/events') {
      response.setHeader('Content-Type', 'text/event-stream');
      response.end('data: live-event\n\n');
    } else {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ accepted: body === '{"message":"hello"}', header: request.headers['x-app-test'] }));
      });
    }
  });
  server.on('upgrade', (request, socket) => {
    requests.push(`UPGRADE ${request.url}`);
    const accept = createHash('sha1').update(String(request.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.write(Buffer.from([0x81, 4, ...Buffer.from('live')]));
    socket.on('data', () => socket.end(Buffer.from([0x88, 0])));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const app: any = await seed(orkas, 'sdk-online', html.replace('</head>',
      `<script src="${base}/app.js"></script><link rel="stylesheet" href="${base}/app.css"></head>`)
      .replace('</body>', '<p id="remote-style">Remote style</p><img id="remote-image" src="' + base + '/pixel.svg"></body>'));
    const frame = await mount(orkas, app.id);
    await expect.poll(() => frame.locator('body').evaluate(() => (window as any).externalCodeLoaded)).toBe(true);
    await expect(frame.locator('#remote-style')).toHaveCSS('color', 'rgb(1, 2, 3)');
    await expect.poll(() => frame.locator('#remote-image').evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(7);
    const result = await frame.locator('body').evaluate(async (_node, url) => {
      const response = await fetch(url + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-App-Test': 'ordinary-browser-call' },
        body: JSON.stringify({ message: 'hello' }), signal: AbortSignal.timeout(5000) });
      const api = (window as any).orkasApp;
      await api.storage.set({ key: 'network-result', value: await response.json() });
      return { stored: await api.storage.get({ key: 'network-result' }), node: typeof (window as any).require, ipc: typeof (window as any).orkas };
    }, base);
    expect(result).toEqual({ stored: { value: { accepted: true, header: 'ordinary-browser-call' } }, node: 'undefined', ipc: 'undefined' });
    const streams = await frame.locator('body').evaluate(async (_node, base) => {
      const message = (source: WebSocket | EventSource) => new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => { source.close(); reject(new Error('Stream timed out')); }, 5000);
        source.onmessage = event => { clearTimeout(timeout); source.close(); resolve(event.data); };
        source.onerror = () => { clearTimeout(timeout); source.close(); reject(new Error('Stream failed')); };
      });
      return Promise.all([message(new WebSocket(base.replace('http:', 'ws:') + '/socket')), message(new EventSource(base + '/events'))]);
    }, base);
    expect(streams).toEqual(['live', 'live-event']);
    expect(requests).toEqual(expect.arrayContaining(['GET /app.js', 'GET /app.css', 'GET /pixel.svg', 'OPTIONS /api', 'POST /api']));
    const beforePreview = [...requests];
    const preview = await orkas.electronApp!.evaluate(async (_electron, args) => {
      const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.module);
      return (await renderResponsiveHtmlPreview(args.entry, [{ name: 'desktop', width: 800, height: 600 }], {}, { interactions: false })).evidence;
    }, { module: path.resolve(__dirname, '../../src/main/features/html_preview.ts'), entry: path.join(orkas.userWorkspaceRoot, 'sdk-online/index.html') });
    expect(preview.sdk).toMatchObject({ mode: 'preview', storage: 'temporary' });
    expect(requests.slice(beforePreview.length)).toEqual(expect.arrayContaining(['GET /app.js', 'GET /app.css', 'GET /pixel.svg']));
    expect(preview.blockedResourceCount).toBe(0);
    expect(preview.viewports[0].consoleErrors).toEqual([]);
    expect(orkas.modelRequests).toHaveLength(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
test('SDK app discovers, reads a selected file, generates, exports and keeps isolated state across reopening',async({modelOrkas:orkas})=>{
  const app:any=await seed(orkas,'sdk-a'); expect(app.ok).toBe(true);
  const frame=await mount(orkas,app.id);
  expect(await frame.locator('body').evaluate(()=>typeof (window as any).orkas)).toBe('undefined');
  const catalog:any=await frame.locator('body').evaluate(()=>(window as any).orkasApp.capabilities.list());
  expect(catalog.methods.find((m:any)=>m.name==='ai.generate')).toMatchObject({supported:true,declared:true,authorized:true});
  const source=orkas.createWorkspaceFile('source.txt','Text selected by the user.');
  await orkas.selectFilesOnNextDialog([source]);
  const selected:any=await frame.locator('body').evaluate(async()=>{
    const api=(window as any).orkasApp;const file=await api.files.pick();return api.files.readText({handle:file.handle});
  });expect(selected.text).toBe('Text selected by the user.');
  await orkas.electronApp!.evaluate(({dialog})=>{const d=dialog as any;d.showMessageBox=async()=>({response:1,checkboxChecked:false});});
  const generated:any=await frame.locator('body').evaluate(async()=>{
    const api=(window as any).orkasApp;const result=await api.ai.generate({prompt:'Write a greeting.',maxTokens:128});await api.storage.set({key:'result',value:result.text});return result;
  });expect(generated.text).toBe('Hello from the local E2E model.');expect(orkas.modelRequests).toHaveLength(1);
  const exportPath=path.join(orkas.userWorkspaceRoot,'sdk-result.txt');
  await orkas.electronApp!.evaluate(({dialog},file)=>{(dialog as any).showSaveDialog=async()=>({canceled:false,filePath:file});},exportPath);
  await frame.locator('body').evaluate((_node,text)=>(window as any).orkasApp.files.saveAs({name:'sdk-result.txt',text}),generated.text);
  expect(readFileSync(exportPath,'utf8')).toBe(generated.text);
  await orkas.closePreview(frame.owner().page());
  const second:any=await seed(orkas,'sdk-b');const other=await mount(orkas,second.id);
  expect(await other.locator('body').evaluate(()=>(window as any).orkasApp.storage.get({key:'result'}))).toEqual({value:null});
  await orkas.closePreview(other.owner().page());
  await orkas.relaunch();const reopened=await mount(orkas,app.id);
  expect(await reopened.locator('body').evaluate(()=>(window as any).orkasApp.storage.get({key:'result'}))).toEqual({value:generated.text});
});

test('a denied cross-origin write has no remote effect and an explicit retry keeps the app usable', async ({ modelOrkas: orkas }) => {
  const requests: string[] = [];
  const writes: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === '/allowed') {
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.setHeader('Access-Control-Allow-Headers', 'X-App-Test');
      response.setHeader('Access-Control-Allow-Methods', 'POST');
    }
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => { writes.push(body); response.end('Saved remotely'); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const app: any = await seed(orkas, 'cors-recovery', html.replace('</body>', `
      <button id="send">Send</button><button id="retry">Retry</button><output role="status">Ready</output>
      <script>
        async function send(route) {
          try {
            const response = await fetch('${base}' + route, { method: 'POST', headers: { 'X-App-Test': 'preflight' }, body: 'User approved content' });
            const text = await response.text();
            await orkasApp.storage.set({key:'result',value:text});
            document.querySelector('output').textContent=text;
          } catch (_) { document.querySelector('output').textContent='Request blocked; retry available'; }
        }
        document.querySelector('#send').onclick=()=>send('/denied');
        document.querySelector('#retry').onclick=()=>send('/allowed');
      </script></body>`));
    const frame = await mount(orkas, app.id);
    await frame.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(frame.getByRole('status')).toHaveText('Request blocked; retry available');
    expect(requests).toEqual(['OPTIONS /denied']);
    expect(writes).toEqual([]);
    expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.storage.get({ key: 'result' }))).toEqual({ value: null });
    await frame.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(frame.getByRole('status')).toHaveText('Saved remotely');
    expect(writes).toEqual(['User approved content']);
    expect(requests.filter(value => value === 'POST /allowed')).toHaveLength(1);
    await orkas.closePreview(frame.owner().page());
    const reopened = await mount(orkas, app.id);
    expect(await reopened.locator('body').evaluate(() => (window as any).orkasApp.storage.get({ key: 'result' }))).toEqual({ value: 'Saved remotely' });
    expect(writes).toHaveLength(1);
    expect(orkas.modelRequests).toHaveLength(0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('SDK metadata, JSON removal, binary snapshots and dialog cancellation cross the actual iframe bridge', async ({ modelOrkas: orkas }) => {
  const app: any = await seed(orkas, 'sdk-remaining-methods');
  const frame = await mount(orkas, app.id);
  const metadata = await frame.locator('body').evaluate(async () => {
    const api = (window as any).orkasApp;
    const context = await api.host.getContext();
    const schema = await api.capabilities.describe({ method: 'ai.generate' });
    await api.storage.set({ key: 'nested', value: { text: '你好', values: [0, false, null] } });
    const stored = await api.storage.get({ key: 'nested' });
    const keys = await api.storage.keys();
    await api.storage.remove({ key: 'nested' });
    return { context, schema, stored, keys, removed: await api.storage.get({ key: 'nested' }) };
  });
  expect(metadata.context).toMatchObject({ sdkVersion: 1, language: expect.any(String) });
  expect(metadata.schema.inputSchema.properties.maxTokens.default).toBeUndefined();
  expect(metadata.stored).toEqual({ value: { text: '你好', values: [0, false, null] } });
  expect(metadata.keys).toEqual({ keys: ['nested'] });
  expect(metadata.removed).toEqual({ value: null });
  const source = orkas.createWorkspaceFile('bytes.bin', '');
  writeFileSync(source, Buffer.from([0, 255, 254, 128]));
  await orkas.selectFilesOnNextDialog([source]);
  const file = await frame.locator('body').evaluate(() => (window as any).orkasApp.files.pick());
  expect(file).not.toHaveProperty('path');
  writeFileSync(source, 'Changed after selection');
  const result = await frame.locator('body').evaluate(async (_node, handle) => {
    const api = (window as any).orkasApp;
    const bytes = await api.files.readBase64({ handle });
    const textError = await api.files.readText({ handle }).then(() => null, (error: any) => error.code);
    await api.files.release({ handle });
    const staleError = await api.files.readBase64({ handle }).then(() => null, (error: any) => error.code);
    return { bytes, textError, staleError };
  }, file.handle);
  expect(result).toEqual({ bytes: { base64: 'AP/+gA==' }, textError: 'E_ENCODING', staleError: 'E_HANDLE' });
  await orkas.electronApp!.evaluate(({ dialog }) => {
    (dialog as any).showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    (dialog as any).showSaveDialog = async () => ({ canceled: true });
  });
  expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.files.pick())).toBeNull();
  expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.files.saveAs({ name: 'cancel.txt', text: 'Not saved' }))).toBeNull();
  expect(readFileSync(source, 'utf8')).toBe('Changed after selection');
  expect(orkas.modelRequests).toHaveLength(0);
});

test('SDK streams and cancels actual inference transport, then allows an explicit fresh request', async ({ modelOrkas: orkas }, info) => {
  await orkas.electronApp!.evaluate(async (_electron, file) => {
    (globalThis as any).__webAppObserver = await (process as any).mainModule.require(file).observeWebAppCalls();
  }, path.resolve(__dirname, 'fixtures/web-app-author-main.ts'));
  await orkas.page.evaluate(() => {
    const events: any[] = (window as any).__streamLifecycle = [];
    const record = (event: any) => { if (events.length < 64) events.push({ ...event, time: performance.now() }); };
    window.addEventListener('pagehide', () => record({ kind: 'host-pagehide' }));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') record({ kind: 'escape', trusted: event.isTrusted });
    }, true);
    document.addEventListener('click', event => {
      if ((event.target as HTMLElement).closest('.saved-app-viewer-close')) record({ kind: 'close-click', trusted: event.isTrusted });
    }, true);
    window.addEventListener('message', event => {
      if (event.data?.__orkasApp === 1) record({ kind: 'message', type: event.data.type, method: event.data.method });
    });
    const remove = HTMLIFrameElement.prototype.removeEventListener;
    HTMLIFrameElement.prototype.removeEventListener = function (type: string, listener: any, options?: any) {
      if (type === 'load') record({ kind: 'release', stack: new Error().stack });
      return remove.call(this, type, listener, options);
    };
    document.addEventListener('load', event => {
      const frame = event.target as HTMLIFrameElement;
      if (frame.tagName === 'IFRAME') record({ kind: 'load', blank: frame.contentDocument?.URL === 'about:blank' });
    }, true);
  });
  const app: any = await seed(orkas, 'sdk-stream-cancel');
  const frame = await mount(orkas, app.id);
  await orkas.electronApp!.evaluate(({ dialog }) => {
    (dialog as any).showMessageBox = async () => ({ response: 1, checkboxChecked: false });
  });
  orkas.setModelMode('controlled-slow');
  await frame.locator('body').evaluate(() => {
    const state = (window as any).streamProbe = { controller: new AbortController(), deltas: [] as string[], outcome: null as any, started: performance.now(), transport: [] as any[] };
    window.addEventListener('message', event => {
      if (event.source === parent && event.data?.__orkasApp === 1 && state.transport.length < 64) state.transport.push({ type: event.data.type, id: event.data.id, elapsed: performance.now() - state.started });
    });
    const input = { prompt: 'Controlled stream', maxTokens: 128 };
    (window as any).orkasApp.ai.generate(input, {
      signal: state.controller.signal, onProgress: (event: any) => state.deltas.push(event.text),
    }).then((result: any) => { state.outcome = result; }, (error: any) => { state.outcome = { code: error.code }; });
    input.prompt = 'Changed after SDK call';
  });
  try {
    await expect.poll(async () => ({ requests: orkas.modelRequests.length,
      outcome: await frame.locator('body').evaluate(() => (window as any).streamProbe.outcome),
    }), { timeout: 30_000 }).toEqual({ requests: 1, outcome: null });
    expect(JSON.stringify(orkas.modelRequests[0])).toContain('Controlled stream');
    expect(JSON.stringify(orkas.modelRequests[0])).not.toContain('Changed after SDK call');
    orkas.releaseControlledModelChunk();
    await expect.poll(() => frame.locator('body').evaluate(() => (window as any).streamProbe.deltas.join(''))).toBe('Hello from the local E2E model.');
    expect(await frame.locator('body').evaluate(() => (window as any).streamProbe.outcome)).toBeNull();
    await frame.locator('body').evaluate(() => (window as any).streamProbe.controller.abort());
    await expect.poll(() => frame.locator('body').evaluate(() => (window as any).streamProbe.outcome)).toEqual({ code: 'E_CANCELLED' });
    await expect.poll(() => orkas.electronApp!.evaluate(() =>
      (globalThis as any).__webAppObserver.read().filter((call: any) => call.method === 'ai.generate')
    )).toEqual([{ method: 'ai.generate', ok: false, code: 'E_CANCELLED' }]);
    orkas.finishControlledModelStream();
    orkas.setModelMode('success');
    const recovered = await frame.locator('body').evaluate(() => (window as any).orkasApp.ai.generate({ prompt: 'Explicit retry', maxTokens: 128 }));
    expect(recovered).toMatchObject({ text: 'Hello from the local E2E model.', stopReason: 'end_turn' });
    expect(orkas.modelRequests).toHaveLength(2);
    expect(await frame.locator('body').evaluate(() => (window as any).streamProbe.outcome)).toEqual({ code: 'E_CANCELLED' });
  } finally {
    const lifecycle = await orkas.page.evaluate(() => (window as any).__streamLifecycle);
    const state = await frame.locator('body').evaluate(() => ({ ready: document.readyState, outcome: (window as any).streamProbe?.outcome,
      aborted: (window as any).streamProbe?.controller.signal.aborted, transport: (window as any).streamProbe?.transport }), undefined, { timeout: 1000 }).catch(() => ({ unavailable: true }));
    const calls = await orkas.electronApp!.evaluate(() => (globalThis as any).__webAppObserver.read());
    const evidenceFile = info.outputPath('stream-lifecycle-evidence.json');
    writeFileSync(evidenceFile, JSON.stringify({ lifecycle, state, calls, requests: orkas.modelRequests.length }, null, 2));
    await info.attach('stream-lifecycle-evidence', { contentType: 'application/json', path: evidenceFile });
  }
});

test('SDK tools discovery and execution read the real Library without redundant app consent', async ({ modelOrkas: orkas }) => {
  await orkas.electronApp!.evaluate(async (_electron, modules) => {
    const { getActiveUserId } = (process as any).mainModule.require(modules.users);
    const { upsertFile } = (process as any).mainModule.require(modules.kb);
    const embedding = Array(512).fill(0); embedding[0] = 1;
    await upsertFile(getActiveUserId(), { relPath: 'sdk-note.md', kind: 'text', bytes: 23, mtime: 1, sha1: 'sdk-fixture',
      chunks: [{ title: 'SDK note', content: 'Independent Library content', embedding }] });
  }, { users: path.resolve(__dirname, '../../src/main/features/users.ts'), kb: path.resolve(__dirname, '../../src/main/features/kb_vector.ts') });
  const app: any = await seed(orkas, 'sdk-library');
  const frame = await mount(orkas, app.id);
  const catalog = await frame.locator('body').evaluate(() => (window as any).orkasApp.tools.list());
  expect(catalog.tools.map((tool: any) => tool.name)).toContain('library');
  expect(catalog.tools.map((tool: any) => tool.name)).not.toContain('bash');
  const result = await frame.locator('body').evaluate(() => (window as any).orkasApp.tools.call({ name: 'library', arguments: { action: 'read', scope: 'global', path: 'sdk-note.md' } }));
  expect(result.content).toContain('Independent Library content');
  expect(result.isError).not.toBe(true);
  expect(result).not.toHaveProperty('observations');
  expect(orkas.modelRequests).toHaveLength(0);
});

test('HTML preview loads the real SDK through an isolated host and leaves the app container working', async ({ modelOrkas: orkas }, info) => {
  const app: any = await seed(orkas, 'sdk-preview-boundary', html.replace('src="__orkas', 'src="/__orkas'));
  const preview = await orkas.electronApp!.evaluate(async (_electron, args) => {
    const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.module);
    return (await renderResponsiveHtmlPreview(args.entry, [{ name: 'desktop', width: 1280, height: 800 }], {}, { interactions: false })).evidence;
  }, { module: path.resolve(__dirname, '../../src/main/features/html_preview.ts'), entry: path.join(orkas.userWorkspaceRoot, 'sdk-preview-boundary/index.html') });
  await info.attach('standalone-preview-evidence', { contentType: 'application/json', body: JSON.stringify(preview) });
  expect(preview.ok).toBe(true);
  expect(preview.blockedResourceSamples).toEqual([]);
  expect(preview.sdk).toMatchObject({ mode: 'preview', storage: 'temporary' });
  expect(orkas.page.isClosed()).toBe(false);
  const frame = await mount(orkas, app.id);
  expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.host.getContext())).toMatchObject({ sdkVersion: 1 });
  expect(orkas.modelRequests).toHaveLength(0);
});

test('authoring preview uses SDK storage and reports unavailable services without dialogs, model calls or persistent state', async ({ modelOrkas: orkas }, info) => {
  const entry = orkas.createWorkspaceFile('sdk-preview-journey/index.html', `<!doctype html><html><head>
    <script src="/__orkas/sdk.js"></script><style>button:focus-visible{outline:3px solid blue}</style></head><body>
    <h1>Preview SDK</h1><button id="run">Check SDK</button><p id="result" role="status">Waiting</p><script>
    document.getElementById('run').onclick = async () => {
      const api = window.orkasApp, check = (value) => { if (!value) throw new Error('Preview SDK assertion failed'); };
      try {
        check(typeof window.orkas === 'undefined' && typeof require === 'undefined');
        const context = await api.host.getContext();
        check(context.mode === 'preview' && context.language === 'zh');
        await api.appFiles.writeText({path:'note.txt',text:'预览'});
        check((await api.appFiles.readText({path:'note.txt'})).text === '预览');
        const catalog = await api.capabilities.list();
        check(catalog.methods.find(m => m.name === 'ai.generate').available === false);
        check((await api.capabilities.describe({method:'storage.set'})).name === 'storage.set');
        check((await api.storage.get({key:'draft'})).value === null);
        await api.storage.set({key:'draft',value:'Preview text'});
        check((await api.storage.get({key:'draft'})).value === 'Preview text');
        check((await api.storage.keys()).keys.includes('draft'));
        await api.storage.remove({key:'draft'});
        await Promise.all(Array.from({length:12}, (_,i) => api.storage.set({key:'batch-'+i,value:i})));
        check((await api.storage.keys()).keys.length === 12);
        check((await api.tools.list()).tools.length === 0);
        for (const [method,args] of [['files.pick',{}],['files.saveAs',{name:'export.txt',text:'Denied'}],
          ['ai.generate',{prompt:'Must not run'}],['tools.call',{name:'library',arguments:{}}]]) {
          let code; try { await api.call(method,args); } catch (e) {code=e.code;} check(code === 'E_UNAVAILABLE');
        }
        document.getElementById('result').textContent = 'SDK verified';
      } catch(e) { console.error(e.message); document.getElementById('result').textContent='Failed'; }
    };
    </script></body></html>`);
  orkas.createWorkspaceFile('sdk-preview-journey/orkas-app.json', JSON.stringify({ sdkVersion: 1, capabilities: ['storage', 'appFiles', 'files', 'ai', 'library'] }));
  const result = await orkas.electronApp!.evaluate(async ({ BrowserWindow, dialog }, args) => {
    const fs = (process as any).mainModule.require('node:fs');
    const os = (process as any).mainModule.require('node:os');
    const { setLanguage } = (process as any).mainModule.require(args.config); setLanguage('zh');
    const windowsBefore = BrowserWindow.getAllWindows().map(w => w.id);
    const storesBefore = fs.readdirSync(os.tmpdir()).filter((name: string) => name.startsWith('orkas-preview-storage-')).sort();
    const dialogs: string[] = [];
    const original = { showOpenDialog: dialog.showOpenDialog, showSaveDialog: dialog.showSaveDialog, showMessageBox: dialog.showMessageBox };
    for (const key of Object.keys(original)) (dialog as any)[key] = async () => { dialogs.push(key); throw new Error('Unexpected native adapter'); };
    const { createLocalTools } = (process as any).mainModule.require(args.tools);
    const { getActiveUserId } = (process as any).mainModule.require(args.users);
    try {
      const tool = createLocalTools({ userId: getActiveUserId(), cwd: args.root }).find((tool: any) => tool.name === 'html_preview');
      const runs = [];
      for (let index = 0; index < 2; index++) runs.push(await tool.execute({ path: args.entry, target: 'desktop' }, { signal: new AbortController().signal, state: {} }));
      return { runs, dialogs, windowsBefore, windowsAfter: BrowserWindow.getAllWindows().map(w => w.id),
        storesBefore, storesAfter: fs.readdirSync(os.tmpdir()).filter((name: string) => name.startsWith('orkas-preview-storage-')).sort() };
    } finally { Object.assign(dialog, original); }
  }, { config: path.resolve(__dirname, '../../src/main/features/config.ts'), tools: path.resolve(__dirname, '../../src/main/model/core-agent/local-tools.ts'), users: path.resolve(__dirname, '../../src/main/features/users.ts'), root: orkas.userWorkspaceRoot, entry });
  await info.attach('preview-sdk-tool-journey', { contentType: 'application/json', body: JSON.stringify(result) });
  for (const run of result.runs) {
    expect(run.isError).not.toBe(true);
    const evidence = JSON.parse(run.content);
    expect(evidence.ok).toBe(true);
    expect(evidence.sdk.calls).toEqual(expect.arrayContaining([
      { method: 'host.getContext', code: 'OK' }, { method: 'storage.set', code: 'OK' },
      { method: 'storage.remove', code: 'OK' }, { method: 'tools.list', code: 'OK' },
      { method: 'files.pick', code: 'E_UNAVAILABLE' }, { method: 'files.saveAs', code: 'E_UNAVAILABLE' },
      { method: 'ai.generate', code: 'E_UNAVAILABLE' }, { method: 'tools.call', code: 'E_UNAVAILABLE' },
    ]));
  }
  expect(result.dialogs).toEqual([]);
  expect(result.storesAfter).toEqual(result.storesBefore);
  expect(result.windowsAfter).toEqual(result.windowsBefore);
  expect(orkas.page.isClosed()).toBe(false);
  expect(orkas.modelRequests).toHaveLength(0);
});

test('isolated origin denies forged messages, foreign data and revoked SDK calls',async({modelOrkas:orkas})=>{
  const app:any=await seed(orkas,'sdk-security');const frame=await mount(orkas,app.id);
  const before=orkas.modelRequests.length;
  await frame.locator('body').evaluate(()=>parent.postMessage({__orkasArtifact:true,type:'submit',payload:'Unapproved task'},'*'));
  const origin=await frame.locator('body').evaluate(()=>location.origin);
  expect(origin).toMatch(/^chat-app:\/\/app-[a-f0-9]{32}$/);
  expect(await frame.locator('body').evaluate(async()=>{try{await (window as any).orkasApp.call('auth.getConfig',{});return 'wrong';}catch(e){return (e as any).code;}})).toBe('E_METHOD');
  const other:any=await seed(orkas,'sdk-foreign');
  const remote:any=await orkas.invoke('savedApps.openInApp',{appId:other.id});
  expect(await frame.locator('body').evaluate(async(_node,url)=>{try{return await (await fetch(url)).text();}catch{return 'blocked';}},remote.url)).toBe('blocked');
  await frame.owner().page().evaluate(()=>{
    const frame=document.querySelector('.saved-app-viewer-frame') as HTMLIFrameElement;
    window.dispatchEvent(new MessageEvent('message',{source:frame.contentWindow,origin:'chat-app://forged',data:{__orkasApp:1,type:'call',id:'forged',method:'storage.set',args:{key:'attacked',value:true}}}));
  });
  expect(await frame.locator('body').evaluate(()=>(window as any).orkasApp.storage.get({key:'attacked'}))).toEqual({value:null});
  expect(await frame.locator('body').evaluate(()=>(window as any).orkasApp.permissions.revoke())).toEqual({revoked:true});
  expect(await frame.locator('body').evaluate(async()=>{try{await (window as any).orkasApp.storage.keys();return 'wrong';}catch(e){return (e as any).code;}})).toBe('E_CLOSED');
  expect(orkas.modelRequests.length).toBe(before);
});

test('local SDK chat artifacts submit results but external destinations cannot submit or call the SDK', async ({ modelOrkas: orkas }) => {
  const artifact: any = await orkas.electronApp!.evaluate(async (_electron, args) => {
    const { createArtifact } = (process as any).mainModule.require(args.artifacts);
    const { getActiveUserId } = (process as any).mainModule.require(args.users);
    return (await createArtifact(getActiveUserId(), 'sdk-chat-test', 'commander', { title: 'SDK chat', files: [
      { path: 'index.html', content: args.html },
      { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['storage'] }) }
    ] }));
  }, { artifacts: path.resolve(__dirname, '../../src/main/features/chat_artifacts.ts'),
    users: path.resolve(__dirname, '../../src/main/features/users.ts'), html });
  expect(artifact.ok).toBe(true);
  await orkas.page!.evaluate(id => {
    const host = document.createElement('div'); host.id = 'sdk-artifact-test'; document.body.append(host);
    (window as any).eval('currentCid = "sdk-chat-test"');
    (window as any).artifactSubmissions = 0;
    (window as any).sendInCurrentConversation = () => { (window as any).artifactSubmissions++; };
    (window as any).renderChatArtifact(host, { cid: 'sdk-chat-test', artifactId: id, title: 'SDK chat', agentId: 'commander' });
  }, artifact.artifactId);
  const frame = orkas.page!.locator('#sdk-artifact-test iframe').contentFrame();
  await expect(frame.locator('h1')).toHaveText('SDK App');
  await frame.locator('body').evaluate(async () => {
    parent.postMessage({ __orkasArtifact: true, type: 'submit', payload: 'Submitted local result' }, '*');
    await (window as any).orkasApp.storage.set({ key: 'working', value: true });
  });
  await expect.poll(() => orkas.page!.evaluate(() => (window as any).artifactSubmissions)).toBe(1);
  expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.storage.get({ key: 'working' }))).toEqual({ value: true });
  expect(orkas.modelRequests).toHaveLength(0);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url || '/');
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><h1>Remote destination</h1><script>
      parent.postMessage({__orkasApp:1,type:'call',id:'remote-write',method:'storage.set',args:{key:'working',value:false}},'*');
      parent.postMessage({__orkasArtifact:true,type:'submit',payload:'Unapproved remote task'},'*');
    </script>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as AddressInfo;
    const expectedRequests: string[] = [];
    for (const method of ['redirect', 'link']) {
      const url = `http://127.0.0.1:${address.port}/${method}`;
      if (method === 'redirect') {
        // A real document request, without a route override that could bypass
        // Electron's owning navigation guard.
        await frame.locator('body').evaluate((_node, url) => { location.replace(url); }, url);
      } else {
        await frame.locator('body').evaluate((_node, url) => {
          const link = document.createElement('a'); link.href = url;
          link.textContent = 'Open website'; link.target = '_self'; document.body.append(link);
        }, url);
        await frame.getByRole('link', { name: 'Open website' }).click();
      }
      await expect(frame.locator('h1')).toHaveText('Remote destination');
      expect(await frame.locator('body').evaluate(() => ({ sdk: typeof (window as any).orkasApp,
        ipc: typeof (window as any).orkas, node: typeof (window as any).require })))
        .toEqual({ sdk: 'undefined', ipc: 'undefined', node: 'undefined' });
      expectedRequests.push('/' + method);
      expect(requests).toEqual(expectedRequests);
      await orkas.page.evaluate(id => {
        const host = document.getElementById('sdk-artifact-test')!;
        host.replaceChildren();
        (window as any).renderChatArtifact(host, { cid: 'sdk-chat-test', artifactId: id, title: 'SDK chat', agentId: 'commander' });
      }, artifact.artifactId);
      await expect(frame.locator('h1')).toHaveText('SDK App');
      expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.storage.get({ key: 'working' }))).toEqual({ value: true });
      expect(await orkas.page.evaluate(() => (window as any).artifactSubmissions)).toBe(1);
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

for (const locale of [
  { language: 'zh', save: '保存草稿', label: '要总结的文本', empty: '请先输入文本。', saved: '草稿已保存。', summarize: '总结' },
  { language: 'ja', save: '下書きを保存', label: '要約するテキスト', empty: '先にテキストを入力してください。', saved: '下書きを保存しました。', summarize: '要約' },
  { language: 'pt', save: 'Salvar rascunho', label: 'Texto para resumir', empty: 'Digite algum texto primeiro.', saved: 'Rascunho salvo.', summarize: 'Resumir' },
]) test(`starter uses ${locale.language} for visible controls, document language and recovery`, async ({ modelOrkas: orkas }, info) => {
  await orkas.electronApp!.evaluate((_electron, args) => (process as any).mainModule.require(args.config).setLanguage(args.language),
    { config: path.resolve(__dirname, '../../src/main/features/config.ts'), language: locale.language });
  const source = path.resolve(__dirname, '../../resources/builtin/system/skills/web-app-sdk/assets/starter');
  const entry = orkas.createWorkspaceFile('localized/index.html', readFileSync(path.join(source, 'index.html'), 'utf8'));
  orkas.createWorkspaceFile('localized/orkas-app.json', readFileSync(path.join(source, 'orkas-app.json'), 'utf8'));
  const app: any = await orkas.invoke('savedApps.saveFromPath', { path: entry, title: 'Localized notebook' });
  await openSidebarEntry(orkas.page, '#apps-btn');
  const preview = await orkas.openPreview(() => orkas.page.locator(`.app-card[data-app-id="${app.id}"]`).click());
  const frame = preview.locator('.saved-app-viewer-frame').contentFrame();
  await expect(frame.locator('html')).toHaveAttribute('lang', locale.language);
  await expect(frame.getByRole('note')).toBeVisible();
  await preview.bringToFront();
  await frame.locator('body').evaluate(() => {
    (window as any).__localeInput = [];
    for (const type of ['pointerdown', 'pointerup', 'click']) document.addEventListener(type, event => {
      (window as any).__localeInput.push({ type, target: (event.target as HTMLElement).id, trusted: event.isTrusted, focused: document.hasFocus() });
    }, true);
  });
  await frame.getByRole('button', { name: locale.summarize, exact: true }).click();
  try { await expect(frame.getByRole('status')).toHaveText(locale.empty); }
  finally {
    const evidence = await frame.locator('body').evaluate(() => ({ events: (window as any).__localeInput, focused: document.hasFocus() }));
    await info.attach('localized-input-evidence', { contentType: 'application/json', body: JSON.stringify(evidence) });
  }
  await frame.getByRole('textbox', { name: locale.label }).fill('跨设备 notebook');
  await frame.getByRole('button', { name: locale.save, exact: true }).click();
  await expect(frame.getByRole('status')).toHaveText(locale.saved);
  expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.storage.get({ key: 'draft', scope: 'cloud' }))).toEqual({ value: '跨设备 notebook' });
  expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.storage.get({ key: 'draft' }))).toEqual({ value: null });
  expect(orkas.modelRequests).toHaveLength(0);
});

test('a large source bundle opens, persists multi-megabyte data and accepts concurrent SDK calls', async ({ modelOrkas: orkas }, info) => {
  for (let i = 0; i < 320; i++) orkas.createWorkspaceFile(`sdk-growing/assets/data${i}.json`, JSON.stringify({ index: i }));
  const app: any = await seed(orkas, 'sdk-growing');
  expect(app).toMatchObject({ ok: true, fileCount: 322 });
  const frame = await mount(orkas, app.id);
  const source = orkas.createWorkspaceFile('large-selected.txt', 'selected:α\n'.repeat(200000));
  await orkas.selectFilesOnNextDialog([source]);
  const imported = await frame.locator('body').evaluate(async () => {
    const api = (window as any).orkasApp;
    const file = await api.files.pick();
    const value = await api.files.readText({ handle: file.handle });
    await api.files.release({ handle: file.handle });
    return { size: file.size, valid: value.text === 'selected:α\n'.repeat(200000) };
  });
  expect(imported).toEqual({ size: Buffer.byteLength('selected:α\n'.repeat(200000)), valid: true });
  const result = await frame.locator('body').evaluate(async () => {
    const api = (window as any).orkasApp;
    const start = performance.now();
    const data = 'abcdefgh'.repeat(256 * 1024); // 2 MiB in each file.
    await Promise.all(Array.from({ length: 12 }, (_, i) => api.appFiles.writeText({ path: `data/${i}.txt`, text: data })));
    await api.storage.set({ key: 'large', value: data });
    const values = await Promise.all(Array.from({ length: 12 }, (_, i) => api.appFiles.readText({ path: `data/${i}.txt` })));
    const stored = await api.storage.get({ key: 'large' });
    return { valid: values.every(value => value.text === data) && stored.value === data,
      files: (await api.appFiles.list()).files.length, elapsedMs: Math.round(performance.now() - start) };
  });
  expect(result).toMatchObject({ valid: true, files: 12 });
  writeFileSync(info.outputPath('quota-workload.json'), JSON.stringify({ bytesPerFile: 2 * 1024 * 1024,
    totalFileBytes: 24 * 1024 * 1024, concurrentCalls: 12, elapsedMs: result.elapsedMs }));
  await orkas.closePreview(frame.owner().page());
  const reopened = await mount(orkas, app.id);
  expect(await reopened.locator('body').evaluate(async () => {
    const api = (window as any).orkasApp;
    const data = 'abcdefgh'.repeat(256 * 1024);
    return (await api.storage.get({ key: 'large' })).value === data &&
      (await api.appFiles.readText({ path: 'data/11.txt' })).text === data;
  })).toBe(true);
  expect(orkas.modelRequests).toHaveLength(0);
});

test('embedded pages, forms, downloads, external links and workers keep the app usable', async ({modelOrkas:orkas}) => {
  const submitted:string[]=[];
  const server=createServer((req,res)=>{
    if (req.url === '/redirect-download') { res.writeHead(302, { Location: '/attachment' }); res.end(); return; }
    if (req.url === '/attachment') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename=server-report.txt' }); res.end('server report'); return; }
    req.on('data',chunk=>submitted.push(String(chunk)));
    res.setHeader('Content-Type','text/html');res.end('<h1>'+ (req.url==='/submit'?'Submitted':'Embedded') +'</h1>');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await orkas.electronApp!.evaluate(({shell,session})=>{
      (globalThis as any).__browserActions={links:[],downloads:[]};
      shell.openExternal=async url=>{(globalThis as any).__browserActions.links.push(url);};
      session.defaultSession.on('will-download',(event,item)=>{event.preventDefault();(globalThis as any).__browserActions.downloads.push(item.getFilename());});
    });
    const app:any=await seed(orkas,'browser-actions',html.replace('</body>',`
      <iframe name="content" src="${base}/view"></iframe>
      <form action="${base}/submit" method="post" target="content"><input name="value" value="accepted"><button>Submit form</button></form>
      <a href="${base}/popup" target="_blank">Open external</a>
      <button id="download" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['report']));a.download='report.txt';a.click()">Download</button>
      <a href="${base}/attachment">Server download</a><a href="${base}/redirect-download">Redirected download</a>
      <output id="worker"></output><script>
        const url=URL.createObjectURL(new Blob(['postMessage(42)'],{type:'text/javascript'}));
        const worker=new Worker(url);worker.onmessage=e=>{document.querySelector('#worker').textContent=e.data;worker.terminate();URL.revokeObjectURL(url)};
      </script></body>`));
    const frame=await mount(orkas,app.id);
    await expect(frame.locator('#worker')).toHaveText('42');
    await expect(frame.locator('iframe').contentFrame().getByRole('heading')).toHaveText('Embedded');
    expect(await frame.locator('body').evaluate(()=>(window as any).orkasApp.storage.keys())).toEqual({keys:[]});
    await frame.getByRole('button',{name:'Submit form'}).click();
    await expect(frame.locator('iframe').contentFrame().getByRole('heading')).toHaveText('Submitted');
    expect(submitted.join('')).toBe('value=accepted');
    await frame.getByRole('link',{name:'Open external'}).click();
    await frame.getByRole('button',{name:'Download',exact:true}).click();
    await expect.poll(()=>orkas.electronApp!.evaluate(()=>(globalThis as any).__browserActions)).toEqual({links:[base+'/popup'],downloads:['report.txt']});
    expect(await frame.locator('body').evaluate(()=>(window as any).orkasApp.storage.keys())).toEqual({keys:[]});
    for (const [index, name] of ['Server download', 'Redirected download'].entries()) {
      await frame.getByRole('link', { name, exact: true }).click();
      await expect.poll(() => orkas.electronApp!.evaluate(() => (globalThis as any).__browserActions.downloads.length)).toBe(index + 2);
      expect(await frame.locator('body').evaluate(() => (window as any).orkasApp.storage.keys())).toEqual({ keys: [] });
    }
    expect(orkas.modelRequests).toHaveLength(0);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('new ordinary apps isolate browser data across objects and accounts while reopen and legacy data survive', async ({ modelOrkas: orkas }) => {
  const entry = orkas.createWorkspaceFile('browser-data/index.html', '<!doctype html><h1>Browser data</h1><script src="__orkas/bridge.js"></script>');
  const saved: any[] = [];
  for (const title of ['First', 'Second', 'Legacy']) {
    const app: any = await orkas.invoke('savedApps.saveFromPath', { path: entry, title, mode: 'new' });
    expect(app.ok).toBe(true); saved.push(app);
  }
  expect(new Set(saved.map(app => app.id)).size).toBe(3);
  const oldMeta = path.join(orkas.workspaceRoot, 'account-e2e/cloud/saved_apps', saved[2].id, '__orkas-meta.json');
  const metadata = JSON.parse(readFileSync(oldMeta, 'utf8')); delete metadata.browserStorage;
  writeFileSync(oldMeta, JSON.stringify(metadata));
  const open = async (source: any, id = 'browser-probe') => {
    const result = await orkas.page.evaluate(async ({ source, id }) => {
      document.getElementById(id)?.remove();
      const frame = document.createElement('iframe'); frame.id = id;
      frame.setAttribute('sandbox', (window as any).OrkasArtifactSecurity.SANDBOX);
      document.body.append(frame);
      await (window as any).OrkasWebAppHost.open(frame, source);
      return { url: frame.src, sdk: (window as any).OrkasWebAppHost.isManaged(frame) };
    }, { source, id });
    expect(result.sdk).toBe(false);
    const body = orkas.page.locator('#' + id).contentFrame().locator('body');
    await expect(body).toContainText('Browser data');
    return { ...result, body };
  };
  const data = (body: any, value?: string): Promise<{ local: string | null; indexed: string | null }> => body.evaluate(async (_node: unknown, value: string | undefined) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('drafts', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('values');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      if (value !== undefined) {
        localStorage.setItem('draft', value);
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('values', 'readwrite'); tx.objectStore('values').put(value, 'draft');
          tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
        });
      }
      const indexed = await new Promise<string | null>((resolve, reject) => {
        const request = db.transaction('values').objectStore('values').get('draft');
        request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error);
      });
      return { local: localStorage.getItem('draft'), indexed };
    } finally { db.close(); }
  }, value);
  const first = await open({ appId: saved[0].id });
  expect(first.url).toMatch(/^chat-app:\/\/a-[a-f0-9]{20}\/index.html$/);
  expect(await data(first.body, 'First private draft')).toEqual({ local: 'First private draft', indexed: 'First private draft' });
  const second = await open({ appId: saved[1].id }, 'browser-second');
  expect(second.url).not.toBe(first.url);
  expect(await data(second.body)).toEqual({ local: null, indexed: null });
  expect(await second.body.evaluate(async (_node, url) => { try { await fetch(url); return true; } catch { return false; } }, first.url)).toBe(false);
  // Ordinary bridge messages remain trusted, but no SDK adapter is installed.
  await orkas.page.evaluate(() => {
    (window as any).ordinaryBridgeEvidence = [];
    window.addEventListener('message', event => {
      const frame = document.getElementById('browser-probe');
      if (event.data?.type === 'submit' && (window as any).OrkasArtifactSecurity.trustedArtifactMessage(event, frame))
        (window as any).ordinaryBridgeEvidence.push(event.data.payload);
    });
  });
  await first.body.evaluate(() => (window as any).orkasArtifact.send({ draft: 'Bridge retained' }));
  await expect.poll(() => orkas.page.evaluate(() => (window as any).ordinaryBridgeEvidence)).toEqual([{ draft: 'Bridge retained' }]);
  // Same-task artifacts must not share their storage or an old cid route.
  const artifacts: any[] = [];
  for (let i = 0; i < 2; i++) {
    const artifact = await orkas.electronApp!.evaluate(async (_electron, modulePath) =>
      (process as any).mainModule.require(modulePath).createArtifact('account-e2e', 'browser-task', 'commander', {
        files: [{ path: 'index.html', content: '<!doctype html><h1>Browser data</h1>' }],
      }), path.resolve(__dirname, '../../src/main/features/chat_artifacts.ts'));
    expect(artifact.ok).toBe(true); artifacts.push(artifact);
  }
  const artifactOne = await open({ cid: 'browser-task', artifactId: artifacts[0].artifactId }, 'artifact-one');
  await data(artifactOne.body, 'Artifact draft');
  const artifactTwo = await open({ cid: 'browser-task', artifactId: artifacts[1].artifactId }, 'artifact-two');
  expect(await data(artifactTwo.body)).toEqual({ local: null, indexed: null });
  expect(await orkas.electronApp!.evaluate(async ({ net }, url) => (await net.fetch(url)).status,
    `chat-app://cid/browser-task/${artifacts[0].artifactId}/index.html`)).toBe(403);
  const alias = `chat-app://saved/${saved[0].id}/index.html`;
  expect(await orkas.electronApp!.evaluate(async ({ net }, url) => (await net.fetch(url)).status, alias)).toBe(403);
  const legacy = await open({ appId: saved[2].id }, 'browser-legacy');
  expect(legacy.url).toBe(`chat-app://saved/${saved[2].id}/index.html`);
  await data(legacy.body, 'Legacy retained');
  const reopened = await open({ appId: saved[0].id });
  expect(reopened.url).toBe(first.url);
  expect(await data(reopened.body)).toEqual({ local: 'First private draft', indexed: 'First private draft' });

  // Same source identifiers in another account must not reuse the first account's origin.
  const otherRoot = path.join(orkas.workspaceRoot, 'browser-other/cloud/saved_apps');
  mkdirSync(otherRoot, { recursive: true });
  cpSync(path.join(orkas.workspaceRoot, 'account-e2e/cloud/saved_apps', saved[0].id), path.join(otherRoot, saved[0].id), { recursive: true });
  await orkas.switchLocalUser('browser-other', { nickname: 'Other', email: 'other@example.invalid' });
  const other = await open({ appId: saved[0].id });
  expect(other.url).not.toBe(first.url);
  expect(await data(other.body)).toEqual({ local: null, indexed: null });
  await orkas.switchLocalUser('account-e2e', { nickname: 'Original', email: 'original@example.invalid' });
  const restarted = await open({ appId: saved[0].id });
  expect(restarted.url).toBe(first.url);
  expect(await data(restarted.body)).toEqual({ local: 'First private draft', indexed: 'First private draft' });
  expect(await data((await open({ appId: saved[2].id }, 'browser-legacy')).body)).toEqual({ local: 'Legacy retained', indexed: 'Legacy retained' });
  expect(orkas.modelRequests).toHaveLength(0);
});


test('local SDK form results reach their original conversation from the card and detached preview', async ({ modelOrkas: orkas }) => {
  const created: any = await orkas.invoke('conversations.create', { title: 'SDK form task' });
  const other: any = await orkas.invoke('conversations.create', { title: 'Unrelated task' });
  const cid = created.conversation.conversation_id, otherCid = other.conversation.conversation_id;
  const artifact = await orkas.electronApp!.evaluate(async (_electron, args) =>
    (process as any).mainModule.require(args.module).createArtifact('account-e2e', args.cid, 'commander', {
      title: 'Travel form', files: [
        { path: 'index.html', content: '<!doctype html><script src="/__orkas/sdk.js"></script><h1>Travel form</h1><button id="submit">Send preferences</button><script>document.querySelector("button").onclick=async()=>{await orkasApp.storage.set({key:"city",value:"Kyoto"});orkasArtifact.send({city:"Kyoto",budget:1200});};</script>' },
        { path: 'orkas-app.json', content: JSON.stringify({ sdkVersion: 1, capabilities: ['storage'] }) },
      ],
    }), { module: path.resolve(__dirname, '../../src/main/features/chat_artifacts.ts'), cid });
  expect(artifact.ok).toBe(true);
  const transcript = path.join(orkas.workspaceRoot, 'account-e2e/cloud/chats', cid + '.jsonl');
  const foreignTranscript = path.join(orkas.workspaceRoot, 'account-e2e/cloud/chats', otherCid + '.jsonl');
  appendFileSync(transcript, JSON.stringify({ id: 'sdk-form-fixture', ts: new Date().toISOString(), from: 'commander', to: ['user'],
    text: 'Fill in your preferences.', artifacts: [{ id: artifact.artifactId, title: 'Travel form', agent_id: 'commander' }] }) + '\n');
  const results = (file: string) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(message => message.from === 'user' && String(message.text).includes('<artifact-result'));
  await orkas.page.evaluate(async cid => { await (window as any).loadConversations(); await (window as any).setView('conversation', cid); }, cid);
  const card = orkas.page.locator('#chat-history .chat-artifact-card');
  await card.locator('iframe').contentFrame().getByRole('button', { name: 'Send preferences' }).click();
  await expect.poll(() => results(transcript).length).toBe(1);
  expect(results(transcript)[0].text).toContain('"city":"Kyoto"');
  await expect.poll(() => orkas.modelRequests.length).toBe(1);
  await expect(orkas.page.locator('#chat-history')).toContainText('Hello from the local E2E model.');
  await expect(orkas.page.locator('#chat-send-btn')).not.toHaveClass(/\bstreaming\b/);
  const preview = await orkas.openPreview(() => orkas.page.evaluate(source =>
    (window as any).OrkasPreviewWindows.open(source), { kind: 'artifact', cid, artifactId: artifact.artifactId, agentId: 'commander', title: 'Travel form' }));
  await orkas.page.evaluate(cid => (window as any).setView('conversation', cid), otherCid);
  await preview.locator('iframe.chat-artifact-frame').contentFrame().getByRole('button', { name: 'Send preferences' }).click();
  await expect.poll(() => results(transcript).length).toBe(2);
  expect(results(foreignTranscript)).toEqual([]);
  await expect.poll(() => orkas.modelRequests.length).toBe(2);
  expect(results(transcript)[1].text).toContain('"budget":1200');
});


test('historical web artifacts cannot submit conversation tasks with a forged local display type', async ({ modelOrkas: orkas }) => {
  const task = await orkas.invoke<any>('conversations.create', { title: 'Historical web output' });
  const cid = task.conversation.conversation_id, artifactId = 'web-submit-test';
  const dir = path.join(orkas.workspaceRoot, 'account-e2e/cloud/chat_artifacts', cid, artifactId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'index.html'), '<h1>Historical browser app</h1>');
  writeFileSync(path.join(dir, '__orkas-meta.json'), JSON.stringify({ appType: 'web', title: 'Web output', entry: 'index.html' }));
  await orkas.page.evaluate(({ cid, artifactId }) => {
    const host = document.createElement('div'); host.id = 'web-submit-test'; document.body.append(host);
    (window as any).unexpectedSubmissions = 0;
    (window as any).sendInCurrentConversation = () => { (window as any).unexpectedSubmissions++; };
    (window as any).renderChatArtifact(host, { cid, artifactId, agentId: 'commander' });
  }, { cid, artifactId });
  const iframe = orkas.page.locator('#web-submit-test iframe');
  await expect(iframe.contentFrame().locator('body')).toContainText('Historical browser app');
  await expect(iframe).toHaveAttribute('src', /^chat-app:/);
  await iframe.evaluate(node => { (node as HTMLElement).dataset.appType = 'local'; });
  expect(await iframe.evaluate(node => (window as any).OrkasWebAppHost.canSubmitArtifact(node))).toBe(false);
  const reopened: any = await orkas.invoke('webApps.open', { source: { cid, artifactId } });
  expect(reopened).toMatchObject({ ok: true, token: expect.any(String) });
  expect(await orkas.invoke('webApps.canSubmitArtifact', { token: reopened.token })).toMatchObject({ ok: true, allowed: false });
  await orkas.invoke('webApps.close', { token: reopened.token });
  expect(await orkas.page.evaluate(() => (window as any).unexpectedSubmissions)).toBe(0);
  expect(orkas.modelRequests).toHaveLength(0);
});
