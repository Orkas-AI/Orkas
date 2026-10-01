'use strict';

const { requestFetch, requestFailureCode } = require('./commerce-request-context.cjs');

// Official manual seller authorization for local and semi-managed production shops.
const crypto = require('node:crypto');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const HOSTS = { us: 'https://openapi-b-us.temu.com', eu: 'https://openapi-b-eu.temu.com', global: 'https://openapi-b-global.temu.com' };
const METHODS = { 'shop.get': 'bg.open.accesstoken.info.get', 'products.list': 'bg.local.goods.list.query', 'products.get': 'bg.local.goods.detail.query',
  'orders.list': 'bg.order.list.v2.get', 'orders.get': 'bg.order.detail.v2.get', 'inventory.get': 'temu.local.goods.sku.stock.query', 'inventory.set': 'bg.local.goods.stock.edit' };
const SECRET_KEYS = ['app_key', 'app_secret', 'access_token'];
const UPLOAD_METHODS = new Set(['bg.arbok.open.upload.uploadFile', 'bg.flash.open.upload.real.image',
  'temu.olaf.auth.rep.upload', 'bg.local.goods.image.upload', 'temu.local.goods.image.v2.upload',
  'temu.aftersales.upload.returnlabel', 'temu.local.order.verification.upload', 'temu.logistics.self.delivery.pod.upload',
  'temu.pay.tax.merchant.upload.invoice', 'bg.arbok.open.cert.uploadProductCert', 'bg.flash.open.upload.recognize']);
const fail = (kind, message) => { throw Object.assign(new Error(message), { code: `storefront_${kind}` }); };
const isProvider = (provider) => provider === 'temu';
const ID = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const PAGE = { page: { type: 'integer', minimum: 1, maximum: 100000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
let contracts;
let validator;
const nativeActions = new Map();
const validators = new Map();

// Pinned provider contracts are loaded only for Temu discovery/native calls.
// Other merchant adapters and the legacy authorization probes incur no schema IO.
function regionalContracts(metadata = { region: 'us' }) {
  if (!Object.hasOwn(HOSTS, metadata?.region)) fail('invalid_binding', 'Invalid Temu production region');
  contracts ||= require('./temu-api-contracts.cjs');
  return contracts.regions[metadata.region];
}
function coverageFor(metadata) {
  const region = regionalContracts(metadata);
  return { complete: false, documentation_snapshot: contracts.documentation_snapshot,
    scope: contracts.scope, reviewed_business_methods: Object.keys(region.methods).length,
    unavailable_methods: [...region.unavailable_methods], host_owned_methods: { ...region.host_owned_methods },
    host_owned_fields: { 'bg.cooperativewarehouse.fulfill.submit': ['authorizeKey', 'authorizeToken', 'authorizeType=1'] },
    max_inline_parameter_bytes: 256 * 1024 };
}
function validateNative(parameters, spec) {
  let serialized;
  try { serialized = JSON.stringify(parameters); } catch { fail('validation_failed', 'Invalid Temu action parameters'); }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 256 * 1024) fail('validation_failed', 'Invalid or oversized Temu action parameters');
  if (!validator) {
    const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
    validator = new AjvJsonSchemaValidator();
  }
  let check = validators.get(spec.input_schema);
  if (!check) { check = validator.getValidator(spec.input_schema); validators.set(spec.input_schema, check); }
  if (!check(parameters).valid) fail('validation_failed', 'Invalid Temu action parameters; check the described field types and required fields');
}

function apiBase(provider, metadata) {
  if (!isProvider(provider) || !metadata || Object.keys(metadata).length !== 1 || !Object.hasOwn(HOSTS, metadata.region)) fail('invalid_binding', 'Invalid Temu production region');
  return HOSTS[metadata.region] + '/openapi/router';
}
function validateCredentials(config) {
  apiBase(config.provider, config.metadata);
  for (const key of SECRET_KEYS) {
    const value = config.credentials?.[key];
    if (typeof value !== 'string' || value.length < (key === 'app_key' ? 3 : 8) || value.length > 4096 || /[\s\u0000-\u001f\u007f]/.test(value)) fail('invalid_credentials', 'Invalid Temu application credential');
  }
}
const fingerprint = (key) => crypto.createHash('sha256').update(key).digest('hex');
function validateBinding(config) {
  validateCredentials(config);
  const id = config.credentials.identity;
  if (config.credentials.provider !== config.provider || id?.region !== config.metadata.region || id?.app_fingerprint !== fingerprint(config.credentials.app_key)
      || !/^[1-9][0-9]*$/.test(id?.shop_id || '') || !Array.isArray(id?.scopes)) fail('binding_mismatch', 'Temu credentials do not match this shop binding; reconnect');
  if (!Number.isSafeInteger(id.expires_at) || id.expires_at <= Date.now()) fail('permission_denied', 'Temu authorization expired; authorize again in Seller Center and reconnect');
}
function sign(parameters, secret) {
  const text = Object.keys(parameters).filter((key) => key !== 'sign').sort().map((key) => key + (typeof parameters[key] === 'object' ? JSON.stringify(parameters[key]) : String(parameters[key]))).join('');
  return crypto.createHash('md5').update(secret + text + secret, 'utf8').digest('hex').toUpperCase();
}
async function request(config, type, parameters = {}, write = false, contract) {
  validateCredentials(config);
  const body = { ...parameters, type, app_key: config.credentials.app_key, access_token: config.credentials.access_token, timestamp: String(Math.floor(Date.now() / 1000)), data_type: 'JSON' };
  body.sign = sign(body, config.credentials.app_secret);
  const deadline = AbortSignal.timeout(UPLOAD_METHODS.has(type) ? 600000 : 60000);
  const ioFailure = (error) => {
    const code = requestFailureCode(error, deadline);
    const message = `Temu request failed${write ? '; inspect the affected resource before retrying an uncertain write' : ''}`;
    if (code === 'E_TOOL_CALL_CANCELLED') throw Object.assign(new Error(message), { code });
    fail(code === 'E_TOOL_CALL_TIMEOUT' ? 'timeout' : 'network_failed', message);
  };
  let response;
  try { response = await requestFetch(apiBase(config.provider, config.metadata), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: deadline }); }
  catch (error) { ioFailure(error); }
  if (!response.ok) fail([401, 403].includes(response.status) ? 'permission_denied' : response.status === 429 ? 'rate_limit' : 'upstream_error', `Temu API failed (HTTP ${response.status})`);
  let text, data;
  try { text = await readBody(response); } catch (error) {
    if (error?.code === 'E_CONNECTOR_RESPONSE_TOO_LARGE') fail('upstream_error', 'Temu returned invalid or oversized JSON');
    ioFailure(error);
  }
  try { data = JSON.parse(text); } catch { fail('upstream_error', 'Temu returned invalid or oversized JSON'); }
  if (data?.success !== true) fail('request_failed', 'Temu API rejected the request; check seller authorization, business mode and parameters');
  if (contract) {
    if (data.result == null && contract.allow_absent_result) return null;
    const valid = contract.result_type === 'BOOLEAN' ? typeof data.result === 'boolean'
      : contract.result_type === 'OBJECT[]' ? Array.isArray(data.result)
        : contract.result_type === 'OBJECT' && data.result !== null && typeof data.result === 'object' && !Array.isArray(data.result);
    if (!valid) fail('invalid_response', 'Temu returned an invalid business acknowledgement');
  } else if (!data.result || typeof data.result !== 'object' || Array.isArray(data.result)) {
    fail('request_failed', 'Temu API rejected the request; check seller authorization, business mode and parameters');
  }
  return data.result;
}
function legacyActionsFor() {
  return {
    'shop.get': action('R', 'Read the verified Temu shop, authorization expiry, granted API scope names and declared API coverage gaps.'),
    'products.list': action('R', 'Read one page of available/off-shelf products, including SKU stock and pagination.', PAGE),
    'products.get': action('R', 'Read one product by its Temu goods ID.', { goods_id: ID }, ['goods_id']),
    'orders.list': action('R', 'Read one page of local/semi-managed orders without buyer or payment details.', PAGE),
    'orders.get': action('R', 'Read one parent order and its items without buyer or payment details.', { order_id: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9-]+$' } }, ['order_id']),
    'inventory.get': action('R', 'Read ordinary and presale stock for one goods ID. Only ordinary self-managed stock can be changed here.', { goods_id: ID }, ['goods_id']),
    'inventory.set': action('H', 'Replace ordinary self-managed stock for one SKU after fresh confirmation. Use a unique request key and never automatically retry an uncertain write.',
      { goods_id: ID, sku_id: ID, quantity: { type: 'integer', minimum: 0, maximum: 2147483647 }, request_key: { type: 'string', minLength: 8, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$', description: 'Unique identifier for this confirmed change; reuse only to identify the same request, never a different change.' } }, ['goods_id', 'sku_id', 'quantity', 'request_key']),
  };
}
function actionsFor(metadata) {
  const region = regionalContracts(metadata);
  const key = metadata?.region || 'us';
  if (!nativeActions.has(key)) {
    nativeActions.set(key, Object.fromEntries(Object.entries(region.methods).map(([name, method]) => [name, {
      risk: method.risk, description: method.description,
      input_schema: businessInputSchema(name, contracts.definitions[method.definition].input_schema),
    }])));
  }
  return { ...legacyActionsFor(), ...nativeActions.get(key) };
}

function businessInputSchema(name, schema) {
  if (name !== 'bg.cooperativewarehouse.fulfill.submit') return schema;
  // Only use the warehouse grant already stored by Temu. Direct warehouse
  // credentials require their own encrypted host workflow, not business input.
  const { authorizeKey: _key, authorizeToken: _token, ...properties } = schema.properties;
  return { ...schema, properties: { ...properties, authorizeType: { ...properties.authorizeType, enum: [0] } },
    required: [...schema.required, 'cwCustomerCode'] };
}

// Business output includes authorized fulfillment PII. Authentication and raw
// provider error prose never become business data or diagnostic messages.
const PRIVATE_FIELDS = new Set(['accesstoken', 'refreshtoken', 'idtoken', 'appkey', 'appsecret', 'clientsecret',
  'secretkey', 'cwappkey', 'cwaccesstoken', 'authorizekey', 'authorizetoken', 'authorization', 'password', 'cookie', 'sign', 'signature',
  'errormsg', 'errormessage', 'failreason', 'reason']);
function businessOutput(value, credentials) {
  if (typeof value === 'string') return SECRET_KEYS.reduce((text, key) => text.split(credentials[key]).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map(item => businessOutput(item, credentials));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => {
    const canonical = key.replace(/[_-]/g, '').toLowerCase();
    return !PRIVATE_FIELDS.has(canonical) || (canonical === 'reason' && typeof item === 'number');
  })
    .map(([key, item]) => [key, businessOutput(item, credentials)]));
}
function stockArguments(parameters) {
  const entries = [...(parameters.skuStockChangeList || []), ...(parameters.skuStockTargetList || [])];
  if (parameters.goodsId < 1 || !entries.length || new Set(entries.map(item => item.skuId)).size !== entries.length
      || entries.some(item => item.skuId < 1 || (item.stockTarget !== undefined && item.stockTarget < 0))
      || (parameters.stockType !== undefined && ![0, 1].includes(parameters.stockType))) fail('validation_failed', 'Invalid Temu stock action parameters');
  return entries;
}
function stockAcknowledgement(data, parameters) {
  const requested = stockArguments(parameters);
  const requestedIds = new Set(requested.map(item => item.skuId));
  const entries = data?.skuStockEditStatusInfoList;
  if (String(data?.goodsId) !== String(parameters.goodsId) || typeof data?.operateResult !== 'boolean'
      || !Array.isArray(entries) || entries.length !== requested.length
      || new Set(entries.map(item => item?.skuId)).size !== entries.length
      || entries.some(item => !requestedIds.has(item?.skuId) || typeof item.stockEditStatus !== 'boolean')) {
    fail('invalid_response', 'Temu stock update was not fully acknowledged; inspect stock before retrying');
  }
  return data.operateResult === false || entries.some(item => item.stockEditStatus === false);
}
function nativeFailure(name, data, parameters) {
  if (name === 'bg.local.goods.stock.edit') return stockAcknowledgement(data, parameters);
  if (data === false) return true;
  if (data?.success === false || data?.applyResult === false) return true;
  if (name === 'temu.local.goods.pre.sale.status.edit') {
    const entries = data?.skuOperateResultInfoList;
    const requestedIds = new Set(parameters.skuInfoList.map(item => item.skuId));
    if (data?.goodsId !== parameters.goodsId || !Number.isInteger(data?.code) || !Array.isArray(entries)
        || entries.length !== parameters.skuInfoList.length || new Set(entries.map(item => item?.skuId)).size !== entries.length
        || requestedIds.size !== parameters.skuInfoList.length
        || entries.some(item => !requestedIds.has(item?.skuId) || !Number.isInteger(item.code))) {
      fail('invalid_response', 'Temu presale update was not fully acknowledged; inspect stock before retrying');
    }
    return data.code !== 0 || entries.some(item => item.code !== 0);
  }
  if (['bg.promotion.activity.goods.enroll', 'bg.promotion.activity.goods.update'].includes(name)) return data?.operationStatus === 30;
  if (name === 'temu.finance.mall.bill.task.create') return data?.status === 'TIME_OUT';
  if (['bg.local.goods.multi.site.submit', 'bg.local.goods.out.sn.set', 'bg.local.goods.sku.out.sn.set'].includes(name)) {
    return data?.resultList?.some(item => item.success === false || item.modifySuccess === false) === true;
  }
  if (name === 'bg.local.goods.priceorder.change.sku.price') return (data?.failedSkuList?.length || Object.keys(data?.failedSkuReasonMap || {}).length) > 0;
  if (name === 'temu.searchrec.ad.create') return Object.keys(data?.createGoodsFailMap || {}).length > 0
    || data?.createGoodsFailObjList?.some(item => item.success !== true) === true;
  if (name === 'temu.searchrec.ad.modify') return data?.modifyGoodsRespList?.some(item => item.success === false) === true;
  return false;
}
async function executeNative(config, name, parameters, spec) {
  validateNative(parameters, spec);
  if (!config.credentials.identity.scopes.includes(name)) fail('permission_denied', 'This Temu authorization lacks the requested API permission; update Seller Center authorization and reconnect');
  if (name === 'bg.local.goods.stock.edit') stockArguments(parameters);
  const contract = contracts.definitions[regionalContracts(config.metadata).methods[name].definition];
  const data = name === 'bg.open.accesstoken.info.get' ? await identity(config)
    : await request(config, name, parameters, spec.risk !== 'R', contract);
  const failed = spec.risk !== 'R' && nativeFailure(name, data, parameters);
  return { ...(spec.risk === 'R' ? {} : { status: failed ? 'partial_or_failed' : 'acknowledged' }), data: businessOutput(data, config.credentials) };
}
async function identity(config) {
  const data = await request(config, METHODS['shop.get']);
  if ((!Number.isSafeInteger(data.mallId) && typeof data.mallId !== 'string') || !/^[1-9][0-9]*$/.test(String(data.mallId))
      || !Number.isSafeInteger(data.expiredTime) || data.expiredTime * 1000 <= Date.now() || !Array.isArray(data.apiScopeList) || data.apiScopeList.some((s) => typeof s !== 'string')) fail('permission_denied', 'Temu authorization is missing or expired; reconnect with a current Seller Center token');
  const result = { shop_id: String(data.mallId), region: config.metadata.region, app_fingerprint: fingerprint(config.credentials.app_key), expires_at: data.expiredTime * 1000, scopes: data.apiScopeList };
  if (config.credentials.identity && result.shop_id !== config.credentials.identity.shop_id) fail('binding_mismatch', 'Temu shop identity changed; reconnect');
  return result;
}
function minimizeOrder(value) {
  const fields = ['totalItemNum', 'pageItems', 'parentOrderMap', 'orderList', 'parentOrderSn', 'parentOrderStatus', 'parentOrderTime', 'parentShippingTime', 'updateTime', 'parentConfirmTime', 'siteId', 'regionId', 'orderSn', 'goodsId', 'skuId', 'goodsName', 'quantity', 'orderStatus', 'orderCreateTime', 'orderShippingTime', 'canceledQuantityBeforeShipment', 'originalOrderQuantity', 'productList', 'productSkuId', 'productId', 'extCode', 'soldFactor', 'fulfillmentType'];
  if (Array.isArray(value)) return value.map(minimizeOrder);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => fields.includes(key)).map(([key, child]) => [key, minimizeOrder(child)]));
}
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const legacy = Object.hasOwn(METHODS, name);
  const spec = legacy ? legacyActionsFor()[name] : actionsFor(config.metadata)[name];
  if (!spec) fail('validation_failed', 'Unreviewed Temu action');
  if (!legacy) return executeNative(config, name, parameters, spec);
  validate(parameters, spec.input_schema);
  if (name === 'shop.get') return { ...await identity(config), api_coverage: coverageFor(config.metadata) };
  if (!config.credentials.identity.scopes.includes(METHODS[name])) fail('permission_denied', 'This Temu authorization lacks the requested API permission; update Seller Center authorization and reconnect');
  const p = parameters;
  const args = name === 'products.list' ? { pageNo: p.page || 1, pageSize: p.limit || 50, goodsSearchType: 1 }
    : name === 'orders.list' ? { pageNumber: p.page || 1, pageSize: p.limit || 50 }
      : name === 'orders.get' ? { parentOrderSn: p.order_id }
        : name === 'inventory.set' ? { goodsId: p.goods_id, stockType: 0, skuStockTargetList: [{ stockTarget: p.quantity, skuId: p.sku_id }], requestUniqueKey: p.request_key }
          : { goodsId: p.goods_id };
  let data = await request(config, METHODS[name], args, spec.risk === 'H');
  if (name === 'inventory.set') {
    const entries = data.skuStockEditStatusInfoList;
    if (data.operateResult !== true || String(data.goodsId) !== String(p.goods_id) || !Array.isArray(entries) || entries.length !== 1
        || String(entries[0].skuId) !== String(p.sku_id) || entries[0].stockEditStatus !== true) fail('upstream_error', 'Temu stock update was not fully acknowledged; inspect stock before retrying');
    return { status: 'completed', goods_id: p.goods_id, sku_id: p.sku_id, quantity: p.quantity };
  }
  if ((name === 'products.list' && (!Array.isArray(data.goodsList) || !Number.isSafeInteger(data.total)))
      || (name === 'products.get' && String(data.goodsId) !== String(p.goods_id))
      || (name === 'orders.get' && (data.parentOrderMap?.parentOrderSn !== p.order_id || !Array.isArray(data.orderList)))
      || (name === 'orders.list' && (!Array.isArray(data.pageItems) || !Number.isSafeInteger(data.totalItemNum)))
      || (name === 'inventory.get' && !Array.isArray(data.stockList))) fail('invalid_response', 'Temu resource or pagination is missing');
  if (name.startsWith('orders.')) data = minimizeOrder(data);
  for (const key of SECRET_KEYS) data = safeOutput(data, config.credentials[key]);
  return { data, ...(name.endsWith('.list') ? { page: p.page || 1, limit: p.limit || 50 } : {}) };
}
async function authorize(config) {
  validateCredentials(config);
  const credentials = { provider: config.provider, ...Object.fromEntries(SECRET_KEYS.map((key) => [key, config.credentials[key]])), identity: await identity(config) };
  const bound = { ...config, credentials };
  await execute(bound, 'products.list', { limit: 1 });
  await execute(bound, 'orders.list', { limit: 1 });
  return credentials;
}
module.exports = { isProvider, apiBase, validateBinding, actionsFor, coverageFor, identity, execute, authorize, sign };
