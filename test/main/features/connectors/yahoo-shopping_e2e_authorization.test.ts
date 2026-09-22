import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ open: vi.fn(async (_url: string) => undefined) }));
vi.mock('electron', () => ({ app: { isPackaged: false }, shell: { openExternal: mocks.open } }));
vi.mock('../../../../src/main/features/account/server', () => ({ accountApiBase: () => 'https://orkas.test/api' }));
vi.mock('../../../../src/main/features/account/token_store', () => ({ getDeviceId: () => 'yahoo-fixture-device', authHeaders: () => ({}) }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'en', getLanguageForUser: () => 'en' }));
vi.mock('../../../../src/main/features/api_common', () => ({ withCommonHeaders: (headers: object) => ({ ...headers, 'Orkas-Channel': 'open' }) }));
vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({ broadcastOAuthConnectProgress: vi.fn() }));
vi.mock('../../../../src/main/util/background-node', () => ({ resolveBackgroundNodeRuntime: () => ({ executable: process.execPath, electronAsNode: false }), withBackgroundNodeEnv: (env: object) => env }));
vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({ buildChildProxyEnvironment: async () => ({}) }));
vi.mock('../../../../src/main/util/local-secret-store', () => ({ encryptLocalSecret: (_context: unknown, value: string) => `TEST:${value}`, decryptLocalSecret: (_context: unknown, value: string) => value.slice(5) }));
vi.mock('../../../../src/main/model/core-agent/interactive-cli-sessions', () => ({ startInteractiveCliSession: () => { throw new Error('No CLI authorization'); }, waitInteractiveCliSession: vi.fn() }));
import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { authorizeLocalApi, localApiTransport, normalizeLocalApiConnectionInput, removeLocalApiAuthorization } from '../../../../src/main/features/connectors/local-api';
import { cancelDcrOAuth, handleDcrCallbackUrl, LOCAL_API_REDIRECT_URI } from '../../../../src/main/features/connectors/oauth-dcr';
const require = createRequire(import.meta.url);
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const codec = require('../../../../bin/local-api-credential-codec.cjs');
const api = require('../../../../bin/yahoo-shopping-api.cjs');
const { XMLParser } = require('fast-xml-parser');
const entry = findCatalogEntry('yahoo-shopping')!;
const UID = 'yahoo-shopping-journey-fixture';
const TOKEN = 'yahoo-private-access-token';
let sequence = 0;
const input = () => ({ seller_id: 'fixture-store', client_id: `yahoo-client-${++sequence}`, client_secret: 'yahoo-private-secret' });
const xml = (body: string, status = 200, headers = {}) => new Response(body, { status, headers });
const json = (body: unknown) => new Response(JSON.stringify(body));
const resultSet = (body = '', total = 0) => `<ResultSet totalResultsAvailable="${total}" totalResultsReturned="${total}" firstResultPosition="1">${body}</ResultSet>`;
const stock = (status = '1') => resultSet(`<Result><ItemCode>item-01</ItemCode><SubCode>blue</SubCode><Status>${status}</Status><Quantity>5</Quantity><AllowOverdraft>1</AllowOverdraft><StockClose>1</StockClose></Result>`, 1);
function fixture(environment = 'live') {
  const fetchMock = vi.fn(async (raw: string, init: RequestInit = {}) => {
    const url = new URL(raw);
    if (url.pathname.endsWith('/dcr-exchange')) return json({ code: 0, oauth_code: 'yahoo-one-use-code', oauth_state: new URL(mocks.open.mock.calls.at(-1)![0]).searchParams.get('state') });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('error');
    expect(raw).not.toMatch(/private|one-use-code/);
    if (url.pathname === '/yconnect/v2/token') {
      expect(url.origin).toBe('https://auth.login.yahoo.co.jp');
      expect(init.headers).toMatchObject({ authorization: expect.stringMatching(/^Basic /) });
      return json({ access_token: TOKEN, refresh_token: 'yahoo-private-refresh', expires_in: 3600 });
    }
    expect(url.origin).toBe(environment === 'sandbox' ? 'https://test.circus.shopping.yahooapis.jp' : 'https://circus.shopping.yahooapis.jp');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    if (url.pathname.endsWith('/getShopCategory')) return xml(resultSet());
    if (url.pathname.endsWith('/myItemList')) return xml(resultSet('<Result><ItemCode>item-01</ItemCode><Name><![CDATA[青 & 白]]></Name><Price>1000</Price><Quantity>5</Quantity></Result>', 1));
    if (url.pathname.endsWith('/getStock')) return xml(stock());
    if (url.pathname.endsWith('/setStock')) return xml(resultSet('<Result><ItemCode>item-01</ItemCode><SubCode>blue</SubCode><Quantity>0</Quantity></Result>', 1));
    if (url.pathname.endsWith('/orderList')) return xml('<Result><Status>OK</Status><Search><TotalCount>101</TotalCount><OrderInfo><SellerId>fixture-store</SellerId><OrderId>fixture-store-10001</OrderId><TotalPrice>1000</TotalPrice><BillName>Private</BillName><BuyerComments>Private</BuyerComments></OrderInfo></Search></Result>', 200, { 'X-SWS-Authorize-Status': 'authorized' });
    throw new Error('Unexpected Yahoo! route');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
async function connect(fields = input()) {
  const flow = authorizeLocalApi(UID, entry, fields);
  void flow.catch(() => undefined); // Observe early setup rejection while waiting for the browser.
  await vi.waitFor(() => expect(mocks.open).toHaveBeenCalled());
  await handleDcrCallbackUrl('orkas://connectors/oauth/dcr-callback?exchange_code=yahoo-fixture-receipt');
  const metadata = await flow;
  const transport = await localApiTransport(UID, entry, metadata);
  if (transport.kind !== 'stdio') throw new Error('Expected stdio');
  vi.useFakeTimers();
  return transport.env!;
}
async function settle<T>(promise: Promise<T>): Promise<T> {
  const outcome = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const result = await outcome;
  if ('error' in result) throw result.error;
  return result.value;
}
afterEach(() => { cancelDcrOAuth(); removeLocalApiAuthorization(UID, entry); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('Yahoo! Shopping merchant OAuth and XML APIs', () => {
  it('binds official sandbox authorization and stock writes to the test host, including after restart', async () => {
    // Official sandbox help + setStock document prescribe a separate test host and app/store.
    // Sandbox is developer-only; the product catalog intentionally remains production-only.
    const fetchMock = fixture('sandbox');
    const metadata = { seller_id: 'fixture-store', environment: 'sandbox' };
    const credentials = await api.authorize({ provider: 'yahoo_shopping', metadata,
      credentials: { ...input(), redirect_uri: LOCAL_API_REDIRECT_URI }, oauthCode: 'sandbox-code' });
    const root = mkdtempSync(join(tmpdir(), 'orkas-yahoo-sandbox-'));
    try {
      const file = join(root, 'grant.enc'); const key = Buffer.alloc(32, 7).toString('base64url');
      codec.writeCredentialFile(file, key, credentials);
      const env = { ORKAS_LOCAL_API_PROVIDER: 'yahoo_shopping', ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(metadata),
        ORKAS_LOCAL_API_CREDENTIAL_FILE: file, ORKAS_LOCAL_API_CREDENTIAL_KEY: key };
      vi.useFakeTimers();
      await settle(adapter.callTool('execute_high_impact', { action: 'inventory.set', parameters: {
        item_code: 'item-01', sub_code: 'blue', quantity: 0,
      } }, env));
      expect(fetchMock.mock.calls.at(-1)![0]).toBe('https://test.circus.shopping.yahooapis.jp/ShoppingWebService/V1/setStock');
      const count = fetchMock.mock.calls.length;
      const altered = { ...env, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify({ seller_id: 'fixture-store', environment: 'live' }) };
      await expect(settle(adapter.callTool('execute_read', { action: 'shop.get' }, altered))).rejects.toThrow(/changed/);
      expect(fetchMock).toHaveBeenCalledTimes(count);
      expect(() => api.apiBase('yahoo_shopping', { ...metadata, environment: 'arbitrary' })).toThrow();
      expect(() => normalizeLocalApiConnectionInput(entry, { ...input(), environment: 'sandbox' })).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it('connects the intended seller, reads after encrypted persistence, signs order access and preserves stock settings', async () => {
    const fetchMock = fixture();
    const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const public_key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const env = await connect({ ...input(), public_key, key_version: '1' } as ReturnType<typeof input>);
    const authorization = new URL(mocks.open.mock.calls[0][0]);
    expect(authorization.origin + authorization.pathname).toBe('https://auth.login.yahoo.co.jp/yconnect/v2/authorization');
    expect(authorization.searchParams.get('scope')).toBe('openid profile');
    expect(authorization.searchParams.get('redirect_uri')).toBe(LOCAL_API_REDIRECT_URI);
    expect(readFileSync(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, 'utf8')).not.toMatch(/private|one-use-code/);
    const products = await settle(adapter.callTool('execute_read', { action: 'products.search', parameters: { query: '青', by: 'name', start: 2, limit: 20 } }, env));
    expect(JSON.stringify(products)).toContain('青 & 白');
    const orders = await settle(adapter.callTool('execute_read', { action: 'orders.list', parameters: { day: '20260916', start: 51 } }, env));
    expect(JSON.stringify(orders)).toContain('fixture-store-10001');
    expect(JSON.stringify(orders)).toContain('public_key_authorized');
    expect(JSON.stringify(orders)).not.toMatch(/Private|BillName|BuyerComments/);
    const orderRequest = fetchMock.mock.calls.at(-1)![1];
    const requestBody = new XMLParser({ parseTagValue: false }).parse(orderRequest.body);
    expect(requestBody.Req).toMatchObject({ SellerId: 'fixture-store', Search: { Start: '51', Condition: { OrderTimeFrom: '20260916000000', OrderTimeTo: '20260916235959' } } });
    expect(requestBody.Req.Search.Field).toBe('OrderId,Version,OrderTime,OrderStatus,ShipStatus,TotalPrice');
    const signature = (orderRequest.headers as Record<string, string>)['X-sws-signature'];
    const plainBlock = privateDecrypt({ key: keys.privateKey, padding: constants.RSA_NO_PADDING }, Buffer.from(signature, 'base64'));
    expect(plainBlock.subarray(plainBlock.indexOf(0, 2) + 1).toString()).toBe(`fixture-store:${Math.floor(Date.now() / 1000)}`);
    const before = fetchMock.mock.calls.length;
    await expect(adapter.callTool('execute_read', { action: 'inventory.set' }, env)).rejects.toThrow(/risk mismatch/);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    await settle(adapter.callTool('execute_high_impact', { action: 'inventory.set', parameters: { item_code: 'item-01', sub_code: 'blue', quantity: 0 } }, env));
    expect(Object.fromEntries(new URLSearchParams(fetchMock.mock.calls.at(-1)![1].body as string))).toEqual({ seller_id: 'fixture-store', item_code: 'item-01:blue', quantity: '0', allow_overdraft: '1' });
  });

  it('refreshes once under concurrency and rejects seller/key/input substitution without a provider request', async () => {
    const fetchMock = fixture(); const env = await connect();
    const file = env.ORKAS_LOCAL_API_CREDENTIAL_FILE, key = env.ORKAS_LOCAL_API_CREDENTIAL_KEY;
    const credentials = codec.readCredentialFile(file, key);
    codec.writeCredentialFile(file, key, { ...credentials, expires_at: Date.now() - 1 });
    fetchMock.mockClear();
    await settle(Promise.allSettled([1, 2].map(() => adapter.callTool('execute_read', { action: 'products.search', parameters: { query: 'item' } }, env))));
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith('/yconnect/v2/token'))).toHaveLength(1);
    expect(codec.readCredentialFile(file, key).expires_at).toBeGreaterThan(Date.now());
    fetchMock.mockClear();
    const config = { provider: 'yahoo_shopping', metadata: { seller_id: 'fixture-store' }, credentials: codec.readCredentialFile(file, key) };
    await expect(api.execute({ ...config, metadata: { seller_id: 'another-store' } }, 'shop.get')).rejects.toThrow(/changed/);
    await expect(api.execute({ ...config, credentials: { ...config.credentials, client_id: 'different-app' } }, 'shop.get')).rejects.toThrow(/changed/);
    for (const [action, parameters] of [['orders.list', { day: '20260230' }], ['products.search', { query: 'x', endpoint: 'evil' }], ['inventory.set', { item_code: 'item-01', quantity: -1 }], ['raw.api', {}]]) {
      await expect(api.execute(config, action, parameters)).rejects.toThrow();
    }
    expect(() => normalizeLocalApiConnectionInput(entry, { ...input(), seller_id: '../another' })).toThrow();
    expect(() => normalizeLocalApiConnectionInput(entry, { ...input(), public_key: 'not-a-key' })).toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects malformed/entity XML and nonexistent stock; partial failures and network errors never replay writes', async () => {
    const fetchMock = fixture(); const env = await connect();
    for (const response of [xml('<ResultSet><Result></ResultSet>'), xml('<!DOCTYPE a [<!ENTITY x SYSTEM "file:///private">]><ResultSet>&x;</ResultSet>'), xml('<ResultSet/>')]) {
      fetchMock.mockResolvedValueOnce(response);
      await expect(settle(adapter.callTool('execute_read', { action: 'products.search', parameters: { query: 'item' } }, env))).rejects.toThrow();
    }
    let before = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValueOnce(xml(stock('0')));
    await expect(settle(adapter.callTool('execute_high_impact', { action: 'inventory.set', parameters: { item_code: 'item-01', sub_code: 'blue', quantity: 0 } }, env))).rejects.toThrow(/existing/);
    expect(fetchMock).toHaveBeenCalledTimes(before + 1);
    for (const mode of ['partial', 'network']) {
      before = fetchMock.mock.calls.length;
      fetchMock.mockResolvedValueOnce(xml(stock()));
      if (mode === 'partial') fetchMock.mockResolvedValueOnce(xml(resultSet('<Result><ErrorCode>st-02104</ErrorCode></Result>', 1), 207));
      else fetchMock.mockRejectedValueOnce(new TypeError(TOKEN));
      const result = await settle(adapter.callToolResult('execute_high_impact', { action: 'inventory.set', parameters: { item_code: 'item-01', sub_code: 'blue', quantity: 0 } }, env));
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
      expect(fetchMock).toHaveBeenCalledTimes(before + 2);
    }
  });
});
