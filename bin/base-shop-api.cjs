'use strict';

// Japanese BASE merchant API (thebase.in), not Base.com or the Base blockchain.
// Contract: https://docs.thebase.in/api/ (reviewed 2026-09-16).
const crypto = require('node:crypto');
const { requestFetch, credentialOperation, requestFailureCode, httpFailureCode } = require('./commerce-request-context.cjs');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const { readCredentialFile, writeCredentialFile } = require('./local-api-credential-codec.cjs');
const BASE = 'https://api.thebase.in/1';
const SCOPES = ['read_users', 'read_items', 'read_orders', 'write_items'];
const refreshes = new Map();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const isProvider = provider => provider === 'base_shop';
const validSecret = value => typeof value === 'string' && value.length >= 3 && value.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(value);
const fingerprint = c => crypto.createHash('sha256').update(c.client_id).digest('hex');
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !metadata || Object.keys(metadata).length) fail('E_BAD_INPUT', 'Invalid BASE shop binding');
  return BASE;
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  const c = config.credentials;
  if (!validSecret(c?.client_id) || !validSecret(c?.client_secret)) fail('E_TOOL_CALL_AUTH', 'Enter the approved BASE application credentials');
}
function authorizeUrl(config, state) {
  setup(config);
  const url = new URL(`${BASE}/oauth/authorize`);
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.credentials.client_id,
    redirect_uri: config.credentials.redirect_uri, scope: SCOPES.join(' '), state }).toString();
  return url.toString();
}
async function request(config, route, params = {}, post = false, token = false) {
  setup(config);
  const url = new URL(BASE + route);
  const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  if (!post) url.search = body.toString();
  const deadline = AbortSignal.timeout(60000);
  let response;
  try {
    response = await requestFetch(url.toString(), { method: post ? 'POST' : 'GET', redirect: 'error', signal: deadline,
      headers: { accept: 'application/json', ...(post ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...(!token ? { authorization: `Bearer ${config.credentials.access_token}` } : {}) },
      ...(post ? { body: body.toString() } : {}) });
  } catch (error) { fail(requestFailureCode(error, deadline), 'BASE request failed; check the connection. Inspect the shop before retrying an uncertain update'); }
  // BASE documents HTTP 400 for both invalid tokens and quota exhaustion.
  // Parse that bounded error envelope before applying the generic HTTP mapping.
  if (!response.ok && response.status !== 400) fail(httpFailureCode(response.status), `BASE request failed (HTTP ${response.status}); check shop authorization and API access`);
  let source;
  try { source = await readBody(response); } catch (error) {
    fail(error?.code === 'E_CONNECTOR_RESPONSE_TOO_LARGE' ? 'E_TOOL_CALL_UPSTREAM' : requestFailureCode(error, deadline),
      'BASE response could not be read; inspect the shop before retrying an uncertain update');
  }
  let data;
  try { data = JSON.parse(source); } catch { fail('E_TOOL_CALL_UPSTREAM', 'BASE returned invalid data'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('E_TOOL_CALL_UPSTREAM', 'BASE returned an invalid result');
  if (data.error) fail(['hour_api_limit', 'day_api_limit'].includes(data.error) ? 'E_TOOL_CALL_RATE_LIMIT'
    : ['invalid_request', 'invalid_scope', 'access_denied', 'unauthorized_client', 'invalid_grant'].includes(data.error) || token
      ? 'E_TOOL_CALL_AUTH' : response.ok ? 'E_TOOL_CALL_UPSTREAM' : httpFailureCode(response.status),
    'BASE rejected the request; check API limits, parameters and shop authorization');
  if (!response.ok) fail(httpFailureCode(response.status), 'BASE rejected the request; check API parameters');
  return data;
}
function tokens(config, data) {
  if (!validSecret(data.access_token) || !validSecret(data.refresh_token) || !Number.isSafeInteger(data.expires_in)
    || data.expires_in <= 0 || data.expires_in > 86400) fail('E_TOOL_CALL_AUTH', 'BASE returned an incomplete authorization');
  return { provider: 'base_shop', client_id: config.credentials.client_id, client_secret: config.credentials.client_secret,
    redirect_uri: config.credentials.redirect_uri, access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000 };
}
function validateBinding(config) {
  setup(config);
  const c = config.credentials;
  if (c.provider !== 'base_shop' || !validSecret(c.access_token) || !validSecret(c.refresh_token)
    || !Number.isSafeInteger(c.expires_at) || !c.identity?.shop_id || c.identity.app_fingerprint !== fingerprint(c)) {
    fail('E_TOOL_CALL_AUTH', 'BASE shop authorization changed; reconnect');
  }
}
async function shop(config) {
  const data = await request(config, '/users/me');
  if (typeof data.user?.shop_id !== 'string' || !data.user.shop_id) fail('E_TOOL_CALL_UPSTREAM', 'BASE shop identity is missing');
  if (config.credentials.identity && data.user.shop_id !== config.credentials.identity.shop_id) fail('E_TOOL_CALL_AUTH', 'BASE shop changed; reconnect before continuing');
  return { shop_id: data.user.shop_id, app_fingerprint: fingerprint(config.credentials) };
}
const ensureToken = credentialOperation(async config => {
  const read = () => {
    if (config.credentialFile) config.credentials = readCredentialFile(config.credentialFile, config.credentialKey);
    validateBinding(config);
  };
  read();
  if (config.credentials.expires_at > Date.now() + 60000) return;
  if (!config.credentialFile) fail('E_TOOL_CALL_AUTH', 'BASE authorization needs refresh; reconnect');
  let pending = refreshes.get(config.credentialFile);
  if (!pending) {
    pending = (async () => {
      const c = config.credentials;
      const data = await request(config, '/oauth/token', { grant_type: 'refresh_token', client_id: c.client_id,
        client_secret: c.client_secret, redirect_uri: c.redirect_uri, refresh_token: c.refresh_token }, true, true);
      const next = { ...tokens(config, data), identity: c.identity };
      await shop({ ...config, credentials: next });
      writeCredentialFile(config.credentialFile, config.credentialKey, next);
    })();
    refreshes.set(config.credentialFile, pending);
  }
  try { await pending; } finally { if (refreshes.get(config.credentialFile) === pending) refreshes.delete(config.credentialFile); }
  read();
});
const id = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const quantity = { type: 'integer', minimum: 0, maximum: 2147483647 };
const page = { limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0, maximum: 1000000 } };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
function actionsFor() {
  return {
    'shop.get': action('R', 'Read the verified BASE shop identifier.'),
    'products.list': action('R', 'Read one page of BASE products including prices and stock.', page),
    'products.get': action('R', 'Read one BASE product and its variations.', { item_id: id }, ['item_id']),
    'orders.list': action('R', 'Read one page of BASE orders without buyer, address or payment details.', page),
    'orders.get': action('R', 'Read one BASE order and its items without buyer, address or payment details.',
      { unique_key: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' } }, ['unique_key']),
    'inventory.set': action('H', 'Replace stock for one BASE item or variation. For an item with variations, supply variation_id. Never automatically retry an uncertain update.',
      { item_id: id, variation_id: id, quantity }, ['item_id', 'quantity']),
  };
}
const ORDER_KEYS = new Set(['orders', 'order', 'unique_key', 'ordered', 'cancelled', 'dispatched', 'dispatch_status', 'modified',
  'total', 'shipping_fee', 'cod_fee', 'order_items', 'order_item_id', 'item_id', 'variation_id', 'title', 'item_identifier',
  'variation', 'variation_identifier', 'price', 'amount', 'item_total', 'option_total', 'item_tax_type', 'consumption_tax_rate', 'status']);
function orderOutput(value) {
  if (Array.isArray(value)) return value.map(orderOutput);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => ORDER_KEYS.has(k)).map(([k, v]) => [k, orderOutput(v)]));
}
async function identity(config) { await ensureToken(config); return shop(config); }
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('E_BAD_INPUT', 'Unreviewed BASE action');
  validate(parameters, spec.input_schema);
  await ensureToken(config);
  if (name === 'shop.get') return shop(config);
  const p = parameters;
  const paging = { limit: p.limit || 20, offset: p.offset || 0 };
  let data;
  if (name === 'inventory.set') {
    const current = await request(config, `/items/detail/${p.item_id}`);
    if (current.item?.item_id !== p.item_id || !Array.isArray(current.item.variations)) fail('E_TOOL_CALL_UPSTREAM', 'BASE product variations are missing');
    if (p.variation_id ? !current.item.variations.some(v => v.variation_id === p.variation_id) : current.item.variations.length > 0) {
      fail('E_BAD_INPUT', 'Select a current variation of this BASE product before updating stock');
    }
    data = await request(config, '/items/edit_stock', { item_id: p.item_id,
      ...(p.variation_id ? { variation_id: p.variation_id, variation_stock: p.quantity } : { stock: p.quantity }) }, true);
    const actual = p.variation_id ? data.item?.variations?.find(v => v.variation_id === p.variation_id)?.variation_stock : data.item?.stock;
    if (data.item?.item_id !== p.item_id || actual !== p.quantity) fail('E_TOOL_CALL_UPSTREAM', 'BASE did not confirm the requested stock; inspect the shop before retrying');
  } else {
    const routes = { 'products.list': '/items', 'products.get': `/items/detail/${p.item_id}`,
      'orders.list': '/orders', 'orders.get': `/orders/detail/${p.unique_key}` };
    data = await request(config, routes[name], name.endsWith('.list') ? paging : {});
    const key = { 'products.list': 'items', 'products.get': 'item', 'orders.list': 'orders', 'orders.get': 'order' }[name];
    if (name.endsWith('.list') ? !Array.isArray(data[key]) : !data[key] || typeof data[key] !== 'object') fail('E_TOOL_CALL_UPSTREAM', 'BASE result is incomplete');
  }
  if (name.startsWith('orders.')) data = orderOutput(data);
  for (const key of ['client_id', 'client_secret', 'access_token', 'refresh_token']) data = safeOutput(data, config.credentials[key]);
  return { data, ...(name.endsWith('.list') ? paging : {}) };
}
async function authorize(config) {
  setup(config);
  if (!validSecret(config.oauthCode)) fail('E_TOOL_CALL_AUTH', 'Complete BASE authorization in the browser');
  const c = config.credentials;
  const data = await request(config, '/oauth/token', { grant_type: 'authorization_code', client_id: c.client_id,
    client_secret: c.client_secret, redirect_uri: c.redirect_uri, code: config.oauthCode }, true, true);
  const credentials = tokens(config, data);
  const bound = { ...config, credentials };
  credentials.identity = await shop(bound);
  for (const name of ['products.list', 'orders.list']) await execute(bound, name, { limit: 1 });
  return credentials;
}
module.exports = { isProvider, apiBase, actionsFor, validateBinding, identity, execute, authorize, authorizeUrl, SCOPES };
