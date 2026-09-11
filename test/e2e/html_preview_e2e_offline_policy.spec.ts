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

test.describe('local HTML offline preview', () => {
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
    await appPage.evaluate((pathValue) => {
      void (window as any).openChatFileViewer(pathValue, 'blocking-resource-preview.html');
    }, htmlPath);

    const body = appPage.locator('.chat-file-viewer-body');
    await expect(body).not.toHaveAttribute('aria-busy', 'true', { timeout: 5_000 });
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(5_000);
    const frame = appPage.locator('.chat-file-viewer-html');
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
      await appPage.evaluate((pathValue) => (
        (window as any).openChatFileViewer(pathValue, 'loading-preview.html')
      ), htmlPath);

      const viewer = appPage.locator('.chat-file-viewer');
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
      await appPage.evaluate((pathValue) => (
        (window as any).openChatFileViewer(pathValue, 'reopen-preview.html')
      ), htmlPath);
      await expect.poll(() => orkas.electronApp!.evaluate(() => (
        (globalThis as any).__htmlResponseGate.requested
      ))).toBe(true);
      const viewer = appPage.locator('.chat-file-viewer');
      await viewer.locator('.chat-file-viewer-close').click();
      await expect(viewer).toBeHidden();
      await expect(viewer.locator('iframe')).toHaveCount(0);

      // Reopen while the old response is still held, then let that stale
      // response finish. It must not dismiss or overwrite the new preview.
      await appPage.evaluate((pathValue) => (
        (window as any).openChatFileViewer(pathValue, 'reopen-preview.html')
      ), htmlPath);
      await release();
      const body = viewer.locator('.chat-file-viewer-body');
      await expect(body).not.toHaveAttribute('aria-busy', 'true');
      await expect(body.locator('iframe')).toHaveCSS('visibility', 'visible');
      const action = viewer.locator('iframe').contentFrame().locator('#action');
      await expect(action).toHaveText('ready');
      await action.press('Enter');
      await expect(action).toHaveText('done');
      await viewer.locator('.chat-file-viewer-close').click();
      await expect(viewer).toBeHidden();
      await expect(viewer.locator('iframe')).toHaveCount(0);
    } finally {
      await release();
    }
  });

  test('runs self-contained code while blocking remote code, assets, connections, and navigation', async ({
    appPage,
    orkas,
  }) => {
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url || '/');
      if (request.url?.startsWith('/external.js')) {
        response.writeHead(200, { 'Content-Type': 'text/javascript' });
        response.end('window.__offlinePreviewEvidence.externalScriptRan = true;');
        return;
      }
      if (request.url?.startsWith('/pixel.png')) {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(PNG_1X1);
        return;
      }
      if (request.url?.startsWith('/external.css')) {
        response.writeHead(200, { 'Content-Type': 'text/css' });
        response.end('#inline-result { color: rgb(1, 2, 3); }');
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>remote</title>');
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address() as AddressInfo;
      const remoteBase = `http://127.0.0.1:${address.port}`;
      const localImagePath = path.join(orkas.userWorkspaceRoot, 'offline-preview-local.png');
      const htmlPath = path.join(orkas.userWorkspaceRoot, 'offline-preview.html');
      const localImageUrl = chatMediaLocalUrl(localImagePath);

      writeFileSync(localImagePath, PNG_1X1);
      writeFileSync(htmlPath, `<!doctype html>
<html>
<body>
  <script>
    window.__offlinePreviewEvidence = {
      inlineRan: false,
      dataImageLoaded: false,
      localImageLoaded: false,
      externalScriptRan: false,
      fetchRejected: false,
      navigationAttempted: false,
      violations: [],
    };
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__offlinePreviewEvidence.violations.push(event.effectiveDirective);
    });
  </script>
  <link rel="stylesheet" href="${remoteBase}/external.css?private=value">
  <link rel="preload" as="font" href="${remoteBase}/external.woff2?private=value">
  <div id="inline-result">pending</div>
  <img id="data-image"
       src="data:image/png;base64,${PNG_1X1.toString('base64')}"
       onload="window.__offlinePreviewEvidence.dataImageLoaded = true">
  <img id="local-image"
       src="${localImageUrl}"
       onload="window.__offlinePreviewEvidence.localImageLoaded = true">
  <script>
    window.__offlinePreviewEvidence.inlineRan = true;
    document.getElementById('inline-result').textContent = 'inline-ok';
    fetch('${remoteBase}/connect?private=value').catch(() => {
      window.__offlinePreviewEvidence.fetchRejected = true;
    });
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '${remoteBase}/xhr?private=value');
    xhr.send();
    try {
      new WebSocket('${remoteBase.replace('http:', 'ws:')}/socket?private=value');
    } catch {}
    navigator.sendBeacon('${remoteBase}/beacon?private=value', 'private=value');
    setTimeout(() => {
      window.__offlinePreviewEvidence.navigationAttempted = true;
      window.location.href = '${remoteBase}/navigate?private=value';
    }, 100);
  </script>
  <script src="${remoteBase}/external.js?private=value"></script>
  <img src="${remoteBase}/pixel.png?private=value">
  <video autoplay src="${remoteBase}/external.mp4?private=value"></video>
  <iframe src="${remoteBase}/nested?private=value"></iframe>
</body>
</html>`);

      await appPage.evaluate((pathValue) => {
        void (window as any).openChatFileViewer(pathValue, 'offline-preview.html');
      }, htmlPath);

      const previewElement = appPage.locator('.chat-file-viewer-html');
      await expect(previewElement).toBeVisible();
      const previewSrc = await previewElement.getAttribute('src');
      await expect.poll(() => appPage.frames().some((frame) => frame.url() === previewSrc)).toBe(true);
      const previewFrame = appPage.frames().find((frame) => frame.url() === previewSrc);
      if (!previewFrame) throw new Error('Local HTML preview frame did not load');

      await expect.poll(async () => previewFrame.evaluate(() => {
        const evidence = (window as any).__offlinePreviewEvidence;
        return evidence ? {
          inlineRan: evidence.inlineRan,
          dataImageLoaded: evidence.dataImageLoaded,
          localImageLoaded: evidence.localImageLoaded,
          externalScriptRan: evidence.externalScriptRan,
          fetchRejected: evidence.fetchRejected,
          navigationAttempted: evidence.navigationAttempted,
          violations: Array.from(new Set(evidence.violations)).sort(),
          inlineText: document.getElementById('inline-result')?.textContent || '',
        } : null;
      })).toMatchObject({
        inlineRan: true,
        dataImageLoaded: true,
        localImageLoaded: true,
        externalScriptRan: false,
        fetchRejected: true,
        navigationAttempted: true,
        inlineText: 'inline-ok',
      });

      const evidence = await previewFrame.evaluate(() => (window as any).__offlinePreviewEvidence);
      expect(evidence.violations).toEqual(expect.arrayContaining([
        'connect-src',
        'font-src',
        'frame-src',
        'img-src',
        'media-src',
        'script-src-elem',
        'style-src-elem',
      ]));
      expect(previewFrame.url()).toMatch(/^chat-media:\/\/local\//);
      expect(requests).toEqual([]);
    } finally {
      if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
