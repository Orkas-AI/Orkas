import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const api = require('../../../../bin/direct-commerce-mcp-server.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
const config = { credentials: { app_key: 'fixture-app', app_secret: 'fixture-secret' } };
const run = (name: string, p: any = {}) => api.executeXiaohongshuArk(config, name, p);
const ok = (data: any) => new Response(JSON.stringify({ success: true, error_code: 0, data }));
afterEach(() => vi.unstubAllGlobals());

it('retains authorized order facts and provider masking across the legacy order reads and export', async () => {
  const data = { package_id: 'P100', receiver_name: 'Buyer', receiver_phone: '138****1234', receiver_address: 'Approved address', id_number: '310100000000000001', message: 'Business note', item_list: [{ price: '99.00', net_weight: 1.25 }] };
  const fetch = vi.fn(async () => ok(data)); vi.stubGlobal('fetch', fetch);
  for (const [name, p] of [
    ['orders.list', {}], ['orders.list_latest', { query: { order_time_from: 100, order_time_to: 1900 } }],
    ['cancellations.list', {}], ['orders.statuses_get', { package_ids: ['P100'] }], ['orders.export', { package_id: 'P100' }],
  ] as const) expect(await run(name, p)).toEqual(data);
  expect(fetch).toHaveBeenCalledTimes(5);
  expect(api.XIAOHONGSHU_ARK_ACTIONS['orders.export'].risk).toBe('H');
});

it('rejects incomplete creation intervals, unknown filters and excessive pages before merchant IO', async () => {
  const fetch = vi.fn(async () => ok({ hits: [] })); vi.stubGlobal('fetch', fetch);
  for (const [name, p] of [
    ['orders.list_latest', {}], ['orders.list_latest', { query: { order_time_from: 100 } }],
    ['orders.list_latest', { query: { order_time_from: 100, order_time_to: 1901 } }],
    ['orders.list_latest', { query: { order_time_from: 100, order_time_to: 99 } }],
    ['orders.list_latest', { query: { order_time_from: 100, order_time_to: 200, page_size: 101 } }],
    ['products.list', { query: { page_size: 51 } }], ['products.list_lite', { query: { page_size: 501 } }],
    ['products.list_lite', { query: { page_size: '50' } }], ['orders.list', { query: { page_no: 0 } }],
    ['cancellations.list', { query: { status: 'waiting' } }], ['products.list', { query: { arbitrary: 'x' } }],
  ] as const) await expect(run(name, p)).rejects.toThrow(/parameter|interval/);
  expect(fetch).not.toHaveBeenCalled();
  await run('products.list_lite', { query: { page_size: 500, status: '2', buyable: false, stock_gte: 0 } });
  await run('products.list');
  const first = new URL(String(fetch.mock.calls[0][0]));
  expect(Object.fromEntries(first.searchParams)).toEqual({ page_no: '1', page_size: '500', status: '2', buyable: 'false', stock_gte: '0' });
  expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get('page_size')).toBe('50');
  expect(api.XIAOHONGSHU_ARK_ACTIONS['orders.list_latest'].input_schema.properties.query.required).toEqual(['order_time_from', 'order_time_to']);
});

it('reconciles partial and all-failed transfer receipts without losing failed package IDs or replaying writes', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(ok({ total: 2, success_count: 1, batch: 'TPS100', error_msgs: { P2: 'Private diagnostic' } }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error_code: -7031, data: null, error_msg: { P1: 'Private diagnostic', P2: 'Other diagnostic' } })))
    .mockResolvedValueOnce(ok('TPS101'));
  vi.stubGlobal('fetch', fetch);
  const p = { packages: [{ package_id: 'P1', weight: 1 }, { package_id: 'P2', weight: 2 }] };
  const partial = await run('transfer_batches.create', p);
  expect(partial.status).toBe('partial_or_failed');
  expect(partial.data).toMatchObject({ total: 2, success_count: 1, batch: 'TPS100', error_msgs: { P2: '[provider diagnostic omitted]' } });
  const failure = await run('transfer_batches.create', p);
  expect(failure.status).toBe('partial_or_failed');
  expect(Object.keys(failure.data.error_msgs)).toEqual(['P1', 'P2']);
  expect(JSON.stringify([partial, failure])).not.toMatch(/Private diagnostic|Other diagnostic/);
  expect(await run('transfer_batches.create', p)).toBe('TPS101');
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('rejects missing, conflicting and unrelated batch outcomes without replay', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const p = { packages: [{ package_id: 'P1', weight: 1 }, { package_id: 'P2', weight: 2 }] };
  await expect(run('transfer_batches.create', { packages: [p.packages[0], p.packages[0]] })).rejects.toThrow(/unique/);
  expect(fetch).not.toHaveBeenCalled();
  for (const data of [{ request_id: 'only' }, { total: 2, success_count: 1, batch: 'TPS100', error_msgs: {} }, { total: 2, success_count: 1, batch: 'TPS100', error_msgs: { OTHER: 'failure' } }, { total: 3, success_count: 2, batch: 'TPS100', error_msgs: { P1: 'failure' } }]) {
    fetch.mockResolvedValueOnce(ok(data));
    await expect(run('transfer_batches.create', p)).rejects.toThrow(/reconcile/);
  }
  expect(fetch).toHaveBeenCalledTimes(4);
});

it('cancels before IO and preserves the legacy app-key query-signing protocol', async () => {
  const fetch = vi.fn(async () => ok({ hits: [] })); vi.stubGlobal('fetch', fetch);
  const controller = new AbortController(); controller.abort();
  await expect(withRequestSignal(controller.signal, () => run('products.list'))).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
  await run('products.list');
  const [raw, init] = fetch.mock.calls[0] as any;
  expect(new URL(raw).origin).toBe('https://ark.xiaohongshu.com');
  expect(init.headers['app-key']).toBe('fixture-app');
  expect(init.headers.sign).toMatch(/^[a-f0-9]{32}$/);
  expect(JSON.stringify(init)).not.toMatch(/accessToken|common_controller/);
});

it('supports the documented barcode routes and product code selectors without ambiguity', async () => {
  const fetch = vi.fn(async () => ok({ success: true })); vi.stubGlobal('fetch', fetch);
  await expect(run('products.get', {})).rejects.toThrow(/exactly one/);
  await expect(run('inventory.set', { item_id: 'I1', barcode: 'A1', quantity: 2 })).rejects.toThrow(/exactly one/);
  expect(fetch).not.toHaveBeenCalled();
  await run('products.get', { barcode: 'A/100' });
  await run('products.get', { skucode: 'S100' });
  await run('inventory.set', { barcode: 'A/100', quantity: 2 });
  await run('inventory.adjust', { barcode: 'A/100', quantity_delta: -1 });
  const calls = fetch.mock.calls as any[];
  expect(new URL(calls[0][0]).searchParams.get('barcode')).toBe('A/100');
  expect(new URL(calls[1][0]).searchParams.get('skucode')).toBe('S100');
  expect(new URL(calls[2][0]).pathname).toBe('/ark/open_api/v0/inventories/A%2F100');
  expect(calls[2][1].method).toBe('PUT'); expect(JSON.parse(calls[2][1].body)).toEqual({ qty: 2 });
  expect(calls[3][1].method).toBe('PATCH'); expect(JSON.parse(calls[3][1].body)).toEqual({ qty: -1 });
});

it('removes only credential material while preserving contact fields and ordinary business notes', async () => {
  const fetch = vi.fn(async () => ok({ app_key: 'fixture-app', nested: { app_secret: 'fixture-secret', receiver_phone: '138****1234', message: 'Business note', echo: 'prefix fixture-secret suffix' } }));
  vi.stubGlobal('fetch', fetch);
  expect(await run('orders.list')).toEqual({ nested: { receiver_phone: '138****1234', message: 'Business note', echo: 'prefix [redacted] suffix' } });
  let deep: any = {}; const root = deep; for (let i = 0; i < 40; i++) deep = deep.child = {};
  fetch.mockResolvedValueOnce(ok(root));
  await expect(run('orders.list')).rejects.toThrow(/structure exceeds/);
});
