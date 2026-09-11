#!/usr/bin/env node
'use strict';

// Only spawned CLI sessions install the child proxy; main retains its own fetch owner.
if (require.main === module) require('./proxy-bootstrap.cjs');
const crypto = require('node:crypto');
const readline = require('node:readline/promises');
const { writeCredentialFile } = require('./local-api-credential-codec.cjs');

const CONSTANT_CONTACT_DEVICE_URL = 'https://authz.constantcontact.com/oauth2/default/v1/device/authorize';
const CONSTANT_CONTACT_TOKEN_URL = 'https://authz.constantcontact.com/oauth2/default/v1/token';
const CONSTANT_CONTACT_ACCOUNT_URL = 'https://api.cc.email/v3/account/summary';
const CONSTANT_CONTACT_SCOPES = 'account_read contact_data campaign_data offline_access';
const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
];
const ETSY_SCOPES = [
  'shops_r', 'shops_w', 'listings_r', 'listings_w', 'listings_d',
  'transactions_r', 'transactions_w',
];
const MERCADO_LIBRE_SCOPES = ['offline_access', 'read', 'write'];
const TAOBAO_AUTHORIZE_URL = 'https://oauth.taobao.com/authorize';
const TAOBAO_TOKEN_URL = 'https://oauth.taobao.com/token';
const TAOBAO_API_URL = 'https://gw.api.taobao.com/router/rest';
const ALIBABA_1688_AUTHORIZE_URL = 'https://auth.1688.com/oauth/authorize';
const ALIBABA_1688_TOKEN_BASE = 'https://gw.open.1688.com/openapi/http/1/system.oauth2/getToken';
const JD_AUTHORIZE_URL = 'https://open-oauth.jd.com/oauth2/to_login';
const JD_TOKEN_URL = 'https://open-oauth.jd.com/oauth2/access_token';
const JD_API_URL = 'https://api.jd.com/routerjson';
const PINDUODUO_AUTHORIZE_URL = 'https://fuwu.pinduoduo.com/service-market/auth';
const PINDUODUO_API_URL = 'https://gw-api.pinduoduo.com/api/router';
const DOUYIN_API_BASE = 'https://openapi-fxg.jinritemai.com';
const KUAISHOU_AUTHORIZE_URL = 'https://open.kwaixiaodian.com/oauth/authorize';
const KUAISHOU_TOKEN_URL = 'https://openapi.kwaixiaodian.com/oauth2/access_token';
const KUAISHOU_API_BASE = 'https://openapi.kwaixiaodian.com';
const YOUZAN_TOKEN_URL = 'https://open.youzanyun.com/auth/token';
const YOUZAN_API_BASE = 'https://open.youzanyun.com/api';
const WEIMOB_TOKEN_URL = 'https://dopen.weimob.com/fuwu/b/oauth2/token';
const WEIMOB_API_BASE = 'https://dopen.weimob.com/apigw';
const XIAOHONGSHU_ARK_API_BASE = 'https://ark.xiaohongshu.com';
const KUAISHOU_SCOPES = [
  'user_base', 'user_info', 'merchant_user', 'merchant_item',
  'merchant_order', 'merchant_refund', 'merchant_logistics',
];

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function readJson(response, label) {
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${label} returned an invalid response`); }
  if (!response.ok) throw new Error(`${label} failed (HTTP ${response.status})`);
  return body;
}

async function postForm(url, params, headers = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
    body: new URLSearchParams(params).toString(),
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
}

function authEnvironment() {
  const provider = String(process.env.ORKAS_LOCAL_API_PROVIDER || '');
  const credentialFile = String(process.env.ORKAS_LOCAL_API_CREDENTIAL_FILE || '');
  const key = String(process.env.ORKAS_LOCAL_API_CREDENTIAL_KEY || '');
  let input = { metadata: {}, credentials: {} };
  try {
    const parsed = JSON.parse(process.env.ORKAS_LOCAL_API_AUTH_INPUT_JSON || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !parsed.metadata || typeof parsed.metadata !== 'object' || Array.isArray(parsed.metadata)
        || !parsed.credentials || typeof parsed.credentials !== 'object' || Array.isArray(parsed.credentials)) {
      throw new Error('invalid local API authorization input');
    }
    input = parsed;
  } catch { throw new Error('invalid local API authorization input'); }
  if (!credentialFile || !key) throw new Error('incomplete local API authorization environment');
  return { provider, credentialFile, key, metadata: input.metadata || {}, credentials: input.credentials || {} };
}

function parseCallback(value, expectedState, expectedRedirect) {
  let callback;
  try { callback = new URL(String(value || '').trim()); } catch { throw new Error('invalid OAuth callback URL'); }
  let registered;
  try { registered = expectedRedirect ? new URL(expectedRedirect) : null; } catch { throw new Error('invalid OAuth redirect URI'); }
  const loopbackHttp = callback.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname)
    && registered?.protocol === 'http:'
    && callback.origin === registered.origin;
  if ((!loopbackHttp && callback.protocol !== 'https:') || callback.username || callback.password
      || callback.hash || callback.toString().length > 4096) {
    throw new Error('invalid OAuth callback URL');
  }
  if (expectedRedirect) {
    if (callback.origin !== registered.origin || callback.pathname !== registered.pathname) {
      throw new Error('OAuth callback does not match the registered redirect URI');
    }
  }
  if (callback.searchParams.get('state') !== expectedState) throw new Error('OAuth callback state mismatch');
  const providerError = callback.searchParams.get('error_description') || callback.searchParams.get('error');
  if (providerError) throw new Error(`OAuth authorization was denied: ${providerError.slice(0, 160)}`);
  const code = callback.searchParams.get('code');
  if (!code || code.length > 4096) throw new Error('OAuth callback contains no authorization code');
  return code;
}

function chinaTimestamp(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

function signTaobao(parameters, appSecret) {
  const message = Object.keys(parameters).sort().map((key) => `${key}${parameters[key]}`).join('');
  return crypto.createHmac('sha256', appSecret).update(message, 'utf8').digest('hex').toUpperCase();
}

async function taobaoApi(appKey, appSecret, session, method, parameters = {}) {
  const form = {
    method, app_key: appKey, session, timestamp: chinaTimestamp(), v: '2.0',
    sign_method: 'hmac-sha256', format: 'json', simplify: 'true', ...parameters,
  };
  form.sign = signTaobao(form, appSecret);
  return readJson(await postForm(TAOBAO_API_URL, form), 'Taobao seller verification');
}

function encode1688Parameter(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function sign1688(pathName, parameters, appSecret) {
  const message = pathName + Object.keys(parameters).sort()
    .map((key) => `${key}${encode1688Parameter(parameters[key])}`).join('');
  return crypto.createHmac('sha1', appSecret).update(message, 'utf8').digest('hex').toUpperCase();
}

async function alibaba1688Api(appKey, appSecret, accessToken, namespace, name, parameters = {}) {
  const pathName = `param2/1/${namespace}/${name}/${appKey}`;
  const form = { ...parameters, access_token: accessToken, _aop_timestamp: String(Date.now()) };
  form._aop_signature = sign1688(pathName, form, appSecret);
  const result = await readJson(await postForm(`https://gw.open.1688.com/openapi/${pathName}`, Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, encode1688Parameter(value)]),
  )), '1688 seller verification');
  if (result.success === false) throw new Error(`1688 seller verification failed: ${String(result.errorMessage || result.errorCode || 'unknown error').slice(0, 160)}`);
  return result;
}

function encodeJdParameter(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function signJd(parameters, appSecret) {
  const message = appSecret + Object.keys(parameters).sort()
    .map((key) => `${key}${encodeJdParameter(parameters[key])}`).join('') + appSecret;
  return crypto.createHash('md5').update(message, 'utf8').digest('hex').toUpperCase();
}

async function jdApi(appKey, appSecret, accessToken, method, parameters = {}) {
  const form = {
    method, access_token: accessToken, app_key: appKey, timestamp: chinaTimestamp(),
    '360buy_param_json': JSON.stringify(parameters), v: '2.0',
  };
  form.sign = signJd(form, appSecret);
  const result = await readJson(await postForm(JD_API_URL, form), 'JD.com seller verification');
  if (result.error_response) {
    throw new Error(`JD.com seller verification failed: ${String(result.error_response.code || 'provider error').slice(0, 80)}`);
  }
  return result;
}

function jdIdentity(result) {
  const wrapper = result?.jingdong_seller_vender_info_get_responce
    || result?.jingdong_seller_vender_info_get_response
    || result?.seller_vender_info_get_response
    || result;
  return wrapper?.vender_info_result?.data || wrapper?.vender_info_result || wrapper?.result || {};
}

function encodePinduoduoParameter(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function signPinduoduo(parameters, clientSecret) {
  const message = clientSecret + Object.keys(parameters).sort()
    .map((key) => `${key}${encodePinduoduoParameter(parameters[key])}`).join('') + clientSecret;
  return crypto.createHash('md5').update(message, 'utf8').digest('hex').toUpperCase();
}

async function pinduoduoApi(clientId, clientSecret, accessToken, type, parameters = {}) {
  const form = {
    type, client_id: clientId, timestamp: String(Math.floor(Date.now() / 1000)),
    data_type: 'JSON', ...(accessToken ? { access_token: accessToken } : {}), ...parameters,
  };
  form.sign = signPinduoduo(form, clientSecret);
  const result = await readJson(await postForm(PINDUODUO_API_URL, Object.fromEntries(
    Object.entries(form).map(([key, value]) => [key, encodePinduoduoParameter(value)]),
  )), 'Pinduoduo seller verification');
  if (result.error_response) {
    throw new Error(`Pinduoduo seller verification failed: ${String(result.error_response.error_code || 'provider error').slice(0, 80)}`);
  }
  return result;
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function signDouyin(appKey, method, paramJson, timestamp, appSecret) {
  const message = `app_key${appKey}method${method}param_json${paramJson}timestamp${timestamp}v2`;
  return crypto.createHmac('sha256', appSecret)
    .update(`${appSecret}${message}${appSecret}`, 'utf8').digest('hex');
}

async function douyinApi(appKey, appSecret, accessToken, pathName, method, parameters = {}, label = 'Douyin Shop seller verification') {
  const timestamp = chinaTimestamp();
  const paramJson = stableJson(parameters);
  const query = {
    app_key: appKey, method, param_json: paramJson, timestamp, v: '2',
    sign_method: 'hmac-sha256',
    sign: signDouyin(appKey, method, paramJson, timestamp, appSecret),
    ...(accessToken ? { access_token: accessToken } : {}),
  };
  const response = await fetch(`${DOUYIN_API_BASE}${pathName}?${new URLSearchParams(query)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: paramJson,
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  });
  const result = await readJson(response, label);
  if (result.code !== undefined && Number(result.code) !== 10000) {
    throw new Error(`${label} failed: ${String(result.message || result.msg || result.code || 'provider error').slice(0, 160)}`);
  }
  return result.data || result;
}

function signKuaishou(parameters, signSecret) {
  const message = Object.keys(parameters).sort()
    .map((key) => `${key}=${parameters[key]}`).join('&') + `&signSecret=${signSecret}`;
  return crypto.createHmac('sha256', signSecret).update(message, 'utf8').digest('hex');
}

async function kuaishouApi(appKey, signSecret, accessToken, method, parameters = {}, httpMethod = 'GET') {
  const common = {
    appkey: appKey, method, version: '1', param: stableJson(parameters),
    access_token: accessToken, timestamp: String(Date.now()), signMethod: 'HMAC_SHA256',
  };
  common.sign = signKuaishou(common, signSecret);
  const pathName = `/${method.split('.').join('/')}`;
  const options = {
    method: httpMethod,
    headers: { accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  };
  let url = `${KUAISHOU_API_BASE}${pathName}`;
  if (httpMethod === 'GET') url += `?${new URLSearchParams(common)}`;
  else {
    options.headers['content-type'] = 'application/x-www-form-urlencoded';
    options.body = new URLSearchParams(common).toString();
  }
  const result = await readJson(await fetch(url, options), 'Kuaishou Shop seller verification');
  if (result.result !== undefined && Number(result.result) !== 1 && String(result.result).toLowerCase() !== 'success') {
    throw new Error(`Kuaishou Shop seller verification failed: ${String(result.error_msg || result.msg || result.error || result.result).slice(0, 160)}`);
  }
  return result.data || result;
}

function expiryMs(value, fallbackSeconds) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now() + fallbackSeconds * 1000;
  return numeric >= 1_000_000_000 ? numeric * 1000 : Date.now() + numeric * 1000;
}

function absoluteOrRelativeExpiryMs(value, fallbackSeconds) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return Date.now() + fallbackSeconds * 1000;
  if (numeric >= 1_000_000_000_000) return numeric;
  if (numeric >= 1_000_000_000) return numeric * 1000;
  return Date.now() + numeric * 1000;
}

async function youzanAuthToken(clientId, clientSecret, kdtId, refresh = false) {
  const result = await readJson(await fetch(YOUZAN_TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_id: clientId, client_secret: clientSecret, authorize_type: 'silent',
      grant_id: kdtId, refresh: Boolean(refresh),
    }),
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  }), 'Youzan token');
  const token = result.data || result;
  if (!token.access_token || String(token.authority_id || '') !== String(kdtId)) {
    throw new Error('Youzan token returned incomplete credentials or a different shop');
  }
  return token;
}

async function youzanAuthApi(accessToken, method, version, parameters = {}) {
  const url = new URL(`${YOUZAN_API_BASE}/${method}/${version}`);
  url.searchParams.set('access_token', accessToken);
  const result = await readJson(await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(parameters), redirect: 'error', signal: AbortSignal.timeout(60_000),
  }), 'Youzan seller verification');
  if (result.success === false || (result.code !== undefined && Number(result.code) !== 200)) {
    throw new Error(`Youzan seller verification failed: ${String(result.message || result.code || 'provider error').slice(0, 160)}`);
  }
  return result.data || result;
}

async function weimobAuthToken(clientId, clientSecret, shopId) {
  const url = new URL(WEIMOB_TOKEN_URL);
  url.search = new URLSearchParams({
    grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret,
    shop_id: shopId, shop_type: 'business_operation_system_id',
  }).toString();
  const result = await readJson(await fetch(url, {
    method: 'POST', headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(60_000),
  }), 'Weimob WOS token');
  const token = result.data || result;
  if (!token.access_token || String(token.business_operation_system_id || '') !== String(shopId)) {
    throw new Error('Weimob WOS token returned incomplete credentials or a different shop');
  }
  return token;
}

async function weimobAuthApi(accessToken, pathName, parameters = {}) {
  const url = new URL(`${WEIMOB_API_BASE}/${pathName}`);
  url.searchParams.set('accesstoken', accessToken);
  const result = await readJson(await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(parameters), redirect: 'error', signal: AbortSignal.timeout(60_000),
  }), 'Weimob WOS seller verification');
  const providerCode = result?.code?.errcode ?? result?.errcode;
  if (providerCode !== undefined && String(providerCode) !== '0') {
    throw new Error(`Weimob WOS seller verification failed: ${String(result?.code?.errmsg || providerCode).slice(0, 160)}`);
  }
  return result.data || result;
}

function signXiaohongshu(pathName, query, appKey, timestamp, appSecret) {
  const parameters = { 'app-key': appKey, ...query, timestamp: String(timestamp) };
  const parameterString = Object.keys(parameters).sort()
    .map((key) => `${key}=${parameters[key]}`).join('&');
  return crypto.createHash('md5').update(`${pathName}?${parameterString}${appSecret}`, 'utf8').digest('hex');
}

async function xiaohongshuAuthApi(appKey, appSecret) {
  const pathName = '/ark/open_api/v1/items/lite';
  const query = { page_no: '1', page_size: '1' };
  const timestamp = String(Math.floor(Date.now() / 1000));
  const url = new URL(`${XIAOHONGSHU_ARK_API_BASE}${pathName}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const result = await readJson(await fetch(url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(60_000),
    headers: {
      accept: 'application/json', 'content-type': 'application/json;charset=utf-8',
      timestamp, 'app-key': appKey,
      sign: signXiaohongshu(pathName, query, appKey, timestamp, appSecret),
    },
  }), 'Xiaohongshu Ark seller verification');
  if (result.success === false || (result.error_code !== undefined && Number(result.error_code) !== 0)) {
    throw new Error(`Xiaohongshu Ark seller verification failed: ${String(result.error_code || 'provider error').slice(0, 80)}`);
  }
  return result.data || result;
}

async function pastedCallback(authorizeUrl) {
  process.stdout.write(`[Orkas] Open this official authorization page in your browser:\n${authorizeUrl}\n`);
  process.stdout.write('[Orkas] After approving access, copy the full final redirect URL from the browser address bar.\n');
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { return await terminal.question('[Orkas] Paste the full redirect URL containing the authorization code here: '); } finally { terminal.close(); }
}

function missingScopes(grantedText, required) {
  if (!grantedText) return [];
  const granted = new Set(String(grantedText).split(/[ ,]+/).filter(Boolean));
  return required.filter((scope) => !granted.has(scope));
}

const BROWSER_OAUTH_PROVIDERS = new Set(['ebay', 'etsy', 'mercado_libre', 'taobao_top', 'alibaba_1688', 'jd_jos', 'pinduoduo', 'kuaishou_shop', 'lazada', 'shein', 'alibaba_icbu', 'aliexpress']);
const SELF_AUTH_PROVIDERS = new Set(['douyin_shop', 'youzan', 'weimob_wos', 'xiaohongshu_ark', 'bigcommerce', 'shopline', 'shoplazza', 'magento', 'temu']);

// One URL builder serves the desktop relay and the legacy CLI fallback.
function authorizationRequest(env, state, verifier) {
  if (['lazada', 'shein', 'alibaba_icbu', 'aliexpress'].includes(env.provider)) return require('./merchant-platform-api.cjs').authorizeUrl(env, state);
  const c = env.credentials;
  const redirect_uri = c.redirect_uri;
  let base;
  let query;
  const pkce = { code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
  if (env.provider === 'ebay') {
    base = env.metadata.environment === 'sandbox' ? 'https://auth.sandbox.ebay.com/oauth2/authorize' : 'https://auth.ebay.com/oauth2/authorize';
    query = { client_id: c.client_id, redirect_uri: c.ru_name, response_type: 'code', scope: EBAY_SCOPES.join(' ') };
  } else if (env.provider === 'etsy') {
    base = 'https://www.etsy.com/oauth/connect';
    query = { client_id: c.keystring, redirect_uri, response_type: 'code', scope: ETSY_SCOPES.join(' '), ...pkce };
  } else if (env.provider === 'mercado_libre') {
    base = 'https://global-selling.mercadolibre.com/authorization';
    query = { client_id: c.client_id, redirect_uri, response_type: 'code', ...pkce };
  } else if (env.provider === 'taobao_top') {
    base = TAOBAO_AUTHORIZE_URL;
    query = { client_id: c.app_key, redirect_uri, response_type: 'code' };
  } else if (env.provider === 'alibaba_1688') {
    base = ALIBABA_1688_AUTHORIZE_URL;
    query = { client_id: c.app_key, redirect_uri, site: '1688' };
  } else if (env.provider === 'jd_jos') {
    base = JD_AUTHORIZE_URL;
    query = { app_key: c.app_key, redirect_uri, response_type: 'code' };
  } else if (env.provider === 'pinduoduo') {
    base = PINDUODUO_AUTHORIZE_URL;
    query = { client_id: c.client_id, redirect_uri, response_type: 'code' };
  } else if (env.provider === 'kuaishou_shop') {
    base = KUAISHOU_AUTHORIZE_URL;
    query = { app_id: c.app_key, redirect_uri, scope: KUAISHOU_SCOPES.join(','), response_type: 'code' };
  } else throw new Error('Unsupported browser authorization provider');
  const url = new URL(base);
  url.search = new URLSearchParams({ ...query, state }).toString();
  return url.toString();
}

async function authorizationCode(env) {
  if (env.oauthCode !== undefined) return { code: env.oauthCode, verifier: env.codeVerifier };
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(64).toString('base64url');
  const url = authorizationRequest(env, state, verifier);
  return { code: parseCallback(await pastedCallback(url), state, env.credentials.redirect_uri), verifier };
}

function createBrowserAuthorization(env, state, redirectUri) {
  if (!BROWSER_OAUTH_PROVIDERS.has(env.provider)) throw new Error('Unsupported browser authorization provider');
  const prepared = { ...env, credentials: { ...env.credentials, redirect_uri: redirectUri } };
  const verifier = crypto.randomBytes(64).toString('base64url');
  return {
    url: authorizationRequest(prepared, state, verifier),
    complete: (code) => {
      if (typeof code !== 'string' || !code || code.length > 4096) throw new Error('Invalid authorization code');
      return authorizeConfigured({ ...prepared, oauthCode: code, codeVerifier: verifier });
    },
  };
}

function constantContactVerificationUrl(device) {
  const code = typeof device.user_code === 'string' ? device.user_code : '';
  if (!device.device_code || !/^[A-Za-z0-9-]{1,128}$/.test(code)) {
    throw new Error('Constant Contact returned an invalid device authorization response');
  }
  let url;
  try { url = new URL(String(device.verification_uri_complete || device.verification_uri || '')); }
  catch { throw new Error('Constant Contact returned an invalid device authorization response'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || !['identity.constantcontact.com', 'authz.constantcontact.com'].includes(url.hostname)
    || url.pathname !== '/activate' || url.searchParams.getAll('user_code').length > 1
    || (url.searchParams.has('user_code') && url.searchParams.get('user_code') !== code)) {
    throw new Error('Constant Contact returned an invalid device authorization response');
  }
  // Carry the user code into the official page even when the provider returns only the base URI.
  url.searchParams.set('user_code', code);
  return url.toString();
}

async function authorizeConstantContact(env) {
  const clientId = String(env.credentials.client_id || process.env.ORKAS_LOCAL_API_CLIENT_ID || '').trim();
  if (!clientId) throw new Error('incomplete Constant Contact authorization environment');
  const device = await readJson(await postForm(CONSTANT_CONTACT_DEVICE_URL, {
    client_id: clientId, scope: CONSTANT_CONTACT_SCOPES,
  }), 'Constant Contact device authorization');
  const verification = constantContactVerificationUrl(device);
  process.stdout.write(`[Orkas] ${process.env.ORKAS_DEVICE_AUTH_OPEN_PAGE || 'Open this official Constant Contact page:'} ${verification}\n`);
  process.stdout.write(`[Orkas] ${process.env.ORKAS_DEVICE_AUTH_CODE || 'Verification code:'} ${String(device.user_code)}\n`);
  process.stdout.write(`[Orkas] ${process.env.ORKAS_DEVICE_AUTH_WAITING || 'Waiting for authorization…'}\n`);

  const deadline = Date.now() + Math.min(Number(device.expires_in || 600), 1800) * 1000;
  let intervalMs = Math.max(5, Number(device.interval || 5)) * 1000;
  let token;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const response = await postForm(CONSTANT_CONTACT_TOKEN_URL, {
      client_id: clientId, device_code: String(device.device_code),
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (response.ok && body.access_token && body.refresh_token) { token = body; break; }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') { intervalMs += 5_000; continue; }
    if (body.error === 'access_denied') throw new Error('Constant Contact authorization was denied');
    if (body.error === 'expired_token') break;
    throw new Error(`Constant Contact token request failed: ${String(body.error_description || body.error || response.status).slice(0, 240)}`);
  }
  if (!token) throw new Error('Constant Contact device authorization expired');
  const missing = missingScopes(token.scope || CONSTANT_CONTACT_SCOPES, CONSTANT_CONTACT_SCOPES.split(' '));
  if (missing.length) throw new Error(`Constant Contact authorization is missing required scopes: ${missing.join(', ')}`);
  const identity = await readJson(await fetch(CONSTANT_CONTACT_ACCOUNT_URL, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  }), 'Constant Contact account verification');
  if (!identity.encoded_account_id) throw new Error('Constant Contact account verification returned no account identity');
  return {
    provider: 'constant_contact', client_id: clientId,
    access_token: token.access_token, refresh_token: token.refresh_token,
    token_type: token.token_type || 'Bearer', scope: token.scope || CONSTANT_CONTACT_SCOPES,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 86400)) * 1000,
    identity: { account_id: identity.encoded_account_id, name: identity.organization_name || `${identity.first_name || ''} ${identity.last_name || ''}`.trim(), email: identity.contact_email || '' },
  };
}

async function authorizeEbay(env) {
  const {
    client_id: clientId, client_secret: clientSecret, ru_name: ruName,
    redirect_uri: redirectUri,
  } = env.credentials;
  const environment = String(env.metadata.environment || '');
  const marketplaceId = String(env.metadata.marketplace_id || '');
  if (!clientId || !clientSecret || !ruName || !redirectUri
      || !['sandbox', 'live'].includes(environment) || !marketplaceId) {
    throw new Error('incomplete eBay authorization input');
  }
  const apiBase = environment === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com';
  const { code } = await authorizationCode(env);
  const token = await readJson(await postForm(`${apiBase}/identity/v1/oauth2/token`, {
    grant_type: 'authorization_code', code, redirect_uri: ruName,
  }, { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`, 'utf8').toString('base64')}` }), 'eBay token exchange');
  if (!token.access_token || !token.refresh_token) throw new Error('eBay token exchange returned incomplete credentials');
  const missing = missingScopes(token.scope, EBAY_SCOPES);
  if (missing.length) throw new Error(`eBay authorization is missing required scopes: ${missing.join(', ')}`);
  const privilege = await readJson(await fetch(`${apiBase}/sell/account/v1/privilege`, {
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json', 'X-EBAY-C-MARKETPLACE-ID': marketplaceId },
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  }), 'eBay seller verification');
  return {
    provider: 'ebay', client_id: clientId, client_secret: clientSecret,
    ru_name: ruName, redirect_uri: redirectUri,
    access_token: token.access_token, refresh_token: token.refresh_token,
    token_type: token.token_type || 'Bearer', scope: token.scope || EBAY_SCOPES.join(' '),
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 7200)) * 1000,
    refresh_expires_at: Date.now() + Math.max(60, Number(token.refresh_token_expires_in || 47_304_000)) * 1000,
    identity: {
      environment, marketplace_id: marketplaceId,
      content_language: env.metadata.content_language,
      selling_limit: privilege.sellingLimit || null,
    },
  };
}

async function authorizeEtsy(env) {
  const { keystring, shared_secret: sharedSecret, redirect_uri: redirectUri } = env.credentials;
  const shopId = String(env.metadata.shop_id || '');
  if (!keystring || !sharedSecret || !redirectUri || !shopId) throw new Error('incomplete Etsy authorization input');
  const { code, verifier } = await authorizationCode(env);
  const token = await readJson(await postForm('https://api.etsy.com/v3/public/oauth/token', {
    grant_type: 'authorization_code', client_id: keystring, redirect_uri: redirectUri, code, code_verifier: verifier,
  }), 'Etsy token exchange');
  if (!token.access_token || !token.refresh_token) throw new Error('Etsy token exchange returned incomplete credentials');
  const missing = missingScopes(token.scope, ETSY_SCOPES);
  if (missing.length) throw new Error(`Etsy authorization is missing required scopes: ${missing.join(', ')}`);
  const identity = await readJson(await fetch(`https://openapi.etsy.com/v3/application/shops/${encodeURIComponent(shopId)}`, {
    headers: { authorization: `Bearer ${token.access_token}`, 'x-api-key': `${keystring}:${sharedSecret}`, accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  }), 'Etsy shop verification');
  if (String(identity.shop_id || '') !== shopId) throw new Error('Etsy authorization returned a different shop');
  const userId = String(token.access_token).split('.', 1)[0];
  if (!/^[1-9][0-9]*$/.test(userId) || (identity.user_id && String(identity.user_id) !== userId)) {
    throw new Error('Etsy shop is not owned by the authorizing user');
  }
  return {
    provider: 'etsy', keystring, shared_secret: sharedSecret,
    access_token: token.access_token, refresh_token: token.refresh_token,
    token_type: token.token_type || 'Bearer', scope: token.scope || ETSY_SCOPES.join(' '),
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000,
    identity: { shop_id: shopId, shop_name: identity.shop_name || '', user_id: userId },
  };
}

async function authorizeMercadoLibre(env) {
  const { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri } = env.credentials;
  const userId = String(env.metadata.user_id || '');
  if (!clientId || !clientSecret || !redirectUri || !/^[1-9][0-9]{0,18}$/.test(userId)) {
    throw new Error('incomplete Mercado Libre authorization input');
  }
  const { code, verifier } = await authorizationCode(env);
  const token = await readJson(await postForm('https://api.mercadolibre.com/oauth/token', {
    grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret,
    code, redirect_uri: redirectUri, code_verifier: verifier,
  }), 'Mercado Libre token exchange');
  if (!token.access_token || !token.refresh_token || !token.user_id) {
    throw new Error('Mercado Libre token exchange returned incomplete credentials');
  }
  if (String(token.user_id) !== userId) throw new Error('Mercado Libre authorization returned a different seller');
  const missing = missingScopes(token.scope, MERCADO_LIBRE_SCOPES);
  if (missing.length) throw new Error(`Mercado Libre authorization is missing required scopes: ${missing.join(', ')}`);
  const identity = await readJson(await fetch('https://api.mercadolibre.com/users/me', {
    headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(60_000),
  }), 'Mercado Libre seller verification');
  if (String(identity.id || '') !== userId) throw new Error('Mercado Libre authorization returned a different seller');
  return {
    provider: 'mercado_libre', client_id: clientId, client_secret: clientSecret,
    redirect_uri: redirectUri, access_token: token.access_token, refresh_token: token.refresh_token,
    token_type: token.token_type || 'Bearer', scope: token.scope || MERCADO_LIBRE_SCOPES.join(' '),
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 21_600)) * 1000,
    identity: { user_id: userId, nickname: identity.nickname || '', site_id: identity.site_id || '' },
  };
}

async function authorizeTaobao(env) {
  const { app_key: appKey, app_secret: appSecret, redirect_uri: redirectUri } = env.credentials;
  if (!appKey || !appSecret || !redirectUri) throw new Error('incomplete Taobao authorization input');
  const { code } = await authorizationCode(env);
  const token = await readJson(await postForm(TAOBAO_TOKEN_URL, {
    grant_type: 'authorization_code', code, client_id: appKey,
    client_secret: appSecret, redirect_uri: redirectUri,
  }), 'Taobao token exchange');
  if (!token.access_token || !token.taobao_user_id) {
    throw new Error('Taobao token exchange returned incomplete credentials');
  }
  const response = await taobaoApi(appKey, appSecret, token.access_token, 'taobao.user.seller.get', {
    fields: 'user_id,nick,type,has_shop',
  });
  const identity = response.user_seller_get_response?.user || response.user || {};
  if (!identity.nick || String(identity.user_id || '') !== String(token.taobao_user_id)) {
    throw new Error('Taobao authorization returned a different seller');
  }
  return {
    provider: 'taobao_top', app_key: appKey, app_secret: appSecret, redirect_uri: redirectUri,
    access_token: token.access_token, refresh_token: token.refresh_token || '',
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 86_400)) * 1000,
    refresh_expires_at: token.re_expires_in
      ? Date.now() + Math.max(60, Number(token.re_expires_in)) * 1000 : 0,
    identity: {
      user_id: String(token.taobao_user_id), open_uid: String(token.taobao_open_uid || ''),
      nick: String(identity.nick), seller_type: String(identity.type || ''),
    },
  };
}

async function authorizeAlibaba1688(env) {
  const { app_key: appKey, app_secret: appSecret, redirect_uri: redirectUri } = env.credentials;
  if (!appKey || !appSecret || !redirectUri) throw new Error('incomplete 1688 authorization input');
  const { code } = await authorizationCode(env);
  const tokenUrl = `${ALIBABA_1688_TOKEN_BASE}/${encodeURIComponent(appKey)}`;
  const token = await readJson(await postForm(tokenUrl, {
    grant_type: 'authorization_code', need_refresh_token: 'true', client_id: appKey,
    client_secret: appSecret, redirect_uri: redirectUri, code,
  }), '1688 token exchange');
  if (!token.access_token || !token.refresh_token || !token.memberId) {
    throw new Error('1688 token exchange returned incomplete credentials');
  }
  const response = await alibaba1688Api(
    appKey, appSecret, token.access_token, 'com.alibaba.account', 'alibaba.account.basic',
  );
  const identity = response.result || {};
  if (String(identity.memberId || '') !== String(token.memberId)) {
    throw new Error('1688 authorization returned a different seller');
  }
  return {
    provider: 'alibaba_1688', app_key: appKey, app_secret: appSecret, redirect_uri: redirectUri,
    access_token: token.access_token, refresh_token: token.refresh_token,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 36_000)) * 1000,
    refresh_token_timeout: String(token.refresh_token_timeout || ''),
    identity: {
      member_id: String(token.memberId), ali_id: String(token.aliId || ''),
      login_id: String(identity.loginId || token.resource_owner || ''),
      supplier_name: String(identity.supplierName || identity.companyName || ''),
    },
  };
}

async function authorizeJd(env) {
  const { app_key: appKey, app_secret: appSecret, redirect_uri: redirectUri } = env.credentials;
  if (!appKey || !appSecret || !redirectUri) throw new Error('incomplete JD.com authorization input');
  const { code } = await authorizationCode(env);
  const token = await readJson(await postForm(JD_TOKEN_URL, {
    grant_type: 'authorization_code', code, app_key: appKey,
    app_secret: appSecret, redirect_uri: redirectUri,
  }), 'JD.com token exchange');
  if (!token.access_token || !token.refresh_token) {
    throw new Error('JD.com token exchange returned incomplete credentials');
  }
  const response = await jdApi(appKey, appSecret, token.access_token, 'jingdong.seller.vender.info.get');
  const identity = jdIdentity(response);
  const venderId = String(identity.vender_id || identity.venderId || token.uid || token.user_nick || '');
  const shopId = String(identity.shop_id || identity.shopId || '');
  if (!venderId || !shopId) throw new Error('JD.com authorization returned incomplete seller identity');
  return {
    provider: 'jd_jos', app_key: appKey, app_secret: appSecret, redirect_uri: redirectUri,
    access_token: token.access_token, refresh_token: token.refresh_token,
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 31_536_000)) * 1000,
    refresh_expires_at: token.refresh_token_expires_in
      ? Date.now() + Math.max(60, Number(token.refresh_token_expires_in)) * 1000 : 0,
    identity: {
      vender_id: venderId, shop_id: shopId,
      shop_name: String(identity.shop_name || identity.shopName || token.user_nick || ''),
      xid: String(token.xid || ''),
    },
  };
}

async function authorizePinduoduo(env) {
  const { client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri } = env.credentials;
  if (!clientId || !clientSecret || !redirectUri) throw new Error('incomplete Pinduoduo authorization input');
  const { code } = await authorizationCode(env);
  const response = await pinduoduoApi(clientId, clientSecret, '', 'pdd.pop.auth.token.create', { code });
  const token = response.pop_auth_token_create_response || response;
  if (!token.access_token || !token.refresh_token || !token.owner_id) {
    throw new Error('Pinduoduo token exchange returned incomplete credentials');
  }
  const mallResponse = await pinduoduoApi(clientId, clientSecret, token.access_token, 'pdd.mall.info.get');
  const identity = mallResponse.mall_info_get_response || {};
  if (String(identity.mall_id || '') !== String(token.owner_id)) {
    throw new Error('Pinduoduo authorization returned a different merchant');
  }
  return {
    provider: 'pinduoduo', client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri,
    access_token: token.access_token, refresh_token: token.refresh_token,
    scope: Array.isArray(token.scope) ? token.scope : [],
    expires_at: Date.now() + Math.max(60, Number(token.expires_in || 86_400)) * 1000,
    refresh_expires_at: token.refresh_token_expires_in
      ? Date.now() + Math.max(60, Number(token.refresh_token_expires_in)) * 1000 : 0,
    identity: {
      mall_id: String(identity.mall_id), mall_name: String(identity.mall_name || token.owner_name || ''),
      merchant_type: String(identity.merchant_type ?? ''), mall_character: String(identity.mall_character ?? ''),
    },
  };
}

async function authorizeDouyinShop(env) {
  const { app_key: appKey, app_secret: appSecret } = env.credentials;
  const shopId = String(env.metadata.shop_id || '');
  if (!appKey || !appSecret || !/^[1-9][0-9]{0,24}$/.test(shopId)) {
    throw new Error('incomplete Douyin Shop authorization input');
  }
  const token = await douyinApi(appKey, appSecret, '', '/token/create', 'token.create', {
    grant_type: 'authorization_self', code: '', shop_id: shopId,
  }, 'Douyin Shop token creation');
  if (!token.access_token || !token.refresh_token || String(token.shop_id || '') !== shopId) {
    throw new Error('Douyin Shop token creation returned incomplete or mismatched credentials');
  }
  const identity = await douyinApi(appKey, appSecret, '', '/open/getAuthInfo', 'open.getAuthInfo', {
    auth_id: shopId, auth_subject_type: 'shop',
  });
  if (String(identity.auth_id || identity.shop_id || '') !== shopId || Number(identity.status) !== 1) {
    throw new Error('Douyin Shop authorization returned an inactive or different shop');
  }
  return {
    provider: 'douyin_shop', app_key: appKey, app_secret: appSecret,
    access_token: token.access_token, refresh_token: token.refresh_token,
    scope: token.scope || [], expires_at: expiryMs(token.expires_in, 7 * 86_400),
    refresh_expires_at: expiryMs(token.refresh_expires_in, 14 * 86_400),
    identity: {
      shop_id: shopId, shop_name: String(identity.shop_name || token.shop_name || ''),
      authority_id: String(identity.authority_id || ''),
      shop_biz_type: String(identity.shop_biz_type ?? ''),
    },
  };
}

async function authorizeKuaishouShop(env) {
  const {
    app_key: appKey, app_secret: appSecret, sign_secret: signSecret,
    redirect_uri: redirectUri,
  } = env.credentials;
  if (!appKey || !appSecret || !signSecret || !redirectUri) {
    throw new Error('incomplete Kuaishou Shop authorization input');
  }
  const { code } = await authorizationCode(env);
  const tokenUrl = new URL(KUAISHOU_TOKEN_URL);
  tokenUrl.search = new URLSearchParams({
    app_id: appKey, grant_type: 'code', code, app_secret: appSecret,
  }).toString();
  const token = await readJson(await fetch(tokenUrl, {
    headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(60_000),
  }), 'Kuaishou Shop token exchange');
  const data = token.data || token;
  if (!data.access_token || !data.refresh_token || !data.open_id) {
    throw new Error('Kuaishou Shop token exchange returned incomplete credentials');
  }
  const missing = missingScopes(data.scope || KUAISHOU_SCOPES.join(','), KUAISHOU_SCOPES);
  if (missing.length) throw new Error(`Kuaishou Shop authorization is missing required scopes: ${missing.join(', ')}`);
  const seller = await kuaishouApi(appKey, signSecret, data.access_token, 'open.user.seller.get');
  const shop = await kuaishouApi(appKey, signSecret, data.access_token, 'open.shop.info.get');
  const returnedOpenId = String(seller.open_id || seller.openId || data.open_id || '');
  if (returnedOpenId !== String(data.open_id)) {
    throw new Error('Kuaishou Shop authorization returned a different seller');
  }
  const shopId = String(shop.shop_id || shop.shopId || shop.id || '');
  if (!shopId) throw new Error('Kuaishou Shop authorization returned no shop identity');
  return {
    provider: 'kuaishou_shop', app_key: appKey, app_secret: appSecret,
    sign_secret: signSecret, redirect_uri: redirectUri,
    access_token: data.access_token, refresh_token: data.refresh_token,
    scope: data.scope || KUAISHOU_SCOPES.join(','),
    expires_at: expiryMs(data.expires_in, 48 * 60 * 60),
    refresh_expires_at: expiryMs(data.refresh_token_expires_in, 180 * 86_400),
    identity: {
      open_id: String(data.open_id), seller_name: String(seller.seller_name || seller.user_name || ''),
      shop_id: shopId, shop_name: String(shop.shop_name || shop.name || ''),
    },
  };
}

async function authorizeYouzan(env) {
  const { client_id: clientId, client_secret: clientSecret } = env.credentials;
  const kdtId = String(env.metadata.kdt_id || '');
  if (!clientId || !clientSecret || !/^[1-9][0-9]{0,24}$/.test(kdtId)) {
    throw new Error('incomplete Youzan authorization input');
  }
  const token = await youzanAuthToken(clientId, clientSecret, kdtId, false);
  const identity = await youzanAuthApi(token.access_token, 'youzan.shop.get', '3.0.0');
  const returnedKdtId = String(identity.kdt_id || identity.id || identity.shop_id || '');
  if (returnedKdtId && returnedKdtId !== kdtId) {
    throw new Error('Youzan authorization returned a different shop');
  }
  return {
    provider: 'youzan', client_id: clientId, client_secret: clientSecret,
    access_token: token.access_token, scope: token.scope || [],
    expires_at: absoluteOrRelativeExpiryMs(token.expires, 7 * 86_400),
    identity: {
      kdt_id: kdtId, shop_name: String(identity.name || identity.shop_name || ''),
      authority_id: String(token.authority_id),
    },
  };
}

async function authorizeWeimobWos(env) {
  const { client_id: clientId, client_secret: clientSecret } = env.credentials;
  const shopId = String(env.metadata.shop_id || '');
  const shopType = String(env.metadata.shop_type || '');
  if (!clientId || !clientSecret || !/^[1-9][0-9]{0,24}$/.test(shopId)
      || shopType !== 'business_operation_system_id') {
    throw new Error('incomplete Weimob WOS authorization input');
  }
  const token = await weimobAuthToken(clientId, clientSecret, shopId);
  await weimobAuthApi(
    token.access_token, 'bos/v2.0/organization/getList', { pageNum: 1, pageSize: 1 },
  );
  return {
    provider: 'weimob_wos', client_id: clientId, client_secret: clientSecret,
    access_token: token.access_token, expires_at: expiryMs(token.expires_in, 7 * 86_400),
    identity: {
      business_operation_system_id: String(token.business_operation_system_id),
      public_account_id: String(token.public_account_id || ''),
      business_id: String(token.business_id || ''),
    },
  };
}

async function authorizeXiaohongshuArk(env) {
  const { app_key: appKey, app_secret: appSecret } = env.credentials;
  if (typeof appKey !== 'string' || appKey.length < 3
      || typeof appSecret !== 'string' || appSecret.length < 8) {
    throw new Error('incomplete Xiaohongshu Ark authorization input');
  }
  await xiaohongshuAuthApi(appKey, appSecret);
  return {
    provider: 'xiaohongshu_ark', app_key: appKey, app_secret: appSecret,
    identity: {
      app_key_fingerprint: crypto.createHash('sha256').update(appKey, 'utf8').digest('hex').slice(0, 16),
    },
  };
}

async function authorizeConfigured(env) {
  const storefrontApi = require('./merchant-platform-api.cjs');
  if (storefrontApi.isProvider(env.provider)) return storefrontApi.authorize(env);
  if (env.provider === 'constant_contact') return authorizeConstantContact(env);
  if (env.provider === 'ebay') return authorizeEbay(env);
  if (env.provider === 'etsy') return authorizeEtsy(env);
  if (env.provider === 'mercado_libre') return authorizeMercadoLibre(env);
  if (env.provider === 'taobao_top') return authorizeTaobao(env);
  if (env.provider === 'alibaba_1688') return authorizeAlibaba1688(env);
  if (env.provider === 'jd_jos') return authorizeJd(env);
  if (env.provider === 'pinduoduo') return authorizePinduoduo(env);
  if (env.provider === 'douyin_shop') return authorizeDouyinShop(env);
  if (env.provider === 'kuaishou_shop') return authorizeKuaishouShop(env);
  if (env.provider === 'youzan') return authorizeYouzan(env);
  if (env.provider === 'weimob_wos') return authorizeWeimobWos(env);
  if (env.provider === 'xiaohongshu_ark') return authorizeXiaohongshuArk(env);
  throw new Error('unsupported local API interactive provider');
}

async function main() {
  const env = authEnvironment();
  const credentials = await authorizeConfigured(env);
  writeCredentialFile(env.credentialFile, env.key, credentials);
  process.stdout.write(`[Orkas] ${process.env.ORKAS_DEVICE_AUTH_DONE || 'Account authorization verified.'}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[Orkas] ${process.env.ORKAS_DEVICE_AUTH_FAILED || String(error && error.message ? error.message : error).replace(/[\r\n]+/g, ' ').slice(0, 500)}\n`);
    process.exit(1);
  });
}

module.exports = {
  BROWSER_OAUTH_PROVIDERS, SELF_AUTH_PROVIDERS, createBrowserAuthorization, authorizeConfigured,
  CONSTANT_CONTACT_DEVICE_URL, CONSTANT_CONTACT_TOKEN_URL, CONSTANT_CONTACT_ACCOUNT_URL,
  CONSTANT_CONTACT_SCOPES, EBAY_SCOPES, ETSY_SCOPES, MERCADO_LIBRE_SCOPES,
  constantContactVerificationUrl,
  TAOBAO_AUTHORIZE_URL, TAOBAO_TOKEN_URL, TAOBAO_API_URL,
  ALIBABA_1688_AUTHORIZE_URL, ALIBABA_1688_TOKEN_BASE,
  JD_AUTHORIZE_URL, JD_TOKEN_URL, JD_API_URL,
  PINDUODUO_AUTHORIZE_URL, PINDUODUO_API_URL,
  DOUYIN_API_BASE, KUAISHOU_AUTHORIZE_URL, KUAISHOU_TOKEN_URL, KUAISHOU_API_BASE,
  KUAISHOU_SCOPES, YOUZAN_TOKEN_URL, YOUZAN_API_BASE, WEIMOB_TOKEN_URL, WEIMOB_API_BASE,
  XIAOHONGSHU_ARK_API_BASE,
  main, postForm, parseCallback, authorizeConstantContact, authorizeEbay, authorizeEtsy,
  authorizeMercadoLibre, authorizeTaobao, authorizeAlibaba1688, authorizeJd, authorizePinduoduo,
  authorizeDouyinShop, authorizeKuaishouShop, authorizeYouzan, authorizeWeimobWos,
  authorizeXiaohongshuArk,
  chinaTimestamp, signTaobao, sign1688, signJd, signPinduoduo, signDouyin, signKuaishou,
  stableJson, douyinApi, kuaishouApi, expiryMs, absoluteOrRelativeExpiryMs,
  youzanAuthToken, youzanAuthApi, weimobAuthToken, weimobAuthApi,
  signXiaohongshu, xiaohongshuAuthApi,
  DEVICE_AUTHORIZE_URL: CONSTANT_CONTACT_DEVICE_URL,
  TOKEN_URL: CONSTANT_CONTACT_TOKEN_URL,
  ACCOUNT_URL: CONSTANT_CONTACT_ACCOUNT_URL,
  SCOPES: CONSTANT_CONTACT_SCOPES,
};
