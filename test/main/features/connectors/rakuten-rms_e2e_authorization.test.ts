import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false } }));
vi.mock('../../../../src/main/features/config', () => ({ getLanguage: () => 'en', getLanguageForUser: () => 'en' }));
vi.mock('../../../../src/main/features/connectors/oauth-events', () => ({ broadcastOAuthConnectProgress: vi.fn() }));
vi.mock('../../../../src/main/util/background-node', () => ({ resolveBackgroundNodeRuntime: () => ({ executable: process.execPath, electronAsNode: false }), withBackgroundNodeEnv: (env: object) => env }));
vi.mock('../../../../src/main/util/proxy-dispatcher', () => ({ buildChildProxyEnvironment: async () => ({}) }));
vi.mock('../../../../src/main/util/local-secret-store', () => ({ encryptLocalSecret: (_context: unknown, value: string) => `TEST:${value}`, decryptLocalSecret: (_context: unknown, value: string) => value.slice(5) }));
vi.mock('../../../../src/main/model/core-agent/interactive-cli-sessions', () => ({ startInteractiveCliSession: () => { throw new Error('Merchant keys require no CLI session'); }, waitInteractiveCliSession: vi.fn() }));
import { findCatalogEntry } from '../../../../src/main/features/connectors/catalog';
import { connectorActionRisk } from '../../../../src/main/features/connectors/action_policy';
import { authorizeLocalApi, hasLocalApiAuthorization, localApiTransport, removeLocalApiAuthorization } from '../../../../src/main/features/connectors/local-api';
const require = createRequire(import.meta.url);
const api = require('../../../../bin/rakuten-rms-api.cjs');
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const UID = 'rms-journey-fixture';
const entry = findCatalogEntry('rakuten-rms')!;
const fields = { service_secret: 'SP-fixture-private', license_key: 'SL-fixture-private' };
const config = () => ({ provider: 'rakuten_rms', metadata: {}, credentials: fields });
const order = '123456-20260916-1234567890';
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const product = { manageNumber: 'item-1', title: 'Fixture product', variants: { 'sku-1': { merchantDefinedSkuId: 'blue' } } };
const secondProduct = { manageNumber: 'item-2', title: 'Second fixture product' };
function fixture() {
  let quantity = 3;
  const calls = vi.fn(async (raw: string, init: RequestInit) => {
    const url = new URL(raw);
    expect(url.origin).toBe('https://api.rms.rakuten.co.jp');
    expect(raw).not.toContain('private');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // ESA is cross-checked against two independent clients, not adapter output.
    expect(init.headers).toMatchObject({ authorization: 'ESA U1AtZml4dHVyZS1wcml2YXRlOlNMLWZpeHR1cmUtcHJpdmF0ZQ==' });
    if (url.pathname === '/es/2.0/items/search') {
      expect(init.method).toBe('GET');
      const offset = Number(url.searchParams.get('offset') || 0);
      return reply({ numFound: 2, offset, results: [{ item: offset === 0 ? product : secondProduct }] });
    }
    if (url.pathname === '/es/2.0/items/manage-numbers/item-1') return reply(product);
    if (url.pathname === '/es/2.1/inventories/manage-numbers/item-1/variants/sku-1') {
      if (init.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ mode: 'ABSOLUTE', quantity: 0 });
        quantity = body.quantity;
        return new Response(null, { status: 204 });
      }
      return reply({ manageNumber: 'item-1', variantId: 'sku-1', quantity });
    }
    if (url.pathname === '/es/2.0/order/searchOrder/') {
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ dateType: 1,
        startDatetime: '2026-09-16T00:00:00+0900', endDatetime: '2026-09-16T23:59:59+0900',
        PaginationRequestModel: { requestRecordsAmount: 100, requestPage: 2 } });
      return reply({ orderNumberList: [order], PaginationResponseModel: { totalRecordsAmount: 201, totalPages: 3, requestPage: 2 } });
    }
    if (url.pathname === '/es/2.0/order/getOrder/') {
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ orderNumberList: [order], version: '7' });
      return reply({ OrderModelList: [{ orderNumber: order, orderProgress: 300, totalPrice: 1000,
        OrdererModel: { familyName: 'Private buyer' }, remark: 'Private message', SettlementModel: { name: 'Private payment' } }],
      MessageModelList: [{ messageType: 'INFO', message: fields.license_key }] });
    }
    throw new Error('Unexpected RMS request');
  });
  vi.stubGlobal('fetch', calls);
  return calls;
}
afterEach(() => { removeLocalApiAuthorization(UID, entry); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('RMS merchant connection with local protocol fixtures (not provider sandbox)', () => {
  it('connects from two protected merchant keys, reloads encrypted credentials and reads products, stock and paged order summaries', async () => {
    const calls = fixture();
    const metadata = await authorizeLocalApi(UID, entry, fields);
    expect(metadata).toEqual({});
    const transport = await localApiTransport(UID, entry, metadata);
    if (transport.kind !== 'stdio') throw new Error('Expected stdio');
    const env = transport.env!;
    const stored = readFileSync(env.ORKAS_LOCAL_API_CREDENTIAL_FILE, 'utf8');
    expect(stored).not.toContain('private');
    expect(JSON.stringify(transport)).not.toContain(fields.license_key);
    const items = await adapter.callTool('execute_read', { action: 'products.list', parameters: { limit: 1 } }, env);
    expect(items.result).toEqual({ data: [product], total: 2, next_offset: 1 });
    const lastItems = await adapter.callTool('execute_read', { action: 'products.list', parameters: { limit: 1, offset: 1 } }, env);
    expect(lastItems.result).toEqual({ data: [secondProduct], total: 2, next_offset: null });
    await adapter.callTool('execute_read', { action: 'products.get', parameters: { manage_number: 'item-1' } }, env);
    await adapter.callTool('execute_read', { action: 'inventory.get', parameters: { manage_number: 'item-1', variant_id: 'sku-1' } }, env);
    const numbers = await adapter.callTool('execute_read', { action: 'orders.list', parameters: { day: '2026-09-16', page: 2 } }, env);
    expect(numbers.result).toEqual({ order_numbers: [order], total: 201, next_page: 3 });
    const summary = await adapter.callTool('execute_read', { action: 'orders.get', parameters: { order_number: order } }, env);
    expect(summary.result).toEqual({ data: { orderNumber: order, orderProgress: 300, totalPrice: 1000 } });
    expect(JSON.stringify(summary)).not.toMatch(/Private|remark|SettlementModel|MessageModelList/);
    const before = calls.mock.calls.length;
    expect(connectorActionRisk({ id: entry.id, origin: 'catalog' }, {
      name: 'execute_high_impact', description: '', input_schema: {}, annotations: { readOnlyHint: true },
    }).risk).toBe('H');
    await expect(adapter.callTool('execute_read', { action: 'inventory.set' }, env)).rejects.toThrow(/risk mismatch/);
    expect(calls).toHaveBeenCalledTimes(before);
    const updated = await adapter.callTool('execute_high_impact', { action: 'inventory.set', parameters: { manage_number: 'item-1', variant_id: 'sku-1', quantity: 0 } }, env);
    expect(updated.result).toEqual({ status: 'completed', data: { manageNumber: 'item-1', variantId: 'sku-1', quantity: 0 } });
    expect(calls.mock.calls.slice(before).map(([, init]) => init.method)).toEqual(['GET', 'PUT', 'GET']);
  });

  it('accepts a genuinely empty shop but does not persist rejected or incomplete authorization', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ results: [], offset: 0, numFound: 0 })));
    await authorizeLocalApi(UID, entry, fields);
    expect(hasLocalApiAuthorization(UID, entry)).toBe(true);
    removeLocalApiAuthorization(UID, entry);
    for (const response of [reply({ message: fields.license_key }, 401), reply({ results: [], offset: 0, numFound: 2 }), reply({})]) {
      const fetchMock = vi.fn(async () => response); vi.stubGlobal('fetch', fetchMock);
      await expect(authorizeLocalApi(UID, entry, fields)).rejects.toThrow();
      expect(hasLocalApiAuthorization(UID, entry)).toBe(false);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it('reports connector pagination limits explicitly without returning an unusable continuation', async () => {
    const calls = fixture();
    const bound = { ...config(), credentials: await api.authorize(config()) };
    calls.mockResolvedValueOnce(reply({ numFound: 10002, offset: 10000, results: [{ item: product }] }));
    expect(await api.execute(bound, 'products.list', { offset: 10000, limit: 1 })).toEqual({
      data: [product], total: 10002, next_offset: null, pagination_limited: true,
    });
    calls.mockResolvedValueOnce(reply({ orderNumberList: [order], PaginationResponseModel: {
      totalRecordsAmount: 1000001, totalPages: 10001, requestPage: 10000,
    } }));
    expect(await api.execute(bound, 'orders.list', { day: '2026-09-16', page: 10000 })).toEqual({
      order_numbers: [order], total: 1000001, next_page: null, pagination_limited: true,
    });
  });

  it('rejects changed credentials, foreign endpoints, unsafe identifiers and invalid dates before IO', async () => {
    const calls = fixture();
    const bound = { ...config(), credentials: await api.authorize(config()) };
    calls.mockClear();
    for (const [name, parameters] of [['products.get', { manage_number: '../search' }], ['inventory.get', { manage_number: 'item-1', variant_id: 'x?token=secret' }],
      ['products.list', { endpoint: 'https://evil.example' }], ['products.list', { limit: 101 }], ['orders.list', { day: '2026-02-30' }],
      ['inventory.set', { manage_number: 'item-1', variant_id: 'sku-1', quantity: -1 }], ['orders.cancel', {}]]) {
      await expect(api.execute(bound, name, parameters)).rejects.toThrow();
    }
    for (const altered of [{ ...bound, metadata: { url: 'https://evil.example' } },
      { ...bound, credentials: { ...bound.credentials, license_key: 'different-key' } }]) {
      await expect(api.execute(altered, 'products.list')).rejects.toThrow();
    }
    expect(calls).not.toHaveBeenCalled();
  });

  it('does not retry uncertain writes or claim success for a mismatched SKU, business error or failed readback', async () => {
    const calls = fixture();
    const bound = { ...config(), credentials: await api.authorize(config()) };
    const p = { manage_number: 'item-1', variant_id: 'sku-1', quantity: 0 };
    calls.mockClear();
    calls.mockResolvedValueOnce(reply({ manageNumber: 'other', variantId: 'sku-1', quantity: 3 }));
    await expect(api.execute(bound, 'inventory.set', p)).rejects.toThrow(/mismatched/);
    expect(calls).toHaveBeenCalledTimes(1);
    calls.mockClear();
    calls.mockResolvedValueOnce(reply({ manageNumber: 'item-1', variantId: 'sku-1', quantity: 3 }))
      .mockRejectedValueOnce(new DOMException(fields.license_key, 'TimeoutError'));
    await expect(api.execute(bound, 'inventory.set', p)).rejects.toMatchObject({ code: 'E_TOOL_CALL_TIMEOUT', message: expect.not.stringContaining(fields.license_key) });
    expect(calls).toHaveBeenCalledTimes(2);
    calls.mockClear();
    calls.mockResolvedValueOnce(reply({ manageNumber: 'item-1', variantId: 'sku-1', quantity: 3 }))
      .mockResolvedValueOnce(reply({})).mockResolvedValueOnce(reply({ manageNumber: 'item-1', variantId: 'sku-1', quantity: 2 }));
    await expect(api.execute(bound, 'inventory.set', p)).rejects.toThrow(/confirmed/);
    expect(calls).toHaveBeenCalledTimes(3);
    calls.mockResolvedValueOnce(reply({ OrderModelList: [{ orderNumber: order }], MessageModelList: [{ messageType: 'ERROR', message: fields.license_key }] }));
    await expect(api.execute(bound, 'orders.get', { order_number: order })).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM', message: expect.not.stringContaining(fields.license_key) });
  });
});
