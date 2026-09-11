import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const api = require('../../../../bin/storefront-admin-api.cjs');
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const TOKEN = 'fixture-store-token-never-log';
const providers = ['bigcommerce', 'shopline', 'shoplazza'];
const metadata = (provider: string) => provider === 'bigcommerce' ? { store_hash: 'abc123' } : { store_domain: `fixture.${provider === 'shopline' ? 'myshopline' : 'myshoplaza'}.com` };
const config = (provider: string) => ({ provider, metadata: metadata(provider), credentials: { provider, access_token: TOKEN,
  identity: { binding: Object.values(metadata(provider))[0], shop_id: '123', name: 'Fixture' } } });
const reply = (body: unknown, status = 200, headers = {}) => new Response(status === 204 ? null : JSON.stringify(body), { status, headers });
const wrap = (provider: string, value: unknown) => provider === 'shoplazza' ? { code: '', message: '', data: value } : value;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('production storefront API contracts', () => {
  it.each([
    ['bigcommerce', 'https://api.bigcommerce.com/stores/abc123/v3/', 'abc123'],
    ['bigcommerce', 'ABC123', 'abc123'],
    ['shopline', 'https://Fixture.myshopline.com/', 'fixture.myshopline.com'],
    ['shopline', 'fixture', 'fixture.myshopline.com'],
    ['shopline', 'localhost', 'localhost.myshopline.com'],
    ['shoplazza', 'fixture', 'fixture.myshoplaza.com'],
  ])('normalizes %s merchant input without widening the host boundary', (provider, input, expected) => {
    expect(api.normalizeBinding(provider, input)).toBe(expected);
  });

  it.each([
    'https://evil.test', 'http://fixture.myshopline.com', 'fixture.myshopline.com.evil.test',
    'https://fixture.myshopline.com:443', 'https://fixture.myshopline.com:8080',
    'https://u:p@fixture.myshopline.com', 'https://fixture.myshopline.com/path',
    'https://fixture.myshopline.com?x=y', 'fixture.myshopline.com#frag',
    'fixture.myshopline.com\\@evil.test', '127.0.0.1', 'https://fixture.myshoplazza.com',
  ])('rejects unsafe or incompatible domain input %s', (input) => {
    expect(() => api.normalizeBinding('shopline', input)).toThrow();
  });

  it.each(providers)('%s rejects tampered synced metadata before sending credentials', async (provider) => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const c = config(provider);
    c.metadata = provider === 'bigcommerce' ? { store_hash: 'different' } : { store_domain: `different.${provider === 'shopline' ? 'myshopline' : 'myshoplaza'}.com` };
    await expect(api.execute(c, 'products.list', {})).rejects.toThrow(/binding/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(providers)('%s exposes exactly reviewed R/H actions and closed schemas', (provider) => {
    const actions = api.actionsFor(provider);
    expect(Object.keys(actions)).toHaveLength(provider === 'shoplazza' ? 11 : 10);
    expect(Object.values(actions).map((x: any) => x.risk).sort()).toEqual(['H', 'H', ...Array(provider === 'shoplazza' ? 9 : 8).fill('R')]);
    for (const spec of Object.values(actions) as any[]) {
      expect(spec.input_schema.additionalProperties).toBe(false);
      expect(adapter.validateActionParameters(spec, Object.fromEntries(spec.input_schema.required.map((key: string) => [key,
        key === 'price' ? '0.00' : key === 'quantity' ? 0 : key.endsWith('_ids') ? ['123'] : '123'])))).toBeDefined();
    }
  });

  it.each(providers)('%s matches all official read routes, auth headers and shapes', async (provider) => {
    const c = config(provider);
    const big = provider === 'bigcommerce'; const line = provider === 'shopline';
    const rows: Array<[string, object, string, unknown]> = [
      ['products.list', { limit: 20 }, big ? '/v3/catalog/products' : line ? '/products/products.json' : '/products', big ? { data: [] } : { products: [] }],
      ['products.get', { product_id: '123' }, big ? '/v3/catalog/products/123' : line ? '/products/123.json' : '/products/123', big ? { data: { id: 123 } } : { product: { id: '123' } }],
      ['variants.list', { product_id: '123' }, big ? '/v3/catalog/products/123/variants' : line ? '/products/123/variants.json' : '/products/123/variants', big ? { data: [] } : { variants: [] }],
      ['orders.list', { limit: 20 }, big ? '/v2/orders' : line ? '/orders.json' : '/orders', big ? [] : { orders: [] }],
      ['orders.get', { order_id: '123' }, big ? '/v2/orders/123' : line ? '/orders.json' : '/orders/123', big ? { id: 123 } : line ? { orders: [{ id: '123' }] } : { order: { id: '123' } }],
      ['locations.list', {}, big ? '/v3/inventory/locations' : line ? '/locations/list.json' : '/locations', big ? { data: [] } : { locations: [] }],
      ['inventory.list', big ? { location_id: '123' } : { inventory_item_ids: ['123', '456'], location_ids: ['7', '8'] }, big ? '/v3/inventory/locations/123/items' : line ? '/inventory_levels.json' : '/inventory_levels', big ? { data: [] } : { inventory_levels: [] }],
    ];
    for (const [name, params, suffix, body] of rows) {
      const mock = vi.fn(async () => reply(wrap(provider, body))); vi.stubGlobal('fetch', mock);
      await api.execute(c, name, params);
      expect(mock).toHaveBeenCalledTimes(1);
      const [target, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
      const url = new URL(target);
      expect(url.pathname.endsWith(suffix), name).toBe(true);
      expect(target.startsWith(api.apiBase(provider, c.metadata) + '/')).toBe(true);
      expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
      expect(init.headers).toMatchObject({ [big ? 'X-Auth-Token' : line ? 'Authorization' : 'Access-Token']: line ? `Bearer ${TOKEN}` : TOKEN });
      expect(url.search).not.toContain(TOKEN);
      if (name === 'inventory.list' && !big) expect(url.searchParams.getAll('inventory_item_ids')).toEqual(line ? ['123,456'] : ['123', '456']);
      if (name === 'orders.get' && line) expect(url.searchParams.get('ids')).toBe('123');
    }
  });

  it.each(providers)('%s verifies identity and returns only safe store metadata', async (provider) => {
    const shop = { id: '123', name: 'Fixture', currency: 'USD', email: 'owner@private.test', access_token: TOKEN };
    vi.stubGlobal('fetch', vi.fn(async () => reply(wrap(provider, provider === 'shopline' ? { data: shop } : shop))));
    const result = await api.execute(config(provider), 'shop.get');
    expect(result).toEqual({ binding: Object.values(metadata(provider))[0], shop_id: '123', name: 'Fixture', currency: 'USD' });
  });

  it.each(providers)('%s supports absolute zero inventory with one write and no retry', async (provider) => {
    const big = provider === 'bigcommerce'; const line = provider === 'shopline';
    const mock = vi.fn(async () => reply(wrap(provider, big ? { transaction_id: 'tx-1' } : { inventory_level: { stock: 0 } })));
    vi.stubGlobal('fetch', mock);
    const result = await api.execute(config(provider), 'inventory.set', { location_id: '7', [big ? 'variant_id' : 'inventory_item_id']: '123', quantity: 0 });
    if (big) expect(result).toMatchObject({ status: 'accepted', data: { transaction_id: 'tx-1' }, follow_up: expect.stringContaining('asynchronously') });
    const [target, init] = mock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe(big ? 'PUT' : 'POST');
    expect(new URL(target).pathname.endsWith(big ? '/v3/inventory/adjustments/absolute' : line ? '/inventory_levels/set.json' : '/inventory_levels/set')).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual(big ? { items: [{ location_id: 7, variant_id: 123, quantity: 0 }], reason: 'Orkas confirmed absolute inventory update' }
      : { inventory_item_id: '123', location_id: '7', [line ? 'available' : 'stock']: 0 });
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockRejectedValueOnce(new Error(`timeout ${TOKEN}`));
    await expect(api.execute(config(provider), 'inventory.set', { location_id: '7', [big ? 'variant_id' : 'inventory_item_id']: '123', quantity: 1 })).rejects.toThrow(/outcome may be unknown/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it.each(providers)('%s sends only the confirmed base price and preserves required existing images', async (provider) => {
    const mock = vi.fn(async (_url: string, init: RequestInit) => reply(wrap(provider, provider === 'bigcommerce' ? { data: { id: 123, price: 0 } }
      : { variant: { id: '123', price: 0, ...(init.method === 'GET' ? { image: { src: 'https://cdn.shoplazza.com/existing.png', alt: 'Old image' } } : {}) } })));
    vi.stubGlobal('fetch', mock);
    await api.execute(config(provider), 'variants.set_price', { variant_id: '123', price: '0.00', ...(provider === 'bigcommerce' ? { product_id: '456' } : {}) });
    const [url, init] = mock.mock.calls.at(-1)!;
    expect(init.method).toBe('PUT');
    expect(new URL(url).pathname.endsWith(provider === 'bigcommerce' ? '/v3/catalog/products/456/variants/123' : provider === 'shopline' ? '/products/variants/123.json' : '/variants/123')).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual(provider === 'bigcommerce' ? { price: 0 } : { variant: { price: provider === 'shopline' ? '0.00' : 0,
      ...(provider === 'shoplazza' ? { image: { src: 'https://cdn.shoplazza.com/existing.png' } } : {}) } });
    expect(mock).toHaveBeenCalledTimes(provider === 'shoplazza' ? 2 : 1);
  });

  it.each([
    ['products.get', { product_id: '../orders' }], ['products.get', { product_id: '%2fadmin' }],
    ['products.list', { limit: 101 }], ['products.list', { url: 'https://evil.test' }],
    ['inventory.list', { inventory_item_ids: Array(101).fill('123') }],
    ['variants.set_price', { variant_id: '123', price: '-1' }],
    ['variants.set_price', { variant_id: '123', price: '1e3' }],
    ['variants.set_price', { variant_id: '123', price: '0.001' }],
    ['inventory.set', { inventory_item_id: '123', location_id: '7', quantity: -1 }],
    ['arbitrary.request', {}],
  ])('fails closed for %s with unsafe parameters', async (name, params) => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    await expect(api.execute(config('shopline'), name, params)).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 429, 500, 302])('does not expose upstream error bodies or retry HTTP %s', async (status) => {
    const mock = vi.fn(async () => reply({ message: TOKEN }, status)); vi.stubGlobal('fetch', mock);
    await expect(api.execute(config('shopline'), 'products.list')).rejects.toThrow(`HTTP ${status}`);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it.each([{ errors: { token: TOKEN } }, { code: 'PermissionDenied', data: { products: [] } }, { data: {} }, '<html>login</html>'])('does not confuse an HTTP-200 error with a valid list', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(body)));
    await expect(api.execute(config('shoplazza'), 'products.list')).rejects.toThrow(/error|shape|JSON/);
  });

  it('preserves pagination and strips consumer details and secret echoes', async () => {
    const target = api.apiBase('shopline', metadata('shopline'));
    vi.stubGlobal('fetch', vi.fn(async () => reply({ orders: [{ id: '123', total_price: '10.00', email: 'buyer@private.test', shipping_address: { name: 'Buyer' }, customer: { phone: '123' }, private_token: TOKEN, line_items: [{ sku: 'sku-1', quantity: 1 }] }] }, 200,
      { link: `<${target}/orders.json?page_info=next-page>; rel="next"` })));
    const result = await api.execute(config('shopline'), 'orders.list', { cursor: 'previous-page' });
    expect(result.next_cursor).toBe('next-page');
    expect(result.data.orders[0]).toEqual({ id: '123', total_price: '10.00', line_items: [{ sku: 'sku-1', quantity: 1 }] });
    expect(JSON.stringify(result)).not.toMatch(/private|Buyer|token/);
  });

  it('preserves Shoplazza cursors, rejects off-origin next links, and handles an empty BigCommerce store', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(wrap('shoplazza', { products: [], cursor: 'next', has_more: true }), 200, { link: '<https://evil.test/products?page_info=bad>; rel="next"' })));
    expect(await api.execute(config('shoplazza'), 'products.list')).toEqual({ data: { products: [], cursor: 'next', has_more: true } });
    vi.stubGlobal('fetch', vi.fn(async () => reply(null, 204)));
    expect(await api.execute(config('bigcommerce'), 'orders.list')).toEqual({ data: [] });
  });

  it('resolves Shoplazza variants to inventory item IDs before reading or setting stock', async () => {
    const mock = vi.fn(async () => reply({ code: '', data: { variant_inventory_items: [{ variant_id: 'variant-1', inventory_item_id: 'item-1' }] } }));
    vi.stubGlobal('fetch', mock);
    expect(await api.execute(config('shoplazza'), 'inventory.items_for_variants', { variant_ids: ['variant-1', 'variant-2'] })).toMatchObject({ data: { variant_inventory_items: [{ variant_id: 'variant-1', inventory_item_id: 'item-1' }] } });
    const target = new URL((mock.mock.calls[0] as unknown as [string])[0]);
    expect(target.pathname).toBe('/openapi/2026-01/inventory_items/variant');
    expect(target.searchParams.getAll('variant_ids')).toEqual(['variant-1', 'variant-2']);
  });

  it('rejects an unacknowledged BigCommerce write without claiming stock was updated', async () => {
    const mock = vi.fn(async () => reply({})); vi.stubGlobal('fetch', mock);
    await expect(api.execute(config('bigcommerce'), 'inventory.set', { location_id: '7', variant_id: '123', quantity: 0 })).rejects.toThrow(/acknowledgement/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized responses without returning partial success or leaking contents', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ products: [{ description: 'x'.repeat(1024 * 1024) }] })));
    await expect(api.execute(config('shopline'), 'products.list')).rejects.toThrow(/oversized JSON/);
  });
});
