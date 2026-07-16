'use strict';

/**
 * Install proxy routing for an app-owned Node child process. Explicit env
 * proxies use undici directly; system policy is evaluated per request by the
 * Electron parent. This file must stay silent on stdout because connector
 * children use stdout as their MCP JSON-RPC transport.
 */

function installChildProxy() {
  const mode = String(process.env.ORKAS_PROXY_MODE || '').trim();
  if (!mode || mode === 'direct') return false;
  if (mode === 'unsupported') {
    const route = String(process.env.ORKAS_PROXY_UNSUPPORTED || 'unknown').slice(0, 80);
    throw new Error(`system proxy route is unsupported for this child process: ${route}`);
  }

  if (mode === 'system-fetch') {
    const bridgeUrl = process.env.ORKAS_PROXY_BRIDGE_URL;
    const bridgeToken = process.env.ORKAS_PROXY_BRIDGE_TOKEN;
    if (!bridgeUrl || !bridgeToken) throw new Error('system fetch bridge configuration is incomplete');
    globalThis.fetch = createBridgeFetch(globalThis.fetch.bind(globalThis), bridgeUrl, bridgeToken);
    return true;
  }

  const {
    EnvHttpProxyAgent,
    setGlobalDispatcher,
  } = require('undici');
  const dispatcherOpts = {
    headersTimeout: 0,
    bodyTimeout: 0,
    connect: { timeout: 30_000 },
  };

  if (mode === 'env') {
    const httpProxy = process.env.ORKAS_PROXY_HTTP_URL || undefined;
    const httpsProxy = process.env.ORKAS_PROXY_HTTPS_URL || undefined;
    if (!httpProxy && !httpsProxy) return false;
    setGlobalDispatcher(new EnvHttpProxyAgent({
      ...(httpProxy ? { httpProxy } : {}),
      ...(httpsProxy ? { httpsProxy } : {}),
      noProxy: process.env.ORKAS_PROXY_NO_PROXY || 'localhost,127.0.0.1,::1,*.local',
      ...dispatcherOpts,
    }));
    return true;
  }

  throw new Error(`unknown child proxy mode: ${mode.slice(0, 40)}`);
}

function encodeMeta(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeMeta(value) {
  if (!value) throw new Error('system fetch bridge returned no metadata');
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

/**
 * Route each child fetch through the Electron parent. The parent uses
 * net.fetch, so PAC/DIRECT/proxy-auth and runtime changes are evaluated for the
 * request's real URL instead of being frozen when the child starts.
 */
function createBridgeFetch(nativeFetch, bridgeUrl, bridgeToken) {
  return async function bridgeFetch(input, init) {
    const request = new Request(input, init);
    const protocol = new URL(request.url).protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return nativeFetch(input, init);

    const meta = encodeMeta({
      url: request.url,
      method: request.method,
      headers: Array.from(request.headers.entries()),
      redirect: request.redirect,
    });
    const response = await nativeFetch(bridgeUrl, {
      method: 'POST',
      headers: {
        'x-orkas-proxy-token': bridgeToken,
        'x-orkas-fetch-meta': meta,
      },
      signal: request.signal,
      ...(request.body ? { body: request.body, duplex: 'half' } : {}),
    });
    if (!response.ok) {
      const detail = String(response.headers.get('x-orkas-bridge-error') || `HTTP ${response.status}`)
        .slice(0, 200);
      throw new Error(`system fetch bridge failed: ${detail}`);
    }
    const responseMeta = decodeMeta(response.headers.get('x-orkas-fetch-meta'));
    return new Response(response.body, {
      status: responseMeta.status,
      statusText: responseMeta.statusText,
      headers: responseMeta.headers,
    });
  };
}

installChildProxy();

module.exports = { createBridgeFetch, installChildProxy };
