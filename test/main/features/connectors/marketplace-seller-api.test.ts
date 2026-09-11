import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const api = require('../../../../bin/marketplace-seller-api.cjs');
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const codec = require('../../../../bin/local-api-credential-codec.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
const dirs: string[] = [];
function environment(provider: 'shopee' | 'tiktok_shop', overrides: Record<string, unknown> = {}, metadataOverrides: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-marketplace-api-'));
  dirs.push(dir);
  const metadata = { shop_id: '456', region: provider === 'shopee' ? 'global' : 'us', ...(provider === 'shopee' ? { environment: 'live' } : {}), ...metadataOverrides };
  const key = crypto.randomBytes(32).toString('base64url');
  const file = path.join(dir, 'credentials.enc');
  codec.writeCredentialFile(file, key, { provider, partner_id: '12345', partner_key: 'partner-test-secret',
    service_id: '789', app_key: '123', app_secret: 'app-test-secret',
    access_token: 'access-test', refresh_token: 'refresh-test', expires_at: Date.now() + 3600_000,
    refresh_expires_at: Date.now() + 86400_000,
    user_type: 0,
    scopes: ['seller.product.basic', 'seller.product.write', 'seller.order.info', 'seller.logistics'],
    identity: { ...metadata, binding_shop_id: '456', shop_id: '7495355150342452340', shop_cipher: 'ROW_test' }, ...overrides });
  return { ORKAS_LOCAL_API_PROVIDER: provider, ORKAS_LOCAL_API_CREDENTIAL_FILE: file,
    ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(metadata) };
}
function response(body: unknown, status = 200) { return { ok: status < 400, status, text: async () => JSON.stringify(body) }; }
function call(env: NodeJS.ProcessEnv, action: string, parameters = {}, tool = 'execute_read') {
  return adapter.callTool(tool, { action, parameters }, env);
}
afterEach(() => {
  vi.unstubAllGlobals(); vi.restoreAllMocks();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('seller marketplace API protocol and failure recovery', () => {
  it.each(['shopee', 'tiktok_shop'] as const)('preserves %s transport and invalid-response diagnostics without leaking provider data', async provider => {
    const env = environment(provider);
    const faults = [
      [response({ message: 'private-diagnostic' }, 401), 'E_TOOL_CALL_AUTH'],
      [response({ message: 'private-diagnostic' }, 429), 'E_TOOL_CALL_RATE_LIMIT'],
      [response({ message: 'private-diagnostic' }, 503), 'E_TOOL_CALL_UPSTREAM'],
      [response({ message: 'private-diagnostic' }, 408), 'E_TOOL_CALL_TIMEOUT'],
      [new DOMException('private-diagnostic', 'TimeoutError'), 'E_TOOL_CALL_TIMEOUT'],
      [new TypeError('private-diagnostic'), 'E_TOOL_CALL_NETWORK'],
      [{ ok: true, status: 200, text: async () => '<html>private-diagnostic</html>' }, 'E_TOOL_CALL_UPSTREAM'],
    ] as const;
    for (const [fault, code] of faults) {
      const fetchMock = vi.fn(async () => { if (fault instanceof Error) throw fault; return fault; });
      vi.stubGlobal('fetch', fetchMock);
      const result = await adapter.callToolResult('execute_read', { action: 'products.list' }, env);
      expect(result).toMatchObject({ isError: true });
      expect(result._meta.orkas.errorCode).toBe(code);
      expect(JSON.stringify(result)).not.toContain('private-diagnostic');
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it.each(['shopee', 'tiktok_shop'] as const)('counts partial %s mutations as failed calls while preserving the safe partial result', async provider => {
    const env = environment(provider);
    const fetchMock = vi.fn(async () => response(provider === 'shopee'
      ? { error: '', response: { failure_list: [{ failed_reason: 'private-diagnostic' }], success_list: [{}] } }
      : { code: 0, data: { errors: [{ message: 'private-diagnostic' }] } }));
    vi.stubGlobal('fetch', fetchMock);
    const parameters = provider === 'shopee' ? { item_id: '123', prices: [{ model_id: '0', original_price: 12 }] }
      : { product_id: '123', skus: [{ id: '456', price: { amount: '12', currency: 'USD' } }] };
    const result = await adapter.callToolResult('execute_high_impact', { action: 'prices.update', parameters }, env);
    expect(result.isError).toBe(true);
    expect(result._meta.orkas.errorCode).toBe('E_TOOL_CALL_UPSTREAM');
    expect(JSON.parse(result.content[0].text).result).toMatchObject({ status: 'partial_or_failed', failed_count: 1 });
    expect(JSON.stringify(result)).not.toContain('private-diagnostic');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('keeps a previously authorized Shopee sandbox isolated instead of silently migrating it to production', async () => {
    const env = environment('shopee', {}, { environment: 'sandbox' });
    const request = vi.fn(async (_url: string) => response({ error: '', response: { item: [] } }));
    vi.stubGlobal('fetch', request);
    await call(env, 'products.list');
    expect(new URL(request.mock.calls[0][0]).origin)
      .toBe('https://openplatform.sandbox.test-stable.shopee.sg');
    const changed = { ...env, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify({
      ...JSON.parse(env.ORKAS_LOCAL_API_METADATA_JSON), environment: 'live',
    }) };
    await expect(call(changed, 'products.list')).rejects.toThrow('does not match this shop');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('matches independent OpenSSL signing vectors, including the exact TikTok JSON bytes', () => {
    // Expected digests were computed with openssl dgst, not the adapter or an SDK under test.
    expect(api.signShopee('12345', '/api/v2/product/get_item_list', 1700000000, 'partner-test-secret', 'access-test', '456'))
      .toBe('2f45fdd988130a52f4dc06c501271b3ce1fa5f337c82b5c828662055551eafd6');
    const body = '{"skus":[{"id":"1729592969712207013","price":{"amount":"12.50","currency":"USD"}}]}';
    expect(api.signTikTok('/product/202309/products/1729592969712207008/prices/update', {
      timestamp: 1700000000, shop_cipher: 'ROW_test', app_key: '123', sign: 'ignored', access_token: 'ignored', page_token: undefined,
    }, body, 'app-test-secret')).toBe('54281d6c11601a1a0102f70c6b344ca7b27eb1e71f5d96a88eb16070fa5d9dbd');
  });

  it.each(['shopee', 'tiktok_shop'] as const)('blocks tampered %s bindings and risk-lane downgrades before network access', async (provider) => {
    const env = environment(provider);
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(call(env, 'inventory.update', {}, 'execute_read')).rejects.toThrow('risk mismatch');
    await expect(call(env, 'delete.everything', {}, 'execute_destructive')).rejects.toThrow('unknown action');
    await expect(call(env, 'products.list', { url: 'https://evil.example' })).rejects.toThrow();
    for (const metadata of [{ shop_id: '987' }, { region: 'cn' }, { environment: 'sandbox' }]) {
      if (provider === 'tiktok_shop' && metadata.environment) continue;
      const altered = { ...env, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify({ ...JSON.parse(env.ORKAS_LOCAL_API_METADATA_JSON), ...metadata }) };
      await expect(call(altered, 'products.list', {})).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes Shopee once for concurrent reads and saves the rotated grant before any business request', async () => {
    const env = environment('shopee', { expires_at: Date.now() - 1 });
    let tokenCalls = 0;
    const fetchMock = vi.fn(async (raw: string, init: any) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/access_token/get')) {
        tokenCalls++;
        expect(JSON.parse(init.body)).toEqual({ partner_id: 12345, shop_id: 456, refresh_token: 'refresh-test' });
        expect(url.searchParams.has('access_token')).toBe(false);
        await Promise.resolve();
        return response({ error: '', partner_id: 12345, shop_id: 456, access_token: 'rotated-access', refresh_token: 'rotated-refresh', expire_in: 14400 });
      }
      const saved = codec.readCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, env.ORKAS_LOCAL_API_CREDENTIAL_KEY);
      expect(saved.refresh_token).toBe('rotated-refresh');
      expect(url.searchParams.get('access_token')).toBe('rotated-access');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return response({ error: '', response: { item: [], next_offset: 50 } });
    });
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all([call(env, 'products.list'), call(env, 'products.list')]);
    expect(tokenCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('finishes a shared token rotation when one waiting request is cancelled', async () => {
    const env = environment('shopee', { expires_at: Date.now() - 1 });
    const cancelled = new AbortController();
    const continuing = new AbortController();
    let releaseToken!: () => void;
    let tokenSignal: AbortSignal | undefined;
    const tokenReady = new Promise<void>(resolve => { releaseToken = resolve; });
    const fetchMock = vi.fn(async (raw: string, init: { signal: AbortSignal }) => {
      if (new URL(raw).pathname.endsWith('/access_token/get')) {
        tokenSignal = init.signal;
        await tokenReady;
        init.signal.throwIfAborted();
        return response({ error: '', partner_id: 12345, shop_id: 456,
          access_token: 'rotated-access', refresh_token: 'rotated-refresh', expire_in: 14400 });
      }
      expect(init.signal.aborted).toBe(false);
      return response({ error: '', response: { item: [] } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = withRequestSignal(cancelled.signal, () => call(env, 'products.list')).catch((error: Error) => error);
    const second = withRequestSignal(continuing.signal, () => call(env, 'products.list')).catch((error: Error) => error);
    try {
      await vi.waitFor(() => expect(tokenSignal).toBeDefined());
      cancelled.abort();
      expect(tokenSignal!.aborted).toBe(false);
      releaseToken();
      expect(await first).toBeInstanceOf(Error);
      expect(await second).not.toBeInstanceOf(Error);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(codec.readCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, env.ORKAS_LOCAL_API_CREDENTIAL_KEY))
        .toMatchObject({ access_token: 'rotated-access', refresh_token: 'rotated-refresh' });
    } finally {
      releaseToken();
      await Promise.all([first, second]);
    }
  });

  it('treats TikTok expiry as epoch seconds and preserves rotation after a subsequent request failure', async () => {
    const env = environment('tiktok_shop', { expires_at: Date.now() - 1 });
    const accessExpiry = Math.floor(Date.now() / 1000) + 7200;
    const refreshExpiry = accessExpiry + 86400;
    const fetchMock = vi.fn(async (raw: string) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/token/refresh')) {
        expect(url.origin).toBe('https://auth.tiktok-shops.com');
        expect(url.searchParams.get('grant_type')).toBe('refresh_token');
        expect(url.searchParams.get('refresh_token')).toBe('refresh-test');
        return response({ code: 0, data: { access_token: 'rotated-access', refresh_token: 'rotated-refresh',
          access_token_expire_in: accessExpiry, refresh_token_expire_in: refreshExpiry } });
      }
      return response({ message: 'secret-network-diagnostic' }, 503);
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(call(env, 'products.list')).rejects.toThrow('platform request failed');
    const saved = codec.readCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, env.ORKAS_LOCAL_API_CREDENTIAL_KEY);
    expect(saved).toMatchObject({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_at: accessExpiry * 1000, refresh_expires_at: refreshExpiry * 1000 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not refresh an expired refresh grant or execute writes without the granted scope', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const expired = environment('tiktok_shop', { expires_at: Date.now() - 1, refresh_expires_at: Date.now() - 1 });
    await expect(call(expired, 'products.list')).rejects.toThrow('expired');
    const incomplete = environment('tiktok_shop', { refresh_expires_at: undefined });
    await expect(call(incomplete, 'products.list')).rejects.toThrow('incomplete');
    const readOnly = environment('tiktok_shop', { scopes: ['seller.product.basic'] });
    await expect(call(readOnly, 'prices.update', { product_id: '123', skus: [{ id: '456', price: { currency: 'USD', amount: '12.50' } }] }, 'execute_high_impact'))
      .rejects.toThrow('seller.product.write');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('routes every declared Shopee action to its fixed path with bounded IDs and reviewed write payloads', async () => {
    const env = environment('shopee');
    const fetchMock = vi.fn(async () => response({ error: '', shop_name: 'Fixture', response: { success_list: [], failure_list: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const cases: Array<[string, string, Record<string, unknown>, string?]> = [
      ['shop.get', 'shop/get_shop_info', {}], ['warehouses.list', 'shop/get_warehouse_detail', {}],
      ['products.list', 'product/get_item_list', { offset: 50, page_size: 10 }],
      ['products.get', 'product/get_item_base_info', { item_ids: ['123', '124'] }],
      ['models.list', 'product/get_model_list', { item_id: '123' }],
      ['orders.list', 'order/get_order_list', { time_from: 1700000000, time_to: 1700000500, cursor: 'cursor' }],
      ['orders.get', 'order/get_order_detail', { order_sns: ['ORDER123'] }],
      ['prices.update', 'product/update_price', { item_id: '123', prices: [{ model_id: '0', original_price: 12.5 }] }, 'execute_high_impact'],
      ['inventory.update', 'product/update_stock', { item_id: '123', stock_list: [{ model_id: '0', seller_stock: [{ stock: 0 }] }] }, 'execute_high_impact'],
    ];
    expect(Object.keys(api.actionsFor('shopee')).sort()).toEqual(cases.map(([name]) => name).sort());
    for (const [name, route, parameters, tool] of cases) {
      await call(env, name, parameters, tool);
      const [raw, init] = fetchMock.mock.calls.at(-1)! as unknown as [string, any];
      const url = new URL(raw);
      expect(url.origin).toBe('https://partner.shopeemobile.com');
      expect(url.pathname).toBe(`/api/v2/${route}`);
      expect(init.method).toBe(tool ? 'POST' : 'GET');
      expect(url.searchParams.get('shop_id')).toBe('456');
      if (tool) expect(JSON.parse(init.body).item_id).toBe(123);
    }
    expect(JSON.parse((fetchMock.mock.calls.at(-1)! as unknown as [string, any])[1].body)).toEqual({ item_id: 123, stock_list: [{ model_id: 0, seller_stock: [{ stock: 0 }] }] });
  });

  it('routes every TikTok action using the selected shop, exact IDs, documented scopes and pagination', async () => {
    const env = environment('tiktok_shop');
    const fetchMock = vi.fn(async (_raw: string, _init: any) => response({ code: 0, data: {
      shops: [{ id: '7495355150342452340', code: '456', cipher: 'US_bound', region: 'US', name: 'Fixture' }],
    } }));
    vi.stubGlobal('fetch', fetchMock);
    const cases: Array<[string, string, Record<string, unknown>, string]> = [
      ['shop.get', '/authorization/202309/shops', {}, 'GET'],
      ['warehouses.list', '/logistics/202309/warehouses', {}, 'GET'],
      ['products.list', '/product/202502/products/search', { page_size: 10, page_token: 'next-page', seller_skus: ['sku'] }, 'POST'],
      ['products.get', '/product/202309/products/1729592969712207008', { product_id: '1729592969712207008' }, 'GET'],
      ['orders.list', '/order/202309/orders/search', { page_token: 'next-order', create_time_ge: 1700000000, create_time_lt: 1700000500 }, 'POST'],
      ['orders.get', '/order/202309/orders', { order_ids: ['1729592969712207008'] }, 'GET'],
      ['prices.update', '/product/202309/products/123/prices/update', { product_id: '123', skus: [{ id: '456', price: { currency: 'USD', amount: '12.50' } }] }, 'POST'],
      ['inventory.update', '/product/202309/products/123/inventory/update', { product_id: '123', skus: [{ id: '456', inventory: [{ warehouse_id: '789', quantity: 0 }] }] }, 'POST'],
    ];
    expect(Object.keys(api.actionsFor('tiktok_shop')).sort()).toEqual(cases.map(([name]) => name).sort());
    for (const [name, route, parameters, method] of cases) {
      await call(env, name, parameters, name.endsWith('.update') ? 'execute_high_impact' : 'execute_read');
      const [raw, init] = fetchMock.mock.calls.at(-1)!;
      const url = new URL(raw);
      expect(url.origin).toBe('https://open-api.tiktokglobalshop.com');
      expect(url.pathname).toBe(route);
      expect(init.method).toBe(method);
      expect(init.headers['x-tts-access-token']).toBe('access-test');
      expect(url.searchParams.has('access_token')).toBe(false);
      expect(url.searchParams.get('shop_cipher')).toBe(name === 'shop.get' ? null : 'ROW_test');
      if (name === 'orders.get') expect(url.searchParams.get('ids')).toBe('1729592969712207008');
      if (name === 'products.list') {
        expect(url.searchParams.get('page_token')).toBe('next-page');
        expect(JSON.parse(init.body)).toEqual({ seller_skus: ['sku'] });
      }
      if (name === 'orders.list') {
        expect(url.searchParams.get('page_token')).toBe('next-order');
        expect(JSON.parse(init.body)).toEqual({ create_time_ge: 1700000000, create_time_lt: 1700000500 });
      }
    }
  });

  it('keeps large TikTok IDs exact and supports cross-border final prices without silently ignoring an amount', async () => {
    const env = environment('tiktok_shop');
    const fetchMock = vi.fn(async () => response({ code: 0, data: {} }));
    vi.stubGlobal('fetch', fetchMock);
    const parameters = { product_id: '1729592969712207008', skus: [{ id: '1729592969712207013', price: { sale_price: '2500', currency: 'JPY' } }] };
    const out = await call(env, 'prices.update', parameters, 'execute_high_impact');
    const [raw, init] = fetchMock.mock.calls[0] as unknown as [string, any];
    expect(new URL(raw).pathname).toBe('/product/202309/products/1729592969712207008/prices/update');
    expect(JSON.parse(init.body)).toEqual({ skus: parameters.skus });
    expect(out.result.status).toBe('accepted');
    for (const price of [{ amount: '10', sale_price: '11', currency: 'USD' }, { currency: 'USD' }, { amount: 'NaN', currency: 'USD' }]) {
      await expect(call(env, 'prices.update', { ...parameters, skus: [{ id: '456', price }] }, 'execute_high_impact')).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['shopee', 'tiktok_shop'] as const)('reports partial %s stock failures without retrying or copying provider error text', async (provider) => {
    const env = environment(provider);
    const fetchMock = vi.fn(async () => response(provider === 'shopee'
      ? { error: '', response: { failure_list: [{ model_id: 0, failed_reason: 'raw-private-error' }], success_list: [] } }
      : { code: 0, data: { errors: [{ code: 12052990, message: 'raw-private-error' }] } }));
    vi.stubGlobal('fetch', fetchMock);
    const parameters = provider === 'shopee' ? { item_id: '123', stock_list: [{ model_id: '0', seller_stock: [{ stock: 0 }] }] }
      : { product_id: '123', skus: [{ id: '456', inventory: [{ warehouse_id: '789', quantity: 0 }] }] };
    const out = await call(env, 'inventory.update', parameters, 'execute_high_impact');
    expect(out.result).toMatchObject({ status: 'partial_or_failed', failed_count: 1 });
    expect(JSON.stringify(out)).not.toContain('raw-private-error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed, duplicate, oversized and credential-bearing changes before any network request', async () => {
    const env = environment('shopee');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const parameters of [
      { item_id: '123', prices: [{ model_id: '0', original_price: -1 }] },
      { item_id: '123', prices: [{ model_id: '0', original_price: 1, access_token: 'override' }] },
      { item_id: '9007199254740993', prices: [{ model_id: '0', original_price: 1 }] },
      { item_id: '123', prices: Array.from({ length: 11 }, (_, i) => ({ model_id: String(i), original_price: 1 })) },
      { item_id: '123', prices: [{ model_id: '0', original_price: 1 }, { model_id: '0', original_price: 2 }] },
    ]) await expect(call(env, 'prices.update', parameters, 'execute_high_impact')).rejects.toThrow();
    await expect(call(env, 'orders.list', { time_from: 1, time_to: 1 + 16 * 86400 })).rejects.toThrow('15 days');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
