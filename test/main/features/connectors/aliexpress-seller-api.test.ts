import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP, SECRET, TOKEN, REFRESH, rows, config, installFixture, providerReply } from './merchant-platform-fixtures';

const api = createRequire(import.meta.url)('../../../../bin/aliexpress-seller-api.cjs');
const row = rows.find(row => row.provider === 'aliexpress')!;
const wrap = (method: string, data: unknown) => new Response(JSON.stringify({ [method.replaceAll('.', '_') + '_response']: data }));
const PRODUCT = 'aliexpress.solution.product.info.get';
const STOCK = 'aliexpress.solution.batch.product.inventory.update';
const stock = { product_id: '11', sku_code: 'SKU-1', quantity: 0 };
async function connected() {
  const mock = installFixture(row);
  const c = { ...config(row), credentials: await api.authorize(config(row)) };
  mock.mockClear();
  return { mock, c };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('AliExpress seller authorization and protocol', () => {
  it('uses SDK dot-method signing without a path prefix, and official REST token signing with a path prefix', () => {
    const method = 'aliexpress.solution.product.info.get';
    const values = { method, app_key: '123', product_id: '456', sign_method: 'sha256', timestamp: '1788220800000', session: 'seller-token' };
    const text = 'app_key123methodaliexpress.solution.product.info.getproduct_id456sessionseller-tokensign_methodsha256timestamp1788220800000';
    expect(api.sign(method, values, 'secret')).toBe(createHmac('sha256', 'secret').update(text).digest('hex').toUpperCase());
    expect(api.sign('/auth/token/create', { app_key: '123', code: 'one-use', sign: 'ignored' }, 'secret')).toBe(createHmac('sha256', 'secret').update('/auth/token/createapp_key123codeone-use').digest('hex').toUpperCase());
    expect(api.sign('/sync', values, 'secret')).not.toBe(api.sign(method, values, 'secret'));
  });
  it('separates seller OAuth from sync business requests and never sends credentials to the old TOP gateway', async () => {
    const mock = installFixture(row);
    await api.authorize(config(row));
    expect(mock.mock.calls.map(([url]) => String(url))).toEqual(['https://api-sg.aliexpress.com/rest/auth/token/create', ...Array(3).fill('https://api-sg.aliexpress.com/sync')]);
    const form = new URLSearchParams(mock.mock.calls[2][1]!.body as string);
    expect(Object.fromEntries(form)).toMatchObject({ method: 'aliexpress.solution.product.list.get', session: TOKEN, simplify: 'false', format: 'json', sign_method: 'sha256', app_key: APP });
    expect(form.has('app_secret')).toBe(false);
    expect(form.has('access_token')).toBe(false);
    expect(JSON.parse(form.get('aeop_a_e_product_list_query')!)).toEqual({ current_page: 1, page_size: 1, product_status_type: 'onSelling' });
    const signed = Object.fromEntries(form);
    expect(signed.sign).toBe(createHmac('sha256', SECRET).update(Object.keys(signed).filter(key => key !== 'sign').sort().map(key => key + signed[key]).join('')).digest('hex').toUpperCase());
  });
  it.each([0, 1, 2, 3])('requires authorization/profile/product/order probes to succeed (failure at %i)', async (failure) => {
    const mock = installFixture(row);
    let index = 0;
    mock.mockImplementation(async (url, init) => index++ === failure ? new Response(JSON.stringify({ error_response: { code: 'InsufficientPermission', msg: SECRET } })) : new Response(JSON.stringify(providerReply(row.provider, url, init))));
    await expect(api.authorize(config(row))).rejects.toMatchObject({ code: 'storefront_permission_denied', message: expect.not.stringContaining(SECRET) });
    expect(mock).toHaveBeenCalledTimes(failure + 1);
  });
  it.each([{ account_platform: 'buyer' }, { seller_id: '' }, { refresh_expires_in: -1 }, { expires_in: 0 }, { expires_in: Number.MAX_SAFE_INTEGER }, { refresh_token: '' }])('rejects incomplete/non-seller grants: %j', async (override) => {
    const mock = installFixture(row);
    mock.mockImplementationOnce(async (url, init) => new Response(JSON.stringify({ ...providerReply(row.provider, url, init) as object, ...override })));
    await expect(api.authorize(config(row))).rejects.toThrow(/seller authorization/);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('retains exact large integer IDs and does not rewrite number-like text', () => {
    expect(api.parseJSON('{"id":9007199254740993,"title":"order 9007199254740993","count":2}')).toEqual({ id: '9007199254740993', title: 'order 9007199254740993', count: 2 });
    expect(() => api.parseJSON('{"id":9007199254740993 trailing}')).toThrow();
    expect(() => api.parseJSON('{"id":1e999}')).toThrow();
  });
});

describe('AliExpress useful reads and safe stock writes', () => {
  it('converts order windows to Pacific standard/daylight time and explicitly requests closed orders', async () => {
    const { mock, c } = await connected();
    expect(api.pacificTime(Date.parse('2026-01-01T08:00:00Z') / 1000)).toBe('2026-01-01 00:00:00');
    expect(api.pacificTime(Date.parse('2026-07-01T07:00:00Z') / 1000)).toBe('2026-07-01 00:00:00');
    await api.execute(c, 'orders.list', { created_after: 1788220800, created_before: 1788224400, page: 2, limit: 3, status: 'FINISH' });
    expect(JSON.parse(new URLSearchParams(mock.mock.calls[0][1]!.body as string).get('param0')!)).toEqual({ current_page: 2, page_size: 3, create_date_start: '2026-08-31 17:00:00', create_date_end: '2026-08-31 18:00:00', order_status: 'FINISH' });
    mock.mockClear();
    await expect(api.execute(c, 'orders.list', {})).rejects.toThrow();
    await expect(api.execute(c, 'orders.list', { created_after: 1788220800, created_before: 1788220800 })).rejects.toThrow(/time range/);
    expect(mock).not.toHaveBeenCalled();
  });
  it('preserves page counts and rejects a missing list when the requested page has products', async () => {
    const { mock, c } = await connected();
    mock.mockResolvedValueOnce(wrap('aliexpress.solution.product.list.get', { result: { success: true, current_page: 2, total_page: 3, product_count: 3, aeop_a_e_product_display_d_t_o_list: { item_display_dto: [{ product_id: 11, subject: 'Fixture product', owner_member_id: 'private-owner' }] } } }));
    expect(await api.execute(c, 'products.list', { page: 2, limit: 1, status: 'offline' })).toEqual({ data: { products: [{ product_id: 11, subject: 'Fixture product' }], total: 3, total_pages: 3, page: 2, limit: 1 } });
    mock.mockResolvedValueOnce(wrap('aliexpress.solution.product.list.get', { result: { success: true, current_page: 1, total_page: 1, product_count: 5 } }));
    await expect(api.execute(c, 'products.list')).rejects.toThrow(/pagination/);
  });
  it('uses an exact 64-bit order ID, disables optional buyer details and strips private fields even if returned', async () => {
    const { mock, c } = await connected();
    const id = '9007199254740993';
    mock.mockResolvedValueOnce(new Response('{"aliexpress_solution_order_info_get_response":{"result":{"data":{"id":9007199254740993,"order_status":"FINISH","receipt_address":{"phone":"private"},"buyer_info":{"id":"private"},"order_msg_list":{"content":"private"},"order_amount":{"amount":"9.99","currency_code":"USD"}}}}}'));
    expect(await api.execute(c, 'orders.get', { order_id: id })).toEqual({ data: { id, order_status: 'FINISH', order_amount: { amount: '9.99', currency_code: 'USD' } } });
    expect(new URLSearchParams(mock.mock.calls[0][1]!.body as string).get('param1')).toBe('{"order_id":9007199254740993,"ext_info_bit_flag":0}');
    mock.mockResolvedValueOnce(wrap('aliexpress.solution.order.info.get', { result: { success: true, data: { id: '12' } } }));
    await expect(api.execute(c, 'orders.get', { order_id: id })).rejects.toThrow(/missing/);
    mock.mockResolvedValueOnce(wrap('aliexpress.solution.order.info.get', { result: { error_code: 'F00-10-10000-001', error_message: TOKEN, data: { id } } }));
    await expect(api.execute(c, 'orders.get', { order_id: id })).rejects.toThrow(/missing/);
  });
  it('checks a unique product SKU before an exact zero-stock write and preserves a large product ID', async () => {
    const { mock, c } = await connected();
    const p = { ...stock, product_id: '9007199254740993' };
    expect(await api.execute(c, 'inventory.set', p)).toEqual({ data: { status: 'completed', ...p } });
    expect(mock).toHaveBeenCalledTimes(2);
    const form = new URLSearchParams(mock.mock.calls[1][1]!.body as string);
    expect(form.get('method')).toBe(STOCK);
    expect(form.get('mutiple_product_update_list')).toBe('[{"product_id":9007199254740993,"multiple_sku_update_list":[{"sku_code":"SKU-1","inventory":0}]}]');
  });
  it.each([[], [{ sku_code: 'other' }], [{ sku_code: 'SKU-1' }, { sku_code: 'SKU-1' }]].map(skus => ({ skus })))('never writes when SKU selection is absent or ambiguous: $skus', async ({ skus }) => {
    const { mock, c } = await connected();
    mock.mockResolvedValueOnce(wrap(PRODUCT, { result: { product_id: 11, aeop_ae_product_s_k_us: { global_aeop_ae_product_sku: skus } } }));
    await expect(api.execute(c, 'inventory.set', stock)).rejects.toThrow(/uniquely/);
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it.each([
    { update_success: false }, { update_success: true },
    { update_success: true, update_error_code: 'FAIL', update_successful_list: { synchronize_product_response_dto: [{ product_id: 11 }] } },
    { update_success: true, update_successful_list: { synchronize_product_response_dto: [{ product_id: 12 }] } },
    { update_success: true, update_successful_list: { synchronize_product_response_dto: [{ product_id: 11 }] }, update_failed_list: { synchronize_product_response_dto: [{ product_id: 11, error_message: TOKEN }] } },
  ])('rejects partial/contradictory/wrong-target acknowledgements without replay: %j', async (response) => {
    const { mock, c } = await connected();
    mock.mockImplementationOnce(async (url, init) => new Response(JSON.stringify(providerReply(row.provider, url, init))));
    mock.mockResolvedValueOnce(wrap(STOCK, response));
    await expect(api.execute(c, 'inventory.set', stock)).rejects.toMatchObject({ message: expect.stringContaining('not fully acknowledged') });
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('rejects a malformed SKU item before attempting a write', async () => {
    const { mock, c } = await connected();
    mock.mockResolvedValueOnce(wrap(PRODUCT, { result: { product_id: 11, aeop_ae_product_s_k_us: { global_aeop_ae_product_sku: [null] } } }));
    await expect(api.execute(c, 'inventory.set', stock)).rejects.toMatchObject({ code: 'storefront_invalid_response' });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('never retries an uncertain write, rejects invalid input before reading, and redacts provider exceptions', async () => {
    const { mock, c } = await connected();
    await expect(api.execute(c, 'inventory.set', { ...stock, quantity: -1 })).rejects.toThrow();
    await expect(api.execute(c, 'inventory.set', { ...stock, sku_code: 'bad\ncode' })).rejects.toThrow();
    expect(mock).not.toHaveBeenCalled();
    mock.mockImplementationOnce(async (url, init) => new Response(JSON.stringify(providerReply(row.provider, url, init))));
    mock.mockRejectedValueOnce(new Error(REFRESH));
    await expect(api.execute(c, 'inventory.set', stock)).rejects.toMatchObject({ code: 'storefront_network_failed', message: expect.stringContaining('inspect stock') });
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
