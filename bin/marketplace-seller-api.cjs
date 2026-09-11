'use strict';

const { requestFetch, credentialOperation, requestFailureCode, httpFailureCode } = require('./commerce-request-context.cjs');

// User-owned Shopee / TikTok Shop apps. Fixed endpoints only; no caller-supplied transport.
// Protocol references: open.shopee.com/developer-guide/20 and
// partner.tiktokshop.com/docv2/page/authorization-overview-202407 (verified 2026-09-05).
const { createHmac } = require('node:crypto');
const { readCredentialFile, writeCredentialFile } = require('./local-api-credential-codec.cjs');

const isSellerProvider = (provider) => provider === 'shopee' || provider === 'tiktok_shop';
const SHOP_HOSTS = Object.freeze({
  global: ['https://partner.shopeemobile.com', 'https://openplatform.sandbox.test-stable.shopee.sg'],
  cn: ['https://openplatform.shopee.cn', 'https://openplatform.sandbox.test-stable.shopee.cn'],
  br: ['https://openplatform.shopee.com.br', 'https://openplatform.sandbox.test-stable.shopee.sg'],
});
const TTS_API = 'https://open-api.tiktokglobalshop.com';
const TTS_AUTH = 'https://auth.tiktok-shops.com/api/v2/token';
const REFRESH_BUFFER = 120_000;
const refreshes = new Map();

function failure(message, code = 'local_api_authorization_failed') {
  return Object.assign(new Error(message), { code });
}

function numericId(value, zero = false) {
  if (typeof value !== 'string' || !(zero ? /^(0|[1-9][0-9]{0,24})$/ : /^[1-9][0-9]{0,24}$/).test(value)) {
    throw new Error('A decimal platform ID is required');
  }
  return value;
}

function shopeeNumber(value, zero = false) {
  const result = Number(numericId(value, zero));
  if (!Number.isSafeInteger(result)) throw new Error('Shopee ID exceeds the supported integer range');
  return result;
}

function validateSetup(provider, metadata, credentials) {
  if (!isSellerProvider(provider)) throw new Error('Unsupported seller provider');
  if (provider === 'shopee') {
    shopeeNumber(metadata.shop_id);
    shopeeNumber(credentials.partner_id);
    if (!Object.hasOwn(SHOP_HOSTS, metadata.region) || !['live', 'sandbox'].includes(metadata.environment)) {
      throw new Error('Invalid Shopee region or environment');
    }
    if (typeof credentials.partner_key !== 'string' || credentials.partner_key.length < 8) throw new Error('Invalid Shopee Partner Key');
  } else {
    // Seller Center shop codes may be alphanumeric; the API shop ID is resolved after consent.
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(metadata.shop_id || '') || !['us', 'row'].includes(metadata.region)) {
      throw new Error('Invalid TikTok Shop code or authorization region');
    }
    numericId(credentials.service_id);
    if (typeof credentials.app_key !== 'string' || credentials.app_key.length < 3
        || typeof credentials.app_secret !== 'string' || credentials.app_secret.length < 8) throw new Error('Invalid TikTok Shop application credentials');
  }
}

function validateBinding(config) {
  const { provider, metadata, credentials } = config;
  validateSetup(provider, metadata, credentials);
  if (credentials.provider !== provider || credentials.identity?.binding_shop_id !== metadata.shop_id
      || credentials.identity?.region !== metadata.region
      || (provider === 'shopee' && credentials.identity?.environment !== metadata.environment)) {
    throw failure('The saved authorization does not match this shop. Reconnect the connector.');
  }
  if (typeof credentials.access_token !== 'string' || !credentials.access_token
      || typeof credentials.refresh_token !== 'string' || !credentials.refresh_token
      || !Number.isFinite(credentials.expires_at) || !Number.isFinite(credentials.refresh_expires_at)) {
    throw failure('Shop authorization is incomplete. Reconnect the connector.');
  }
  if (provider === 'tiktok_shop') {
    numericId(credentials.identity.shop_id);
    if (typeof credentials.identity.shop_cipher !== 'string' || !credentials.identity.shop_cipher) {
      throw failure('Shop authorization is incomplete. Reconnect the connector.');
    }
  }
}

function apiBase(provider, metadata) {
  if (provider === 'tiktok_shop') return TTS_API;
  if (provider !== 'shopee' || !Object.hasOwn(SHOP_HOSTS, metadata.region)
      || !['live', 'sandbox'].includes(metadata.environment)) throw new Error('Invalid seller API region or environment');
  return SHOP_HOSTS[metadata.region][metadata.environment === 'sandbox' ? 1 : 0];
}

function authorizeUrl(provider, metadata, credentials, state, redirectUri) {
  validateSetup(provider, metadata, credentials);
  let url;
  if (provider === 'shopee') {
    const suffix = metadata.region === 'cn' ? 'cn' : metadata.region === 'br' ? 'com.br' : 'com';
    url = new URL(`https://open.${metadata.environment === 'sandbox' ? 'sandbox.test-stable.' : ''}shopee.${suffix}/auth`);
    url.searchParams.set('partner_id', credentials.partner_id);
    url.searchParams.set('auth_type', 'seller');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
  } else {
    url = new URL(`https://services.${metadata.region === 'us' ? 'us.' : ''}tiktokshop.com/open/authorize`);
    url.searchParams.set('service_id', credentials.service_id);
  }
  url.searchParams.set('state', state);
  return url.toString();
}

function signShopee(partnerId, path, timestamp, key, token = '', shopId = '') {
  return createHmac('sha256', key).update(`${partnerId}${path}${timestamp}${token}${shopId}`).digest('hex');
}

function signTikTok(path, query, body, secret) {
  const parameters = Object.keys(query).filter((key) => key !== 'sign' && key !== 'access_token' && query[key] !== undefined).sort()
    .map((key) => `${key}${query[key]}`).join('');
  return createHmac('sha256', secret).update(`${secret}${path}${parameters}${body || ''}${secret}`).digest('hex');
}

async function requestJson(url, init, provider, fetchImpl = globalThis.fetch) {
  const deadline = AbortSignal.timeout(60_000);
  let response;
  try {
    response = await requestFetch(url, { ...init, redirect: 'error', signal: deadline }, fetchImpl);
  } catch (error) {
    throw failure('The platform request did not complete. Check your network and try again.', requestFailureCode(error, deadline));
  }
  if (!response.ok) {
    throw failure(response.status === 401 || response.status === 403
      ? 'Check the app permissions and shop authorization, then reconnect.'
      : 'The platform request failed. Check its service status and try again.',
    httpFailureCode(response.status));
  }
  let text;
  try { text = await response.text(); }
  catch (error) { throw failure('The platform response could not be read. Try again.', requestFailureCode(error, deadline)); }
  let result;
  try { result = JSON.parse(text); } catch { throw failure('The platform returned an invalid response. Try again.', 'E_TOOL_CALL_UPSTREAM'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)
      || (provider === 'shopee' ? typeof result.error !== 'string' || result.error !== '' : result.code !== 0)) {
    // Never copy provider messages: they may echo signing inputs, tokens or shop data.
    throw failure('The platform rejected the request. Check app permissions, shop authorization and action parameters.');
  }
  return result;
}

async function shopeeRequest(config, path, query = {}, body, token, fetchImpl) {
  const { metadata: m, credentials: c } = config;
  const timestamp = Math.floor(Date.now() / 1000);
  const url = new URL(path, apiBase('shopee', m));
  const common = { ...query, partner_id: c.partner_id, timestamp,
    ...(token ? { access_token: token, shop_id: m.shop_id } : {}) };
  common.sign = signShopee(c.partner_id, path, timestamp, c.partner_key, token || '', token ? m.shop_id : '');
  for (const [key, value] of Object.entries(common)) if (value !== undefined) url.searchParams.set(key, String(value));
  return requestJson(url.toString(), {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, 'shopee', fetchImpl);
}

async function tikTokRequest(config, path, query = {}, body, token, fetchImpl, shopScoped = true) {
  const c = config.credentials;
  const json = body === undefined ? '' : JSON.stringify(body);
  const common = { ...query, app_key: c.app_key, timestamp: Math.floor(Date.now() / 1000),
    ...(shopScoped ? { shop_cipher: c.identity.shop_cipher } : {}) };
  common.sign = signTikTok(path, common, json, c.app_secret);
  const url = new URL(path, TTS_API);
  for (const [key, value] of Object.entries(common)) if (value !== undefined) url.searchParams.set(key, String(value));
  const result = await requestJson(url.toString(), {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tts-access-token': token },
    ...(body === undefined ? {} : { body: json }),
  }, 'tiktok_shop', fetchImpl);
  if (!result.data || typeof result.data !== 'object') throw failure('The platform returned incomplete data. Try again.');
  return result.data;
}

function tokensFrom(provider, response, old = {}) {
  const data = provider === 'shopee' ? response : response.data;
  if (!data || typeof data.access_token !== 'string' || !data.access_token
      || typeof data.refresh_token !== 'string' || !data.refresh_token) throw failure('Authorization returned incomplete tokens. Reconnect.');
  const userType = data.user_type ?? old.user_type;
  if (provider === 'tiktok_shop' && ![0, 4, 5].includes(userType)) {
    throw failure('Authorize with a seller account, not a creator or partner account.');
  }
  const expiresAt = provider === 'shopee' ? Date.now() + data.expire_in * 1000 : data.access_token_expire_in * 1000;
  const refreshExpiresAt = provider === 'shopee' ? Date.now() + 30 * 86400_000 : data.refresh_token_expire_in * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || !Number.isFinite(refreshExpiresAt) || refreshExpiresAt <= Date.now()) {
    throw failure('Authorization has expired. Reconnect the connector.');
  }
  return { ...old, access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: expiresAt, refresh_expires_at: refreshExpiresAt,
    ...(provider === 'tiktok_shop' ? { user_type: userType,
      scopes: Array.isArray(data.granted_scopes) ? data.granted_scopes.filter((scope) => typeof scope === 'string') : old.scopes || [] } : {}) };
}

async function tokenRequest(config, code, refresh, fetchImpl) {
  const c = config.credentials;
  if (config.provider === 'shopee') {
    const response = await shopeeRequest(config, refresh ? '/api/v2/auth/access_token/get' : '/api/v2/auth/token/get', {}, {
      partner_id: shopeeNumber(c.partner_id), shop_id: shopeeNumber(config.metadata.shop_id),
      ...(refresh ? { refresh_token: c.refresh_token } : { code }),
    }, undefined, fetchImpl);
    if (response.shop_id !== undefined && String(response.shop_id) !== config.metadata.shop_id) throw failure('Authorization belongs to another shop.');
    if (response.partner_id !== undefined && String(response.partner_id) !== c.partner_id) throw failure('Authorization belongs to another app.');
    return response;
  }
  const url = new URL(`${TTS_AUTH}/${refresh ? 'refresh' : 'get'}`);
  for (const [key, value] of Object.entries({ app_key: c.app_key, app_secret: c.app_secret,
    ...(refresh ? { refresh_token: c.refresh_token, grant_type: 'refresh_token' } : { auth_code: code, grant_type: 'authorized_code' }),
  })) url.searchParams.set(key, value);
  return requestJson(url.toString(), { method: 'GET' }, 'tiktok_shop', fetchImpl);
}

async function shopIdentity(config, fetchImpl) {
  const c = config.credentials;
  if (config.provider === 'shopee') {
    const data = await shopeeRequest(config, '/api/v2/shop/get_shop_info', {}, undefined, c.access_token, fetchImpl);
    if (!data.shop_name || (data.shop_id !== undefined && String(data.shop_id) !== config.metadata.shop_id)) {
      throw failure('The selected Shopee shop could not be verified. Reconnect using that shop account.', 'seller_shop_mismatch');
    }
    return { shop_id: config.metadata.shop_id, shop_name: data.shop_name, shop_region: data.region };
  }
  const data = await tikTokRequest(config, '/authorization/202309/shops', {}, undefined, c.access_token, fetchImpl, false);
  const selected = (Array.isArray(data.shops) ? data.shops : []).filter((shop) =>
    shop.id === config.metadata.shop_id || shop.code === config.metadata.shop_id);
  if (selected.length !== 1 || typeof selected[0].cipher !== 'string' || !selected[0].cipher
      || (config.metadata.region === 'us') !== (selected[0].region === 'US')) {
    throw failure('The authorized shops do not match the selected shop and market. Check the shop code and reconnect.', 'seller_shop_mismatch');
  }
  const shop = selected[0];
  numericId(shop.id);
  return { shop_id: shop.id, shop_name: shop.name, shop_region: shop.region, shop_cipher: shop.cipher };
}

async function authorize(provider, metadata, credentials, code, fetchImpl) {
  validateSetup(provider, metadata, credentials);
  const config = { provider, metadata, credentials };
  config.credentials = tokensFrom(provider, await tokenRequest(config, code, false, fetchImpl), { provider, ...credentials });
  const identity = await shopIdentity(config, fetchImpl);
  config.credentials.identity = { ...identity, binding_shop_id: metadata.shop_id, region: metadata.region,
    ...(provider === 'shopee' ? { environment: metadata.environment } : {}) };
  return config.credentials;
}

const ensureToken = credentialOperation(async function ensureToken(config) {
  const read = () => {
    config.credentials = readCredentialFile(config.credentialFile, config.credentialKey);
    validateBinding(config);
  };
  read();
  if (config.credentials.expires_at > Date.now() + REFRESH_BUFFER) return;
  let refresh = refreshes.get(config.credentialFile);
  if (!refresh) {
    refresh = (async () => {
      if (config.credentials.refresh_expires_at <= Date.now()) throw failure('Shop authorization expired. Reconnect.');
      const next = tokensFrom(config.provider, await tokenRequest(config, undefined, true), config.credentials);
      // Persist the rotating grant before another API call can fail. Writes are never retried.
      writeCredentialFile(config.credentialFile, config.credentialKey, next);
    })();
    refreshes.set(config.credentialFile, refresh);
  }
  try { await refresh; } finally { if (refreshes.get(config.credentialFile) === refresh) refreshes.delete(config.credentialFile); }
  read();
});

const ID = { type: 'string', minLength: 1, maxLength: 25, description: 'Decimal platform ID; keep it as a string to preserve precision.' };
const TEXT = { type: 'string', minLength: 1, maxLength: 512 };
const PAGE = { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum results in this page; defaults to 50.' };
const TIME = { type: 'integer', minimum: 1, maximum: 9999999999, description: 'Unix epoch seconds.' };
const array = (items, maxItems = 10) => ({ type: 'array', items, minItems: 1, maxItems });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const action = (risk, description, properties = {}, required = [], scope) => ({
  risk, description, input_schema: object(properties, required), ...(scope ? { scope } : {}),
});
const SHOPEE_ACTIONS = Object.freeze({
  'shop.get': action('R', 'Verify and read the connected shop.'),
  'warehouses.list': action('R', 'Read shop warehouses and stock location IDs.'),
  'products.list': action('R', 'List products; continue with the returned next_offset.', {
    offset: { type: 'integer', minimum: 0, maximum: 1000000, description: 'Result offset; defaults to 0.' }, page_size: PAGE,
    item_status: { type: 'string', enum: ['NORMAL', 'BANNED', 'DELETED', 'UNLIST'], description: 'Listing status; defaults to NORMAL.' },
  }),
  'products.get': action('R', 'Read product details, including SKU and inventory information.', { item_ids: array(ID, 50) }, ['item_ids']),
  'models.list': action('R', 'Read the variants, prices and warehouse stock of one product.', { item_id: ID }, ['item_id']),
  'orders.list': action('R', 'List orders for an explicit time range of at most 15 days; continue with next_cursor.', {
    time_from: TIME, time_to: TIME,
    time_range_field: { type: 'string', enum: ['create_time', 'update_time'], description: 'Timestamp field to filter; defaults to create_time.' },
    cursor: TEXT, page_size: PAGE,
  }, ['time_from', 'time_to']),
  'orders.get': action('R', 'Read order details for the supplied order serial numbers.', {
    order_sns: array({ type: 'string', minLength: 1, maxLength: 64 }, 50),
  }, ['order_sns']),
  'prices.update': action('H', 'Set original prices for reviewed product variants, in the shop currency.', {
    item_id: ID, prices: array(object({ model_id: { ...ID, description: 'Use 0 for a product without variants.' },
      original_price: { type: 'number', exclusiveMinimum: 0, maximum: 1000000000 } })),
  }, ['item_id', 'prices']),
  'inventory.update': action('H', 'Set absolute seller stock, not a quantity delta. Existing promotion reservations still apply.', {
    item_id: ID, stock_list: array(object({ model_id: { ...ID, description: 'Use 0 for a product without variants.' },
      seller_stock: array(object({ location_id: { type: 'string', minLength: 1, maxLength: 64, description: 'From warehouses.list; omit only when the shop has no warehouses.' },
        stock: { type: 'integer', minimum: 0, maximum: 1000000000 } }, ['stock'])) })),
  }, ['item_id', 'stock_list']),
});
const TIKTOK_ACTIONS = Object.freeze({
  'shop.get': action('R', 'Verify and read only the connected shop, not other authorized shops.'),
  'warehouses.list': action('R', 'List warehouses associated with the connected seller shop.', {}, [], 'seller.logistics'),
  'products.list': action('R', 'Search products; continue with the returned next_page_token.', {
    page_size: PAGE, page_token: TEXT,
    seller_skus: array({ type: 'string', minLength: 1, maxLength: 100 }, 100),
  }, [], 'seller.product.basic'),
  'products.get': action('R', 'Read one product, including its SKUs, prices and inventory.', { product_id: ID }, ['product_id'], 'seller.product.basic'),
  'orders.list': action('R', 'Search orders by creation time; continue with the returned next_page_token.', {
    page_size: PAGE, page_token: TEXT, create_time_ge: TIME, create_time_lt: TIME,
  }, [], 'seller.order.info'),
  'orders.get': action('R', 'Read selected orders without rounding their IDs.', { order_ids: array(ID, 50) }, ['order_ids'], 'seller.order.info'),
  'prices.update': action('H', 'Set SKU prices for active products without ongoing promotions. Supply exactly one of amount or sale_price for each SKU.', {
    product_id: ID, skus: array(object({ id: ID, price: object({
      amount: { type: 'string', minLength: 1, maxLength: 20, description: 'Positive decimal display price for local sellers, or pre-tax price for global sellers. Not for JP or US shops using China warehouses.' },
      sale_price: { type: 'string', minLength: 1, maxLength: 20, description: 'Global sellers only: final local display price. Required instead of amount for JP and US shops using China warehouses.' },
      currency: { type: 'string', minLength: 3, maxLength: 3, description: 'Shop currency code, for example USD.' } }, ['currency']) })),
  }, ['product_id', 'skus'], 'seller.product.write'),
  'inventory.update': action('H', 'Set absolute SKU inventory. Include all existing warehouses required by the platform; this does not add warehouses.', {
    product_id: ID, skus: array(object({ id: ID, inventory: array(object({ warehouse_id: ID,
      quantity: { type: 'integer', minimum: 0, maximum: 1000000000 } })) })),
  }, ['product_id', 'skus'], 'seller.product.write'),
});

function actionsFor(provider) {
  if (!isSellerProvider(provider)) throw new Error('Unsupported seller provider');
  return provider === 'shopee' ? SHOPEE_ACTIONS : TIKTOK_ACTIONS;
}

function unique(values) {
  if (new Set(values).size !== values.length) throw new Error('Duplicate resource IDs are not allowed');
}

function mutationResult(provider, result) {
  const errors = provider === 'shopee' ? result.response?.failure_list : result.errors;
  if (Array.isArray(errors) && errors.length) {
    // A 200/outer success can still contain partial failures. Do not claim success or retry.
    return { status: 'partial_or_failed', failed_count: errors.length,
      ...(provider === 'shopee' ? { successful_count: result.response?.success_list?.length || 0 } : {}),
      message: 'Some updates failed. Read the product again before deciding which changes to retry.' };
  }
  return { status: 'accepted', message: 'The platform accepted the update. Read the product to verify its current values.' };
}

async function execute(config, name, p) {
  const spec = actionsFor(config.provider)[name];
  if (!spec) throw new Error('Unsupported seller action');
  // The owning adapter validates the closed action schema and risk class before calling here.
  const shop = config.provider === 'shopee';
  const id = shop ? shopeeNumber : numericId;
  if (p.item_id !== undefined) id(p.item_id);
  if (p.product_id !== undefined) id(p.product_id);
  for (const key of ['item_ids', 'order_ids']) if (p[key]) { p[key].forEach((value) => id(value)); unique(p[key]); }
  if (p.order_sns) {
    if (p.order_sns.some((value) => !/^[A-Za-z0-9_-]{1,64}$/.test(value))) throw new Error('Invalid order serial number');
    unique(p.order_sns);
  }
  if (p.time_from !== undefined && (p.time_to <= p.time_from || p.time_to - p.time_from > 15 * 86400)) {
    throw new Error('The Shopee order time range must be positive and at most 15 days');
  }
  if (p.create_time_ge !== undefined && p.create_time_lt !== undefined && p.create_time_lt <= p.create_time_ge) {
    throw new Error('The order time range must be positive');
  }
  for (const rows of [p.prices, p.stock_list]) if (rows) {
    unique(rows.map((row) => numericId(row.model_id, true)));
    rows.forEach((row) => shopeeNumber(row.model_id, true));
  }
  if (p.stock_list) {
    if (p.stock_list.reduce((count, row) => count + row.seller_stock.length, 0) > 10) throw new Error('Review at most 10 stock locations per update');
    p.stock_list.forEach((row) => unique(row.seller_stock.map((stock) => stock.location_id || '')));
  }
  if (p.skus) {
    unique(p.skus.map((sku) => numericId(sku.id)));
    for (const sku of p.skus) {
      if (sku.price) {
        const values = [sku.price.amount, sku.price.sale_price].filter((value) => value !== undefined);
        if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(values[0])
            || Number(values[0]) <= 0 || !/^[A-Z]{3}$/.test(sku.price.currency)) throw new Error('Provide exactly one positive amount or sale_price and a shop currency code');
      }
      if (sku.inventory) unique(sku.inventory.map((row) => numericId(row.warehouse_id)));
    }
    if (name === 'inventory.update' && p.skus.reduce((count, row) => count + row.inventory.length, 0) > 10) throw new Error('Review at most 10 stock locations per update');
  }
  await ensureToken(config);
  if (spec.scope && Array.isArray(config.credentials.scopes) && !config.credentials.scopes.includes(spec.scope)) {
    throw failure(`Enable ${spec.scope} in the app, then reauthorize this shop.`);
  }
  if (name === 'shop.get') {
    const { shop_cipher: _cipher, ...identity } = await shopIdentity(config);
    return identity;
  }
  let result;
  if (shop) {
    const request = (path, query, body) => shopeeRequest(config, `/api/v2/${path}`, query, body, config.credentials.access_token);
    if (name === 'warehouses.list') return request('shop/get_warehouse_detail', {});
    if (name === 'products.list') return request('product/get_item_list', { offset: p.offset ?? 0, page_size: p.page_size ?? 50, item_status: p.item_status || 'NORMAL' });
    if (name === 'products.get') return request('product/get_item_base_info', { item_id_list: p.item_ids.join(',') });
    if (name === 'models.list') return request('product/get_model_list', { item_id: p.item_id });
    if (name === 'orders.list') return request('order/get_order_list', { ...p, time_range_field: p.time_range_field || 'create_time', page_size: p.page_size ?? 50 });
    if (name === 'orders.get') return request('order/get_order_detail', { order_sn_list: p.order_sns.join(','), response_optional_fields: 'item_list,total_amount,package_list' });
    if (name === 'prices.update') result = await request('product/update_price', {}, { item_id: id(p.item_id),
      price_list: p.prices.map((row) => ({ ...row, model_id: shopeeNumber(row.model_id, true) })) });
    if (name === 'inventory.update') result = await request('product/update_stock', {}, { item_id: id(p.item_id),
      stock_list: p.stock_list.map((row) => ({ ...row, model_id: shopeeNumber(row.model_id, true) })) });
  } else {
    const request = (path, query, body) => tikTokRequest(config, path, query, body, config.credentials.access_token);
    if (name === 'warehouses.list') return request('/logistics/202309/warehouses', {});
    if (name === 'products.get') return request(`/product/202309/products/${id(p.product_id)}`, {});
    if (name === 'products.list') return request('/product/202502/products/search', { page_size: p.page_size ?? 50, page_token: p.page_token },
      p.seller_skus ? { seller_skus: p.seller_skus } : {});
    if (name === 'orders.list') return request('/order/202309/orders/search', { page_size: p.page_size ?? 50, page_token: p.page_token },
      Object.fromEntries(['create_time_ge', 'create_time_lt'].filter((key) => p[key] !== undefined).map((key) => [key, p[key]])));
    if (name === 'orders.get') return request('/order/202309/orders', { ids: p.order_ids.join(',') });
    if (name === 'prices.update' || name === 'inventory.update') result = await request(
      `/product/202309/products/${id(p.product_id)}/${name === 'prices.update' ? 'prices' : 'inventory'}/update`, {}, { skus: p.skus });
  }
  if (result === undefined) throw new Error('Unsupported seller action');
  return mutationResult(config.provider, result);
}

module.exports = { isSellerProvider, validateSetup, validateBinding, apiBase, authorizeUrl, authorize,
  numericId, shopeeNumber, signShopee, signTikTok, shopeeRequest, tikTokRequest, shopIdentity, ensureToken,
  actionsFor, execute };
