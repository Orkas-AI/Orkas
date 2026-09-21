import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ElectronApplication } from '@playwright/test';

import { chatMediaLocalUrl } from '../../src/main/util/chat-media-url';
import { expect, test } from './fixtures/orkas';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

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
