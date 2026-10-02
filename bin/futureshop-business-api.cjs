'use strict';
const owner = require('./futureshop-api.cjs');
let contracts, actions, validator;
const checks = new Map();
const source = () => contracts ||= require('./futureshop-api-contracts.cjs');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const isNative = name => Object.hasOwn(source().methods, name);
function actionsFor() {
  return actions ||= Object.fromEntries(Object.entries(source().methods).map(([name, row]) => [name, { risk: row.risk, description: row.description, input_schema: row.input_schema, documentation_url: row.source_url }]));
}
function checkValue(schema, value, path, row) {
  if (typeof value === 'string') {
    const limit = row.byte_limits[path];
    if (limit && Buffer.byteLength(value, 'utf8') > limit) fail('E_BAD_INPUT', 'futureshop field exceeds the documented UTF-8 byte limit');
    if (value && (schema.pattern || schema.anyOf?.find(branch => branch.pattern)?.pattern)?.includes('\\d{4}')) {
      const stamp = new Date(value.length === 10 ? value + 'T00:00:00Z' : value + 'Z');
      if (!Number.isFinite(stamp.getTime()) || stamp.toISOString().slice(0, value.length) !== value) fail('E_BAD_INPUT', 'Invalid futureshop date or local date-time');
    }
  }
  if (Array.isArray(value)) value.forEach(child => checkValue(schema.items, child, path + '.*', row));
  else if (object(value)) for (const [key, child] of Object.entries(value)) checkValue(schema.properties[key], child, path ? path + '.' + key : key, row);
}
function build(config, name, p = {}) {
  if (config.provider !== 'futureshop' || !isNative(name)) fail('E_BAD_INPUT', 'Unavailable futureshop action');
  const row = source().methods[name];
  let encoded; try { encoded = JSON.stringify(p); } catch { fail('E_BAD_INPUT', 'Invalid futureshop parameters'); }
  if (!encoded || Buffer.byteLength(encoded) > 256 * 1024) fail('E_BAD_INPUT', 'Invalid or oversized futureshop parameters');
  if (!validator) { const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv'); validator = new AjvJsonSchemaValidator(); }
  if (!checks.has(row)) checks.set(row, validator.getValidator(row.input_schema));
  if (!checks.get(row)(p).valid) fail('E_BAD_INPUT', 'Invalid futureshop parameters; check the described fields and types');
  checkValue(row.input_schema, p, '', row);
  const query = { ...(p.query || {}) };
  for (const [key, schema] of Object.entries(row.input_schema.properties.query?.properties || {})) if (query[key] === undefined && schema.default !== undefined) query[key] = schema.default;
  for (const key of ['productNo', 'mainGroupUrl', 'janCode', 'memberId', 'orderNo']) if (row.method === 'GET' && query[key] !== undefined) {
    const values = query[key].split(',');
    const maxBytes = { productNo: 32, mainGroupUrl: 32, janCode: 30, memberId: 20, orderNo: 12 }[key];
    if (values.length > 100 || values.some(value => !value || Buffer.byteLength(value) > maxBytes)) fail('E_BAD_INPUT', 'futureshop filters exceed the identifier or 100-entry limit');
  }
  if (query.updateDateStart && query.updateDateEnd) {
    const span = Date.parse(query.updateDateEnd + 'Z') - Date.parse(query.updateDateStart + 'Z');
    if (span < 0 || span > 31 * 86400000) fail('E_BAD_INPUT', 'futureshop update-date range must be ordered and at most 31 days');
  }
  const list = p.body?.productList || p.body?.orderList || p.body?.pointList;
  if (list) {
    const keys = row.source_id === 'adjustpointsRegist' ? ['memberId', 'name'] : row.source_id === 'pointsstatusRefresh' ? ['pointId'] : p.body.productList ? ['productNo'] : ['orderNo'];
    const identities = list.map(value => JSON.stringify(keys.map(key => value[key])));
    if (new Set(identities).size !== identities.length) fail('E_BAD_INPUT', 'Duplicate futureshop resources in one mutation');
  }
  let leafCount = 0;
  const countLeaves = value => {
    if (!object(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'inventoryList' || key === 'shipmentList') leafCount += child.length;
      else if (Array.isArray(child)) child.forEach(countLeaves);
      else if (object(child)) countLeaves(child);
    }
  };
  countLeaves(p.body);
  if (leafCount > 10) fail('E_BAD_INPUT', 'futureshop permits at most 10 stock or shipment changes per high-impact call');
  let route = row.path;
  for (const [key, value] of Object.entries(p.path || {})) route = route.replace('{' + key + '}', encodeURIComponent(value));
  return { row, route, query, body: p.body };
}
function parseJson(text) {
  return JSON.parse(text.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g, token => {
    if (token.startsWith('"')) return token;
    const value = Number(token);
    if (/^-?[0-9]+$/.test(token) && !Number.isSafeInteger(value)) return JSON.stringify(token);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('E_TOOL_CALL_UPSTREAM', 'Unsupported futureshop numeric representation');
    return token;
  }));
}
const PRIVATE_KEYS = new Set(['access_token', 'refresh_token', 'client_secret', 'shop_key', 'authorization', 'password']);
function clean(value, secrets, depth = 0) {
  if (depth > 40) fail('E_TOOL_CALL_UPSTREAM', 'Excessively nested futureshop response');
  if (typeof value === 'string') { for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]'); return value; }
  if (Array.isArray(value)) return value.map(child => clean(child, secrets, depth + 1));
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEYS.has(key.toLowerCase())).map(([key, child]) => [key, clean(child, secrets, depth + 1)]));
}
function codes(errors) {
  if (errors === undefined) return [];
  if (!Array.isArray(errors)) fail('E_TOOL_CALL_UPSTREAM', 'Malformed futureshop error acknowledgement');
  return errors.map(error => ({ ...(typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(error.code) ? { code: error.code } : {}) }));
}
function mutationResult(row, p, data) {
  if (!['success', 'failed'].includes(data.status)) fail('E_TOOL_CALL_UPSTREAM', 'futureshop omitted the mutation status; inspect the shop before retrying');
  const result = { status: data.status === 'success' ? 'acknowledged' : 'partial_or_failed', errors: codes(data.errors) };
  const list = p.body?.productList || p.body?.orderList || p.body?.pointList;
  if (list) {
    if (!Array.isArray(data.results) || data.results.length !== list.length) fail('E_TOOL_CALL_UPSTREAM', 'futureshop omitted resource acknowledgements; inspect the shop before retrying');
    const keys = row.source_id === 'adjustpointsRegist' ? ['memberId', 'name'] : row.source_id === 'pointsstatusRefresh' ? ['pointId'] : p.body.productList ? ['productNo'] : ['orderNo'];
    const expected = new Set(list.map(value => JSON.stringify(keys.map(key => value[key]))));
    result.results = data.results.map(value => {
      if (!object(value) || !['success', 'failed'].includes(value.status)) fail('E_TOOL_CALL_UPSTREAM', 'futureshop returned an invalid resource acknowledgement');
      const key = JSON.stringify(keys.map(key => value[key]));
      if (!expected.delete(key)) fail('E_TOOL_CALL_UPSTREAM', 'futureshop acknowledged a different or duplicate resource');
      if (value.status === 'failed') result.status = 'partial_or_failed';
      const output = { status: value.status, ...Object.fromEntries([...keys, 'apiId'].filter(key => value[key] !== undefined).map(key => [key, value[key]])), errors: codes(value.errors) };
      if (output.errors.length) result.status = 'partial_or_failed';
      for (const key of ['code', 'errorCode']) if (typeof value[key] === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(value[key])) output[key] = value[key];
      if (row.source_id === 'adjustpointsRegist' && value.status === 'success' && (typeof value.apiId !== 'string' || !value.apiId)) fail('E_TOOL_CALL_UPSTREAM', 'futureshop omitted the created points reference');
      return output;
    });
  } else if (data.status === 'success') {
    if (row.source_id === 'pointsUse' && (typeof data.apiId !== 'string' || !data.apiId)) fail('E_TOOL_CALL_UPSTREAM', 'futureshop omitted the points transaction reference');
    if (row.source_id === 'memberRegist' && (typeof data.memberId !== 'string' || !data.memberId)) fail('E_TOOL_CALL_UPSTREAM', 'futureshop omitted the created member identifier');
    if (data.apiId) result.apiId = data.apiId;
    if (data.memberId) result.memberId = data.memberId;
  }
  if (result.errors.length) result.status = 'partial_or_failed';
  return result;
}
function nextCursor(config, data, route, query) {
  if (!data.nextUrl) return null;
  let next;
  try { next = new URL(data.nextUrl, config.metadata.api_origin); } catch { fail('E_TOOL_CALL_UPSTREAM', 'Invalid futureshop pagination'); }
  const cursor = next.searchParams.get('cursor');
  if (next.origin !== config.metadata.api_origin || next.pathname !== route || next.username || next.password || next.hash || !cursor || cursor.length > 2048) fail('E_TOOL_CALL_UPSTREAM', 'Invalid futureshop pagination');
  for (const [key, value] of next.searchParams) if (key !== 'cursor' && (query[key] === undefined || String(query[key]) !== value)) fail('E_TOOL_CALL_UPSTREAM', 'futureshop pagination changed the requested filters');
  return cursor;
}
async function execute(config, name, p = {}) {
  const built = build(config, name, p), { row } = built;
  owner.validateBinding(config);
  await owner.ensureToken(config);
  if (row.source_id === 'inventoryRefresh') {
    const products = p.body.productList;
    const current = await owner.request(config, '/admin-api/v1/inventory', { query: { productNo: products.map(value => value.productNo).join(','), types: 'regular,preorder,planned' }, parseJson });
    if (!Array.isArray(current.productList)) fail('E_TOOL_CALL_UPSTREAM', 'futureshop inventory is unavailable; no stock update was sent');
    for (const product of products) {
      const existing = current.productList.find(value => value.productNo === product.productNo)?.inventoryInfo;
      const groups = ['regular', 'preorder'].filter(key => product.inventoryInfo[key]).map(key => [product.inventoryInfo[key], existing?.[key]]);
      for (const planned of product.inventoryInfo.plannedList || []) groups.push([planned, existing?.plannedList?.find(value => value.date === planned.date)]);
      if (!groups.length) fail('E_BAD_INPUT', 'Select stock entries to update');
      for (const [wanted, found] of groups) {
        if (!Array.isArray(wanted.inventoryList) || !Array.isArray(found?.inventoryList)) fail('E_BAD_INPUT', 'Select existing futureshop stock entries before updating');
        const seen = new Set();
        for (const item of wanted.inventoryList) {
          const key = JSON.stringify([item.verticalNo || '', item.horizontalNo || '']);
          if (seen.has(key) || !found.inventoryList.some(value => (value.verticalNo || '') === (item.verticalNo || '') && (value.horizontalNo || '') === (item.horizontalNo || ''))) fail('E_BAD_INPUT', 'Select distinct existing futureshop stock variations before updating');
          seen.add(key);
        }
      }
    }
  }
  const data = await owner.request(config, built.route, { method: row.method, query: built.query, body: built.body, parseJson, allowBusinessErrors: true });
  const secrets = [owner.getAccessToken(config), ...['client_id', 'client_secret', 'shop_key'].map(key => config.credentials[key]), p.query?.password].filter(value => typeof value === 'string' && value);
  if (row.method !== 'GET') return clean(mutationResult(row, p, data), secrets);
  if (data.status === 'failed' || data.errors?.length) fail('E_TOOL_CALL_UPSTREAM', 'futureshop rejected the read; check merchant API permissions and enabled options');
  const lists = { productsSearch: ['productList', 'productNo'], inventorySearch: ['productList', 'productNo'], memberSearch: ['memberList', 'memberId'], orderdata: ['orderList', 'orderNo'], pointsHistory: ['pointList', 'pointId'] };
  const list = lists[row.source_id];
  if (list && (!Array.isArray(data[list[0]]) || data[list[0]].some(value => !object(value) || typeof value[list[1]] !== 'string' || !value[list[1]]))) fail('E_TOOL_CALL_UPSTREAM', 'futureshop returned incomplete resource data');
  if (row.source_id === 'orderdataRequest' && data.orderNo !== p.path.orderNo || row.source_id === 'realstoreRequest' && data.storeCode !== p.path.storeCode) fail('E_TOOL_CALL_UPSTREAM', 'futureshop returned a different resource');
  const next_cursor = nextCursor(config, data, built.route, built.query);
  delete data.nextUrl;
  return { data: clean(data, secrets), next_cursor };
}
module.exports = { actionsFor, isNative, build, execute };
