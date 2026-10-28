import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  _resetProxyRoutingForTests,
  activeProxy,
  buildChildProxyEnvironment,
  buildNoProxy,
  createSystemProxyBinaryFetch,
  createSystemProxyFetch,
  downloadBinaryWithProxyPolicy,
  fetchUploadWithProxyPolicy,
  envProxyConfig,
  envProxyAppliesToUrl,
  envProxyUrl,
  installEnvProxyDispatcher,
  installSystemProxyDispatcher,
  normalizeElectronNetFetchError,
  parseResolvedProxyRoute,
  resolveProxyRouteForUrl,
  startChildFetchBridge,
} from '../../../src/main/util/proxy-dispatcher';
import { classifyTransientNetworkError } from '../../../src/core-agent/src/shared/errors';


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

describe('Electron system-proxy transport failures', () => {
  it('survives a truncated response with excessive content encodings and can download again', async () => {
    // GHSA-xjj6-f33q-929c kills the process even when fetch rejection is caught.
    // Exercise the real address-checked download route in an isolated process.
    const script = String.raw`
      require('tsx/cjs');
      const { createServer } = require('node:net');
      const { downloadBinaryWithProxyPolicy } = require('./src/main/util/proxy-dispatcher.ts');
      let requests = 0;
      const server = createServer(socket => socket.once('data', () => {
        requests++;
        socket.end(requests === 1
          ? 'HTTP/1.1 200 OK\r\nContent-Encoding: gzip,gzip,gzip,gzip,gzip,gzip\r\nContent-Length: 100\r\nConnection: close\r\n\r\n'
          : 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
      }));
      server.listen(0, '127.0.0.1', async () => {
        const url = 'http://127.0.0.1:' + server.address().port;
        const options = { label: 'encoding-regression', isAllowedDirectAddress: ip => ip === '127.0.0.1', signal: AbortSignal.timeout(3000), retries: 0 };
        try {
          let rejected = false;
          try { await downloadBinaryWithProxyPolicy(url, options); } catch { rejected = true; }
          if (!rejected) throw new Error('Malformed response was accepted');
          const result = await downloadBinaryWithProxyPolicy(url, options);
          if (result.body.toString() !== 'ok' || requests !== 2) throw new Error('Recovery failed');
          process.stdout.write('rejected-and-recovered');
        } catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
        finally { server.close(); }
      });
    `;
    const result = await promisify(execFile)(process.execPath, ['-e', script], {
      cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10000,
    });
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('rejected-and-recovered');
  });

  it('uploads through the configured environment proxy with byte progress and no system-route lookup', async () => {
    const {getGlobalDispatcher, setGlobalDispatcher} = await import('undici');
    const original = getGlobalDispatcher();
    let received = '', tunnels = 0;
    const server = createServer((request, response) => {
      request.setEncoding('utf8'); request.on('data', chunk => { received += chunk; });
      request.on('end', () => response.end('ok'));
    });
    const proxy = createServer();
    const listen = (value: ReturnType<typeof createServer>) => new Promise<number>(resolve => {
      value.listen(0, '127.0.0.1', () => resolve((value.address() as import('node:net').AddressInfo).port));
    });
    const port = await listen(server);
    proxy.on('connect', (_request, socket, head) => {
      tunnels++;
      const upstream = connect(port, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if(head.length)upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      socket.on('close', () => upstream.destroy()); upstream.on('error', () => socket.destroy());
    });
    const proxyPort = await listen(proxy), progress: number[] = [];
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`;
    const resolveSystem = vi.fn(async () => 'PROXY unused:8080');
    const body = 'x'.repeat(64 * 1024);
    try {
      expect(await installEnvProxyDispatcher()).toBe(true);
      expect(await installSystemProxyDispatcher(vi.fn(), resolveSystem)).toBe(false);
      const result = await fetchUploadWithProxyPolicy('http://upload.invalid/chunk', {
        method: 'POST', body, signal: AbortSignal.timeout(3000),
      }, sent => progress.push(sent));
      expect(await result.text()).toBe('ok'); expect(received).toBe(body);
      expect(progress.some(sent => sent > 0 && sent < body.length)).toBe(true);
      expect(progress.at(-1)).toBe(body.length);
      expect(tunnels).toBe(1); expect(resolveSystem).not.toHaveBeenCalled();
    } finally {
      const current = getGlobalDispatcher(); setGlobalDispatcher(original); await current.destroy();
      server.closeAllConnections();
      await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
    }
  });
  it.each(['success', 'abort', 'error'] as const)('tracks Chromium upload bytes and disposes polling on %s without a direct fallback', async outcome => {
    vi.useFakeTimers();
    const request = Object.assign(new EventEmitter(), {
      getUploadProgress: vi.fn(() => ({active: true, started: true, current: 4, total: 8})),
      setHeader: vi.fn(), end: vi.fn(), abort: vi.fn(),
    });
    const netRequest = vi.fn(() => request);
    vi.doMock('electron', () => ({net: {request: netRequest}, session: {defaultSession: {}}}));
    const progress = vi.fn(), controller = new AbortController();
    let work: Promise<unknown> | undefined;
    try {
      await installSystemProxyDispatcher(vi.fn(), async () => 'SOCKS5 proxy.example:1080');
      work = fetchUploadWithProxyPolicy('https://upload.example/chunk', {
        method: 'POST', body: '12345678', headers: {user_id: 'test', session_id: 'test-session'}, signal: controller.signal,
      }, progress).then(response => response.text(), error => error.message);
      await vi.waitFor(() => expect(request.end).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(100);
      expect(progress).toHaveBeenCalledWith(4, 8);
      expect(request.end).toHaveBeenCalledWith(Buffer.from('12345678'));
      expect(request.setHeader).toHaveBeenCalledWith('session_id', 'test-session');
      if (outcome === 'success') {
        const response = Object.assign(new EventEmitter(), {statusCode: 200, headers: {'Content-Type': ['application/json']}});
        request.emit('response', response); response.emit('data', Buffer.from('ok')); response.emit('end');
        expect(await work).toBe('ok');
      } else if (outcome === 'abort') {
        controller.abort(new Error('cancelled'));
        expect(await work).toBe('cancelled'); expect(request.abort).toHaveBeenCalledOnce();
      } else {
        request.emit('error', new Error('proxy unavailable'));
        expect(await work).toBe('proxy unavailable');
      }
      const count = progress.mock.calls.length;
      await vi.advanceTimersByTimeAsync(500);
      expect(progress).toHaveBeenCalledTimes(count);
      expect(vi.getTimerCount()).toBe(0);
      expect(netRequest).toHaveBeenCalledOnce();
    } finally { controller.abort(); await work; vi.useRealTimers(); vi.doUnmock('electron'); }
  });
  it('keeps a message-only Chromium proxy failure in the network exhaustion category', () => {
    const rejection = new Error('net::ERR_PROXY_CONNECTION_FAILED');
    expect(classifyTransientNetworkError(rejection)).toBeNull();

    const normalized = normalizeElectronNetFetchError(rejection);
    expect(normalized).toMatchObject({ code: 'ENETUNREACH', cause: rejection });
    expect(classifyTransientNetworkError(normalized)).toBe('network');
  });

  it('leaves structured failures, aborts, and similar prose untouched', () => {
    const structured = Object.assign(new Error('net::ERR_PROXY_CONNECTION_FAILED'), { code: 'ETIMEDOUT' });
    const aborted = Object.assign(new Error('net::ERR_PROXY_CONNECTION_FAILED'), { name: 'AbortError' });
    const prose = new Error('request failed: net::ERR_PROXY_CONNECTION_FAILED');
    expect(normalizeElectronNetFetchError(structured)).toBe(structured);
    expect(normalizeElectronNetFetchError(aborted)).toBe(aborted);
    expect(normalizeElectronNetFetchError(prose)).toBe(prose);
  });
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

  it('matches environment proxy and NO_PROXY host/port selection', () => {
    const config = envProxyConfig({
      HTTPS_PROXY: 'http://proxy.example:8080',
      NO_PROXY: 'direct.example,.internal.example,port.example:8443',
    });
    expect(envProxyAppliesToUrl(new URL('https://cdn.example/file'), config)).toBe(true);
    expect(envProxyAppliesToUrl(new URL('https://direct.example/file'), config)).toBe(false);
    expect(envProxyAppliesToUrl(new URL('https://a.internal.example/file'), config)).toBe(false);
    expect(envProxyAppliesToUrl(new URL('https://port.example:8443/file'), config)).toBe(false);
    expect(envProxyAppliesToUrl(new URL('https://port.example/file'), config)).toBe(true);
  });

  it.each([
    { NO_PROXY: '*' },
    { no_proxy: '*' },
    { NO_PROXY: 'direct.example' },
  ])('preserves an explicit direct route through the actual environment dispatcher: %j', async (bypass) => {
    const { EnvHttpProxyAgent, request } = await import('undici');
    let directRequests = 0;
    let proxyRequests = 0;
    const direct = createServer((_req, res) => {
      directRequests += 1;
      res.end('direct response');
    });
    const proxy = createServer();
    proxy.on('connect', (_req, socket) => {
      proxyRequests += 1;
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    });
    const listen = (server: ReturnType<typeof createServer>) => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as import('node:net').AddressInfo).port));
    });
    const directPort = await listen(direct);
    const proxyPort = await listen(proxy);
    const config = envProxyConfig({ HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, ...bypass });
    const dispatcher = new EnvHttpProxyAgent({
      ...config,
      connect: { lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
        else callback(null, '127.0.0.1', 4);
      } },
    });
    const url = new URL(`http://direct.example:${directPort}/probe`);
    try {
      const result = await request(url, { dispatcher, signal: AbortSignal.timeout(2_000) })
        .then(response => response.body.text(), error => `transport failure: ${error.code}`);
      expect({ result, directRequests, proxyRequests }).toEqual({
        result: 'direct response', directRequests: 1, proxyRequests: 0,
      });
      expect(envProxyAppliesToUrl(url, config)).toBe(false);
    } finally {
      await dispatcher.destroy();
      await Promise.all([direct, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    }
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

  it.each([' * ', 'direct.example,*'])('preserves all-hosts bypass in child fetch configuration: %s', async (noProxy) => {
    process.env.HTTP_PROXY = 'http://proxy.example:8080';
    process.env.NO_PROXY = noProxy;
    const bridge = vi.fn();
    const resolve = vi.fn();
    expect(await buildChildProxyEnvironment('https://api.example.com', bridge, resolve)).toMatchObject({
      NO_PROXY: '*', ORKAS_PROXY_NO_PROXY: '*', ORKAS_PROXY_MODE: 'env',
    });
    expect(bridge).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
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

  it('keeps native bridge response bodies readable across settled garbage collection', async () => {
    const script = String.raw`
      const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
      const {createRequire}=require('node:module');
      const root=fs.mkdtempSync(path.join(os.tmpdir(),'orkas-proxy-body-review-'));
      process.env.ORKAS_WORKSPACE_ROOT=root;
      const req=createRequire(path.resolve('package.json'));
      req('tsx/cjs');
      const logger=path.resolve('src/main/logger.ts');
      require.cache[logger]={exports:{createLogger:()=>({debug(){},info(){},warn(){},error(){}})}};
      const {startChildFetchBridge}=require(path.resolve('src/main/util/proxy-dispatcher.ts'));
      const {createBridgeFetch}=req('./bin/proxy-bootstrap.cjs');
      (async()=>{
       const bridge=await startChildFetchBridge(async(input,init)=>new Response(String(input)+'|'+(init?.body?await new Response(init.body).text():'')));
       try{
        const fetchChild=createBridgeFetch(globalThis.fetch,bridge.url,bridge.token);
        for(let i=0;i<20;i++){
         const direct=await fetchChild('https://direct.example/path');
         await new Promise(resolve=>setImmediate(resolve));if(global.gc)global.gc();await new Promise(resolve=>setImmediate(resolve));
         const proxied=await fetchChild('https://proxy.example/upload',{method:'POST',body:'stream-me'});
         await new Promise(resolve=>setImmediate(resolve));if(global.gc)global.gc();await new Promise(resolve=>setImmediate(resolve));
         assert.equal(await direct.text(),'https://direct.example/path|');
         assert.equal(await proxied.text(),'https://proxy.example/upload|stream-me');
        }
        console.log(JSON.stringify({iterations:20,requests:40,forced_gc:!!global.gc,body_reuse_failure:false}));
       }finally{await bridge.close();fs.rmSync(root,{recursive:true,force:true});}
      })().catch(error=>{console.error(error);process.exitCode=1;});
    `;
    const result = await promisify(execFile)(process.execPath, ['--expose-gc', '-e', script], {
      cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 15000, maxBuffer: 16 * 1024,
    });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ iterations: 20, requests: 40, forced_gc: true, body_reuse_failure: false });
  });

  it('preserves a bodyless bridge response and propagates a source stream failure', async () => {
    const { createBridgeFetch } = require('../../../bin/proxy-bootstrap.cjs');
    const meta = (status: number) => ({ 'x-orkas-fetch-meta': Buffer.from(JSON.stringify({
      status, statusText: '', headers: [['x-upstream', 'fixture']],
    })).toString('base64url') });
    const emptyFetch = createBridgeFetch(async () => new Response(null, { headers: meta(204) }), 'http://localhost/bridge', 'fixture');
    const empty = await emptyFetch('https://upstream.example');
    expect(empty.status).toBe(204);
    expect(empty.body).toBeNull();
    expect(empty.headers.get('x-upstream')).toBe('fixture');
    const failure = new Error('controlled upstream stream failure');
    const failedFetch = createBridgeFetch(async () => new Response(new ReadableStream({
      start(controller) { controller.error(failure); },
    }), { headers: meta(200) }), 'http://localhost/bridge', 'fixture');
    const failed = await failedFetch('https://upstream.example');
    await expect(failed.text()).rejects.toBe(failure);
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

  it('downloads proxied binary bodies without requiring response headers', async () => {
    const directBytes = Buffer.from('direct-bytes');
    const proxiedBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fallback = vi.fn(async () => ({ status: 200, body: directBytes }));
    // The raw system transport contract intentionally exposes no Headers
    // object. This is what keeps non-ByteString CDN metadata (for example a
    // Chinese lifecycle rule name) outside WHATWG header conversion.
    const system = vi.fn(async () => ({ status: 200, body: proxiedBytes }));
    const resolveProxy = vi.fn(async (url: string) => (
      new URL(url).hostname === 'direct.example'
        ? 'DIRECT'
        : 'PROXY 127.0.0.1:7890; DIRECT'
    ));
    const routed = createSystemProxyBinaryFetch(fallback, system, resolveProxy, 10_000);

    await expect(routed('https://direct.example/image.png')).resolves.toEqual({
      status: 200,
      body: directBytes,
    });
    const addressPolicy = vi.fn(() => false);
    const options = {
      headers: { Authorization: 'Bearer test' },
      maxBytes: 1024,
      redirect: 'error' as const,
      isAllowedDirectAddress: addressPolicy,
    };
    await expect(routed('https://cdn.example/image.png', options)).resolves.toEqual({
      status: 200,
      body: proxiedBytes,
    });

    expect(fallback).toHaveBeenCalledOnce();
    expect(system).toHaveBeenCalledOnce();
    expect(system).toHaveBeenCalledWith('https://cdn.example/image.png', options);
    expect(addressPolicy).not.toHaveBeenCalled();
    expect(resolveProxy).toHaveBeenCalledTimes(2);
  });

  it('checks the address selected by a direct connection before sending its GET', async () => {
    let requestCount = 0;
    const server = createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200).end('must not be requested');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    expect(address && typeof address !== 'string').toBe(true);
    const checked: string[] = [];
    try {
      await expect(downloadBinaryWithProxyPolicy(
        `http://localhost:${typeof address === 'string' || !address ? 0 : address.port}/private`,
        {
          label: 'direct address policy probe',
          retries: 0,
          isAllowedDirectAddress(candidate) {
            checked.push(candidate);
            return false;
          },
        },
      )).rejects.toThrow();
      expect(checked.length).toBeGreaterThan(0);
      expect(requestCount).toBe(0);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('leaves destination resolution to an explicitly configured environment proxy', async () => {
    const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
    const originalDispatcher = getGlobalDispatcher();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const addressPolicy = vi.fn(() => false);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    process.env.HTTP_PROXY = 'http://proxy.example:8080';
    process.env.HTTPS_PROXY = 'http://proxy.example:8080';
    try {
      expect(await installEnvProxyDispatcher()).toBe(true);
      await expect(downloadBinaryWithProxyPolicy('https://cdn.example/proxied.bin', {
        label: 'environment-proxy download',
        retries: 0,
        isAllowedDirectAddress: addressPolicy,
      })).resolves.toMatchObject({ status: 200, body: Buffer.from([1, 2, 3]) });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(addressPolicy).not.toHaveBeenCalled();

      let directRequestCount = 0;
      const directServer = createServer((_req, res) => {
        directRequestCount += 1;
        res.writeHead(200).end('must not be requested');
      });
      await new Promise<void>((resolve, reject) => {
        directServer.once('error', reject);
        directServer.listen(0, '127.0.0.1', () => resolve());
      });
      const directAddress = directServer.address();
      try {
        await expect(downloadBinaryWithProxyPolicy(
          `http://localhost:${typeof directAddress === 'string' || !directAddress ? 0 : directAddress.port}/private`,
          {
            label: 'environment NO_PROXY direct download',
            retries: 0,
            isAllowedDirectAddress: addressPolicy,
          },
        )).rejects.toThrow();
        expect(addressPolicy).toHaveBeenCalled();
        expect(directRequestCount).toBe(0);
        expect(fetchMock).toHaveBeenCalledOnce();
      } finally {
        await new Promise<void>(resolve => directServer.close(() => resolve()));
      }
    } finally {
      setGlobalDispatcher(originalDispatcher);
    }
  });

  it('retries only the idempotent binary GET for transient transport, status, and validation failures', async () => {
    const validBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('connection reset');
      if (attempts === 2) return new Response('temporarily unavailable', { status: 503 });
      if (attempts === 3) return new Response('<html>edge cache warming</html>', { status: 200 });
      return new Response(validBytes, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await downloadBinaryWithProxyPolicy('https://cdn.example/image.png', {
      label: 'generated image download',
      retries: 3,
      delaysMs: [0],
      validate: (body) => {
        if (!body.subarray(0, 4).equals(validBytes)) throw new Error('invalid image bytes');
      },
    });

    expect(result.body).toEqual(validBytes);
    expect(attempts).toBe(4);
  });

  it.each([404, 408, 409, 425, 429, 500, 502, 503, 504])(
    'retries a potentially transient HTTP %i and then returns valid bytes',
    async (status) => {
      const validBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response('not ready', { status }))
        .mockResolvedValueOnce(new Response(validBytes, { status: 200 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(downloadBinaryWithProxyPolicy('https://cdn.example/eventual.png', {
        label: 'generated image download',
        retries: 1,
        delaysMs: [0],
      })).resolves.toMatchObject({ status: 200, body: validBytes });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([400, 401, 403, 410, 422])(
    'does not retry a definite HTTP %i response',
    async (status) => {
      const fetchMock = vi.fn(async () => new Response('rejected', { status }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await expect(downloadBinaryWithProxyPolicy('https://cdn.example/rejected.png', {
        label: 'generated image download',
        retries: 2,
        delaysMs: [0],
      })).rejects.toThrow(`HTTP ${status}`);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('stops after the configured total number of attempts', async () => {
    const fetchMock = vi.fn(async () => new Response('busy', { status: 503 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(downloadBinaryWithProxyPolicy('https://cdn.example/busy.png', {
      label: 'generated image download',
      retries: 2,
      delaysMs: [0],
    })).rejects.toThrow('HTTP 503');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry or continue reading after the response exceeds its byte cap', async () => {
    let cancelled = false;
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      },
      cancel() { cancelled = true; },
    })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(downloadBinaryWithProxyPolicy('https://cdn.example/oversized.bin', {
      label: 'generated media download',
      retries: 2,
      delaysMs: [0],
      maxBytes: 3,
    })).rejects.toThrow('exceeds 3 bytes');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cancelled).toBe(true);
  });

  it('does not start a GET when cancellation is already known', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled before download'));
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(downloadBinaryWithProxyPolicy('https://cdn.example/cancelled.png', {
      label: 'generated image download',
      retries: 2,
      delaysMs: [0],
      signal: controller.signal,
    })).rejects.toThrow('cancelled before download');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves GET headers, redirect policy, byte cap, and signal across retries', async () => {
    const controller = new AbortController();
    const calls: RequestInit[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(init || {});
      return calls.length === 1
        ? new Response('no', { status: 503 })
        : new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(downloadBinaryWithProxyPolicy('https://cdn.example/authenticated.bin', {
      label: 'authenticated media download',
      retries: 1,
      delaysMs: [0],
      headers: { Authorization: 'Bearer test' },
      redirect: 'error',
      maxBytes: 3,
      signal: controller.signal,
    })).resolves.toMatchObject({ body: Buffer.from([1, 2, 3]) });

    expect(calls).toHaveLength(2);
    for (const init of calls) {
      expect(init).toMatchObject({
        method: 'GET',
        headers: { Authorization: 'Bearer test' },
        redirect: 'error',
        signal: controller.signal,
      });
    }
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

describe('util/proxy-dispatcher startup ordering', () => {
  it('installs system routing before opening the window without a hosted account bootstrap', () => {
    const source = fs.readFileSync(new URL('../../../src/main/index.ts', import.meta.url), 'utf8');
    expect(source).toContain('setFetchImplementation((input, init) => net.fetch');
    expect(source).not.toContain('const accountBoot = account.bootstrap();');
    expect(source.indexOf('await installSystemProxyDispatcher();')).toBeGreaterThan(0);
    expect(source.indexOf('await installSystemProxyDispatcher();')).toBeLessThan(source.lastIndexOf('    createWindow();'));
    expect(source).not.toContain("registerImmediate('net:system-proxy'");
  });
});
