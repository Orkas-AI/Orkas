import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Journey coverage: combined setup -> browser -> relay -> shop verification -> encrypted
// grant -> existing MCP actions. External boundaries are fake; no real store is contacted.
const mocks = vi.hoisted(() => ({ open: vi.fn(async (_url: string) => undefined) }));
vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: mocks.open } }));
vi.mock('../../../../src/main/features/connectors/_server_bridge', () => ({ accountApiBase: () => 'https://orkas.ai/api', tokenStore: { getDeviceId: () => 'seller-test-device', authHeaders: () => ({}) } }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'en', getLanguageForUser: () => 'en' }));
vi.mock('../../../../src/main/features/api_common', () => ({ withCommonHeaders: (headers: object) => ({ ...headers, 'Orkas-Channel': 'open' }) }));
vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({ broadcastOAuthConnectProgress: vi.fn() }));
vi.mock('../../../../src/main/util/background-node', () => ({
  resolveBackgroundNodeRuntime: () => ({ executable: process.execPath, electronAsNode: false }),
  withBackgroundNodeEnv: (env: object) => env,
}));
vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({ buildChildProxyEnvironment: async () => ({}) }));
vi.mock('../../../../src/main/util/local-secret-store', () => ({
  encryptLocalSecret: (_context: unknown, value: string) => `TEST:${value}`,
  decryptLocalSecret: (_context: unknown, value: string) => value.slice(5),
}));
vi.mock('../../../../src/main/model/core-agent/interactive-cli-sessions', () => ({
  startInteractiveCliSession: () => { throw new Error('Seller authorization must not prompt in a terminal'); },
  waitInteractiveCliSession: vi.fn(),
}));

import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { authorizeLocalApi, hasLocalApiAuthorization, localApiRuntimeDir, localApiTransport,
  normalizeLocalApiConnectionInput, removeLocalApiAuthorization } from '../../../../src/main/features/connectors/local-api';
import { cancelDcrOAuth, handleDcrCallbackUrl, LOCAL_API_REDIRECT_URI } from '../../../../src/main/features/connectors/oauth-dcr';
import { cancelInFlightOAuth } from '../../../../src/main/features/connectors/oauth';
import { broadcastOAuthConnectProgress } from '../../../../src/main/features/connectors/oauth-events';

const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const api = require('../../../../bin/marketplace-seller-api.cjs');
const UID = 'seller-e2e-test';
const inputs = {
  shopee: { region: 'global', shop_id: '456', partner_id: '12345', partner_key: 'partner-test-secret' },
  'tiktok-shop': { region: 'us', shop_id: 'USSELLERCODE', service_id: '7000000000000000001', app_key: '123', app_secret: 'app-test-secret' },
};
const scopeList = ['seller.product.basic', 'seller.product.write', 'seller.order.info', 'seller.logistics'];
function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}
function tokens(provider: string, token = 'access-test') {
  return provider === 'shopee'
    ? { error: '', access_token: token, refresh_token: 'refresh-test', expire_in: 14400 }
    : { code: 0, data: { access_token: token, refresh_token: 'refresh-test',
      access_token_expire_in: Math.floor(Date.now() / 1000) + 3600,
      refresh_token_expire_in: Math.floor(Date.now() / 1000) + 86400,
      user_type: 0, granted_scopes: scopeList } };
}
function identity(provider: string) {
  return provider === 'shopee' ? { error: '', shop_name: 'Fixture shop', region: 'SG' } : { code: 0, data: { shops: [
    { id: '7495355150342452340', code: 'USSELLERCODE', cipher: 'US_bound_cipher', region: 'US', name: 'Fixture shop' },
    { id: '7495355150342452341', code: 'ANOTHER', cipher: 'other-private-cipher', region: 'US', name: 'Not selected' },
  ] } };
}
function openedUrl() { return new URL(mocks.open.mock.calls.at(-1)![0] as unknown as string); }
function relay(provider: string, overrides?: (url: URL, init: any) => any) {
  const requests = vi.fn(async (raw: string, init: any) => {
    const url = new URL(raw);
    const override = overrides?.(url, init);
    if (override !== undefined) return override;
    if (url.pathname.endsWith('/dcr-exchange')) return json({ code: 0, oauth_code: 'one-time-code', oauth_state: openedUrl().searchParams.get('state') });
    if (url.pathname.includes('/token/') || url.pathname === '/api/v2/auth/access_token/get') return json(tokens(provider));
    if (url.pathname.endsWith('/shops') || url.pathname.endsWith('/get_shop_info')) return json(identity(provider));
    return json(provider === 'shopee' ? { error: '', response: { item: [] } } : { code: 0, data: { products: [], next_page_token: 'next-page' } });
  });
  vi.stubGlobal('fetch', requests);
  return requests;
}
const callback = () => handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=one-time-relay');

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => {
  cancelDcrOAuth();
  for (const id of Object.keys(inputs)) removeLocalApiAuthorization(UID, findCatalogEntry(id)!);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('seller-owned marketplace authorization journey', () => {
  it('accepts official local/global seller types and rejects creator, partner or malformed grants', async () => {
    const entry = findCatalogEntry('tiktok-shop')!;
    for (const userType of [0, 4, 5, 1, 2, 3, undefined]) {
      relay('tiktok_shop', (url) => {
        if (!url.pathname.endsWith('/token/get')) return undefined;
        const token = tokens('tiktok_shop');
        return json({ ...token, data: { ...token.data, user_type: userType } });
      });
      const flow = authorizeLocalApi(UID, entry, inputs['tiktok-shop']);
      const accepted = userType !== undefined && [0, 4, 5].includes(userType);
      const outcome = accepted ? expect(flow).resolves.toMatchObject({ shop_id: 'USSELLERCODE' })
        : expect(flow).rejects.toThrow('Could not authorize');
      await callback();
      await outcome;
      expect(hasLocalApiAuthorization(UID, entry)).toBe(accepted);
      removeLocalApiAuthorization(UID, entry);
    }
  });

  it('uses production consistently for new Shopee authorization, API and proxy selection in every region', async () => {
    const entry = findCatalogEntry('shopee')!;
    const cases = [
      ['global', 'https://open.shopee.com', 'https://partner.shopeemobile.com'],
      ['cn', 'https://open.shopee.cn', 'https://openplatform.shopee.cn'],
      ['br', 'https://open.shopee.com.br', 'https://openplatform.shopee.com.br'],
    ];
    for (const [region, authHost, apiHost] of cases) {
      const requests = relay('shopee');
      const flow = authorizeLocalApi(UID, entry, { ...inputs.shopee, region });
      expect(openedUrl().origin).toBe(authHost);
      await callback();
      const metadata = await flow;
      expect(metadata.environment).toBe('live');
      expect(new URL(requests.mock.calls[1][0]).origin).toBe(apiHost);
      expect((await localApiTransport(UID, entry, metadata)).proxyTargetUrl).toBe(apiHost);
      removeLocalApiAuthorization(UID, entry);
    }
  });

  it.each(['shopee', 'tiktok-shop'] as const)('connects %s through the public relay and uses only encrypted device credentials', async (id) => {
    const entry = findCatalogEntry(id)!;
    const provider = entry.local_api!.provider;
    const requests = relay(provider);
    const flow = authorizeLocalApi(UID, entry, inputs[id], { attemptId: 'seller-attempt' });
    const url = openedUrl();
    expect(url.protocol).toBe('https:');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(url.toString()).not.toMatch(/secret|partner_key|access_token/);
    if (id === 'shopee') {
      expect(url.origin + url.pathname).toBe('https://open.shopee.com/auth');
      expect(url.searchParams.get('redirect_uri')).toBe(LOCAL_API_REDIRECT_URI);
    } else {
      expect(url.origin + url.pathname).toBe('https://services.us.tiktokshop.com/open/authorize');
      expect(url.searchParams.get('service_id')).toBe(inputs[id].service_id);
    }
    expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
    await callback();
    const metadata = await flow;
    expect(broadcastOAuthConnectProgress).toHaveBeenCalledWith({ attempt_id: 'seller-attempt', catalog_id: id });
    expect(metadata).toEqual(id === 'shopee' ? { region: 'global', environment: 'live', shop_id: '456' } : { region: 'us', shop_id: 'USSELLERCODE' });
    expect(requests.mock.calls[0][0]).toBe('https://orkas.ai/api/connectors/oauth/dcr-exchange');
    expect(JSON.parse(requests.mock.calls[0][1].body)).toEqual({ exchange_code: 'one-time-relay', device_id: 'seller-test-device' });
    const transport = await localApiTransport(UID, entry, metadata);
    expect(transport.kind).toBe('stdio');
    if (transport.kind !== 'stdio') throw new Error('Expected existing stdio runtime');
    const encrypted = fs.readFileSync(path.join(localApiRuntimeDir(UID, id), 'credentials.enc'), 'utf8');
    expect(encrypted).toMatch(/^ORKAPI1:/);
    expect(encrypted).not.toMatch(/access-test|refresh-test|secret|US_bound_cipher/);
    const config = adapter.configured(transport.env);
    expect(config.credentials.identity.binding_shop_id).toBe(inputs[id].shop_id);
    expect(config.credentials.expires_at - Date.now()).toBeLessThan(15_000_000);
    const capabilities = await adapter.callTool('list_capabilities', {}, transport.env);
    expect(capabilities.identity).toMatchObject({ shop_name: 'Fixture shop' });
    expect(JSON.stringify(capabilities)).not.toMatch(/access-test|refresh-test|secret|cipher|Not selected/);
    await adapter.callTool('execute_read', { action: 'products.list', parameters: { page_size: 2 } }, transport.env);
    const last = new URL(requests.mock.calls.at(-1)![0]);
    expect(last.pathname).toBe(id === 'shopee' ? '/api/v2/product/get_item_list' : '/product/202502/products/search');
    expect(last.searchParams.get('page_size')).toBe('2');
    if (id === 'tiktok-shop') {
      expect(last.searchParams.get('shop_cipher')).toBe('US_bound_cipher');
      expect(last.searchParams.has('access_token')).toBe(false);
      expect(requests.mock.calls.at(-1)![1].headers['x-tts-access-token']).toBe('access-test');
    }
    const calls = requests.mock.calls.length;
    await callback();
    expect(requests).toHaveBeenCalledTimes(calls); // replay has no pending grant to mutate
  });

  it('rejects a wrong state before exchanging app credentials, and can reconnect afterward', async () => {
    const entry = findCatalogEntry('shopee')!;
    const requests = relay('shopee', (url) => url.pathname.endsWith('/dcr-exchange')
      ? json({ code: 0, oauth_code: 'forged-code', oauth_state: 'wrong-state' }) : undefined);
    const flow = authorizeLocalApi(UID, entry, inputs.shopee);
    const rejected = expect(flow).rejects.toThrow('Could not authorize');
    await callback();
    await rejected;
    expect(requests).toHaveBeenCalledTimes(1);
    expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
    relay('shopee');
    const retry = authorizeLocalApi(UID, entry, inputs.shopee);
    await callback();
    await expect(retry).resolves.toMatchObject({ shop_id: '456' });
  });

  it('rejects another shop or the wrong market without retaining tokens', async () => {
    const entry = findCatalogEntry('tiktok-shop')!;
    for (const replacement of [{ shop_id: 'unknown-shop' }, { region: 'row' }]) {
      relay('tiktok_shop');
      const flow = authorizeLocalApi(UID, entry, { ...inputs['tiktok-shop'], ...replacement });
      const rejected = expect(flow).rejects.toThrow('does not match');
      await callback();
      await rejected;
      expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
    }
  });

  it('keeps cancel effective during a pending token exchange and ignores late completion', async () => {
    let release!: (value: unknown) => void;
    const tokenReply = new Promise((resolve) => { release = resolve; });
    relay('shopee', (url) => url.pathname.endsWith('/auth/token/get') ? tokenReply : undefined);
    const entry = findCatalogEntry('shopee')!;
    const flow = authorizeLocalApi(UID, entry, inputs.shopee);
    const rejected = expect(flow).rejects.toMatchObject({ code: 'user_cancelled' });
    const completion = callback();
    await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/auth/token/get'))).toBe(true));
    expect(cancelInFlightOAuth()).toBe(true);
    release(json(tokens('shopee')));
    await completion;
    await rejected;
    expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
  });

  it('reports browser failure and provider rejection without exposing credentials or raw errors', async () => {
    const entry = findCatalogEntry('tiktok-shop')!;
    mocks.open.mockRejectedValueOnce(new Error('sensitive-browser-url'));
    await expect(authorizeLocalApi(UID, entry, inputs['tiktok-shop'])).rejects.toThrow('Could not authorize');
    relay('tiktok_shop', (url) => url.hostname === 'auth.tiktok-shops.com'
      ? json({ code: 105000, message: 'leaked-secret-and-token' }) : undefined);
    const flow = authorizeLocalApi(UID, entry, inputs['tiktok-shop']);
    const rejected = expect(flow).rejects.toThrow('Could not authorize');
    await callback();
    await rejected;
    expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
  });

  it('requires exact named fields and keeps keys, IDs and store choices separated', () => {
    const entry = findCatalogEntry('shopee')!;
    for (const replacement of [ { shop_id: '9007199254740993' }, { partner_id: '1.5' }, { region: 'https://evil.example' },
      { environment: 'production' }, { partner_key: '' }, { redirect_uri: 'https://evil.example' } ]) {
      expect(() => normalizeLocalApiConnectionInput(entry, { ...inputs.shopee, ...replacement })).toThrow();
    }
    const tiktok = findCatalogEntry('tiktok-shop')!;
    expect(normalizeLocalApiConnectionInput(tiktok, inputs['tiktok-shop']).credentials.service_id).toBe('7000000000000000001');
    expect(api.authorizeUrl('tiktok_shop', { region: 'row', shop_id: '123' }, inputs['tiktok-shop'], 'test-state', LOCAL_API_REDIRECT_URI))
      .toBe('https://services.tiktokshop.com/open/authorize?service_id=7000000000000000001&state=test-state');
  });
});
