'use strict';

const { requestFetch, credentialOperation } = require('./commerce-request-context.cjs');

// Seller Solution APIs, not affiliate/dropshipping buyer APIs. OAuth REST signing:
// developer.alibaba.com/docs/doc.htm?articleId=120692&docType=1&treeId=727
// Dot-method /sync signing: ae_php_sdk IopClient.php, commit 28d6044d4bac09695af5388e0a765ed9083bc31a.
// Business contracts: articleIds 46616, 42384, 42383, 42270, 42707, 45135 (docType=2).
// Those business references are legacy; connection probes must fail closed when
// the current app does not support them. Never fall back to the old TOP gateway.
const crypto = require('node:crypto');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const { readCredentialFile, writeCredentialFile } = require('./local-api-credential-codec.cjs');
const refreshes = new Map();
const fail = (kind, message) => { throw Object.assign(new Error(message), { code: `storefront_${kind}` }); };
const isProvider = (provider) => provider === 'aliexpress';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const secret = (value, min = 8) => typeof value === 'string' && value.length >= min && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
const decimal = (value) => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9][0-9]{0,24}$/.test(String(value));
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !object(metadata) || Object.keys(metadata).length) fail('invalid_binding', 'Invalid AliExpress production binding');
  return 'https://api-sg.aliexpress.com/sync';
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  if (!secret(config.credentials?.app_key, 3) || !secret(config.credentials?.app_secret)) fail('invalid_credentials', 'Invalid AliExpress app credentials');
}
function authorizeUrl(config, state) {
  setup(config);
  const url = new URL('https://api-sg.aliexpress.com/oauth/authorize');
  url.search = new URLSearchParams({ response_type: 'code', force_auth: 'true', client_id: config.credentials.app_key, redirect_uri: config.credentials.redirect_uri, state }).toString();
  return url.toString();
}
function sign(method, parameters, appSecret) {
  const text = Object.keys(parameters).filter((key) => key !== 'sign').sort().map((key) => key + String(parameters[key])).join('');
  return crypto.createHmac('sha256', appSecret).update((method.startsWith('/') ? method : '') + text).digest('hex').toUpperCase();
}
function parseJSON(raw) {
  // V8 source context preserves 64-bit order IDs. Older runtimes fail closed
  // instead of returning a rounded ID that could target a different order.
  return JSON.parse(raw, (_key, value, context) => {
    if (typeof value === 'number' && !Number.isFinite(value)) fail('invalid_response', 'AliExpress returned an invalid number');
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (context?.source && /^-?[0-9]+$/.test(context.source)) return context.source;
      fail('invalid_response', 'AliExpress returned an unsupported numeric identifier');
    }
    return value;
  });
}
async function request(config, method, parameters = {}, token = false, write = false) {
  setup(config);
  const values = { ...parameters, app_key: config.credentials.app_key, timestamp: String(Date.now()), sign_method: 'sha256',
    ...(!token ? { method, session: config.credentials.access_token, format: 'json', simplify: 'false' } : {}) };
  values.sign = sign(method, values, config.credentials.app_secret);
  const body = new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString();
  let response;
  try {
    response = await requestFetch(token ? `https://api-sg.aliexpress.com/rest${method}` : apiBase(config.provider, config.metadata), {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'error', signal: AbortSignal.timeout(60000),
    });
  } catch (error) { fail(['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'network_failed', `AliExpress request failed${write ? '; inspect stock before retrying an uncertain write' : ''}`); }
  if (!response.ok) fail([401, 403].includes(response.status) ? 'permission_denied' : response.status === 429 ? 'rate_limit' : 'upstream_error', `AliExpress API failed (HTTP ${response.status})`);
  let data;
  try { data = parseJSON(await readBody(response)); } catch { fail('invalid_response', 'AliExpress returned invalid, oversized or unsupported JSON'); }
  const error = data?.error_response || (data?.code !== undefined && String(data.code) !== '0' ? data : null);
  if (error) fail(/token|permission|auth|code|session/i.test(String(error.code)) ? 'permission_denied' : 'request_failed', 'AliExpress rejected the request; check the seller app permissions and reconnect if authorization expired');
  if (token) {
    if (String(data?.code) !== '0') fail('permission_denied', 'AliExpress authorization was not acknowledged');
    return data;
  }
  const result = data?.[method.replaceAll('.', '_') + '_response'];
  if (!object(result)) fail('invalid_response', 'AliExpress seller response is missing');
  return result;
}
function tokens(config, data, previous) {
  const now = Date.now(), seconds = Number(data.expires_in), refreshSeconds = Number(data.refresh_expires_in);
  if (data.account_platform !== 'seller_center' || !decimal(data.seller_id) || !secret(data.access_token)
      || !Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(now + seconds * 1000)
      || !Number.isSafeInteger(refreshSeconds) || refreshSeconds < 0 || !Number.isSafeInteger(now + refreshSeconds * 1000)
      || (refreshSeconds > 0 && !secret(data.refresh_token))) fail('permission_denied', 'AliExpress did not return a complete seller authorization');
  if (previous && previous.seller_id !== String(data.seller_id)) fail('binding_mismatch', 'AliExpress seller changed during refresh; reconnect');
  return { provider: 'aliexpress', app_key: config.credentials.app_key, app_secret: config.credentials.app_secret,
    seller_id: String(data.seller_id), access_token: data.access_token, ...(secret(data.refresh_token) ? { refresh_token: data.refresh_token } : {}),
    expires_at: now + seconds * 1000, refresh_expires_at: Math.min(now + refreshSeconds * 1000, previous?.refresh_expires_at ?? Infinity),
    ...(previous ? { identity: previous.identity } : {}) };
}
function validateBinding(config) {
  setup(config);
  const c = config.credentials;
  if (c.provider !== 'aliexpress' || !secret(c.access_token) || !decimal(c.seller_id) || !decimal(c.identity?.shop_id)
      || c.identity?.seller_id !== c.seller_id || c.identity?.app_fingerprint !== hash(c.app_key)
      || !Number.isSafeInteger(c.expires_at) || !Number.isSafeInteger(c.refresh_expires_at)) fail('binding_mismatch', 'AliExpress credential binding changed; reconnect');
}
async function profile(config) {
  const data = await request(config, 'aliexpress.solution.merchant.profile.get');
  if (!decimal(data.shop_id)) fail('permission_denied', 'AliExpress seller profile is unavailable; check Seller Solution API access');
  if (config.credentials.identity && config.credentials.identity.shop_id !== String(data.shop_id)) fail('binding_mismatch', 'AliExpress shop changed; reconnect');
  return { shop_id: String(data.shop_id), seller_id: config.credentials.seller_id, app_fingerprint: hash(config.credentials.app_key),
    ...(typeof data.shop_name === 'string' ? { shop_name: data.shop_name } : {}) };
}
const ensureToken = credentialOperation(async function ensureToken(config) {
  const read = () => { if (config.credentialFile) config.credentials = readCredentialFile(config.credentialFile, config.credentialKey); validateBinding(config); };
  read();
  if (config.credentials.expires_at > Date.now() + 60000) return;
  if (!config.credentialFile || config.credentials.refresh_expires_at <= Date.now() || !secret(config.credentials.refresh_token)) {
    if (config.credentials.expires_at > Date.now()) return;
    fail('permission_denied', 'AliExpress authorization expired; reconnect');
  }
  let pending = refreshes.get(config.credentialFile);
  if (!pending) {
    pending = (async () => {
      const next = tokens(config, await request(config, '/auth/token/refresh', { refresh_token: config.credentials.refresh_token }, true), config.credentials);
      next.identity = redact(await profile({ ...config, credentials: next }), next);
      writeCredentialFile(config.credentialFile, config.credentialKey, next);
    })();
    refreshes.set(config.credentialFile, pending);
  }
  try { await pending; } finally { if (refreshes.get(config.credentialFile) === pending) refreshes.delete(config.credentialFile); }
  read();
});
const ID = { type: 'string', minLength: 1, maxLength: 25, pattern: '^[1-9][0-9]*$' };
const PAGE = { page: { type: 'integer', minimum: 1, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 50 } };
const TIME = { type: 'integer', minimum: 946684800, maximum: 4102444800, description: 'Unix timestamp in seconds; Orkas converts it to the API-required US Pacific time, including daylight saving.' };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
function actionsFor() {
  return {
    'shop.get': action('R', 'Read and verify the authorized AliExpress seller shop; not buyer or affiliate access.'),
    'products.list': action('R', 'Read one product page. Defaults to onSelling; query offline, auditing and editingRequired separately. Use products.get for SKU stock and prices.', { ...PAGE, status: { type: 'string', enum: ['onSelling', 'offline', 'auditing', 'editingRequired'] } }),
    'products.get': action('R', 'Read one seller product with its SKU codes, stock and prices.', { product_id: ID }, ['product_id']),
    'orders.list': action('R', 'Read an order page created after an explicit timestamp, without buyer/contact/payment details. Closed orders require a separate status FINISH query.', { ...PAGE, created_after: TIME, created_before: TIME, status: { type: 'string', enum: ['PLACE_ORDER_SUCCESS', 'IN_CANCEL', 'WAIT_SELLER_SEND_GOODS', 'SELLER_PART_SEND_GOODS', 'WAIT_BUYER_ACCEPT_GOODS', 'FUND_PROCESSING', 'IN_ISSUE', 'IN_FROZEN', 'WAIT_SELLER_EXAMINE_MONEY', 'RISK_CONTROL', 'FINISH'] } }, ['created_after']),
    'orders.get': action('R', 'Read one seller order and line items without buyer/contact/payment details.', { order_id: ID }, ['order_id']),
    'inventory.set': action('H', 'Replace one existing seller SKU stock quantity after fresh confirmation. The SKU must uniquely match products.get. Never automatically retry an uncertain write. Does not change price or promotion.',
      { product_id: ID, sku_code: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }, quantity: { type: 'integer', minimum: 0, maximum: 2147483647 } }, ['product_id', 'sku_code', 'quantity']),
  };
}
const PRODUCT_KEYS = new Set(['product_id', 'subject', 'currency_code', 'product_status_type', 'ws_display', 'product_price', 'product_min_price', 'product_max_price', 'gmt_create', 'gmt_modified', 'aeop_ae_product_s_k_us', 'global_aeop_ae_product_sku', 'sku_code', 'sku_price', 'sku_discount_price', 'ipm_sku_stock', 'sku_stock', 'id']);
const ORDER_KEYS = new Set(['order_id', 'id', 'order_status', 'gmt_create', 'gmt_update', 'gmt_modified', 'gmt_pay_time', 'gmt_trade_end', 'logistics_status', 'fund_status', 'issue_status', 'pay_amount', 'order_amount', 'product_list', 'order_product_dto', 'child_order_list', 'global_aeop_tp_child_order_dto', 'child_order_ext_info_list', 'global_aeop_tp_order_product_info_dto', 'product_id', 'product_name', 'product_count', 'quantity', 'sku_code', 'product_unit_price', 'unit_price', 'total_product_amount', 'currency_code', 'amount', 'amount_str', 'son_order_status']);
function project(value, keys) {
  if (Array.isArray(value)) return value.map((child) => project(child, keys));
  return object(value) ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.has(key)).map(([key, child]) => [key, project(child, keys)])) : value;
}
function redact(data, credentials) {
  for (const key of ['app_key', 'app_secret', 'access_token', 'refresh_token']) if (credentials[key]) data = safeOutput(data, credentials[key]);
  return data;
}
function pacificTime(seconds) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(seconds * 1000)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}
async function identity(config) {
  await ensureToken(config);
  return redact(await profile(config), config.credentials);
}
async function product(config, id) {
  const data = (await request(config, 'aliexpress.solution.product.info.get', { product_id: id })).result;
  const skus = data?.aeop_ae_product_s_k_us?.global_aeop_ae_product_sku;
  if (!object(data) || data.success === false || (data.error_code && String(data.error_code) !== '0') || !decimal(data.product_id) || String(data.product_id) !== id
      || !Array.isArray(skus) || skus.some((sku) => !object(sku))) fail('invalid_response', 'AliExpress product or SKU details are missing');
  return data;
}
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('validation_failed', 'Unreviewed AliExpress action');
  validate(parameters, spec.input_schema);
  const p = parameters, page = p.page || 1, limit = p.limit || 50;
  if (p.created_before !== undefined && p.created_before <= p.created_after) fail('validation_failed', 'Invalid AliExpress order time range');
  if (name === 'shop.get') return identity(config);
  await ensureToken(config);
  let data;
  if (name === 'inventory.set') {
    const item = await product(config, p.product_id);
    if (item.aeop_ae_product_s_k_us.global_aeop_ae_product_sku.filter((sku) => sku.sku_code === p.sku_code).length !== 1) fail('validation_failed', 'AliExpress SKU code must uniquely match the requested product');
    // IDs stay decimal literals in nested JSON; never round a 64-bit identifier.
    const payload = '[{"product_id":' + p.product_id + ',"multiple_sku_update_list":' + JSON.stringify([{ sku_code: p.sku_code, inventory: p.quantity }]) + '}]';
    const result = await request(config, 'aliexpress.solution.batch.product.inventory.update', { mutiple_product_update_list: payload }, false, true);
    const success = result.update_successful_list?.synchronize_product_response_dto;
    const failed = result.update_failed_list?.synchronize_product_response_dto;
    if (result.update_success !== true || result.update_error_code || result.update_error_message || (result.update_failed_list != null && (!Array.isArray(failed) || failed.length))
        || !Array.isArray(success) || success.length !== 1 || !decimal(success[0]?.product_id) || String(success[0].product_id) !== p.product_id || success[0].error_code || success[0].error_message) fail('upstream_error', 'AliExpress stock write was not fully acknowledged; inspect stock before retrying');
    data = { status: 'completed', product_id: p.product_id, sku_code: p.sku_code, quantity: p.quantity };
  } else if (name === 'products.get') data = project(await product(config, p.product_id), PRODUCT_KEYS);
  else if (name === 'orders.get') {
    const result = (await request(config, 'aliexpress.solution.order.info.get', { param1: '{"order_id":' + p.order_id + ',"ext_info_bit_flag":0}' })).result;
    // OrderDetailResult has data/error_code, unlike the list API's success flag.
    if (!object(result) || result.success === false || (result.error_code && String(result.error_code) !== '0') || !decimal(result.data?.id) || String(result.data.id) !== p.order_id) fail('invalid_response', 'AliExpress order details are missing');
    data = project(result.data, ORDER_KEYS);
  } else {
    const isProduct = name === 'products.list';
    const query = { current_page: page, page_size: limit, ...(isProduct ? { product_status_type: p.status || 'onSelling' }
      : { create_date_start: pacificTime(p.created_after), ...(p.created_before ? { create_date_end: pacificTime(p.created_before) } : {}), ...(p.status ? { order_status: p.status } : {}) }) };
    const result = (await request(config, isProduct ? 'aliexpress.solution.product.list.get' : 'aliexpress.solution.order.get', { [isProduct ? 'aeop_a_e_product_list_query' : 'param0']: JSON.stringify(query) })).result;
    const count = result?.[isProduct ? 'product_count' : 'total_count'];
    const list = isProduct ? result?.aeop_a_e_product_display_d_t_o_list?.item_display_dto : result?.target_list?.order_dto;
    if (result?.success !== true || !Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(result.total_page) || result.total_page < 0
        || result.current_page !== page || (!Array.isArray(list) && !(count === 0 && list == null)) || (count > 0 && !list?.length && page <= result.total_page)) fail('invalid_response', 'AliExpress resource or pagination is missing');
    data = { [isProduct ? 'products' : 'orders']: project(list || [], isProduct ? PRODUCT_KEYS : ORDER_KEYS), total: count, total_pages: result.total_page, page, limit };
  }
  return { data: redact(data, config.credentials) };
}
async function authorize(config) {
  setup(config);
  if (!secret(config.oauthCode, 1)) fail('invalid_credentials', 'Missing AliExpress authorization code');
  const credentials = tokens(config, await request(config, '/auth/token/create', { code: config.oauthCode }, true));
  const bound = { ...config, credentials };
  credentials.identity = redact(await profile(bound), credentials);
  await execute(bound, 'products.list', { limit: 1 });
  await execute(bound, 'orders.list', { limit: 1, created_after: Math.floor(Date.now() / 1000) - 86400 });
  return credentials;
}
module.exports = { isProvider, apiBase, validateBinding, actionsFor, identity, execute, authorize, authorizeUrl, sign, parseJSON, pacificTime };
