'use strict';

const { requestFetch, credentialOperation } = require('./commerce-request-context.cjs');

// Alibaba.com international seller APIs, not 1688 or Taobao shop APIs.
const crypto = require('node:crypto');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const { readCredentialFile, writeCredentialFile } = require('./local-api-credential-codec.cjs');
const refreshes = new Map();
const isProvider = (provider) => provider === 'alibaba_icbu';
const fail = (kind, message) => { throw Object.assign(new Error(message), { code: `storefront_${kind}` }); };
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const validSecret = (text, min = 8) => typeof text === 'string' && text.length >= min && text.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(text);
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !metadata || Object.keys(metadata).length) fail('invalid_binding', 'Invalid Alibaba.com production binding');
  return 'https://eco.taobao.com/router/rest';
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  if (!validSecret(config.credentials?.app_key, 3) || !validSecret(config.credentials?.app_secret)) fail('invalid_credentials', 'Invalid Alibaba.com app credentials');
}
function authorizeUrl(config, state) {
  setup(config);
  const url = new URL('https://oauth.alibaba.com/authorize');
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.credentials.app_key, redirect_uri: config.credentials.redirect_uri, state, view: 'web', sp: 'icbu' }).toString();
  return url.toString();
}
const timestamp = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
function sign(parameters, secret) {
  const text = Object.keys(parameters).filter((key) => key !== 'sign').sort().map((key) => key + String(parameters[key])).join('');
  return crypto.createHmac('md5', secret).update(text).digest('hex').toUpperCase();
}
async function post(url, parameters, write = false) {
  let response;
  try { response = await requestFetch(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(parameters).toString(), redirect: 'error', signal: AbortSignal.timeout(60000) }); }
  catch (error) { fail(['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'network_failed', `Alibaba.com request failed${write ? '; inspect product visibility before retrying an uncertain write' : ''}`); }
  if (!response.ok) fail([401, 403].includes(response.status) ? 'permission_denied' : response.status === 429 ? 'rate_limit' : 'upstream_error', `Alibaba.com API failed (HTTP ${response.status})`);
  let data;
  try { data = JSON.parse(await readBody(response)); } catch { fail('upstream_error', 'Alibaba.com returned invalid or oversized JSON'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('invalid_response', 'Invalid Alibaba.com response');
  if (data.error || data.error_response) fail('request_failed', 'Alibaba.com rejected the request; check the app permissions, authorization expiry and parameters');
  return data;
}
async function tokenRequest(config, refresh) {
  return post('https://oauth.alibaba.com/token', { client_id: config.credentials.app_key, client_secret: config.credentials.app_secret, sp: 'icbu',
    ...(refresh ? { grant_type: 'refresh_token', refresh_token: config.credentials.refresh_token } : { grant_type: 'authorization_code', code: config.oauthCode, redirect_uri: config.credentials.redirect_uri }) });
}
function tokens(config, data, previous) {
  const id = data.taobao_user_id;
  if (!validSecret(data.access_token) || typeof id !== 'string' || !/^[1-9][0-9]{0,24}$/.test(id)
      || !Number.isSafeInteger(Number(data.expires_in)) || Number(data.expires_in) <= 0
      || !Number.isSafeInteger(Number(data.re_expires_in)) || Number(data.re_expires_in) < 0) fail('invalid_response', 'Alibaba.com returned an incomplete authorization grant');
  if (data.sub_taobao_user_id) fail('permission_denied', 'Authorize Alibaba.com with the main merchant account, not a sub-account');
  if (previous && previous.identity.account_id !== id) fail('binding_mismatch', 'Alibaba.com account changed during refresh; reconnect');
  const now = Date.now();
  return { provider: config.provider, app_key: config.credentials.app_key, app_secret: config.credentials.app_secret,
    access_token: data.access_token, ...(validSecret(data.refresh_token) ? { refresh_token: data.refresh_token } : {}),
    expires_at: now + Number(data.expires_in) * 1000,
    refresh_expires_at: Math.min(now + Number(data.re_expires_in) * 1000, previous?.refresh_expires_at ?? Infinity),
    identity: { account_id: id, app_fingerprint: hash(config.credentials.app_key) } };
}
function validateBinding(config) {
  setup(config);
  const c = config.credentials;
  if (c.provider !== config.provider || !validSecret(c.access_token) || !/^[1-9][0-9]{0,24}$/.test(c.identity?.account_id || '')
      || c.identity?.app_fingerprint !== hash(c.app_key) || !Number.isSafeInteger(c.expires_at) || !Number.isSafeInteger(c.refresh_expires_at)) fail('binding_mismatch', 'Alibaba.com credential binding changed; reconnect');
}
const ensureToken = credentialOperation(async function ensureToken(config) {
  const read = () => { if (config.credentialFile) config.credentials = readCredentialFile(config.credentialFile, config.credentialKey); validateBinding(config); };
  read();
  if (config.credentials.expires_at > Date.now() + 60000) return;
  if (!config.credentialFile || !validSecret(config.credentials.refresh_token) || config.credentials.refresh_expires_at <= Date.now()) {
    if (config.credentials.expires_at > Date.now()) return;
    fail('permission_denied', 'Alibaba.com authorization expired; reconnect. Fixed-duration merchant apps require a new login');
  }
  let pending = refreshes.get(config.credentialFile);
  if (!pending) {
    pending = (async () => { const next = tokens(config, await tokenRequest(config, true), config.credentials); writeCredentialFile(config.credentialFile, config.credentialKey, next); })();
    refreshes.set(config.credentialFile, pending);
  }
  try { await pending; } finally { if (refreshes.get(config.credentialFile) === pending) refreshes.delete(config.credentialFile); }
  read();
});
async function request(config, method, parameters = {}, write = false) {
  await ensureToken(config);
  const params = { ...parameters, method, app_key: config.credentials.app_key, session: config.credentials.access_token, format: 'json', v: '2.0', sign_method: 'hmac', timestamp: timestamp() };
  params.sign = sign(params, config.credentials.app_secret);
  const data = await post(apiBase(config.provider, config.metadata), params, write);
  const envelope = data[method.replaceAll('.', '_') + '_response'];
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) fail('invalid_response', 'Alibaba.com response envelope is missing');
  return envelope;
}
const ID = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_=-]+$', description: 'Use the opaque product_id or order ID returned by the list action; do not substitute a product numeric id.' };
const PAGE = { page: { type: 'integer', minimum: 1, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 30 } };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
function actionsFor() {
  return {
    'account.get': action('R', 'Verify live product access and return the Alibaba.com account ID bound by official OAuth. Does not read a personal member profile.'),
    'products.list': action('R', 'Read one page of English Alibaba.com products, including opaque product_id for detail and visibility actions.', PAGE),
    'products.get': action('R', 'Read one Alibaba.com product by its opaque product_id, not its numeric id.', { product_id: ID }, ['product_id']),
    'orders.list': action('R', 'Read one page of seller trade order IDs and timestamps; page starts at 1 in Orkas and is converted to provider start_page 0.', PAGE),
    'orders.get': action('R', 'Read one trade order and product totals without buyer/contact/payment links.', { order_id: ID }, ['order_id']),
    'products.set_visibility': action('H', 'List or delist one existing product after fresh confirmation. Does not create, delete or change its price.', { product_id: ID, visibility: { type: 'string', minLength: 2, maxLength: 3, pattern: '^(on|off)$' } }, ['product_id', 'visibility']),
  };
}
const ORDER_KEYS = new Set(['trade_id', 'create_date', 'modify_date', 'timestamp', 'format_date', 'order_products', 'trade_ecology_order_product', 'name', 'quantity', 'sku_id', 'sku_code', 'unit', 'unit_price', 'product_id', 'product_total_amount', 'total_amount', 'shipment_fee', 'shipment_method', 'amount', 'currency', 'trade_status', 'trade_term', 'shipment_date', 'type', 'duration', 'date', 'advance_amount', 'balance_amount', 'discount_amount', 'pay_step', 'item_status', 'semi_manage']);
function minimize(value) {
  if (Array.isArray(value)) return value.map(minimize);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => ORDER_KEYS.has(key)).map(([key, child]) => [key, minimize(child)])) : value;
}
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('validation_failed', 'Unreviewed Alibaba.com action');
  validate(parameters, spec.input_schema);
  if (name === 'account.get') return identity(config);
  const p = parameters;
  const page = p.page || 1, limit = p.limit || 30;
  let data;
  if (name === 'products.list') {
    data = await request(config, 'alibaba.icbu.product.list', { language: 'ENGLISH', current_page: String(page), page_size: String(limit) });
    const items = data.products?.alibaba_product_brief_response;
    // Empty TOP collections may omit the wrapper entirely when total_item is 0.
    if (!Number.isSafeInteger(data.total_item) || (data.total_item > 0 && !Array.isArray(items)) || (items !== undefined && !Array.isArray(items))) fail('invalid_response', 'Alibaba.com product pagination is missing');
    data = { products: items || [], total: data.total_item, page, limit };
  } else if (name === 'products.get') {
    const reply = await request(config, 'alibaba.icbu.product.get', { language: 'ENGLISH', product_id: p.product_id });
    if (reply.product?.product_id !== p.product_id) fail('invalid_response', 'Alibaba.com product identity is missing');
    data = reply.product;
  } else if (name === 'orders.list') {
    const reply = await request(config, 'alibaba.seller.order.list', { param_trade_ecology_order_list_query: JSON.stringify({ role: 'seller', start_page: page - 1, page_size: limit }) });
    const result = reply.result;
    if (result?.success !== true) fail('request_failed', 'Alibaba.com seller order access failed; verify transaction API approval');
    const value = result.value, items = value?.order_list?.trade_ecology_order;
    if (!Number.isSafeInteger(value?.total_count) || (value.total_count > 0 && !Array.isArray(items)) || (items !== undefined && !Array.isArray(items))) fail('invalid_response', 'Alibaba.com order pagination is missing');
    data = { orders: minimize(items || []), total: value.total_count, page, limit };
  } else if (name === 'orders.get') {
    const reply = await request(config, 'alibaba.seller.order.get', { e_trade_id: p.order_id, language: 'en_US' });
    if (!reply.value?.trade_id) fail('invalid_response', 'Alibaba.com order identity is missing');
    data = minimize(reply.value);
  } else {
    const reply = await request(config, 'alibaba.icbu.product.batch.update.display', { new_display: p.visibility, product_id_list: p.product_id }, true);
    if (reply.sub_success !== true || reply.sub_error_code) fail('upstream_error', 'Alibaba.com visibility change was not fully acknowledged; inspect the product before retrying');
    data = { status: 'completed', product_id: p.product_id, visibility: p.visibility };
  }
  for (const key of ['app_key', 'app_secret', 'access_token', 'refresh_token']) if (config.credentials[key]) data = safeOutput(data, config.credentials[key]);
  return { data };
}
async function identity(config) {
  await execute(config, 'products.list', { limit: 1 });
  return { ...config.credentials.identity };
}
async function authorize(config) {
  setup(config);
  if (typeof config.oauthCode !== 'string' || !config.oauthCode || config.oauthCode.length > 4096) fail('invalid_credentials', 'Missing Alibaba.com authorization code');
  const credentials = tokens(config, await tokenRequest(config, false));
  const bound = { ...config, credentials };
  await identity(bound);
  await execute(bound, 'orders.list', { limit: 1 });
  return credentials;
}
module.exports = { isProvider, apiBase, validateBinding, actionsFor, identity, execute, authorize, authorizeUrl, sign };
