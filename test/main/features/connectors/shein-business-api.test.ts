import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, installFixture, rows, SECRET, SHEIN_KEY, SHEIN_SECRET } from './merchant-platform-fixtures';

const require = createRequire(import.meta.url);
const shein = require('../../../../bin/shein-seller-api.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
const evidence = JSON.parse(readFileSync(new URL('../../../fixtures/connectors/official-contracts/shein-20260930.json', import.meta.url), 'utf8'));
const native = (path: string, method = 'POST') => `${method} /open-api/${path}`;
const hostOwned = [3001520, 3001229, 3001226, 3001227];
const uploads = [3001359, 3001861, 3001886, 3001852, 3001176];
const reply = (info: unknown) => new Response(JSON.stringify({ code: '0', info }));
async function connected() {
  const row = rows[3], mock = installFixture(row), initial = config(row);
  const c = { ...initial, credentials: await shein.authorize(initial) };
  mock.mockClear(); return { c, mock };
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('SHEIN merchant business journeys', () => {
  it('exposes the independently pinned seller inventory and full field trees with explicit application and host workflow gaps', () => {
    const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
    const compiler = new AjvJsonSchemaValidator(), actions = shein.actionsFor();
    const eligible = evidence.inventory.filter((row: any) => row.applicable_to_seller && !hostOwned.includes(row.id));
    expect(Object.keys(actions).filter(n => n.includes('/open-api/')).sort()).toEqual(eligible.map((r: any) => `${r.method} ${r.path}`).sort());
    function compare(node: any, schema: any, id: number) {
      const p = node.props;
      if (uploads.includes(id) && p.name === 'file') {
        expect(schema.required).toEqual(['name', 'content_base64']); return;
      }
      if (p.multiple === 1) { expect(schema.type).toBe('array'); compare({ ...node, props: { ...p, multiple: 0 } }, schema.items, id); return; }
      const types: Record<string, string> = { object: 'object', string: 'string', datetime: 'string', integer: 'integer', int64: 'integer', long: 'integer', bigint: 'integer', double: 'number', decimal: 'number', boolean: 'boolean' };
      expect(schema.type).toBe(types[p.type]);
      if (p.type === 'object') {
        const fields = node.children || [];
        expect(Object.keys(schema.properties).sort()).toEqual(fields.map((f: any) => f.props.name).sort());
        let required = fields.filter((f: any) => f.props.required === true).map((f: any) => f.props.name);
        if (id === 3002018 && p.name === 'sku_list') {
          required = required.filter((name: string) => name !== 'price_info_list');
          expect(schema.anyOf).toEqual([{ required: ['price_info_list'] }, { required: ['cost_info'] }]);
        }
        expect(schema.required.slice().sort()).toEqual(required.sort());
        expect(schema.additionalProperties).toBe(false);
        fields.forEach((f: any) => compare(f, schema.properties[f.props.name], id));
      }
    }
    for (const r of eligible) {
      const schema = actions[`${r.method} ${r.path}`].input_schema, source = evidence.definitions[r.id];
      if (source.requestBody && r.method !== 'GET') compare(source.requestBody, schema.properties.body, r.id);
      if (source.queryStrings?.children?.length) compare(source.queryStrings, schema.properties.query, r.id);
      expect(schema.additionalProperties).toBe(false);
      expect(compiler.getValidator(schema)).toBeTypeOf('function');
    }
    expect(actions[native('goods/image-category-suggestion')].input_schema.properties.body.properties.url).toBeDefined();
    expect(actions[native('goods/product/publishOrEdit')].risk).toBe('H');
    expect(actions[native('order/export-address')].risk).toBe('H');
    expect(actions[native('order/import-batch-multiple-express')].risk).toBe('D');
    expect(actions[native('goods/delete/{skcName}', 'DELETE')].risk).toBe('D');
    expect(actions[native('goods/add-custom-attribute-value')].risk).toBe('W');
    expect(shein.coverageFor()).toMatchObject({ complete: false, reviewed_business_methods: eligible.length, max_inline_parameter_bytes: 256 * 1024 });
    expect(Object.keys(shein.coverageFor().host_owned_methods)).toHaveLength(4);
  });

  it('supports publishing rules, quota, nested product publication and audit follow-up without claiming publication', async () => {
    const { c, mock } = await connected();
    mock.mockResolvedValueOnce(reply({ canPublishProduct: true })).mockResolvedValueOnce(reply({ fill_in_standard_list: [{ field_key: 'brand_code', required: true }] })).mockResolvedValueOnce(reply({ availableQuota: 2 }));
    await shein.execute(c, native('goods/product/check-publish-permission', 'GET'), {});
    await shein.execute(c, native('goods/query-publish-fill-in-standard'), { body: { category_id: 20039882 } });
    await shein.execute(c, native('goods-publish-quotas/detail'), {});
    const body = { category_id: 20039882, brand_code: 'BR-1', is_spu_pic: false,
      multi_language_name_list: [{ language: 'en', name: 'Fixture shorts' }], product_attribute_list: [{ attribute_id: 123, attribute_value_id: 456 }],
      skc_list: [{ supplier_code: 'ITEM-11', image_info: { image_info_list: [{ image_sort: 1, image_type: 1, image_url: 'https://img.shein.com/fixture.jpg' }] },
        sale_attribute: { attribute_id: 2147484187, attribute_value_id: 2147488294 },
        sku_list: [{ height: '20', length: '10', width: '10', weight: 10, mall_state: 1, supplier_sku: 'SKU-11',
          price_info_list: [{ base_price: 20, currency: 'USD', sub_site: 'shein-us' }], stock_info_list: [{ inventory_num: 0 }] }] }],
    };
    mock.mockResolvedValueOnce(reply({ success: true, spu_name: 'SPU-11', skc_list: [{ skc_name: 'SKC-11' }], version: 'V-1' }));
    const result = await shein.execute(c, native('goods/product/publishOrEdit'), { body });
    expect(result).toMatchObject({ status: 'acknowledged', data: { spu_name: 'SPU-11', version: 'V-1' } });
    expect(result).not.toHaveProperty('published');
    expect(JSON.parse(mock.mock.calls[3][1]!.body as string)).toEqual(body);
    mock.mockResolvedValueOnce(reply({ data: [{ spu_name: 'SPU-11', state: 'reviewing' }], meta: { count: 1 } }));
    await shein.execute(c, native('goods/query-document-state'), { body: { spuList: [{ spuName: 'SPU-11', version: 'V-1' }] } });
    expect(mock).toHaveBeenCalledTimes(5);
    // The provider field prose requires supply cost instead of selling prices
    // for semi-managed SKUs; a shared required marker must not reject that mode.
    const semiManaged: any = structuredClone(body);
    delete semiManaged.skc_list[0].sku_list[0].price_info_list;
    semiManaged.skc_list[0].sku_list[0].cost_info = { cost_price: '12.50', currency: 'USD' };
    mock.mockResolvedValueOnce(reply({ success: true, spu_name: 'SPU-12', version: 'V-2' }));
    await expect(shein.execute(c, native('goods/product/publishOrEdit'), { body: semiManaged })).resolves.toMatchObject({ status: 'acknowledged' });
    expect(JSON.parse(mock.mock.calls[5][1]!.body as string)).toEqual(semiManaged);
  });

  it('retains full order amounts and fulfillment contacts while redacting credential fields and error prose', async () => {
    const { c, mock } = await connected();
    const details = [{ orderNo: 'O-11', productTotalPrice: '21.00', receiveMsg: { recipientName: 'Fixture recipient', phone: 'Fixture phone', address: 'Fixture address' }, secretKey: SHEIN_SECRET, nested: { message: SHEIN_KEY } }];
    mock.mockResolvedValueOnce(reply(details));
    const result = await shein.execute(c, native('order/order-detail'), { body: { orderNoList: ['O-11'] } });
    expect(result.data[0]).toMatchObject({ receiveMsg: details[0].receiveMsg, productTotalPrice: '21.00' });
    expect(JSON.stringify(result)).not.toContain(SHEIN_SECRET);
    expect(JSON.stringify(result)).not.toContain(SHEIN_KEY);
    expect(result.data[0]).not.toHaveProperty('secretKey');
    expect(result.data[0].nested).not.toHaveProperty('message');
    const list = { queryType: 2, startTime: '2026-09-28 00:00:00', endTime: '2026-09-29 00:00:00', page: 2, pageSize: 30, orderStatus: 2 };
    mock.mockResolvedValueOnce(reply({ count: 31, orderList: details }));
    expect(await shein.execute(c, native('order/order-list'), { body: list })).toMatchObject({ data: { count: 31, orderList: details.map(({ secretKey, nested, ...v }) => ({ ...v, nested: {} })) } });
    expect(JSON.parse(mock.mock.calls[1][1]!.body as string)).toEqual(list);
  });

  it('preserves review status and partial per-site pricing outcomes', async () => {
    const { c, mock } = await connected();
    const body = { productPriceList: [{ productCode: 'SKU-11', currencyCode: 'USD', shopPrice: 12.5, specialPrice: 0, site: 'shein-us' }] };
    mock.mockResolvedValueOnce(reply({ data: [{ productCode: 'SKU-11', site: 'shein-us', success: true, status: 2 }] }));
    expect(await shein.execute(c, native('openapi-business-backend/product/price/save'), { body })).toMatchObject({ status: 'acknowledged', data: { data: [{ status: 2 }] } });
    mock.mockResolvedValueOnce(reply({ data: [{ productCode: 'SKU-11', site: 'shein-us', success: false, status: 0, message: SECRET }] }));
    expect(await shein.execute(c, native('openapi-business-backend/product/price/save'), { body })).toMatchObject({ status: 'partial_or_failed', data: { data: [{ status: 0 }] } });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('supports zero saleable stock on v1 and bounded VI/JI batches on v2 without allowing physical stock', async () => {
    const { c, mock } = await connected();
    mock.mockResolvedValueOnce(reply({ failedList: [], successList: [{ skuCode: 'SKU-11' }] }));
    expect(await shein.execute(c, native('gsp/goods/change-inventory'), { body: { updateSkuInventoryQuantityRequests: [{ skuCode: 'SKU-11', saleInventory: 0 }] } })).toMatchObject({ status: 'acknowledged' });
    const body = { updateSkuInventoryQuantityRequests: [
      { idempotencyKey: 'stock-001', skuCode: 'SKU-11', invType: 'VI', warehouseCode: 'WH-1', changeType: 'OVERWRITE', changeQuantity: 1 },
      { idempotencyKey: 'stock-002', skuCode: 'SKU-12', invType: 'JI', changeType: 'ADD', changeQuantity: 2 },
    ] };
    mock.mockResolvedValueOnce(reply({ failedList: [{ skuCode: 'SKU-12', code: 'stock-004', reason: SECRET }] }));
    const result = await shein.execute(c, native('stock/change-inventory/v2'), { body });
    expect(result).toMatchObject({ status: 'partial_or_failed', data: { failedList: [{ skuCode: 'SKU-12', code: 'stock-004' }] } });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    await expect(shein.execute(c, native('stock/change-inventory/v2'), { body: { updateSkuInventoryQuantityRequests: [{ ...body.updateSkuInventoryQuantityRequests[0], invType: 'PI' }] } })).rejects.toThrow(/parameters/);
    await expect(shein.execute(c, native('gsp/goods/change-inventory'), { body: { updateSkuInventoryQuantityRequests: [{ skuCode: 'SKU-11', saleInventory: 0, changeInventoryQuantity: 0 }] } })).rejects.toThrow(/parameters/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('keeps shipment submission, failed waybill reconciliation and return receipt distinct from completion', async () => {
    const { c, mock } = await connected();
    const shipment = { expressChannelCode: 'CH-1', preRequestId: 'SHIP-001', packageInfoList: [{ orderNo: 'O-11' }] };
    mock.mockResolvedValueOnce(reply({ deliveryNo: 'D-1', placeRequestId: 'P-1' }));
    expect(await shein.execute(c, native('gsp/place-express-order'), { body: shipment })).toMatchObject({ status: 'acknowledged', data: { placeRequestId: 'P-1' } });
    const waybill = { orderNo: 'O-11', infoList: [{ expressCode: 'TRACK-1', expressIdCode: 'CARRIER-1', goodsId: 123, status: 2 }] };
    mock.mockResolvedValueOnce(reply([{ goodsId: 123, expressCode: 'TRACK-1', status: '2', errorMsg: SECRET }]));
    expect(await shein.execute(c, native('order/import-batch-multiple-express'), { body: waybill })).toMatchObject({ status: 'partial_or_failed', data: [{ goodsId: 123 }] });
    mock.mockResolvedValueOnce(reply([]));
    expect(await shein.execute(c, native('order/import-batch-multiple-express'), { body: waybill })).toMatchObject({ status: 'acknowledged', data: [] });
    mock.mockResolvedValueOnce(reply({ returnOrderNo: 'RET-1', goodsIdList: [123] }));
    expect(await shein.execute(c, native('return-order/sign-return-order'), { body: { returnOrderNo: 'RET-1', goodsIdList: [123] } })).toMatchObject({ status: 'acknowledged' });
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it('encodes GET queries and DELETE paths on the fixed bound host and accepts documented void acknowledgements', async () => {
    const { c, mock } = await connected();
    mock.mockResolvedValueOnce(reply({ checkOrderNo: 'STATEMENT&1', itemList: [] }));
    await shein.execute(c, native('finance/get-check-order-detail', 'GET'), { query: { checkOrderNo: 'STATEMENT&1' } });
    expect(String(mock.mock.calls[0][0])).toBe('https://openapi.sheincorp.com/open-api/finance/get-check-order-detail?checkOrderNo=STATEMENT%261');
    expect(mock.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
    expect(mock.mock.calls[0][1]).not.toHaveProperty('body');
    mock.mockResolvedValueOnce(reply({ apply_no: 'DEL-1', deleted: false, id: 'SKC-11' }));
    expect(await shein.execute(c, native('goods/delete/{skcName}', 'DELETE'), { path: { skcName: 'SKC-11' } })).toMatchObject({ status: 'acknowledged', data: { deleted: false, apply_no: 'DEL-1' } });
    expect(mock.mock.calls[1][1]).toMatchObject({ method: 'DELETE' });
    expect(String(mock.mock.calls[1][0])).toBe('https://openapi.sheincorp.com/open-api/goods/delete/SKC-11');
    mock.mockResolvedValueOnce(reply(null));
    await expect(shein.execute(c, native('goods/save-certificate-pool-skc-bind'), { body: { skcCertificatePoolRelationList: [{ certificatePoolIdList: [123], skcName: 'SKC-11', spuName: 'SPU-11' }] } })).resolves.toMatchObject({ status: 'acknowledged', data: null });
  });

  it('uses the custom-product data envelope and leaves task polling explicit', async () => {
    const { c, mock } = await connected();
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '0', data: { id: 'CUSTOM-1', customInfo: { preview: { texts: ['Fixture custom text'] } } } })));
    const result = await shein.execute(c, native('ccst/v1/custom-infos', 'GET'), { query: { customInfoId: 'CUSTOM-1', lang: 'en' } });
    expect(result.data.customInfo.preview.texts).toEqual(['Fixture custom text']);
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ code: '0', data: { id: 'TASK-1', status: 1 } })));
    expect(await shein.execute(c, native('ccst/v1/composite/queryTask', 'GET'), { query: { id: 'TASK-1' } })).toMatchObject({ data: { status: 1 } });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('uploads a bounded inline file as multipart without exposing local paths or overriding signing headers', async () => {
    const { c, mock } = await connected();
    mock.mockResolvedValueOnce(reply({ image_url: 'https://img.shein.com/fixture.png' }));
    await shein.execute(c, native('goods/upload-pic'), { body: { image_type: 6, file: { name: 'fixture.png', content_base64: 'aW1hZ2U=' } } });
    const init = mock.mock.calls[0][1]!;
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get('image_type')).toBe('6');
    expect(await ((init.body as FormData).get('file') as Blob).text()).toBe('image');
    expect(init.headers).not.toHaveProperty('content-type');
    expect(init.headers).toHaveProperty('x-lt-signature');
    await expect(shein.execute(c, native('goods/upload-pic'), { body: { image_type: 6, file: { name: '../private.png', content_base64: 'aW1hZ2U=' } } })).rejects.toThrow(/parameters/);
    await expect(shein.execute(c, native('goods/upload-pic'), { body: { image_type: 6, file: { name: 'large.png', content_base64: 'eA=='.repeat(100000) } } })).rejects.toThrow(/oversized|parameters/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed nested requests and unknown actions before IO, and does not replay provider permission failures', async () => {
    const { c, mock } = await connected();
    await expect(shein.execute(c, native('goods/product/partialEdit'), { body: { spu_name: 'SPU-11', is_spu_pic: 'false' } })).rejects.toThrow(/parameters/);
    await expect(shein.execute(c, native('goods/product/partialEdit'), { body: { spu_name: 'SPU-11', app_secret: SECRET } })).rejects.toThrow(/parameters/);
    await expect(shein.execute(c, native('goods/delete/{skcName}', 'DELETE'), { path: { skcName: '../store' } })).rejects.toThrow(/parameters/);
    await expect(shein.execute(c, 'POST https://other.example/orders', {})).rejects.toThrow(/Unreviewed/);
    expect(mock).not.toHaveBeenCalled();
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ msg: SECRET }), { status: 403 }));
    await expect(shein.execute(c, native('goods/product/partialEdit'), { body: { spu_name: 'SPU-11' } })).rejects.toMatchObject({ code: 'storefront_permission_denied', message: expect.not.stringContaining(SECRET) });
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockResolvedValueOnce(reply({ success: true, spu_name: 'SPU-11' }));
    await expect(shein.execute(c, native('goods/product/partialEdit'), { body: { spu_name: 'SPU-11' } })).resolves.toMatchObject({ status: 'acknowledged' });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete success envelopes and preserves per-item failure evidence instead of claiming every write succeeded', async () => {
    const { c, mock } = await connected();
    mock.mockResolvedValueOnce(reply({}));
    await expect(shein.execute(c, native('goods/product/partialEdit'), { body: { spu_name: 'SPU-11' } })).rejects.toMatchObject({ code: 'storefront_invalid_response' });
    mock.mockResolvedValueOnce(reply({ data: [] }));
    await expect(shein.execute(c, native('openapi-business-backend/product/price/save'), { body: { productPriceList: [{ productCode: 'SKU-11', currencyCode: 'USD', shopPrice: 12, site: 'shein-us' }] } })).rejects.toMatchObject({ code: 'storefront_invalid_response' });
    mock.mockResolvedValueOnce(reply({ failedList: [], successList: [{ skuCode: 'OTHER-SKU' }] }));
    await expect(shein.execute(c, native('gsp/goods/change-inventory'), { body: { updateSkuInventoryQuantityRequests: [{ skuCode: 'SKU-11', saleInventory: 0 }] } })).rejects.toMatchObject({ code: 'storefront_invalid_response' });
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ code: 'Denied', info: { success: true }, msg: SHEIN_SECRET })));
    await expect(shein.execute(c, native('goods/product/partialEdit'), { body: { spu_name: 'SPU-11' } })).rejects.toMatchObject({ code: 'storefront_request_failed', message: expect.not.stringContaining(SHEIN_SECRET) });
    expect(mock).toHaveBeenCalledTimes(4);
  });

  it.each(['fetch', 'body'])('preserves scoped cancellation during %s without replaying a write and permits a later explicit call', async (stage) => {
    const { c, mock } = await connected(), owner = new AbortController();
    mock.mockImplementationOnce(async (_url, init) => {
      if (stage === 'fetch') { owner.abort(SECRET); init!.signal!.throwIfAborted(); }
      return { ok: true, body: undefined, text: async () => { owner.abort(SECRET); init!.signal!.throwIfAborted(); } } as unknown as Response;
    });
    await expect(withRequestSignal(owner.signal, () => shein.execute(c, native('goods/product/partialEdit'), { body: { spu_name: 'SPU-11' } }))).rejects.toMatchObject({ code: 'E_TOOL_CALL_CANCELLED', message: expect.not.stringContaining(SECRET) });
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockResolvedValueOnce(reply({ success: true, spu_name: 'SPU-11' }));
    await expect(shein.execute(c, native('goods/product/partialEdit'), { body: { spu_name: 'SPU-11' } })).resolves.toMatchObject({ status: 'acknowledged' });
  });
});
