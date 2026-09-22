import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'en', getLanguageForUser: () => 'en' }));
vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({ broadcastOAuthConnectProgress: vi.fn() }));
vi.mock('../../../../src/main/util/background-node', () => ({ resolveBackgroundNodeRuntime: () => ({ executable: process.execPath, electronAsNode: false }), withBackgroundNodeEnv: (env: object) => env }));
vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({ buildChildProxyEnvironment: async () => ({}) }));
vi.mock('../../../../src/main/util/local-secret-store', () => ({ encryptLocalSecret: (_context: unknown, value: string) => `TEST:${value}`, decryptLocalSecret: (_context: unknown, value: string) => value.slice(5) }));
vi.mock('../../../../src/main/model/core-agent/interactive-cli-sessions', () => ({ startInteractiveCliSession: () => { throw new Error('No CLI authorization'); }, waitInteractiveCliSession: vi.fn() }));
import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { authorizeLocalApi, localApiTransport, normalizeLocalApiConnectionInput, removeLocalApiAuthorization } from '../../../../src/main/features/connectors/local-api';
const require = createRequire(import.meta.url);
const api = require('../../../../bin/futureshop-api.cjs');
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const UID = 'futureshop-journey-fixture';
const entry = findCatalogEntry('futureshop')!;
const origin = 'https://issued-api.example.com';
const token = 'futureshop-private-token';
let sequence = 0;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const input = () => ({ api_origin: origin, client_id: `future-client-${++sequence}`, client_secret: 'future-private-secret', shop_key: 'future-private-shop-key' });
async function settle<T>(promise: Promise<T>): Promise<T> {
  const result = promise.then(value => ({ value }), error => ({ error }));
  await vi.runAllTimersAsync();
  const out = await result;
  if ('error' in out) throw out.error;
  return out.value;
}
function fixture() {
  vi.useFakeTimers();
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
  const calls: number[] = [];
  const fetchMock = vi.fn(async (raw: string, init: RequestInit) => {
    calls.push(Date.now());
    const url = new URL(raw);
    expect(url.origin).toBe(origin);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe('error');
    expect(init.headers).toMatchObject({ 'X-SHOP-KEY': 'future-private-shop-key' });
    expect(raw).not.toContain('private');
    if (url.pathname === '/oauth/token') {
      expect(init.headers).toMatchObject({ authorization: expect.stringMatching(/^Basic /), 'content-type': 'application/x-www-form-urlencoded' });
      expect(init.body).toBe('grant_type=client_credentials');
      return reply({ access_token: token, expires_in: 3600 });
    }
    expect(init.headers).toMatchObject({ authorization: `Bearer ${token}` });
    if (url.pathname === '/admin-api/v1/products') return reply({ productList: [{ productNo: 'gd1' }], nextUrl: `${origin}/admin-api/v1/products?count=50&cursor=next-page` });
    if (url.pathname === '/admin-api/v1/inventory' && init.method === 'POST') return reply({ status: 'success', results: [{ productNo: 'gd1', status: 'success' }] });
    if (url.pathname === '/admin-api/v1/inventory') return reply({ productList: [{ productNo: 'gd1', inventoryInfo: { regular: { inventoryList: [{ verticalNo: '01', horizontalNo: '', count: 3 }] } } }] });
    if (url.pathname === '/admin-api/v1/shipping') return reply({ orderList: [{ orderNo: 'ORDER1', grandTotal: 1000, status: 'AWAITING_PAYMENT', purchaser: { name: 'Private' }, memo: 'Private' }] });
    if (url.pathname === '/admin-api/v1/orders/ORDER1') return reply({ orderNo: 'ORDER1', grandTotal: 1000, purchaser: { name: 'Private' } });
    throw new Error('Unexpected futureshop route');
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, calls };
}
afterEach(() => { removeLocalApiAuthorization(UID, entry); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('futureshop approved API connection', () => {
  it('enforces official UTF-8 byte limits before transmitting multibyte inventory identifiers', async () => {
    // inventoryRefresh defines productNo=32 bytes and variation axes=9 bytes, not characters.
    const { fetchMock } = fixture();
    const config = { provider: 'futureshop', metadata: { api_origin: origin }, credentials: input() };
    const bound = { ...config, credentials: await settle(api.authorize(config)) };
    fetchMock.mockClear();
    for (const parameters of [{ product_no: 'あ'.repeat(11), quantity: 1 },
      { product_no: 'gd1', vertical_no: 'あ'.repeat(4), quantity: 1 },
      { product_no: 'gd1', horizontal_no: 'あ'.repeat(4), quantity: 1 }]) {
      await expect(settle(api.execute(bound, 'inventory.set', parameters))).rejects.toMatchObject({ code: 'E_BAD_INPUT' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('connects from the issued origin, encrypts credentials, pages reads and writes only one existing SKU at the provider rate', async () => {
    const { fetchMock, calls } = fixture();
    const fields = input();
    const metadata = await settle(authorizeLocalApi(UID, entry, fields));
    expect(metadata).toEqual({ api_origin: origin });
    const transport = await localApiTransport(UID, entry, metadata);
    if (transport.kind !== 'stdio') throw new Error('Expected stdio');
    const env = transport.env!;
    expect(readFileSync(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, 'utf8')).not.toContain('private');
    const products = await settle(adapter.callTool('execute_read', { action: 'products.list', parameters: { cursor: 'next-page' } }, env));
    expect(JSON.stringify(products)).toContain('next_cursor');
    expect(JSON.stringify(products)).not.toContain('nextUrl');
    expect(new URL(fetchMock.mock.calls.at(-1)![0]).searchParams.get('cursor')).toBe('next-page');
    for (const [action, parameters] of [['orders.list', { day: '2026-09-16' }], ['orders.get', { order_no: 'ORDER1' }]] as const) {
      const orders = await settle(adapter.callTool('execute_read', { action, parameters }, env));
      expect(JSON.stringify(orders)).toContain('ORDER1');
      expect(JSON.stringify(orders)).not.toMatch(/Private|purchaser|memo/);
    }
    const before = fetchMock.mock.calls.length;
    await expect(adapter.callTool('execute_read', { action: 'inventory.set' }, env)).rejects.toThrow(/risk mismatch/);
    expect(fetchMock).toHaveBeenCalledTimes(before);
    await settle(adapter.callTool('execute_high_impact', { action: 'inventory.set', parameters: { product_no: 'gd1', vertical_no: '01', horizontal_no: '', quantity: 0 } }, env));
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body as string)).toEqual({ productList: [{ productNo: 'gd1', inventoryInfo: { regular: { inventoryList: [{ verticalNo: '01', horizontalNo: '', count: 0 }] } } }] });
    expect(calls.slice(1).every((time, i) => time - calls[i] >= 1000)).toBe(true);
  });

  it('rejects unsafe origins, private DNS, changed shop binding and invalid actions before credential transmission', async () => {
    const { fetchMock } = fixture();
    const fields = input();
    for (const api_origin of ['http://issued-api.example.com', 'https://127.0.0.1', 'https://local.test', 'https://user@issued-api.example.com', `${origin}/oauth/token`, `${origin}?token=x`]) {
      expect(() => normalizeLocalApiConnectionInput(entry, { ...fields, api_origin })).toThrow();
    }
    const config = { provider: 'futureshop', metadata: { api_origin: origin }, credentials: fields };
    vi.mocked(dns.lookup).mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }] as never);
    await expect(settle(api.authorize(config))).rejects.toThrow(/public/);
    expect(fetchMock).not.toHaveBeenCalled();
    const bound = { ...config, credentials: await settle(api.authorize(config)) };
    fetchMock.mockClear();
    await expect(api.execute({ ...bound, metadata: { api_origin: 'https://other.example.com' } }, 'products.list')).rejects.toThrow(/binding/);
    await expect(api.execute({ ...bound, credentials: { ...bound.credentials, shop_key: 'other-private-shop' } }, 'products.list')).rejects.toThrow(/binding/);
    for (const [action, parameters] of [['orders.list', { day: '2026-02-30' }], ['products.list', { count: 251 }], ['products.list', { endpoint: 'evil' }], ['inventory.delete', {}]]) {
      await expect(api.execute(bound, action, parameters)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reacquires one expired token, refuses foreign pagination and never retries uncertain or partially failed writes', async () => {
    const { fetchMock } = fixture();
    const config = { provider: 'futureshop', metadata: { api_origin: origin }, credentials: input() };
    const bound = { ...config, credentials: await settle(api.authorize(config)) };
    fetchMock.mockClear();
    await vi.advanceTimersByTimeAsync(3600000);
    await settle(Promise.allSettled([api.execute(bound, 'products.list'), api.execute(bound, 'products.list')]));
    expect(fetchMock.mock.calls.filter(([raw]) => raw.endsWith('/oauth/token'))).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(reply({ productList: [], nextUrl: 'https://other.example.com/admin-api/v1/products?cursor=x' }));
    await expect(settle(api.execute(bound, 'products.list'))).rejects.toThrow(/pagination/);
    for (const response of [reply({ status: 'failed', errors: [{ message: token }] }), reply({ status: 'success', results: [{ productNo: 'other', status: 'success' }] }), reply({ message: token }, 503)]) {
      const before = fetchMock.mock.calls.length;
      fetchMock.mockResolvedValueOnce(reply({ productList: [{ productNo: 'gd1', inventoryInfo: { regular: { inventoryList: [{ verticalNo: '01', horizontalNo: '', count: 3 }] } } }] })).mockResolvedValueOnce(response);
      await expect(settle(api.execute(bound, 'inventory.set', { product_no: 'gd1', vertical_no: '01', horizontal_no: '', quantity: 1 }))).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM', message: expect.not.stringContaining(token) });
      expect(fetchMock).toHaveBeenCalledTimes(before + 2);
    }
    const before = fetchMock.mock.calls.length;
    await expect(settle(api.execute(bound, 'inventory.set', { product_no: 'gd1', vertical_no: 'missing', horizontal_no: '', quantity: 1 }))).rejects.toThrow(/existing/);
    expect(fetchMock).toHaveBeenCalledTimes(before + 1);
  });
});
