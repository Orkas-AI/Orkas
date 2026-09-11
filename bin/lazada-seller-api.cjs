'use strict';

const { requestFetch, credentialOperation } = require('./commerce-request-context.cjs');

// Lazada ABA merchant apps: production country binding, rotating OAuth grants,
// and a closed seller surface behind the existing connector risk/secret owners.
const crypto = require('node:crypto');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const { readCredentialFile, writeCredentialFile } = require('./local-api-credential-codec.cjs');
const HOSTS = { sg: 'api.lazada.sg', my: 'api.lazada.com.my', ph: 'api.lazada.com.ph', th: 'api.lazada.co.th', id: 'api.lazada.co.id', vn: 'api.lazada.vn' };
const refreshes = new Map();
const fail = (kind, message) => { throw Object.assign(new Error(message), { code: `storefront_${kind}` }); };
const isProvider = (provider) => provider === 'lazada';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const secret = (value, min = 8) => typeof value === 'string' && value.length >= min && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
const decimal = (value) => (typeof value === 'string' || Number.isSafeInteger(value)) && /^[1-9][0-9]{0,24}$/.test(String(value));
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !metadata || Object.keys(metadata).length !== 1 || !Object.hasOwn(HOSTS, metadata.country)) fail('invalid_binding', 'Invalid Lazada production country');
  return `https://${HOSTS[metadata.country]}/rest`;
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  if (!secret(config.credentials?.app_key, 3) || !secret(config.credentials?.app_secret)) fail('invalid_credentials', 'Invalid Lazada app credentials');
}
function authorizeUrl(config, state) {
  setup(config);
  const url = new URL('https://auth.lazada.com/oauth/authorize');
  url.search = new URLSearchParams({ response_type: 'code', force_auth: 'true', client_id: config.credentials.app_key, redirect_uri: config.credentials.redirect_uri, state }).toString();
  return url.toString();
}
function sign(path, parameters, appSecret) {
  const text = Object.keys(parameters).filter((key) => key !== 'sign').sort().map((key) => key + String(parameters[key])).join('');
  return crypto.createHmac('sha256', appSecret).update(path + text).digest('hex').toUpperCase();
}
async function request(config, path, parameters = {}, token = false, write = false) {
  setup(config);
  const values = { ...parameters, app_key: config.credentials.app_key, timestamp: String(Date.now()), sign_method: 'sha256', ...(!token ? { access_token: config.credentials.access_token } : {}) };
  values.sign = sign(path, values, config.credentials.app_secret);
  const encoded = new URLSearchParams(Object.entries(values).map(([key, value]) => [key, String(value)])).toString();
  const post = token || write;
  const url = (token ? 'https://auth.lazada.com/rest' : apiBase(config.provider, config.metadata)) + path + (post ? '' : `?${encoded}`);
  let response;
  try { response = await requestFetch(url, { method: post ? 'POST' : 'GET', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, ...(post ? { body: encoded } : {}), redirect: 'error', signal: AbortSignal.timeout(60000) }); }
  catch (error) { fail(['AbortError', 'TimeoutError'].includes(error?.name) ? 'timeout' : 'network_failed', `Lazada request failed${write ? '; inspect stock before retrying an uncertain write' : ''}`); }
  if (!response.ok) fail([401, 403].includes(response.status) ? 'permission_denied' : response.status === 429 ? 'rate_limit' : 'upstream_error', `Lazada API failed (HTTP ${response.status})`);
  let data;
  try { data = JSON.parse(await readBody(response)); } catch { fail('upstream_error', 'Lazada returned invalid or oversized JSON'); }
  if (String(data?.code) !== '0') fail(['IllegalAccessToken', 'InvalidAccessToken', 'InsufficientPermission', 'InvalidRefreshToken', 'IllegalRefreshToken', 'AUTH_TYPE_UNSUPPORTED', 'InvalidCode'].includes(data?.code) ? 'permission_denied' : String(data?.code) === '901' ? 'rate_limit' : 'request_failed', 'Lazada rejected the request; check the app permissions, shop authorization and parameters');
  return token ? data : data.data;
}
function tokens(config, data, previous) {
  const countries = previous ? data.country_user_info_list : data.country_user_info;
  const selected = Array.isArray(countries) ? countries.filter((entry) => entry.country === config.metadata.country) : [];
  if (!secret(data.access_token) || !Number.isSafeInteger(Number(data.expires_in)) || Number(data.expires_in) <= 0
      || !Array.isArray(selected) || selected.length !== 1 || !decimal(selected[0].seller_id)) fail('permission_denied', 'Lazada authorization does not include the selected country and seller');
  const shopId = String(selected[0].seller_id);
  if (previous?.identity?.shop_id && previous.identity.shop_id !== shopId) fail('binding_mismatch', 'Lazada seller changed during refresh; reconnect');
  const now = Date.now();
  const refreshSeconds = Number(data.refresh_expires_in);
  if (!Number.isSafeInteger(refreshSeconds) || refreshSeconds < 0 || (refreshSeconds > 0 && !secret(data.refresh_token))) fail('invalid_response', 'Lazada returned an incomplete refresh grant');
  return { provider: 'lazada', app_key: config.credentials.app_key, app_secret: config.credentials.app_secret,
    access_token: data.access_token, ...(secret(data.refresh_token) ? { refresh_token: data.refresh_token } : {}),
    expires_at: now + Number(data.expires_in) * 1000,
    refresh_expires_at: Math.min(now + refreshSeconds * 1000, previous?.refresh_expires_at ?? Infinity),
    identity: { shop_id: shopId, country: config.metadata.country, app_fingerprint: hash(config.credentials.app_key) } };
}
function validateBinding(config) {
  setup(config);
  const c = config.credentials;
  if (c.provider !== 'lazada' || !secret(c.access_token) || c.identity?.country !== config.metadata.country
      || c.identity?.app_fingerprint !== hash(c.app_key) || !decimal(c.identity?.shop_id)
      || !Number.isSafeInteger(c.expires_at) || !Number.isSafeInteger(c.refresh_expires_at)) fail('binding_mismatch', 'Lazada credential binding changed; reconnect');
}
const ensureToken = credentialOperation(async function ensureToken(config) {
  const read = () => { if (config.credentialFile) config.credentials = readCredentialFile(config.credentialFile, config.credentialKey); validateBinding(config); };
  read();
  if (config.credentials.expires_at > Date.now() + 60000) return;
  if (!config.credentialFile || config.credentials.refresh_expires_at <= Date.now() || !secret(config.credentials.refresh_token)) {
    if (config.credentials.expires_at > Date.now()) return;
    fail('permission_denied', 'Lazada authorization expired; reconnect');
  }
  let pending = refreshes.get(config.credentialFile);
  if (!pending) {
    pending = (async () => {
      const next = tokens(config, await request(config, '/auth/token/refresh', { refresh_token: config.credentials.refresh_token }, true), config.credentials);
      writeCredentialFile(config.credentialFile, config.credentialKey, next);
    })();
    refreshes.set(config.credentialFile, pending);
  }
  try { await pending; } finally { if (refreshes.get(config.credentialFile) === pending) refreshes.delete(config.credentialFile); }
  read();
});
const ID = { type: 'string', minLength: 1, maxLength: 25, pattern: '^[1-9][0-9]*$' };
const PAGE = { offset: { type: 'integer', minimum: 0, maximum: 10000 }, limit: { type: 'integer', minimum: 1, maximum: 50 } };
const DATE = { type: 'string', minLength: 25, maxLength: 25, pattern: '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$', description: 'ISO 8601 timestamp including numeric timezone, e.g. 2026-09-01T00:00:00+00:00.' };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
function actionsFor() {
  return {
    'shop.get': action('R', 'Read and verify the Lazada seller bound to this production country, without contact details.'),
    'products.list': action('R', 'Read one product page including SKU prices and stock. Offset is capped at 10000; use updated_after/updated_before to continue larger catalogs.', { ...PAGE, updated_after: DATE, updated_before: DATE }),
    'products.get': action('R', 'Read one item and its SKUs, price and stock by Item ID; Seller SKU lookup is deprecated.', { item_id: ID }, ['item_id']),
    'orders.list': action('R', 'Read orders created after an explicit timestamp, with totals/pagination but no buyer or payment details.', { ...PAGE, created_after: DATE, created_before: DATE }, ['created_after']),
    'orders.get': action('R', 'Read one order without buyer/contact/payment details.', { order_id: ID }, ['order_id']),
    'order_items.list': action('R', 'Read SKU, quantity, price and status for one order, without shipping labels or contact details.', { order_id: ID }, ['order_id']),
    'inventory.set': action('H', 'Replace sellable stock for one SKU in its default warehouse after fresh confirmation. For a multi-warehouse store, supply warehouse_code. Never automatically retry an uncertain write.',
      { item_id: ID, sku_id: ID, quantity: { type: 'integer', minimum: 0, maximum: 2147483647 }, warehouse_code: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' } }, ['item_id', 'sku_id', 'quantity']),
  };
}
const ORDER_KEYS = new Set(['orders', 'count', 'countTotal', 'order_id', 'order_number', 'created_at', 'updated_at', 'price', 'shipping_fee', 'items_count', 'statuses', 'status', 'order_item_id', 'sku', 'shop_sku', 'name', 'item_price', 'paid_price', 'quantity', 'currency', 'product_id', 'sku_id']);
function orders(value) {
  if (Array.isArray(value)) return value.map(orders);
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => ORDER_KEYS.has(key)).map(([key, child]) => [key, orders(child)])) : value;
}
async function identity(config) {
  await ensureToken(config);
  const data = await request(config, '/seller/get');
  if (!decimal(data?.seller_id) || String(data.seller_id) !== config.credentials.identity.shop_id) fail('binding_mismatch', 'Lazada seller identity does not match the authorized country; reconnect');
  return { ...config.credentials.identity, ...(typeof data.name === 'string' ? { shop_name: safeOutput(data.name, config.credentials.access_token) } : {}) };
}
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('validation_failed', 'Unreviewed Lazada action');
  validate(parameters, spec.input_schema);
  const p = parameters;
  for (const key of ['updated_after', 'updated_before', 'created_after', 'created_before']) if (p[key] && !Number.isFinite(Date.parse(p[key]))) fail('validation_failed', 'Invalid Lazada date');
  for (const pair of [['updated_after', 'updated_before'], ['created_after', 'created_before']]) if (p[pair[0]] && p[pair[1]] && Date.parse(p[pair[0]]) >= Date.parse(p[pair[1]])) fail('validation_failed', 'Invalid Lazada time range');
  if (name === 'shop.get') return identity(config);
  await ensureToken(config);
  const paging = { offset: p.offset || 0, limit: p.limit || 50 };
  let path, args;
  if (name === 'products.list') { path = '/products/get'; args = { ...paging, filter: 'all', options: '1', ...(p.updated_after ? { update_after: p.updated_after } : {}), ...(p.updated_before ? { update_before: p.updated_before } : {}) }; }
  else if (name === 'products.get') { path = '/product/item/get'; args = { item_id: p.item_id }; }
  else if (name === 'orders.list') { path = '/orders/get'; args = { ...paging, created_after: p.created_after, ...(p.created_before ? { created_before: p.created_before } : {}) }; }
  else if (name === 'orders.get' || name === 'order_items.list') { path = name === 'orders.get' ? '/order/get' : '/order/items/get'; args = { order_id: p.order_id }; }
  else {
    path = '/product/stock/sellable/update';
    const stock = p.warehouse_code ? `<MultiWarehouseInventories><MultiWarehouseInventory><WarehouseCode>${p.warehouse_code}</WarehouseCode><SellableQuantity>${p.quantity}</SellableQuantity></MultiWarehouseInventory></MultiWarehouseInventories>` : `<SellableQuantity>${p.quantity}</SellableQuantity>`;
    args = { payload: `<Request><Product><Skus><Sku><ItemId>${p.item_id}</ItemId><SkuId>${p.sku_id}</SkuId>${stock}</Sku></Skus></Product></Request>` };
  }
  let data = await request(config, path, args, false, spec.risk === 'H');
  if (spec.risk === 'H') {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length) fail('upstream_error', 'Lazada stock write was not fully acknowledged; inspect stock before retrying');
    return { status: 'completed', item_id: p.item_id, sku_id: p.sku_id, quantity: p.quantity };
  }
  if ((name === 'products.list' && (!Array.isArray(data?.products) || !Number.isSafeInteger(Number(data.total_products))))
      || (name === 'orders.list' && (!Array.isArray(data?.orders) || !Number.isSafeInteger(Number(data.countTotal))))
      || (name === 'products.get' && String(data?.item_id) !== p.item_id)
      || (name === 'orders.get' && String(data?.order_id) !== p.order_id)
      || (name === 'order_items.list' && !Array.isArray(data))) fail('invalid_response', 'Lazada resource or pagination is missing');
  if (name.startsWith('order')) data = orders(data);
  for (const key of ['app_key', 'app_secret', 'access_token', 'refresh_token']) if (config.credentials[key]) data = safeOutput(data, config.credentials[key]);
  return { data, ...(['products.list', 'orders.list'].includes(name) ? paging : {}) };
}
async function authorize(config) {
  setup(config);
  if (typeof config.oauthCode !== 'string' || !config.oauthCode || config.oauthCode.length > 4096) fail('invalid_credentials', 'Missing Lazada authorization code');
  const credentials = tokens(config, await request(config, '/auth/token/create', { code: config.oauthCode }, true));
  const bound = { ...config, credentials };
  await identity(bound);
  await execute(bound, 'products.list', { limit: 1 });
  await execute(bound, 'orders.list', { limit: 1, created_after: new Date(Date.now() - 86400000).toISOString().slice(0, 19) + '+00:00' });
  return credentials;
}
module.exports = { isProvider, apiBase, validateBinding, actionsFor, identity, execute, authorize, authorizeUrl, sign };
