import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ConsoleMessage, ElectronApplication, Request, Response, WebError } from '@playwright/test';

import { chatMediaLocalUrl } from '../../src/main/util/chat-media-url';
import { expect, test } from './fixtures/orkas';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// A multi-file page as agents usually produce it: sibling stylesheet, a
// classic script in a subfolder, an ES module, fetched JSON and a local font.
const SYSTEM_FONT = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  'C:\\Windows\\Fonts\\arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
].find((candidate) => existsSync(candidate));

function createMultiFileSite(orkas: { createWorkspaceFile(relativePath: string, content: string | Buffer): string }, dir: string, useStorage: boolean): string {
  orkas.createWorkspaceFile(`${dir}/style.css`, `${SYSTEM_FONT ? '@font-face{font-family:PreviewFont;src:url(fonts/preview.ttf)}' : ''}
output#classic{color:rgb(10, 20, 30)}`);
  orkas.createWorkspaceFile(`${dir}/assets/icons.js`, "window.__icons = 'icons ready';");
  orkas.createWorkspaceFile(`${dir}/app.mjs`, "document.getElementById('module').textContent = 'module ran';");
  orkas.createWorkspaceFile(`${dir}/data.json`, '{"label":"data loaded"}');
  if (SYSTEM_FONT) orkas.createWorkspaceFile(`${dir}/fonts/preview.ttf`, readFileSync(SYSTEM_FONT));
  return orkas.createWorkspaceFile(`${dir}/index.html`, `<!doctype html>
<html><head><link rel="stylesheet" href="style.css"><script src="assets/icons.js"></script>
<script type="module" src="app.mjs"></script></head><body>
  <button>Refresh</button>
  <output id="classic"></output><output id="module"></output><output id="data"></output>
  <output id="font"></output><output id="storage"></output>
  <script>
    document.getElementById('classic').textContent = window.__icons || 'missing';
    fetch('data.json').then((r) => r.json())
      .then((d) => { document.getElementById('data').textContent = d.label; })
      .catch((e) => { document.getElementById('data').textContent = e.name; });
    document.fonts.load('16px PreviewFont').then((faces) => {
      document.getElementById('font').textContent = faces.length ? 'font loaded' : 'no font';
    });
    try {
      localStorage.setItem('draft', '1');
      document.getElementById('storage').textContent = 'available';
    } catch (e) {
      document.getElementById('storage').textContent = e.name;
      ${useStorage ? "console.error('draft storage unavailable: ' + e.message);" : ''}
    }
  </script>
</body></html>`);
}

// Delay the actual document response, leaving layout IPC and the renderer's
// native iframe load events intact. Each test owns an isolated Electron app.
async function holdFirstHtmlResponse(app: ElectronApplication, html: string) {
  await app.evaluate(({ protocol }, content) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const gate = { release, requested: false };
    (globalThis as any).__htmlResponseGate = gate;
    protocol.unhandle('chat-media');
    protocol.handle('chat-media', async () => {
      if (!gate.requested) {
        gate.requested = true;
        await pending;
      }
      return new Response(content, { headers: { 'Content-Type': 'text/html' } });
    });
  }, html);
  return () => app.evaluate(() => (globalThis as any).__htmlResponseGate.release());
}

test.describe('local HTML preview', () => {
  test('loads same-folder styles, scripts, modules, data and fonts while storage stays sandboxed', async ({ appPage, orkas }) => {
    const entry = createMultiFileSite(orkas, 'site', false);
    const preview = await orkas.openPreview(() => appPage.evaluate((p) => {
      void (window as any).openChatFileViewer(p, 'index.html');
    }, entry));
    const frame = preview.locator('.chat-file-viewer-html').contentFrame();
    await expect(frame.locator('#classic')).toHaveText('icons ready');
    await expect(frame.locator('#classic')).toHaveCSS('color', 'rgb(10, 20, 30)');
    await expect(frame.locator('#module')).toHaveText('module ran');
    await expect(frame.locator('#data')).toHaveText('data loaded');
    if (SYSTEM_FONT) await expect(frame.locator('#font')).toHaveText('font loaded');
    await expect(frame.locator('#storage')).toHaveText('SecurityError');
  });

  test('renders same-folder frames with production scheme privileges while keeping opaque-origin isolation', async ({ orkas }) => {
    orkas.createWorkspaceFile('frame-check/child.html', `<!doctype html><style>html,body{margin:0;background:#00ff00}</style>
      <script>parent.postMessage('child-ready','*')</script>`);
    const entry = orkas.createWorkspaceFile('frame-check/index.html', `<!doctype html><style>html,body{margin:0;background:#ff0000}iframe{width:400px;height:400px;border:0}</style>
      <output id="status">waiting</output><iframe src="child.html"></iframe><script>
      addEventListener('message',event=>{if(event.data!=='child-ready')return;
        let storageDenied=false,domDenied=false;
        try{localStorage.setItem('probe','1')}catch{storageDenied=true}
        try{domDenied=!document.querySelector('iframe').contentDocument}catch{domDenied=true}
        document.getElementById('status').textContent='child-ready storage-denied:'+storageDenied+' dom-denied:'+domDenied;
        if(storageDenied&&domDenied)document.body.style.background='#00ff00';
      });</script>`);
    const observed = await orkas.electronApp!.evaluate(async (_, args) => {
      const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.modulePath);
      const { nativeImage } = (process as any).mainModule.require('electron');
      const rendered = await renderResponsiveHtmlPreview(args.entry, [
        { name: 'desktop', width: 960, height: 640 },
      ], {}, { interactions: false, fileViewer: true });
      const image = nativeImage.createFromBuffer(rendered.screenshots[0]);
      return {
        evidence: rendered.evidence,
        pixel: Array.from(image.crop({ x: 200, y: 200, width: 1, height: 1 }).toBitmap()) as number[],
        isolationPixel: Array.from(image.crop({ x: 600, y: 200, width: 1, height: 1 }).toBitmap()) as number[],
      };
    }, { modulePath: path.resolve(__dirname, '../../src/main/features/html_preview.ts'), entry });
    expect(observed.evidence.viewports[0].consoleErrors).toEqual([]);
    // The child must paint green. The separate parent pixel turns green only
    // after real postMessage delivery and both sandbox denials succeed.
    for (const pixel of [observed.pixel, observed.isolationPixel]) {
      expect(pixel[3]).toBe(255);
      expect(pixel[1]).toBeGreaterThan(Math.max(pixel[0], pixel[2]));
    }
  });

  test('checks a deliverable page under the file viewer sandbox and keeps artifact checks unchanged', async ({ orkas }) => {
    const modulePath = path.resolve(__dirname, '../../src/main/features/html_preview.ts');
    const clean = createMultiFileSite(orkas, 'check-clean', false);
    const storage = createMultiFileSite(orkas, 'check-storage', true);
    const check = (htmlPath: string, fileViewer: boolean) => orkas.electronApp!.evaluate(async (_, args) => {
      const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.modulePath);
      const result = await renderResponsiveHtmlPreview(args.htmlPath, [
        { name: 'desktop', width: 1280, height: 800 },
      ], {}, { interactions: false, fileViewer: args.fileViewer });
      return result.evidence;
    }, { modulePath, htmlPath, fileViewer });

    const cleanEvidence = await check(clean, true);
    expect(cleanEvidence.viewports[0].consoleErrors).toEqual([]);
    expect(cleanEvidence.blockedResourceCount).toBe(0);
    expect(cleanEvidence.ok).toBe(true);

    const storageEvidence = await check(storage, true);
    expect(storageEvidence.ok).toBe(false);
    expect(storageEvidence.viewports[0].consoleErrors.join(' ')).toMatch(/draft storage unavailable: .*sandboxed/);

    // Generated artifacts run in chat-app:// with a real origin; their smoke
    // check keeps the default loading and may use storage.
    const artifactEvidence = await check(storage, false);
    expect(artifactEvidence.viewports[0].consoleErrors).toEqual([]);
  });

  test('audits filter panels after a dense graphic and retains missing effects as inconclusive', async ({ orkas }) => {
    const modulePath = path.resolve(__dirname, '../../src/main/features/html_preview.ts');
    for (const working of [true, false]) {
      const htmlPath = orkas.createWorkspaceFile(`dense-filter-${working}.html`, `<!doctype html>
<html><head><style>
  button:focus-visible { outline: 2px solid blue; }
  .dot { display: inline-block; width: 2px; height: 2px; }
  #panel { position: fixed; top: 80px; background: white; }
  #panel[hidden] { display: none; }
</style></head><body>
  <button onclick="${working ? "document.getElementById('panel').hidden = false" : ''}">FILTER</button>
  ${'<span class="dot"></span>'.repeat(300)}
  <section id="panel" hidden><p>Filter options</p>
    <button onclick="document.getElementById('panel').hidden = true">Close</button>
  </section>
</body></html>`);
      const evidence = await orkas.electronApp!.evaluate(async (_, args) => {
        const { renderResponsiveHtmlPreview } = (process as any).mainModule.require(args.modulePath);
        const result = await renderResponsiveHtmlPreview(args.htmlPath, [
          { name: 'desktop', width: 1280, height: 800 },
        ]);
        return result.evidence;
      }, { modulePath, htmlPath });

      expect(evidence.blockedResourceCount).toBe(0);
      expect(evidence.viewports[0].consoleErrors).toEqual([]);
      expect(evidence.ok).toBe(true);
      expect(evidence.interactions.stateTransitionsObserved).toBe(working ? 2 : 0);
      expect(evidence.interactions.failures).toEqual([]);
      expect(evidence.interactions.warnings).toEqual(working ? [] : [
        'enabled control produced no observable outcome: FILTER',
      ]);
    }
  });

  test('keeps layout inference responsive for long HTML with blocking resource tags', async ({
    appPage,
    orkas,
  }) => {
    const blockers = Array.from({ length: 16 }, (_, index) => (
      `<script src="./blocked-${index}.js"></script><link rel="stylesheet" href="./blocked-${index}.css">`
    )).join('');
    const htmlPath = orkas.createWorkspaceFile('blocking-resource-preview.html', `<!doctype html>
<html><head>${blockers}<style>main { color: rgb(12, 34, 56); }</style></head>
<body><main id="ready">${'preview-ready '.repeat(8_000)}</main></body></html>`);

    // The 32 absent assets are an intentional negative fixture. Record their
    // real responses independently of the generic Chromium console text; any
    // other response failure or renderer error still fails this case.
    const context = orkas.electronApp!.context();
    const expectedUrls = Array.from({ length: 16 }, (_, index) => ['js', 'css'].map(extension =>
      new URL(`./blocked-${index}.${extension}`, chatMediaLocalUrl(htmlPath)).href)).flat().sort();
    const expected = new Set(expectedUrls);
    const responses: Array<{ url: string; status: number }> = [];
    const consoleErrors: Array<{ text: string; url: string }> = [];
    const requestFailures: Array<{ url: string; error: string | null; responseUrl: string | null; status: number | null }> = [];
    const pageErrors: string[] = [];
    const onResponse = (response: Response) => {
      const url = response.url();
      if (expected.has(url) || response.status() >= 400) responses.push({ url, status: response.status() });
    };
    const onConsole = (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push({ text: message.text(), url: message.location().url });
    };
    const onRequestFailed = (request: Request) => {
      // The custom-scheme missing script/style response supplies404 headers,
      // then Chromium aborts its body. Pair the failure with THIS request's
      // actual response, rather than accepting unrelated ERR_ABORTED events.
      const response = request.existingResponse();
      requestFailures.push({ url: request.url(), error: request.failure()?.errorText ?? null,
        responseUrl: response?.url() ?? null, status: response?.status() ?? null });
    };
    const onWebError = (error: WebError) => pageErrors.push(error.error().message);
    context.on('weberror', onWebError);
    context.on('response', onResponse);
    context.on('console', onConsole);
    context.on('requestfailed', onRequestFailed);
    try {
      const startedAt = Date.now();
      const preview = await orkas.openPreview(() => appPage.evaluate((pathValue) => {
        void (window as any).openChatFileViewer(pathValue, 'blocking-resource-preview.html');
      }, htmlPath));

      const body = preview.locator('.chat-file-viewer-body');
      await expect(body).not.toHaveAttribute('aria-busy', 'true', { timeout: 5_000 });
      const elapsedMs = Date.now() - startedAt;
      expect(elapsedMs).toBeLessThan(5_000);
      const frame = preview.locator('.chat-file-viewer-html');
      expect(await frame.getAttribute('src')).toMatch(/^chat-media:\/\/local\//);
      await expect(frame.contentFrame().locator('#ready')).toContainText('preview-ready');
      await expect.poll(() => responses.length).toBe(32);
      expect(responses.map(response => response.url).sort()).toEqual(expectedUrls);
      expect(responses.every(response => response.status === 404)).toBe(true);
      await expect.poll(() => consoleErrors.length).toBe(32);
      expect(consoleErrors.every(error => error.text === 'Failed to load resource: the server responded with a status of 404 (Not Found)'
        && (!error.url || expected.has(error.url)))).toBe(true);
      await expect.poll(() => requestFailures.length).toBe(32);
      expect(requestFailures.map(failure => failure.url).sort()).toEqual(expectedUrls);
      expect(requestFailures.every(failure => failure.error === 'net::ERR_ABORTED'
        && failure.status === 404 && failure.responseUrl === failure.url)).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      context.off('weberror', onWebError);
      context.off('response', onResponse);
      context.off('console', onConsole);
      context.off('requestfailed', onRequestFailed);
      await test.info().attach('blocking-resource-receipt.json', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
        expectedUrls, responses, consoleErrors, requestFailures, pageErrors,
      })) });
    }
  });

  test('keeps the file-viewer loading state visible until layout and iframe are both ready', async ({
    appPage,
    orkas,
  }) => {
    const htmlPath = orkas.createWorkspaceFile('loading-preview.html', `<!doctype html>
<html><body><main id="ready">preview-ready</main></body></html>`);

    const release = await holdFirstHtmlResponse(orkas.electronApp!,
      '<!doctype html><main id="ready">preview-ready</main>');
    try {
      // This resolves after layout IPC, while the HTML response remains held.
      const preview = await orkas.openPreview(() => appPage.evaluate((pathValue) => (
        (window as any).openChatFileViewer(pathValue, 'loading-preview.html')
      ), htmlPath));

      let viewer = preview.locator('.chat-file-viewer');
      const body = viewer.locator('.chat-file-viewer-body');
      await expect(viewer).toHaveClass(/is-open/);
      await expect(body).toHaveAttribute('aria-busy', 'true');
      await expect(body.locator('.chat-file-viewer-loading')).toBeVisible();
      await expect(body.locator('.chat-file-viewer-html')).toHaveCSS('visibility', 'hidden');

      await release();
      await expect(body).not.toHaveAttribute('aria-busy', 'true');
      await expect(body.locator('.chat-file-viewer-loading')).toHaveCount(0);
      await expect(body.locator('.chat-file-viewer-html')).toHaveCSS('visibility', 'visible');
      await expect(body.locator('iframe').contentFrame().locator('#ready')).toHaveText('preview-ready');
    } finally {
      await release();
    }
  });

  test('closes a pending preview without waiting and reopens a working document', async ({
    appPage,
    orkas,
  }) => {
    const htmlPath = orkas.createWorkspaceFile('reopen-preview.html', '<!doctype html><main>preview</main>');
    const release = await holdFirstHtmlResponse(orkas.electronApp!,
      '<!doctype html><button id="action" onclick="this.textContent=\'done\'">ready</button>');
    try {
      let preview = await orkas.openPreview(() => appPage.evaluate((pathValue) => (
        (window as any).openChatFileViewer(pathValue, 'reopen-preview.html')
      ), htmlPath));
      await expect.poll(() => orkas.electronApp!.evaluate(() => (
        (globalThis as any).__htmlResponseGate.requested
      ))).toBe(true);
      let viewer = preview.locator('.chat-file-viewer');
      await orkas.closePreview(preview);
      await expect.poll(() => preview.isClosed()).toBe(true);

      // Reopen while the old response is still held, then let that stale
      // response finish. It must not dismiss or overwrite the new preview.
      preview = await orkas.openPreview(() => appPage.evaluate((pathValue) => (
        (window as any).openChatFileViewer(pathValue, 'reopen-preview.html')
      ), htmlPath));
      viewer = preview.locator('.chat-file-viewer');
      await release();
      const body = viewer.locator('.chat-file-viewer-body');
      await expect(body).not.toHaveAttribute('aria-busy', 'true');
      await expect(body.locator('iframe')).toHaveCSS('visibility', 'visible');
      const action = viewer.locator('iframe').contentFrame().locator('#action');
      await expect(action).toHaveText('ready');
      await action.press('Enter');
      await expect(action).toHaveText('done');
      await orkas.closePreview(preview);
      await expect.poll(() => preview.isClosed()).toBe(true);
    } finally {
      await release();
    }
  });

  test('loads remote code, styles and APIs while keeping the host isolated', async ({ appPage, orkas }) => {
    const requests:string[]=[];
    const server=createServer((req,res)=>{
      requests.push(req.url || '/');res.setHeader('Access-Control-Allow-Origin','*');
      if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end('document.querySelector("output").textContent="remote loaded";');}
      else if(req.url==='/app.css'){res.setHeader('Content-Type','text/css');res.end('output{color:rgb(1,2,3)}');}
      else if(req.url==='/api'){res.setHeader('Content-Type','application/json');res.end('{"value":42}');}
      else {res.setHeader('Content-Type','text/html');res.end('<h1>External page</h1>');}
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try {
      const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const entry=orkas.createWorkspaceFile('online-preview.html',`<!doctype html><link rel="stylesheet" href="${base}/app.css"><output></output><script src="${base}/app.js"></script><a href="${base}/page">Open page</a>`);
      const preview=await orkas.openPreview(()=>appPage.evaluate(p=>{void (window as any).openChatFileViewer(p,'online-preview.html');},entry));
      const frame=preview.locator('.chat-file-viewer-html').contentFrame();
      await expect(frame.locator('output')).toHaveText('remote loaded');
      await expect(frame.locator('output')).toHaveCSS('color','rgb(1, 2, 3)');
      expect(await frame.locator('body').evaluate(async(_node,base)=>({api:await (await fetch(base+'/api')).json(),node:typeof (window as any).require,ipc:typeof (window as any).orkas}),base)).toEqual({api:{value:42},node:'undefined',ipc:'undefined'});
      await frame.getByRole('link',{name:'Open page'}).click();
      await expect(frame.getByRole('heading')).toHaveText('External page');
      expect(requests).toEqual(expect.arrayContaining(['/app.js','/app.css','/api','/page']));
    }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
