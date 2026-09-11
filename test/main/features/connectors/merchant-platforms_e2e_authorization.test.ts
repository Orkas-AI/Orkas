import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rows, installFixture, providerReply, TOKEN, SECRET, Row } from './merchant-platform-fixtures';

const mocks = vi.hoisted(() => ({ channel: 'open', open: vi.fn(async (_url: string) => undefined) }));
vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: mocks.open } }));
vi.mock('../../../../src/main/features/connectors/_server_bridge', () => ({ accountApiBase: () => 'https://orkas.ai/api', tokenStore: { getDeviceId: () => 'merchant-journey-device', authHeaders: () => ({}) } }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'en', getLanguageForUser: () => 'en' }));
vi.mock('../../../../src/main/features/api_common', () => ({ withCommonHeaders: (headers: object) => ({ ...headers, 'Orkas-Channel': mocks.channel }) }));
vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({ broadcastOAuthConnectProgress: vi.fn() }));
vi.mock('../../../../src/main/util/background-node', () => ({ resolveBackgroundNodeRuntime: () => ({ executable: process.execPath, electronAsNode: false }), withBackgroundNodeEnv: (env: object) => env }));
vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({ buildChildProxyEnvironment: async () => ({}) }));
vi.mock('../../../../src/main/util/local-secret-store', () => ({ encryptLocalSecret: (_context: unknown, value: string) => `TEST:${value}`, decryptLocalSecret: (_context: unknown, value: string) => value.slice(5) }));
vi.mock('../../../../src/main/model/core-agent/interactive-cli-sessions', () => ({ startInteractiveCliSession: () => { throw new Error('Merchant connectors must not launch a CLI'); }, waitInteractiveCliSession: vi.fn() }));

import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { authorizeLocalApi, hasLocalApiAuthorization, localApiTransport, normalizeLocalApiConnectionInput, removeLocalApiAuthorization } from '../../../../src/main/features/connectors/local-api';
import { cancelDcrOAuth, handleDcrCallbackUrl, LOCAL_API_REDIRECT_URI } from '../../../../src/main/features/connectors/oauth-dcr';
import { broadcastOAuthConnectProgress } from '../../../../src/main/features/connectors/oauth-events';
const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const codec = require('../../../../bin/local-api-credential-codec.cjs');
const { CallToolResultSchema } = require('@modelcontextprotocol/sdk/types.js');
const UID = 'merchant-journey-fixture';
const entry = (row: Row) => findCatalogEntry(row.id)!;
function openedQuery() {
  const url = new URL(mocks.open.mock.calls.at(-1)![0]);
  return url.hash ? new URLSearchParams(url.hash.split('?')[1]) : url.searchParams;
}
function boundary(row: Row, mode = '') {
  const fetchMock = installFixture(row);
  fetchMock.mockImplementation(async (url, init) => {
    if (new URL(String(url)).pathname.endsWith('/dcr-exchange')) return new Response(JSON.stringify({ code: 0, oauth_code: 'one-use-code', oauth_state: mode === 'state' ? 'wrong-state' : openedQuery().get('state') }));
    if (mode === 'permission') return new Response(JSON.stringify({ message: TOKEN }), { status: 403 });
    return new Response(JSON.stringify(providerReply(row.provider, url, init)));
  });
  return fetchMock;
}
const callback = () => handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=merchant-single-use-receipt');
async function connect(row: Row) {
  const flow = authorizeLocalApi(UID, entry(row), row.input, { attemptId: 'merchant-attempt' });
  if (row.host) { await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled()); await callback(); }
  const metadata = await flow;
  const transport = await localApiTransport(UID, entry(row), metadata);
  if (transport.kind !== 'stdio') throw new Error('Expected shared stdio transport');
  return { metadata, env: transport.env! };
}
afterEach(() => { cancelDcrOAuth(); rows.forEach(row => removeLocalApiAuthorization(UID, entry(row))); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe.each(['open'])('remaining merchant journey (%s)', (channel) => {
  it.each(rows)('$id completes the combined form, authorization, encrypted persistence, restarted read and correct risk lane', async (row) => {
    mocks.channel = channel;
    const fetchMock = boundary(row);
    const { metadata, env } = await connect(row);
    expect(metadata).toEqual(row.metadata);
    expect(fetchMock).toHaveBeenCalledTimes(row.authCalls + (row.host ? 1 : 0));
    expect(hasLocalApiAuthorization(UID, entry(row))).toBe(true);
    expect(broadcastOAuthConnectProgress).toHaveBeenCalledWith({ attempt_id: 'merchant-attempt', catalog_id: row.id });
    if (row.host) {
      const url = new URL(mocks.open.mock.calls[0][0]);
      expect(url.hostname).toBe(row.host);
      const query = openedQuery();
      expect(query.get('state')).toBeTruthy();
      expect(row.provider === 'shein' ? Buffer.from(query.get('redirectUrl')!, 'base64').toString() : query.get('redirect_uri')).toBe(LOCAL_API_REDIRECT_URI);
      expect(url.toString()).not.toContain(SECRET);
      // Relay carries only a one-use receipt; never the app secret or access grant.
      expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ exchange_code: 'merchant-single-use-receipt', device_id: 'merchant-journey-device' });
    } else expect(mocks.open).not.toHaveBeenCalled();
    const encrypted = fs.readFileSync(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, 'utf8');
    expect(encrypted).toMatch(/^ORKAPI1:/);
    expect(encrypted).not.toMatch(/merchant-private|merchant-fixture-secret|one-use-code/);
    expect(JSON.stringify(metadata)).not.toMatch(/secret|token|identity/);
    const caps = await adapter.callTool('list_capabilities', {}, env);
    expect(caps.actions).toHaveLength(row.count);
    expect(JSON.stringify(caps)).not.toMatch(/merchant-private|merchant-fixture-secret/);
    const read = await adapter.callTool('execute_read', { action: 'products.list', parameters: { limit: 1 } }, env);
    expect(JSON.stringify(read)).toContain('Fixture product');
    const before = fetchMock.mock.calls.length;
    const highAction = caps.actions.find((action: any) => action.risk === 'H').action;
    await expect(adapter.callTool('execute_read', { action: highAction, parameters: {} }, env)).rejects.toThrow(/risk mismatch/);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    removeLocalApiAuthorization(UID, entry(row));
    expect(hasLocalApiAuthorization(UID, entry(row))).toBe(false);
  });
});

describe('merchant setup and callback failures', () => {
  it.each(rows)('$id preserves failure causes through the MCP result envelope and recovers on the next user request', async (row) => {
    const fetchMock = boundary(row);
    const { env } = await connect(row);
    const healthy = fetchMock.getMockImplementation()!;
    // A connected seller requests products; only the remote HTTP boundary fails.
    // The SDK-visible envelope, adapter execution remain real.
    for (const [fault, errorCode] of [
      [403, 'storefront_permission_denied'],
      [429, 'storefront_rate_limit'],
      [503, 'storefront_upstream_error'],
      ['network', 'storefront_network_failed'],
    ] as const) {
      fetchMock.mockImplementationOnce(async () => {
        if (fault === 'network') throw new Error(`fetch failed ${TOKEN}`);
        return new Response(JSON.stringify({ message: TOKEN }), { status: fault });
      });
      const before = fetchMock.mock.calls.length;
      const result = CallToolResultSchema.parse(JSON.parse(JSON.stringify(
        await adapter.callToolResult('execute_read', { action: 'products.list', parameters: { limit: 1 } }, env),
      )));
      expect(result.isError).toBe(true);
      expect(result._meta).toEqual({ orkas: { errorCode } });
      expect(fetchMock).toHaveBeenCalledTimes(before + 1);
      expect(JSON.stringify(result)).not.toMatch(/merchant-private|merchant-fixture-secret/);
    }
    fetchMock.mockImplementation(healthy);
    const recovered = await adapter.callToolResult('execute_read', { action: 'products.list', parameters: { limit: 1 } }, env);
    expect(recovered.isError).toBeUndefined();
    expect(recovered._meta).toBeUndefined();
    expect(JSON.parse(recovered.content[0].text).result).toBeTruthy();
  });

  it.each(rows)('$id never saves a failed grant and gives a localized, redacted permission error', async (row) => {
    const fetchMock = boundary(row, 'permission');
    const flow = authorizeLocalApi(UID, entry(row), row.input);
    const rejected = expect(flow).rejects.toMatchObject({ code: 'storefront_permission_denied', message: expect.stringContaining('permissions listed') });
    if (row.host) await callback();
    await rejected;
    expect(hasLocalApiAuthorization(UID, entry(row))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(row.host ? 2 : 1);
  });
  it.each(rows.filter(row => row.host))('$id rejects state mismatch before disclosing app secrets', async (row) => {
    const fetchMock = boundary(row, 'state');
    const flow = authorizeLocalApi(UID, entry(row), row.input);
    const rejected = expect(flow).rejects.toThrow();
    await callback(); await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hasLocalApiAuthorization(UID, entry(row))).toBe(false);
  });
  it.each(rows)('$id rejects hidden environment, callback and endpoint overrides', (row) => {
    for (const override of [{ environment: 'sandbox' }, { redirect_uri: 'https://evil.example' }, { endpoint: 'https://evil.example' }]) expect(() => normalizeLocalApiConnectionInput(entry(row), { ...row.input, ...override })).toThrow();
  });
  it.each(rows.filter(row => row.host))('$id discards callbacks after cancellation', async (row) => {
    const fetchMock = boundary(row);
    const flow = authorizeLocalApi(UID, entry(row), row.input);
    const rejected = expect(flow).rejects.toMatchObject({ code: 'user_cancelled' });
    cancelDcrOAuth(); await rejected;
    await callback();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(hasLocalApiAuthorization(UID, entry(row))).toBe(false);
  });
});

describe.each(rows.filter(row => ['lazada', 'alibaba_icbu', 'aliexpress'].includes(row.provider)))('$provider encrypted token rotation', (row) => {
  it('coalesces concurrent refreshes, preserves the absolute grant deadline and restarts with the new encrypted token', async () => {
    const mock = boundary(row);
    const { env } = await connect(row);
    const c = adapter.configured(env);
    const deadline = Date.now() + 3600000;
    codec.writeCredentialFile(c.credentialFile, c.credentialKey, { ...c.credentials, expires_at: Date.now() - 1, refresh_expires_at: deadline });
    mock.mockClear();
    const reads = await Promise.all([1, 2, 3].map(() => adapter.callTool('execute_read', { action: 'products.list', parameters: { limit: 1 } }, env)));
    expect(reads.every(read => JSON.stringify(read).includes('Fixture product'))).toBe(true);
    const refreshCalls = mock.mock.calls.filter(([url, init]) => String(url).endsWith('/auth/token/refresh') || new URLSearchParams(init?.body as string).get('grant_type') === 'refresh_token');
    expect(refreshCalls).toHaveLength(1);
    const restarted = adapter.configured(env);
    expect(restarted.credentials.access_token).toBe(TOKEN + '-rotated');
    expect(restarted.credentials.refresh_expires_at).toBe(deadline);
    expect(fs.readFileSync(c.credentialFile, 'utf8')).not.toContain(TOKEN);
  });
  it('rejects a changed subject during refresh without overwriting the original grant', async () => {
    const mock = boundary(row);
    const { env } = await connect(row);
    const c = adapter.configured(env);
    const original = { ...c.credentials, expires_at: Date.now() - 1 };
    codec.writeCredentialFile(c.credentialFile, c.credentialKey, original);
    mock.mockImplementationOnce(async (url, init) => {
      const body: any = providerReply(row.provider, url, init);
      if (row.provider === 'lazada') body.country_user_info_list = [{ country: 'sg', seller_id: '456' }];
      else if (row.provider === 'aliexpress') body.seller_id = '456';
      else body.taobao_user_id = '456';
      return new Response(JSON.stringify(body));
    });
    await expect(adapter.callTool('execute_read', { action: 'products.list', parameters: {} }, env)).rejects.toThrow(/changed/);
    expect(codec.readCredentialFile(c.credentialFile, c.credentialKey)).toEqual(original);
  });
});

it('AliExpress does not persist authorization when the final order permission probe fails', async () => {
  const row = rows.find(row => row.provider === 'aliexpress')!;
  const mock = boundary(row);
  const normal = mock.getMockImplementation()!;
  mock.mockImplementation(async (url, init) => new URLSearchParams(init?.body as string).get('method') === 'aliexpress.solution.order.get'
    ? new Response(JSON.stringify({ error_response: { code: 'InsufficientPermission', msg: TOKEN } })) : normal(url, init));
  const flow = authorizeLocalApi(UID, entry(row), row.input);
  const rejected = expect(flow).rejects.toMatchObject({ code: 'storefront_permission_denied' });
  await callback(); await rejected;
  expect(hasLocalApiAuthorization(UID, entry(row))).toBe(false);
});

it('AliExpress rejects a changed shop after refresh before replacing the encrypted grant', async () => {
  const row = rows.find(row => row.provider === 'aliexpress')!;
  const mock = boundary(row);
  const { env } = await connect(row);
  const c = adapter.configured(env);
  const original = { ...c.credentials, expires_at: Date.now() - 1 };
  codec.writeCredentialFile(c.credentialFile, c.credentialKey, original);
  mock.mockImplementationOnce(async (url, init) => new Response(JSON.stringify(providerReply(row.provider, url, init))));
  mock.mockResolvedValueOnce(new Response(JSON.stringify({ aliexpress_solution_merchant_profile_get_response: { shop_id: 999 } })));
  await expect(adapter.callTool('execute_read', { action: 'products.list', parameters: {} }, env)).rejects.toThrow(/shop changed/);
  expect(codec.readCredentialFile(c.credentialFile, c.credentialKey)).toEqual(original);
});

it('all remaining cards have concise four-locale setup, only production and official artwork provenance', () => {
  const artwork = {"magento":{"source":"0e2bc36e1a03cbf59a03ea1a49623ddddfe00423d097fc630940c5ea9b385df8","rendered":"82ae19c9c1f52035881bccf1a2010914a16491aa27f0ff0d33bcdb25e46c1951"},"temu-seller":{"source":"01e915e404fc70129df11cde9bab723b0915eeda382ce29e608dd0674c37b583","rendered":"32a015f2ab782250b67ee0cc015b102103f7d519a7c7b16dc0862180f52a2523"},"lazada-seller":{"source":"c61dcbeb5aa0e08d13cf54bdedc00ff0ca96d6c82a40de9606d9686e0d0fffad","rendered":"1b039aa29850261b5c0d48746becd8131092da2a03616ef589a8240d35d6b35f"},"shein-seller":{"source":"0777198f884eb762b7aade99c7fb4bff6a7cff7d9cdce494f1d2493827b193c1","rendered":"c1ba254354b0f032b2926cc47ef500b0e6f4740f9c35cc2ead3e37535720ccaa"},"alibaba-com-seller":{"source":"c5aac0e85f3aed73f4a1d70635619a6afdeb610b4c5d120e8121be02c3bd5a2f","rendered":"710de3c6cb6934f14bf638d3a528b4447da327f0f7aaee5f42f1c3b82b03368a"},"aliexpress-seller":{"source":"ef181e9b6a58d8f36ebfc6acd589d2f94d371af0cb2c68e17032edebdaed99a0","rendered":"ac437eb0ebbe75c9b57131b1b93bbd82d4e250e5d1a4fef1802e1553ce0b3f03"}};
  for (const row of rows) {
    const card = entry(row), setup = card.connection_setup!;
    expect(card.composio).toBeUndefined();
    expect(setup.fields.map(field => field.key).sort()).toEqual(Object.keys(row.input).sort());
    expect(Boolean(setup.callback_url)).toBe(Boolean(row.host));
    expect(card.tool_policies?.execute_high_impact).toMatchObject({ risk: 'H', confirmation: 'fresh' });
    for (const lang of ['zh', 'en', 'ja', 'pt']) {
      expect((card as any)[`description_${lang}`]).toBeTruthy();
      expect((setup as any)[`instructions_${lang}`]).toBeTruthy();
      expect((setup as any)[`instructions_${lang}`].length).toBeLessThan(800);
      for (const field of setup.fields) { expect((field as any)[`label_${lang}`]).toBeTruthy(); expect((field as any)[`help_${lang}`]).toBeTruthy(); }
    }
    expect(card.icon_source_url).toMatch(/^https:\/\//);
    expect(card.icon_source_sha256).toBe(artwork[row.id].source);
    expect(createHash('sha256').update(card.icon_svg!).digest('hex')).toBe(artwork[row.id].rendered);
    expect(setup.fields.flatMap(field => field.options?.map(option => option.value) || [])).not.toContain('sandbox');
  }
});
