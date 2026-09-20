import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ open: vi.fn(async (_url: string) => undefined) }));
vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: mocks.open } }));
vi.mock('../../../../src/main/features/account/server', () => ({ accountApiBase: () => 'https://orkas.test/api' }));
vi.mock('../../../../src/main/features/account/token_store', () => ({ getDeviceId: () => 'base-fixture-device', authHeaders: () => ({}) }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'en', getLanguageForUser: () => 'en' }));
vi.mock('../../../../src/main/features/api_common', () => ({ withCommonHeaders: (headers: object) => ({ ...headers, 'Orkas-Channel': 'open' }) }));
vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({ broadcastOAuthConnectProgress: vi.fn() }));
vi.mock('../../../../src/main/util/background-node', () => ({ resolveBackgroundNodeRuntime: () => ({ executable: process.execPath, electronAsNode: false }), withBackgroundNodeEnv: (env: object) => env }));
vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({ buildChildProxyEnvironment: async () => ({}) }));
vi.mock('../../../../src/main/util/local-secret-store', () => ({ encryptLocalSecret: (_context: unknown, value: string) => `TEST:${value}`, decryptLocalSecret: (_context: unknown, value: string) => value.slice(5) }));
vi.mock('../../../../src/main/model/core-agent/interactive-cli-sessions', () => ({ startInteractiveCliSession: () => { throw new Error('No CLI authorization'); }, waitInteractiveCliSession: vi.fn() }));
import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { authorizeLocalApi, hasLocalApiAuthorization, localApiTransport, normalizeLocalApiConnectionInput, removeLocalApiAuthorization } from '../../../../src/main/features/connectors/local-api';
import { cancelDcrOAuth, handleDcrCallbackUrl, LOCAL_API_REDIRECT_URI } from '../../../../src/main/features/connectors/oauth-dcr';
const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const codec = require('../../../../bin/local-api-credential-codec.cjs');
const UID = 'base-shop-journey-fixture';
const entry = findCatalogEntry('base-shop')!;
const input = { client_id: 'base-fixture-client', client_secret: 'base-fixture-private-secret' };
const TOKEN = 'base-fixture-private-token';
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function fixture() {
  const fetchMock = vi.fn(async (raw: string, init: RequestInit = {}) => {
    const url = new URL(raw);
    if (url.pathname.endsWith('/dcr-exchange')) return reply({ code: 0, oauth_code: 'base-one-use-code',
      oauth_state: new URL(mocks.open.mock.calls.at(-1)![0]).searchParams.get('state') });
    expect(url.origin).toBe('https://api.thebase.in');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('error');
    if (url.pathname === '/1/oauth/token') return reply({ access_token: TOKEN, refresh_token: 'base-fixture-refresh', expires_in: 3600 });
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    if (url.pathname === '/1/users/me') return reply({ user: { shop_id: 'fixture-shop', mail_address: 'private@example.test' } });
    if (url.pathname === '/1/items') return reply({ items: [{ item_id: 1234, title: 'Fixture product', stock: 30 }] });
    if (url.pathname === '/1/orders') return reply({ orders: [{ unique_key: 'ORDER1', total: 2000, first_name: 'Private', tel: 'Private', remark: 'Private' }] });
    if (url.pathname === '/1/items/detail/1234') return reply({ item: { item_id: 1234, stock: 30, variations: [{ variation_id: 11, variation_stock: 30 }] } });
    if (url.pathname === '/1/items/edit_stock') return reply({ item: { item_id: 1234, stock: 0, variations: [{ variation_id: 11, variation_stock: 0 }] } });
    throw new Error('Unexpected BASE route');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
async function connect() {
  const flow = authorizeLocalApi(UID, entry, input);
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
  await handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=base-fixture-receipt');
  const metadata = await flow;
  const transport = await localApiTransport(UID, entry, metadata);
  if (transport.kind !== 'stdio') throw new Error('Expected stdio');
  return transport.env!;
}
afterEach(() => { cancelDcrOAuth(); removeLocalApiAuthorization(UID, entry); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('BASE shop authorization and merchant operations', () => {
  it('classifies official HTTP 400 authorization and quota errors without disclosing provider text or retrying', async () => {
    // Official API overview: errors use HTTP 400, including invalid_request (invalid token)
    // and hour_api_limit/day_api_limit. Confirmed invalid_request with an unauthenticated live read.
    const fetchMock = fixture(); const env = await connect(); fetchMock.mockClear();
    for (const [error, code] of [['invalid_request', 'E_TOOL_CALL_AUTH'], ['invalid_scope', 'E_TOOL_CALL_AUTH'],
      ['hour_api_limit', 'E_TOOL_CALL_RATE_LIMIT'], ['day_api_limit', 'E_TOOL_CALL_RATE_LIMIT'], ['bad_params', 'E_BAD_INPUT']]) {
      fetchMock.mockResolvedValueOnce(reply({ error, error_description: TOKEN }, 400));
      const result = await adapter.callToolResult('execute_read', { action: 'products.list' }, env);
      expect(result).toMatchObject({ isError: true, _meta: { orkas: { errorCode: code } } });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it('authorizes the shop, encrypts credentials, reads after restart and updates only the intended variation', async () => {
    const fetchMock = fixture();
    const env = await connect();
    const auth = new URL(mocks.open.mock.calls[0][0]);
    expect(auth.origin + auth.pathname).toBe('https://api.thebase.in/1/oauth/authorize');
    expect(auth.searchParams.get('scope')).toBe('read_users read_items read_orders write_items');
    expect(auth.searchParams.get('redirect_uri')).toBe(LOCAL_API_REDIRECT_URI);
    expect(auth.toString()).not.toContain(input.client_secret);
    expect(hasLocalApiAuthorization(UID, entry)).toBe(true);
    expect(readFileSync(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, 'utf8')).not.toMatch(/private|one-use-code/);
    const orders = await adapter.callTool('execute_read', { action: 'orders.list', parameters: { limit: 1 } }, env);
    expect(JSON.stringify(orders)).toContain('ORDER1');
    expect(JSON.stringify(orders)).not.toMatch(/Private|tel|remark/);
    const before = fetchMock.mock.calls.length;
    await expect(adapter.callTool('execute_read', { action: 'inventory.set', parameters: { item_id: 1234, quantity: 0 } }, env)).rejects.toThrow(/risk mismatch/);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    await adapter.callTool('execute_high_impact', { action: 'inventory.set', parameters: { item_id: 1234, variation_id: 11, quantity: 0 } }, env);
    const write = fetchMock.mock.calls.at(-1)!;
    expect(write[0]).toBe('https://api.thebase.in/1/items/edit_stock');
    expect(Object.fromEntries(new URLSearchParams(write[1]?.body as string))).toEqual({ item_id: '1234', variation_id: '11', variation_stock: '0' });
    const writes = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length;
    await expect(adapter.callTool('execute_high_impact', { action: 'inventory.set', parameters: { item_id: 1234, quantity: 1 } }, env)).rejects.toThrow(/variation/);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(writes);
  });

  it('coalesces refreshes, verifies shop binding and persists the new grant for restart', async () => {
    const fetchMock = fixture(); const env = await connect();
    const file = env.ORKAS_LOCAL_API_CREDENTIAL_FILE; const key = env.ORKAS_LOCAL_API_CREDENTIAL_KEY;
    const c = codec.readCredentialFile(file, key);
    codec.writeCredentialFile(file, key, { ...c, expires_at: Date.now() - 1 });
    fetchMock.mockClear();
    await Promise.all([1, 2].map(() => adapter.callTool('execute_read', { action: 'products.list' }, env)));
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/oauth/token'))).toHaveLength(1);
    expect(codec.readCredentialFile(file, key).expires_at).toBeGreaterThan(Date.now());
    const expired = { ...c, expires_at: Date.now() - 1 };
    codec.writeCredentialFile(file, key, expired);
    fetchMock.mockResolvedValueOnce(reply({ access_token: 'changed-token', refresh_token: 'changed-refresh', expires_in: 3600 }))
      .mockResolvedValueOnce(reply({ user: { shop_id: 'different-shop' } }));
    await expect(adapter.callTool('execute_read', { action: 'products.list' }, env)).rejects.toThrow(/shop changed/);
    expect(codec.readCredentialFile(file, key)).toEqual(expired);
  });

  it('denies injected endpoints and invalid parameters before I/O; provider errors stay private without retries', async () => {
    const fetchMock = fixture(); const env = await connect(); fetchMock.mockClear();
    expect(() => normalizeLocalApiConnectionInput(entry, { ...input, endpoint: 'https://evil.test' })).toThrow();
    for (const parameters of [{ limit: 101 }, { offset: -1 }, { endpoint: 'https://evil.test' }]) {
      await expect(adapter.callTool('execute_read', { action: 'products.list', parameters }, env)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
    for (const [status, code] of [[403, 'E_TOOL_CALL_AUTH'], [429, 'E_TOOL_CALL_RATE_LIMIT'], [503, 'E_TOOL_CALL_UPSTREAM']] as const) {
      fetchMock.mockResolvedValueOnce(reply({ error_description: TOKEN }, status));
      const result = await adapter.callToolResult('execute_read', { action: 'products.list' }, env);
      expect(result).toMatchObject({ isError: true, _meta: { orkas: { errorCode: code } } });
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
