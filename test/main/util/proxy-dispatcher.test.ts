import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import {
  _resetProxyRoutingForTests,
  activeProxy,
  buildChildProxyEnvironment,
  buildNoProxy,
  createSystemProxyFetch,
  envProxyConfig,
  envProxyUrl,
  installEnvProxyDispatcher,
  installSystemProxyDispatcher,
  parseResolvedProxyRoute,
  resolveProxyRouteForUrl,
  startChildFetchBridge,
} from '../../../src/main/util/proxy-dispatcher';

const hostFetch = globalThis.fetch;
const proxyEnvKeys = [
  'HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy',
  'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy',
] as const;
let savedEnv: Partial<Record<(typeof proxyEnvKeys)[number], string | undefined>> = {};
let savedNoAutoProxy: string | undefined;

function clearProxyEnv(): void {
  for (const key of proxyEnvKeys) delete process.env[key];
}

beforeEach(() => {
  _resetProxyRoutingForTests();
  globalThis.fetch = hostFetch;
  savedEnv = Object.fromEntries(proxyEnvKeys.map((key) => [key, process.env[key]]));
  savedNoAutoProxy = process.env.ORKAS_NO_AUTO_PROXY;
  clearProxyEnv();
  delete process.env.ORKAS_NO_AUTO_PROXY;
});

afterEach(() => {
  globalThis.fetch = hostFetch;
  _resetProxyRoutingForTests();
  clearProxyEnv();
  for (const key of proxyEnvKeys) {
    const value = savedEnv[key];
    if (value !== undefined) process.env[key] = value;
  }
  if (savedNoAutoProxy === undefined) delete process.env.ORKAS_NO_AUTO_PROXY;
  else process.env.ORKAS_NO_AUTO_PROXY = savedNoAutoProxy;
});

describe('util/proxy-dispatcher environment configuration', () => {
  it('returns no proxy when the environment is empty', () => {
    expect(envProxyConfig({})).toMatchObject({ httpProxy: undefined, httpsProxy: undefined });
    expect(envProxyUrl({})).toBeUndefined();
  });

  it('preserves distinct HTTP and HTTPS proxies', () => {
    expect(envProxyConfig({
      HTTP_PROXY: 'http://http-proxy:8080',
      HTTPS_PROXY: 'http://https-proxy:8443',
      ALL_PROXY: 'socks5://fallback:1080',
    })).toMatchObject({
      httpProxy: 'http://http-proxy:8080',
      httpsProxy: 'http://https-proxy:8443',
    });
  });

  it('uses HTTP_PROXY for HTTPS when HTTPS_PROXY is absent', () => {
    expect(envProxyConfig({ HTTP_PROXY: 'http://proxy:8080' })).toMatchObject({
      httpProxy: 'http://proxy:8080',
      httpsProxy: 'http://proxy:8080',
    });
  });

  it('uses ALL_PROXY as the final fallback and supports lowercase variables', () => {
    expect(envProxyConfig({ all_proxy: 'socks5://proxy:1080' })).toMatchObject({
      httpProxy: 'socks5://proxy:1080',
      httpsProxy: 'socks5://proxy:1080',
    });
    expect(envProxyUrl({ https_proxy: 'http://low:7890' })).toBe('http://low:7890');
  });
});

describe('util/proxy-dispatcher buildNoProxy', () => {
  it('always includes loopback bypasses', () => {
    expect(buildNoProxy({}).split(','))
      .toEqual(expect.arrayContaining(['localhost', '127.0.0.1', '::1', '*.local']));
  });

  it('merges caller NO_PROXY and dedupes', () => {
    const out = buildNoProxy({ NO_PROXY: 'example.com, localhost , 10.0.0.1' }).split(',');
    expect(out).toContain('example.com');
    expect(out).toContain('10.0.0.1');
    expect(out.filter((host) => host === 'localhost')).toHaveLength(1);
  });
});

describe('util/proxy-dispatcher child routes', () => {
  it('parses DIRECT, HTTP(S), and SOCKS5 decisions', () => {
    expect(parseResolvedProxyRoute('DIRECT')).toEqual({ kind: 'direct' });
    expect(parseResolvedProxyRoute('PROXY 127.0.0.1:7890; DIRECT'))
      .toEqual({ kind: 'proxy', url: 'http://127.0.0.1:7890' });
    expect(parseResolvedProxyRoute('HTTPS proxy.example:443'))
      .toEqual({ kind: 'proxy', url: 'https://proxy.example:443' });
    expect(parseResolvedProxyRoute('SOCKS5 127.0.0.1:1080'))
      .toEqual({ kind: 'proxy', url: 'socks5h://127.0.0.1:1080' });
    expect(parseResolvedProxyRoute('SOCKS4 127.0.0.1:1080')).toMatchObject({ kind: 'unsupported' });
  });

  it('covers system VPN decisions for DIRECT, HTTP, and SOCKS-only routes', async () => {
    const target = 'https://bucket.cos.ap-test.myqcloud.com/';
    await expect(resolveProxyRouteForUrl(target, async () => 'DIRECT'))
      .resolves.toEqual({ kind: 'direct' });
    await expect(resolveProxyRouteForUrl(target, async () => 'PROXY 127.0.0.1:7890; DIRECT'))
      .resolves.toEqual({ kind: 'proxy', url: 'http://127.0.0.1:7890' });
    await expect(resolveProxyRouteForUrl(target, async () => 'SOCKS5 127.0.0.1:1080; DIRECT'))
      .resolves.toEqual({ kind: 'proxy', url: 'socks5h://127.0.0.1:1080' });
  });

  it('uses a per-request Electron bridge when the known child target needs a proxy', async () => {
    const bridge = vi.fn(async () => ({
      url: 'http://127.0.0.1:45678/v1/fetch',
      token: 'test-token',
    }));
    await expect(buildChildProxyEnvironment(
      'https://api.example.com',
      bridge,
      async () => 'PROXY 127.0.0.1:7890',
    ))
      .resolves.toEqual({
        ORKAS_PROXY_MODE: 'system-fetch',
        ORKAS_PROXY_BRIDGE_URL: 'http://127.0.0.1:45678/v1/fetch',
        ORKAS_PROXY_BRIDGE_TOKEN: 'test-token',
      });
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('uses the Electron bridge for an app-owned child under SOCKS-only VPN', async () => {
    const bridge = vi.fn(async () => ({
      url: 'http://127.0.0.1:45678/v1/fetch',
      token: 'test-token',
    }));
    await expect(buildChildProxyEnvironment(
      'https://api.example.com',
      bridge,
      async () => 'SOCKS5 127.0.0.1:1080; DIRECT',
    )).resolves.toMatchObject({
      ORKAS_PROXY_MODE: 'system-fetch',
      ORKAS_PROXY_BRIDGE_URL: 'http://127.0.0.1:45678/v1/fetch',
    });
    expect(bridge).toHaveBeenCalledOnce();
  });

  it('leaves a DIRECT child target on its original fetch stack', async () => {
    const bridge = vi.fn(async () => ({ url: 'http://unused', token: 'unused' }));
    await expect(buildChildProxyEnvironment(
      'https://direct.example.com',
      bridge,
      async () => 'DIRECT',
    )).resolves.toEqual({ ORKAS_PROXY_MODE: 'direct' });
    expect(bridge).not.toHaveBeenCalled();
  });

  it('propagates separate explicit environment routes without consulting PAC', async () => {
    process.env.HTTP_PROXY = 'http://http-proxy:8080';
    process.env.HTTPS_PROXY = 'http://https-proxy:8443';
    const bridge = vi.fn(async () => ({ url: 'http://unused', token: 'unused' }));
    const childEnv = await buildChildProxyEnvironment('https://api.example.com', bridge);
    expect(childEnv).toMatchObject({
      ORKAS_PROXY_MODE: 'env',
      HTTP_PROXY: 'http://http-proxy:8080',
      HTTPS_PROXY: 'http://https-proxy:8443',
      NODE_USE_ENV_PROXY: '1',
    });
    expect(bridge).not.toHaveBeenCalled();
  });
});

describe('util/proxy-dispatcher child fetch bridge', () => {
  it('streams each actual URL through the supplied Electron fetch implementation', async () => {
    const system = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = init?.body ? await new Response(init.body).text() : '';
      return new Response(`${String(input)}|${body}`, {
        status: 201,
        headers: { 'x-upstream': 'electron' },
      });
    }) as unknown as typeof fetch;
    const bridge = await startChildFetchBridge(system);
    // Requiring the bootstrap is side-effect free while ORKAS_PROXY_MODE is unset.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createBridgeFetch } = require('../../../bin/proxy-bootstrap.cjs') as {
      createBridgeFetch: (native: typeof fetch, url: string, token: string) => typeof fetch;
    };
    const childFetch = createBridgeFetch(hostFetch, bridge.url, bridge.token);

    try {
      const direct = await childFetch('https://direct.example/path');
      const proxied = await childFetch('https://proxy.example/upload', {
        method: 'POST',
        headers: { authorization: 'Bearer test' },
        body: 'stream-me',
      });
      expect(await direct.text()).toBe('https://direct.example/path|');
      expect(proxied.status).toBe(201);
      expect(proxied.headers.get('x-upstream')).toBe('electron');
      expect(await proxied.text()).toBe('https://proxy.example/upload|stream-me');
      expect(system).toHaveBeenCalledTimes(2);
      expect(system.mock.calls[1]?.[1]?.headers).toContainEqual(['authorization', 'Bearer test']);
    } finally {
      await bridge.close();
    }
  });

  it('cancels the Electron response stream when the child stops reading', async () => {
    let upstreamCancelled = false;
    const system = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first-chunk'));
      },
      cancel() {
        upstreamCancelled = true;
      },
    }))) as unknown as typeof fetch;
    const bridge = await startChildFetchBridge(system);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createBridgeFetch } = require('../../../bin/proxy-bootstrap.cjs') as {
      createBridgeFetch: (native: typeof fetch, url: string, token: string) => typeof fetch;
    };

    try {
      const response = await createBridgeFetch(hostFetch, bridge.url, bridge.token)(
        'https://proxy.example/stream',
      );
      const reader = response.body?.getReader();
      expect((await reader?.read())?.done).toBe(false);
      await reader?.cancel();
      await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
    } finally {
      await bridge.close();
    }
  });
});

describe('util/proxy-dispatcher per-request system routing', () => {
  it('keeps DIRECT on Node, sends proxy/error routes to Electron, and caches per origin', async () => {
    const fallback = vi.fn(async () => new Response('fallback')) as unknown as typeof fetch;
    const system = vi.fn(async () => new Response('system')) as unknown as typeof fetch;
    const resolveProxy = vi.fn(async (url: string) => {
      const host = new URL(url).hostname;
      if (host === 'direct.example') return 'DIRECT';
      if (host === 'broken.example') throw new Error('proxy service unavailable');
      if (host === 'socks.example') return 'SOCKS5 127.0.0.1:1080; DIRECT';
      return 'PROXY 127.0.0.1:7890; DIRECT';
    });
    const routed = createSystemProxyFetch(fallback, system, resolveProxy, 10_000);

    await expect((await routed('https://direct.example/one')).text()).resolves.toBe('fallback');
    await expect((await routed('https://direct.example/two')).text()).resolves.toBe('fallback');
    await expect((await routed(new URL('http://proxy.example/path'))).text()).resolves.toBe('system');
    await expect((await routed('https://socks.example/path')).text()).resolves.toBe('system');
    await expect((await routed('https://broken.example/path')).text()).resolves.toBe('system');
    await expect((await routed('data:,ok')).text()).resolves.toBe('fallback');

    expect(system).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledTimes(3);
    expect(resolveProxy).toHaveBeenCalledTimes(4);
  });

  it('refreshes the route after the short cache window', async () => {
    const fallback = vi.fn(async () => new Response('fallback')) as unknown as typeof fetch;
    const system = vi.fn(async () => new Response('system')) as unknown as typeof fetch;
    const resolveProxy = vi.fn()
      .mockResolvedValueOnce('DIRECT')
      .mockResolvedValueOnce('PROXY 127.0.0.1:7890');
    const routed = createSystemProxyFetch(fallback, system, resolveProxy, 0);

    expect(await (await routed('https://changing.example/one')).text()).toBe('fallback');
    expect(await (await routed('https://changing.example/two')).text()).toBe('system');
    expect(resolveProxy).toHaveBeenCalledTimes(2);
  });

  it('keeps a diagnostic-style outer wrapper intact when phase 2 changes the delegate', async () => {
    const fallback = vi.fn(async () => new Response('fallback')) as unknown as typeof fetch;
    const system = vi.fn(async () => new Response('system')) as unknown as typeof fetch;
    globalThis.fetch = fallback;

    expect(await installEnvProxyDispatcher()).toBe(false);
    const stableRouter = globalThis.fetch;
    const outer = vi.fn((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => (
      stableRouter(input, init)
    )) as unknown as typeof fetch;
    globalThis.fetch = outer;

    expect(await installSystemProxyDispatcher(system, async () => 'PROXY 127.0.0.1:7890')).toBe(true);
    expect(await (await globalThis.fetch('https://chatgpt.com/backend-api')).text()).toBe('system');
    expect(outer).toHaveBeenCalledOnce();
    expect(system).toHaveBeenCalledOnce();
    expect(activeProxy()).toBe('system:per-request');
  });

  it('honors the auto-system-proxy kill switch', async () => {
    const system = vi.fn(async () => new Response('system')) as unknown as typeof fetch;
    process.env.ORKAS_NO_AUTO_PROXY = '1';
    expect(await installSystemProxyDispatcher(system)).toBe(false);
    expect(system).not.toHaveBeenCalled();
  });
});
