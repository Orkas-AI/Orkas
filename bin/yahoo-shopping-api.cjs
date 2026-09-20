'use strict';

// Yahoo! JAPAN seller APIs, not Yahoo global OAuth or public affiliate search.
// https://developer.yahoo.co.jp/webapi/shopping/ (reviewed 2026-09-16).
const crypto = require('node:crypto');
const { XMLParser, XMLBuilder, XMLValidator } = require('fast-xml-parser');
const { requestFetch, credentialOperation, requestFailureCode, httpFailureCode } = require('./commerce-request-context.cjs');
const { validate, readBody, safeOutput } = require('./storefront-admin-api.cjs');
const { readCredentialFile, writeCredentialFile } = require('./local-api-credential-codec.cjs');
const API = 'https://circus.shopping.yahooapis.jp/ShoppingWebService/V1';
const SANDBOX_API = 'https://test.circus.shopping.yahooapis.jp/ShoppingWebService/V1';
const AUTH = 'https://auth.login.yahoo.co.jp/yconnect/v2';
const refreshes = new Map();
const rate = new Map();
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const isProvider = provider => provider === 'yahoo_shopping';
const validSecret = value => typeof value === 'string' && value.length >= 3 && value.length <= 4096 && !/[\s:\u0000-\u001f\u007f]/.test(value);
function normalizePublicKey(value) {
  try {
    if (typeof value !== 'string' || value.length > 6000) throw new Error();
    const pem = /^-----BEGIN PUBLIC KEY-----\s*([A-Za-z0-9+/=\s]+)\s*-----END PUBLIC KEY-----$/.exec(value.trim());
    const encoded = (pem ? pem[1] : value.trim()).replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const key = crypto.createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 4096) throw new Error();
    return key.export({ format: 'der', type: 'spki' }).toString('base64');
  } catch { fail('E_BAD_INPUT', 'Enter the RSA public key issued by Yahoo! Shopping'); }
}
function apiBase(provider, metadata) {
  if (!isProvider(provider) || !metadata || Object.keys(metadata).some(key => !['seller_id', 'key_version', 'environment'].includes(key))
    || !/^[a-z0-9_-]{1,128}$/.test(metadata.seller_id || '')
    || (metadata.environment !== undefined && !['live', 'sandbox'].includes(metadata.environment))
    || (metadata.key_version !== undefined && !/^[1-9][0-9]{0,5}$/.test(metadata.key_version))) fail('E_BAD_INPUT', 'Invalid Yahoo! Shopping seller binding');
  return metadata.environment === 'sandbox' ? SANDBOX_API : API;
}
function setup(config) {
  apiBase(config.provider, config.metadata);
  const c = config.credentials;
  if (!validSecret(c?.client_id) || !validSecret(c?.client_secret)) fail('E_TOOL_CALL_AUTH', 'Enter the Yahoo! Shopping application credentials');
  if (Boolean(c.public_key) !== Boolean(config.metadata.key_version)) fail('E_BAD_INPUT', 'Supply both the Yahoo! public key and its version, or leave both empty');
  if (c.public_key && normalizePublicKey(c.public_key) !== c.public_key) fail('E_BAD_INPUT', 'Invalid Yahoo! public key');
}
const fingerprint = config => crypto.createHash('sha256').update(JSON.stringify([config.metadata.seller_id, config.metadata.key_version || '',
  config.credentials.client_id, config.credentials.client_secret, config.credentials.public_key || '',
  // Keep the pre-sandbox live binding compatible; test grants cannot be reused in live.
  ...(config.metadata.environment === 'sandbox' ? ['sandbox'] : [])])).digest('hex');
function validateBinding(config) {
  setup(config);
  const c = config.credentials;
  if (c.provider !== 'yahoo_shopping' || !validSecret(c.access_token) || !validSecret(c.refresh_token) || !Number.isSafeInteger(c.expires_at)
    || c.identity?.fingerprint !== fingerprint(config)) fail('E_TOOL_CALL_AUTH', 'Yahoo! Shopping shop or application changed; reconnect');
}
function authorizeUrl(config, state) {
  setup(config);
  const url = new URL(`${AUTH}/authorization`);
  url.search = new URLSearchParams({ response_type: 'code', client_id: config.credentials.client_id,
    redirect_uri: config.credentials.redirect_uri, scope: 'openid profile', bail: '1', state }).toString();
  return url.toString();
}
async function request(config, route, params = {}, { post = false, xml = false, token = false } = {}) {
  setup(config);
  const c = config.credentials;
  const url = new URL(token ? `${AUTH}/token` : `${apiBase(config.provider, config.metadata)}/${route}`);
  const form = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
  if (!post) url.search = form.toString();
  if (!token) {
    const key = `${fingerprint(config)}:${route}`;
    const delay = (rate.get(key) || 0) - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    if (Date.now() < (rate.get(key) || 0)) fail('E_TOOL_CALL_RATE_LIMIT', 'Yahoo! Shopping permits one request per second to this API; try again shortly');
    if (!rate.has(key) && rate.size >= 1000) fail('E_TOOL_CALL_RATE_LIMIT', 'Too many active Yahoo! connections; restart the connector');
    rate.set(key, Date.now() + 1000);
  }
  const headers = { accept: token ? 'application/json' : 'application/xml',
    authorization: token ? `Basic ${Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64')}` : `Bearer ${c.access_token}`,
    ...(post ? { 'content-type': xml ? 'application/xml; charset=UTF-8' : 'application/x-www-form-urlencoded' } : {}) };
  if (xml && c.public_key) {
    headers['X-sws-signature'] = crypto.publicEncrypt({ key: crypto.createPublicKey({ key: Buffer.from(c.public_key, 'base64'), format: 'der', type: 'spki' }),
      padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(`${config.metadata.seller_id}:${Math.floor(Date.now() / 1000)}`)).toString('base64');
    headers['X-sws-signature-version'] = config.metadata.key_version;
  }
  const deadline = AbortSignal.timeout(60000);
  let response;
  try {
    response = await requestFetch(url.toString(), { method: post ? 'POST' : 'GET', headers, redirect: 'error', signal: deadline,
      ...(post ? { body: xml ? new XMLBuilder().build(params) : form.toString() } : {}) });
  } catch (error) { fail(requestFailureCode(error, deadline), 'Yahoo! Shopping request failed; inspect the shop before retrying an uncertain update'); }
  if (!response.ok || response.status === 207) fail(response.status === 207 ? 'E_TOOL_CALL_UPSTREAM' : httpFailureCode(response.status),
    `Yahoo! Shopping request failed (HTTP ${response.status}); check shop permission and order API IP registration`);
  let source;
  try { source = await readBody(response); } catch (error) {
    fail(error?.code === 'E_CONNECTOR_RESPONSE_TOO_LARGE' ? 'E_TOOL_CALL_UPSTREAM' : requestFailureCode(error, deadline),
      'Yahoo! Shopping response could not be read; inspect the shop before retrying an uncertain update');
  }
  let data;
  try {
    if (token) data = JSON.parse(source);
    else {
      // Merchant XML needs CDATA/entities, but never DTDs or external entities.
      if (/<!DOCTYPE|<!ENTITY/i.test(source) || XMLValidator.validate(source) !== true) throw new Error();
      data = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', parseTagValue: false,
        parseAttributeValue: false, ignoreDeclaration: true, maxNestedTags: 32 }).parse(source);
    }
  } catch { fail('E_TOOL_CALL_UPSTREAM', 'Yahoo! Shopping returned invalid data'); }
  if (!data || typeof data !== 'object' || data.error || data.Error || data.Result?.Status === 'NG' || data.ResultSet?.Error) fail(token ? 'E_TOOL_CALL_AUTH' : 'E_TOOL_CALL_UPSTREAM', 'Yahoo! Shopping rejected the request; check API permissions or reconnect');
  return { data, public_key_authorized: xml && c.public_key ? response.headers.get('X-SWS-Authorize-Status') === 'authorized' : false };
}
function tokens(config, data) {
  const refresh_token = data.refresh_token || config.credentials.refresh_token;
  if (!validSecret(data.access_token) || !validSecret(refresh_token) || !Number.isSafeInteger(data.expires_in)
    || data.expires_in <= 0 || data.expires_in > 86400) fail('E_TOOL_CALL_AUTH', 'Yahoo! Shopping returned incomplete authorization');
  const c = config.credentials;
  return { provider: 'yahoo_shopping', client_id: c.client_id, client_secret: c.client_secret,
    ...(c.public_key ? { public_key: c.public_key } : {}), redirect_uri: c.redirect_uri,
    access_token: data.access_token, refresh_token, expires_at: Date.now() + data.expires_in * 1000 };
}
const list = value => value === undefined || value === '' ? [] : Array.isArray(value) ? value : [value];
const integer = value => typeof value === 'string' && /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value));
async function shop(config) {
  const { data } = await request(config, 'getShopCategory', { seller_id: config.metadata.seller_id });
  if (!integer(data.ResultSet?.['@totalResultsAvailable'])) fail('E_TOOL_CALL_UPSTREAM', 'Yahoo! Shopping shop access was not verified');
  return { seller_id: config.metadata.seller_id, fingerprint: fingerprint(config) };
}
const ensureToken = credentialOperation(async config => {
  const read = () => { if (config.credentialFile) config.credentials = readCredentialFile(config.credentialFile, config.credentialKey); validateBinding(config); };
  read();
  if (config.credentials.expires_at > Date.now() + 60000) return;
  if (!config.credentialFile) fail('E_TOOL_CALL_AUTH', 'Yahoo! Shopping authorization expired; reconnect');
  let pending = refreshes.get(config.credentialFile);
  if (!pending) {
    pending = (async () => {
      const { data } = await request(config, '', { grant_type: 'refresh_token', refresh_token: config.credentials.refresh_token }, { token: true, post: true });
      const next = { ...tokens(config, data), identity: config.credentials.identity };
      await shop({ ...config, credentials: next });
      writeCredentialFile(config.credentialFile, config.credentialKey, next);
    })();
    refreshes.set(config.credentialFile, pending);
  }
  try { await pending; } finally { if (refreshes.get(config.credentialFile) === pending) refreshes.delete(config.credentialFile); }
  read();
});
const code = { type: 'string', minLength: 1, maxLength: 99, pattern: '^[A-Za-z0-9-]+$' };
const page = { start: { type: 'integer', minimum: 1, maximum: 1000000 }, limit: { type: 'integer', minimum: 1, maximum: 100 } };
const action = (risk, description, properties = {}, required = []) => ({ risk, description, input_schema: { type: 'object', properties, required, additionalProperties: false } });
function actionsFor() {
  return {
    'shop.get': action('R', 'Verify access to the configured Yahoo! Shopping seller account.'),
    'products.search': action('R', 'Read one page of registered products by item-code prefix or name, including stock.',
      { query: { type: 'string', minLength: 1, maxLength: 200 }, by: { type: 'string', enum: ['item_code', 'name'] }, ...page }, ['query']),
    'inventory.get': action('R', 'Read stock for one product or sub-code. Empty Quantity means unlimited stock, not zero.', { item_code: code, sub_code: code }, ['item_code']),
    'orders.list': action('R', 'Read one page of one Japan calendar day of orders without customer/payment details. Order API approval and registered outbound IP are required. Public-key authentication avoids the shorter 12-hour reauthorization period.',
      { day: { type: 'string', minLength: 8, maxLength: 8, pattern: '^20[0-9]{6}$' }, ...page }, ['day']),
    'inventory.set': action('H', 'Replace stock for one existing product/sub-code. Preserves overselling and stock-close settings. Never automatically retry an uncertain update.',
      { item_code: code, sub_code: code, quantity: { type: 'integer', minimum: 0, maximum: 999999999 } }, ['item_code', 'quantity']),
  };
}
const orderFields = ['OrderId', 'Version', 'OrderTime', 'OrderStatus', 'ShipStatus', 'TotalPrice'];
async function execute(config, name, parameters = {}) {
  validateBinding(config);
  const spec = actionsFor()[name];
  if (!spec) fail('E_BAD_INPUT', 'Unreviewed Yahoo! Shopping action');
  validate(parameters, spec.input_schema);
  const p = parameters;
  if (name === 'orders.list') {
    const iso = `${p.day.slice(0, 4)}-${p.day.slice(4, 6)}-${p.day.slice(6, 8)}`;
    const parsed = new Date(iso + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) fail('E_BAD_INPUT', 'Invalid Yahoo! Shopping calendar date');
  }
  await ensureToken(config);
  if (name === 'shop.get') return shop(config);
  const seller_id = config.metadata.seller_id;
  const item_code = p.sub_code ? `${p.item_code}:${p.sub_code}` : p.item_code;
  let data;
  if (name === 'orders.list') {
    const result = await request(config, 'orderList', { Req: { Search: { Result: p.limit || 50, Start: p.start || 1, Sort: '+order_time',
      Condition: { OrderTimeFrom: `${p.day}000000`, OrderTimeTo: `${p.day}235959` }, Field: orderFields.join(',') }, SellerId: seller_id } }, { post: true, xml: true });
    const root = result.data.Result;
    if (root?.Status !== 'OK' || !integer(root.Search?.TotalCount)) fail('E_TOOL_CALL_UPSTREAM', 'Yahoo! Shopping order pagination is missing');
    const rows = list(root.Search.OrderInfo);
    if (rows.some(row => row.SellerId && row.SellerId !== seller_id)) fail('E_TOOL_CALL_AUTH', 'Yahoo! Shopping returned another seller; reconnect');
    data = { total: Number(root.Search.TotalCount), start: p.start || 1, limit: p.limit || 50,
      orders: rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => orderFields.includes(key)))),
      public_key_authorized: result.public_key_authorized };
  } else {
    const result = name === 'products.search'
      ? await request(config, 'myItemList', { seller_id, query: p.query, type: p.by || 'item_code', stock: 'true', start: p.start || 1, results: p.limit || 25 })
      : await request(config, 'getStock', { seller_id, item_code }, { post: true });
    const root = result.data.ResultSet;
    if (!integer(root?.['@totalResultsAvailable']) || !integer(root?.['@totalResultsReturned'])) fail('E_TOOL_CALL_UPSTREAM', 'Yahoo! Shopping pagination is missing');
    const rows = list(root.Result);
    if (rows.length !== Number(root['@totalResultsReturned'])) fail('E_TOOL_CALL_UPSTREAM', 'Yahoo! Shopping returned incomplete results');
    if (name === 'inventory.set') {
      const current = rows.find(row => row.ItemCode === p.item_code && (row.SubCode || '') === (p.sub_code || ''));
      if (rows.length !== 1 || current?.Status !== '1' || !['0', '1'].includes(current.AllowOverdraft)) fail('E_BAD_INPUT', 'Select an existing Yahoo! inventory record before updating stock');
      const updated = await request(config, 'setStock', { seller_id, item_code, quantity: p.quantity, allow_overdraft: current.AllowOverdraft }, { post: true });
      const acknowledged = list(updated.data.ResultSet?.Result);
      if (acknowledged.length !== 1 || acknowledged[0].ErrorCode || acknowledged[0].ItemCode !== p.item_code
        || (acknowledged[0].SubCode || '') !== (p.sub_code || '') || acknowledged[0].Quantity !== String(p.quantity)) fail('E_TOOL_CALL_UPSTREAM', 'Yahoo! Shopping did not confirm the stock update; inspect the shop before retrying');
      return { status: 'completed' };
    }
    data = { total: Number(root['@totalResultsAvailable']), returned: rows.length, results: rows };
  }
  for (const key of ['client_id', 'client_secret', 'access_token', 'refresh_token', 'public_key']) data = safeOutput(data, config.credentials[key]);
  return { data };
}
async function identity(config) { await ensureToken(config); return shop(config); }
async function authorize(config) {
  setup(config);
  if (!validSecret(config.oauthCode)) fail('E_TOOL_CALL_AUTH', 'Complete Yahoo! Shopping authorization in the browser');
  const { data } = await request(config, '', { grant_type: 'authorization_code', code: config.oauthCode, redirect_uri: config.credentials.redirect_uri }, { token: true, post: true });
  const credentials = tokens(config, data);
  credentials.identity = await shop({ ...config, credentials });
  return credentials;
}
module.exports = { isProvider, normalizePublicKey, apiBase, validateBinding, actionsFor, identity, execute, authorize, authorizeUrl };
