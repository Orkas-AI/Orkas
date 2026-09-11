import { createCipheriv } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { vi } from 'vitest';

// Provider-published response envelopes at external boundaries only. Application
// normalization, OAuth state handling, credential files and MCP routing remain real.
export const APP = 'merchant-fixture-app';
export const SECRET = 'merchant-fixture-secret';
export const TOKEN = 'merchant-private-access';
export const REFRESH = 'merchant-private-refresh';
export const SHEIN_KEY = 'merchant-private-open-key';
export const SHEIN_SECRET = 'merchant-private-shein-secret';
export const rows = [
  { id: 'magento', provider: 'magento', count: 9, authCalls: 4, input: { store_url: 'https://shop.example.com/magento', consumer_key: APP, consumer_secret: SECRET, access_token: TOKEN, token_secret: REFRESH }, metadata: { store_url: 'https://shop.example.com/magento' }, host: '' },
  { id: 'temu-seller', provider: 'temu', count: 7, authCalls: 3, input: { region: 'us', app_key: APP, app_secret: SECRET, access_token: TOKEN }, metadata: { region: 'us' }, host: '' },
  { id: 'lazada-seller', provider: 'lazada', count: 7, authCalls: 4, input: { country: 'sg', app_key: APP, app_secret: SECRET }, metadata: { country: 'sg' }, host: 'auth.lazada.com' },
  { id: 'shein-seller', provider: 'shein', count: 8, authCalls: 5, input: { app_id: APP, app_secret: SECRET }, metadata: {}, host: 'openapi-sem.sheincorp.com' },
  { id: 'alibaba-com-seller', provider: 'alibaba_icbu', count: 6, authCalls: 3, input: { app_key: APP, app_secret: SECRET }, metadata: {}, host: 'oauth.alibaba.com' },
  { id: 'aliexpress-seller', provider: 'aliexpress', count: 6, authCalls: 4, input: { app_key: APP, app_secret: SECRET }, metadata: {}, host: 'api-sg.aliexpress.com' },
] as const;
export type Row = typeof rows[number];
export const temuScopes = ['bg.open.accesstoken.info.get', 'bg.local.goods.list.query', 'bg.local.goods.detail.query', 'bg.order.list.v2.get', 'bg.order.detail.v2.get', 'temu.local.goods.sku.stock.query', 'bg.local.goods.stock.edit'];
export const config = (row: Row) => ({ provider: row.provider, metadata: { ...row.metadata }, credentials: { ...Object.fromEntries(Object.entries(row.input).filter(([key]) => !(key in row.metadata))), redirect_uri: 'https://orkas.ai/api/connectors/oauth/dcr-callback' }, oauthCode: 'one-use-code' });
export function sheinEncryptedSecret() {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(SECRET).subarray(0, 16), Buffer.from('space-station-de'));
  return Buffer.concat([cipher.update(SHEIN_SECRET), cipher.final()]).toString('base64');
}
export function providerReply(provider: string, raw: string | URL, init: RequestInit = {}): unknown {
  const url = new URL(String(raw));
  const form = new URLSearchParams(typeof init.body === 'string' ? init.body : url.search);
  if (provider === 'magento') {
    if (url.hostname !== 'shop.example.com' || !url.pathname.startsWith('/magento/rest/V1/')) throw new Error('Unexpected Magento host');
    if (url.pathname.endsWith('/store/storeConfigs')) return [{ id: 1, code: 'default', website_id: 1, base_currency_code: 'USD' }];
    if (init.method === 'POST') return [];
    if (url.pathname.endsWith('/products')) return { items: [{ id: 11, sku: 'SKU-1', name: 'Fixture product' }], total_count: 1 };
    if (['/orders', '/inventory/sources', '/inventory/source-items'].some((path) => url.pathname.endsWith(path))) return { items: [], total_count: 0 };
  }
  if (provider === 'temu') {
    if (url.origin !== 'https://openapi-b-us.temu.com' || url.pathname !== '/openapi/router') throw new Error('Unexpected Temu host');
    const body = JSON.parse(init.body as string);
    const replies: Record<string, unknown> = {
      'bg.open.accesstoken.info.get': { mallId: 123, expiredTime: Math.floor(Date.now() / 1000) + 7200, apiScopeList: temuScopes },
      'bg.local.goods.list.query': { goodsList: [{ goodsId: 11, goodsName: 'Fixture product' }], total: 1 },
      'bg.local.goods.detail.query': { goodsId: body.goodsId, goodsName: 'Fixture product' },
      'bg.order.list.v2.get': { pageItems: [], totalItemNum: 0 },
      'bg.order.detail.v2.get': { parentOrderMap: { parentOrderSn: body.parentOrderSn, parentOrderStatus: 2 }, orderList: [] },
      'temu.local.goods.sku.stock.query': { stockList: [] },
      'bg.local.goods.stock.edit': { goodsId: body.goodsId, operateResult: true, skuStockEditStatusInfoList: [{ skuId: body.skuStockTargetList?.[0]?.skuId, stockEditStatus: true }] },
    };
    if (body.type in replies) return { success: true, result: replies[body.type] };
  }
  if (provider === 'lazada') {
    if (url.hostname === 'auth.lazada.com' && ['/rest/auth/token/create', '/rest/auth/token/refresh'].includes(url.pathname)) return {
      code: '0', access_token: url.pathname.endsWith('/refresh') ? TOKEN + '-rotated' : TOKEN, refresh_token: REFRESH + (url.pathname.endsWith('/refresh') ? '-rotated' : ''), expires_in: 7200, refresh_expires_in: 86400,
      [url.pathname.endsWith('/refresh') ? 'country_user_info_list' : 'country_user_info']: [{ country: 'sg', seller_id: '123' }], country: 'sg', account: 'private@example.com',
    };
    if (url.hostname !== 'api.lazada.sg') throw new Error('Unexpected Lazada host');
    const replies: Record<string, unknown> = {
      '/rest/seller/get': { seller_id: '123', name: 'Fixture shop', email: 'private@example.com' },
      '/rest/products/get': { products: [{ item_id: '11', attributes: { name: 'Fixture product' } }], total_products: '1' },
      '/rest/product/item/get': { item_id: url.searchParams.get('item_id'), skus: [] },
      '/rest/orders/get': { orders: [], count: '0', countTotal: '0' },
      '/rest/order/get': { order_id: url.searchParams.get('order_id'), price: '10.00' },
      '/rest/order/items/get': [], '/rest/product/stock/sellable/update': {},
    };
    if (url.pathname in replies) return { code: '0', data: replies[url.pathname] };
  }
  if (provider === 'shein') {
    if (url.origin !== 'https://openapi.sheincorp.com') throw new Error('Unexpected SHEIN host');
    const body = init.body ? JSON.parse(init.body as string) : {};
    const replies: Record<string, unknown> = {
      '/open-api/auth/get-by-token': { appid: APP, openKeyId: SHEIN_KEY, secretKey: sheinEncryptedSecret(), supplierId: 123 },
      '/open-api/goods/query-site-list': { data: [{ main_site: 'shein', sub_site_list: [{ site_abbr: 'shein-us', currency: 'USD' }] }], meta: { count: 1 } },
      '/open-api/goods/searchProduct': { data: [{ spuName: body.spuNameList?.[0] || 'SPU-1', skcList: [], name: 'Fixture product' }], meta: { count: 1 } },
      '/open-api/order/order-list': { orderList: [], count: 0 },
      '/open-api/order/order-detail': [{ orderNo: body.orderNoList?.[0], orderStatus: 1 }],
      '/open-api/msc/warehouse/list': { list: [{ warehouseCode: 'WH-1', warehouseName: 'Main', warehouseType: '1' }] },
      '/open-api/stock/stock-query': { goodsInventory: [] },
      '/open-api/stock/change-inventory/v2': { failedList: [] },
    };
    if (url.pathname in replies) return { code: '0', info: replies[url.pathname] };
  }
  if (provider === 'alibaba_icbu') {
    if (url.origin === 'https://oauth.alibaba.com' && url.pathname === '/token') return { access_token: TOKEN + (form.get('grant_type') === 'refresh_token' ? '-rotated' : ''), refresh_token: REFRESH, expires_in: 7200, re_expires_in: 86400, taobao_user_id: '123' };
    if (url.origin !== 'https://eco.taobao.com' || url.pathname !== '/router/rest') throw new Error('Unexpected Alibaba.com host');
    const method = form.get('method')!;
    const replies: Record<string, unknown> = {
      'alibaba.icbu.product.list': { products: { alibaba_product_brief_response: [{ product_id: 'opaque-11', subject: 'Fixture product' }] }, total_item: 1, current_page: 1, page_size: 1 },
      'alibaba.icbu.product.get': { product: { product_id: form.get('product_id'), subject: 'Fixture product' } },
      'alibaba.seller.order.list': { result: { success: true, value: { total_count: 0 } } },
      'alibaba.seller.order.get': { value: { trade_id: form.get('e_trade_id'), trade_status: 'undeliver' } },
      'alibaba.icbu.product.batch.update.display': { sub_success: true },
    };
    if (method in replies) return { [method.replaceAll('.', '_') + '_response']: replies[method] };
  }
  if (provider === 'aliexpress') {
    if (url.origin !== 'https://api-sg.aliexpress.com') throw new Error('Unexpected AliExpress host');
    if (['/rest/auth/token/create', '/rest/auth/token/refresh'].includes(url.pathname)) return { code: '0', account_platform: 'seller_center', seller_id: '123', user_id: '123', access_token: TOKEN + (url.pathname.endsWith('/refresh') ? '-rotated' : ''), refresh_token: REFRESH + (url.pathname.endsWith('/refresh') ? '-rotated' : ''), expires_in: 7200, refresh_expires_in: 86400, account: 'private@example.com' };
    if (url.pathname !== '/sync') throw new Error('Unexpected AliExpress route');
    const method = form.get('method')!;
    const page = JSON.parse(form.get('aeop_a_e_product_list_query') || form.get('param0') || '{}').current_page || 1;
    const replies: Record<string, unknown> = {
      'aliexpress.solution.merchant.profile.get': { shop_id: 321, shop_name: 'Fixture shop', country_code: 'ES', merchant_login_id: 'private@example.com' },
      'aliexpress.solution.product.list.get': { result: { success: true, product_count: 1, total_page: 1, current_page: page, aeop_a_e_product_display_d_t_o_list: { item_display_dto: [{ product_id: 11, subject: 'Fixture product' }] } } },
      'aliexpress.solution.product.info.get': { result: { product_id: form.get('product_id'), subject: 'Fixture product', aeop_ae_product_s_k_us: { global_aeop_ae_product_sku: [{ sku_code: 'SKU-1', ipm_sku_stock: 20, sku_price: '10.00' }] } } },
      'aliexpress.solution.order.get': { result: { success: true, total_count: 0, total_page: 0, current_page: page } },
      'aliexpress.solution.order.info.get': { result: { data: { id: /"order_id":([0-9]+)/.exec(form.get('param1') || '')?.[1], order_status: 'WAIT_SELLER_SEND_GOODS', receipt_address: { contact_person: 'private buyer' } } } },
      'aliexpress.solution.batch.product.inventory.update': { update_success: true, update_successful_list: { synchronize_product_response_dto: [{ product_id: /"product_id":([0-9]+)/.exec(form.get('mutiple_product_update_list') || '')?.[1] }] } },
    };
    if (method in replies) return { [method.replaceAll('.', '_') + '_response']: replies[method] };
  }
  throw new Error('Unexpected merchant API fixture route');
}
export function installFixture(row: Row) {
  if (row.provider === 'magento') vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => new Response(JSON.stringify(providerReply(row.provider, url, init))));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
