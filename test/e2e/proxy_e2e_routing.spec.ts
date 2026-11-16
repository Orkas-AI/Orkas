import { createServer } from 'node:http';
import { expect, test } from '@playwright/test';
import { OrkasTestApp } from './fixtures/orkas';

test('main-process fetch follows the system proxy after normal app startup', async ({}, testInfo) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url || '');
    response.end('local proxy response');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy fixture has no port');
  const app = new OrkasTestApp(testInfo, { enableSystemProxy: true });
  try {
    await app.launch();
    const result = await app.electronApp!.evaluate(async ({ session }, port) => {
      await session.defaultSession.setProxy({ proxyRules: `http=127.0.0.1:${port}` });
      try {
        return await (await fetch('http://orkas-proxy-parity.invalid/probe', { signal: AbortSignal.timeout(5000) })).text();
      } catch { return 'proxy was bypassed'; }
    }, address.port);
    expect(result).toBe('local proxy response');
    expect(requests).toContain('http://orkas-proxy-parity.invalid/probe');
  } finally {
    await app.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// Use the real Chromium transport and a local proxy. No hosted API or provider
// is involved: the proxy independently observes the bytes and signed headers.
test('uploads a signed body once through Chromium without mutating caller headers', async ({}, testInfo) => {
  const uploads: Array<{ method: string; bytes: string; headers: Record<string, unknown> }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      uploads.push({ method: request.method || '', bytes: Buffer.concat(chunks).toString('base64'), headers: request.headers });
      response.writeHead(200, { 'content-type': 'text/plain' }).end('stored');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy fixture has no port');
  const app = new OrkasTestApp(testInfo, { enableSystemProxy: true });
  try {
    await app.launch();
    const result = await app.electronApp!.evaluate(async ({ session }, port) => {
      await session.defaultSession.setProxy({ proxyRules: `http=127.0.0.1:${port}` });
      const headers = { 'Content-Length': '4', 'Content-Type': 'image/png', 'Content-MD5': 'CNbBRYM/0e8Rz5ixn/PMlQ==', 'x-cos-acl': 'private' };
      const response = await fetch('http://orkas-proxy-parity.invalid/signed-upload', {
        method: 'PUT', headers, body: new Uint8Array([1, 2, 3, 4]), signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      return { status: response.status, text: await response.text(), length: headers['Content-Length'] };
    }, address.port);
    expect(result).toEqual({ status: 200, text: 'stored', length: '4' });
    expect(uploads).toEqual([expect.objectContaining({
      method: 'PUT', bytes: 'AQIDBA==', headers: expect.objectContaining({
        'content-length': '4', 'content-type': 'image/png', 'content-md5': 'CNbBRYM/0e8Rz5ixn/PMlQ==', 'x-cos-acl': 'private',
      }),
    })]);
  } finally {
    await app.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

// The server delays its receipt after accepting the complete body. A writable
// request close must not become a failed upload or cause a second submission.
test('keeps accepted upload receipts after Chromium closes its writable request', async ({}, testInfo) => {
  const uploads: Array<{ path: string; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(Buffer.from(chunk)));
    request.on('end', () => {
      uploads.push({ path: request.url || '', body: Buffer.concat(chunks).toString('utf8') });
      setTimeout(() => {
        response.writeHead(request.url?.endsWith('/conflict') ? 409 : 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ received: true }));
      }, 150);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Proxy fixture has no port');
  const app = new OrkasTestApp(testInfo, { enableSystemProxy: true, configuredModel: false });
  try {
    await app.launch();
    const results = await app.electronApp!.evaluate(async ({ session }, input) => {
      const require = (process as any).mainModule.require.bind((process as any).mainModule);
      const transport = require(`${input.root}/src/main/util/proxy-dispatcher.ts`);
      await session.defaultSession.setProxy({ proxyRules: `http=127.0.0.1:${input.port}` });
      await transport.installSystemProxyDispatcher();
      const rows = [];
      for (const name of ['success', 'conflict']) {
        const response = await transport.fetchUploadWithProxyPolicy(`http://orkas-proxy-receipt.invalid/${name}`, {
          method: 'POST', body: JSON.stringify({ operation: name }), signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json' },
        }, () => {});
        rows.push({ status: response.status, body: await response.json() });
      }
      return rows;
    }, { root: process.cwd(), port: address.port });
    expect(results).toEqual([{ status: 200, body: { received: true } }, { status: 409, body: { received: true } }]);
    expect(uploads).toEqual(['success', 'conflict'].map(name => ({
      path: `http://orkas-proxy-receipt.invalid/${name}`, body: JSON.stringify({ operation: name }),
    })));
    expect(app.modelRequests).toHaveLength(0);
  } finally {
    await app.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
