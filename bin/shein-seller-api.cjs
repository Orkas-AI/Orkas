'use strict';

const { requestFetch, requestFailureCode } = require('./commerce-request-context.cjs');

// Self-operated / semi-managed SHEIN seller apps. Full-managed .cn supply-chain
// applications are a different product, not an environment selection.
const crypto = require('node:crypto');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const fail = (kind, message) => { throw Object.assign(new Error(message), { code: `storefront_${kind}` }); };
const isProvider = (provider) => provider === 'shein';
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const secret = (text, min = 8) => typeof text === 'string' && text.length >= min && text.length <= 4096 && !/[\s\u0000-\u001f\u007f]/.test(text);
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !metadata || Object.keys(metadata).length) fail('invalid_binding', 'Invalid SHEIN production binding');
  return 'https://openapi.sheincorp.com';
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  if (!secret(config.credentials?.app_id, 3) || !secret(config.credentials?.app_secret)) fail('invalid_credentials', 'Invalid SHEIN app credentials');
}
function authorizeUrl(config, state) {
  setup(config);
  const query = new URLSearchParams({ appid: config.credentials.app_id, redirectUrl: Buffer.from(config.credentials.redirect_uri, 'utf8').toString('base64'), state });
  return `https://openapi-sem.sheincorp.com/#/empower?${query}`;
}
function signature(openKeyId, secretKey, timestamp, path, random = crypto.randomBytes(4).toString('hex').slice(0, 5)) {
  const hex = crypto.createHmac('sha256', secretKey + random).update(`${openKeyId}&${timestamp}&${path}`).digest('hex');
  return random + Buffer.from(hex, 'utf8').toString('base64');
}
function decryptSecret(ciphertext, appSecret) {
  if (typeof ciphertext !== 'string' || ciphertext.length > 8192 || !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)) fail('invalid_response', 'Invalid encrypted SHEIN grant');
  try {
    const key = Buffer.alloc(16); Buffer.from(appSecret, 'utf8').copy(key, 0, 0, 16);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.from('space-station-default-iv', 'utf8').subarray(0, 16));
    const value = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
    if (!secret(value)) throw new Error('invalid');
    return value;
  } catch { fail('invalid_response', 'SHEIN grant could not be decrypted with this app secret'); }
}
function validateBinding(config) {
  setup(config);
  const c = config.credentials;
  if (c.provider !== 'shein' || !secret(c.open_key_id) || !secret(c.secret_key) || !/^[1-9][0-9]*$/.test(c.identity?.supplier_id || '')
      || c.identity?.app_fingerprint !== hash(c.app_id) || c.identity?.grant_fingerprint !== hash(c.open_key_id)) fail('binding_mismatch', 'SHEIN app or seller grant changed; reconnect');
}
async function request(config, path, body, auth = false, write = false, contract, query = {}) {
  setup(config);
  if (!auth) validateBinding(config);
  const c = config.credentials, timestamp = String(Date.now());
  const key = auth ? c.app_id : c.open_key_id, secretKey = auth ? c.app_secret : c.secret_key;
  const url = new URL(apiBase(config.provider, config.metadata) + path);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
  const multipart = contract?.multipart === true;
  const deadline = AbortSignal.timeout(multipart ? 600000 : 60000);
  const ioFailure = (error) => {
    const code = requestFailureCode(error, deadline);
    const message = `SHEIN request failed${write ? '; inspect the affected resource before retrying an uncertain write' : ''}`;
    if (code === 'E_TOOL_CALL_CANCELLED') throw Object.assign(new Error(message), { code });
    fail(code === 'E_TOOL_CALL_TIMEOUT' ? 'timeout' : 'network_failed', message);
  };
  let response;
  try { response = await requestFetch(url.toString(), {
    method: contract?.method || (body === undefined ? 'GET' : 'POST'), headers: { accept: 'application/json', ...(!multipart ? { 'content-type': 'application/json;charset=UTF-8' } : {}), language: 'en', 'x-lt-language': 'US',
      [auth ? 'x-lt-appid' : 'x-lt-openKeyId']: key, 'x-lt-timestamp': timestamp, 'x-lt-signature': signature(key, secretKey, timestamp, path) },
    ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}), redirect: 'error', signal: deadline,
  }); } catch (error) { ioFailure(error); }
  if (!response.ok) fail([401, 403].includes(response.status) ? 'permission_denied' : response.status === 429 ? 'rate_limit' : 'upstream_error', `SHEIN API failed (HTTP ${response.status})`);
  let text, data;
  try { text = await readBody(response); } catch (error) {
    if (error?.code === 'E_CONNECTOR_RESPONSE_TOO_LARGE') fail('upstream_error', 'SHEIN returned invalid or oversized JSON');
    ioFailure(error);
  }
  try { data = JSON.parse(text); } catch { fail('upstream_error', 'SHEIN returned invalid or oversized JSON'); }
  if (String(data?.code) !== '0') fail('request_failed', 'SHEIN rejected the request; verify seller authorization, app business mode and API permissions');
  const result = data[contract?.response_field || 'info'];
  if (contract) {
    if (contract.allow_absent_result && result == null) return null;
    const valid = contract.result_type === 'array' ? Array.isArray(result)
      : contract.result_type === 'object' ? result !== null && typeof result === 'object' && !Array.isArray(result)
        : contract.result_type === 'string' ? typeof result === 'string'
          : contract.result_type === 'boolean' ? typeof result === 'boolean' : false;
    if (!valid) fail('invalid_response', 'SHEIN returned an invalid business acknowledgement');
  } else if (result === undefined || result === null) fail('request_failed', 'SHEIN rejected the request; verify seller authorization, app business mode and API permissions');
  return result;
}
const ID = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' };
const TIME = { type: 'integer', minimum: 1577836800, maximum: 4102444800, description: 'Unix epoch seconds; Orkas converts to the required UTC+8 provider time.' };
const PAGE = { page: { type: 'integer', minimum: 1, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 10 } };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
function legacyActionsFor() {
  return {
    'shop.get': action('R', 'Verify the authorized SHEIN grant and read available selling sites and currencies.'),
    'products.list': action('R', 'Read one SPU page including SKU codes, stock, prices and marketing locks. Provider page size is at most 10.', PAGE),
    'products.get': action('R', 'Read one SPU and its SKCs/SKUs using the SPU code returned by products.list.', { spu_code: ID }, ['spu_code']),
    'orders.list': action('R', 'Read an order page for an explicit time window no longer than 48 hours. Provider caps a window at 10000 orders; narrow the time range when necessary.', { ...PAGE, start_time: TIME, end_time: TIME, query_type: { type: 'integer', minimum: 1, maximum: 2, description: '1 = order creation; 2 = order update. Defaults to 1.' } }, ['start_time', 'end_time']),
    'orders.get': action('R', 'Read one order and line-item amounts without buyer contacts, labels or payment links.', { order_id: ID }, ['order_id']),
    'warehouses.list': action('R', 'Read warehouse codes, types and supported countries. Only merchant warehouses support inventory writes.'),
    'inventory.get': action('R', 'Read merchant virtual stock, reserved quantities and available quantities for one SKU.', { sku_code: ID }, ['sku_code']),
    'inventory.overwrite': action('H', 'Request a total merchant virtual stock overwrite after fresh confirmation. SHEIN will not reduce below reserved/occupied stock. The acknowledged quantity is a request, not a guarantee of resulting stock; read inventory.get afterward. Does not change SHEIN physical or JIT stock.',
      { sku_code: ID, warehouse_code: ID, quantity: { type: 'integer', minimum: 1, maximum: 2147483647 }, request_key: { ...ID, minLength: 8, description: 'Unique idempotency key for this confirmed change; never reuse it for a different change.' } }, ['sku_code', 'warehouse_code', 'quantity', 'request_key']),
  };
}
let contracts, nativeActions, validator;
const validators = new Map();
function businessContracts() { return contracts ||= require('./shein-api-contracts.cjs'); }
function actionsFor() {
  nativeActions ||= Object.fromEntries(Object.entries(businessContracts().methods).map(([name, method]) => [name, {
    risk: method.risk, description: method.description, input_schema: method.input_schema,
  }]));
  return { ...legacyActionsFor(), ...nativeActions };
}
function coverageFor() {
  const source = businessContracts();
  return { complete: false, documentation_snapshot: source.documentation_snapshot, scope: source.scope,
    reviewed_business_methods: Object.keys(source.methods).length, host_owned_methods: { ...source.host_owned_methods },
    other_application_methods: [...source.other_application_methods], max_inline_parameter_bytes: 256 * 1024 };
}
function validateNative(parameters, contract) {
  let serialized;
  try { serialized = JSON.stringify(parameters); } catch { fail('validation_failed', 'Invalid SHEIN action parameters'); }
  if (!serialized || Buffer.byteLength(serialized) > 256 * 1024) fail('validation_failed', 'Invalid or oversized SHEIN action parameters');
  if (!validator) {
    const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
    validator = new AjvJsonSchemaValidator();
  }
  let check = validators.get(contract.input_schema);
  if (!check) { check = validator.getValidator(contract.input_schema); validators.set(contract.input_schema, check); }
  if (!check(parameters).valid) fail('validation_failed', 'Invalid SHEIN action parameters; check the described field types and required fields');
}
const PRIVATE_FIELDS = new Set(['accesstoken','refreshtoken','idtoken','appsecret','secretkey','openkeyid','clientsecret',
  'authorization','password','cookie','signature','errormsg','errormessage','errorordergoodsexpressremark','failmsg','failreason','failedreason','failurereason','msg','message']);
function businessOutput(value, credentials, eligibilityReason = false) {
  if (typeof value === 'string') return ['app_id','app_secret','open_key_id','secret_key'].reduce((text, key) => text.split(credentials[key]).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map(item => businessOutput(item, credentials, eligibilityReason));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => {
    const canonical = key.replace(/[_-]/g, '').toLowerCase();
    return !PRIVATE_FIELDS.has(canonical) && (canonical !== 'reason' || eligibilityReason || typeof item === 'number');
  }).map(([key, item]) => [key, businessOutput(item, credentials, eligibilityReason)]));
}
function stockArguments(body, version) {
  const entries = body.updateSkuInventoryQuantityRequests;
  if (new Set(entries.map(item => `${item.skuCode}\0${item.warehouseCode || ''}\0${item.invType || ''}`)).size !== entries.length
      || (version === 2 && new Set(entries.map(item => item.idempotencyKey)).size !== entries.length)) {
    fail('validation_failed', 'Invalid SHEIN stock action parameters; use distinct items and idempotency keys');
  }
  return entries;
}
function nativeFailure(contract, data, parameters) {
  const id = contract.id, body = parameters.body || {};
  if ([3002018,3002019].includes(id)) {
    if (typeof data?.success !== 'boolean' || (data.success && (typeof data.spu_name !== 'string' || !data.spu_name
        || (body.spu_name && data.spu_name !== body.spu_name)))) fail('invalid_response', 'SHEIN product submission was not fully acknowledged; inspect product audit status before retrying');
    return data.success === false || (Array.isArray(data.filtered_result) && data.filtered_result.length > 0);
  }
  if (id === 3001940) {
    const rows = data?.data, requested = body.productPriceList || [];
    const keys = new Set(requested.map(item => `${item.productCode}\0${item.site}`));
    if (!Array.isArray(rows) || rows.length !== requested.length || keys.size !== requested.length
        || new Set(rows.map(item => `${item.productCode}\0${item.site}`)).size !== rows.length
        || rows.some(item => !keys.has(`${item.productCode}\0${item.site}`) || typeof item.success !== 'boolean'
          || (item.status !== undefined && ![0,1,2].includes(item.status)))) fail('invalid_response', 'SHEIN price changes were not fully acknowledged; inspect price review results before retrying');
    return rows.some(item => item.success === false || item.status === 0);
  }
  if ([3001692,3001738].includes(id)) {
    const requested = stockArguments(body, id === 3001738 ? 2 : 1);
    // The v2 table describes a single failed object; the existing adapter contract
    // and legacy API also use a list. Both are failure records, never prose.
    const failures = Array.isArray(data?.failedList) ? data.failedList
      : data?.failedList && typeof data.failedList === 'object' && typeof data.failedList.skuCode === 'string' ? [data.failedList] : null;
    const ids = new Set(requested.map(item => item.skuCode));
    if (!failures || failures.some(item => !ids.has(item?.skuCode))) fail('invalid_response', 'SHEIN inventory change was not fully acknowledged; inspect stock before retrying');
    if (id === 3001692) {
      const accepted = data.successList;
      if (!Array.isArray(accepted) || accepted.length + failures.length !== requested.length
          || accepted.some(item => !ids.has(item?.skuCode))) fail('invalid_response', 'SHEIN inventory change was not fully acknowledged; inspect stock before retrying');
      const counts = new Map();
      requested.forEach(item => counts.set(item.skuCode, (counts.get(item.skuCode) || 0) + 1));
      [...accepted,...failures].forEach(item => counts.set(item.skuCode, (counts.get(item.skuCode) || 0) - 1));
      if ([...counts.values()].some(count => count !== 0)) fail('invalid_response', 'SHEIN inventory change was not fully acknowledged; inspect stock before retrying');
    }
    return failures.length > 0;
  }
  if (id === 3001274) return data.length > 0;
  if (id === 3001283) {
    const requested = new Set(body.goodsIdList);
    if (data?.returnOrderNo !== body.returnOrderNo || !Array.isArray(data.goodsIdList)
        || new Set(data.goodsIdList).size !== data.goodsIdList.length || data.goodsIdList.some(item => !requested.has(item))) {
      fail('invalid_response', 'SHEIN return receipt was not acknowledged; inspect the return order before retrying');
    }
    return data.goodsIdList.length !== requested.size;
  }
  const failureArrays = { 3001896:'failList',3001939:'failure_results',3001895:'failed_list',3001858:'failedList',3001385:'failedList',3001399:'faildList',3002032:'failedList',3001998:'failedList' };
  if (failureArrays[id]) {
    const failures = data?.[failureArrays[id]];
    if (!Array.isArray(failures)) fail('invalid_response', 'SHEIN did not return the item failure acknowledgement; inspect the affected resource before retrying');
    return failures.length > 0;
  }
  if (id === 3001892) {
    if (!Number.isSafeInteger(data?.failCount) || !Number.isSafeInteger(data?.successCount)) fail('invalid_response', 'SHEIN did not acknowledge the price negotiation');
    return data.failCount > 0;
  }
  if ([3001852,3001176,3001908].includes(id)) return String(data?.code) !== '0';
  if (id === 3001360) return typeof data.failure_reason === 'string' && data.failure_reason.length > 0;
  return false;
}
async function executeNative(config, name, parameters, contract) {
  validateNative(parameters, contract);
  let body = parameters.body;
  if (contract.id === 3001738 || contract.id === 3001692) stockArguments(body, contract.id === 3001738 ? 2 : 1);
  if (contract.id === 3001921) {
    const parse = value => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? Date.parse(value.replace(' ', 'T') + '+08:00') : NaN;
    const start = parse(body.startTime), end = parse(body.endTime);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 48 * 3600000) fail('validation_failed', 'SHEIN order time range must be positive and at most 48 hours');
  }
  if (contract.multipart) {
    if (!body?.file) fail('validation_failed', 'Invalid SHEIN upload parameters; supply an inline file');
    const bytes = Buffer.from(body.file.content_base64, 'base64');
    if (bytes.toString('base64') !== body.file.content_base64) fail('validation_failed', 'Invalid SHEIN upload parameters; use canonical base64');
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) form.set(key, key === 'file' ? new Blob([bytes]) : String(value), ...(key === 'file' ? [body.file.name] : []));
    body = form;
  } else if (contract.input_schema.properties.body && body === undefined) body = {};
  const path = contract.id === 3001905 ? '/open-api/goods/delete/' + encodeURIComponent(parameters.path.skcName) : contract.path;
  const data = await request(config, path, body, false, contract.risk !== 'R', contract, parameters.query);
  const failed = contract.risk !== 'R' && nativeFailure(contract, data, parameters);
  return { ...(contract.risk === 'R' ? {} : { status: failed ? 'partial_or_failed' : 'acknowledged' }),
    data: businessOutput(data, config.credentials, [3001589,3001380].includes(contract.id)) };
}
function pick(value, keys) {
  if (Array.isArray(value)) return value.map((item) => pick(item, keys));
  return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)).map(([key, child]) => [key, pick(child, keys)])) : value;
}
const ORDER_KEYS = ['count', 'orderList', 'orderNo', 'orderStatus', 'orderCreateTime', 'orderUpdateTime', 'stockMode', 'orderType', 'salesSite', 'orderGoodsInfoList', 'skuCode', 'skc', 'sellerSku', 'newGoodsStatus', 'goodsExchangeTag', 'goodsTitle', 'spuName', 'orderCurrency', 'saleCurrency', 'sellerCurrencyPrice', 'costPrice', 'productTotalPrice', 'totalCostPrice', 'productQuantity', 'warehouseCode', 'orderCurrencyStoreCouponPrice', 'orderCurrencyPromotionPrice'];
const utc8 = (seconds) => new Date(seconds * 1000 + 8 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
async function identity(config) {
  const data = await request(config, '/open-api/goods/query-site-list', {});
  if (!Array.isArray(data?.data) || !Number.isSafeInteger(data.meta?.count)) fail('invalid_response', 'SHEIN site identity is missing');
  return { supplier_id: config.credentials.identity.supplier_id, sites: pick(data.data, ['main_site', 'sub_site_list', 'currency', 'site_abbr', 'site_status', 'store_type']) };
}
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const legacy = Object.hasOwn(legacyActionsFor(), name);
  const spec = legacy ? legacyActionsFor()[name] : actionsFor()[name];
  if (!spec) fail('validation_failed', 'Unreviewed SHEIN action');
  if (!legacy) return executeNative(config, name, parameters, businessContracts().methods[name]);
  validate(parameters, spec.input_schema);
  const p = parameters;
  if (name === 'shop.get') return identity(config);
  if (name === 'orders.list' && (p.end_time <= p.start_time || p.end_time - p.start_time > 48 * 3600)) fail('validation_failed', 'SHEIN order time range must be positive and at most 48 hours');
  const page = p.page || 1, limit = p.limit || 10;
  let data;
  if (name === 'products.list' || name === 'products.get') {
    data = await request(config, '/open-api/goods/searchProduct', { pageNum: name === 'products.get' ? 1 : page, pageSize: name === 'products.get' ? 1 : limit, ...(p.spu_code ? { spuNameList: [p.spu_code] } : {}) });
    if (!Array.isArray(data?.data) || !Number.isSafeInteger(data.meta?.count) || (name === 'products.get' && (data.data.length !== 1 || data.data[0].spuName !== p.spu_code))) fail('invalid_response', 'SHEIN product or pagination is missing');
  } else if (name === 'orders.list') {
    data = await request(config, '/open-api/order/order-list', { queryType: p.query_type || 1, startTime: utc8(p.start_time), endTime: utc8(p.end_time), page, pageSize: limit, queryOrderType: 4 });
    if (!Array.isArray(data?.orderList) || !Number.isSafeInteger(data.count)) fail('invalid_response', 'SHEIN order pagination is missing');
    data = pick(data, ORDER_KEYS);
  } else if (name === 'orders.get') {
    data = await request(config, '/open-api/order/order-detail', { orderNoList: [p.order_id] });
    if (!Array.isArray(data) || data.length !== 1 || data[0].orderNo !== p.order_id) fail('invalid_response', 'SHEIN order identity is missing');
    data = pick(data[0], ORDER_KEYS);
  } else if (name === 'warehouses.list') {
    data = await request(config, '/open-api/msc/warehouse/list');
    if (!Array.isArray(data?.list)) fail('invalid_response', 'SHEIN warehouse list is missing');
    data = pick(data, ['list', 'saleCountryList', 'warehouseCode', 'warehouseName', 'warehouseType']);
  } else if (name === 'inventory.get') {
    data = await request(config, '/open-api/stock/stock-query', { skuCodeList: [p.sku_code], invType: 'VI' });
    if (!Array.isArray(data?.goodsInventory)) fail('invalid_response', 'SHEIN inventory is missing');
  } else {
    // Require an existing merchant warehouse; do not accidentally mutate a certified warehouse.
    const warehouses = await request(config, '/open-api/msc/warehouse/list');
    if (!Array.isArray(warehouses?.list) || !warehouses.list.some((w) => w.warehouseCode === p.warehouse_code && String(w.warehouseType) === '1')) fail('validation_failed', 'SHEIN inventory writes require a verified merchant warehouse');
    data = await request(config, '/open-api/stock/change-inventory/v2', { updateSkuInventoryQuantityRequests: [{ idempotencyKey: p.request_key, skuCode: p.sku_code, invType: 'VI', warehouseCode: p.warehouse_code, changeType: 'OVERWRITE', changeQuantity: p.quantity }] }, false, true);
    if (!Array.isArray(data?.failedList) || data.failedList.length) fail('upstream_error', 'SHEIN inventory write was not fully acknowledged; inspect stock before retrying');
    data = { status: 'acknowledged', sku_code: p.sku_code, warehouse_code: p.warehouse_code, requested_total: p.quantity, resulting_stock: 'Read inventory.get; reserved and occupied stock may raise the resulting total.' };
  }
  for (const key of ['app_id', 'app_secret', 'open_key_id', 'secret_key']) data = safeOutput(data, config.credentials[key]);
  return { data, ...(['products.list', 'orders.list'].includes(name) ? { page, limit } : {}) };
}
async function authorize(config) {
  setup(config);
  if (typeof config.oauthCode !== 'string' || !config.oauthCode || config.oauthCode.length > 4096) fail('invalid_credentials', 'Missing SHEIN temporary authorization token');
  const data = await request(config, '/open-api/auth/get-by-token', { tempToken: config.oauthCode }, true);
  if (data.appid !== config.credentials.app_id || !secret(data.openKeyId) || (!Number.isSafeInteger(data.supplierId) && typeof data.supplierId !== 'string') || !/^[1-9][0-9]*$/.test(String(data.supplierId))) fail('binding_mismatch', 'SHEIN authorization does not identify this app and seller');
  const credentials = { provider: 'shein', app_id: config.credentials.app_id, app_secret: config.credentials.app_secret, open_key_id: data.openKeyId,
    secret_key: decryptSecret(data.secretKey, config.credentials.app_secret),
    identity: { supplier_id: String(data.supplierId), app_fingerprint: hash(config.credentials.app_id), grant_fingerprint: hash(data.openKeyId) } };
  const bound = { ...config, credentials };
  await identity(bound);
  await execute(bound, 'products.list', { limit: 1 });
  const now = Math.floor(Date.now() / 1000);
  await execute(bound, 'orders.list', { limit: 1, start_time: now - 86400, end_time: now });
  await execute(bound, 'warehouses.list', {});
  return credentials;
}
module.exports = { isProvider, apiBase, validateBinding, actionsFor, coverageFor, identity, execute, authorize, authorizeUrl, signature, decryptSecret };
