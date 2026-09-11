import { createRequire } from 'node:module';
import { generateKeyPairSync } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const interactiveMocks = vi.hoisted(() => ({
  start: vi.fn(() => ({ session_id: 'local-api-auth-session', status: 'running' })),
  wait: vi.fn(async () => ({
    session_id: 'local-api-auth-session', status: 'exited', exit_code: 0,
  })),
}));

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../../../src/main/util/background-node', () => ({
  resolveBackgroundNodeRuntime: () => ({ executable: '/opt/orkas/runtime/node', electronAsNode: false }),
  withBackgroundNodeEnv: (env: Record<string, string>) => ({
    ...env,
    ORKAS_NODE: '/opt/orkas/runtime/node',
    ORKAS_BUNDLED_NODE: '/opt/orkas/runtime/node',
  }),
}));
vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({
  buildChildProxyEnvironment: vi.fn(async () => ({ HTTPS_PROXY: 'http://proxy.test' })),
}));
vi.mock('../../../../src/main/util/local-secret-store', () => ({
  encryptLocalSecret: (_context: unknown, plaintext: string) => `TESTWRAP:${plaintext}`,
  decryptLocalSecret: (_context: unknown, payload: string) => {
    if (!payload.startsWith('TESTWRAP:')) throw new Error('invalid test key envelope');
    return payload.slice('TESTWRAP:'.length);
  },
}));
vi.mock('../../../../src/main/model/core-agent/interactive-cli-sessions', () => ({
  startInteractiveCliSession: interactiveMocks.start,
  waitInteractiveCliSession: interactiveMocks.wait,
}));

import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import {
  authorizeLocalApi,
  hasLocalApiAuthorization,
  localApiRuntimeDir,
  localApiStoredTransport,
  localApiTransport,
  normalizeLocalApiConnectionInput,
  removeLocalApiAuthorization,
} from '../../../../src/main/features/connectors/local-api';

const require = createRequire(import.meta.url);
const codec = require('../../../../bin/local-api-credential-codec.cjs') as {
  readCredentialFile: (file: string, key: string) => Record<string, unknown>;
  writeCredentialFile: (file: string, key: string, payload: Record<string, unknown>) => void;
};
const localApiAuth = require('../../../../bin/local-api-auth.cjs') as {
  constantContactVerificationUrl: (device: Record<string, string>) => string;
  EBAY_SCOPES: string[];
  ETSY_SCOPES: string[];
  MERCADO_LIBRE_SCOPES: string[];
  TAOBAO_AUTHORIZE_URL: string;
  ALIBABA_1688_AUTHORIZE_URL: string;
  JD_AUTHORIZE_URL: string;
  PINDUODUO_AUTHORIZE_URL: string;
  DOUYIN_API_BASE: string;
  KUAISHOU_AUTHORIZE_URL: string;
  KUAISHOU_SCOPES: string[];
  YOUZAN_TOKEN_URL: string;
  WEIMOB_TOKEN_URL: string;
  signTaobao: (parameters: Record<string, string>, secret: string) => string;
  sign1688: (pathName: string, parameters: Record<string, string>, secret: string) => string;
  signJd: (parameters: Record<string, string>, secret: string) => string;
  signPinduoduo: (parameters: Record<string, string>, secret: string) => string;
  signDouyin: (appKey: string, method: string, paramJson: string, timestamp: string, secret: string) => string;
  signKuaishou: (parameters: Record<string, string>, secret: string) => string;
  stableJson: (value: unknown) => string;
  parseCallback: (value: string, state: string, redirect?: string) => string;
};
const TEST_UID = 'u-local-api-tests';

function entry(id: string) {
  const result = findCatalogEntry(id);
  if (!result) throw new Error(`missing test catalog entry: ${id}`);
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const id of [
    'commerce-layer', 'shopify-admin', 'constant-contact', 'lightspeed-x', 'reloadly', 'square',
    'instacart-shopping', 'woocommerce', 'walmart-marketplace',
    'ebay-seller', 'etsy-seller', 'amazon-seller-central', 'mercado-libre-global-selling',
  ]) {
    try { removeLocalApiAuthorization(TEST_UID, entry(id)); } catch { /* test cleanup */ }
  }
  interactiveMocks.start.mockReset().mockReturnValue({
    session_id: 'local-api-auth-session', status: 'running',
  });
  interactiveMocks.wait.mockReset().mockResolvedValue({
    session_id: 'local-api-auth-session', status: 'exited', exit_code: 0,
  });
});

describe('device-local commerce API credentials', () => {
  it('retains eBay signing credentials through OAuth without sending them to token or privilege endpoints', async () => {
    const signing_private_key = generateKeyPairSync('ed25519').privateKey
      .export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const signing_key_jwe = 'header.encrypted.iv.ciphertext.tag';
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => ({
      ok: true, status: 200,
      text: async () => JSON.stringify(url.endsWith('/token') ? {
        access_token: 'access-fixture', refresh_token: 'refresh-fixture',
        scope: localApiAuth.EBAY_SCOPES.join(' '),
      } : { sellingLimit: {} }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await require('../../../../bin/local-api-auth.cjs').authorizeEbay({
        oauthCode: 'fixture-code', metadata: { environment: 'live', marketplace_id: 'EBAY_US', content_language: 'en-US' },
        credentials: { client_id: 'fixture-app', client_secret: 'fixture-secret', ru_name: 'Fixture-RuName',
          redirect_uri: 'https://orkas.test/callback', signing_private_key, signing_key_jwe },
      });
      expect(result).toMatchObject({ signing_private_key, signing_key_jwe, access_token: 'access-fixture' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(signing_private_key);
      expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(signing_key_jwe);
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps optional eBay signing secrets out of metadata and requires a valid pair', () => {
    const raw = { marketplace_id: 'EBAY_US', content_language: 'en-US', client_id: 'fixture-app',
      client_secret: 'fixture-secret', ru_name: 'Fixture-RuName' };
    const signing_private_key = generateKeyPairSync('ed25519').privateKey
      .export({ format: 'der', type: 'pkcs8' }).toString('base64');
    const signing_key_jwe = 'header.encrypted.iv.ciphertext.tag';
    const normalized = normalizeLocalApiConnectionInput(entry('ebay-seller'), {
      ...raw, signing_private_key, signing_key_jwe,
    });
    expect(normalized.credentials).toMatchObject({ signing_private_key, signing_key_jwe });
    expect(normalized.metadata).not.toHaveProperty('signing_private_key');
    expect(normalized.metadata).not.toHaveProperty('signing_key_jwe');
    expect(normalizeLocalApiConnectionInput(entry('ebay-seller'), {
      ...raw, signing_private_key: '', signing_key_jwe: '',
    })).toEqual(normalizeLocalApiConnectionInput(entry('ebay-seller'), raw));
    for (const invalid of [
      { signing_private_key }, { signing_key_jwe },
      { signing_private_key: 'not-a-key', signing_key_jwe },
      { signing_private_key, signing_key_jwe: 'injected\r\nheader' },
    ]) expect(() => normalizeLocalApiConnectionInput(entry('ebay-seller'), { ...raw, ...invalid })).toThrow(/invalid/);
    expect(() => normalizeLocalApiConnectionInput(entry('ebay-seller'), {
      ...raw, client_secret: '',
    })).toThrow(/required/);
  });

  it('validates pasted OAuth callbacks, CSRF state, redirect binding, and complete seller scopes', () => {
    expect(localApiAuth.parseCallback(
      'https://merchant.example.com/oauth/etsy?code=authorization-code&state=strong-state',
      'strong-state', 'https://merchant.example.com/oauth/etsy',
    )).toBe('authorization-code');
    expect(() => localApiAuth.parseCallback(
      'https://merchant.example.com/oauth/etsy?code=authorization-code&state=wrong-state',
      'strong-state', 'https://merchant.example.com/oauth/etsy',
    )).toThrow('state mismatch');
    expect(() => localApiAuth.parseCallback(
      'https://evil.example.com/oauth/etsy?code=authorization-code&state=strong-state',
      'strong-state', 'https://merchant.example.com/oauth/etsy',
    )).toThrow('does not match');
    expect(() => localApiAuth.parseCallback(
      'http://merchant.example.com/oauth/etsy?code=authorization-code&state=strong-state',
      'strong-state', 'https://merchant.example.com/oauth/etsy',
    )).toThrow('invalid OAuth callback URL');
    expect(localApiAuth.parseCallback(
      'http://127.0.0.1:49152/oauth/alibaba?code=authorization-code&state=strong-state',
      'strong-state', 'http://127.0.0.1:49152/oauth/alibaba',
    )).toBe('authorization-code');
    expect(localApiAuth.parseCallback(
      'http://[::1]:49152/oauth/alibaba?code=authorization-code&state=strong-state',
      'strong-state', 'http://[::1]:49152/oauth/alibaba',
    )).toBe('authorization-code');
    expect(localApiAuth.EBAY_SCOPES).toEqual([
      'https://api.ebay.com/oauth/api_scope/sell.account',
      'https://api.ebay.com/oauth/api_scope/sell.inventory',
      'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    ]);
    expect(localApiAuth.ETSY_SCOPES).toEqual([
      'shops_r', 'shops_w', 'listings_r', 'listings_w', 'listings_d',
      'transactions_r', 'transactions_w',
    ]);
    expect(localApiAuth.MERCADO_LIBRE_SCOPES).toEqual(['offline_access', 'read', 'write']);
    expect(localApiAuth.TAOBAO_AUTHORIZE_URL).toBe('https://oauth.taobao.com/authorize');
    expect(localApiAuth.ALIBABA_1688_AUTHORIZE_URL).toBe('https://auth.1688.com/oauth/authorize');
    expect(localApiAuth.JD_AUTHORIZE_URL).toBe('https://open-oauth.jd.com/oauth2/to_login');
    expect(localApiAuth.PINDUODUO_AUTHORIZE_URL).toBe('https://fuwu.pinduoduo.com/service-market/auth');
    expect(localApiAuth.DOUYIN_API_BASE).toBe('https://openapi-fxg.jinritemai.com');
    expect(localApiAuth.KUAISHOU_AUTHORIZE_URL).toBe('https://open.kwaixiaodian.com/oauth/authorize');
    expect(localApiAuth.YOUZAN_TOKEN_URL).toBe('https://open.youzanyun.com/auth/token');
    expect(localApiAuth.WEIMOB_TOKEN_URL).toBe('https://dopen.weimob.com/fuwu/b/oauth2/token');
    expect(localApiAuth.XIAOHONGSHU_ARK_API_BASE).toBe('https://ark.xiaohongshu.com');
    expect(localApiAuth.KUAISHOU_SCOPES).toEqual([
      'user_base', 'user_info', 'merchant_user', 'merchant_item',
      'merchant_order', 'merchant_refund', 'merchant_logistics',
    ]);
    expect(localApiAuth.signTaobao({ b: '2', a: '1' }, 'secret'))
      .toBe('3A9F9E53162A24430830CCA87B7FB623401B81EB6616A6EA75B3614AEBDC7F4D');
    expect(localApiAuth.sign1688('param2/1/system/currentTime/1000000', { b: '2', a: '1' }, 'test123'))
      .toBe('33E54F4F7B989E3E0E912D3FBD2F1A03CA7CCE88');
    expect(localApiAuth.signJd({ b: '2', a: '1' }, 'secret'))
      .toBe('EF16F26C937CF52AE6F85DF2FD08B24A');
    expect(localApiAuth.signPinduoduo({ b: '2', a: '1' }, 'secret'))
      .toBe('EF16F26C937CF52AE6F85DF2FD08B24A');
    expect(localApiAuth.signXiaohongshu('/ark/open_api/v1/items', {
      page_no: '1', page_size: '50', status: '0',
    }, 'xhs', '1469902537', '9a539709cafc1efc9ef05838be468a28'))
      .toBe('72be6fad4dd0e5104dbdebbcdadb2a06');
    expect(localApiAuth.stableJson({ z: [{ b: 2, a: 1 }], a: { y: 2, x: 1 } }))
      .toBe('{"a":{"x":1,"y":2},"z":[{"a":1,"b":2}]}');
    expect(localApiAuth.signDouyin(
      'app-key', 'product.detail', '{"a":1,"b":2}', '2025-01-02 03:04:05', 'secret',
    )).toBe('4eaefa2d3044c9f9711928edc8cfe5df1b7a8fd2d79d5d62866c79bbc4a09f2a');
    expect(localApiAuth.signKuaishou({ b: '2', a: '1' }, 'secret'))
      .toBe('ed7440a1245c50018f251c9f5b76b6a2058049f6f80d6951e3774888ff55f244');
  });

  it.each([
    { id: 'shopee', raw: { region: 'global', shop_id: '456', partner_id: '12345', partner_key: 'partner-test-secret' } },
    { id: 'square', raw: { access_token: 'square-personal-access-token' } },
    { id: 'instacart-shopping', raw: { api_key: 'keys.1234567890abcdef1234567890abcdef' } },
    { id: 'reloadly', raw: { product: 'giftcards', client_id: 'reloadly-client', client_secret: 'reloadly-secret' } },
    { id: 'walmart-marketplace', raw: { market: 'ca', client_id: 'walmart-client', client_secret: 'walmart-secret' } },
    { id: 'ebay-seller', raw: { marketplace_id: 'EBAY_US', content_language: 'en-US', client_id: 'ebay-client', client_secret: 'ebay-secret', ru_name: 'Merchant-RuName' } },
    { id: 'amazon-seller-central', raw: { marketplace_id: 'ATVPDKIKX0DER', seller_id: 'A1SELLER23456789', client_id: 'amazon-client', client_secret: 'amazon-secret', refresh_token: 'Atzr|amazon-refresh-token-value-1234567890' } },
  ])('connects new $id accounts to production and rejects hidden environment overrides', ({ id, raw }) => {
    const catalog = entry(id);
    for (const value of ['sandbox', 'live', 'staging']) {
      expect(() => normalizeLocalApiConnectionInput(catalog, { ...raw, environment: value }))
        .toThrow('unknown connector parameter: environment');
    }
    // A rejected stale/tampered form does not prevent a fresh production-only retry.
    expect(normalizeLocalApiConnectionInput(catalog, raw).metadata.environment).toBe('live');
  });

  it('normalizes fixed tenant bindings and separates metadata from credentials', () => {
    expect(normalizeLocalApiConnectionInput(entry('commerce-layer'), {
      organization_slug: 'https://sample-shop.commercelayer.io',
      client_id: 'commerce-layer-client', client_secret: 'commerce-layer-secret',
    })).toEqual({
      metadata: { organization_slug: 'sample-shop' },
      credentials: { client_id: 'commerce-layer-client', client_secret: 'commerce-layer-secret' },
    });
    expect(normalizeLocalApiConnectionInput(entry('shopify-admin'), {
      shop_domain: 'https://My-Store.myshopify.com/',
      client_id: 'client-123',
      client_secret: 'super-secret-value',
    })).toEqual({
      metadata: { shop_domain: 'my-store.myshopify.com' },
      credentials: { client_id: 'client-123', client_secret: 'super-secret-value' },
    });
    expect(normalizeLocalApiConnectionInput(entry('lightspeed-x'), {
      store_domain: 'merchant', access_token: 'personal-token-value',
    })).toEqual({
      metadata: { store_domain: 'merchant.retail.lightspeed.app' },
      credentials: { access_token: 'personal-token-value' },
    });
    expect(normalizeLocalApiConnectionInput(entry('reloadly'), {
      product: 'giftcards',
      client_id: 'reloadly-client', client_secret: 'reloadly-secret',
    })).toMatchObject({
      metadata: { product: 'giftcards', environment: 'live' },
      credentials: { client_id: 'reloadly-client', client_secret: 'reloadly-secret' },
    });
    expect(normalizeLocalApiConnectionInput(entry('square'), {
      access_token: 'square-personal-access-token',
    })).toEqual({
      metadata: { environment: 'live' },
      credentials: { access_token: 'square-personal-access-token' },
    });
    expect(normalizeLocalApiConnectionInput(entry('instacart-shopping'), {
      api_key: 'keys.1234567890abcdef1234567890abcdef',
    })).toEqual({
      metadata: { environment: 'live' },
      credentials: { api_key: 'keys.1234567890abcdef1234567890abcdef' },
    });
    expect(normalizeLocalApiConnectionInput(entry('woocommerce'), {
      store_url: 'https://Shop.Example.com/wordpress/',
      consumer_key: `ck_${'a'.repeat(40)}`,
      consumer_secret: `cs_${'B'.repeat(40)}`,
    })).toEqual({
      metadata: { store_url: 'https://shop.example.com/wordpress' },
      credentials: {
        consumer_key: `ck_${'a'.repeat(40)}`,
        consumer_secret: `cs_${'B'.repeat(40)}`,
      },
    });
    expect(normalizeLocalApiConnectionInput(entry('walmart-marketplace'), {
      market: 'mx',
      client_id: 'walmart-seller-client', client_secret: 'walmart-seller-secret',
    })).toEqual({
      metadata: { environment: 'live', market: 'mx' },
      credentials: { client_id: 'walmart-seller-client', client_secret: 'walmart-seller-secret' },
    });
    expect(normalizeLocalApiConnectionInput(entry('ebay-seller'), {
      marketplace_id: 'EBAY_CA', content_language: 'fr-CA',
      client_id: 'ebay-client-id', client_secret: 'ebay-client-secret',
      ru_name: 'Orkas-Merchant-Redirect-Name',
    })).toEqual({
      metadata: { environment: 'live', marketplace_id: 'EBAY_CA', content_language: 'fr-CA' },
      credentials: {
        client_id: 'ebay-client-id', client_secret: 'ebay-client-secret',
        ru_name: 'Orkas-Merchant-Redirect-Name',
        redirect_uri: 'https://orkas.ai/api/connectors/oauth/dcr-callback',
      },
    });
    expect(normalizeLocalApiConnectionInput(entry('etsy-seller'), {
      shop_id: '12345678', keystring: 'etsykeystring123456', shared_secret: 'etsy-shared-secret',
    })).toEqual({
      metadata: { shop_id: '12345678' },
      credentials: {
        keystring: 'etsykeystring123456', shared_secret: 'etsy-shared-secret',
        redirect_uri: 'https://orkas.ai/api/connectors/oauth/dcr-callback',
      },
    });
    expect(normalizeLocalApiConnectionInput(entry('amazon-seller-central'), {
      marketplace_id: 'ATVPDKIKX0DER', seller_id: 'A1SELLER23456789',
      client_id: 'amzn1.application-oa2-client.test', client_secret: 'amazon-client-secret',
      refresh_token: 'Atzr|amazon-refresh-token-value-1234567890',
    })).toEqual({
      metadata: { environment: 'live', marketplace_id: 'ATVPDKIKX0DER', seller_id: 'A1SELLER23456789' },
      credentials: {
        client_id: 'amzn1.application-oa2-client.test', client_secret: 'amazon-client-secret',
        refresh_token: 'Atzr|amazon-refresh-token-value-1234567890',
      },
    });
    expect(normalizeLocalApiConnectionInput(entry('mercado-libre-global-selling'), {
      user_id: '1305627900', client_id: 'mercado-app-id', client_secret: 'mercado-client-secret',
    })).toEqual({
      metadata: { user_id: '1305627900' },
      credentials: {
        client_id: 'mercado-app-id', client_secret: 'mercado-client-secret',
        redirect_uri: 'https://orkas.ai/api/connectors/oauth/dcr-callback',
      },
    });
    expect(() => normalizeLocalApiConnectionInput(entry('commerce-layer'), {
      organization_slug: 'https://attacker.example.com',
      client_id: 'commerce-layer-client', client_secret: 'commerce-layer-secret',
    })).toThrow('invalid Commerce Layer organization slug');
    expect(() => normalizeLocalApiConnectionInput(entry('shopify-admin'), {
      shop_domain: 'store.myshopify.com.evil.test',
      client_id: 'client-123', client_secret: 'super-secret-value',
    })).toThrow('invalid Shopify shop domain');
    expect(() => normalizeLocalApiConnectionInput(entry('reloadly'), {
      product: 'wallet-admin',
      client_id: 'reloadly-client', client_secret: 'reloadly-secret',
    })).toThrow('invalid Reloadly product');
    expect(() => normalizeLocalApiConnectionInput(entry('instacart-shopping'), {
      api_key: 'not-an-instacart-key',
    })).toThrow('invalid Instacart API key');
    expect(() => normalizeLocalApiConnectionInput(entry('woocommerce'), {
      store_url: 'http://store.example.com', consumer_key: `ck_${'a'.repeat(40)}`,
      consumer_secret: `cs_${'b'.repeat(40)}`,
    })).toThrow('invalid WooCommerce store URL');
    expect(() => normalizeLocalApiConnectionInput(entry('woocommerce'), {
      store_url: 'https://127.0.0.1/store', consumer_key: `ck_${'a'.repeat(40)}`,
      consumer_secret: `cs_${'b'.repeat(40)}`,
    })).toThrow('invalid WooCommerce store URL');
    expect(() => normalizeLocalApiConnectionInput(entry('woocommerce'), {
      store_url: 'https://store.example.com/wp-json/wc/v3', consumer_key: `ck_${'a'.repeat(40)}`,
      consumer_secret: `cs_${'b'.repeat(40)}`,
    })).toThrow('invalid WooCommerce store URL');
    expect(() => normalizeLocalApiConnectionInput(entry('woocommerce'), {
      store_url: 'https://store.example.com', consumer_key: 'ck_not-real',
      consumer_secret: `cs_${'b'.repeat(40)}`,
    })).toThrow('invalid WooCommerce consumer key');
    expect(() => normalizeLocalApiConnectionInput(entry('walmart-marketplace'), {
      market: 'uk',
      client_id: 'walmart-seller-client', client_secret: 'walmart-seller-secret',
    })).toThrow('invalid Walmart market');
    expect(() => normalizeLocalApiConnectionInput(entry('ebay-seller'), {
      marketplace_id: 'EBAY_CA', content_language: 'en-US',
      client_id: 'ebay-client-id', client_secret: 'ebay-client-secret',
      ru_name: 'Orkas-Merchant-Redirect-Name',
    })).toThrow('listing language is not supported');
    expect(() => normalizeLocalApiConnectionInput(entry('ebay-seller'), {
      marketplace_id: 'EBAY_CA', content_language: 'fr-CA',
      client_id: 'ebay-client-id', client_secret: 'ebay-client-secret',
      ru_name: 'https://merchant.example/oauth',
    })).toThrow('invalid eBay RuName');
    expect(() => normalizeLocalApiConnectionInput(entry('etsy-seller'), {
      shop_id: '0', keystring: 'etsykeystring123456', shared_secret: 'etsy-shared-secret',
    })).toThrow('invalid Etsy shop ID');
    expect(() => normalizeLocalApiConnectionInput(entry('etsy-seller'), {
      shop_id: '12345678', keystring: 'etsykeystring123456', shared_secret: 'etsy-shared-secret',
      redirect_uri: 'http://127.0.0.1/oauth/etsy',
    })).toThrow('unknown connector parameter: redirect_uri');
    expect(() => normalizeLocalApiConnectionInput(entry('amazon-seller-central'), {
      marketplace_id: 'NOT_A_MARKETPLACE', seller_id: 'A1SELLER23456789',
      client_id: 'amazon-client-id', client_secret: 'amazon-client-secret',
      refresh_token: 'Atzr|amazon-refresh-token-value-1234567890',
    })).toThrow('invalid Amazon marketplace');
    expect(() => normalizeLocalApiConnectionInput(entry('amazon-seller-central'), {
      marketplace_id: 'ATVPDKIKX0DER', seller_id: 'seller with spaces',
      client_id: 'amazon-client-id', client_secret: 'amazon-client-secret',
      refresh_token: 'not-an-amazon-refresh-token',
    })).toThrow('invalid Amazon seller ID');
    expect(() => normalizeLocalApiConnectionInput(entry('mercado-libre-global-selling'), {
      user_id: '1305627900', client_id: 'mercado-app-id', client_secret: 'mercado-client-secret',
      redirect_uri: 'http://127.0.0.1/oauth/mercado-libre',
    })).toThrow('unknown connector parameter: redirect_uri');
  });

  it('binds direct-commerce network targets without exposing credentials', async () => {
    const commerceLayer = entry('commerce-layer');
    const commerceLayerMetadata = await authorizeLocalApi(TEST_UID, commerceLayer, {
      organization_slug: 'sample-shop',
      client_id: 'commerce-layer-client', client_secret: 'commerce-layer-secret',
    });
    const commerceLayerTransport = await localApiTransport(TEST_UID, commerceLayer, commerceLayerMetadata);
    if (commerceLayerTransport.kind !== 'stdio') throw new Error('expected Commerce Layer stdio transport');
    expect(commerceLayerTransport.proxyTargetUrl).toBe('https://auth.commercelayer.io/oauth/token');
    expect(JSON.stringify(commerceLayerTransport)).not.toContain('commerce-layer-secret');

    const woo = entry('woocommerce');
    const wooMetadata = await authorizeLocalApi(TEST_UID, woo, {
      store_url: 'https://shop.example.com/wordpress',
      consumer_key: `ck_${'a'.repeat(40)}`,
      consumer_secret: `cs_${'b'.repeat(40)}`,
    });
    const wooTransport = await localApiTransport(TEST_UID, woo, wooMetadata);
    if (wooTransport.kind !== 'stdio') throw new Error('expected WooCommerce stdio transport');
    expect(wooTransport.proxyTargetUrl).toBe('https://shop.example.com/wordpress/wp-json/wc/v3/system_status');
    expect(JSON.stringify(wooTransport)).not.toContain(`ck_${'a'.repeat(40)}`);
    expect(JSON.stringify(wooTransport)).not.toContain(`cs_${'b'.repeat(40)}`);

    const walmart = entry('walmart-marketplace');
    const walmartMetadata = await authorizeLocalApi(TEST_UID, walmart, {
      market: 'us',
      client_id: 'walmart-seller-client', client_secret: 'walmart-seller-secret',
    });
    const walmartTransport = await localApiTransport(TEST_UID, walmart, walmartMetadata);
    if (walmartTransport.kind !== 'stdio') throw new Error('expected Walmart stdio transport');
    expect(walmartTransport.proxyTargetUrl).toBe('https://marketplace.walmartapis.com/v3/token');
    expect(JSON.stringify(walmartTransport)).not.toContain('walmart-seller-secret');

    const amazon = entry('amazon-seller-central');
    const amazonMetadata = await authorizeLocalApi(TEST_UID, amazon, {
      marketplace_id: 'ATVPDKIKX0DER', seller_id: 'A1SELLER23456789',
      client_id: 'amazon-client-id', client_secret: 'amazon-client-secret',
      refresh_token: 'Atzr|amazon-refresh-token-value-1234567890',
    });
    const amazonTransport = await localApiTransport(TEST_UID, amazon, amazonMetadata);
    if (amazonTransport.kind !== 'stdio') throw new Error('expected Amazon stdio transport');
    expect(amazonTransport.proxyTargetUrl).toBe('https://api.amazon.com/auth/o2/token');
    expect(JSON.stringify(amazonTransport)).not.toContain('amazon-client-secret');
    expect(JSON.stringify(amazonTransport)).not.toContain('Atzr|');
  });

  it('stores only encrypted credentials locally and keeps the synced transport credential-free', async () => {
    const shopify = entry('shopify-admin');
    const metadata = await authorizeLocalApi(TEST_UID, shopify, {
      shop_domain: 'merchant', client_id: 'client-123', client_secret: 'super-secret-value',
    });
    const stored = localApiStoredTransport(TEST_UID, shopify);
    const live = await localApiTransport(TEST_UID, shopify, metadata);
    expect(hasLocalApiAuthorization(TEST_UID, shopify)).toBe(true);
    expect(stored).toEqual({
      kind: 'stdio',
      command: '/opt/orkas/runtime/node',
      args: [path.resolve(__dirname, '../../../../bin/direct-commerce-mcp-server.cjs')],
      cwd: localApiRuntimeDir(TEST_UID, 'shopify-admin'),
    });
    expect(stored.kind === 'stdio' ? stored.env : undefined).toBeUndefined();
    expect(live.kind).toBe('stdio');
    if (live.kind !== 'stdio') throw new Error('expected stdio transport');
    expect(live.env).toMatchObject({
      ORKAS_LOCAL_API_PROVIDER: 'shopify',
      ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(metadata),
      ORKAS_LOCAL_API_CREDENTIAL_FILE: expect.stringMatching(/credentials\.enc$/),
      ORKAS_LOCAL_API_CREDENTIAL_KEY: expect.any(String),
      HTTPS_PROXY: 'http://proxy.test',
    });
    const encrypted = fs.readFileSync(live.env!.ORKAS_LOCAL_API_CREDENTIAL_FILE, 'utf8');
    expect(encrypted).toMatch(/^ORKAPI1:/);
    expect(encrypted).not.toContain('client-123');
    expect(encrypted).not.toContain('super-secret-value');
    expect(codec.readCredentialFile(
      live.env!.ORKAS_LOCAL_API_CREDENTIAL_FILE,
      live.env!.ORKAS_LOCAL_API_CREDENTIAL_KEY,
    )).toEqual({
      provider: 'shopify', client_id: 'client-123', client_secret: 'super-secret-value',
    });
    if (process.platform !== 'win32') {
      expect(fs.statSync(live.env!.ORKAS_LOCAL_API_CREDENTIAL_FILE).mode & 0o777).toBe(0o600);
    }
  });

  it('carries the device code to the official browser page without requiring terminal output', () => {
    const device = { device_code: 'private-device-code', user_code: 'CODE-42' };
    expect(localApiAuth.constantContactVerificationUrl({ ...device,
      verification_uri: 'https://identity.constantcontact.com/activate',
    })).toBe('https://identity.constantcontact.com/activate?user_code=CODE-42');
    expect(localApiAuth.constantContactVerificationUrl({ ...device,
      verification_uri_complete: 'https://authz.constantcontact.com/activate?user_code=CODE-42',
    })).toBe('https://authz.constantcontact.com/activate?user_code=CODE-42');
    for (const verification_uri of [
      'https://identity.constantcontact.com.evil.test/activate',
      'https://identity.constantcontact.com/other',
      'https://identity.constantcontact.com/activate?user_code=WRONG',
      'https://identity.constantcontact.com/activate?user_code=CODE-42&user_code=CODE-42',
      'http://identity.constantcontact.com/activate',
    ]) {
      expect(() => localApiAuth.constantContactVerificationUrl({ ...device, verification_uri })).toThrow('invalid device authorization');
    }
  });

  it.each(['zh', 'en', 'ja', 'pt'] as const)('runs Constant Contact Device Flow with browser UI and %s guidance', async (lang) => {
    const config = await import('../../../../src/main/features/config');
    vi.spyOn(config, 'getLanguageForUser').mockReturnValue(lang);
    interactiveMocks.start.mockImplementation((options: { sandboxEnv: Record<string, string> }) => {
      codec.writeCredentialFile(
        options.sandboxEnv.ORKAS_LOCAL_API_CREDENTIAL_FILE,
        options.sandboxEnv.ORKAS_LOCAL_API_CREDENTIAL_KEY,
        {
          provider: 'constant_contact', client_id: options.sandboxEnv.ORKAS_LOCAL_API_CLIENT_ID,
          access_token: 'access-token', refresh_token: 'refresh-token', expires_at: Date.now() + 60_000,
        },
      );
      return { session_id: 'local-api-auth-session', status: 'running' };
    });

    await expect(authorizeLocalApi(TEST_UID, entry('constant-contact'), {
      client_id: 'constant-contact-client',
    })).resolves.toEqual({});
    expect(interactiveMocks.start).toHaveBeenCalledWith(expect.objectContaining({
      uid: TEST_UID,
      command: '/opt/orkas/runtime/node',
      args: [path.resolve(__dirname, '../../../../bin/local-api-auth.cjs')],
      presentation: 'browser_auth',
      sandboxEnv: expect.objectContaining({
        ORKAS_LOCAL_API_PROVIDER: 'constant_contact',
        ORKAS_LOCAL_API_CLIENT_ID: 'constant-contact-client',
        ORKAS_DEVICE_AUTH_CODE: { zh: '验证码：', en: 'Verification code:', ja: '認証コード：', pt: 'Código de verificação:' }[lang],
        ORKAS_DEVICE_AUTH_WAITING: { zh: '正在等待授权…', en: 'Waiting for authorization…', ja: '認証を待っています…', pt: 'Aguardando autorização…' }[lang],
        ORKAS_LOCAL_API_CREDENTIAL_KEY: expect.any(String),
        HTTPS_PROXY: 'http://proxy.test',
      }),
    }));
    expect(interactiveMocks.wait).toHaveBeenCalledWith(TEST_UID, 'local-api-auth-session');
    expect(hasLocalApiAuthorization(TEST_UID, entry('constant-contact'))).toBe(true);
  });

  // The former terminal-only seller test is superseded by user-owned-app_e2e_authorization.test.ts,
  // which exercises the real browser relay, provider exchange, encrypted store and MCP runtime.

  it('removes only the selected connector credential directory', () => {
    const shopifyDir = localApiRuntimeDir(TEST_UID, 'shopify-admin');
    const siblingDir = localApiRuntimeDir(TEST_UID, 'lightspeed-x');
    fs.mkdirSync(shopifyDir, { recursive: true });
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(shopifyDir, 'marker'), 'shopify');
    fs.writeFileSync(path.join(siblingDir, 'marker'), 'lightspeed');

    removeLocalApiAuthorization(TEST_UID, entry('shopify-admin'));

    expect(fs.existsSync(shopifyDir)).toBe(false);
    expect(fs.readFileSync(path.join(siblingDir, 'marker'), 'utf8')).toBe('lightspeed');
    expect(() => localApiRuntimeDir(TEST_UID, '../escape')).toThrow('invalid local API catalog id');
  });
});
