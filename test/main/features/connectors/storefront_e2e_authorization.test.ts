import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Combined setup -> official identity/read probes -> real encrypted file -> restarted
// direct-commerce adapter. Only OS key wrapping and external services are faked.
const mocks = vi.hoisted(() => ({ channel: 'open', open: vi.fn(), proxy: vi.fn(async (_url: string) => ({})) }));
vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: mocks.open } }));
vi.mock('../../../../src/main/features/account/server', () => ({ accountApiBase: () => 'https://orkas.test/api' }));
vi.mock('../../../../src/main/features/account/token_store', () => ({ getDeviceId: () => 'storefront-fixture', authHeaders: () => ({}) }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'en', getLanguageForUser: () => 'en' }));
vi.mock('../../../../src/main/features/api_common', () => ({ withCommonHeaders: (headers: object) => ({ ...headers, 'Orkas-Channel': mocks.channel }) }));
vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({ broadcastOAuthConnectProgress: vi.fn() }));
vi.mock('../../../../src/main/util/background-node', () => ({ resolveBackgroundNodeRuntime: () => ({ executable: process.execPath, electronAsNode: false }), withBackgroundNodeEnv: (env: object) => env }));
vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({ buildChildProxyEnvironment: mocks.proxy }));
vi.mock('../../../../src/main/util/local-secret-store', () => ({
  encryptLocalSecret: (_context: unknown, value: string) => `TEST:${value}`,
  decryptLocalSecret: (_context: unknown, value: string) => value.slice(5),
}));
vi.mock('../../../../src/main/model/core-agent/interactive-cli-sessions', () => ({
  startInteractiveCliSession: () => { throw new Error('Storefront setup must not install or launch a CLI'); },
  waitInteractiveCliSession: vi.fn(),
}));

import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { authorizeLocalApi, hasLocalApiAuthorization, localApiRuntimeDir, localApiTransport, normalizeLocalApiConnectionInput, removeLocalApiAuthorization } from '../../../../src/main/features/connectors/local-api';
import { cancelDcrOAuth } from '../../../../src/main/features/connectors/oauth-dcr';
import { broadcastOAuthConnectProgress } from '../../../../src/main/features/connectors/oauth-events';

const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const codec = require('../../../../bin/local-api-credential-codec.cjs');
const { CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js');
const UID = 'storefront-journey-fixture';
const TOKEN = 'private-storefront-fixture-token';
const providers = ['bigcommerce', 'shopline', 'shoplazza'];
const entry = (id: string) => findCatalogEntry(id)!;
const input = (id: string) => ({ access_token: TOKEN, ...(id === 'bigcommerce' ? { store_hash: 'https://api.bigcommerce.com/stores/abc123/v3/' } : { store_domain: 'fixture' }) });

function installProviderFixture(provider: string) {
  const fetchMock = vi.fn(async (target: string) => {
    const url = new URL(target);
    expect(url.hostname).toBe(provider === 'bigcommerce' ? 'api.bigcommerce.com' : provider === 'shopline' ? 'fixture.myshopline.com' : 'fixture.myshoplaza.com');
    let body: unknown;
    const shop = { id: '123', name: 'Fixture store', currency: 'USD' };
    if (url.pathname.endsWith('/store') || url.pathname.endsWith('/shop') || url.pathname.endsWith('/shop.json')) body = provider === 'shopline' ? { data: shop } : shop;
    else if (url.pathname.endsWith('/orders') || url.pathname.endsWith('/orders.json')) body = provider === 'bigcommerce' ? [] : { orders: [] };
    else if (url.pathname.endsWith('/locations') || url.pathname.endsWith('/locations/list.json')) body = provider === 'bigcommerce' ? { data: [] } : { locations: [] };
    else if (url.pathname.endsWith('/products') || url.pathname.endsWith('/products/products.json')) body = provider === 'bigcommerce' ? { data: [{ id: 123, name: 'Product' }], meta: { pagination: { current_page: 1, total_pages: 1 } } } : { products: [{ id: '123', title: 'Product' }] };
    else throw new Error('Unexpected fixture API route');
    return new Response(JSON.stringify(provider === 'shoplazza' ? { code: '', message: '', data: body } : body), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  cancelDcrOAuth();
  for (const id of providers) removeLocalApiAuthorization(UID, entry(id));
  vi.unstubAllGlobals(); vi.clearAllMocks();
});

describe.each(['open', 'commercial'])('storefront credential journey (%s channel)', (channel) => {
  it.each(providers)('%s setup verifies access, persists only encrypted token and restarts through the shared adapter', async (provider) => {
    mocks.channel = channel;
    const fetchMock = installProviderFixture(provider);
    const e = entry(provider);
    const metadata = await authorizeLocalApi(UID, e, input(provider), { attemptId: 'storefront-attempt' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(mocks.open).not.toHaveBeenCalled();
    expect(broadcastOAuthConnectProgress).toHaveBeenCalledWith({ attempt_id: 'storefront-attempt', catalog_id: provider });
    expect(hasLocalApiAuthorization(UID, e)).toBe(true);
    expect(metadata).toEqual(provider === 'bigcommerce' ? { store_hash: 'abc123' } : { store_domain: `fixture.${provider === 'shopline' ? 'myshopline' : 'myshoplaza'}.com` });
    const transport = await localApiTransport(UID, e, metadata);
    expect(transport.kind).toBe('stdio');
    if (transport.kind !== 'stdio') throw new Error('Expected existing stdio transport');
    expect(transport.args?.[0]).toMatch(/direct-commerce-mcp-server\.cjs$/);
    expect(mocks.proxy).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/(?:api.bigcommerce.com\/stores\/abc123|fixture.myshopline.com\/admin\/openapi\/v20260901|fixture.myshoplaza.com\/openapi\/2026-01)$/));
    const env = transport.env!;
    const encrypted = fs.readFileSync(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, 'utf8');
    expect(encrypted).toMatch(/^ORKAPI1/);
    expect(encrypted).not.toContain(TOKEN);
    expect(JSON.stringify(metadata)).not.toMatch(/token|secret|identity/);
    const stored = codec.readCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, env.ORKAS_LOCAL_API_CREDENTIAL_KEY);
    expect(stored).toMatchObject({ provider, access_token: TOKEN, identity: { shop_id: '123', binding: Object.values(metadata)[0] } });
    if (process.platform !== 'win32') {
      expect(fs.statSync(env.ORKAS_LOCAL_API_CREDENTIAL_FILE).mode & 0o777).toBe(0o600);
      expect(fs.statSync(localApiRuntimeDir(UID, e.id)).mode & 0o777).toBe(0o700);
    }
    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities.actions).toHaveLength(provider === 'shoplazza' ? 11 : 10);
    expect(capabilities.identity.shop_id).toBe('123');
    const read = await adapter.callTool('execute_read', { action: 'products.list', parameters: { limit: 1 } }, env);
    expect(JSON.stringify(read)).toContain('Product');
    const before = fetchMock.mock.calls.length;
    await expect(adapter.callTool('execute_read', { action: 'inventory.set', parameters: {} }, env)).rejects.toThrow(/risk mismatch/);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    const tampered = { ...env, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(provider === 'bigcommerce' ? { store_hash: 'other' } : { store_domain: `other.${provider === 'shopline' ? 'myshopline' : 'myshoplaza'}.com` }) };
    await expect(adapter.callTool('execute_read', { action: 'products.list' }, tampered)).rejects.toThrow(/binding/);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    removeLocalApiAuthorization(UID, e);
    expect(hasLocalApiAuthorization(UID, e)).toBe(false);
  });
});

describe('storefront setup failures and catalog contract', () => {
  it.each(providers)('%s does not misclassify a business error or invalid JSON as missing permissions', async (provider) => {
    const fetchMock = installProviderFixture(provider);
    const metadata = await authorizeLocalApi(UID, entry(provider), input(provider));
    const transport = await localApiTransport(UID, entry(provider), metadata);
    if (transport.kind !== 'stdio') throw new Error('Expected shared stdio transport');
    for (const [body, errorCode] of [[JSON.stringify({ error: TOKEN }), 'storefront_request_failed'], ['not-json', 'storefront_upstream_error']]) {
      fetchMock.mockImplementationOnce(async () => new Response(body, { status: 200 }));
      const result = CallToolResultSchema.parse(JSON.parse(JSON.stringify(
        await adapter.callToolResult('execute_read', { action: 'products.list', parameters: { limit: 1 } }, transport.env),
      )));
      expect(result.isError).toBe(true);
      expect(result).toMatchObject({ isError: true, _meta: { orkas: { errorCode } } });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  it.each(providers)('%s failed permission probe never persists a grant or echoes provider secrets', async (provider) => {
    const fetchMock = installProviderFixture(provider);
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ error: TOKEN }), { status: 403 }));
    await expect(authorizeLocalApi(UID, entry(provider), input(provider))).rejects.toMatchObject({ code: 'storefront_permission_denied', message: expect.stringContaining('permissions listed') });
    expect(hasLocalApiAuthorization(UID, entry(provider))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not persist a valid identity when the order permission probe fails', async () => {
    const mock = installProviderFixture('shopline');
    const fixture = mock.getMockImplementation()!;
    mock.mockImplementation(async (target) => target.includes('/orders.json') ? new Response('{}', { status: 403 }) : fixture(target));
    await expect(authorizeLocalApi(UID, entry('shopline'), input('shopline'))).rejects.toMatchObject({ code: 'storefront_permission_denied' });
    expect(hasLocalApiAuthorization(UID, entry('shopline'))).toBe(false);
  });

  it('rejects hidden sandbox, callback and credential overrides before any network request', async () => {
    const mock = vi.fn(); vi.stubGlobal('fetch', mock);
    for (const extra of [{ environment: 'sandbox' }, { redirect_uri: 'https://evil.test' }, { api_url: 'https://evil.test' }]) {
      expect(() => normalizeLocalApiConnectionInput(entry('shopline'), { ...input('shopline'), ...extra })).toThrow();
    }
    expect(mock).not.toHaveBeenCalled();
  });

  it('discards a late authorization result after the user cancels setup', async () => {
    const mock = installProviderFixture('shopline');
    const fixture = mock.getMockImplementation()!;
    let release: () => void = () => {};
    const pendingReply = new Promise<void>((resolve) => { release = resolve; });
    mock.mockImplementationOnce(async (target) => { await pendingReply; return fixture(target); });
    const pending = authorizeLocalApi(UID, entry('shopline'), input('shopline'));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'user_cancelled' });
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(1));
    cancelDcrOAuth();
    release();
    await rejected;
    await vi.waitFor(() => expect(mock).toHaveBeenCalledTimes(4));
    expect(hasLocalApiAuthorization(UID, entry('shopline'))).toBe(false);
  });

  it.each([
    ['bigcommerce', 'https://docs.bigcommerce.com/', '00b74026ec5fb4f3599063d082dcb9b88b8220809b04c9652ea89fa6667f3887', '8ddc67ee730c9d92c491bbbd33b533295e9e6dd9c32f14a42f6b6c157a0cf9fb'],
    ['shopline', 'https://s2cdn.myshopline.com/slfs/op-new/175585091795902/brand.png', 'eafdfd5c153706130436a2e61b16ec05db80a932ca6e499c414651f51ee3fde8', 'b922d06b98418af21a4a2148b287521b4074cc7df6eae52a27db13790da7cee0'],
    ['shoplazza', 'https://www.shoplazza.dev/img/favicon.png', 'b3fd8be9c3603388f813d6968cd5bf6e35e3a71bd6f0b9d233d83fa2f9915ce0', '300209812c65df5e918a3befdd7c754934564c02cbffa3a3e16ba4a287d5b775'],
  ])('pins both official asset provenance and rendered SVG for %s', (id, url, sourceHash, svgHash) => {
    expect(entry(id)).toMatchObject({ icon_source_url: url, icon_source_sha256: sourceHash });
    expect(createHash('sha256').update(entry(id).icon_svg!).digest('hex')).toBe(svgHash);
  });

  it('shows all fields together with localized guidance, safe policy lanes and authentic icon hashes', () => {
    const seen = new Set();
    for (const provider of providers) {
      const e = entry(provider);
      const setup = e.connection_setup!;
      expect(setup.fields).toHaveLength(2);
      expect(setup.callback_url).toBeUndefined();
      expect(setup.fields.some((field) => field.input === 'choice')).toBe(false);
      expect(e.auth_mode).toBe('local_api');
      expect(e.composio).toBeUndefined();
      expect(e.allowed_tools).toEqual(['list_capabilities', 'describe_action', 'execute_read', 'execute_high_impact']);
      expect(e.tool_policies?.execute_high_impact).toMatchObject({ risk: 'H', confirmation: 'fresh' });
      for (const locale of ['zh', 'en', 'ja', 'pt']) {
        expect((e as any)[`description_${locale}`]).toBeTruthy();
        expect((setup as any)[`instructions_${locale}`]).toBeTruthy();
        expect((setup as any)[`guide_label_${locale}`]).toBeTruthy();
        for (const field of setup.fields) {
          expect((field as any)[`label_${locale}`]).toBeTruthy();
          expect((field as any)[`help_${locale}`]).toBeTruthy();
        }
        const dictionary = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../../src/main/locales/${locale}.json`), 'utf8'));
        expect(dictionary['connectors.storefront.permission_denied']).toBeTruthy();
      }
      expect(e.icon_source_url).toMatch(/^https:\/\//);
      expect(e.icon_source_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(seen.has(e.icon_source_sha256)).toBe(false);
      seen.add(e.icon_source_sha256);
    }
  });
});
