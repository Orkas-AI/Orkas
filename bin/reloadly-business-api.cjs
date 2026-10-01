'use strict';

const { requestFetch, requestFailureCode, httpFailure } = require('./commerce-request-context.cjs');
const { readBody } = require('./storefront-admin-api.cjs');
let contracts, validator;
const cachedActions = new Map(), checks = new Map();
const source = () => contracts ||= require('./reloadly-api-contracts.cjs');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function actionsFor(config) {
  const product = config.metadata?.product;
  if (!['airtime', 'giftcards', 'utilities'].includes(product)) fail('E_BAD_INPUT', 'Invalid Reloadly product binding');
  if (!cachedActions.has(product)) cachedActions.set(product, Object.fromEntries(Object.entries(source().methods)
    .filter(([, row]) => row.product === product).map(([name, row]) => [name, {
      risk: row.risk, description: row.description, input_schema: row.input_schema, documentation_url: row.source_url,
    }])));
  return cachedActions.get(product);
}
const isNative = name => Object.hasOwn(source().methods, name);
function validate(row, p) {
  let encoded; try { encoded = JSON.stringify(p); } catch { fail('E_BAD_INPUT', 'Invalid Reloadly action parameters'); }
  if (!encoded || Buffer.byteLength(encoded) > 256 * 1024) fail('E_BAD_INPUT', 'Invalid or oversized Reloadly action parameters');
  if (!validator) { const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv'); validator = new AjvJsonSchemaValidator(); }
  if (!checks.has(row)) checks.set(row, validator.getValidator(row.input_schema));
  if (!checks.get(row)(p).valid) fail('E_BAD_INPUT', 'Invalid Reloadly action parameters; check the described fields and types');
  for (const value of Object.values(p.path || {})) {
    if (typeof value === 'string' && (!value || value === '.' || value === '..' || /[\u0000-\u001f\u007f/\\]/.test(value))) fail('E_BAD_INPUT', 'Invalid Reloadly resource identifier');
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) fail('E_BAD_INPUT', 'Invalid Reloadly resource identifier');
  }
  if (row.purchase) {
    const keys = row.product === 'giftcards' ? ['productId', 'quantity', 'unitPrice'] : row.product === 'airtime' ? ['operatorId', 'amount'] : ['billerId', 'amount'];
    for (const key of keys) if (!Number.isFinite(Number(p.body[key])) || Number(p.body[key]) <= 0 || Number(p.body[key]) > 1e9) fail('E_BAD_INPUT', 'Invalid Reloadly purchase amount or product identifier');
  }
}
function build(config, name, p = {}) {
  const row = source().methods[name];
  if (config.provider !== 'reloadly' || !row || row.product !== config.metadata?.product) fail('E_BAD_INPUT', 'Reloadly action is unavailable for the connected product');
  validate(row, p);
  let route = row.path;
  const query = new URLSearchParams();
  for (const field of row.wire) {
    let value = p[field.location]?.[field.name];
    if (value === undefined && field.location === 'query' && field.name === 'size') value = 20;
    if (value === undefined) continue;
    if (field.location === 'path') route = route.replace('{' + field.name + '}', encodeURIComponent(String(value)));
    else query.append(field.name, String(value));
  }
  if (/[{}]/.test(route)) fail('E_BAD_INPUT', 'Missing Reloadly resource identifier');
  const accept = row.path.endsWith('/cards') ? `application/com.reloadly.giftcards-v${p.redemption_version || 2}+json` : row.accept;
  return { row, route: route + (query.size ? '?' + query : ''), accept, body: p.body };
}
const PRIVATE_KEYS = new Set(['access_token', 'refresh_token', 'client_secret', 'authorization']);
function clean(value, secrets, depth = 0) {
  if (depth > 40) fail('E_TOOL_CALL_UPSTREAM', 'Reloadly returned an excessively nested response');
  if (typeof value === 'string') { for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]'); return value; }
  if (Array.isArray(value)) return value.map(item => clean(item, secrets, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_KEYS.has(key.toLowerCase())).map(([key, item]) => [key, clean(item, secrets, depth + 1)]));
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function usableId(value) { return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)); }
function parseResponse(text) {
  // Keep integer identifiers/card numbers exact before JSON.parse can round them.
  // Quoted JSON strings are one token and are never reinterpreted as numbers.
  const exact = text.replace(/"(?:\\.|[^"\\])*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g, token => {
    if (token.startsWith('"')) return token;
    const value = Number(token);
    if (/^-?[0-9]+$/.test(token) && !Number.isSafeInteger(value)) return JSON.stringify(token);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('E_TOOL_CALL_UPSTREAM', 'Reloadly returned an unsupported numeric representation');
    return token;
  });
  return JSON.parse(exact);
}
async function execute(config, name, p = {}, owners) {
  const built = build(config, name, p), { row } = built;
  const base = owners.base(config);
  const host = { airtime: 'topups', giftcards: 'giftcards', utilities: 'utilities' }[row.product];
  const environment = config.metadata.environment;
  if (!['live', 'sandbox'].includes(environment) || base !== `https://${host}${environment === 'sandbox' ? '-sandbox' : ''}.reloadly.com`) fail('E_TOOL_CALL_AUTH', 'Invalid Reloadly account binding');
  const token = await owners.token(config);
  const secrets = [token, config.credentials?.client_id, config.credentials?.client_secret].filter(value => typeof value === 'string' && value);
  async function request(method, route, body, accept) {
    const deadline = AbortSignal.timeout(60000);
    let response;
    try { response = await requestFetch(base + route, { method, headers: { authorization: 'Bearer ' + token, accept, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: deadline }); }
    catch (error) { fail(requestFailureCode(error, deadline), 'Reloadly request did not complete; inspect transaction history before retrying a purchase or paid lookup'); }
    if (!response.ok) throw httpFailure(response.status, 'Reloadly could not complete this request; check access, balance or transaction history before retrying');
    let value;
    try { value = parseResponse(await readBody(response)); }
    catch (error) {
      const code = requestFailureCode(error, deadline);
      if (code === 'E_TOOL_CALL_CANCELLED' || code === 'E_TOOL_CALL_TIMEOUT') fail(code, 'Reloadly response was interrupted; check transaction history before retrying');
      fail('E_TOOL_CALL_UPSTREAM', 'Reloadly returned invalid or oversized JSON');
    }
    if (!value || typeof value !== 'object' || (object(value) && (!Object.keys(value).length || value.errorCode || value.error || value.errors))) fail('E_TOOL_CALL_UPSTREAM', 'Reloadly returned a missing acknowledgement or business error');
    return clean(value, secrets);
  }
  let balance;
  if (row.purchase || row.paid_lookup) {
    const media = `application/com.reloadly.${host}-v1+json`;
    balance = await request('GET', '/accounts/balance', undefined, media);
    if (!object(balance) || typeof balance.balance !== 'number' || !Number.isFinite(balance.balance) || typeof balance.currencyCode !== 'string' || !balance.currencyCode) fail('E_TOOL_CALL_UPSTREAM', 'Reloadly wallet balance is unavailable; no purchase or paid lookup was sent');
  }
  const data = await request(row.method, built.route, built.body, built.accept);
  if (row.purchase) {
    if (!object(data) || !usableId(row.product === 'utilities' ? data.id : data.transactionId)) fail('E_TOOL_CALL_UPSTREAM', 'Reloadly omitted the transaction identifier; inspect transaction history before retrying');
    const reference = row.product === 'utilities' ? 'referenceId' : 'customIdentifier';
    if (data[reference] != null && data[reference] !== p.body[reference]) fail('E_TOOL_CALL_UPSTREAM', 'Reloadly returned a different transaction reference; inspect transaction history before retrying');
    if (row.path === '/topups-async') return { status: 'pending', balance_before: balance, transaction: data };
    if (!['SUCCESSFUL', 'PROCESSING', 'PENDING', 'FAILED', 'REFUNDED'].includes(data.status)) fail('E_TOOL_CALL_UPSTREAM', 'Reloadly omitted a recognized transaction status; inspect transaction history before retrying');
    const failed = ['FAILED', 'REFUNDED'].includes(data.status);
    if (failed) delete data.message;
    return { status: failed ? 'partial_or_failed' : data.status === 'SUCCESSFUL' ? 'acknowledged' : 'pending', balance_before: balance, transaction: data };
  }
  if (row.paid_lookup) {
    if (!object(data) || !usableId(data.operatorId ?? data.id)) fail('E_TOOL_CALL_UPSTREAM', 'Reloadly omitted the lookup result; check lookup history before retrying');
    return { balance_before: balance, data };
  }
  return { data };
}

module.exports = { actionsFor, isNative, build, execute };
