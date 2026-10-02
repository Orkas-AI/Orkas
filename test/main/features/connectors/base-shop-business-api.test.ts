import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url), api = require('../../../../bin/base-shop-business-api.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
const config = () => ({ provider: 'base_shop', metadata: {}, credentials: { provider: 'base_shop', client_id: 'fixture-client', client_secret: 'fixture-secret', access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_at: Date.now() + 3600000, identity: { shop_id: 'fixture-shop', app_fingerprint: crypto.createHash('sha256').update('fixture-client').digest('hex') } } });
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
afterEach(() => vi.unstubAllGlobals());
// Portfolio: discover within grants -> edit ordered variants -> full orders -> stock and deletion
// acknowledgement -> interruption. Official wire tables and merchant state provide independent oracles.
it('discovers all 21 current-grant routes with bounded writes and distinct destructive risk', () => {
  const actions = api.actionsFor(); expect(Object.keys(actions)).toHaveLength(21);
  expect(Object.values(actions).filter((r: any) => r.risk === 'R')).toHaveLength(9);
  expect(Object.values(actions).filter((r: any) => r.risk === 'D')).toHaveLength(5);
  expect(actions).toHaveProperty('base.items.search');
  for (const name of ['base.search', 'base.search.refresh', 'base.savings', 'base.orders.edit_status']) expect(api.isNative(name)).toBe(false);
  expect(Object.keys(actions['base.items.edit'].input_schema.properties)).toEqual(['item_id', 'title', 'detail', 'price', 'item_tax_type', 'stock', 'visible', 'list_order', 'identifier', 'variation_id', 'variation', 'variation_stock', 'variation_identifier', 'barcode']);
  expect(actions['base.items.edit'].input_schema.properties.variation.maxItems).toBe(10);
});
it('sends indexed form arrays with empty new-variation IDs, Japanese text, zero stock and exact identifiers', async () => {
  const journal: any[] = []; vi.stubGlobal('fetch', async (url: string, init: any) => {
    journal.push({ url, init }); const body = new URLSearchParams(init.body);
    expect(body.get('variation_id[0]')).toBe('9007199254740993'); expect(body.get('variation_id[1]')).toBe('');
    expect(body.get('variation[1]')).toBe('青 & 白 + 新'); expect(body.get('variation_stock[1]')).toBe('0');
    expect(body.get('barcode[1]')).toBe('0012345678901'); expect(body.has('variation')).toBe(false);
    return new Response('{"item":{"item_id":9007199254740993,"title":"日本語 & +","price":0,"visible":0,"variations":[{"variation_id":9007199254740993,"variation":"黒","variation_stock":2,"variation_identifier":"sku-b","barcode":"0012345678900"},{"variation_id":9007199254740995,"variation":"青 & 白 + 新","variation_stock":0,"variation_identifier":"sku-w","barcode":"0012345678901"}]}}');
  });
  const result = await api.execute(config(), 'base.items.edit', { item_id: '9007199254740993', title: '日本語 & +', price: 0, visible: 0, variation_id: ['9007199254740993', ''], variation: ['黒', '青 & 白 + 新'], variation_stock: [2, 0], variation_identifier: ['sku-b', 'sku-w'], barcode: ['0012345678900', '0012345678901'] });
  expect(result.data.item.item_id).toBe('9007199254740993'); expect(result.data.item.variations[1].variation_id).toBe('9007199254740995'); expect(journal).toHaveLength(1);
  expect(journal[0].url).toBe('https://api.thebase.in/1/items/edit'); expect(journal[0].init.headers['content-type']).toBe('application/x-www-form-urlencoded');
});
it('preserves full order contacts and exact response IDs while removing connector secrets', async () => {
  vi.stubGlobal('fetch', async () => new Response('{"order":{"unique_key":"ORDER_A","order_item_id":9007199254740993,"mail_address":"buyer@example.test","first_name":"太郎","order_receiver":{"address":"Tokyo","phone":"0123456789"},"payment":"creditcard","remark":"text 9007199254740993 fixture-token","access_token":"credential","nested":{"client_secret":"private","business_code":"001"}}}'));
  const result = await api.execute(config(), 'base.orders.detail', { unique_key: 'ORDER_A' });
  expect(result.data.order.order_item_id).toBe('9007199254740993'); expect(result.data.order.mail_address).toBe('buyer@example.test'); expect(result.data.order.order_receiver.phone).toBe('0123456789');
  expect(result.data.order.payment).toBe('creditcard'); expect(result.data.order.nested).toEqual({ business_code: '001' }); expect(result.data.order.remark).toBe('text 9007199254740993 [redacted]'); expect(result.data.order).not.toHaveProperty('access_token');
});
it('uses local search and one explicit page with all product filters', async () => {
  const urls: string[] = []; vi.stubGlobal('fetch', async (url: string) => { urls.push(url); return json({ items: [] }); });
  const result = await api.execute(config(), 'base.items.search', { q: '帽子 & T', fields: 'title,detail', order: 'modified', sort: 'desc', limit: 100, offset: 10000 });
  expect(result).toMatchObject({ limit: 100, offset: 10000 }); expect(new URL(urls[0]).pathname).toBe('/1/items/search'); expect(new URL(urls[0]).searchParams.get('q')).toBe('帽子 & T');
  await api.execute(config(), 'base.items', { visible: 0, image_size: 'origin,sp_640', max_image_no: 20, category_id: '9007199254740993', order: 'created', sort: 'asc' });
  expect(new URL(urls[1]).searchParams.get('limit')).toBe('20'); expect(new URL(urls[1]).searchParams.get('category_id')).toBe('9007199254740993'); expect(urls).toHaveLength(2);
});
it('rejects malformed contracts before token or business IO', async () => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  const cases: [string, any][] = [
    ['base.items.search', { q: 'x', offset: 10001 }], ['base.items', { limit: 101 }], ['base.items', { image_size: 'unknown' }],
    ['base.items.detail', { item_id: 9007199254740992 }], ['base.orders.detail', { unique_key: '../other' }],
    ['base.items.add', { title: 't', price: 1, stock: 2, access_token: 'arbitrary' }], ['base.items.edit', { item_id: 1, variation: ['x'] }],
    ['base.items.edit', { item_id: 1, variation_id: [1, '1'], variation_stock: [1, 1] }], ['base.items.edit', { item_id: 1, variation_id: [1], variation_stock: [1, 2] }],
    ['base.items.edit', { item_id: 1, variation_id: Array(11).fill(''), variation: Array(11).fill('x') }],
    ['base.items.edit_stock', { item_id: 1, stock: 0, variation_id: 1, variation_stock: 0 }],
    ['base.items.add_image', { item_id: 1, image_no: 21, image_url: 'https://images.example/x.png' }], ['base.items.add_image', { item_id: 1, image_no: 1, image_url: 'data:image/png;base64,A' }],
    ['base.items.edit', { item_id: 1, identifier: 'two words' }], ['base.orders.edit_status', { order_item_id: 1 }],
  ];
  for (const [action, params] of cases) await expect(api.execute(config(), action, params)).rejects.toMatchObject({ code: 'E_BAD_INPUT' }); expect(fetch).not.toHaveBeenCalled();
});
it('checks variants before stock replacement and rejects mismatched acknowledgements without retry', async () => {
  const journal: string[] = []; let mismatch = false;
  vi.stubGlobal('fetch', async (_url: string, init: any) => { journal.push(init.method); return new Response('{"item":{"item_id":9007199254740993,"variations":[{"variation_id":9007199254740995,"variation_stock":' + (init.method === 'POST' && !mismatch ? 0 : 7) + '}]}}'); });
  await expect(api.execute(config(), 'base.items.edit_stock', { item_id: '9007199254740993', stock: 0 })).rejects.toMatchObject({ code: 'E_BAD_INPUT' });
  const p = { item_id: '9007199254740993', variation_id: '9007199254740995', variation_stock: 0 };
  expect((await api.execute(config(), 'base.items.edit_stock', p)).data.item.variations[0].variation_stock).toBe(0); expect(journal).toEqual(['GET', 'GET', 'POST']);
  mismatch = true; await expect(api.execute(config(), 'base.items.edit_stock', p)).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' }); expect(journal).toEqual(['GET', 'GET', 'POST', 'GET', 'POST']);
});
it('requires newly created category IDs and positive destructive acknowledgements', async () => {
  let response: any = { result: false }, count = 0;
  vi.stubGlobal('fetch', async (_url: string, init: any) => { count++; return init.method === 'GET' ? json({ categories: [{ category_id: 1, name: 'Name' }] }) : json(response); });
  await expect(api.execute(config(), 'base.items.delete', { item_id: 1 })).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
  response = { result: true }; expect((await api.execute(config(), 'base.items.delete', { item_id: 1 })).data.result).toBe(true);
  response = { categories: [{ category_id: 1, name: 'Name' }] };
  await expect(api.execute(config(), 'base.categories.add', { name: 'Name' })).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
  response = { categories: [{ category_id: 2, name: 'Name' }] }; expect((await api.execute(config(), 'base.categories.add', { name: 'Name' })).data.categories[0].category_id).toBe(2);
  response = { item: { item_id: 1, img20_origin: 'https://images.example/item.png' } };
  expect((await api.execute(config(), 'base.items.add_image', { item_id: 1, image_no: 20, image_url: 'https://images.example/item.png?a=1&b=2' })).data.item.img20_origin).toBeTruthy();
  await expect(api.execute(config(), 'base.items.delete_image', { item_id: 1, image_no: 20 })).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
  response = { item_categories: [{ item_category_id: 7, item_id: 1, category_id: 9 }] }; await expect(api.execute(config(), 'base.item_categories.delete', { item_category_id: 7 })).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
  response = { item_categories: [] }; expect((await api.execute(config(), 'base.item_categories.delete', { item_category_id: 7 })).data.item_categories).toEqual([]); expect(count).toBe(10);
});
it('rejects an edit snapshot that silently ignored requested stock or variation fields', async () => {
  let data: any = { item: { item_id: 1, stock: 7 } };
  const fetch = vi.fn(async () => json(data)); vi.stubGlobal('fetch', fetch);
  await expect(api.execute(config(), 'base.items.edit', { item_id: 1, stock: 0 })).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
  data = { item: { item_id: 1, variations: [{ variation_id: 11, variation_stock: 7 }] } };
  await expect(api.execute(config(), 'base.items.edit', { item_id: 1, variation_id: [11], variation_stock: [0] })).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it('maps structured errors privately and treats malformed results as failures without replay', async () => {
  let count = 0;
  for (const [status, body, code] of [
    [400, { error: 'hour_api_limit', error_description: 'private details' }, 'E_TOOL_CALL_RATE_LIMIT'], [400, { error: 'invalid_scope', error_description: 'private details' }, 'E_TOOL_CALL_AUTH'],
    [400, { error: 'invalid_request', error_description: 'デジタルコンテンツの商品は編集できません。' }, 'E_BAD_INPUT'], [200, { error: 'db_error', error_description: 'private details' }, 'E_TOOL_CALL_UPSTREAM'],
    [503, { private: 'details' }, 'E_TOOL_CALL_UPSTREAM'], [200, {}, 'E_TOOL_CALL_UPSTREAM'],
  ] as const) { vi.stubGlobal('fetch', async () => { count++; return json(body, status); }); const e = await api.execute(config(), 'base.items.delete', { item_id: 1 }).catch((error: any) => error); expect(e.code).toBe(code); expect(e.message).not.toContain('private'); expect(e.message).not.toContain('デジタル'); }
  expect(count).toBe(6);
});
it('cancels the owning call without replaying an uncertain write', async () => {
  const controller = new AbortController(); let started!: () => void; const ready = new Promise<void>(resolve => started = resolve); let calls = 0;
  vi.stubGlobal('fetch', async (_url: string, init: any) => { calls++; started(); return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))); });
  const pending = withRequestSignal(controller.signal, () => api.execute(config(), 'base.items.delete', { item_id: 1 })); await ready; controller.abort(new Error('private cancellation reason'));
  await expect(pending).rejects.toMatchObject({ code: 'E_TOOL_CALL_CANCELLED' }); expect(calls).toBe(1);
});
