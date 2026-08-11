import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { chatMediaLocalUrl } from '../../src/main/util/chat-media-url';
import { expect, test } from './fixtures/orkas';

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

test.describe('local HTML offline preview', () => {
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
      const previewUrl = chatMediaLocalUrl(htmlPath);

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

      await appPage.evaluate((url) => {
        const frame = document.createElement('iframe');
        frame.id = 'offline-preview-policy-test';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.src = url;
        document.body.appendChild(frame);
      }, previewUrl);

      await expect.poll(() => (
        appPage.frames().some((frame) => frame.url() === previewUrl)
      )).toBe(true);
      const previewFrame = appPage.frames().find((frame) => frame.url() === previewUrl);
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
      expect(previewFrame.url()).toBe(previewUrl);
      expect(requests).toEqual([]);
    } finally {
      if ('closeAllConnections' in server && typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
