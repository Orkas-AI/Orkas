'use strict';

// Merchant RMS, not Rakuten's public affiliate API. Protocol reference:
// JakeJP/Rakuten.RMS.Api@cf4da0c2 (MIT), cross-checked with oh0123/rakuten-spi-sdk.
// Merchant-only official specifications remain the final authority; no live grant
// was used during development. Item 2.0, Inventory 2.1, Order 2.0 (SKU version 7).
const crypto = require('node:crypto');
const { requestFetch, requestFailureCode, httpFailureCode } = require('./commerce-request-context.cjs');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const BASE = 'https://api.rms.rakuten.co.jp';
const isProvider = provider => provider === 'rakuten_rms';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const secretKeys = ['service_secret', 'license_key'];
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !object(metadata) || Object.keys(metadata).length) fail('E_BAD_INPUT', 'Invalid Rakuten RMS binding');
  return BASE;
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  if (secretKeys.some(key => typeof config.credentials?.[key] !== 'string'
    || config.credentials[key].length < 8 || config.credentials[key].length > 4096
    || /[^\x21-\x39\x3b-\x7e]/.test(config.credentials[key]))) {
    fail('E_TOOL_CALL_AUTH', 'Enter the merchant RMS serviceSecret and licenseKey');
  }
}
const fingerprint = config => crypto.createHash('sha256').update(JSON.stringify(secretKeys.map(key => config.credentials[key]))).digest('hex');
const authorization = config => `ESA ${Buffer.from(`${config.credentials.service_secret}:${config.credentials.license_key}`, 'ascii').toString('base64')}`;
function validateBinding(config) {
  setup(config);
  if (config.credentials.provider !== 'rakuten_rms' || config.credentials.identity?.fingerprint !== fingerprint(config)) {
    fail('E_TOOL_CALL_AUTH', 'Rakuten RMS credentials changed; reconnect');
  }
}
async function request(config, route, { method = 'GET', query = {}, body, empty = false } = {}) {
  setup(config);
  const url = new URL(BASE + route);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const deadline = AbortSignal.timeout(60000);
  let response;
  try {
    response = await requestFetch(url.toString(), { method, redirect: 'error', signal: deadline,
      headers: { accept: 'application/json', authorization: authorization(config),
        ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (error) {
    fail(requestFailureCode(error, deadline), 'Rakuten RMS request failed; check the shop before retrying an uncertain update');
  }
  if (!response.ok) fail(httpFailureCode(response.status), `Rakuten RMS request failed (HTTP ${response.status}); check the license key, enabled APIs and parameters before retrying`);
  let source;
  try { source = await readBody(response); } catch (error) {
    fail(error?.code === 'E_CONNECTOR_RESPONSE_TOO_LARGE' ? 'E_TOOL_CALL_UPSTREAM' : requestFailureCode(error, deadline),
      'Rakuten RMS response could not be read; check the shop before retrying an uncertain update');
  }
  if (!source && empty) return {};
  let data;
  try { data = JSON.parse(source); } catch { fail('E_TOOL_CALL_UPSTREAM', 'Rakuten RMS returned invalid data'); }
  if (!object(data) || (data.errors !== undefined && (!Array.isArray(data.errors) || data.errors.length))
    || (data.MessageModelList !== undefined && (!Array.isArray(data.MessageModelList)
      || data.MessageModelList.some(row => !object(row) || !['INFO', 'WARNING'].includes(row.messageType))))) {
    fail('E_TOOL_CALL_UPSTREAM', 'Rakuten RMS rejected the request; check API permissions and parameters before retrying');
  }
  return data;
}
// Conservative connector bounds, not a claim about the provider's maximums.
const identifier = { type: 'string', minLength: 1, maxLength: 127, pattern: '^[A-Za-z0-9_-]+$' };
const orderNumber = { type: 'string', minLength: 1, maxLength: 100, pattern: '^[0-9]+-[0-9]+-[0-9]+$' };
const action = (risk, description, properties = {}, required = []) => ({ risk, description,
  input_schema: { type: 'object', properties, required, additionalProperties: false } });
function actionsFor() {
  return {
    'products.list': action('R', 'Read one RMS Item API 2.0 page. Offset defaults to 0; limit defaults to 30. Continue using next_offset. If pagination_limited is true, narrow the title filter; the connector stops at offset 10000.', {
      title: { type: 'string', minLength: 1, maxLength: 100 }, offset: { type: 'integer', minimum: 0, maximum: 10000 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    }),
    'products.get': action('R', 'Read one RMS product using its manageNumber, not the storefront itemNumber.', { manage_number: identifier }, ['manage_number']),
    'inventory.get': action('R', 'Read Inventory API 2.1 stock for one manageNumber and variantId from products.get.',
      { manage_number: identifier, variant_id: identifier }, ['manage_number', 'variant_id']),
    'orders.list': action('R', 'Read one page of order numbers for one Japan calendar day (order date). Page defaults to 1. Use orders.get for a summary; no buyer information is returned. pagination_limited means the connector page limit was reached, not all orders were retrieved.', {
      day: { type: 'string', pattern: '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' }, page: { type: 'integer', minimum: 1, maximum: 10000 },
    }, ['day']),
    'orders.get': action('R', 'Read one order status and totals using Order API SKU version 7. Buyer, recipient, payment details and free-form notes are excluded.',
      { order_number: orderNumber }, ['order_number']),
    'inventory.set': action('H', 'Replace one existing SKU stock quantity using ABSOLUTE mode, then read it back. No automatic retry. Concurrent orders may change stock; check the shop if confirmation fails.', {
      manage_number: identifier, variant_id: identifier, quantity: { type: 'integer', minimum: 0, maximum: 99999 },
    }, ['manage_number', 'variant_id', 'quantity']),
  };
}
function stock(data, p) {
  if (data.manageNumber !== p.manage_number || data.variantId !== p.variant_id || !Number.isSafeInteger(data.quantity)) {
    fail('E_TOOL_CALL_UPSTREAM', 'Rakuten RMS returned incomplete or mismatched stock');
  }
  return { manageNumber: data.manageNumber, variantId: data.variantId, quantity: data.quantity };
}
const ORDER_FIELDS = ['orderNumber', 'orderProgress', 'orderDatetime', 'goodsPrice', 'goodsTax', 'postagePrice', 'paymentCharge', 'totalPrice', 'requestPrice'];
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('E_BAD_INPUT', 'Unreviewed Rakuten RMS action');
  validate(parameters, spec.input_schema);
  const p = parameters;
  let result;
  if (name === 'products.list') {
    const offset = p.offset ?? 0, hits = p.limit ?? 30;
    const data = await request(config, '/es/2.0/items/search', { query: { offset, hits, ...(p.title ? { title: p.title } : {}) } });
    if (!Array.isArray(data.results) || !Number.isSafeInteger(data.numFound) || data.numFound < 0 || data.offset !== offset
      || data.results.length > hits || data.results.some(row => !object(row?.item) || typeof row.item.manageNumber !== 'string')
      || (offset < data.numFound && !data.results.length)) fail('E_TOOL_CALL_UPSTREAM', 'Rakuten RMS product pagination is incomplete');
    const next = offset + data.results.length < data.numFound ? offset + data.results.length : null;
    result = { data: data.results.map(row => row.item), total: data.numFound,
      next_offset: next !== null && next <= 10000 ? next : null,
      ...(next !== null && next > 10000 ? { pagination_limited: true } : {}) };
  } else if (name === 'products.get') {
    const data = await request(config, `/es/2.0/items/manage-numbers/${p.manage_number}`);
    if (data.manageNumber !== p.manage_number) fail('E_TOOL_CALL_UPSTREAM', 'Rakuten RMS returned a different product');
    result = { data };
  } else if (name.startsWith('inventory.')) {
    const route = `/es/2.1/inventories/manage-numbers/${p.manage_number}/variants/${p.variant_id}`;
    const before = stock(await request(config, route), p);
    if (name === 'inventory.get') result = { data: before };
    else {
      await request(config, route, { method: 'PUT', body: { mode: 'ABSOLUTE', quantity: p.quantity }, empty: true });
      const after = stock(await request(config, route), p);
      if (after.quantity !== p.quantity) fail('E_TOOL_CALL_UPSTREAM', 'Rakuten RMS stock changed or could not be confirmed; inspect the shop before retrying');
      result = { status: 'completed', data: after };
    }
  } else if (name === 'orders.list') {
    const date = new Date(`${p.day}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== p.day) fail('E_BAD_INPUT', 'Invalid Japan calendar date');
    const page = p.page ?? 1;
    const data = await request(config, '/es/2.0/order/searchOrder/', { method: 'POST', body: {
      dateType: 1, startDatetime: `${p.day}T00:00:00+0900`, endDatetime: `${p.day}T23:59:59+0900`,
      PaginationRequestModel: { requestRecordsAmount: 100, requestPage: page },
    } });
    const paging = data.PaginationResponseModel;
    if (!Array.isArray(data.orderNumberList) || data.orderNumberList.length > 100
      || data.orderNumberList.some(value => typeof value !== 'string' || !/^[0-9]+-[0-9]+-[0-9]+$/.test(value))
      || !object(paging) || !Number.isSafeInteger(paging.totalRecordsAmount) || paging.totalRecordsAmount < 0
      || !Number.isSafeInteger(paging.totalPages) || paging.totalPages < 0 || paging.requestPage !== page
      || (page <= paging.totalPages && paging.totalRecordsAmount > 0 && !data.orderNumberList.length)) {
      fail('E_TOOL_CALL_UPSTREAM', 'Rakuten RMS order pagination is incomplete');
    }
    result = { order_numbers: data.orderNumberList, total: paging.totalRecordsAmount,
      next_page: page < paging.totalPages && page < 10000 ? page + 1 : null,
      ...(page < paging.totalPages && page === 10000 ? { pagination_limited: true } : {}) };
  } else {
    const data = await request(config, '/es/2.0/order/getOrder/', { method: 'POST', body: { orderNumberList: [p.order_number], version: '7' } });
    if (!Array.isArray(data.OrderModelList) || data.OrderModelList.length !== 1 || data.OrderModelList[0]?.orderNumber !== p.order_number) {
      fail('E_TOOL_CALL_UPSTREAM', 'Rakuten RMS did not return the requested order');
    }
    const row = data.OrderModelList[0];
    result = { data: Object.fromEntries(ORDER_FIELDS.filter(key => Object.hasOwn(row, key) && ['number', 'string'].includes(typeof row[key])).map(key => [key, row[key]])) };
  }
  for (const secret of [...secretKeys.map(key => config.credentials[key]), authorization(config).slice(4)]) result = safeOutput(result, secret);
  return result;
}
async function identity(config) {
  await execute(config, 'products.list', { limit: 1 });
  return { authorization_verified: true };
}
async function authorize(config) {
  setup(config);
  const credentials = { provider: 'rakuten_rms', ...Object.fromEntries(secretKeys.map(key => [key, config.credentials[key]])), identity: { fingerprint: fingerprint(config) } };
  await identity({ ...config, credentials });
  return credentials;
}
module.exports = { isProvider, apiBase, actionsFor, validateBinding, identity, execute, authorize };
