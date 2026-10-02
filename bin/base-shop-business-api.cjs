'use strict';

const owner = require('./base-shop-api.cjs');
const { requestFetch, requestFailureCode, httpFailureCode } = require('./commerce-request-context.cjs');
const { readBody } = require('./storefront-admin-api.cjs');
let contracts, actions, validator;
const checks = new Map();
const source = () => contracts ||= require('./base-shop-api-contracts.cjs');
const fail = (code, message, httpStatus) => { throw Object.assign(new Error(message), { code, ...(httpStatus ? { httpStatus } : {}) }); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const id = v => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) || (typeof v === 'string' && /^[1-9][0-9]*$/.test(v));
const same = (a, b) => id(a) && id(b) && String(a) === String(b);
function actionsFor() {
  return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name, row]) => [name, {
    risk: row.risk, description: row.description, input_schema: row.input_schema, documentation_url: row.source_url,
  }]));
}
const isNative = name => Object.hasOwn(source().methods, name);
function build(config, name, p = {}) {
  if (config.provider !== 'base_shop' || !isNative(name)) fail('E_BAD_INPUT', 'Unavailable BASE shop action');
  owner.apiBase(config.provider, config.metadata);
  const row = source().methods[name];
  let encoded; try { encoded = JSON.stringify(p); } catch { fail('E_BAD_INPUT', 'Invalid BASE action parameters'); }
  if (!encoded || Buffer.byteLength(encoded) > 256 * 1024) fail('E_BAD_INPUT', 'Invalid or oversized BASE action parameters');
  if (!validator) { const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv'); validator = new AjvJsonSchemaValidator(); }
  if (!checks.has(row)) checks.set(row, validator.getValidator(row.input_schema));
  if (!checks.get(row)(p).valid) fail('E_BAD_INPUT', 'Invalid BASE parameters; check the described fields and types');
  const arrays = ['variation_id', 'variation', 'variation_stock', 'variation_identifier', 'barcode'].filter(key => Array.isArray(p[key]));
  if (arrays.some(key => p[key].length !== p[arrays[0]].length)) fail('E_BAD_INPUT', 'BASE variation arrays must have matching lengths');
  if (row.path === '/items/edit' && arrays.length && !p.variation_id) fail('E_BAD_INPUT', 'Include variation IDs when editing BASE variations; use an empty ID for a new variation');
  if (row.path === '/items/add' && arrays.length && (!p.variation || !p.variation_stock)) fail('E_BAD_INPUT', 'Include variation names and stock when creating BASE variations');
  if (Array.isArray(p.variation_id)) {
    const existing = p.variation_id.filter(value => value !== '').map(String);
    if (new Set(existing).size !== existing.length) fail('E_BAD_INPUT', 'BASE variation IDs must not repeat');
  }
  let route = row.path;
  const params = new URLSearchParams();
  for (const [key, schema] of Object.entries(row.input_schema.properties)) {
    const value = p[key] ?? schema.default;
    if (value === undefined) continue;
    if (route.includes(':' + key)) route = route.replace(':' + key, encodeURIComponent(String(value)));
    else if (Array.isArray(value)) value.forEach((item, i) => params.append(`${key}[${i}]`, String(item)));
    else params.append(key, String(value));
  }
  return { row, route, params };
}
const PRIVATE_KEYS = new Set(['access_token', 'refresh_token', 'client_secret', 'authorization']);
function clean(value, secrets, depth = 0) {
  if (depth > 40) fail('E_TOOL_CALL_UPSTREAM', 'BASE returned an excessively nested response');
  if (typeof value === 'string') { for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]'); return value; }
  if (Array.isArray(value)) return value.map(item => clean(item, secrets, depth + 1));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEYS.has(key.toLowerCase())).map(([key, item]) => [key, clean(item, secrets, depth + 1)]));
}
function parseResponse(text) {
  const exact = text.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g, token => {
    if (token.startsWith('"')) return token;
    const value = Number(token);
    if (/^-?[0-9]+$/.test(token) && !Number.isSafeInteger(value)) return JSON.stringify(token);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('E_TOOL_CALL_UPSTREAM', 'BASE returned an unsupported numeric representation');
    return token;
  });
  return JSON.parse(exact);
}
function acknowledge(row, p, data, config, previousCategories) {
  const route = row.path;
  const reject = () => fail('E_TOOL_CALL_UPSTREAM', 'BASE did not confirm the requested result; inspect the shop before retrying an update');
  const list = (key, identifier) => {
    if (!Array.isArray(data[key]) || data[key].some(value => !object(value) || (identifier === 'unique_key' ? typeof value[identifier] !== 'string' || !value[identifier] : !id(value[identifier])))) reject();
    return data[key];
  };
  if (route === '/users/me') {
    if (!object(data.user) || data.user.shop_id !== config.credentials.identity.shop_id) fail('E_TOOL_CALL_AUTH', 'BASE returned a different shop; reconnect before continuing');
  } else if (route === '/items' || route === '/items/search') list('items', 'item_id');
  else if (route === '/orders') list('orders', 'unique_key');
  else if (route === '/orders/detail/:unique_key') { if (!object(data.order) || data.order.unique_key !== p.unique_key) reject(); }
  else if (route === '/delivery_companies') list('delivery_companies', 'delivery_company_id');
  else if (route.startsWith('/categories')) {
    const values = list('categories', 'category_id');
    if (route === '/categories/delete' && values.some(value => same(value.category_id, p.category_id))) reject();
    if (route === '/categories/add' || route === '/categories/edit') {
      const matches = values.filter(value => route.endsWith('/add') ? !previousCategories.has(String(value.category_id)) : same(value.category_id, p.category_id));
      if (!matches.some(value => ['name', 'list_order', 'parent_number'].every(key => p[key] === undefined || value[key] === p[key]))) reject();
    }
  } else if (route.startsWith('/item_categories')) {
    const values = list('item_categories', 'item_category_id');
    if (values.some(value => !id(value.item_id) || !id(value.category_id))) reject();
    if (route === '/item_categories/detail/:item_id' && values.some(value => !same(value.item_id, p.item_id))) reject();
    if (route === '/item_categories/add' && p.category_id !== undefined && !values.some(value => same(value.item_id, p.item_id) && same(value.category_id, p.category_id))) reject();
    if (route === '/item_categories/delete' && values.some(value => same(value.item_category_id, p.item_category_id))) reject();
  } else if (route === '/items/delete') { if (data.result !== true) reject(); }
  else {
    const item = data.item;
    if (!object(item) || !id(item.item_id) || (p.item_id !== undefined && !same(item.item_id, p.item_id))) reject();
    if (route === '/items/edit_stock') {
      const actual = p.variation_id === undefined ? item.stock : (Array.isArray(item.variations) ? item.variations.find(value => same(value.variation_id, p.variation_id))?.variation_stock : undefined);
      if (actual !== (p.variation_stock ?? p.stock)) reject();
    }
    if (route === '/items/add_image' && (typeof item[`img${p.image_no}_origin`] !== 'string' || !item[`img${p.image_no}_origin`])) reject();
    if (route === '/items/delete_image' && item[`img${p.image_no}_origin`] !== null) reject();
    if (route === '/items/delete_variation' && (!Array.isArray(item.variations) || item.variations.some(value => same(value.variation_id, p.variation_id)))) reject();
    if (route === '/items/add' || route === '/items/edit') {
      for (const key of ['title', 'detail', 'price', 'item_tax_type', 'visible', 'identifier', 'list_order']) if (p[key] !== undefined && item[key] !== p[key]) reject();
      if (p.stock !== undefined && !p.variation_stock && item.stock !== p.stock) reject();
      const fields = ['variation', 'variation_stock', 'variation_identifier', 'barcode'].filter(key => Array.isArray(p[key]));
      if (fields.length) {
        if (!Array.isArray(item.variations)) reject();
        const used = new Set();
        for (let i = 0; i < p[fields[0]].length; i++) {
          const match = item.variations.findIndex((value, index) => !used.has(index) && object(value) && id(value.variation_id)
            && (!p.variation_id?.[i] || same(value.variation_id, p.variation_id[i]))
            && fields.every(key => value[key] === p[key][i]));
          if (match < 0) reject();
          used.add(match);
        }
      }
    }
  }
}
async function execute(config, name, p = {}) {
  const built = build(config, name, p), { row } = built;
  await owner.ensureToken(config);
  const base = owner.apiBase(config.provider, config.metadata);
  const secrets = ['client_id', 'client_secret', 'access_token', 'refresh_token'].map(key => config.credentials[key]).filter(value => typeof value === 'string' && value);
  async function request(method, route, params = new URLSearchParams()) {
    const url = new URL(base + route), deadline = AbortSignal.timeout(60000);
    if (method === 'GET') url.search = params.toString();
    let response;
    try { response = await requestFetch(url.toString(), { method, redirect: 'error', signal: deadline,
      headers: { accept: 'application/json', authorization: 'Bearer ' + config.credentials.access_token, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(method === 'POST' ? { body: params.toString() } : {}) }); }
    catch (error) { fail(requestFailureCode(error, deadline), 'BASE request did not complete; inspect the shop before retrying an update'); }
    if (!response.ok && response.status !== 400) fail(httpFailureCode(response.status), 'BASE request failed; check shop authorization, limits and connection', response.status);
    let data;
    try { data = parseResponse(await readBody(response)); }
    catch (error) {
      const code = requestFailureCode(error, deadline);
      fail(['E_TOOL_CALL_CANCELLED', 'E_TOOL_CALL_TIMEOUT'].includes(code) ? code : 'E_TOOL_CALL_UPSTREAM', 'BASE returned an incomplete or invalid response; inspect the shop before retrying an update');
    }
    if (!object(data)) fail('E_TOOL_CALL_UPSTREAM', 'BASE returned an invalid response');
    if (data.error) {
      // invalid_request is also documented for unsupported product types; do not infer auth failure from prose.
      const code = ['hour_api_limit', 'day_api_limit', 'exceed_daily_limit'].includes(data.error) ? 'E_TOOL_CALL_RATE_LIMIT'
        : ['invalid_scope', 'access_denied', 'unauthorized_client', 'invalid_grant'].includes(data.error) ? 'E_TOOL_CALL_AUTH'
          : data.error === 'db_error' || data.error === 'image_put_fail' ? 'E_TOOL_CALL_UPSTREAM' : 'E_BAD_INPUT';
      fail(code, 'BASE rejected the request; check authorization, API limits, product eligibility and parameters');
    }
    if (!response.ok) fail(httpFailureCode(response.status), 'BASE rejected the request; check parameters', response.status);
    return data;
  }
  if (row.path === '/items/edit_stock') {
    const current = await request('GET', '/items/detail/' + encodeURIComponent(String(p.item_id)));
    if (!same(current.item?.item_id, p.item_id) || !Array.isArray(current.item.variations)) fail('E_TOOL_CALL_UPSTREAM', 'BASE product variations are unavailable; no stock update was sent');
    if (p.variation_id === undefined ? current.item.variations.length > 0 : !current.item.variations.some(value => same(value.variation_id, p.variation_id))) fail('E_BAD_INPUT', 'Select a current variation of this BASE product before updating stock');
  }
  let previousCategories;
  if (row.path === '/categories/add') {
    const current = await request('GET', '/categories');
    if (!Array.isArray(current.categories) || current.categories.some(value => !id(value?.category_id))) fail('E_TOOL_CALL_UPSTREAM', 'BASE categories are unavailable; no category was created');
    previousCategories = new Set(current.categories.map(value => String(value.category_id)));
  }
  const data = await request(row.method, built.route, built.params);
  acknowledge(row, p, data, config, previousCategories);
  return { data: clean(data, secrets), ...(row.input_schema.properties.limit ? { limit: p.limit ?? row.input_schema.properties.limit.default, offset: p.offset ?? 0 } : {}) };
}
module.exports = { actionsFor, isNative, build, execute };
