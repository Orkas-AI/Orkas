import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, installFixture, rows, SECRET, TOKEN } from './merchant-platform-fixtures';

const require = createRequire(import.meta.url);
const temu = require('../../../../bin/temu-seller-api.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
const evidence = JSON.parse(readFileSync(new URL('../../../fixtures/connectors/official-contracts/temu-20260930.json', import.meta.url), 'utf8'));
const hostOwned = [
  'bg.open.accesstoken.create', 'bg.cooperativewarehouse.token.authorization',
  'bg.local.mall.info.get', 'bg.local.goods.gallery.signature.get',
  'temu.aftersales.signature.get', 'temu.logistics.self.delivery.pod.upload.signature.query',
  'temu.pay.tax.get.galerie.signature',
];
const nativeScopes = [
  'bg.order.list.v2.get', 'bg.order.shippinginfo.v2.get', 'bg.local.goods.partial.update',
  'bg.local.goods.stock.edit', 'bg.logistics.shipment.v2.confirm', 'bg.tmc.message.update',
  'temu.aftersales.refund.issue', 'temu.local.goods.delete', 'bg.local.goods.spec.id.get',
];
async function connected() {
  const mock = installFixture(rows[1]);
  const initial = config(rows[1]);
  const c = { ...initial, credentials: await temu.authorize(initial) };
  c.credentials.identity.scopes.push(...nativeScopes);
  mock.mockClear();
  return { c, mock };
}
const reply = (data: unknown) => new Response(JSON.stringify({ success: true, result: data }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Temu complete merchant business contracts', () => {
  it('preserves every regional request field tree and compiles the published action schemas', () => {
    const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
    const compiler = new AjvJsonSchemaValidator();
    const types: Record<number, string> = { 1: 'integer', 2: 'integer', 4: 'string', 5: 'boolean', 6: 'object', 7: 'object', 8: 'array' };
    function compare(field: any, schema: any) {
      expect(schema.type).toBe(types[field.param_type]);
      if (field.param_type === 6) {
        const fields = field.open_param_list || [];
        expect(Object.keys(schema.properties).sort()).toEqual(fields.map((f: any) => f.param_name).sort());
        expect(schema.required.slice().sort()).toEqual(fields.filter((f: any) => f.required).map((f: any) => f.param_name).sort());
        expect(schema.additionalProperties).toBe(false);
        for (const child of fields) compare(child, schema.properties[child.param_name]);
      } else if (field.param_type === 7) {
        compare(field.open_param_list.find((f: any) => f.param_name === '$value'), schema.additionalProperties);
      } else if (field.param_type === 8) {
        if (field.param_type_desc === 'OBJECT[]') compare({ ...field, param_type: 6 }, schema.items);
        else expect(schema.items.type).toBe(field.param_type_desc === 'STRING[]' ? 'string' : 'integer');
      } else if (field.param_type === 1 || field.param_type === 2) {
        expect(schema.maximum).toBe(field.param_type === 1 ? 2147483647 : Number.MAX_SAFE_INTEGER);
        expect(schema.minimum).toBe(field.param_type === 1 ? -2147483648 : Number.MIN_SAFE_INTEGER);
      }
    }
    for (const region of ['us', 'eu', 'global']) {
      const actions = temu.actionsFor({ region });
      for (const row of evidence.regions[region]) {
        if (!actions[row.method]) continue;
        let source = evidence.definitions[row.definition_sha256].request_parameters;
        if (row.method === 'bg.cooperativewarehouse.fulfill.submit') {
          source = { ...source, open_param_list: source.open_param_list.filter((f: any) => !['authorizeKey', 'authorizeToken'].includes(f.param_name))
            .map((f: any) => f.param_name === 'cwCustomerCode' ? { ...f, required: true } : f) };
          expect(actions[row.method].input_schema.properties.authorizeType.enum).toEqual([0]);
        }
        compare(source, actions[row.method].input_schema);
        expect(compiler.getValidator(actions[row.method].input_schema)).toBeTypeOf('function');
      }
    }
  });
  it.each(['us', 'eu', 'global'])('discovers every documented business method in %s and discloses authorization/reference gaps', (region) => {
    // The denominator is a separately pinned public provider inventory, not the
    // runtime action table. Missing business families cannot pass as complete.
    const docs = evidence.regions[region];
    const expected = [...new Set<string>(docs.filter((r: any) =>
      evidence.definitions[r.definition_sha256].status === 'documented' && !hostOwned.includes(r.method),
    ).map((r: any) => r.method))].sort();
    const actions = temu.actionsFor({ region });
    expect(Object.keys(actions).filter(name => name.startsWith('bg.') || name.startsWith('temu.')).sort()).toEqual(expected);
    expect(actions['bg.local.goods.spec.id.get'].risk).toBe('W');
    expect(actions['temu.aftersales.refund.issue'].risk).toBe('H');
    expect(actions['temu.local.goods.delete'].risk).toBe('D');
    for (const name of hostOwned) expect(actions[name]).toBeUndefined();
    const coverage = temu.coverageFor({ region });
    expect(coverage.complete).toBe(false);
    expect(coverage.reviewed_business_methods).toBe(expected.length);
    expect(coverage.unavailable_methods.sort()).toEqual([...new Set(docs.filter((r: any) =>
      evidence.definitions[r.definition_sha256].status === 'documentation_unavailable',
    ).map((r: any) => r.method))].sort());
  });

  it('preserves filters, false flags, page continuation and full business results', async () => {
    const { c, mock } = await connected();
    const params = { pageNumber: 2, pageSize: 20, parentOrderStatus: 2, parentOrderSnList: ['PO-11'], hasPreSaleOrder: false, skuId: 12 };
    const data = { pageItems: [{ parentOrderMap: { parentOrderSn: 'PO-11' }, orderAmount: { amount: '120.00', currency: 'USD' } }], totalItemNum: 31 };
    mock.mockResolvedValueOnce(reply(data));
    expect(await temu.execute(c, 'bg.order.list.v2.get', params)).toMatchObject({ data });
    const sent = JSON.parse(mock.mock.calls[0][1]!.body as string);
    expect(sent).toMatchObject({ ...params, type: 'bg.order.list.v2.get' });
    expect(sent).not.toHaveProperty('page');
    expect(sent).not.toHaveProperty('request');
    expect(mock.mock.calls[0][0]).toBe('https://openapi-b-us.temu.com/openapi/router');
  });

  it('returns authorized fulfillment contact fields while removing credentials from nested results', async () => {
    const { c, mock } = await connected();
    mock.mockResolvedValueOnce(reply({ fullName: 'Fixture recipient', phone: 'fixture-phone', addressLine1: 'Fixture address', warning: { reason: 3 }, accessToken: TOKEN, nested: { app_secret: SECRET, text: `do not echo ${TOKEN}` } }));
    const result = await temu.execute(c, 'bg.order.shippinginfo.v2.get', { parentOrderSn: 'PO-11' });
    expect(result.data).toMatchObject({ fullName: 'Fixture recipient', phone: 'fixture-phone', addressLine1: 'Fixture address' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.data).not.toHaveProperty('accessToken');
    expect(result.data.warning).toEqual({ reason: 3 });
    expect(result.data.nested).not.toHaveProperty('app_secret');
  });

  it('edits nested product properties and typed language maps without losing booleans or empty strings', async () => {
    const { c, mock } = await connected();
    const params = { goodsId: 11, goodsBasic: { goodsName: 'Updated item' }, goodsDesc: '', goodsTrademark: { noTrademark: false }, guideFileInfo: { lang2GuideFileUrl: { en: 'https://assets.example/manual.pdf' } } };
    mock.mockResolvedValueOnce(reply({ goodsId: 11 }));
    await temu.execute(c, 'bg.local.goods.partial.update', params);
    expect(JSON.parse(mock.mock.calls[0][1]!.body as string)).toMatchObject(params);
    const before = mock.mock.calls.length;
    await expect(temu.execute(c, 'bg.local.goods.partial.update', { ...params, guideFileInfo: { lang2GuideFileUrl: { en: 12 } } })).rejects.toThrow(/parameters/);
    await expect(temu.execute(c, 'bg.local.goods.partial.update', { ...params, goodsTrademark: { noTrademark: 'false' } })).rejects.toThrow(/parameters/);
    expect(mock).toHaveBeenCalledTimes(before);
  });

  it('supports void refund and boolean webhook acknowledgements without claiming remote completion', async () => {
    const { c, mock } = await connected();
    mock.mockResolvedValueOnce(new Response(JSON.stringify({ success: true, errorCode: 0 })));
    expect(await temu.execute(c, 'temu.aftersales.refund.issue', { parentAfterSalesSn: 'AS-11', parentOrderSn: 'PO-11', openApiRefundType: 1 })).toMatchObject({ status: 'acknowledged', data: null });
    mock.mockResolvedValueOnce(reply(true));
    expect(await temu.execute(c, 'bg.tmc.message.update', { permitEventCodeList: ['ORDER_UPDATE'] })).toMatchObject({ status: 'acknowledged', data: true });
    mock.mockResolvedValueOnce(reply(false));
    expect(await temu.execute(c, 'bg.tmc.message.update', { cancelEventCodeList: ['ORDER_UPDATE'] })).toMatchObject({ status: 'partial_or_failed', data: false });
  });

  it('retains reconciliation evidence for partial multi-SKU stock changes and rejects missing acknowledgement', async () => {
    const { c, mock } = await connected();
    const params = { goodsId: 11, stockType: 1, requestUniqueKey: 'presale-001', skuStockTargetList: [{ skuId: 12, stockTarget: 0 }, { skuId: 13, stockTarget: 4 }] };
    const data = { goodsId: 11, operateResult: true, skuStockEditStatusInfoList: [{ skuId: 12, stockEditStatus: true }, { skuId: 13, stockEditStatus: false, errorCode: 500, errorMsg: TOKEN }] };
    mock.mockResolvedValueOnce(reply(data));
    const result = await temu.execute(c, 'bg.local.goods.stock.edit', params);
    expect(result.status).toBe('partial_or_failed');
    expect(result.data.skuStockEditStatusInfoList).toMatchObject([{ skuId: 12, stockEditStatus: true }, { skuId: 13, stockEditStatus: false, errorCode: 500 }]);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.parse(mock.mock.calls[0][1]!.body as string)).toMatchObject(params);
    mock.mockResolvedValueOnce(reply({ ...data, skuStockEditStatusInfoList: data.skuStockEditStatusInfoList.slice(0, 1) }));
    await expect(temu.execute(c, 'bg.local.goods.stock.edit', params)).rejects.toThrow(/acknowledged/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('rejects absent permissions, wrong region, nested transport overrides and malformed shipments before IO', async () => {
    const { c, mock } = await connected();
    await expect(temu.execute({ ...c, credentials: { ...c.credentials, identity: { ...c.credentials.identity, scopes: [] } } }, 'bg.order.shippinginfo.v2.get', { parentOrderSn: 'PO-11' })).rejects.toThrow(/permission/);
    await expect(temu.execute(c, 'temu.order.amount.v3.query', { parentOrderSn: 'PO-11' })).rejects.toThrow(/Unreviewed/);
    await expect(temu.execute(c, 'bg.local.goods.partial.update', { goodsId: 11, goodsBasic: { app_secret: SECRET } })).rejects.toThrow(/parameters/);
    await expect(temu.execute(c, 'bg.logistics.shipment.v2.confirm', { sendType: 0, sendRequestList: [{ carrierId: 1, trackingNumber: 'TRACK-1' }] })).rejects.toThrow(/parameters/);
    expect(mock).not.toHaveBeenCalled();
  });

  it('uses platform-owned warehouse grants without exposing warehouse credentials', async () => {
    const { c, mock } = await connected();
    c.credentials.identity.scopes.push('bg.cooperativewarehouse.fulfill.submit');
    const fields = temu.actionsFor(c.metadata)['bg.cooperativewarehouse.fulfill.submit'].input_schema.properties;
    expect(fields).not.toHaveProperty('authorizeKey');
    expect(fields).not.toHaveProperty('authorizeToken');
    const warehouse = { warehouseProviderCode: 'fixture-warehouse', warehouseCode: 'WH-1', cwCustomerCode: 'fixture-customer', erpFulfillNo: 'EF-1', orderList: [{ parentOrderSn: 'PO-11', orderSn: 'O-11', cwSkuCode: 'SKU-1', quantity: 1 }] };
    mock.mockResolvedValueOnce(reply({ fulfillStatus: 1, erpFulfillNo: 'EF-1', cwFulfillNo: 'CF-1' }));
    await expect(temu.execute(c, 'bg.cooperativewarehouse.fulfill.submit', warehouse)).resolves.toMatchObject({ status: 'acknowledged' });
    await expect(temu.execute(c, 'bg.cooperativewarehouse.fulfill.submit', { ...warehouse, authorizeType: 1, authorizeToken: TOKEN })).rejects.toThrow(/parameters/);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(temu.coverageFor(c.metadata)).toMatchObject({ complete: false, max_inline_parameter_bytes: 256 * 1024 });
  });

  it('rejects oversized inline uploads before IO and permits a later bounded upload in its documented region', async () => {
    const { c, mock } = await connected();
    c.metadata.region = 'global';
    c.credentials.identity.region = 'global';
    c.credentials.identity.scopes.push('bg.flash.open.upload.real.image');
    await expect(temu.execute(c, 'bg.flash.open.upload.real.image', { image: 'A'.repeat(256 * 1024) })).rejects.toThrow(/oversized/);
    expect(mock).not.toHaveBeenCalled();
    mock.mockResolvedValueOnce(reply({ url: 'https://assets.example/fixture.png' }));
    await expect(temu.execute(c, 'bg.flash.open.upload.real.image', { image: 'aW1hZ2U=' })).resolves.toMatchObject({ data: { url: 'https://assets.example/fixture.png' } });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock.mock.calls[0][0]).toBe('https://openapi-b-global.temu.com/openapi/router');
  });

  it('does not replay an uncertain refund and preserves later explicit recovery', async () => {
    const { c, mock } = await connected();
    const params = { parentAfterSalesSn: 'AS-11', parentOrderSn: 'PO-11', openApiRefundType: 1 };
    mock.mockRejectedValueOnce(new Error(TOKEN));
    await expect(temu.execute(c, 'temu.aftersales.refund.issue', params)).rejects.toMatchObject({ code: 'storefront_network_failed', message: expect.not.stringContaining(TOKEN) });
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockResolvedValueOnce(reply({ fullName: 'Fixture recipient' }));
    await expect(temu.execute(c, 'bg.order.shippinginfo.v2.get', { parentOrderSn: 'PO-11' })).resolves.toMatchObject({ data: { fullName: 'Fixture recipient' } });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it.each(['request', 'body'])('reports cancellation during %s without replaying a refund or exposing its reason', async (phase) => {
    const { c, mock } = await connected();
    const owner = new AbortController();
    mock.mockImplementationOnce(async (_url: unknown, init: RequestInit) => {
      const fail = () => { owner.abort(TOKEN); throw new DOMException(TOKEN, 'AbortError'); };
      if (phase === 'request') return fail();
      expect(init.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, status: 200, text: async () => fail() };
    });
    await expect(withRequestSignal(owner.signal, () => temu.execute(c, 'temu.aftersales.refund.issue', {
      parentAfterSalesSn: 'AS-11', parentOrderSn: 'PO-11', openApiRefundType: 1,
    }))).rejects.toMatchObject({ code: 'E_TOOL_CALL_CANCELLED', message: expect.not.stringContaining(TOKEN) });
    expect(mock).toHaveBeenCalledTimes(1);
    mock.mockResolvedValueOnce(reply({ fullName: 'Fixture recipient' }));
    await expect(temu.execute(c, 'bg.order.shippinginfo.v2.get', { parentOrderSn: 'PO-11' })).resolves.toMatchObject({ data: { fullName: 'Fixture recipient' } });
  });
});
