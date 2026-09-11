'use strict';

const { requestFetch } = require('./commerce-request-context.cjs');

// Magento Open Source / Adobe Commerce PaaS 2.4 integration credentials.
// Adobe Commerce SaaS (IMS authentication) is a different API and is not accepted.
const crypto = require('node:crypto');
const net = require('node:net');
const dns = require('node:dns').promises;
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const fail = (kind, message) => { throw Object.assign(new Error(message), { code: `storefront_${kind}` }); };
const isProvider = (provider) => provider === 'magento';
const CREDENTIALS = ['consumer_key', 'consumer_secret', 'access_token', 'token_secret'];
const SKU = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9_. -]*$' };
const PAGE = { page: { type: 'integer', minimum: 1, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const INTEGER = { type: 'integer', minimum: 0, maximum: 2147483647 };
const MONEY = { type: 'string', maxLength: 12, pattern: '^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,2})?$' };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });

function normalizeBinding(raw) {
  if (typeof raw !== 'string' || /[\\\s\u0000-\u001f\u007f]/.test(raw)) fail('invalid_binding', 'Invalid Magento store URL');
  let u;
  try { u = new URL(raw.includes('://') ? raw : `https://${raw}`); } catch { fail('invalid_binding', 'Invalid Magento store URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.search || u.hash || net.isIP(u.hostname)
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(u.hostname)
      || /\.(?:localhost|local|internal|test|invalid|example)$/.test(u.hostname)
      || /(?:^|\/)\.\.?($|\/)|%|\/rest(?:\/|$)|\/admin(?:\/|$)/i.test(raw.replace(/^https:\/\/[^/]+/, ''))
      || !/^(?:\/[A-Za-z0-9_-]+)*\/?$/.test(u.pathname)) fail('invalid_binding', 'Use the public HTTPS Magento installation URL without an admin or REST path');
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

function apiBase(_provider, metadata) {
  if (!metadata || Object.keys(metadata).length !== 1 || normalizeBinding(metadata.store_url) !== metadata.store_url) fail('invalid_binding', 'Invalid Magento store binding');
  return `${metadata.store_url}/rest/V1`;
}

function validateCredentials(config) {
  if (!isProvider(config.provider)) fail('invalid_binding', 'Unsupported Magento provider');
  apiBase(config.provider, config.metadata);
  for (const key of CREDENTIALS) {
    if (typeof config.credentials?.[key] !== 'string' || !/^[A-Za-z0-9_-]{8,512}$/.test(config.credentials[key])) fail('invalid_credentials', 'Invalid Magento integration credential');
  }
}

function validateBinding(config) {
  validateCredentials(config);
  if (config.credentials.provider !== config.provider || config.credentials.identity?.binding !== config.metadata.store_url
      || !Array.isArray(config.credentials.identity?.stores) || !config.credentials.identity.stores.length) fail('binding_mismatch', 'Magento credential binding changed; reconnect the connector');
}

function publicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b))
      || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  // Only globally routed IPv6 unicast; mapped, link-local and ULA addresses fail closed.
  return net.isIPv6(address) && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:db8|0):/i.test(address);
}

async function assertPublicHost(hostname) {
  let timer;
  try {
    const addresses = await Promise.race([dns.lookup(hostname, { all: true }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 60000); })]);
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) fail('invalid_binding', 'Magento host must resolve only to public addresses');
  } catch (error) {
    if (error?.code?.startsWith('storefront_')) throw error;
    fail('network_failed', 'Cannot resolve the Magento store; check its public HTTPS address');
  } finally { clearTimeout(timer); }
}

const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
function oauthHeader(method, url, credentials, nonce = crypto.randomBytes(16).toString('hex'), timestamp = String(Math.floor(Date.now() / 1000))) {
  const u = new URL(url);
  const oauth = { oauth_consumer_key: credentials.consumer_key, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA256', oauth_timestamp: timestamp, oauth_token: credentials.access_token, oauth_version: '1.0' };
  const params = [...u.searchParams.entries(), ...Object.entries(oauth)].map(([k, v]) => [encode(k), encode(v)]).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0);
  const base = [method, encode(u.origin + u.pathname), encode(params.map(([k, v]) => `${k}=${v}`).join('&'))].join('&');
  oauth.oauth_signature = crypto.createHmac('sha256', `${encode(credentials.consumer_secret)}&${encode(credentials.token_secret)}`).update(base).digest('base64');
  return `OAuth ${Object.entries(oauth).map(([k, v]) => `${k}="${encode(v)}"`).join(', ')}`;
}

async function request(config, path, { method = 'GET', query = {}, body } = {}) {
  validateCredentials(config);
  const url = new URL(apiBase(config.provider, config.metadata) + path);
  Object.entries(query).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  await assertPublicHost(url.hostname);
  let response;
  try {
    response = await requestFetch(url.toString(), { method, headers: { accept: 'application/json', 'content-type': 'application/json', authorization: oauthHeader(method, url.toString(), config.credentials) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60000) });
  } catch (error) { fail(['TimeoutError', 'AbortError'].includes(error?.name) ? 'timeout' : 'network_failed', `Magento request failed${method !== 'GET' ? '; check the store before retrying an uncertain write' : ''}`); }
  if (!response.ok) fail([401, 403].includes(response.status) ? 'permission_denied' : response.status === 429 ? 'rate_limit' : 'upstream_error', `Magento API failed (HTTP ${response.status}); check integration permissions and store availability`);
  let data;
  try { data = JSON.parse(await readBody(response)); } catch { fail('upstream_error', 'Magento returned invalid or oversized JSON'); }
  if (data === null || typeof data !== 'object' || data.message || data.errors) fail('upstream_error', 'Magento returned an unexpected response');
  return data;
}

function actionsFor() {
  return {
    'shop.get': action('R', 'Read the verified Magento installation and store views without contact details.'),
    'products.list': action('R', 'Read one product page, including total_count; stock and price use separate actions.', PAGE),
    'products.get': action('R', 'Read one product by SKU.', { sku: SKU }, ['sku']),
    'orders.list': action('R', 'Read one order page with buyer and address information removed.', PAGE),
    'orders.get': action('R', 'Read one order without buyer, address or payment details.', { order_id: { ...INTEGER, minimum: 1 } }, ['order_id']),
    'sources.list': action('R', 'List inventory sources without address or contact details.', PAGE),
    'inventory.list': action('R', 'Read physical source stock for one SKU; this is not salable stock after reservations.', { sku: SKU, ...PAGE }, ['sku']),
    'products.set_price': action('H', 'Set one base selling price after fresh confirmation. Supports simple, virtual, downloadable and fixed-price bundle products.', { sku: SKU, store_id: INTEGER, price: MONEY }, ['sku', 'store_id', 'price']),
    'inventory.set': action('H', 'Replace physical stock and availability at one source after fresh confirmation. Does not modify reservations. Never automatically retry an uncertain write.',
      { sku: SKU, source_code: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' }, quantity: INTEGER, status: { type: 'integer', minimum: 0, maximum: 1, description: '0 = out of stock; 1 = in stock.' } }, ['sku', 'source_code', 'quantity', 'status']),
  };
}

async function identity(config) {
  const data = await request(config, '/store/storeConfigs');
  if (!Array.isArray(data) || !data.length || data.some((s) => !Number.isSafeInteger(s.id) || typeof s.code !== 'string')) fail('invalid_response', 'Magento store identity is missing');
  const stores = data.map((s) => ({ id: s.id, code: s.code, website_id: s.website_id, currency: s.base_currency_code })).sort((a, b) => a.id - b.id);
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(stores.map(({ id, code, website_id }) => ({ id, code, website_id })))).digest('hex');
  if (config.credentials.identity && config.credentials.identity.fingerprint !== fingerprint) fail('binding_mismatch', 'Magento store views changed; reconnect to verify this installation');
  return { binding: config.metadata.store_url, fingerprint, stores };
}

function pick(value, keys) {
  if (Array.isArray(value)) return value.map((v) => pick(v, keys));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => keys.includes(k)).map(([k, v]) => [k, pick(v, keys)]));
}

async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('validation_failed', 'Unreviewed Magento action');
  validate(parameters, spec.input_schema);
  if (name === 'shop.get') return identity(config);
  const p = parameters;
  if (name === 'products.set_price' && p.store_id !== 0 && !config.credentials.identity.stores.some((store) => store.id === p.store_id)) fail('validation_failed', 'Magento price store ID must be 0 or one of the verified store views');
  const query = { 'searchCriteria[pageSize]': p.limit || 50, 'searchCriteria[currentPage]': p.page || 1 };
  const routes = {
    'products.list': ['/products', { query }], 'products.get': [`/products/${encode(p.sku || '')}`],
    'orders.list': ['/orders', { query }], 'orders.get': [`/orders/${p.order_id}`],
    'sources.list': ['/inventory/sources', { query }],
    'inventory.list': ['/inventory/source-items', { query: { ...query, 'searchCriteria[filter_groups][0][filters][0][field]': 'sku', 'searchCriteria[filter_groups][0][filters][0][value]': p.sku, 'searchCriteria[filter_groups][0][filters][0][condition_type]': 'eq' } }],
    'products.set_price': ['/products/base-prices', { method: 'POST', body: { prices: [{ price: Number(p.price), store_id: p.store_id, sku: p.sku }] } }],
    'inventory.set': ['/inventory/source-items', { method: 'POST', body: { sourceItems: [{ sku: p.sku, source_code: p.source_code, quantity: p.quantity, status: p.status }] } }],
  };
  let data = await request(config, ...routes[name]);
  if (spec.risk === 'H') {
    if (!Array.isArray(data) || data.length) fail('upstream_error', 'Magento write was not fully acknowledged; inspect the store before retrying');
    return { status: 'completed' };
  }
  if (name.endsWith('.list') && (!Array.isArray(data.items) || !Number.isSafeInteger(data.total_count))) fail('invalid_response', 'Magento pagination is missing');
  if (name.startsWith('orders.')) data = pick(data, ['items', 'total_count', 'entity_id', 'increment_id', 'status', 'state', 'created_at', 'updated_at', 'store_id', 'order_currency_code', 'grand_total', 'subtotal', 'tax_amount', 'discount_amount', 'shipping_amount', 'item_id', 'order_id', 'product_id', 'sku', 'name', 'qty_ordered', 'qty_shipped', 'qty_refunded', 'price', 'row_total']);
  if (name === 'sources.list') data = pick(data, ['items', 'total_count', 'source_code', 'name', 'enabled']);
  for (const key of CREDENTIALS) data = safeOutput(data, config.credentials[key]);
  return { data, ...(name.endsWith('.list') ? { page: p.page || 1, limit: p.limit || 50 } : {}) };
}

async function authorize(config) {
  validateCredentials(config);
  const credentials = { provider: config.provider, ...Object.fromEntries(CREDENTIALS.map((key) => [key, config.credentials[key]])), identity: await identity(config) };
  const bound = { ...config, credentials };
  for (const name of ['products.list', 'orders.list', 'sources.list']) await execute(bound, name, { limit: 1 });
  return credentials;
}

module.exports = { isProvider, normalizeBinding, apiBase, validateBinding, actionsFor, identity, execute, authorize, oauthHeader, publicAddress };
