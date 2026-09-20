'use strict';

// Official QAPI guide, methods 10008/10007/10005/10045/10022, reviewed 2026-09-16.
// POST keeps the seller certification key out of URLs, including for read methods.
const crypto = require('node:crypto');
const { requestFetch, requestFailureCode, httpFailureCode } = require('./commerce-request-context.cjs');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const BASE = 'https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi';
const isProvider = provider => provider === 'qoo10_japan';
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !metadata || Object.keys(metadata).length) fail('E_BAD_INPUT', 'Invalid Qoo10 Japan binding');
  return BASE;
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  const key = config.credentials?.certification_key;
  if (typeof key !== 'string' || key.length < 8 || key.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(key)) fail('E_TOOL_CALL_AUTH', 'Enter the Qoo10 seller certification key');
}
const fingerprint = config => crypto.createHash('sha256').update(config.credentials.certification_key).digest('hex');
function validateBinding(config) {
  setup(config);
  if (config.credentials.provider !== 'qoo10_japan' || config.credentials.identity?.key_fingerprint !== fingerprint(config)) fail('E_TOOL_CALL_AUTH', 'Qoo10 authorization changed; reconnect');
}
async function request(config, method, params, version = '1.0') {
  setup(config);
  const deadline = AbortSignal.timeout(60000);
  let response;
  try {
    response = await requestFetch(`${BASE}/${method}`, { method: 'POST', redirect: 'error', signal: deadline,
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded',
        QAPIVersion: version, GiosisCertificationKey: config.credentials.certification_key },
      body: new URLSearchParams({ returnType: 'json', ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) }).toString() });
  } catch (error) { fail(requestFailureCode(error, deadline), 'Qoo10 request failed; inspect the shop before retrying an uncertain update'); }
  if (!response.ok) fail(httpFailureCode(response.status), `Qoo10 request failed (HTTP ${response.status}); check seller authorization`);
  let source;
  try { source = await readBody(response); } catch (error) {
    fail(error?.code === 'E_CONNECTOR_RESPONSE_TOO_LARGE' ? 'E_TOOL_CALL_UPSTREAM' : requestFailureCode(error, deadline),
      'Qoo10 response could not be read; inspect the shop before retrying an uncertain update');
  }
  let data;
  try { data = JSON.parse(source); } catch { fail('E_TOOL_CALL_UPSTREAM', 'Qoo10 returned invalid data'); }
  const providerCode = data?.ErrorCode ?? data?.ResultCode;
  if ([-90000, -10000, -90002, -90003, -90004, -90005].includes(providerCode)) {
    fail('E_TOOL_CALL_AUTH', 'Qoo10 denied access; check the seller certification key and API permission');
  }
  if (data?.ErrorCode !== undefined && data.ErrorCode !== 0) fail('E_TOOL_CALL_UPSTREAM', 'Qoo10 rejected the API request; verify the current official method and application access');
  if (data?.ResultCode !== 0) fail('E_TOOL_CALL_UPSTREAM', 'Qoo10 rejected the request; check the seller certification key, permissions and parameters');
  return data.ResultObject;
}
const item = { type: 'string', minLength: 1, maxLength: 20, pattern: '^[1-9][0-9]*$' };
const text = { type: 'string', minLength: 1, maxLength: 50 };
const day = { type: 'string', minLength: 8, maxLength: 8, pattern: '^20[0-9]{6}$', description: 'Japan calendar date, YYYYMMDD.' };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
function actionsFor() {
  return {
    'products.list': action('R', 'Read one page of registered Qoo10 products by sale status. The provider returns up to 500 items per page with total page counts.',
      { status: { type: 'string', minLength: 2, maxLength: 2, pattern: '^S[012358]$', description: 'S0 pending, S1 seller-stopped, S2 selling, S3 platform-stopped, S5 restricted, S8 rejected.' }, page: { type: 'integer', minimum: 1, maximum: 100000 } }, ['status']),
    'products.get': action('R', 'Read one Qoo10 product by platform item code.', { item_code: item }, ['item_code']),
    'inventory.get': action('R', 'Read the combination options and their absolute stock quantities for one product.', { item_code: item }, ['item_code']),
    'orders.list': action('R', 'Read one Japan calendar day of orders, excluding buyer, recipient and payment details. By default only pending shipping states 1–3 are returned; select 4 for shipped or 5 for delivered. Large responses fail explicitly; no silent truncation.',
      { day, shipping_status: { type: 'string', enum: ['1', '2', '3', '4', '5'], description: '1 awaiting shipment, 2 shipping requested, 3 preparing, 4 shipped, 5 delivered. Omitted returns 1–3.' } }, ['day']),
    'inventory.set': action('H', 'Replace one existing combination option stock quantity. Use the exact option names, values and code from the shop. Never automatically retry an uncertain update.',
      { item_code: item, option_name: { ...text, maxLength: 50 }, option_value: text, option_code: text,
        quantity: { type: 'integer', minimum: 0, maximum: 2147483647 } }, ['item_code', 'option_name', 'option_value', 'option_code', 'quantity']),
  };
}
const ORDER_KEYS = new Set(['shippingStatus', 'packNo', 'orderDate', 'PaymentDate', 'EstShippingDate', 'ShippingDate', 'DeliveredDate',
  'OrderType', 'orderNo', 'itemCode', 'sellerItemCode', 'itemTitle', 'optionCode', 'orderPrice', 'orderQty', 'discount', 'total',
  'SellerDiscount', 'Currency', 'ShippingRate', 'shippingRateType', 'cod_price', 'Cart_Discount_Seller', 'Cart_Discount_Qoo10', 'SettlePrice']);
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('E_BAD_INPUT', 'Unreviewed Qoo10 action');
  validate(parameters, spec.input_schema);
  const p = parameters;
  if (name === 'orders.list') {
    const iso = `${p.day.slice(0, 4)}-${p.day.slice(4, 6)}-${p.day.slice(6, 8)}`;
    const parsed = new Date(iso + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) fail('E_BAD_INPUT', 'Invalid Qoo10 calendar date');
  }
  const routes = {
    'products.list': ['ItemsLookup.GetAllGoodsInfo', { ItemStatus: p.status, Page: p.page || 1 }],
    'products.get': ['ItemsLookup.GetItemDetailInfo', { ItemCode: p.item_code }, '1.2'],
    'inventory.get': ['ItemsLookup.GetGoodsInventoryInfo', { ItemCode: p.item_code }],
    'orders.list': ['ShippingBasic.GetShippingInfo_v2', { search_Sdate: `${p.day}000000`, search_Edate: `${p.day}235959`, search_condition: '1', ...(p.shipping_status ? { ShippingStat: p.shipping_status } : {}) }],
    'inventory.set': ['ItemsOptions.UpdateInventoryQtyUnit', { ItemCode: p.item_code, OptionName: p.option_name,
      OptionValue: p.option_value, OptionCode: p.option_code, Qty: p.quantity }],
  };
  let data = await request(config, ...routes[name]);
  if (name === 'inventory.set') return { status: 'completed' };
  if (name === 'products.list') {
    if (!Array.isArray(data?.Items) || !Number.isSafeInteger(data.TotalPages) || !Number.isSafeInteger(data.TotalItems)) fail('E_TOOL_CALL_UPSTREAM', 'Qoo10 product pagination is missing');
  } else if (!Array.isArray(data)) fail('E_TOOL_CALL_UPSTREAM', 'Qoo10 returned an incomplete list');
  if (name === 'orders.list') data = data.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => ORDER_KEYS.has(key))));
  return { data: safeOutput(data, config.credentials.certification_key),
    ...(name === 'orders.list' ? { shipping_status: p.shipping_status || '1-3' } : {}) };
}
async function identity(config) {
  validateBinding(config);
  await execute(config, 'products.list', { status: 'S2', page: 1 });
  return { authorization_verified: true };
}
async function authorize(config) {
  setup(config);
  const credentials = { provider: 'qoo10_japan', certification_key: config.credentials.certification_key,
    identity: { key_fingerprint: fingerprint(config) } };
  await identity({ ...config, credentials });
  return credentials;
}
module.exports = { isProvider, apiBase, actionsFor, validateBinding, identity, execute, authorize };
