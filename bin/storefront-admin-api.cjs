'use strict';

const { requestFetch } = require('./commerce-request-context.cjs');

// Merchant-owned production tokens. Endpoints and schemas are intentionally closed;
// this module is consumed by the existing direct-commerce MCP and authorization owners.
const PROVIDERS = new Set(['bigcommerce', 'shopline', 'shoplazza']);
const SHOPLINE_VERSION = 'v20260901';
const SHOPLAZZA_VERSION = '2026-01'; // The provider still labels 2026-07 unreleased.
const MAX_BYTES = 1024 * 1024;
const ID = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
const CURSOR = { type: 'string', minLength: 1, maxLength: 2048 };
const LIMIT = { type: 'integer', minimum: 1, maximum: 100 };
const IDS = { type: 'array', items: ID, minItems: 1, maxItems: 100 };
const MONEY = { type: 'string', pattern: '^(0|[1-9][0-9]{0,8})(\\.[0-9]{1,2})?$', maxLength: 12 };

function isProvider(provider) { return PROVIDERS.has(provider); }
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function normalizeBinding(provider, raw) {
  if (!isProvider(provider) || typeof raw !== 'string' || /[\s\\\u0000-\u001f\u007f]/.test(raw)) {
    fail('storefront_invalid_binding', 'Invalid storefront store identifier');
  }
  let value = raw.toLowerCase();
  if (provider === 'bigcommerce') {
    const match = /^https:\/\/api\.bigcommerce\.com\/stores\/([a-z0-9]{2,32})\/(?:v[23]\/?)?$/.exec(value);
    if (match) value = match[1];
    if (!/^[a-z0-9]{2,32}$/.test(value)) fail('storefront_invalid_binding', 'Invalid BigCommerce store hash or API path');
    return value;
  }
  const suffix = provider === 'shopline' ? 'myshopline.com' : 'myshoplaza.com';
  if (/^https:\/\//.test(value)) value = value.slice(8).replace(/\/$/, '');
  if (!value.includes('.')) value = `${value}.${suffix}`;
  const parts = value.split('.');
  if (parts.length !== 3 || parts.slice(1).join('.') !== suffix
      || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(parts[0])) {
    fail('storefront_invalid_binding', 'Use the original HTTPS storefront domain, without a path, port or custom domain');
  }
  return value;
}

function bindingOf(provider, metadata) {
  if (!object(metadata)) fail('storefront_invalid_binding', 'Invalid storefront metadata');
  const key = provider === 'bigcommerce' ? 'store_hash' : 'store_domain';
  if (Object.keys(metadata).some((field) => field !== key)) fail('storefront_invalid_binding', 'Unexpected storefront binding field');
  const value = normalizeBinding(provider, metadata[key]);
  if (metadata[key] !== value) fail('storefront_invalid_binding', 'Storefront binding must be canonical');
  return value;
}

function apiBase(provider, metadata) {
  const binding = bindingOf(provider, metadata);
  if (provider === 'bigcommerce') return `https://api.bigcommerce.com/stores/${binding}`;
  return provider === 'shopline'
    ? `https://${binding}/admin/openapi/${SHOPLINE_VERSION}`
    : `https://${binding}/openapi/${SHOPLAZZA_VERSION}`;
}

function validateCredentials(config) {
  bindingOf(config.provider, config.metadata);
  const token = config.credentials?.access_token;
  if (typeof token !== 'string' || token.length < 8 || token.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(token)) {
    fail('storefront_invalid_credentials', 'Invalid storefront access token');
  }
}

function validateBinding(config) {
  validateCredentials(config);
  const identity = config.credentials.identity;
  if (!object(identity) || identity.binding !== bindingOf(config.provider, config.metadata)
      || !identity.shop_id || config.credentials.provider !== config.provider) {
    fail('storefront_binding_mismatch', 'Storefront credential binding changed; reconnect this connector');
  }
}

function action(risk, description, properties = {}, required = []) {
  return { risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } };
}

function actionsFor(provider) {
  if (!isProvider(provider)) fail('storefront_invalid_binding', 'Unsupported storefront provider');
  const paging = provider === 'bigcommerce'
    ? { limit: LIMIT, page: { type: 'integer', minimum: 1, maximum: 100000 } }
    : { limit: LIMIT, cursor: CURSOR };
  const inventory = provider === 'bigcommerce' ? { location_id: ID, ...paging }
    : { inventory_item_ids: IDS, location_ids: IDS, ...(provider === 'shoplazza' ? paging : {}) };
  return {
    'shop.get': action('R', 'Read the verified store identity, name and currency; no owner contact details.'),
    'products.list': action('R', 'List one page of products. Preserve the returned pagination; do not assume this is the whole catalog.', paging),
    'products.get': action('R', 'Get a product with its variants and inventory identifiers.', { product_id: ID }, ['product_id']),
    'variants.list': action('R', 'List variants belonging to a product.', { product_id: ID, ...(provider === 'shoplazza' ? {} : paging) }, ['product_id']),
    'orders.list': action('R', 'Read one page of orders with buyer/contact/payment credentials removed.', paging),
    'orders.get': action('R', 'Read one order with buyer/contact/payment credentials removed.', { order_id: ID }, ['order_id']),
    'locations.list': action('R', 'List store inventory locations.', provider === 'shopline' ? {} : paging),
    'inventory.list': action('R', 'Read inventory at locations. Inventory item IDs are not SKU or variant IDs.', inventory, provider === 'bigcommerce' ? ['location_id'] : provider === 'shopline' ? ['inventory_item_ids'] : []),
    ...(provider === 'shoplazza' ? {
      'inventory.items_for_variants': action('R', 'Resolve variant IDs from products.get or variants.list into the inventory item IDs required for inventory.list and inventory.set.', { variant_ids: IDS }, ['variant_ids']),
    } : {}),
    'variants.set_price': action('H', 'Set one variant base selling price in store currency after fresh confirmation. Does not change price lists or compare-at prices.',
      { ...(provider === 'bigcommerce' ? { product_id: ID } : {}), variant_id: ID, price: MONEY }, provider === 'bigcommerce' ? ['product_id', 'variant_id', 'price'] : ['variant_id', 'price']),
    'inventory.set': action('H', 'Replace the absolute stock quantity for one item at one location after fresh confirmation. Never automatically retry an uncertain write.',
      { location_id: ID, [provider === 'bigcommerce' ? 'variant_id' : 'inventory_item_id']: ID, quantity: { type: 'integer', minimum: 0, maximum: 2147483647 } },
      ['location_id', provider === 'bigcommerce' ? 'variant_id' : 'inventory_item_id', 'quantity']),
  };
}

function validate(value, schema) {
  if (schema.type === 'object') {
    if (!object(value) || Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key))
        || schema.required.some((key) => !Object.hasOwn(value, key))) throw new Error('Invalid storefront action parameters');
    for (const [key, child] of Object.entries(value)) validate(child, schema.properties[key]);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) throw new Error('Invalid storefront ID batch');
    value.forEach((child) => validate(child, schema.items));
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum) throw new Error('Invalid storefront numeric parameter');
  } else if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > schema.maxLength
      || /[\u0000-\u001f\u007f]/.test(value) || (schema.pattern && !new RegExp(schema.pattern).test(value))) {
    throw new Error('Invalid storefront string parameter');
  }
}

function numericId(value) {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error('Invalid BigCommerce numeric ID');
  return Number(value);
}

// Provider error text is untrusted and may echo credentials or consumer data.
function safeOutput(value, token) {
  if (typeof value === 'string') return value.split(token).join('[redacted]');
  if (Array.isArray(value)) return value.map((item) => safeOutput(item, token));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/(?:token|secret|authorization|password|cookie|email|phone|address|customer|buyer|first_name|last_name|ip_address|payment_details|payment_source|credit_card|staff_notes|customer_message|note_attributes)/i.test(key))
    .map(([key, child]) => [key, safeOutput(child, token)]));
}

const ORDER_FIELDS = new Set([
  'orders', 'order', 'id', 'order_id', 'order_number', 'order_no', 'number', 'name',
  'status', 'status_id', 'financial_status', 'fulfillment_status', 'payment_status',
  'created_at', 'updated_at', 'date_created', 'date_modified', 'currency', 'currency_code',
  'total_price', 'total', 'total_inc_tax', 'total_ex_tax', 'subtotal', 'subtotal_price',
  'subtotal_inc_tax', 'subtotal_ex_tax', 'total_tax', 'total_discount', 'total_discounts',
  'total_shipping_price', 'shipping_cost_inc_tax', 'shipping_cost_ex_tax', 'items_total',
  'items_shipped', 'line_items', 'items', 'product_id', 'variant_id', 'sku', 'title',
  'quantity', 'price', 'product_price', 'fulfillable_quantity', 'discount_amount',
  'cursor', 'pre_cursor', 'has_more', 'total_count',
]);
function minimizeOrders(value) {
  if (Array.isArray(value)) return value.map(minimizeOrders);
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => ORDER_FIELDS.has(key))
    .map(([key, child]) => [key, minimizeOrders(child)]));
}

async function readBody(response) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('oversized');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); throw new Error('oversized'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function request(config, route) {
  validateCredentials(config);
  const base = apiBase(config.provider, config.metadata);
  const url = new URL(base + route.path);
  for (const [key, value] of Object.entries(route.query || {})) {
    if (value === undefined) continue;
    if (Array.isArray(value) && config.provider === 'shoplazza') value.forEach((item) => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }
  const token = config.credentials.access_token;
  const headers = { accept: 'application/json', 'content-type': 'application/json; charset=utf-8' };
  headers[config.provider === 'bigcommerce' ? 'X-Auth-Token' : config.provider === 'shoplazza' ? 'Access-Token' : 'Authorization'] = config.provider === 'shopline' ? `Bearer ${token}` : token;
  let response;
  try {
    response = await requestFetch(url.toString(), { method: route.method || 'GET', headers,
      ...(route.body ? { body: JSON.stringify(route.body) } : {}), redirect: 'error', signal: AbortSignal.timeout(60_000) });
  } catch (error) {
    fail(['AbortError', 'TimeoutError'].includes(error?.name) ? 'storefront_timeout' : 'storefront_network_failed',
      `Storefront request failed${route.method ? '; write outcome may be unknown, check the store before retrying' : ''}`);
  }
  if (!response.ok) {
    fail([401, 403].includes(response.status) ? 'storefront_permission_denied' : response.status === 429 ? 'storefront_rate_limit'
      : response.status >= 500 ? 'storefront_upstream_error' : 'storefront_validation_failed',
      `Storefront API failed (HTTP ${response.status})${[401, 403].includes(response.status) ? '; check the token and required scopes' : ''}${route.method && response.status >= 500 ? '; write outcome may be unknown, check the store before retrying' : ''}`);
  }
  // V2 BigCommerce order lists use 204 for an empty store.
  if (response.status === 204 && route.empty204) return { data: [] };
  let body;
  try {
    const text = await readBody(response);
    body = JSON.parse(text);
  } catch { fail('storefront_upstream_error', 'Storefront API returned invalid or oversized JSON'); }
  if ((!object(body) && !Array.isArray(body)) || body.error || body.errors
      || (body.code !== undefined && !['', '0'].includes(String(body.code)))) {
    fail('storefront_request_failed', 'Storefront API returned a business error; check store permissions and action parameters');
  }
  const data = config.provider === 'shoplazza' ? body.data : body;
  const resource = route.key ? data?.[route.key] : data;
  if ((route.list && !Array.isArray(resource)) || (!route.list && !object(resource))) {
    fail('storefront_upstream_error', 'Storefront API returned an unexpected resource shape');
  }
  const result = { data: safeOutput(data, token) };
  // Return only an opaque cursor from the same endpoint, never an executable next URL.
  const link = response.headers?.get?.('link') || '';
  for (const match of link.matchAll(/<([^>]+)>\s*;\s*rel="?next"?/g)) {
    try {
      const next = new URL(match[1]);
      if (next.origin === url.origin && next.pathname === url.pathname) {
        const cursor = next.searchParams.get('page_info');
        if (cursor && cursor.length <= 2048) result.next_cursor = cursor;
      }
    } catch { /* Malformed pagination is not a destination to follow. */ }
  }
  if (config.provider === 'bigcommerce' && Array.isArray(data)) {
    result.page = route.query?.page || 1;
    result.limit = route.query?.limit || 50;
    result.may_have_more = data.length === result.limit;
  }
  return result;
}

async function identity(config) {
  const key = config.provider === 'shopline' ? 'data' : undefined;
  const { data } = await request(config, { path: config.provider === 'bigcommerce' ? '/v2/store' : config.provider === 'shopline' ? '/merchants/shop.json' : '/shop', key });
  const shop = key ? data[key] : data;
  if (!['string', 'number'].includes(typeof shop.id) || !String(shop.id) || shop.id === 0) fail('storefront_invalid_response', 'Storefront identity is missing');
  const binding = bindingOf(config.provider, config.metadata);
  if (config.provider === 'shoplazza' && shop.system_domain && normalizeBinding(config.provider, shop.system_domain) !== binding) {
    fail('storefront_binding_mismatch', 'Storefront returned a different store identity');
  }
  if (config.credentials.identity && String(shop.id) !== config.credentials.identity.shop_id) {
    fail('storefront_binding_mismatch', 'Storefront account changed; reconnect this connector');
  }
  return { binding, shop_id: String(shop.id), name: String(shop.name || ''), currency: String(shop.currency || '') };
}

async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor(config.provider)[name];
  if (!spec) throw new Error('Unreviewed storefront action');
  validate(parameters, spec.input_schema);
  if (name === 'shop.get') return identity(config);
  const p = parameters;
  const limit = p.limit || 50;
  const paged = { limit, page: p.page || 1 };
  let route;
  if (config.provider === 'bigcommerce') {
    if (name === 'products.list') route = { path: '/v3/catalog/products', query: paged, key: 'data', list: true };
    if (name === 'products.get') route = { path: `/v3/catalog/products/${numericId(p.product_id)}`, query: { include: 'variants' }, key: 'data' };
    if (name === 'variants.list') route = { path: `/v3/catalog/products/${numericId(p.product_id)}/variants`, query: paged, key: 'data', list: true };
    if (name === 'orders.list') route = { path: '/v2/orders', query: paged, list: true, empty204: true };
    if (name === 'orders.get') route = { path: `/v2/orders/${numericId(p.order_id)}` };
    if (name === 'locations.list') route = { path: '/v3/inventory/locations', query: paged, key: 'data', list: true };
    if (name === 'inventory.list') route = { path: `/v3/inventory/locations/${numericId(p.location_id)}/items`, query: paged, key: 'data', list: true };
    if (name === 'variants.set_price') route = { method: 'PUT', path: `/v3/catalog/products/${numericId(p.product_id)}/variants/${numericId(p.variant_id)}`, body: { price: Number(p.price) }, key: 'data' };
    if (name === 'inventory.set') route = { method: 'PUT', path: '/v3/inventory/adjustments/absolute', body: { items: [{ location_id: numericId(p.location_id), variant_id: numericId(p.variant_id), quantity: p.quantity }], reason: 'Orkas confirmed absolute inventory update' } };
  } else if (config.provider === 'shopline') {
    const query = { limit, page_info: p.cursor };
    if (name === 'products.list') route = { path: '/products/products.json', query, key: 'products', list: true };
    if (name === 'products.get') route = { path: `/products/${p.product_id}.json`, key: 'product' };
    if (name === 'variants.list') route = { path: `/products/${p.product_id}/variants.json`, query, key: 'variants', list: true };
    if (name === 'orders.list' || name === 'orders.get') route = { path: '/orders.json', query: name === 'orders.get' ? { ids: p.order_id } : query, key: 'orders', list: true };
    if (name === 'locations.list') route = { path: '/locations/list.json', key: 'locations', list: true };
    if (name === 'inventory.list') route = { path: '/inventory_levels.json', query: { inventory_item_ids: p.inventory_item_ids, location_ids: p.location_ids }, key: 'inventory_levels', list: true };
    if (name === 'variants.set_price') route = { method: 'PUT', path: `/products/variants/${p.variant_id}.json`, body: { variant: { price: p.price } }, key: 'variant' };
    if (name === 'inventory.set') route = { method: 'POST', path: '/inventory_levels/set.json', body: { inventory_item_id: p.inventory_item_id, location_id: p.location_id, available: p.quantity }, key: 'inventory_level' };
  } else {
    const query = { page_size: limit, cursor: p.cursor };
    if (name === 'products.list') route = { path: '/products', query: { per_page: limit, cursor: p.cursor }, key: 'products', list: true };
    if (name === 'products.get') route = { path: `/products/${p.product_id}`, key: 'product' };
    if (name === 'variants.list') route = { path: `/products/${p.product_id}/variants`, key: 'variants', list: true };
    if (name === 'orders.list') route = { path: '/orders', query, key: 'orders', list: true };
    if (name === 'orders.get') route = { path: `/orders/${p.order_id}`, key: 'order' };
    if (name === 'locations.list') route = { path: '/locations', query, key: 'locations', list: true };
    if (name === 'inventory.list') route = { path: '/inventory_levels', query: { ...query, inventory_item_ids: p.inventory_item_ids, location_ids: p.location_ids }, key: 'inventory_levels', list: true };
    if (name === 'inventory.items_for_variants') route = { path: '/inventory_items/variant', query: { variant_ids: p.variant_ids }, key: 'variant_inventory_items', list: true };
    if (name === 'variants.set_price') {
      // Some products require a variant image on update. Preserve the existing one;
      // callers cannot inject image URLs or change other variant attributes.
      const current = await request(config, { path: `/variants/${p.variant_id}`, key: 'variant' });
      const image = current.data.variant.image;
      route = { method: 'PUT', path: `/variants/${p.variant_id}`, body: { variant: { price: Number(p.price),
        ...(object(image) && typeof image.src === 'string' && /^https:\/\//.test(image.src) ? { image: { src: image.src } } : {}) } }, key: 'variant' };
    }
    if (name === 'inventory.set') route = { method: 'POST', path: '/inventory_levels/set', body: { inventory_item_id: p.inventory_item_id, location_id: p.location_id, stock: p.quantity }, key: 'inventory_level' };
  }
  if (!route) throw new Error('Unreviewed storefront action');
  const result = await request(config, route);
  if (name.startsWith('orders.')) result.data = minimizeOrders(result.data);
  if (name === 'inventory.set' && config.provider === 'bigcommerce') {
    if (typeof result.data.transaction_id !== 'string' || !result.data.transaction_id) {
      fail('storefront_upstream_error', 'Inventory write acknowledgement is missing; check the store before retrying');
    }
    result.status = 'accepted';
    result.follow_up = 'BigCommerce processes this transaction asynchronously. Read inventory to verify the final stock; do not resubmit the adjustment automatically.';
  }
  return result;
}

async function authorize(config) {
  validateCredentials(config);
  const verified = await identity(config);
  const credentials = { provider: config.provider, access_token: config.credentials.access_token, identity: verified };
  const bound = { ...config, credentials };
  // Read probes establish useful account access without performing a test write.
  await execute(bound, 'products.list', { limit: 1 });
  await execute(bound, 'orders.list', { limit: 1 });
  await execute(bound, 'locations.list', config.provider === 'shopline' ? {} : { limit: 1 });
  return credentials;
}

module.exports = { isProvider, normalizeBinding, apiBase, validateBinding, actionsFor, execute, authorize, identity, SHOPLINE_VERSION, SHOPLAZZA_VERSION,
  validate, readBody, safeOutput };
