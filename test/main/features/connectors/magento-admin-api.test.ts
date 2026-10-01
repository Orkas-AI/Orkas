import { createRequire } from 'node:module';
import { promises as dns } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const api = require('../../../../bin/magento-admin-api.cjs');
const credentials = { consumer_key: 'consumer-fixture', consumer_secret: 'consumer-secret-fixture', access_token: 'access-token-fixture', token_secret: 'token-secret-fixture' };
const config = () => ({ provider: 'magento', metadata: { store_url: 'https://shop.example.com/magento' }, credentials: { ...credentials } });
const stores = [{ id: 1, code: 'default', website_id: 1, base_currency_code: 'USD', secure_base_url: 'https://shop.example.com/magento/' }];
function fixture() {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  const fetchMock = vi.fn(async (target: string, init: RequestInit) => {
    const url = new URL(target);
    expect(url.origin).toBe('https://shop.example.com');
    expect(url.pathname).toMatch(/^\/magento\/rest\/V1\//);
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toMatch(/^OAuth .*oauth_signature_method="HMAC-SHA256"/);
    expect(target).not.toContain(credentials.access_token);
    const data = url.pathname.endsWith('storeConfigs') ? stores : init.method === 'POST' ? [] : { items: [], total_count: 0 };
    return new Response(JSON.stringify(data));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Magento merchant-owned integration', () => {
  it('verifies useful read access without changing store security or performing a test write', async () => {
    const fetchMock = fixture();
    const result = await api.authorize(config());
    expect(result).toMatchObject({ provider: 'magento', identity: { binding: 'https://shop.example.com/magento', stores: [{ id: 1, currency: 'USD' }] } });
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual(['/magento/rest/V1/store/storeConfigs', '/magento/rest/V1/products', '/magento/rest/V1/orders', '/magento/rest/V1/inventory/sources']);
    expect(fetchMock.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it.each(['http://shop.example.com', 'https://localhost', 'https://127.0.0.1', 'https://shop.local', 'https://user@shop.example.com', 'https://shop.example.com:444', 'https://shop.example.com/rest/V1', 'https://shop.example.com/a/../b', 'https://shop.example.com/%2e%2e', 'https://shop.example.com/?token=x'])('rejects unsafe installation URL %s before credential use', (url) => {
    expect(() => api.normalizeBinding(url)).toThrow(/Magento|HTTPS/);
  });

  it.each(['10.0.0.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', '2001:db8::1'])('rejects a public-looking domain resolving to %s without sending credentials', async (address) => {
    const fetchMock = fixture();
    vi.mocked(dns.lookup).mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }] as never);
    await expect(api.authorize(config())).rejects.toThrow(/public/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses exact Adobe price/source-item envelopes including zero stock and refuses partial acknowledgement', async () => {
    const fetchMock = fixture();
    const bound = { ...config(), credentials: await api.authorize(config()) };
    await expect(api.execute(bound, 'products.set_price', { sku: '24-UG04', store_id: 0, price: '12.00' })).resolves.toEqual({ status: 'completed' });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string)).toEqual({ prices: [{ price: 12, store_id: 0, sku: '24-UG04' }] });
    await api.execute(bound, 'inventory.set', { sku: '24-UG04', source_code: 'default', quantity: 0, status: 0 });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string)).toEqual({ sourceItems: [{ sku: '24-UG04', source_code: 'default', quantity: 0, status: 0 }] });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ message: credentials.access_token }])));
    await expect(api.execute(bound, 'products.set_price', { sku: '24-UG04', store_id: 0, price: '12' })).rejects.toThrow(/acknowledged/);
  });

  it('preserves full order fulfilment, amounts, business notes and exact IDs while removing credentials', async () => {
    const fetchMock = fixture();
    const bound = { ...config(), credentials: await api.authorize(config()) };
    const order = { entity_id: 21, increment_id: '10021', grand_total: 49.25, customer_email: 'buyer@example.com', billing_address: { firstname: 'Fixture', street: ['Fixture road'], telephone: '1234567' }, payment: { method: 'checkmo', amount_ordered: 49.25, extension_attributes: { provider_reference: 'payment-1' }, access_token: 'not-for-output' }, status_histories: [{ comment: 'Keep this business note' }], extension_attributes: { shipping_assignments: [{ shipping: { address: { city: 'Fixture city' } } }] }, items: [{ sku: '24-UG04', qty_ordered: 2 }] };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [order], total_count: 105, search_criteria: { page_size: 50, current_page: 2 } })));
    const result = await api.execute(bound, 'orders.list', { page: 2, limit: 50 });
    const { access_token: ignored, ...payment } = order.payment; void ignored;
    expect(result).toEqual({ data: { items: [{ ...order, payment }], total_count: 105, search_criteria: { page_size: 50, current_page: 2 } }, page: 2, limit: 50 });
    fetchMock.mockResolvedValueOnce(new Response('{"entity_id":21,"extension_attributes":{"external_order_id":9007199254740993},"customer_note":"access-token-fixture should be redacted"}'));
    expect(await api.execute(bound, 'orders.get', { order_id: 21 })).toEqual({ data: { entity_id: 21, extension_attributes: { external_order_id: '9007199254740993' }, customer_note: '[redacted] should be redacted' } });
    fetchMock.mockResolvedValueOnce(new Response('{"entity_id":21,"extension_attributes":{"external_order_id":9.007199254740993e15}}'));
    await expect(api.execute(bound, 'orders.get', { order_id: 21 })).rejects.toMatchObject({ code: 'storefront_upstream_error' });
  });

  it('returns complete sources, products and shop configuration without storing them in the credential identity', async () => {
    const fetchMock = fixture();
    const bound = { ...config(), credentials: await api.authorize(config()) };
    expect(bound.credentials.identity).not.toHaveProperty('data');
    expect(await api.execute(bound, 'shop.get')).toMatchObject({ data: stores, stores: [{ id: 1, code: 'default' }] });
    const source = { source_code: 'default', name: 'Warehouse', email: 'warehouse@example.com', phone: '1234567', contact_name: 'Fixture operator', street: 'Fixture road', carrier_links: [{ carrier_code: 'flat_rate', position: 1 }], extension_attributes: { frontend_description: 'Pickup notes' } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ items: [source], total_count: 1 })));
    expect((await api.execute(bound, 'sources.list')).data.items[0]).toEqual(source);
    const product = { sku: '24-UG04', price: 12.25, custom_attributes: [{ attribute_code: 'manufacturer_email', value: 'factory@example.com' }], extension_attributes: { gift_note: 'Keep this note', consumer_secret: 'private' } };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(product)));
    expect((await api.execute(bound, 'products.get', { sku: '24-UG04' })).data).toEqual({ ...product, extension_attributes: { gift_note: 'Keep this note' } });
  });

  it('rejects changed binding and forged action parameters before side effects; uncertain writes are not retried', async () => {
    const fetchMock = fixture();
    const bound = { ...config(), credentials: await api.authorize(config()) };
    fetchMock.mockClear();
    await expect(api.execute({ ...bound, metadata: { store_url: 'https://other.example.com' } }, 'products.list', {})).rejects.toThrow(/binding/);
    await expect(api.execute(bound, 'inventory.set', { sku: 'abc', source_code: 'default', quantity: 1, status: 1, url: 'https://evil.example' })).rejects.toThrow(/parameter/);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRejectedValueOnce(new TypeError('upstream includes access-token-fixture'));
    await expect(api.execute(bound, 'inventory.set', { sku: 'abc', source_code: 'default', quantity: 1, status: 1 })).rejects.toThrow('Magento request failed; check the store before retrying an uncertain write');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
