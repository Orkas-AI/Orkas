'use strict';

const { requestFetch } = require('./commerce-request-context.cjs');

// Official manual seller authorization for local and semi-managed production shops.
const crypto = require('node:crypto');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const HOSTS = { us: 'https://openapi-b-us.temu.com', eu: 'https://openapi-b-eu.temu.com', global: 'https://openapi-b-global.temu.com' };
const METHODS = { 'shop.get': 'bg.open.accesstoken.info.get', 'products.list': 'bg.local.goods.list.query', 'products.get': 'bg.local.goods.detail.query',
  'orders.list': 'bg.order.list.v2.get', 'orders.get': 'bg.order.detail.v2.get', 'inventory.get': 'temu.local.goods.sku.stock.query', 'inventory.set': 'bg.local.goods.stock.edit' };
const SECRET_KEYS = ['app_key', 'app_secret', 'access_token'];
const fail = (kind, message) => { throw Object.assign(new Error(message), { code: `storefront_${kind}` }); };
const isProvider = (provider) => provider === 'temu';
const ID = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const PAGE = { page: { type: 'integer', minimum: 1, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });

function apiBase(provider, metadata) {
  if (!isProvider(provider) || !metadata || Object.keys(metadata).length !== 1 || !Object.hasOwn(HOSTS, metadata.region)) fail('invalid_binding', 'Invalid Temu production region');
  return HOSTS[metadata.region] + '/openapi/router';
}
function validateCredentials(config) {
  apiBase(config.provider, config.metadata);
  for (const key of SECRET_KEYS) {
    const value = config.credentials?.[key];
    if (typeof value !== 'string' || value.length < (key === 'app_key' ? 3 : 8) || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) fail('invalid_credentials', 'Invalid Temu application credential');
  }
}
const fingerprint = (key) => crypto.createHash('sha256').update(key).digest('hex');
function validateBinding(config) {
  validateCredentials(config);
  const id = config.credentials.identity;
  if (config.credentials.provider !== config.provider || id?.region !== config.metadata.region || id?.app_fingerprint !== fingerprint(config.credentials.app_key)
      || !/^[1-9][0-9]*$/.test(id?.shop_id || '') || !Array.isArray(id?.scopes)) fail('binding_mismatch', 'Temu credentials do not match this shop binding; reconnect');
  if (!Number.isSafeInteger(id.expires_at) || id.expires_at <= Date.now()) fail('permission_denied', 'Temu authorization expired; authorize again in Seller Center and reconnect');
}
function sign(parameters, secret) {
  const text = Object.keys(parameters).filter((key) => key !== 'sign').sort().map((key) => key + (typeof parameters[key] === 'object' ? JSON.stringify(parameters[key]) : String(parameters[key]))).join('');
  return crypto.createHash('md5').update(secret + text + secret, 'utf8').digest('hex').toUpperCase();
}
async function request(config, type, parameters = {}, write = false) {
  validateCredentials(config);
  const body = { ...parameters, type, app_key: config.credentials.app_key, access_token: config.credentials.access_token, timestamp: String(Math.floor(Date.now() / 1000)), data_type: 'JSON' };
  body.sign = sign(body, config.credentials.app_secret);
  let response;
  try { response = await requestFetch(apiBase(config.provider, config.metadata), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60000) }); }
  catch (error) { fail(['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_failed', `Temu request failed${write ? '; inspect stock before retrying an uncertain write' : ''}`); }
  if (!response.ok) fail([401, 403].includes(response.status) ? 'permission_denied' : response.status === 429 ? 'rate_limit' : 'upstream_error', `Temu API failed (HTTP ${response.status})`);
  let data;
  try { data = JSON.parse(await readBody(response)); } catch { fail('upstream_error', 'Temu returned invalid or oversized JSON'); }
  if (data?.success !== true || !data.result || typeof data.result !== 'object' || Array.isArray(data.result)) fail('request_failed', 'Temu API rejected the request; check seller authorization, business mode and parameters');
  return data.result;
}
function actionsFor() {
  return {
    'shop.get': action('R', 'Read the verified Temu shop, authorization expiry and granted API scope names.'),
    'products.list': action('R', 'Read one page of available/off-shelf products, including SKU stock and pagination.', PAGE),
    'products.get': action('R', 'Read one product by its Temu goods ID.', { goods_id: ID }, ['goods_id']),
    'orders.list': action('R', 'Read one page of local/semi-managed orders without buyer or payment details.', PAGE),
    'orders.get': action('R', 'Read one parent order and its items without buyer or payment details.', { order_id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9-]+$' } }, ['order_id']),
    'inventory.get': action('R', 'Read ordinary and presale stock for one goods ID. Only ordinary self-managed stock can be changed here.', { goods_id: ID }, ['goods_id']),
    'inventory.set': action('H', 'Replace ordinary self-managed stock for one SKU after fresh confirmation. Use a unique request key and never automatically retry an uncertain write.',
      { goods_id: ID, sku_id: ID, quantity: { type: 'integer', minimum: 0, maximum: 2147483647 }, request_key: { type: 'string', minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$', description: 'Unique identifier for this confirmed change; reuse only to identify the same request, never a different change.' } }, ['goods_id', 'sku_id', 'quantity', 'request_key']),
  };
}
async function identity(config) {
  const data = await request(config, METHODS['shop.get']);
  if ((!Number.isSafeInteger(data.mallId) && typeof data.mallId !== 'string') || !/^[1-9][0-9]*$/.test(String(data.mallId))
      || !Number.isSafeInteger(data.expiredTime) || data.expiredTime * 1000 <= Date.now() || !Array.isArray(data.apiScopeList) || data.apiScopeList.some((s) => typeof s !== 'string')) fail('permission_denied', 'Temu authorization is missing or expired; reconnect with a current Seller Center token');
  const result = { shop_id: String(data.mallId), region: config.metadata.region, app_fingerprint: fingerprint(config.credentials.app_key), expires_at: data.expiredTime * 1000, scopes: data.apiScopeList };
  if (config.credentials.identity && result.shop_id !== config.credentials.identity.shop_id) fail('binding_mismatch', 'Temu shop identity changed; reconnect');
  return result;
}
function minimizeOrder(value) {
  const fields = ['totalItemNum', 'pageItems', 'parentOrderMap', 'orderList', 'parentOrderSn', 'parentOrderStatus', 'parentOrderTime', 'parentShippingTime', 'updateTime', 'parentConfirmTime', 'siteId', 'regionId', 'orderSn', 'goodsId', 'skuId', 'goodsName', 'quantity', 'orderStatus', 'orderCreateTime', 'orderShippingTime', 'canceledQuantityBeforeShipment', 'originalOrderQuantity', 'productList', 'productSkuId', 'productId', 'extCode', 'soldFactor', 'fulfillmentType'];
  if (Array.isArray(value)) return value.map(minimizeOrder);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.includes(key)).map(([key, child]) => [key, minimizeOrder(child)]));
}
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('validation_failed', 'Unreviewed Temu action');
  validate(parameters, spec.input_schema);
  if (name === 'shop.get') return identity(config);
  if (!config.credentials.identity.scopes.includes(METHODS[name])) fail('permission_denied', 'This Temu authorization lacks the requested API permission; update Seller Center authorization and reconnect');
  const p = parameters;
  const args = name === 'products.list' ? { pageNo: p.page || 1, pageSize: p.limit || 50, goodsSearchType: 1 }
    : name === 'orders.list' ? { pageNumber: p.page || 1, pageSize: p.limit || 50 }
      : name === 'orders.get' ? { parentOrderSn: p.order_id }
        : name === 'inventory.set' ? { goodsId: p.goods_id, stockType: 0, skuStockTargetList: [{ stockTarget: p.quantity, skuId: p.sku_id }], requestUniqueKey: p.request_key }
          : { goodsId: p.goods_id };
  let data = await request(config, METHODS[name], args, spec.risk === 'H');
  if (name === 'inventory.set') {
    const entries = data.skuStockEditStatusInfoList;
    if (data.operateResult !== true || String(data.goodsId) !== String(p.goods_id) || !Array.isArray(entries) || entries.length !== 1
        || String(entries[0].skuId) !== String(p.sku_id) || entries[0].stockEditStatus !== true) fail('upstream_error', 'Temu stock update was not fully acknowledged; inspect stock before retrying');
    return { status: 'completed', goods_id: p.goods_id, sku_id: p.sku_id, quantity: p.quantity };
  }
  if ((name === 'products.list' && (!Array.isArray(data.goodsList) || !Number.isSafeInteger(data.total)))
      || (name === 'products.get' && String(data.goodsId) !== String(p.goods_id))
      || (name === 'orders.get' && (data.parentOrderMap?.parentOrderSn !== p.order_id || !Array.isArray(data.orderList)))
      || (name === 'orders.list' && (!Array.isArray(data.pageItems) || !Number.isSafeInteger(data.totalItemNum)))
      || (name === 'inventory.get' && !Array.isArray(data.stockList))) fail('invalid_response', 'Temu resource or pagination is missing');
  if (name.startsWith('orders.')) data = minimizeOrder(data);
  for (const key of SECRET_KEYS) data = safeOutput(data, config.credentials[key]);
  return { data, ...(name.endsWith('.list') ? { page: p.page || 1, limit: p.limit || 50 } : {}) };
}
async function authorize(config) {
  validateCredentials(config);
  const credentials = { provider: config.provider, ...Object.fromEntries(SECRET_KEYS.map((key) => [key, config.credentials[key]])), identity: await identity(config) };
  const bound = { ...config, credentials };
  await execute(bound, 'products.list', { limit: 1 });
  await execute(bound, 'orders.list', { limit: 1 });
  return credentials;
}
module.exports = { isProvider, apiBase, validateBinding, actionsFor, identity, execute, authorize, sign };
