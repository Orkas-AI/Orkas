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
