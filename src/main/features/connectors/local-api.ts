/** Device-only credential store and runtime for direct, user-owned commerce API connections. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isIP } from 'node:net';
import { app } from 'electron';

import * as paths from '../../paths';
import { writeTextAtomicSync } from '../../storage';
import * as localSecrets from '../../util/local-secret-store';
import { resolveBackgroundNodeRuntime, withBackgroundNodeEnv } from '../../util/background-node';
import { buildChildProxyEnvironment } from '../../util/proxy-dispatcher';
import { getLanguageForUser } from '../config';
import { t } from '../../i18n';
import { startLocalApiBrowserOAuth, startLocalApiCredentialAuthorization } from './oauth-dcr';
import { LOCAL_API_REDIRECT_URI } from './oauth-redirect';
import {
  startInteractiveCliSession,
  waitInteractiveCliSession,
} from '../../model/core-agent/interactive-cli-sessions';
import type { CatalogConnectionField, CatalogEntry, LocalApiConfig, Transport } from './types';

const CREDENTIAL_KEY_NAMESPACE = 'connectors.local-api-key';
const PAYLOAD_PREFIX = 'ORKAPI1:';
// Only new installations use this default; persisted runtime bindings stay authoritative.
export const PRODUCTION_ONLY_LOCAL_API_PROVIDERS: ReadonlySet<string> = new Set([
  'shopee', 'square', 'instacart', 'reloadly', 'walmart', 'ebay', 'amazon_seller',
]);
const EBAY_MARKETPLACE_LOCALES: Record<string, readonly string[]> = Object.freeze({
  EBAY_US: ['en-US'], EBAY_MOTORS_US: ['en-US'], EBAY_AT: ['de-AT'], EBAY_AU: ['en-AU'], EBAY_BE: ['nl-BE', 'fr-BE'],
  EBAY_CA: ['en-CA', 'fr-CA'], EBAY_CH: ['de-CH'], EBAY_DE: ['de-DE'], EBAY_ES: ['es-ES'],
  EBAY_FR: ['fr-FR'], EBAY_GB: ['en-GB'], EBAY_HK: ['zh-HK'], EBAY_IE: ['en-IE'],
  EBAY_IT: ['it-IT'], EBAY_MY: ['en-US'], EBAY_NL: ['nl-NL'], EBAY_PH: ['en-PH'],
  EBAY_PL: ['pl-PL'], EBAY_SG: ['en-US'], EBAY_TW: ['zh-TW'],
});
const AMAZON_MARKETPLACES = new Set([
  'A2EUQ1WTGCTBG2', 'ATVPDKIKX0DER', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC',
  'A28R8C7NBKEWEA', 'A1RKKUPIHCS9HS', 'A1F83G8C2ARO7P', 'A13V1IB3VIYZZH',
  'AMEN7PMS3EDWL', 'A1805IZSGTT6HS', 'A1PA6795UKMFR9', 'APJ6JRA9NG5V4',
  'A2NODRKZP88ZB9', 'AE08WJ6YKNBMC', 'A1C3SOZRARQ6R3', 'ARBP9OOSHTCHU',
  'A33AVAJ2PDY3EV', 'A17E79C6D8DWNP', 'A2VIGQ35RCS4UG', 'A21TJRUUN4KGV',
  'A19VAU5U5O7RUS', 'A39IBJ37TRP1C6', 'A1VC38T7YXB528',
]);

export interface LocalApiConnectionInput {
  metadata: Record<string, string>;
  credentials: Record<string, string>;
}

function pcDirForChild(): string {
  return app?.isPackaged ? paths.PC_ROOT.replace(/\bapp\.asar\b/, 'app.asar.unpacked') : paths.PC_ROOT;
}

function requireLocalApi(entry: CatalogEntry): LocalApiConfig {
  if (entry.auth_mode !== 'local_api' || !entry.local_api || !entry.connection_setup?.fields.length) {
    throw new Error(`catalog entry ${entry.id} is not a local API connector`);
  }
  return entry.local_api;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeField(field: CatalogConnectionField, raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error(`connector parameter required: ${field.key}`);
  const value = raw.trim();
  if (/[\u0000-\u001f\u007f]/.test(value) || value.length > 4096) throw new Error(`invalid connector parameter: ${field.key}`);
  if (field.format === 'client_id' || field.format === 'app_key') {
    if (value.length < 3 || value.length > 512) throw new Error(`invalid connector ${field.format === 'app_key' ? 'app key' : 'client ID'}: ${field.key}`);
    return value;
  }
  if (field.format === 'secret') {
    if (value.length < 8) throw new Error(`invalid connector secret: ${field.key}`);
    return value;
  }
  if (['bigcommerce_store_hash', 'shopline_store_domain', 'shoplazza_store_domain'].includes(field.format)) {
    const storefrontApi = require(path.join(pcDirForChild(), 'bin/storefront-admin-api.cjs'));
    return storefrontApi.normalizeBinding(field.format.split('_')[0], value);
  }
  if (field.format === 'lazada_country') {
    if (!['sg', 'my', 'ph', 'th', 'id', 'vn'].includes(value)) throw new Error('Invalid Lazada production country');
    return value;
  }
  if (field.format === 'temu_region') {
    if (!['us', 'eu', 'global'].includes(value)) throw new Error('Invalid Temu production region');
    return value;
  }
  if (field.format === 'magento_store_url') {
    return require(path.join(pcDirForChild(), 'bin/magento-admin-api.cjs')).normalizeBinding(value);
  }
  if (field.format === 'shopify_shop_domain') {
    let host = value.toLowerCase();
    if (!host.includes('.')) host = `${host}.myshopify.com`;
    if (/^https?:\/\//.test(host)) {
      const parsed = new URL(host);
      if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('invalid Shopify shop domain');
      host = parsed.hostname;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/.test(host)) throw new Error('invalid Shopify shop domain');
    return host;
  }
  if (field.format === 'lightspeed_store_domain') {
    let host = value.toLowerCase();
    if (!host.includes('.')) host = `${host}.retail.lightspeed.app`;
    if (/^https?:\/\//.test(host)) {
      const parsed = new URL(host);
      if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new Error('invalid Lightspeed store domain');
      host = parsed.hostname;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,62}\.retail\.lightspeed\.app$/.test(host)) throw new Error('invalid Lightspeed store domain');
    return host;
  }
  if (field.format === 'commerce_layer_slug') {
    let slug = value.toLowerCase();
    if (/^https?:\/\//.test(slug)) {
      let parsed: URL;
      try { parsed = new URL(slug); } catch { throw new Error('invalid Commerce Layer organization slug'); }
      if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash
          || parsed.username || parsed.password || !parsed.hostname.endsWith('.commercelayer.io')) {
        throw new Error('invalid Commerce Layer organization slug');
      }
      slug = parsed.hostname.slice(0, -'.commercelayer.io'.length);
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
      throw new Error('invalid Commerce Layer organization slug');
    }
    return slug;
  }
  if (field.format === 'woocommerce_store_url') {
    let parsed: URL;
    try { parsed = new URL(/^https:\/\//i.test(value) ? value : `https://${value}`); } catch {
      throw new Error('invalid WooCommerce store URL');
    }
    const host = parsed.hostname.toLowerCase();
    const reserved = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || host.endsWith('.internal') || host.endsWith('.test') || host.endsWith('.invalid')
      || host.endsWith('.example');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash
        || isIP(host) !== 0 || reserved || !host.includes('.')) {
      throw new Error('invalid WooCommerce store URL');
    }
    const pathName = parsed.pathname.replace(/\/+$/, '');
    if (/\/(?:wp-json|wc-api)(?:\/|$)/i.test(pathName)) throw new Error('invalid WooCommerce store URL');
    return `${parsed.origin}${pathName}`;
  }
  if (field.format === 'woocommerce_consumer_key') {
    if (!/^ck_[A-Fa-f0-9]{40}$/.test(value)) throw new Error('invalid WooCommerce consumer key');
    return value;
  }
  if (field.format === 'woocommerce_consumer_secret') {
    if (!/^cs_[A-Fa-f0-9]{40}$/.test(value)) throw new Error('invalid WooCommerce consumer secret');
    return value;
  }
  if (field.format === 'walmart_market') {
    if (!['us', 'ca', 'mx', 'cl'].includes(value)) throw new Error('invalid Walmart market');
    return value;
  }
  if (field.format === 'ebay_marketplace') {
    if (!Object.prototype.hasOwnProperty.call(EBAY_MARKETPLACE_LOCALES, value)) throw new Error('invalid eBay marketplace');
    return value;
  }
  if (field.format === 'ebay_content_language') {
    if (!Object.values(EBAY_MARKETPLACE_LOCALES).some((locales) => locales.includes(value))) {
      throw new Error('invalid eBay listing language');
    }
    return value;
  }
  if (field.format === 'ebay_ru_name') {
    if (!/^[A-Za-z0-9._~-]{3,512}$/.test(value) || /^https?:/i.test(value)) throw new Error('invalid eBay RuName');
    return value;
  }
  if (field.format === 'etsy_shop_id') {
    if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new Error('invalid Etsy shop ID');
    return value;
  }
  if (field.format === 'etsy_keystring') {
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(value)) throw new Error('invalid Etsy keystring');
    return value;
  }
  if (field.format === 'amazon_marketplace') {
    if (!AMAZON_MARKETPLACES.has(value)) throw new Error('invalid Amazon marketplace');
    return value;
  }
  if (field.format === 'amazon_seller_id') {
    if (!/^[A-Z0-9]{8,32}$/.test(value)) throw new Error('invalid Amazon seller ID');
    return value;
  }
  if (field.format === 'amazon_refresh_token') {
    if (!/^Atzr\|[A-Za-z0-9._|~+/=-]{16,4090}$/.test(value)) throw new Error('invalid Amazon LWA refresh token');
    return value;
  }
  if (field.format === 'mercado_libre_user_id') {
    if (!/^[1-9][0-9]{0,18}$/.test(value)) throw new Error('invalid Mercado Libre user ID');
    return value;
  }
  if (field.format === 'douyin_shop_id') {
    if (!/^[1-9][0-9]{0,24}$/.test(value)) throw new Error('invalid Douyin Shop ID');
    return value;
  }
  if (field.format === 'youzan_kdt_id') {
    if (!/^[1-9][0-9]{0,24}$/.test(value)) throw new Error('invalid Youzan KDT ID');
    return value;
  }
  if (field.format === 'weimob_wos_shop_id') {
    if (!/^[1-9][0-9]{0,24}$/.test(value)) throw new Error('invalid Weimob WOS shop ID');
    return value;
  }
  if (field.format === 'etsy_redirect_uri' || field.format === 'ebay_redirect_uri'
      || field.format === 'mercado_libre_redirect_uri' || field.format === 'alibaba_redirect_uri'
      || field.format === 'jd_redirect_uri' || field.format === 'pinduoduo_redirect_uri'
      || field.format === 'kuaishou_redirect_uri') {
    let parsed: URL;
    const providerName = field.format === 'ebay_redirect_uri' ? 'eBay'
      : field.format === 'mercado_libre_redirect_uri' ? 'Mercado Libre'
        : field.format === 'alibaba_redirect_uri' ? 'Alibaba'
          : field.format === 'jd_redirect_uri' ? 'JD.com'
            : field.format === 'pinduoduo_redirect_uri' ? 'Pinduoduo'
              : field.format === 'kuaishou_redirect_uri' ? 'Kuaishou Shop' : 'Etsy';
    try { parsed = new URL(value); } catch { throw new Error(`invalid ${providerName} redirect URI`); }
    const host = parsed.hostname.toLowerCase();
    const loopback = field.format === 'alibaba_redirect_uri' && parsed.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(host);
    if ((!loopback && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash
        || (!loopback && (isIP(host) !== 0 || !host.includes('.') || host === 'localhost'
          || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')))) {
      throw new Error(`invalid ${providerName} redirect URI`);
    }
    return parsed.toString();
  }
  if (field.format === 'reloadly_product') {
    if (!['airtime', 'giftcards', 'utilities'].includes(value)) throw new Error('invalid Reloadly product');
    return value;
  }
  if (field.format === 'instacart_api_key') {
    if (!/^keys\.[A-Za-z0-9_-]{16,256}$/.test(value)) throw new Error('invalid Instacart API key');
    return value;
  }
  if (field.format === 'sandbox_or_live') {
    if (!['sandbox', 'live'].includes(value)) throw new Error('invalid connector environment');
    return value;
  }
  if (field.format === 'shopee_id') {
    if (!/^[1-9][0-9]{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`invalid Shopee ID: ${field.key}`);
    return value;
  }
  if (field.format === 'tiktok_service_id') {
    if (!/^[1-9][0-9]{0,24}$/.test(value)) throw new Error('invalid TikTok Shop service ID');
    return value;
  }
  if (field.format === 'tiktok_shop_code') {
    if (!/^[A-Za-z0-9_-]{3,64}$/.test(value)) throw new Error('invalid TikTok Shop code');
    return value;
  }
  if (field.format === 'shopee_region' || field.format === 'tiktok_shop_region') {
    if (!(field.format === 'shopee_region' ? ['global', 'cn', 'br'] : ['us', 'row']).includes(value)) throw new Error('invalid seller platform region');
    return value;
  }
  throw new Error(`unsupported local API parameter format: ${String(field.format)}`);
}

export function normalizeLocalApiConnectionInput(entry: CatalogEntry, raw: unknown): LocalApiConnectionInput {
  requireLocalApi(entry);
  if (!isPlainObject(raw)) throw new Error('connector connection parameters required');
  const fields = entry.connection_setup!.fields;
  const known = new Map(fields.map((field) => [field.key, field]));
  if (known.size !== fields.length) throw new Error('invalid connector connection setup');
  for (const key of Object.keys(raw)) if (!known.has(key)) throw new Error(`unknown connector parameter: ${key}`);
  const metadata: Record<string, string> = {};
  const credentials: Record<string, string> = {};
  for (const field of fields) {
    const value = normalizeField(field, raw[field.key]);
    (field.storage === 'credential' ? credentials : metadata)[field.key] = value;
  }
  if (PRODUCTION_ONLY_LOCAL_API_PROVIDERS.has(entry.local_api!.provider)) metadata.environment = 'live';
  if (entry.local_api?.provider === 'ebay'
      && !EBAY_MARKETPLACE_LOCALES[metadata.marketplace_id]?.includes(metadata.content_language)) {
    throw new Error('eBay listing language is not supported by the selected marketplace');
  }
  if (entry.local_api?.provider === 'weimob_wos') {
    metadata.shop_type = 'business_operation_system_id';
  }
  // The desktop owns the callback. Never accept an arbitrary redirect from the renderer.
  if (entry.connection_setup?.callback_url === LOCAL_API_REDIRECT_URI) {
    credentials.redirect_uri = LOCAL_API_REDIRECT_URI;
  }
  return { metadata, credentials };
}

export function localApiRuntimeDir(uid: string, catalogId: string): string {
  if (!/^[a-z0-9_-]+$/.test(catalogId)) throw new Error('invalid local API catalog id');
  return path.join(paths.userLocalConfigDir(uid), 'connector-api', catalogId);
}

function credentialFile(uid: string, catalogId: string): string {
  return path.join(localApiRuntimeDir(uid, catalogId), 'credentials.enc');
}

function keyEnvelopeFile(uid: string, catalogId: string): string {
  return path.join(localApiRuntimeDir(uid, catalogId), 'credential-key.enc');
}

export function hasLocalApiAuthorization(uid: string, entry: CatalogEntry): boolean {
  requireLocalApi(entry);
  return fs.existsSync(credentialFile(uid, entry.id)) && fs.existsSync(keyEnvelopeFile(uid, entry.id));
}

function keyContext(uid: string, catalogId: string): localSecrets.LocalSecretContext {
  return { namespace: CREDENTIAL_KEY_NAMESPACE, ownerId: uid, recordId: catalogId };
}

function credentialKey(uid: string, catalogId: string): Buffer {
  const file = keyEnvelopeFile(uid, catalogId);
  try {
    const decoded = Buffer.from(localSecrets.decryptLocalSecret(
      keyContext(uid, catalogId), fs.readFileSync(file, 'utf8').trim(),
    ), 'base64url');
    if (decoded.length !== 32) throw new Error('invalid local API credential key');
    return decoded;
  } catch (error) {
    if (fs.existsSync(file)) throw error;
    const key = crypto.randomBytes(32);
    fs.mkdirSync(localApiRuntimeDir(uid, catalogId), { recursive: true, mode: 0o700 });
    try { fs.chmodSync(localApiRuntimeDir(uid, catalogId), 0o700); } catch { /* Windows/best effort */ }
    writeTextAtomicSync(file, `${localSecrets.encryptLocalSecret(
      keyContext(uid, catalogId), key.toString('base64url'),
    )}\n`, 'utf8', { mode: 0o600 });
    return key;
  }
}

function encryptCredentials(key: Buffer, payload: Record<string, unknown>): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return PAYLOAD_PREFIX + Buffer.from(JSON.stringify({
    iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url'),
  })).toString('base64url');
}

function saveCredentials(uid: string, entry: CatalogEntry, credentials: Record<string, unknown>): void {
  const key = credentialKey(uid, entry.id);
  writeTextAtomicSync(credentialFile(uid, entry.id), `${encryptCredentials(
    key, { provider: entry.local_api!.provider, ...credentials },
  )}\n`, 'utf8', { mode: 0o600 });
}

export function localApiStoredTransport(uid: string, entry: CatalogEntry): Transport {
  requireLocalApi(entry);
  const runtime = resolveBackgroundNodeRuntime();
  return {
    kind: 'stdio', command: runtime.executable,
    args: [path.join(pcDirForChild(), 'bin/direct-commerce-mcp-server.cjs')],
    cwd: localApiRuntimeDir(uid, entry.id),
  };
}

export async function localApiTransport(
  uid: string,
  entry: CatalogEntry,
  metadata?: Record<string, string>,
): Promise<Transport> {
  const config = requireLocalApi(entry);
  const file = credentialFile(uid, entry.id);
  if (!hasLocalApiAuthorization(uid, entry)) {
    throw Object.assign(new Error(`local_api_credentials_missing:${entry.id}`), {
      code: 'local_api_credentials_missing',
    });
  }
  const key = credentialKey(uid, entry.id);
  const runtime = resolveBackgroundNodeRuntime();
  const wooStoreUrl = String(metadata?.store_url || '');
  const merchantApi = require(path.join(pcDirForChild(), 'bin/merchant-platform-api.cjs'));
  const proxyTargetUrl = merchantApi.isProvider(config.provider)
    ? merchantApi.apiBase(config.provider, metadata || {})
    : config.provider === 'woocommerce' && wooStoreUrl
    ? `${wooStoreUrl.replace(/\/$/, '')}/wp-json/wc/v3/system_status`
    : config.provider === 'walmart' && ['sandbox', 'live'].includes(String(metadata?.environment || ''))
      ? `${metadata?.environment === 'sandbox' ? 'https://sandbox.walmartapis.com' : 'https://marketplace.walmartapis.com'}/v3/token`
      : config.provider === 'ebay' && ['sandbox', 'live'].includes(String(metadata?.environment || ''))
        ? `${metadata?.environment === 'sandbox' ? 'https://api.sandbox.ebay.com' : 'https://api.ebay.com'}/identity/v1/oauth2/token`
      : config.provider === 'etsy'
        ? 'https://openapi.etsy.com/v3/application'
      : config.provider === 'amazon_seller'
        ? 'https://api.amazon.com/auth/o2/token'
      : config.provider === 'mercado_libre'
        ? 'https://api.mercadolibre.com/oauth/token'
      : config.provider === 'shopee' || config.provider === 'tiktok_shop'
        ? require(path.join(pcDirForChild(), 'bin/marketplace-seller-api.cjs')).apiBase(config.provider, metadata || {})
      : config.provider === 'taobao_top'
        ? 'https://oauth.taobao.com/token'
      : config.provider === 'alibaba_1688'
        ? 'https://gw.open.1688.com/openapi/http/1/system.oauth2/getToken'
      : config.provider === 'jd_jos'
        ? 'https://open-oauth.jd.com/oauth2/access_token'
      : config.provider === 'pinduoduo'
        ? 'https://gw-api.pinduoduo.com/api/router'
      : config.provider === 'douyin_shop'
        ? 'https://openapi-fxg.jinritemai.com/token/create'
      : config.provider === 'kuaishou_shop'
        ? 'https://openapi.kwaixiaodian.com/oauth2/access_token'
      : config.provider === 'youzan'
        ? 'https://open.youzanyun.com/auth/token'
      : config.provider === 'weimob_wos'
        ? 'https://dopen.weimob.com/fuwu/b/oauth2/token'
      : config.provider === 'xiaohongshu_ark'
        ? 'https://ark.xiaohongshu.com/ark/open_api/v1/items/lite'
      : config.provider === 'commerce_layer'
        ? 'https://auth.commercelayer.io/oauth/token'

        : undefined;
  const proxyEnv = await buildChildProxyEnvironment(proxyTargetUrl);
  const stored = localApiStoredTransport(uid, entry);
  if (stored.kind !== 'stdio') throw new Error('invalid local API transport');
  return {
    ...stored,
    ...(proxyTargetUrl ? { proxyTargetUrl } : {}),
    env: withBackgroundNodeEnv({
      ...proxyEnv,
      ORKAS_LOCAL_API_PROVIDER: config.provider,
      ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(metadata || {}),
      ORKAS_LOCAL_API_CREDENTIAL_FILE: file,
      ORKAS_LOCAL_API_CREDENTIAL_KEY: key.toString('base64url'),
    }, runtime),
  };
}

export async function authorizeLocalApi(
  uid: string,
  entry: CatalogEntry,
  raw: unknown,
  opts: { attemptId?: string } = {},
): Promise<Record<string, string>> {
  const config = requireLocalApi(entry);
  const normalized = normalizeLocalApiConnectionInput(entry, raw);
  const userAppAuth = require(path.join(pcDirForChild(), 'bin/local-api-auth.cjs'));
  if (userAppAuth.BROWSER_OAUTH_PROVIDERS.has(config.provider) || userAppAuth.SELF_AUTH_PROVIDERS.has(config.provider)) {
    try {
      const env = { provider: config.provider, ...normalized };
      let credentials: Record<string, unknown>;
      if (userAppAuth.BROWSER_OAUTH_PROVIDERS.has(config.provider)) {
        let flow: { url: string; complete: (code: string) => Promise<Record<string, unknown>> };
        credentials = await startLocalApiBrowserOAuth(entry.id, (state, redirectUri) => {
          flow = userAppAuth.createBrowserAuthorization(env, state, redirectUri);
          return flow.url;
        }, (code) => flow.complete(code), opts);
      } else {
        credentials = await startLocalApiCredentialAuthorization(entry.id, () => userAppAuth.authorizeConfigured(env), opts);
      }
      saveCredentials(uid, entry, credentials);
      return normalized.metadata;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'user_cancelled') throw error;
      if (code?.startsWith('storefront_')) {
        const key = code === 'storefront_permission_denied' ? 'permission_denied'
          : code === 'storefront_binding_mismatch' ? 'binding_mismatch' : 'request_failed';
        throw Object.assign(new Error(t(`connectors.storefront.${key}`, {}, getLanguageForUser(uid))), { code });
      }
      throw Object.assign(new Error(t('connectors.seller.authorization_failed', {}, getLanguageForUser(uid))), {
        code: code || 'local_api_authorization_failed',
      });
    }
  }
  if (config.provider === 'shopee' || config.provider === 'tiktok_shop') {
    // Shared with the bundled MCP adapter; Node fetch retains the owning main-process proxy.
    const sellerApi = require(path.join(pcDirForChild(), 'bin/marketplace-seller-api.cjs'));
    try {
      const credentials = await startLocalApiBrowserOAuth(entry.id, (state, redirectUri) => sellerApi.authorizeUrl(
        config.provider, normalized.metadata, normalized.credentials, state, redirectUri,
      ), (code) => sellerApi.authorize(config.provider, normalized.metadata, normalized.credentials, code), opts);
      saveCredentials(uid, entry, credentials);
      return normalized.metadata;
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'user_cancelled') throw error;
      const key = code === 'seller_shop_mismatch' ? 'shop_mismatch'
        : code === 'seller_request_failed' ? 'request_failed' : 'authorization_failed';
      throw Object.assign(new Error(t(`connectors.seller.${key}`, {}, getLanguageForUser(uid))), {
        code: code || 'local_api_authorization_failed',
      });
    }
  }
  if (config.provider !== 'constant_contact') {
    saveCredentials(uid, entry, normalized.credentials);
    return normalized.metadata;
  }
  const runtime = resolveBackgroundNodeRuntime();
  const proxyEnv = await buildChildProxyEnvironment();
  const key = credentialKey(uid, entry.id);
  const lang = getLanguageForUser(uid);
  const session = startInteractiveCliSession({
    presentation: 'browser_auth',
    uid,
    purpose: t('connectors.local_cli.auth_purpose', { connector: entry.display_name }, lang),
    command: runtime.executable,
    args: [path.join(pcDirForChild(), 'bin/local-api-auth.cjs')],
    cwd: localApiRuntimeDir(uid, entry.id),
    sandboxEnv: withBackgroundNodeEnv({
      ...proxyEnv,
      ORKAS_LOCAL_API_PROVIDER: config.provider,
      ORKAS_LOCAL_API_CLIENT_ID: normalized.credentials.client_id || '',
      ORKAS_DEVICE_AUTH_OPEN_PAGE: t('connectors.device_auth.open_page', {}, lang),
      ORKAS_DEVICE_AUTH_CODE: t('connectors.device_auth.code', {}, lang),
      ORKAS_DEVICE_AUTH_WAITING: t('connectors.device_auth.waiting', {}, lang),
      ORKAS_DEVICE_AUTH_DONE: t('connectors.local_cli.auth_done', {}, lang),
      ORKAS_DEVICE_AUTH_FAILED: t('connectors.device_auth.failed', {}, lang),
      ORKAS_LOCAL_API_AUTH_INPUT_JSON: JSON.stringify(normalized),
      ORKAS_LOCAL_API_CREDENTIAL_FILE: credentialFile(uid, entry.id),
      ORKAS_LOCAL_API_CREDENTIAL_KEY: key.toString('base64url'),
    }, runtime),
    maxLifetimeMs: 30 * 60 * 1000,
  });
  const terminal = await waitInteractiveCliSession(uid, session.session_id);
  if (terminal.status !== 'exited' || terminal.exit_code !== 0 || !fs.existsSync(credentialFile(uid, entry.id))) {
    throw Object.assign(new Error(`local_api_authorization_failed:${config.provider}`), {
      code: terminal.status === 'closed' ? 'user_cancelled' : 'local_api_authorization_failed',
    });
  }
  return normalized.metadata;
}

export function removeLocalApiAuthorization(uid: string, entry: CatalogEntry): void {
  requireLocalApi(entry);
  try { fs.rmSync(localApiRuntimeDir(uid, entry.id), { recursive: true, force: true }); } catch { /* best effort */ }
}
