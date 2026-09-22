'use strict';

// futureshop API v2: https://manual.future-shop.jp/api/ (reviewed 2026-09-16).
// The approved API origin is issued by the provider, not inferred from the shop URL.
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const net = require('node:net');
const { requestFetch, credentialOperation, requestFailureCode, httpFailureCode } = require('./commerce-request-context.cjs');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const { publicAddress } = require('./magento-admin-api.cjs');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const isProvider = provider => provider === 'futureshop';
const secrets = ['client_id', 'client_secret', 'shop_key'];
const sessions = new Map();
function normalizeBinding(value) {
  let url;
  if (typeof value !== 'string' || /[\\\s\u0000-\u001f\u007f]/.test(value)) fail('E_BAD_INPUT', 'Enter the API domain issued by futureshop');
  try { url = new URL(value.includes('://') ? value : `https://${value}`); } catch { fail('E_BAD_INPUT', 'Invalid futureshop API domain'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || net.isIP(url.hostname) || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(url.hostname)
    || /\.(?:localhost|local|internal|test|invalid|example)$/.test(url.hostname)) fail('E_BAD_INPUT', 'Use the issued public HTTPS API domain without a path');
  return url.origin;
}
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !metadata || Object.keys(metadata).length !== 1
    || normalizeBinding(metadata.api_origin) !== metadata.api_origin) fail('E_BAD_INPUT', 'Invalid futureshop API binding');
  return metadata.api_origin;
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  if (secrets.some(key => typeof config.credentials?.[key] !== 'string' || config.credentials[key].length < 3
    || config.credentials[key].length > 4096 || /[\s:\u0000-\u001f\u007f]/.test(config.credentials[key]))) fail('E_TOOL_CALL_AUTH', 'Enter the approved futureshop application and shop credentials');
}
const fingerprint = config => crypto.createHash('sha256').update(JSON.stringify([config.metadata.api_origin, ...secrets.map(key => config.credentials[key])])).digest('hex');
function validateBinding(config) {
  setup(config);
  if (config.credentials.provider !== 'futureshop' || config.credentials.identity?.fingerprint !== fingerprint(config)) fail('E_TOOL_CALL_AUTH', 'futureshop API or shop binding changed; reconnect');
}
async function publicHost(host) {
  let timer;
  try {
    const rows = await Promise.race([dns.lookup(host, { all: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 60000); })]);
    if (!rows.length || rows.some(row => !publicAddress(row.address))) fail('E_BAD_INPUT', 'The futureshop API must resolve to public addresses');
  } catch (error) {
    if (error?.code === 'E_BAD_INPUT') throw error;
    fail('E_TOOL_CALL_NETWORK', 'Cannot resolve the futureshop API domain');
  } finally { clearTimeout(timer); }
}
function session(config) {
  const key = fingerprint(config);
  if (!sessions.has(key)) {
    if (sessions.size >= 100) fail('E_TOOL_CALL_RATE_LIMIT', 'Too many active futureshop connections; restart the connector');
    sessions.set(key, { next: 0 });
  }
  return sessions.get(key);
}
async function request(config, route, { query = {}, body, token = false } = {}) {
  setup(config);
  const url = new URL(config.metadata.api_origin + route);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, String(value)));
  await publicHost(url.hostname);
  // Provider limit is one request/second per client. At most one second is queued;
  // competing requests fail explicitly instead of accumulating or replaying writes.
  const state = session(config);
  const delay = state.next - Date.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
  if (Date.now() < state.next) fail('E_TOOL_CALL_RATE_LIMIT', 'futureshop permits one request per second; try again shortly');
  state.next = Date.now() + 1000;
  const c = config.credentials;
  const deadline = AbortSignal.timeout(60000);
  let response;
  try {
    response = await requestFetch(url.toString(), { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: deadline,
      headers: { accept: 'application/json', 'X-SHOP-KEY': c.shop_key,
        authorization: token ? `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64')}` : `Bearer ${state.access_token}`,
        ...(body !== undefined ? { 'content-type': token ? 'application/x-www-form-urlencoded' : 'application/json' } : {}) },
      ...(body !== undefined ? { body: token ? new URLSearchParams(body).toString() : JSON.stringify(body) } : {}) });
  } catch (error) { fail(requestFailureCode(error, deadline), 'futureshop request failed; inspect the shop before retrying an uncertain update'); }
  if (!response.ok) {
    if (response.status === 401) { delete state.access_token; delete state.expires_at; }
    fail(httpFailureCode(response.status), `futureshop request failed (HTTP ${response.status}); check API permissions and the registered outbound IP`);
  }
  let source;
  try { source = await readBody(response); } catch (error) {
    fail(error?.code === 'E_CONNECTOR_RESPONSE_TOO_LARGE' ? 'E_TOOL_CALL_UPSTREAM' : requestFailureCode(error, deadline),
      'futureshop response could not be read; inspect the shop before retrying an uncertain update');
  }
  let data;
  try { data = JSON.parse(source); } catch { fail('E_TOOL_CALL_UPSTREAM', 'futureshop returned invalid data'); }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.status === 'failed' || data.errors?.length) fail('E_TOOL_CALL_UPSTREAM', 'futureshop rejected the request; inspect the shop before retrying an update');
  return data;
}
const ensureToken = credentialOperation(async config => {
  const state = session(config);
  if (state.access_token && state.expires_at > Date.now() + 60000) return;
  if (!state.pending) state.pending = (async () => {
    const data = await request(config, '/oauth/token', { token: true, body: { grant_type: 'client_credentials' } });
    if (typeof data.access_token !== 'string' || !data.access_token || /\s/.test(data.access_token)
      || !Number.isSafeInteger(data.expires_in) || data.expires_in < 1 || data.expires_in > 86400) fail('E_TOOL_CALL_AUTH', 'futureshop returned an incomplete token');
    state.access_token = data.access_token;
    state.expires_at = Date.now() + data.expires_in * 1000;
  })();
  try { await state.pending; } finally { delete state.pending; }
});
const product = { type: 'string', minLength: 1, maxLength: 32, pattern: '^[^,\\s\\u0000-\\u001f\\u007f]+$' };
const axis = { type: 'string', maxLength: 9, pattern: '^[^\\u0000-\\u001f\\u007f]*$' };
const cursor = { type: 'string', minLength: 1, maxLength: 2048, description: 'Use next_cursor from the previous response with the same filters.' };
const orderNo = { type: 'string', minLength: 1, maxLength: 12, pattern: '^[A-Za-z0-9_-]+$' };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
function actionsFor() {
  return {
    'products.list': action('R', 'Read one page of futureshop products.', { product_no: product, count: { type: 'integer', minimum: 50, maximum: 250 }, cursor }),
    'inventory.get': action('R', 'Read regular stock for one futureshop product, including variation axis codes.', { product_no: product }, ['product_no']),
    'orders.list': action('R', 'Read one page of orders for one Japan calendar day without buyer, address or payment details.', { day: { type: 'string', pattern: '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' }, cursor }, ['day']),
    'orders.get': action('R', 'Read order totals and status without buyer, address or payment details.', { order_no: orderNo }, ['order_no']),
    'inventory.set': action('H', 'Replace regular stock for one existing product/variation. Axis codes must match inventory.get; omitted or empty codes identify an unused axis. Never automatically retry an uncertain update.',
      { product_no: product, vertical_no: axis, horizontal_no: axis, quantity: { type: 'integer', minimum: 0, maximum: 999999999 } }, ['product_no', 'quantity']),
  };
}
const ORDER_KEYS = new Set(['orderList', 'orderNo', 'type', 'date', 'dateLastUpdated', 'status', 'grandTotal', 'totalCost', 'productTotal', 'taxTotal', 'postage', 'usedPoint', 'usedPointPrice']);
function orders(value) {
  if (Array.isArray(value)) return value.map(orders);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => ORDER_KEYS.has(key)).map(([key, child]) => [key, orders(child)]));
}
function nextCursor(config, data, route) {
  if (!data.nextUrl) return null;
  let next;
  try { next = new URL(data.nextUrl); } catch { fail('E_TOOL_CALL_UPSTREAM', 'Invalid futureshop pagination'); }
  const value = next.searchParams.get('cursor');
  if (next.origin !== config.metadata.api_origin || next.pathname !== route || next.username || next.password || next.hash
    || !value || value.length > 2048) fail('E_TOOL_CALL_UPSTREAM', 'Invalid futureshop pagination');
  return value;
}
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('E_BAD_INPUT', 'Unreviewed futureshop action');
  validate(parameters, spec.input_schema);
  const p = parameters;
  for (const [key, bytes] of [['product_no', 32], ['vertical_no', 9], ['horizontal_no', 9], ['order_no', 12]]) {
    if (p[key] !== undefined && Buffer.byteLength(p[key], 'utf8') > bytes) fail('E_BAD_INPUT', 'futureshop identifier exceeds the API byte limit');
  }
  if (name === 'orders.list') {
    const parsed = new Date(`${p.day}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== p.day) fail('E_BAD_INPUT', 'Invalid futureshop calendar date');
  }
  await ensureToken(config);
  if (name === 'inventory.set') {
    const verticalNo = p.vertical_no || '', horizontalNo = p.horizontal_no || '';
    const current = await request(config, '/admin-api/v1/inventory', { query: { productNo: p.product_no, types: 'regular' } });
    const rows = current.productList?.find(row => row.productNo === p.product_no)?.inventoryInfo?.regular?.inventoryList;
    if (!Array.isArray(rows) || !rows.some(row => (row.verticalNo || '') === verticalNo && (row.horizontalNo || '') === horizontalNo)) fail('E_BAD_INPUT', 'Select an existing futureshop stock variation before updating');
    const data = await request(config, '/admin-api/v1/inventory', { body: { productList: [{ productNo: p.product_no,
      inventoryInfo: { regular: { inventoryList: [{ verticalNo, horizontalNo, count: p.quantity }] } } }] } });
    if (data.status !== 'success' || !Array.isArray(data.results) || data.results.length !== 1
      || data.results[0].status !== 'success' || data.results[0].productNo !== p.product_no) fail('E_TOOL_CALL_UPSTREAM', 'futureshop did not confirm the stock update; inspect the shop before retrying');
    return { status: 'completed' };
  }
  const routes = {
    'products.list': ['/admin-api/v1/products', { count: p.count || 50, ...(p.product_no ? { productNo: p.product_no } : {}), ...(p.cursor ? { cursor: p.cursor } : {}) }],
    'inventory.get': ['/admin-api/v1/inventory', { types: 'regular', productNo: p.product_no }],
    'orders.list': ['/admin-api/v1/shipping', { orderDateStart: `${p.day}T00:00:00`, orderDateEnd: `${p.day}T23:59:59`, ...(p.cursor ? { cursor: p.cursor } : {}) }],
    'orders.get': [`/admin-api/v1/orders/${p.order_no}`, {}],
  };
  const [route, query] = routes[name];
  let data = await request(config, route, { query });
  if (name === 'orders.get' ? data.orderNo !== p.order_no : !Array.isArray(data[name.startsWith('orders.') ? 'orderList' : 'productList'])) fail('E_TOOL_CALL_UPSTREAM', 'futureshop returned incomplete data');
  const next_cursor = nextCursor(config, data, route);
  delete data.nextUrl;
  if (name.startsWith('orders.')) data = orders(data);
  for (const secret of [...secrets.map(key => config.credentials[key]), session(config).access_token]) data = safeOutput(data, secret);
  return { data, next_cursor };
}
async function identity(config) {
  validateBinding(config);
  await execute(config, 'products.list', { count: 50 });
  return { authorization_verified: true };
}
async function authorize(config) {
  setup(config);
  const credentials = { provider: 'futureshop', ...Object.fromEntries(secrets.map(key => [key, config.credentials[key]])), identity: { fingerprint: fingerprint(config) } };
  await identity({ ...config, credentials });
  return credentials;
}
module.exports = { isProvider, normalizeBinding, apiBase, validateBinding, actionsFor, identity, execute, authorize };
