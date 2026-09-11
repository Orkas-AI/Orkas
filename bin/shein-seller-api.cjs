'use strict';

const { requestFetch } = require('./commerce-request-context.cjs');

// Self-operated / semi-managed SHEIN seller apps. Full-managed .cn supply-chain
// applications are a different product, not an environment selection.
const crypto = require('node:crypto');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const fail = (kind, message) => { throw Object.assign(new Error(message), { code: `storefront_${kind}` }); };
const isProvider = (provider) => provider === 'shein';
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const secret = (text, min = 8) => typeof text === 'string' && text.length >= min && text.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(text);
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !metadata || Object.keys(metadata).length) fail('invalid_binding', 'Invalid SHEIN production binding');
  return 'https://openapi.sheincorp.com';
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  if (!secret(config.credentials?.app_id, 3) || !secret(config.credentials?.app_secret)) fail('invalid_credentials', 'Invalid SHEIN app credentials');
}
function authorizeUrl(config, state) {
  setup(config);
  const query = new URLSearchParams({ appid: config.credentials.app_id, redirectUrl: Buffer.from(config.credentials.redirect_uri, 'utf8').toString('base64'), state });
  return `https://openapi-sem.sheincorp.com/#/empower?${query}`;
}
function signature(openKeyId, secretKey, timestamp, path, random = crypto.randomBytes(4).toString('hex').slice(0, 5)) {
  const hex = crypto.createHmac('sha256', secretKey + random).update(`${openKeyId}&${timestamp}&${path}`).digest('hex');
  return random + Buffer.from(hex, 'utf8').toString('base64');
}
function decryptSecret(ciphertext, appSecret) {
  if (typeof ciphertext !== 'string' || ciphertext.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) fail('invalid_response', 'Invalid encrypted SHEIN grant');
  try {
    const key = Buffer.alloc(16); Buffer.from(appSecret, 'utf8').copy(key, 0, 0, 16);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from('space-station-default-iv', 'utf8').subarray(0, 16));
    const value = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
    if (!secret(value)) throw new Error('invalid');
    return value;
  } catch { fail('invalid_response', 'SHEIN grant could not be decrypted with this app secret'); }
}
function validateBinding(config) {
  setup(config);
  const c = config.credentials;
  if (c.provider !== 'shein' || !secret(c.open_key_id) || !secret(c.secret_key) || !/^[1-9][0-9]*$/.test(c.identity?.supplier_id || '')
      || c.identity?.app_fingerprint !== hash(c.app_id) || c.identity?.grant_fingerprint !== hash(c.open_key_id)) fail('binding_mismatch', 'SHEIN app or seller grant changed; reconnect');
}
async function request(config, path, body, auth = false, write = false) {
  setup(config);
  if (!auth) validateBinding(config);
  const c = config.credentials, timestamp = String(Date.now());
  const key = auth ? c.app_id : c.open_key_id, secretKey = auth ? c.app_secret : c.secret_key;
  let response;
  try { response = await requestFetch(apiBase(config.provider, config.metadata) + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { accept: 'application/json', 'content-type': 'application/json;charset=UTF-8', language: 'en', 'x-lt-language': 'US',
      [auth ? 'x-lt-appid' : 'x-lt-openKeyId']: key, 'x-lt-timestamp': timestamp, 'x-lt-signature': signature(key, secretKey, timestamp, path) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000),
  }); } catch (error) { fail(['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_failed', `SHEIN request failed${write ? '; inspect inventory before retrying an uncertain write' : ''}`); }
  if (!response.ok) fail([401, 403].includes(response.status) ? 'permission_denied' : response.status === 429 ? 'rate_limit' : 'upstream_error', `SHEIN API failed (HTTP ${response.status})`);
  let data;
  try { data = JSON.parse(await readBody(response)); } catch { fail('upstream_error', 'SHEIN returned invalid or oversized JSON'); }
  if (String(data?.code) !== '0' || data.info === undefined || data.info === null) fail('request_failed', 'SHEIN rejected the request; verify seller authorization, app business mode and API permissions');
  return data.info;
}
const ID = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
const TIME = { type: 'integer', minimum: 1577836800, maximum: 4102444800, description: 'Unix epoch seconds; Orkas converts to the required UTC+8 provider time.' };
const PAGE = { page: { type: 'integer', minimum: 1, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 10 } };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
function actionsFor() {
  return {
    'shop.get': action('R', 'Verify the authorized SHEIN grant and read available selling sites and currencies.'),
    'products.list': action('R', 'Read one SPU page including SKU codes, stock, prices and marketing locks. Provider page size is at most 10.', PAGE),
    'products.get': action('R', 'Read one SPU and its SKCs/SKUs using the SPU code returned by products.list.', { spu_code: ID }, ['spu_code']),
    'orders.list': action('R', 'Read an order page for an explicit time window no longer than 48 hours. Provider caps a window at 10000 orders; narrow the time range when necessary.', { ...PAGE, start_time: TIME, end_time: TIME, query_type: { type: 'integer', minimum: 1, maximum: 2, description: '1 = order creation; 2 = order update. Defaults to 1.' } }, ['start_time', 'end_time']),
    'orders.get': action('R', 'Read one order and line-item amounts without buyer contacts, labels or payment links.', { order_id: ID }, ['order_id']),
    'warehouses.list': action('R', 'Read warehouse codes, types and supported countries. Only merchant warehouses support inventory writes.'),
    'inventory.get': action('R', 'Read merchant virtual stock, reserved quantities and available quantities for one SKU.', { sku_code: ID }, ['sku_code']),
    'inventory.overwrite': action('H', 'Request a total merchant virtual stock overwrite after fresh confirmation. SHEIN will not reduce below reserved/occupied stock. The acknowledged quantity is a request, not a guarantee of resulting stock; read inventory.get afterward. Does not change SHEIN physical or JIT stock.',
      { sku_code: ID, warehouse_code: ID, quantity: { type: 'integer', minimum: 1, maximum: 2147483647 }, request_key: { ...ID, minLength: 8, description: 'Unique idempotency key for this confirmed change; never reuse it for a different change.' } }, ['sku_code', 'warehouse_code', 'quantity', 'request_key']),
  };
}
function pick(value, keys) {
  if (Array.isArray(value)) return value.map((item) => pick(item, keys));
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)).map(([key, child]) => [key, pick(child, keys)])) : value;
}
const ORDER_KEYS = ['count', 'orderList', 'orderNo', 'orderStatus', 'orderCreateTime', 'orderUpdateTime', 'stockMode', 'orderType', 'salesSite', 'orderGoodsInfoList', 'skuCode', 'skc', 'sellerSku', 'newGoodsStatus', 'goodsExchangeTag', 'goodsTitle', 'spuName', 'orderCurrency', 'saleCurrency', 'sellerCurrencyPrice', 'costPrice', 'productTotalPrice', 'totalCostPrice', 'productQuantity', 'warehouseCode', 'orderCurrencyStoreCouponPrice', 'orderCurrencyPromotionPrice'];
const utc8 = (seconds) => new Date(seconds * 1000 + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
async function identity(config) {
  const data = await request(config, '/open-api/goods/query-site-list', {});
  if (!Array.isArray(data?.data) || !Number.isSafeInteger(data.meta?.count)) fail('invalid_response', 'SHEIN site identity is missing');
  return { supplier_id: config.credentials.identity.supplier_id, sites: pick(data.data, ['main_site', 'sub_site_list', 'currency', 'site_abbr', 'site_status', 'store_type']) };
}
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('validation_failed', 'Unreviewed SHEIN action');
  validate(parameters, spec.input_schema);
  const p = parameters;
  if (name === 'shop.get') return identity(config);
  if (name === 'orders.list' && (p.end_time <= p.start_time || p.end_time - p.start_time > 48 * 3600)) fail('validation_failed', 'SHEIN order time range must be positive and at most 48 hours');
  const page = p.page || 1, limit = p.limit || 10;
  let data;
  if (name === 'products.list' || name === 'products.get') {
    data = await request(config, '/open-api/goods/searchProduct', { pageNum: name === 'products.get' ? 1 : page, pageSize: name === 'products.get' ? 1 : limit, ...(p.spu_code ? { spuNameList: [p.spu_code] } : {}) });
    if (!Array.isArray(data?.data) || !Number.isSafeInteger(data.meta?.count) || (name === 'products.get' && (data.data.length !== 1 || data.data[0].spuName !== p.spu_code))) fail('invalid_response', 'SHEIN product or pagination is missing');
  } else if (name === 'orders.list') {
    data = await request(config, '/open-api/order/order-list', { queryType: p.query_type || 1, startTime: utc8(p.start_time), endTime: utc8(p.end_time), page, pageSize: limit, queryOrderType: 4 });
    if (!Array.isArray(data?.orderList) || !Number.isSafeInteger(data.count)) fail('invalid_response', 'SHEIN order pagination is missing');
    data = pick(data, ORDER_KEYS);
  } else if (name === 'orders.get') {
    data = await request(config, '/open-api/order/order-detail', { orderNoList: [p.order_id] });
    if (!Array.isArray(data) || data.length !== 1 || data[0].orderNo !== p.order_id) fail('invalid_response', 'SHEIN order identity is missing');
    data = pick(data[0], ORDER_KEYS);
  } else if (name === 'warehouses.list') {
    data = await request(config, '/open-api/msc/warehouse/list');
    if (!Array.isArray(data?.list)) fail('invalid_response', 'SHEIN warehouse list is missing');
    data = pick(data, ['list', 'saleCountryList', 'warehouseCode', 'warehouseName', 'warehouseType']);
  } else if (name === 'inventory.get') {
    data = await request(config, '/open-api/stock/stock-query', { skuCodeList: [p.sku_code], invType: 'VI' });
    if (!Array.isArray(data?.goodsInventory)) fail('invalid_response', 'SHEIN inventory is missing');
  } else {
    // Require an existing merchant warehouse; do not accidentally mutate a certified warehouse.
    const warehouses = await request(config, '/open-api/msc/warehouse/list');
    if (!Array.isArray(warehouses?.list) || !warehouses.list.some((w) => w.warehouseCode === p.warehouse_code && String(w.warehouseType) === '1')) fail('validation_failed', 'SHEIN inventory writes require a verified merchant warehouse');
    data = await request(config, '/open-api/stock/change-inventory/v2', { updateSkuInventoryQuantityRequests: [{ idempotencyKey: p.request_key, skuCode: p.sku_code, invType: 'VI', warehouseCode: p.warehouse_code, changeType: 'OVERWRITE', changeQuantity: p.quantity }] }, false, true);
    if (!Array.isArray(data?.failedList) || data.failedList.length) fail('upstream_error', 'SHEIN inventory write was not fully acknowledged; inspect stock before retrying');
    data = { status: 'acknowledged', sku_code: p.sku_code, warehouse_code: p.warehouse_code, requested_total: p.quantity, resulting_stock: 'Read inventory.get; reserved and occupied stock may raise the resulting total.' };
  }
  for (const key of ['app_id', 'app_secret', 'open_key_id', 'secret_key']) data = safeOutput(data, config.credentials[key]);
  return { data, ...(['products.list', 'orders.list'].includes(name) ? { page, limit } : {}) };
}
async function authorize(config) {
  setup(config);
  if (typeof config.oauthCode !== 'string' || !config.oauthCode || config.oauthCode.length > 4096) fail('invalid_credentials', 'Missing SHEIN temporary authorization token');
  const data = await request(config, '/open-api/auth/get-by-token', { tempToken: config.oauthCode }, true);
  if (data.appid !== config.credentials.app_id || !secret(data.openKeyId) || (!Number.isSafeInteger(data.supplierId) && typeof data.supplierId !== 'string') || !/^[1-9][0-9]*$/.test(String(data.supplierId))) fail('binding_mismatch', 'SHEIN authorization does not identify this app and seller');
  const credentials = { provider: 'shein', app_id: config.credentials.app_id, app_secret: config.credentials.app_secret, open_key_id: data.openKeyId,
    secret_key: decryptSecret(data.secretKey, config.credentials.app_secret),
    identity: { supplier_id: String(data.supplierId), app_fingerprint: hash(config.credentials.app_id), grant_fingerprint: hash(data.openKeyId) } };
  const bound = { ...config, credentials };
  await identity(bound);
  await execute(bound, 'products.list', { limit: 1 });
  const now = Math.floor(Date.now() / 1000);
  await execute(bound, 'orders.list', { limit: 1, start_time: now - 86400, end_time: now });
  await execute(bound, 'warehouses.list', {});
  return credentials;
}
module.exports = { isProvider, apiBase, validateBinding, actionsFor, identity, execute, authorize, authorizeUrl, signature, decryptSecret };
