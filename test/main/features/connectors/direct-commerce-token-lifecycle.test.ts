import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config as merchantConfig, rows, providerReply } from './merchant-platform-fixtures';

const require = createRequire(import.meta.url);
const codec = require('../../../../bin/local-api-credential-codec.cjs');
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const directories: string[] = [];
const ebayScope = ['sell.account', 'sell.inventory', 'sell.fulfillment']
  .map(scope => `https://api.ebay.com/oauth/api_scope/${scope}`).join(' ');
const kuaishouScope = 'user_base user_info merchant_user merchant_item merchant_order merchant_refund merchant_logistics';
const nativeRotations = [
  { provider: 'taobao_top', credentials: { app_key: 'fixture-app', app_secret: 'fixture-secret', identity: { user_id: '123', nick: 'Fixture' } }, metadata: {}, action: 'account.get',
    identity: { user_seller_get_response: { user: { user_id: '123', nick: 'Fixture' } } } },
  { provider: 'alibaba_1688', credentials: { app_key: 'fixture-app', app_secret: 'fixture-secret', identity: { member_id: 'fixture-member' } }, metadata: {}, action: 'account.get',
    identity: { result: { memberId: 'fixture-member' } } },
  { provider: 'jd_jos', credentials: { app_key: 'fixture-app', app_secret: 'fixture-secret', identity: { vender_id: '123', shop_id: '456' } }, metadata: {}, action: 'account.get',
    identity: { seller_vender_info_get_response: { vender_info_result: { data: { vender_id: '123', shop_id: '456' } } } } },
  { provider: 'pinduoduo', credentials: { client_id: 'fixture-client', client_secret: 'fixture-secret', identity: { mall_id: '123' } }, metadata: {}, action: 'account.get',
    identity: { mall_info_get_response: { mall_id: '123' } } },
  { provider: 'douyin_shop', credentials: { app_key: 'fixture-app', app_secret: 'fixture-secret', identity: { shop_id: '123' } }, metadata: { shop_id: '123' }, action: 'products.list',
    identity: { code: 10000, data: { auth_id: '123', status: 1 } } },
  { provider: 'kuaishou_shop', credentials: { app_key: 'fixture-app', app_secret: 'fixture-secret', sign_secret: 'fixture-sign-secret', identity: { open_id: 'fixture-seller', shop_id: '123' } }, metadata: {}, action: 'products.list',
    identity: { result: 1, data: { openId: 'fixture-seller', sellerId: 123, shopName: 'Fixture shop', shopType: 5 } } },
];
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function environment(provider: string, credentials: Record<string, unknown>, metadata = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-token-lifecycle-'));
  directories.push(directory);
  const file = path.join(directory, 'credentials.enc');
  const key = crypto.randomBytes(32).toString('base64url');
  codec.writeCredentialFile(file, key, { provider, ...credentials });
  return { ORKAS_LOCAL_API_PROVIDER: provider, ORKAS_LOCAL_API_CREDENTIAL_FILE: file,
    ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(metadata) };
}
const stored = (env: ReturnType<typeof environment>) => codec.readCredentialFile(
  env.ORKAS_LOCAL_API_CREDENTIAL_FILE, env.ORKAS_LOCAL_API_CREDENTIAL_KEY);
function ebay() {
  const metadata = { environment: 'sandbox', marketplace_id: 'EBAY_US', content_language: 'en-US' };
  return environment('ebay', { client_id: 'fixture-client', client_secret: 'fixture-secret',
    scope: ebayScope, identity: metadata, access_token: 'old-access-fixture',
    refresh_token: 'old-refresh-fixture', expires_at: 0 }, metadata);
}
function kuaishou() {
  return environment('kuaishou_shop', { app_key: 'fixture-app', app_secret: 'fixture-secret',
    sign_secret: 'fixture-sign-secret', access_token: 'old-access-fixture', refresh_token: 'old-refresh-fixture',
    expires_at: 0, scope: kuaishouScope, identity: { open_id: 'fixture-seller', shop_id: '123' } });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  while (directories.length) fs.rmSync(directories.pop()!, { recursive: true, force: true });
});

describe('direct commerce authorization continuity', () => {
  it.each(['ebay', 'etsy', 'constant_contact'])('shares one %s refresh across simultaneous reads and the next request', async provider => {
    const env = provider === 'ebay' ? ebay() : environment(provider, {
      client_id: 'fixture-client', keystring: 'fixturekey', shared_secret: 'fixture-secret',
      access_token: 'old-access-fixture', refresh_token: 'old-refresh-fixture', expires_at: 0,
      scope: provider === 'etsy' ? 'shops_r shops_w listings_r listings_w listings_d transactions_r transactions_w'
        : 'account_read contact_data campaign_data offline_access', identity: { shop_id: '67890', user_id: '12345' },
    }, provider === 'etsy' ? { shop_id: '67890' } : {});
    let tokenRequests = 0;
    const fetchMock = vi.fn(async (raw: string) => {
      if (new URL(raw).pathname.endsWith('/token')) {
        tokenRequests++;
        await new Promise(resolve => setTimeout(resolve, 10));
        return reply({ access_token: `${provider === 'etsy' ? '12345.' : ''}rotated-access`,
          refresh_token: 'rotated-refresh', expires_in: 3600, scope: stored(env).scope });
      }
      return reply({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const action = provider === 'ebay' ? 'account.privileges' : provider === 'etsy' ? 'shop.get' : 'account.get';
    await Promise.all([1, 2, 3].map(() => adapter.callTool('execute_read', { action }, env)));
    await adapter.callTool('execute_read', { action }, env);
    expect(tokenRequests).toBe(1);
    expect(stored(env).refresh_token).toBe('rotated-refresh');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each(['invalid-expiry', 0, -1, null, 1e30, true, [3600]].map(expires_in => ({ expires_in })))('rejects malformed expiry $expires_in before saving or issuing a business request', async ({ expires_in }) => {
    const env = ebay(), previous = stored(env);
    const fetchMock = vi.fn(async () => reply({ access_token: 'rotated-access', expires_in, scope: ebayScope }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await adapter.callToolResult('execute_read', { action: 'account.privileges' }, env);
    expect(result).toMatchObject({ isError: true, _meta: { orkas: { errorCode: 'E_TOOL_CALL_UPSTREAM' } } });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(stored(env)).toEqual(previous);
  });

  it('reports an OAuth invalid_grant as authorization failure without exposing provider details', async () => {
    const env = ebay(), previous = stored(env);
    const fetchMock = vi.fn(async () => reply({ error: 'invalid_grant', error_description: 'private-fixture-detail' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const result = await adapter.callToolResult('execute_read', { action: 'account.privileges' }, env);
    expect(result).toMatchObject({ isError: true, _meta: { orkas: { errorCode: 'E_TOOL_CALL_AUTH' } } });
    expect(JSON.parse(result.content[0].text).error_code).toBe('connector_reconnect_required');
    expect(JSON.stringify(result)).not.toContain('private-fixture-detail');
    expect(stored(env)).toEqual(previous);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([503, 429])('keeps HTTP %s during refresh actionable without claiming the grant was revoked', async status => {
    const env = ebay(), previous = stored(env);
    vi.stubGlobal('fetch', vi.fn(async () => reply({}, status)));
    const result = await adapter.callToolResult('execute_read', { action: 'account.privileges' }, env);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error_code).toBe('direct_commerce_action_failed');
    expect(stored(env)).toEqual(previous);
  });

  it('invalidates a revoked cached Amazon access token for the next explicit read without replaying the failed call', async () => {
    const env = environment('amazon_seller', { client_id: 'fixture-client', client_secret: 'fixture-secret',
      refresh_token: 'Atzr|fixture-refresh-token-value-1234567890' },
    { environment: 'live', marketplace_id: 'ATVPDKIKX0DER', seller_id: 'A1FIXTURESELLER' });
    let tokens = 0, reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (raw: string) => {
      if (new URL(raw).pathname.endsWith('/auth/o2/token')) return reply({ access_token: `access-${++tokens}`, expires_in: 3600 });
      reads++;
      return reads === 1 ? reply({}, 401) : reply({ payload: [] });
    }));
    await expect(adapter.callTool('execute_read', { action: 'account.marketplace_participations' }, env)).rejects.toMatchObject({ code: 'E_TOOL_CALL_AUTH' });
    expect(reads).toBe(1);
    await adapter.callTool('execute_read', { action: 'account.marketplace_participations' }, env);
    expect(tokens).toBe(2);
    expect(reads).toBe(2);
  });

  it('never replays a failed eBay inventory replacement and refreshes only on the next explicit request', async () => {
    const env = ebay();
    codec.writeCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, env.ORKAS_LOCAL_API_CREDENTIAL_KEY,
      { ...stored(env), expires_at: Date.now() + 3600_000 });
    let tokens = 0, writes = 0;
    vi.stubGlobal('fetch', vi.fn(async (raw: string, init: RequestInit) => {
      if (new URL(raw).pathname.endsWith('/token')) { tokens++; return reply({ access_token: 'rotated-access', expires_in: 3600, scope: ebayScope }); }
      if (init.method === 'PUT') { writes++; return reply({}, 401); }
      return reply({});
    }));
    await expect(adapter.callTool('execute_high_impact', { action: 'inventory_items.replace', parameters: {
      sku: 'SKU-1', body: { availability: { shipToLocationAvailability: { quantity: 8 } } },
    } }, env)).rejects.toMatchObject({ code: 'E_TOOL_CALL_AUTH' });
    expect(writes).toBe(1);
    expect(tokens).toBe(0);
    await adapter.callTool('execute_read', { action: 'account.privileges' }, env);
    expect(tokens).toBe(1);
    expect(writes).toBe(1);
  });

  it.each(nativeRotations)('recovers $provider rotation after identity IO failed without reusing the consumed grant', async row => {
    const env = environment(row.provider, { ...row.credentials, access_token: 'old-access-fixture',
      refresh_token: 'old-refresh-fixture', expires_at: 0, refresh_expires_at: Date.now() + 86400_000, scope: kuaishouScope }, row.metadata);
    let tokens = 0, identityAvailable = false;
    vi.stubGlobal('fetch', vi.fn(async (raw: string, init: RequestInit = {}) => {
      const url = new URL(raw);
      const form = new URLSearchParams(typeof init.body === 'string' ? init.body : '');
      const isToken = url.hostname.startsWith('oauth.') || url.hostname.startsWith('open-oauth.')
        || url.pathname.includes('/getToken/') || url.pathname.endsWith('/refresh_token')
        || url.pathname === '/token/refresh' || form.get('type') === 'pdd.pop.auth.token.refresh';
      if (isToken) {
        tokens++;
        if (tokens > 1) return reply({}, 401);
        const token = { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 7200,
          re_expires_in: 86400, open_id: 'fixture-seller', scopes: kuaishouScope };
        return reply(row.provider === 'kuaishou_shop' ? { result: 1, data: token }
          : row.provider === 'douyin_shop' ? { code: 10000, data: token }
            : row.provider === 'pinduoduo' ? { pop_auth_token_refresh_response: token } : token);
      }
      if (!identityAvailable) throw new Error('fixture identity connection unavailable');
      return reply(row.identity);
    }));
    await expect(adapter.callTool('execute_read', { action: row.action }, env)).rejects.toMatchObject({ code: 'E_TOOL_CALL_NETWORK' });
    // The verified grant remains unchanged; only an encrypted recovery record may contain the candidate.
    expect(stored(env).refresh_token).toBe('old-refresh-fixture');
    for (const file of fs.readdirSync(path.dirname(env.ORKAS_LOCAL_API_CREDENTIAL_FILE))) {
      expect(fs.readFileSync(path.join(path.dirname(env.ORKAS_LOCAL_API_CREDENTIAL_FILE), file), 'utf8')).not.toContain('rotated-refresh');
    }
    identityAvailable = true;
    const result = await adapter.callTool('execute_read', { action: row.action }, env);
    expect(result).toMatchObject({ provider: row.provider, risk: 'R' });
    expect(tokens).toBe(1);
    expect(stored(env).refresh_token).toBe('rotated-refresh');
  });

  it('keeps a candidate for a different shop blocked on repeated calls', async () => {
    const env = kuaishou(), previous = stored(env);
    let tokens = 0, business = 0;
    vi.stubGlobal('fetch', vi.fn(async (raw: string) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/refresh_token')) { tokens++; return reply({ result: 1, data: {
        access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 7200, scopes: kuaishouScope } }); }
      const method = url.searchParams.get('method');
      if (method === 'open.user.seller.get') return reply({ result: 1, data: { openId: 'fixture-seller', sellerId: 999 } });
      if (method === 'open.shop.info.get') return reply({ result: 1, data: { shopName: 'Other shop', shopType: 5 } });
      business++; return reply({ result: 1, data: {} });
    }));
    for (let i = 0; i < 2; i++) await expect(adapter.callTool('execute_read', { action: 'products.list' }, env)).rejects.toThrow(/different shop/);
    expect(tokens).toBe(1);
    expect(business).toBe(0);
    expect(stored(env)).toEqual(previous);
  });

  it('keeps the inherited Kuaishou refresh deadline and rejects fabricated or revoked scopes before business IO', async () => {
    const env = kuaishou(), deadline = Date.now() + 3600_000;
    codec.writeCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, env.ORKAS_LOCAL_API_CREDENTIAL_KEY, { ...stored(env), refresh_expires_at: deadline });
    let scopes: unknown = kuaishouScope.split(' '), result = 1;
    const requests = vi.fn(async (raw: string) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/refresh_token')) return reply({ result, data: { access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 7200, scopes } });
      if (url.pathname.endsWith('/seller/get')) return reply({ result: 1, data: { openId: 'fixture-seller', sellerId: 123 } });
      if (url.pathname.endsWith('/info/get')) return reply({ result: 1, data: { shopName: 'Fixture shop', shopType: 5 } });
      return reply({ result: 1, data: { items: [] } });
    });
    vi.stubGlobal('fetch', requests);
    await adapter.callTool('execute_read', { action: 'products.list' }, env);
    expect(stored(env).refresh_expires_at).toBe(deadline);
    expect(stored(env).scope.split(',')).toEqual(kuaishouScope.split(' '));
    for (const invalid of [undefined, [], 'user_base']) {
      scopes = invalid;
      const isolated = kuaishou(), before = stored(isolated), count = requests.mock.calls.length;
      await expect(adapter.callTool('execute_read', { action: 'products.list' }, isolated)).rejects.toMatchObject({ code: 'E_TOOL_CALL_AUTH' });
      expect(stored(isolated)).toEqual(before);
      expect(requests.mock.calls.length).toBe(count + 1);
    }
    result = 0; scopes = kuaishouScope;
    const isolated = kuaishou(), before = stored(isolated);
    await expect(adapter.callTool('execute_read', { action: 'products.list' }, isolated)).rejects.toMatchObject({ code: 'E_TOOL_CALL_AUTH' });
    expect(stored(isolated)).toEqual(before);
  });

  it.each(['base_shop', 'yahoo_shopping', 'aliexpress'])('recovers %s identity verification with the pending grant', async provider => {
    const api = require(`../../../../bin/${provider === 'base_shop' ? 'base-shop-api' : provider === 'yahoo_shopping' ? 'yahoo-shopping-api' : 'aliexpress-seller-api'}.cjs`);
    const initial = provider === 'aliexpress' ? merchantConfig(rows.find(row => row.provider === provider)!) : {
      provider, metadata: provider === 'yahoo_shopping' ? { seller_id: 'lifecycle-fixture' } : {},
      credentials: { client_id: 'fixture-client', client_secret: 'fixture-secret', redirect_uri: 'https://orkas.ai/api/connectors/oauth/dcr-callback' }, oauthCode: 'fixture-code',
    };
    let authorizing = true, identityAvailable = true, rotations = 0;
    vi.stubGlobal('fetch', vi.fn(async (raw: string, init: RequestInit = {}) => {
      const url = new URL(raw), token = url.pathname.endsWith('/token') || url.pathname.includes('/auth/token/');
      if (token) {
        if (!authorizing) { rotations++; if (rotations > 1) return reply({}, 401); }
        return provider === 'aliexpress' ? reply(providerReply(provider, raw, init)) : reply({ access_token: authorizing ? 'previous-access' : 'rotated-access',
          refresh_token: authorizing ? 'previous-refresh' : 'rotated-refresh', expires_in: 3600 });
      }
      if (!identityAvailable) throw new Error('Fixture identity connection unavailable');
      if (provider === 'aliexpress') return reply(providerReply(provider, raw, init));
      if (provider === 'yahoo_shopping') return new Response('<ResultSet totalResultsAvailable="0"/>');
      return reply(url.pathname.endsWith('/users/me') ? { user: { shop_id: 'fixture-shop' } }
        : url.pathname.endsWith('/items') ? { items: [] } : { orders: [] });
    }));
    const credentials = await api.authorize(initial);
    const env = environment(provider, { ...credentials, expires_at: Date.now() - 1 }, initial.metadata);
    const previous = stored(env);
    authorizing = false;
    identityAvailable = false;
    await expect(adapter.callTool('execute_read', { action: 'shop.get' }, env)).rejects.toThrow();
    expect(stored(env)).toEqual(previous);
    identityAvailable = true;
    await adapter.callTool('execute_read', { action: 'shop.get' }, env);
    expect(rotations).toBe(1);
    expect(stored(env).refresh_token).not.toBe(previous.refresh_token);
  });
});
