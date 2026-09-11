import { createRequire } from 'node:module';
import { createHmac, createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP, SECRET, TOKEN, SHEIN_KEY, SHEIN_SECRET, rows, config, installFixture, providerReply, sheinEncryptedSecret } from './merchant-platform-fixtures';

const require = createRequire(import.meta.url);
const api = require('../../../../bin/merchant-platform-api.cjs');
const lazada = require('../../../../bin/lazada-seller-api.cjs');
const temu = require('../../../../bin/temu-seller-api.cjs');
const shein = require('../../../../bin/shein-seller-api.cjs');
const alibaba = require('../../../../bin/alibaba-icbu-api.cjs');
const magento = require('../../../../bin/magento-admin-api.cjs');
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe.each(rows)('$provider merchant API contracts', (row) => {
  it('verifies useful read permissions, binds the grant and exposes only reviewed R/H actions', async () => {
    const fetchMock = installFixture(row);
    const c = { ...config(row), credentials: await api.authorize(config(row)) };
    expect(fetchMock).toHaveBeenCalledTimes(row.authCalls);
    expect(c.credentials.provider).toBe(row.provider);
    expect(c.credentials.identity).toBeTruthy();
    expect(c.credentials).not.toHaveProperty('redirect_uri');
    expect(JSON.stringify(c.credentials)).not.toContain('one-use-code');
    expect(JSON.stringify(c.credentials)).not.toContain('private@example.com');
    expect(Object.keys(api.actionsFor(row.provider))).toHaveLength(row.count);
    expect(Object.values(api.actionsFor(row.provider)).every((spec: any) => ['R', 'H'].includes(spec.risk) && spec.input_schema.additionalProperties === false)).toBe(true);
    const result = await api.execute(c, 'products.list', { limit: 1 });
    expect(JSON.stringify(result)).toContain('Fixture product');
    for (const [, init] of fetchMock.mock.calls) {
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(fetchMock.mock.calls.some(([url, init]) => /stock.edit|change-inventory|update.display|base-prices/.test(String(url) + String(init?.body)))).toBe(false);
  });
  it.each([401, 403, 429, 500])('rejects HTTP %i without exposing provider secrets', async (status) => {
    const fetchMock = installFixture(row);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: TOKEN }), { status }));
    await expect(api.authorize(config(row))).rejects.toMatchObject({ code: expect.stringMatching(/^storefront_/), message: expect.not.stringContaining(TOKEN) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('rejects unknown actions, extra fields and binding tampering before sending credentials', async () => {
    const fetchMock = installFixture(row);
    const c = { ...config(row), credentials: await api.authorize(config(row)) };
    fetchMock.mockClear();
    await expect(api.execute(c, 'http.request', {})).rejects.toThrow(/Unreviewed/);
    await expect(api.execute(c, 'products.list', { limit: 1, access_token: 'override' })).rejects.toThrow(/parameters/);
    await expect(api.execute({ ...c, metadata: { ...c.metadata, base_url: 'https://evil.example' } }, 'products.list')).rejects.toThrow();
    await expect(api.execute({ ...c, credentials: { ...c.credentials, provider: 'other' } }, 'products.list')).rejects.toThrow(/binding|grant/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(['{}', '{broken', JSON.stringify({ message: TOKEN, success: false, code: 'AccessDenied' }), JSON.stringify({ data: 'x'.repeat(1024 * 1024) })])('does not accept malformed, failed or oversized responses', async (reply) => {
    const fetchMock = installFixture(row);
    const c = { ...config(row), credentials: await api.authorize(config(row)) };
    fetchMock.mockResolvedValueOnce(new Response(reply));
    await expect(api.execute(c, 'products.list', { limit: 1 })).rejects.toThrow();
  });
});

describe('provider signatures and token interpretation', () => {
  it('uses the published Lazada path prefix, UTF-8 sorting and uppercase HMAC-SHA256', () => {
    const expected = createHmac('sha256', 'secret').update('/products/getapp_key123filteralllimit10timestamp123456').digest('hex').toUpperCase();
    expect(lazada.sign('/products/get', { timestamp: '123456', limit: 10, filter: 'all', app_key: '123' }, 'secret')).toBe(expected);
    expect(lazada.sign('/orders/get', { timestamp: '123456', limit: 10, filter: 'all', app_key: '123' }, 'secret')).not.toBe(expected);
  });
  it('uses Temu compact nested JSON between two app-secret copies and uppercase MD5', () => {
    const expected = createHash('md5').update('secretapp_key123skuStockTargetList[{"stockTarget":0,"skuId":5}]timestamp123secret').digest('hex').toUpperCase();
    expect(temu.sign({ timestamp: '123', skuStockTargetList: [{ stockTarget: 0, skuId: 5 }], app_key: '123' }, 'secret')).toBe(expected);
  });
  it('uses SHEIN base64 of hexadecimal HMAC text, not base64 of raw bytes, and decrypts the official AES layout', () => {
    const expected = 'test1' + Buffer.from(createHmac('sha256', SHEIN_SECRET + 'test1').update(`${SHEIN_KEY}&1740709414000&/open-api/goods/searchProduct`).digest('hex')).toString('base64');
    expect(shein.signature(SHEIN_KEY, SHEIN_SECRET, '1740709414000', '/open-api/goods/searchProduct', 'test1')).toBe(expected);
    expect(shein.decryptSecret(sheinEncryptedSecret(), SECRET)).toBe(SHEIN_SECRET);
    expect(() => shein.decryptSecret(sheinEncryptedSecret(), 'wrong-private-secret')).toThrow(/decrypted/);
  });
  it('uses TOP HMAC-MD5 without a REST path prefix for Alibaba.com', () => {
    expect(alibaba.sign({ session: 'token', method: 'alibaba.icbu.product.list', app_key: '123' }, 'secret')).toBe(createHmac('md5', 'secret').update('app_key123methodalibaba.icbu.product.listsessiontoken').digest('hex').toUpperCase());
  });
  it('signs Magento query parameters with RFC3986 escaping, including spaces and duplicate values', () => {
    const credentials = { consumer_key: 'key', consumer_secret: 'secret', access_token: 'token', token_secret: 'token-secret' };
    const normalized = 'a=hello%20world&a=z&oauth_consumer_key=key&oauth_nonce=nonce&oauth_signature_method=HMAC-SHA256&oauth_timestamp=123&oauth_token=token&oauth_version=1.0';
    const base = 'GET&https%3A%2F%2Fshop.example.com%2Frest%2FV1%2Fproducts&' + encodeURIComponent(normalized);
    const signature = createHmac('sha256', 'secret&token-secret').update(base).digest('base64');
    expect(magento.oauthHeader('GET', 'https://shop.example.com/rest/V1/products?a=z&a=hello+world', credentials, 'nonce', '123')).toContain(`oauth_signature="${encodeURIComponent(signature)}"`);
  });
});

describe('merchant pagination, data minimization and confirmed writes', () => {
  it('Temu accepts only details for the requested product or order', async () => {
    const row = rows[1], mock = installFixture(row), c = { ...config(row), credentials: await api.authorize(config(row)) };
    await expect(api.execute(c, 'products.get', { goods_id: 11 })).resolves.toMatchObject({ data: { goodsId: 11 } });
    await expect(api.execute(c, 'orders.get', { order_id: 'PO-11' })).resolves.toMatchObject({ data: { parentOrderMap: { parentOrderSn: 'PO-11' } } });
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: { goodsId: 12 } })));
    await expect(api.execute(c, 'products.get', { goods_id: 11 })).rejects.toThrow(/missing/);
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: { parentOrderMap: { parentOrderSn: 'PO-12' }, orderList: [] } })));
    await expect(api.execute(c, 'orders.get', { order_id: 'PO-11' })).rejects.toThrow(/missing/);
  });
  it('Temu enforces granted scopes, local-shop expiry, exact zero-stock payload and per-SKU acknowledgement', async () => {
    const row = rows[1], mock = installFixture(row), c = { ...config(row), credentials: await api.authorize(config(row)) };
    const p = { goods_id: 11, sku_id: 12, quantity: 0, request_key: 'change-001' };
    await api.execute(c, 'inventory.set', p);
    const sent = JSON.parse(mock.mock.calls.at(-1)![1]!.body as string);
    expect(sent).toMatchObject({ stockType: 0, goodsId: 11, skuStockTargetList: [{ stockTarget: 0, skuId: 12 }], requestUniqueKey: 'change-001' });
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, result: { operateResult: true, goodsId: 11, skuStockEditStatusInfoList: [{ skuId: 12, stockEditStatus: false, errorMsg: TOKEN }] } })));
    await expect(api.execute(c, 'inventory.set', p)).rejects.toThrow(/acknowledged/);
    const before = mock.mock.calls.length;
    await expect(api.execute({ ...c, credentials: { ...c.credentials, identity: { ...c.credentials.identity, scopes: [] } } }, 'inventory.set', p)).rejects.toThrow(/permission/);
    await expect(api.execute({ ...c, credentials: { ...c.credentials, identity: { ...c.credentials.identity, expires_at: 1 } } }, 'products.list', {})).rejects.toThrow(/expired/);
    expect(mock).toHaveBeenCalledTimes(before);
  });
  it('Lazada converts pagination and stock XML safely, retaining order totals but excluding notes, tax IDs and contact data', async () => {
    const row = rows[2], mock = installFixture(row), c = { ...config(row), credentials: await api.authorize(config(row)) };
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '0', data: { orders: [{ order_id: '11', price: '10', tax_code: 'private', recipient_info: { identify_no: 'private' }, remarks: 'private' }], countTotal: '42', count: '1' } })));
    expect(await api.execute(c, 'orders.list', { created_after: '2026-09-01T00:00:00+08:00', offset: 1, limit: 1 })).toEqual({ data: { orders: [{ order_id: '11', price: '10' }], countTotal: '42', count: '1' }, offset: 1, limit: 1 });
    await api.execute(c, 'inventory.set', { item_id: '11', sku_id: '12', quantity: 0, warehouse_code: 'WH-1' });
    expect(new URLSearchParams(mock.mock.calls.at(-1)![1]!.body as string).get('payload')).toBe('<Request><Product><Skus><Sku><ItemId>11</ItemId><SkuId>12</SkuId><MultiWarehouseInventories><MultiWarehouseInventory><WarehouseCode>WH-1</WarehouseCode><SellableQuantity>0</SellableQuantity></MultiWarehouseInventory></MultiWarehouseInventories></Sku></Skus></Product></Request>');
    const before = mock.mock.calls.length;
    await expect(api.execute(c, 'inventory.set', { item_id: '11', sku_id: '12', quantity: 0, warehouse_code: '</Sku>' })).rejects.toThrow();
    await expect(api.execute(c, 'orders.list', {})).rejects.toThrow();
    expect(mock).toHaveBeenCalledTimes(before);
  });
  it('SHEIN converts epoch time to UTC+8, rejects overlong windows and checks merchant warehouse/partial failure on v2 inventory', async () => {
    const row = rows[3], mock = installFixture(row), c = { ...config(row), credentials: await api.authorize(config(row)) };
    await api.execute(c, 'orders.list', { start_time: 1788220800, end_time: 1788224400, page: 2, limit: 2 });
    expect(JSON.parse(mock.mock.calls.at(-1)![1]!.body as string)).toEqual({ startTime: '2026-09-01 08:00:00', endTime: '2026-09-01 09:00:00', queryType: 1, queryOrderType: 4, page: 2, pageSize: 2 });
    const p = { sku_code: 'SKU-1', warehouse_code: 'WH-1', quantity: 1, request_key: 'change-001' };
    expect(await api.execute(c, 'inventory.overwrite', p)).toMatchObject({ data: { status: 'acknowledged', requested_total: 1 } });
    expect(JSON.parse(mock.mock.calls.at(-1)![1]!.body as string)).toEqual({ updateSkuInventoryQuantityRequests: [{ idempotencyKey: 'change-001', skuCode: 'SKU-1', invType: 'VI', warehouseCode: 'WH-1', changeType: 'OVERWRITE', changeQuantity: 1 }] });
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '0', info: { list: [{ warehouseCode: 'WH-1', warehouseType: '2' }] } })));
    await expect(api.execute(c, 'inventory.overwrite', p)).rejects.toThrow(/merchant warehouse/);
    const before = mock.mock.calls.length;
    await expect(api.execute(c, 'orders.list', { start_time: 1788220800, end_time: 1788220800 + 172801 })).rejects.toThrow(/48 hours/);
    expect(mock).toHaveBeenCalledTimes(before);
    mock.mockImplementationOnce(async (url, init) => new Response(JSON.stringify(providerReply('shein', url, init))));
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '0', info: { failedList: [{ skuCode: 'SKU-1', reason: TOKEN }] } })));
    await expect(api.execute(c, 'inventory.overwrite', p)).rejects.toThrow(/acknowledged/);
  });
  it('Alibaba.com requests seller-role orders with zero-based paging and rejects conflicting success/error acknowledgements', async () => {
    const row = rows[4], mock = installFixture(row), c = { ...config(row), credentials: await api.authorize(config(row)) };
    expect(await api.execute(c, 'orders.list', { page: 2, limit: 3 })).toEqual({ data: { orders: [], total: 0, page: 2, limit: 3 } });
    expect(JSON.parse(new URLSearchParams(mock.mock.calls.at(-1)![1]!.body as string).get('param_trade_ecology_order_list_query')!)).toEqual({ role: 'seller', start_page: 1, page_size: 3 });
    await api.execute(c, 'products.set_visibility', { product_id: 'opaque-11', visibility: 'off' });
    expect(new URLSearchParams(mock.mock.calls.at(-1)![1]!.body as string).get('product_id_list')).toBe('opaque-11');
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ alibaba_icbu_product_batch_update_display_response: { sub_success: true, sub_error_code: 'ERROR' } })));
    await expect(api.execute(c, 'products.set_visibility', { product_id: 'opaque-11', visibility: 'off' })).rejects.toThrow(/acknowledged/);
  });
  it.each(rows.filter((row) => !['magento', 'aliexpress'].includes(row.provider)))('$provider never retries an uncertain write or echoes private network error text', async (row) => {
    const mock = installFixture(row), c = { ...config(row), credentials: await api.authorize(config(row)) };
    const name = row.provider === 'shein' ? 'inventory.overwrite' : row.provider === 'alibaba_icbu' ? 'products.set_visibility' : 'inventory.set';
    const params = row.provider === 'shein' ? { sku_code: 'SKU-1', warehouse_code: 'WH-1', quantity: 1, request_key: 'change-001' } : row.provider === 'alibaba_icbu' ? { product_id: 'opaque-11', visibility: 'off' } : row.provider === 'lazada' ? { item_id: '11', sku_id: '12', quantity: 0 } : { goods_id: 11, sku_id: 12, quantity: 0, request_key: 'change-001' };
    mock.mockClear();
    if (row.provider === 'shein') mock.mockImplementationOnce(async (url, init) => new Response(JSON.stringify(providerReply(row.provider, url, init))));
    mock.mockRejectedValueOnce(new Error(TOKEN));
    await expect(api.execute(c, name, params)).rejects.toMatchObject({ code: 'storefront_network_failed', message: expect.not.stringContaining(TOKEN) });
    expect(mock).toHaveBeenCalledTimes(row.provider === 'shein' ? 2 : 1);
  });
});
