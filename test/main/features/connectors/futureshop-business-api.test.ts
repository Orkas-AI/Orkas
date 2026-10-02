import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { promises as dns } from 'node:dns';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url), api = require('../../../../bin/futureshop-business-api.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
let sequence = 0;
const config = () => {
  const metadata = { api_origin: 'https://issued.example.com' }, credentials: any = { provider: 'futureshop', client_id: 'fixture-client-' + ++sequence, client_secret: 'fixture-secret', shop_key: 'fixture-shop-key' };
  credentials.identity = { fingerprint: crypto.createHash('sha256').update(JSON.stringify([metadata.api_origin, credentials.client_id, credentials.client_secret, credentials.shop_key])).digest('hex') };
  return { provider: 'futureshop', metadata, credentials };
};
async function settle<T>(promise: Promise<T>): Promise<T> { const pending = promise.then(value => ({ value }), error => ({ error })); await vi.runAllTimersAsync(); const result = await pending; if ('error' in result) throw result.error; return result.value; }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function fixture(handler: (url: URL, init: any) => any) {
  const calls: any[] = []; vi.stubGlobal('fetch', async (raw: string, init: any) => {
    const url = new URL(raw); calls.push({ url, init, time: Date.now() });
    expect(url.origin).toBe('https://issued.example.com'); expect(init.headers['X-SHOP-KEY']).toBe('fixture-shop-key');
    if (url.pathname === '/oauth/token') return json({ access_token: 'fixture-token', expires_in: 3600 });
    expect(init.headers.authorization).toBe('Bearer fixture-token'); return handler(url, init);
  }); return calls;
}
beforeEach(() => { vi.useFakeTimers(); vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
// Official request tables and final provider acknowledgement are the oracles. Scenarios cover
// full-contract discovery, exact wire encodings, partial batches, stock safety and cancellation.
it('describes 23 public JSON operations and merchant-option boundaries without adding XML or generic transport', () => {
  const actions = api.actionsFor(); expect(Object.keys(actions)).toHaveLength(23);
  expect(Object.values(actions).filter((x: any) => x.risk === 'D')).toHaveLength(4);
  expect(actions['futureshop.points.history'].description).toContain('Unavailable for omni-channel');
  expect(actions['futureshop.members.create'].input_schema.properties.query.properties).toHaveProperty('additionalItem20');
  expect(actions['futureshop.members.update'].input_schema.properties.query.properties).not.toHaveProperty('password');
  expect(actions['futureshop.inventory.update'].input_schema.properties.body.properties.productList.items.properties.inventoryInfo.properties).toHaveProperty('plannedList');
});
it('reads complete business contacts and 18-digit IDs with filters and one safe cursor', async () => {
  const calls = fixture(() => new Response('{"productList":[{"productNo":"gd1","id":9007199254740993,"freeItem":"contact buyer@example.test"}],"nextUrl":"https://issued.example.com/admin-api/v1/products?types=image,variation&count=50&cursor=next"}'));
  const result = await settle(api.execute(config(), 'futureshop.products.search', { query: { types: 'image,variation' } }));
  expect(result.data.productList[0].id).toBe('9007199254740993'); expect(result.data.productList[0].freeItem).toContain('buyer@example.test'); expect(result.next_cursor).toBe('next'); expect(result.data).not.toHaveProperty('nextUrl');
  expect(calls).toHaveLength(2); expect(calls[1].time - calls[0].time).toBeGreaterThanOrEqual(1000);
});
it('uses bodyless member POST/PUT parameters and character limits as documented, while retaining business password only on the request', async () => {
  const calls = fixture((url, init) => {
    expect(init.body).toBeUndefined(); expect(url.searchParams.get('firstName')).toBe('あ'.repeat(100)); expect(url.searchParams.get('zipCode')).toBe('123-4567');
    return json(init.method === 'POST' ? { status: 'success', memberId: '9007199254740993' } : { status: 'success' });
  });
  const bound = config();
  const created = await settle(api.execute(bound, 'futureshop.members.create', { query: { mail: 'buyer@example.test', firstName: 'あ'.repeat(100), password: 'chosen&password', registrationPointsEnabled: 'NO', zipCode: '123-4567' } }));
  expect(created.memberId).toBe('9007199254740993'); expect(calls[1].url.searchParams.get('password')).toBe('chosen&password');
  await settle(api.execute(bound, 'futureshop.members.update', { path: { memberId: created.memberId }, query: { firstName: 'あ'.repeat(100), zipCode: '123-4567' } })); expect(calls[2].init.method).toBe('PUT'); expect(calls[2].url.pathname).toBe('/admin-api/v1/member/9007199254740993');
});
it('sends store nested fields and shipping objects intact, including explicit empty date clearing', async () => {
  const bodies: any[] = []; fixture((_url, init) => { const b = JSON.parse(init.body); bodies.push(b); return json(b.orderList ? { status: 'success', results: [{ orderNo: 'ORDER1', status: 'success' }] } : { status: 'success' }); });
  await settle(api.execute(config(), 'futureshop.stores.update', { path: { storeCode: 'STORE1' }, body: { additionalItem5: { name: 'Map', url: 'https://shop.example/map' }, storePickupEnabled: true, storePickupMail: 'Ready', htmlComment: '<p>Shop</p>' } }));
  await settle(api.execute(config(), 'futureshop.orders.shipping', { body: { orderList: [{ orderNo: 'ORDER1', shipmentList: [{ shipmentNo: 1, shippingInfo: { invoiceNo: '', expectedArrival: '', shippingDate: '2026-10-01' } }] }] } }));
  expect(bodies[0].additionalItem5.name).toBe('Map'); expect(bodies[1].orderList[0].shipmentList[0].shippingInfo.expectedArrival).toBe('');
});
it('keeps partial batch results correlated with every requested resource and strips raw error messages', async () => {
  const calls = fixture(() => json({ status: 'failed', errors: [{ code: 'ErrorsPresent', message: 'private response' }], results: [{ orderNo: 'A', status: 'success' }, { orderNo: 'B', status: 'failed', errorCode: 'OrderLocked', message: 'private response', errors: [{ code: 'OrderLocked', message: 'private response' }] }] }));
  const result = await settle(api.execute(config(), 'futureshop.orders.complete', { body: { orderList: [{ orderNo: 'A' }, { orderNo: 'B' }] } }));
  expect(result.status).toBe('partial_or_failed'); expect(result.results[0].status).toBe('success'); expect(result.results[1].errorCode).toBe('OrderLocked'); expect(JSON.stringify(result)).not.toContain('private'); expect(calls).toHaveLength(2);
});
it('checks existing stock axes before non-idempotent signed deltas and does not replay', async () => {
  const calls = fixture((_url, init) => init.method === 'GET' ? json({ productList: [{ productNo: 'gd1', inventoryInfo: { regular: { inventoryList: [{ verticalNo: '01', horizontalNo: '' }] }, plannedList: [{ date: '2026-10-02', inventoryList: [{ verticalNo: '01' }] }] } }] }) : json({ status: 'success', results: [{ productNo: 'gd1', status: 'success' }] }));
  const bound = config();
  const result = await settle(api.execute(bound, 'futureshop.inventory.update', { body: { productList: [{ productNo: 'gd1', inventoryInfo: { regular: { inventoryList: [{ verticalNo: '01', count: '+2' }] }, plannedList: [{ date: '2026-10-02', inventoryList: [{ verticalNo: '01', count: '-1' }] }] } }] } }));
  expect(result.status).toBe('acknowledged'); expect(JSON.parse(calls.at(-1).init.body).productList[0].inventoryInfo.regular.inventoryList[0].count).toBe('+2');
  await expect(settle(api.execute(bound, 'futureshop.inventory.update', { body: { productList: [{ productNo: 'gd1', inventoryInfo: { regular: { inventoryList: [{ count: 0 }] } } }] } }))).rejects.toMatchObject({ code: 'E_BAD_INPUT' });
  expect(calls.filter(c => c.init.method === 'POST' && c.url.pathname !== '/oauth/token')).toHaveLength(1);
});
it('rejects byte overflow, nested action amplification, malformed dates and unsafe path IDs before IO', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const cases: [string, any][] = [
    ['futureshop.inventory.update', { body: { productList: [{ productNo: 'あ'.repeat(11), inventoryInfo: { regular: { inventoryList: [{ count: 0 }] } } }] } }],
    ['futureshop.orders.shipping', { body: { orderList: [{ orderNo: 'A', shipmentList: [{ shipmentNo: 1, shippingInfo: { invoiceNo: '', expectedArrival: '2026-02-30', shippingDate: '' } }] }] } }],
    ['futureshop.orders.complete', { body: { orderList: [{ orderNo: 'A' }, { orderNo: 'A' }] } }],
    ['futureshop.products.search', { query: { count: 250 } }], ['futureshop.products.search', { query: { updateDateStart: '2026-01-01T00:00:00', updateDateEnd: '2026-03-01T00:00:00' } }],
    ['futureshop.members.update', { path: { memberId: '../x' }, query: {} }], ['futureshop.points.use', { body: { memberId: '1', points: 0 } }],
    ['futureshop.orders.complete', { body: { orderList: Array.from({ length: 11 }, (_, i) => ({ orderNo: String(i) })) } }],
    ['futureshop.stores.create', { body: { storeCode: 'A', storeName: 'Shop', displayOrder: '1', areaCode: 'TOKYO', endpoint: 'https://other.example' } }],
  ];
  for (const [name, p] of cases) await expect(api.execute(config(), name, p)).rejects.toMatchObject({ code: 'E_BAD_INPUT' }); expect(fetch).not.toHaveBeenCalled();
});
it('requires explicit mutation receipts and exact resource correspondence', async () => {
  for (const reply of [{}, { status: 'success', results: [] }, { status: 'success', results: [{ orderNo: 'OTHER', status: 'success' }] }]) {
    const calls = fixture(() => json(reply)); await expect(settle(api.execute(config(), 'futureshop.orders.complete', { body: { orderList: [{ orderNo: 'A' }] } }))).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' }); expect(calls).toHaveLength(2);
  }
  fixture(() => json({ status: 'success' })); await expect(settle(api.execute(config(), 'futureshop.points.use', { body: { memberId: '1', points: 10 } }))).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
});
it('rejects foreign cursors and merchant binding changes without credential leakage', async () => {
  const calls = fixture(() => json({ memberList: [], nextUrl: 'https://other.example/member?cursor=x' }));
  await expect(settle(api.execute(config(), 'futureshop.members.search'))).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
  const changed = config(); changed.metadata.api_origin = 'https://other.example.com'; const before = calls.length;
  await expect(api.execute(changed, 'futureshop.members.search')).rejects.toMatchObject({ code: 'E_TOOL_CALL_AUTH' }); expect(calls).toHaveLength(before);
});
it('retains call cancellation through token ownership and the shared rate limiter without sending a delayed write', async () => {
  const controller = new AbortController(); const calls = fixture(() => { throw new Error('Business request must not run'); });
  const promise = withRequestSignal(controller.signal, () => api.execute(config(), 'futureshop.members.delete', { path: { memberId: '1' } }));
  controller.abort(new Error('private cancellation')); await expect(settle(promise)).rejects.toMatchObject({ code: 'E_TOOL_CALL_CANCELLED' });
  expect(calls.filter(c => c.url.pathname !== '/oauth/token')).toHaveLength(0);
});
