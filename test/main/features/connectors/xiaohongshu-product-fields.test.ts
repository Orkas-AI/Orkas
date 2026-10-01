import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const api = require('../../../../bin/direct-commerce-mcp-server.cjs');
const config = { credentials: { app_key: 'fixture-app', app_secret: 'fixture-secret' } };
afterEach(() => vi.unstubAllGlobals());

// Independent oracle: official legacy create-spu/update-spl-item/update-spv-custom
// request tables. Creation wraps entities; updates send entity fields directly.
it('describes product creation, customs and clearing fields instead of an opaque payload', () => {
  const schema = (name: string) => api.XIAOHONGSHU_ARK_ACTIONS[name].input_schema.properties.payload;
  expect(schema('products.spu_create').properties?.spv.properties).toMatchObject({
    qty: { type: 'integer' }, net_weight: { type: 'number' }, barcode: { type: 'string' },
    customs_photos_urls: { type: 'array', items: { type: 'string' } },
  });
  expect(schema('products.spl_item_update').properties?.faqs.items.properties).toMatchObject({
    question: { type: 'string' }, answer: { type: 'string' },
  });
  expect(schema('products.item_update').properties?.pre_tax_price.type).toBe('number');
  expect(schema('products.spv_customs_update').properties?.ingredient.type).toBe('string');
  expect(schema('products.item_logistics_update').properties?.logistics_name.type).toBe('string');
});

it('rejects malformed nested fields before any merchant write', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: {} })));
  vi.stubGlobal('fetch', fetch);
  for (const [name, p] of [
    ['products.spu_create', { payload: { spv: { qty: 1.5 } } }],
    ['products.item_update', { item_id: 'I1', payload: { price: '99.00' } }],
    ['products.spl_item_update', { spl_id: 'L1', payload: { faqs: [{ question: 12 }] } }],
    ['products.spv_customs_update', { spv_id: 'V1', payload: { customs_photos_urls: [5] } }],
  ] as const) await expect(api.executeXiaohongshuArk(config, name, p)).rejects.toThrow(/parameter/);
  expect(fetch).not.toHaveBeenCalled();
});

it('preserves wrapped creation, flat updates and explicit empty-list clearing on the wire', async () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true, data: { id: 'I1' } })));
  vi.stubGlobal('fetch', fetch);
  const payload = {
    spu: { brand_id: 'B1', category_id: 'C1', name: 'Example', ename: 'Example', short_name: 'Short' },
    spl: { variants: [{ id: 'COLOR', value_id: 'RED' }] },
    spl_item: { desc: 'Description', image_urls: ['https://example.org/photo.jpg'], faqs: [], attributes: [] },
    spv: { qty: 1, unit: 'piece', net_weight: 0.2, gross_weight: 0.25, barcode: '12345', import_cost: 10, ingredient: 'Cotton', customs_photos_urls: [] },
    item: { price: 20, original_price: 25, pre_tax_price: 18 },
  };
  await api.executeXiaohongshuArk(config, 'products.spu_create', { payload });
  await api.executeXiaohongshuArk(config, 'products.spl_item_update', { spl_id: 'L1', payload: { attributes: [], faqs: [] } });
  await api.executeXiaohongshuArk(config, 'products.submit_review', { spl_id: 'L1' });
  const calls = fetch.mock.calls as any[];
  expect(JSON.parse(calls[0][1].body)).toEqual(payload);
  expect(new URL(calls[0][0]).pathname).toBe('/ark/open_api/v1/spu');
  expect(calls[1][1].method).toBe('PUT');
  expect(JSON.parse(calls[1][1].body)).toEqual({ attributes: [], faqs: [] });
  expect(new URL(calls[2][0]).pathname).toBe('/ark/open_api/v1/spl/L1/spl_item/submit');
  expect(JSON.parse(calls[2][1].body)).toEqual({});
  expect(fetch).toHaveBeenCalledTimes(3);
});
