import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => logs }));
const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const { writeCredentialFile } = require('../../../../bin/local-api-credential-codec.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
const privateMarker = 'private-shop-key-order-error-canary';
const roots: string[] = [];
let sequence = 0;
const providers = [
  ['rakuten_rms', 'rakuten-rms', 'rakuten-rms-api.cjs'],
  ['base_shop', 'base-shop', 'base-shop-api.cjs'],
  ['qoo10_japan', 'qoo10-japan', 'qoo10-japan-api.cjs'],
  ['futureshop', 'futureshop', 'futureshop-api.cjs'],
  ['yahoo_shopping', 'yahoo-shopping', 'yahoo-shopping-api.cjs'],
] as const;

const failureTypes: Record<string, string> = {
  E_TOOL_CALL_AUTH: 'auth',
  E_TOOL_CALL_RATE_LIMIT: 'upstream',
  E_TOOL_CALL_UPSTREAM: 'upstream',
  E_TOOL_CALL_NETWORK: 'network',
  E_TOOL_CALL_TIMEOUT: 'timeout',
  E_TOOL_CALL_CANCELLED: 'cancelled',
};
function connectorFailureDiagnostics(result: any) {
  let code = result?._meta?.orkas?.errorCode;
  if (!code && Array.isArray(result?.content)) {
    for (const item of result.content) {
      if (item?.type !== 'text' || typeof item.text !== 'string') continue;
      try { code = JSON.parse(item.text)?.error_code; } catch { /* Ignore non-JSON error text. */ }
      if (code) break;
    }
  }
  return { error_code: code, error_type: failureTypes[code] };
}

async function settle<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const out = await result;
  if ('error' in out) throw out.error;
  return out.value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  logs.info.mockClear(); logs.warn.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function connected(provider: string, file: string) {
  const api = require(`../../../../bin/${file}`);
  const metadata = provider === 'futureshop' ? { api_origin: 'https://issued.example.com' }
    : provider === 'yahoo_shopping' ? { seller_id: 'fixture-shop' } : {};
  const token = { access_token: privateMarker, refresh_token: 'fixture-refresh', expires_in: 3600 };
  const fixture = vi.fn(async (url: string) => {
    if (url.endsWith('/token')) return new Response(JSON.stringify(token));
    if (provider === 'base_shop') return new Response(JSON.stringify(url.endsWith('/users/me')
      ? { user: { shop_id: 'fixture-shop' } } : url.includes('/orders') ? { orders: [] } : { items: [] }));
    if (provider === 'qoo10_japan') return new Response(JSON.stringify({ ResultCode: 0,
      ResultObject: { TotalItems: 0, TotalPages: 0, PresentPage: 0, Items: [] } }));
    if (provider === 'rakuten_rms') return new Response(JSON.stringify({ results: [], numFound: 0, offset: 0 }));
    if (provider === 'futureshop') return new Response(JSON.stringify({ productList: [] }));
    return new Response('<ResultSet totalResultsAvailable="0"></ResultSet>');
  });
  vi.stubGlobal('fetch', fixture);
  const credentials = await settle(api.authorize({ provider, metadata, oauthCode: 'fixture-code',
    credentials: { client_id: `fixture-app-${++sequence}`, client_secret: privateMarker, shop_key: privateMarker,
      service_secret: privateMarker, license_key: privateMarker, certification_key: privateMarker, redirect_uri: 'https://orkas.ai/api/connectors/oauth/dcr-callback' } }));
  const root = mkdtempSync(join(tmpdir(), 'japan-diagnostics-')); roots.push(root);
  const credentialFile = join(root, 'credentials.enc'); const key = randomBytes(32).toString('base64url');
  writeCredentialFile(credentialFile, key, credentials);
  const env = { ORKAS_LOCAL_API_PROVIDER: provider, ORKAS_LOCAL_API_CREDENTIAL_FILE: credentialFile,
    ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(metadata) };
  const args = { action: provider === 'yahoo_shopping' ? 'products.search' : 'products.list', parameters: provider === 'qoo10_japan' ? { status: 'S2' }
    : provider === 'yahoo_shopping' ? { query: 'fixture-item' } : {} };
  return () => adapter.callToolResult('execute_read', args, env);
}

describe('Japanese merchant diagnostics across response IO and MCP', () => {
  it.each(providers)('preserves %s failures and cancellation without retrying or exposing private data', async (provider, _id, file) => {
    const read = await connected(provider, file);
    const faults = [
      { response: () => ({ ok: false, status: 401 }), code: 'E_TOOL_CALL_AUTH', type: 'auth' },
      { response: () => ({ ok: false, status: 429 }), code: 'E_TOOL_CALL_RATE_LIMIT', type: 'upstream' },
      { response: () => ({ ok: false, status: 503 }), code: 'E_TOOL_CALL_UPSTREAM', type: 'upstream' },
      { response: () => ({ ok: true, status: 200, text: async () => { throw new TypeError(privateMarker); } }), code: 'E_TOOL_CALL_NETWORK', type: 'network' },
      { response: () => ({ ok: true, status: 200, text: async () => { throw new DOMException(privateMarker, 'TimeoutError'); } }), code: 'E_TOOL_CALL_TIMEOUT', type: 'timeout' },
      { response: () => new Response(`<broken>${privateMarker}`), code: 'E_TOOL_CALL_UPSTREAM', type: 'upstream' },
      { response: () => new Response('x'.repeat(2_000_001)), code: 'E_TOOL_CALL_UPSTREAM', type: 'upstream' },
    ];
    for (const fault of faults) {
      // Start with an approved connection for each fault: futureshop invalidates
      // its cached grant on 401 and reacquires it on a later independent call.
      const call = fault === faults[0] ? read : await connected(provider, file);
      const fetchMock = vi.fn(async () => fault.response()); vi.stubGlobal('fetch', fetchMock);
      const result = await settle(call());
      expect(result).toMatchObject({ isError: true });
      const diagnostic = connectorFailureDiagnostics(result);
      expect(diagnostic).toEqual({ error_code: fault.code, error_type: fault.type });
      expect(JSON.stringify(result)).not.toContain(privateMarker);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
    const call = await connected(provider, file);
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => {
      controller.abort(privateMarker); throw new DOMException(privateMarker, 'AbortError');
    } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await settle(withRequestSignal(controller.signal, call));
    expect(connectorFailureDiagnostics(result)).toEqual({ error_code: 'E_TOOL_CALL_CANCELLED', error_type: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.stringify([result, logs.warn.mock.calls, logs.info.mock.calls])).not.toContain(privateMarker);
  });
});
