/**
 * proxy-dispatcher — make main-process HTTP(S) follow the user's proxy policy.
 *
 * Electron has two unrelated fetch stacks:
 *   - `net.fetch`, backed by Chromium. It evaluates the OS proxy policy for
 *     every request, including PAC, per-host DIRECT rules, proxy auth, and
 *     runtime VPN/proxy changes.
 *   - Node's global `fetch`, backed by undici. pi-ai/core-agent and several
 *     SDKs use this stack, which otherwise connects directly.
 *
 * For the OS system-proxy path we resolve the actual request origin. DIRECT
 * requests stay on Node's original fetch (so a machine without a proxy keeps
 * the pre-existing network behaviour); proxy routes use `net.fetch`, which
 * supports Chromium's HTTP(S)/SOCKS routing and proxy authentication.
 *
 * Explicit HTTP(S)_PROXY / ALL_PROXY launch environment variables retain
 * precedence and use undici's EnvHttpProxyAgent. That path is installed before
 * app-ready; the system path is installed after app-ready because `net.fetch`
 * is not available earlier.
 *
 * A stable delegating fetch wrapper is installed synchronously in phase 1.
 * fetch-diag may wrap it afterwards; phase 2 changes only the delegate, so the
 * diagnostic wrapper stays intact.
 */

import { createLogger } from '../logger';
import { logErrorSummary } from './log-redact';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';

const log = createLogger('proxy-dispatcher');

const LOCAL_NO_PROXY = ['localhost', '127.0.0.1', '::1', '*.local'];
const SYSTEM_ROUTE_CACHE_MS = 2_000;
const SYSTEM_ROUTE_CACHE_MAX_ORIGINS = 256;

// The turn-level watchdog owns idle/abort for model streaming. Connection
// setup remains bounded while long response bodies are allowed to continue.
const DISPATCHER_OPTS = { headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 30_000 } };

type FetchLike = typeof globalThis.fetch;

export interface EnvProxyConfig {
  httpProxy?: string;
  httpsProxy?: string;
  noProxy: string;
}

export type ResolvedProxyRoute =
  | { kind: 'direct' }
  | { kind: 'proxy'; url: string }
  | { kind: 'unsupported'; value: string };

export type ChildProxyEnvironment = Record<string, string>;

let _active: string | undefined;
let _envActive = false;
let _originalFetchValue: FetchLike | undefined;
let _baseFetch: FetchLike | undefined;
let _fetchDelegate: FetchLike | undefined;
let _fetchRouter: FetchLike | undefined;
let _childFetchBridge: Promise<ChildFetchBridge> | undefined;

interface ChildFetchBridge {
  url: string;
  token: string;
  close: () => Promise<void>;
}

interface ChildFetchRequestMeta {
  url: string;
  method: string;
  headers: Array<[string, string]>;
  redirect: RequestRedirect;
}

interface ChildFetchResponseMeta {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`;
  } catch {
    return 'set';
  }
}

/** Merge caller NO_PROXY with mandatory loopback bypasses. */
export function buildNoProxy(env: NodeJS.ProcessEnv = process.env): string {
  const existing = String(env.NO_PROXY || env.no_proxy || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...existing, ...LOCAL_NO_PROXY])].join(',');
}

/**
 * Resolve standard proxy environment variables without collapsing distinct
 * HTTP and HTTPS routes. ALL_PROXY is the final fallback for both schemes;
 * HTTP_PROXY alone also covers HTTPS, matching EnvHttpProxyAgent semantics.
 */
export function envProxyConfig(env: NodeJS.ProcessEnv = process.env): EnvProxyConfig {
  const http = env.HTTP_PROXY || env.http_proxy || undefined;
  const https = env.HTTPS_PROXY || env.https_proxy || undefined;
  const all = env.ALL_PROXY || env.all_proxy || undefined;
  return {
    httpProxy: http || all,
    httpsProxy: https || http || all,
    noProxy: buildNoProxy(env),
  };
}

/** Kept as a compact presence/diagnostic helper for callers and tests. */
export function envProxyUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const config = envProxyConfig(env);
  return config.httpsProxy || config.httpProxy;
}

/** Parse the first route in Chromium's semicolon-separated proxy chain. */
export function parseResolvedProxyRoute(result: string | undefined): ResolvedProxyRoute {
  const first = String(result || '').split(';')[0]?.trim() || '';
  if (!first || /^DIRECT$/i.test(first)) return { kind: 'direct' };
  const match = first.match(/^([A-Za-z0-9]+)\s+(\S+:\d+)$/);
  if (!match) return { kind: 'unsupported', value: first || 'empty' };
  const scheme = match[1].toUpperCase();
  const hostPort = match[2];
  if (scheme === 'PROXY' || scheme === 'HTTP') return { kind: 'proxy', url: `http://${hostPort}` };
  if (scheme === 'HTTPS') return { kind: 'proxy', url: `https://${hostPort}` };
  if (scheme === 'SOCKS5' || scheme === 'SOCKS') {
    // Chromium's SOCKS route is host-based. Preserve that behaviour for Node
    // SDK adapters by delegating destination DNS to the proxy as well; a plain
    // socks5:// URL would resolve locally and can fail (or leak DNS) when the
    // VPN intentionally provides no virtual interface.
    return { kind: 'proxy', url: `socks5h://${hostPort}` };
  }
  return { kind: 'unsupported', value: first };
}

/** Standard NO_PROXY host/port matching used by non-undici SDK adapters. */
export function shouldBypassProxy(url: string, noProxy: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  const hostname = parsed.hostname.toLowerCase();
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  for (const rawEntry of String(noProxy || '').split(/[,\s]+/)) {
    const raw = rawEntry.trim().toLowerCase();
    if (!raw) continue;
    if (raw === '*') return true;
    const match = raw.match(/^(.+):(\d+)$/);
    const entryPort = match ? Number(match[2]) : 0;
    if (entryPort && entryPort !== port) continue;
    const entryHost = (match ? match[1] : raw).replace(/^\*?\./, '');
    if (hostname === entryHost || hostname.endsWith(`.${entryHost}`)) return true;
  }
  return false;
}

/** Resolve the current route for a known URL for SDKs that cannot use net.fetch. */
export async function resolveProxyRouteForUrl(
  targetUrl: string,
  resolveProxyOverride?: (url: string) => Promise<string>,
): Promise<ResolvedProxyRoute> {
  const envConfig = envProxyConfig();
  const protocol = (() => { try { return new URL(targetUrl).protocol; } catch { return ''; } })();
  const envProxy = protocol === 'http:' ? envConfig.httpProxy : envConfig.httpsProxy;
  if (envProxy) {
    return shouldBypassProxy(targetUrl, envConfig.noProxy)
      ? { kind: 'direct' }
      : { kind: 'proxy', url: envProxy };
  }
  if (process.env.ORKAS_NO_AUTO_PROXY === '1') return { kind: 'direct' };
  try {
    let resolveProxy = resolveProxyOverride;
    if (!resolveProxy) {
      const { session } = await import('electron');
      resolveProxy = (url: string) => session.defaultSession.resolveProxy(url);
    }
    return parseResolvedProxyRoute(await resolveProxy(targetUrl));
  } catch {
    return { kind: 'unsupported', value: 'resolve_failed' };
  }
}

/**
 * Build the minimal environment consumed by `bin/proxy-bootstrap.cjs` in an
 * app-owned Node child. Explicit launch env has precedence. A DIRECT target
 * leaves the child on its original fetch stack. If its known service target
 * needs a system proxy, child fetches stream through a token-protected
 * loopback bridge and Electron makes the PROXY/DIRECT decision for every
 * actual URL. This is deliberately a fetch bridge, not a frozen HTTP_PROXY
 * value: one child may call domains with different PAC rules, and proxy
 * settings may change while it is alive.
 *
 * Custom third-party children without a known target can inherit explicit env
 * proxy settings, but system PAC cannot be evaluated for an unknown URL.
 */
export async function buildChildProxyEnvironment(
  targetUrl?: string,
  bridgeOverride?: () => Promise<{ url: string; token: string }>,
  resolveProxyOverride?: (url: string) => Promise<string>,
): Promise<ChildProxyEnvironment> {
  const envConfig = envProxyConfig();
  if (envConfig.httpProxy || envConfig.httpsProxy) {
    return {
      ORKAS_PROXY_MODE: 'env',
      ...(envConfig.httpProxy ? { ORKAS_PROXY_HTTP_URL: envConfig.httpProxy } : {}),
      ...(envConfig.httpsProxy ? { ORKAS_PROXY_HTTPS_URL: envConfig.httpsProxy } : {}),
      ORKAS_PROXY_NO_PROXY: envConfig.noProxy,
      ...(envConfig.httpProxy ? { HTTP_PROXY: envConfig.httpProxy } : {}),
      ...(envConfig.httpsProxy ? { HTTPS_PROXY: envConfig.httpsProxy } : {}),
      NO_PROXY: envConfig.noProxy,
      NODE_USE_ENV_PROXY: '1',
    };
  }
  if (!targetUrl || process.env.ORKAS_NO_AUTO_PROXY === '1') return {};

  try {
    const route = await resolveProxyRouteForUrl(targetUrl, resolveProxyOverride);
    if (route.kind === 'direct') return { ORKAS_PROXY_MODE: 'direct' };
    if (route.kind === 'unsupported') {
      log.warn('child proxy route could not be resolved', {
        target: (() => { try { return new URL(targetUrl).origin; } catch { return 'invalid'; } })(),
      });
      return {
        ORKAS_PROXY_MODE: 'unsupported',
        ORKAS_PROXY_UNSUPPORTED: 'route_resolution_failed',
      };
    }
    const bridge = bridgeOverride ? await bridgeOverride() : await ensureChildFetchBridge();
    return {
      ORKAS_PROXY_MODE: 'system-fetch',
      ORKAS_PROXY_BRIDGE_URL: bridge.url,
      ORKAS_PROXY_BRIDGE_TOKEN: bridge.token,
    };
  } catch (err) {
    log.warn('child fetch bridge setup failed', {
      target: (() => { try { return new URL(targetUrl).origin; } catch { return 'invalid'; } })(),
      error: logErrorSummary(err),
    });
    return { ORKAS_PROXY_MODE: 'unsupported', ORKAS_PROXY_UNSUPPORTED: 'bridge_setup_failed' };
  }
}

function encodeBridgeMeta(value: ChildFetchRequestMeta | ChildFetchResponseMeta): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeBridgeMeta<T>(value: string | string[] | undefined): T {
  if (typeof value !== 'string' || !value) throw new Error('missing bridge metadata');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
}

function validBridgeToken(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function electronSystemFetch(): Promise<FetchLike> {
  const { net } = await import('electron');
  return ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const normalized = input instanceof URL ? input.href : input;
    return net.fetch(
      normalized as Parameters<typeof net.fetch>[0],
      init as Parameters<typeof net.fetch>[1],
    ) as Promise<Response>;
  }) as FetchLike;
}

/**
 * Start the loopback fetch bridge used by app-owned Node children. The random
 * token prevents unrelated local processes from turning it into an open
 * proxy. Request and response bodies stay streamed in both directions.
 */
export async function startChildFetchBridge(
  systemFetchOverride?: FetchLike,
): Promise<{ url: string; token: string; close: () => Promise<void> }> {
  const systemFetch = systemFetchOverride || await electronSystemFetch();
  const token = randomBytes(32).toString('base64url');
  const server = createServer({ maxHeaderSize: 128 * 1024 }, async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/fetch'
      || !validBridgeToken(req.headers['x-orkas-proxy-token'], token)) {
      res.writeHead(404).end();
      return;
    }

    const abort = new AbortController();
    let upstreamBody: ReadableStream<Uint8Array> | null = null;
    let upstreamReadable: Readable | null = null;
    const cancelUpstream = () => {
      if (!abort.signal.aborted) abort.abort();
      if (upstreamReadable) upstreamReadable.destroy();
      else if (upstreamBody) void upstreamBody.cancel().catch(() => undefined);
    };
    req.once('aborted', cancelUpstream);
    res.once('close', () => {
      if (!res.writableEnded) cancelUpstream();
    });
    try {
      const meta = decodeBridgeMeta<ChildFetchRequestMeta>(req.headers['x-orkas-fetch-meta']);
      const target = new URL(meta.url);
      if (target.protocol !== 'http:' && target.protocol !== 'https:') {
        throw new Error('bridge target must use HTTP(S)');
      }
      const hasBody = meta.method !== 'GET' && meta.method !== 'HEAD';
      const response = await systemFetch(meta.url, {
        method: meta.method,
        headers: meta.headers,
        redirect: meta.redirect,
        signal: abort.signal,
        ...(hasBody ? {
          body: Readable.toWeb(req) as unknown as BodyInit,
          // Electron/undici accepts streaming bodies even though DOM types do
          // not expose the Node-specific duplex field.
          duplex: 'half',
        } : {}),
      } as RequestInit);
      const responseMeta: ChildFetchResponseMeta = {
        status: response.status,
        statusText: response.statusText,
        headers: Array.from(response.headers.entries()),
      };
      res.writeHead(200, { 'x-orkas-fetch-meta': encodeBridgeMeta(responseMeta) });
      if (!response.body) {
        res.end();
      } else {
        upstreamBody = response.body as ReadableStream<Uint8Array>;
        upstreamReadable = Readable.fromWeb(
          upstreamBody as unknown as import('node:stream/web').ReadableStream,
        );
        upstreamReadable
          .once('error', () => res.destroy())
          .pipe(res);
      }
    } catch (err) {
      if (!res.headersSent) {
        log.warn('child fetch bridge request failed', logErrorSummary(err));
        res.writeHead(502, { 'x-orkas-bridge-error': 'upstream_fetch_failed' });
        res.end();
      } else {
        res.destroy();
      }
    }
  });
  // The bridge is loopback-only and bodies are streamed. Do not let Node's
  // five-minute request-body timeout truncate a large/slow connector upload;
  // headers remain tightly bounded in both size and time.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('child fetch bridge did not bind a TCP port');
  }
  return {
    url: `http://127.0.0.1:${address.port}/v1/fetch`,
    token,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

async function ensureChildFetchBridge(): Promise<ChildFetchBridge> {
  if (!_childFetchBridge) {
    _childFetchBridge = startChildFetchBridge().catch((err) => {
      _childFetchBridge = undefined;
      throw err;
    });
  }
  return _childFetchBridge;
}

function ensureFetchRouter(): void {
  if (_fetchRouter) return;
  const current = globalThis.fetch;
  if (typeof current !== 'function') throw new Error('global fetch is unavailable');
  _originalFetchValue = current;
  _baseFetch = current.bind(globalThis) as FetchLike;
  _fetchDelegate = _baseFetch;
  _fetchRouter = ((input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    return (_fetchDelegate as FetchLike)(input, init);
  }) as FetchLike;
  Object.defineProperty(_fetchRouter, '__orkasProxyFetchRouter', { value: true });
  globalThis.fetch = _fetchRouter;
}

function inputUrl(input: Parameters<FetchLike>[0]): URL | undefined {
  let raw: string;
  if (typeof input === 'string') raw = input;
  else if (input instanceof URL) raw = input.href;
  else if (input && typeof (input as Request).url === 'string') raw = (input as Request).url;
  else return undefined;
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/**
 * Build the phase-2 delegate. DIRECT HTTP(S) requests retain Node's original
 * fetch stack. Routes that name a proxy are handed to Electron so Chromium
 * applies HTTP(S), SOCKS, authentication, and PAC fallbacks. Resolution
 * failures also use Electron rather than risking an unintended direct leak.
 *
 * The small per-origin cache prevents PAC evaluation from becoming a hot-path
 * cost while keeping runtime proxy changes responsive. Domain-rule proxy
 * configurations naturally map to the same cache key.
 */
export function createSystemProxyFetch(
  fallbackFetch: FetchLike,
  systemFetch: FetchLike,
  resolveProxy: (url: string) => Promise<string>,
  routeCacheMs = SYSTEM_ROUTE_CACHE_MS,
): FetchLike {
  const cache = new Map<string, { expiresAt: number; route: Promise<ResolvedProxyRoute> }>();

  return (async (input: Parameters<FetchLike>[0], init?: Parameters<FetchLike>[1]) => {
    const url = inputUrl(input);
    if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
      return fallbackFetch(input, init);
    }

    const now = Date.now();
    let entry = cache.get(url.origin);
    if (!entry || entry.expiresAt <= now) {
      if (cache.size >= SYSTEM_ROUTE_CACHE_MAX_ORIGINS) {
        for (const [origin, cached] of cache) {
          if (cached.expiresAt <= now) cache.delete(origin);
        }
        if (cache.size >= SYSTEM_ROUTE_CACHE_MAX_ORIGINS) {
          const oldestOrigin = cache.keys().next().value as string | undefined;
          if (oldestOrigin) cache.delete(oldestOrigin);
        }
      }
      const route = resolveProxy(url.href)
        .then(parseResolvedProxyRoute)
        .catch(() => ({ kind: 'unsupported', value: 'resolve_failed' }) as ResolvedProxyRoute);
      entry = { expiresAt: now + Math.max(0, routeCacheMs), route };
      cache.set(url.origin, entry);
    }
    const route = await entry.route;
    return route.kind === 'direct'
      ? fallbackFetch(input, init)
      : systemFetch(input, init);
  }) as FetchLike;
}

/**
 * Phase 1 — install the stable router and honor explicit launch-environment
 * proxy settings. This function performs the dispatcher change synchronously
 * before returning its resolved Promise, so early provider imports cannot race
 * the environment-proxy setup.
 */
export async function installEnvProxyDispatcher(): Promise<boolean> {
  ensureFetchRouter();
  const config = envProxyConfig();
  if (!config.httpProxy && !config.httpsProxy) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { EnvHttpProxyAgent, setGlobalDispatcher } = require('undici') as typeof import('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent({
      ...(config.httpProxy ? { httpProxy: config.httpProxy } : {}),
      ...(config.httpsProxy ? { httpsProxy: config.httpsProxy } : {}),
      noProxy: config.noProxy,
      ...DISPATCHER_OPTS,
    }));
    _envActive = true;
    const routes = [
      config.httpProxy ? `http=${redact(config.httpProxy)}` : '',
      config.httpsProxy ? `https=${redact(config.httpsProxy)}` : '',
    ].filter(Boolean).join(',');
    _active = `env:${routes}`;
    log.info('installed environment proxy dispatcher for global fetch', {
      http_proxy: config.httpProxy ? redact(config.httpProxy) : undefined,
      https_proxy: config.httpsProxy ? redact(config.httpsProxy) : undefined,
    });
    return true;
  } catch (err) {
    _envActive = false;
    log.warn('env proxy dispatcher install failed; system proxy may still be used after app-ready',
      logErrorSummary(err));
    return false;
  }
}

/**
 * Phase 2 — choose the main-process HTTP(S) fetch stack from Electron's
 * per-origin system-proxy decision. DIRECT keeps Node's original stack;
 * proxied routes use Chromium, preserving PAC/bypass rules, proxy auth, and
 * runtime proxy changes.
 *
 * `systemFetchOverride` exists for deterministic unit tests; production loads
 * Electron's net.fetch after app-ready.
 */
export async function installSystemProxyDispatcher(
  systemFetchOverride?: FetchLike,
  resolveProxyOverride?: (url: string) => Promise<string>,
): Promise<boolean> {
  ensureFetchRouter();
  if (_envActive) return false;
  if (process.env.ORKAS_NO_AUTO_PROXY === '1') {
    log.info('auto system-proxy routing disabled (ORKAS_NO_AUTO_PROXY=1)');
    return false;
  }
  try {
    let systemFetch = systemFetchOverride;
    let resolveProxy = resolveProxyOverride;
    if (!systemFetch) {
      systemFetch = await electronSystemFetch();
    }
    if (!resolveProxy) {
      const { session } = await import('electron');
      resolveProxy = (url: string) => session.defaultSession.resolveProxy(url);
    }
    _fetchDelegate = createSystemProxyFetch(_baseFetch as FetchLike, systemFetch, resolveProxy);
    _active = 'system:per-request';
    log.info('installed per-request Electron system-proxy routing for global fetch');
    return true;
  } catch (err) {
    log.warn('system proxy routing install failed; leaving global fetch on its previous route',
      logErrorSummary(err));
    return false;
  }
}

/** Current route summary; proxy credentials and full URLs are never exposed. */
export function activeProxy(): string | undefined {
  return _active;
}

/** Test-only: restore the global fetch value that preceded the stable router. */
export function _resetProxyRoutingForTests(): void {
  if (_fetchRouter && globalThis.fetch === _fetchRouter && _originalFetchValue) {
    globalThis.fetch = _originalFetchValue;
  }
  _active = undefined;
  _envActive = false;
  _originalFetchValue = undefined;
  _baseFetch = undefined;
  _fetchDelegate = undefined;
  _fetchRouter = undefined;
  if (_childFetchBridge) {
    void _childFetchBridge.then(({ close }) => close()).catch(() => undefined);
    _childFetchBridge = undefined;
  }
}
