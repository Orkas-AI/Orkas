import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Journey coverage: combined setup -> browser -> relay -> shop verification -> encrypted
// grant -> existing MCP actions. External boundaries are fake; no real store is contacted.
const mocks = vi.hoisted(() => ({ open: vi.fn(async (_url: string) => undefined) }));
vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: mocks.open } }));
vi.mock('../../../../src/main/features/connectors/_server_bridge', () => ({ accountApiBase: () => 'https://orkas.ai/api', tokenStore: { getDeviceId: () => 'seller-test-device', authHeaders: () => ({}) } }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'en', getLanguageForUser: () => 'en' }));
vi.mock('../../../../src/main/features/api_common', () => ({ withCommonHeaders: (headers: object) => ({ ...headers, 'Orkas-Channel': 'open' }) }));
vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({ broadcastOAuthConnectProgress: vi.fn() }));
vi.mock('../../../../src/main/util/background-node', () => ({
  resolveBackgroundNodeRuntime: () => ({ executable: process.execPath, electronAsNode: false }),
  withBackgroundNodeEnv: (env: object) => env,
}));
vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({ buildChildProxyEnvironment: async () => ({}) }));
vi.mock('../../../../src/main/util/local-secret-store', () => ({
  encryptLocalSecret: (_context: unknown, value: string) => `TEST:${value}`,
  decryptLocalSecret: (_context: unknown, value: string) => value.slice(5),
}));
vi.mock('../../../../src/main/model/core-agent/interactive-cli-sessions', () => ({
  startInteractiveCliSession: () => { throw new Error('Seller authorization must not prompt in a terminal'); },
  waitInteractiveCliSession: vi.fn(),
}));

import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { authorizeLocalApi, hasLocalApiAuthorization, localApiRuntimeDir, localApiTransport,
  normalizeLocalApiConnectionInput, removeLocalApiAuthorization } from '../../../../src/main/features/connectors/local-api';
import { cancelDcrOAuth, handleDcrCallbackUrl, LOCAL_API_REDIRECT_URI } from '../../../../src/main/features/connectors/oauth-dcr';
import { cancelInFlightOAuth } from '../../../../src/main/features/connectors/oauth';
import { broadcastOAuthConnectProgress } from '../../../../src/main/features/connectors/oauth-events';

const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');

const UID = 'user-app-e2e-test';
const app = { app_key: 'approved-app', app_secret: 'private-app-secret' };
const client = { client_id: 'approved-client', client_secret: 'private-client-secret' };
const grant = { access_token: 'access-private', refresh_token: 'refresh-private', expires_in: 7200 };
const cases = [
  { id: 'ebay-seller', provider: 'ebay', host: 'auth.ebay.com',
    input: { ...client, marketplace_id: 'EBAY_US', content_language: 'en-US', ru_name: 'Merchant-RuName-123' },
    replies: [grant, { sellingLimit: { quantity: 50 } }] },
  { id: 'etsy-seller', provider: 'etsy', host: 'www.etsy.com',
    input: { shop_id: '67890', keystring: 'approvedkeystring', shared_secret: 'private-shared-secret' },
    replies: [{ ...grant, access_token: '12345.access-private' }, { shop_id: 67890, user_id: 12345, shop_name: 'Fixture shop' }] },
  { id: 'mercado-libre-global-selling', provider: 'mercado_libre', host: 'global-selling.mercadolibre.com',
    input: { ...client, user_id: '12345' },
    replies: [{ ...grant, user_id: 12345 }, { id: 12345, nickname: 'Fixture seller' }] },
  { id: 'taobao-tmall-seller', provider: 'taobao_top', host: 'oauth.taobao.com', input: app,
    replies: [{ ...grant, taobao_user_id: '12345' }, { user_seller_get_response: { user: { user_id: 12345, nick: 'Fixture shop', has_shop: true } } }] },
  { id: 'alibaba-1688-seller', provider: 'alibaba_1688', host: 'auth.1688.com', input: app,
    replies: [{ ...grant, memberId: 'member12345' }, { result: { memberId: 'member12345', loginId: 'Fixture seller' } }] },
  { id: 'jd-seller', provider: 'jd_jos', host: 'open-oauth.jd.com', input: app,
    replies: [grant, { jingdong_seller_vender_info_get_responce: { vender_info_result: { vender_id: '12345', shop_id: '67890' } } }] },
  { id: 'pinduoduo-seller', provider: 'pinduoduo', host: 'fuwu.pinduoduo.com', input: client,
    replies: [{ pop_auth_token_create_response: { ...grant, owner_id: '67890' } }, { mall_info_get_response: { mall_id: '67890', mall_name: 'Fixture shop' } }] },
  { id: 'kuaishou-shop-seller', provider: 'kuaishou_shop', host: 'open.kwaixiaodian.com',
    input: { ...app, sign_secret: 'private-sign-secret' },
    replies: [{ ...grant, open_id: 'seller12345' }, { result: 1, data: { open_id: 'seller12345' } }, { result: 1, data: { shop_id: '67890' } }] },
  { id: 'douyin-shop-seller', provider: 'douyin_shop', host: '', input: { ...app, shop_id: '67890' },
    replies: [{ code: 10000, data: { ...grant, shop_id: '67890' } }, { code: 10000, data: { auth_id: '67890', status: 1 } }] },
  { id: 'youzan-seller', provider: 'youzan', host: '', input: { ...client, kdt_id: '67890' },
    replies: [{ data: { ...grant, authority_id: '67890' } }, { data: { kdt_id: '67890', name: 'Fixture shop' } }] },
  { id: 'weimob-wos-seller', provider: 'weimob_wos', host: '', input: { ...client, shop_id: '67890' },
    replies: [{ data: { ...grant, business_operation_system_id: '67890' } }, { code: { errcode: 0 }, data: { list: [] } }] },
  { id: 'xiaohongshu-seller', provider: 'xiaohongshu_ark', host: '', input: app,
    replies: [{ success: true, data: { items: [] } }] },
];
function json(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
}
function opened() { return new URL(mocks.open.mock.calls.at(-1)![0]); }
function boundary(row: typeof cases[number], mode = '') {
  let index = 0;
  const requests = vi.fn(async (raw: string | URL, init: any) => {
    const url = new URL(String(raw));
    if (url.pathname.endsWith('/dcr-exchange')) return json({
      code: 0, oauth_code: 'one-time-code',
      oauth_state: mode === 'state' ? 'wrong-state' : opened().searchParams.get('state'),
    });
    if (mode === 'reject') return json({ error: 'private-client-secret access-private' }, 403);
    const reply = row.replies[Math.min(index++, row.replies.length - 1)];
    return json(mode === 'identity' && index >= row.replies.length ? {} : reply);
  });
  vi.stubGlobal('fetch', requests);
  return requests;
}
const callback = () => handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=one-time-relay');
beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  cancelDcrOAuth();
  for (const row of cases) removeLocalApiAuthorization(UID, findCatalogEntry(row.id)!);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('user-owned app authorization journey', () => {
  it('exposes the complete credential panel and pins callbacks only for browser providers', () => {
    // Short copy is intentional; assert the platform prerequisite, not prose length.
    const prerequisites: Record<string, [RegExp, RegExp]> = {
      'ebay-seller': [/eBay Developers Program 应用/, /eBay Developers Program app/],
      'etsy-seller': [/Seller API Access/, /approved for Seller API Access/],
      'mercado-libre-global-selling': [/KYC.*主账号/, /KYC-approved.*owner account/],
      'taobao-tmall-seller': [/已获批.*应用/, /approved.*app/],
      'alibaba-1688-seller': [/匹配的解决方案.*审核/, /matching solution.*APIs approved/],
      'jd-seller': [/应用.*审批/, /app.*approval/],
      'pinduoduo-seller': [/开发者认证.*应用/, /verified.*developer.*app/],
      'kuaishou-shop-seller': [/App Secret 与 Sign Secret 不可互换/, /App Secret and Sign Secret are not interchangeable/],
      'douyin-shop-seller': [/企业资质.*软件著作权/, /business verification.*software copyright required/],
      'youzan-seller': [/已绑定店铺.*应用/, /app bound to the store/],
      'weimob-wos-seller': [/已绑定 WOS 店铺/, /app bound to the WOS store/],
      'xiaohongshu-seller': [/正式 Ark.*凭据/, /production Ark.*credentials/],
    };
    for (const row of cases) {
      const entry = findCatalogEntry(row.id)!;
      const setup = entry.connection_setup!;
      expect(setup.fields.map((field) => field.key).sort()).toEqual(Object.keys(row.input).sort());
      expect(setup.guide_url).toMatch(/^https:\/\//);
      expect(setup.instructions_zh).toMatch(prerequisites[row.id][0]);
      expect(setup.instructions_en).toMatch(prerequisites[row.id][1]);
      expect(setup.instructions_zh).not.toContain(LOCAL_API_REDIRECT_URI);
      expect(setup.instructions_en).not.toContain(LOCAL_API_REDIRECT_URI);
      for (const field of setup.fields) {
        if (field.storage !== 'credential') continue;
        expect(field.help_zh).toBeTruthy();
        expect(field.help_en).toBeTruthy();
        if (field.key.includes('secret')) expect(field.input).toBe('secret');
      }
      expect(setup.callback_url).toBe(row.host ? LOCAL_API_REDIRECT_URI : undefined);
      const input = normalizeLocalApiConnectionInput(entry, row.input);
      expect(input.credentials.redirect_uri).toBe(row.host ? LOCAL_API_REDIRECT_URI : undefined);
      expect(() => normalizeLocalApiConnectionInput(entry, { ...row.input, redirect_uri: 'https://attacker.example' }))
        .toThrow('unknown connector parameter: redirect_uri');
    }
    for (const id of ['commerce-layer', 'shopify-admin', 'amazon-seller-central', 'constant-contact']) {
      expect(findCatalogEntry(id)!.connection_setup!.callback_url).toBeUndefined();
    }
  });

  it.each(cases)('connects $id without a terminal and hands encrypted credentials to the existing runtime', async (row) => {
    const requests = boundary(row);
    const entry = findCatalogEntry(row.id)!;
    const flow = authorizeLocalApi(UID, entry, row.input, { attemptId: 'app-attempt' });
    if (row.host) {
      const url = opened();
      expect(url.hostname).toBe(row.host);
      expect(url.protocol).toBe('https:');
      expect(url.searchParams.get('state')).toMatch(/^[\w-]{40,}$/);
      expect(url.toString()).not.toMatch(/private|secret|access_token/);
      expect(url.searchParams.get('redirect_uri')).toBe(row.provider === 'ebay' ? 'Merchant-RuName-123' : LOCAL_API_REDIRECT_URI);
      expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
      await callback();
      expect(broadcastOAuthConnectProgress).toHaveBeenCalledWith({ attempt_id: 'app-attempt', catalog_id: row.id });
      const relayRequest = requests.mock.calls[0];
      expect(String(relayRequest[0])).toBe('https://orkas.ai/api/connectors/oauth/dcr-exchange');
      expect(JSON.parse(relayRequest[1].body)).toEqual({ exchange_code: 'one-time-relay', device_id: 'seller-test-device' });
      if (['etsy', 'mercado_libre'].includes(row.provider)) {
        const verifier = new URLSearchParams(requests.mock.calls[1][1].body).get('code_verifier')!;
        expect(require('node:crypto').createHash('sha256').update(verifier).digest('base64url'))
          .toBe(url.searchParams.get('code_challenge'));
      }
    } else expect(mocks.open).not.toHaveBeenCalled();
    const metadata = await flow;
    expect(hasLocalApiAuthorization(UID, entry)).toBe(true);
    expect(requests.mock.calls).toHaveLength(row.replies.length + (row.host ? 1 : 0));
    for (const [raw, init] of requests.mock.calls.slice(row.host ? 1 : 0)) {
      expect(new URL(String(raw)).protocol).toBe('https:');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeDefined();
    }
    const transport = await localApiTransport(UID, entry, metadata);
    expect(transport.kind).toBe('stdio');
    if (transport.kind !== 'stdio') throw new Error('Expected stdio runtime');
    const encrypted = fs.readFileSync(path.join(localApiRuntimeDir(UID, row.id), 'credentials.enc'), 'utf8');
    expect(encrypted).toMatch(/^ORKAPI1:/);
    expect(encrypted).not.toMatch(/private|secret|access_token/);
    expect(JSON.stringify(metadata)).not.toMatch(/secret|access_token|refresh_token/);
    const config = adapter.configured(transport.env);
    expect(config.provider).toBe(row.provider);
    expect(config.credentials.provider).toBe(row.provider);
    // A fresh device-only transport can reopen the exact persisted grant.
    const second = await localApiTransport(UID, entry, metadata);
    expect(adapter.configured(second.env).credentials).toEqual(config.credentials);
  });

  it.each(cases)('rejects $id platform errors without retaining or exposing credentials', async (row) => {
    boundary(row, 'reject');
    const entry = findCatalogEntry(row.id)!;
    const flow = authorizeLocalApi(UID, entry, row.input);
    const rejected = expect(flow).rejects.toThrow('Could not authorize');
    if (row.host) await callback();
    await rejected;
    expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
  });

  it.each(cases.filter(row => row.host))('rejects a wrong $id state before sending app secrets', async (row) => {
    const requests = boundary(row, 'state');
    const entry = findCatalogEntry(row.id)!;
    const flow = authorizeLocalApi(UID, entry, row.input);
    const rejected = expect(flow).rejects.toThrow('Could not authorize');
    await callback();
    await rejected;
    expect(requests).toHaveBeenCalledTimes(1);
    expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
  });

  it.each(cases.filter(row => ['etsy', 'mercado_libre', 'taobao_top', 'alibaba_1688', 'jd_jos', 'pinduoduo', 'kuaishou_shop', 'douyin_shop'].includes(row.provider)))(
    'rejects missing or mismatched $id identity instead of saving the token', async (row) => {
      boundary(row, 'identity');
      const entry = findCatalogEntry(row.id)!;
      const flow = authorizeLocalApi(UID, entry, row.input);
      const rejected = expect(flow).rejects.toThrow('Could not authorize');
      if (row.host) await callback();
      await rejected;
      expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
    });

  it('cancels browser authorization without saving or calling the platform', async () => {
    const row = cases[0];
    const requests = boundary(row);
    const entry = findCatalogEntry(row.id)!;
    const flow = authorizeLocalApi(UID, entry, row.input);
    const rejected = expect(flow).rejects.toMatchObject({ code: 'user_cancelled' });
    cancelInFlightOAuth();
    await rejected;
    expect(requests).not.toHaveBeenCalled();
    expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
  });

  it('cancels a self-use token request and ignores its late successful result', async () => {
    const row = cases.find(value => value.provider === 'douyin_shop')!;
    const entry = findCatalogEntry(row.id)!;
    const ordinaryFetch = boundary(row);
    let release!: (response: unknown) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    vi.stubGlobal('fetch', vi.fn((raw: string | URL, init: any) => {
      if (new URL(String(raw)).pathname === '/token/create') {
        started();
        return new Promise(resolve => { release = resolve; });
      }
      return Promise.resolve(json(row.replies[1]));
    }));
    const flow = authorizeLocalApi(UID, entry, row.input, { attemptId: 'self-attempt' });
    const rejected = expect(flow).rejects.toMatchObject({ code: 'user_cancelled' });
    await startedPromise;
    expect(broadcastOAuthConnectProgress).toHaveBeenCalledWith({ attempt_id: 'self-attempt', catalog_id: row.id });
    cancelInFlightOAuth();
    await rejected;
    release(json(row.replies[0]));
    // Drain the external response and identity check; the cancelled owner cannot publish it.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
    vi.stubGlobal('fetch', ordinaryFetch);
    await expect(authorizeLocalApi(UID, entry, row.input)).resolves.toEqual({ shop_id: '67890' });
    expect(hasLocalApiAuthorization(UID, entry)).toBe(true);
  });
});
