import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(import.meta.url);
const native = require('../../../../bin/shopify-business-api.cjs');
const contracts = require('../../../../bin/shopify-api-contracts.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
const evidence = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../fixtures/connectors/official-contracts/shopify-20261001.json'), 'utf8'));
const config = () => ({ provider: 'shopify', metadata: { shop_domain: 'merchant.myshopify.com' }, credentials: { client_id: 'fixture-client', client_secret: 'fixture-secret' } });
const owners = { token: vi.fn(async () => 'fixture-token') };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); owners.token.mockClear(); });
// Merchant journeys: complete product inputs and explicit output, inventory
// mutation acknowledgement, grant boundaries, bounded queries and uncertain writes.
describe('Shopify merchant contracts', () => {
  it('retains official inputs, oneOf and defaults while excluding ungranted, deprecated and unavailable operations', () => {
    const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/sdk/validation/ajv');
    const validator = new AjvJsonSchemaValidator();
    const actions = native.actionsFor(), types = Object.fromEntries(evidence.model.types.map((t: any) => [t.name, t]));
    expect(actions.productSet.risk).toBe('D');
    expect(actions.orderEditBegin).toBeUndefined(); expect(actions.companyCreate).toBeUndefined(); expect(actions.flowGenerateSignature).toBeUndefined();
    expect(actions.collectionAddProducts).toBeUndefined(); expect(actions.fulfillmentOrderAcceptFulfillmentRequest).toBeUndefined();
    expect(actions.productSet.input_schema.$defs.ProductSetInput.properties).toHaveProperty('productOptions');
    expect(actions.productSet.input_schema.$defs.ProductSetInput.properties).toHaveProperty('metafields');
    expect(actions.productSet.input_schema.properties.arguments.properties.synchronous.default).toBe(true);
    for (const row of evidence.inventory) {
      if (row.excluded_reason) { expect(actions[row.operation]).toBeUndefined(); continue; }
      expect(() => validator.getValidator(actions[row.operation].input_schema)).not.toThrow();
      const root = types[row.kind === 'queries' ? 'QueryRoot' : 'Mutation'].fields.find((f: any) => f.name === row.operation);
      expect(Object.keys(actions[row.operation].input_schema.properties.arguments.properties)).toEqual(root.args.filter((a: any) => !a.isDeprecated).map((a: any) => a.name));
      for (const [name, schema] of Object.entries(actions[row.operation].input_schema.$defs) as [string, any][]) {
        if (name === 'Selection') continue;
        if (types[name].kind === 'INPUT_OBJECT') {
          expect(Object.keys(schema.properties)).toEqual(types[name].inputFields.filter((f: any) => !f.isDeprecated).map((f: any) => f.name));
          if (types[name].isOneOf) expect(schema).toMatchObject({ minProperties: 1, maxProperties: 1 });
        }
      }
      expect(actions[row.operation].input_schema.$defs.Product).toBeUndefined();
    }
    expect(() => native.build('productSet', { arguments: { identifier: { id: 'gid://shopify/Product/1', handle: 'blue' }, input: { title: 'Blue' } } })).toThrow();
    const row = contracts.methods.productSet; delete contracts.methods.productSet;
    try { expect(() => native.build('productSet', { arguments: { input: { title: 'Blue' } } })).toThrow(); } finally { contracts.methods.productSet = row; }
  });
  it('discovers one reachable output type at a time with full argument schemas and no grant escape', () => {
    expect(native.actionsFor().products.output_type).toBe('ProductConnection');
    const product = native.describeOutputType('products', 'Product');
    expect(product.fields.variants.type).toBe('ProductVariantConnection!');
    expect(product.fields.variants.arguments.properties).toHaveProperty('first');
    expect(product.fields.variants.arguments.$defs.ProductVariantSortKeys.enum).toContain('ID');
    expect(product.fields.variants).not.toHaveProperty('children');
    expect(native.describeOutputType('products', 'ProductStatus').enum_values).toContain('ACTIVE');
    const discount = native.describeOutputType('discountNode', 'Discount');
    expect(discount.possible_types).toContain('DiscountCodeBasic');
    for (const type of ['Mutation', 'Company', 'DelegateAccessToken']) expect(() => native.describeOutputType('products', type)).toThrow();
    expect(native.describeOutputType('customer', 'Customer').fields.companyContactProfiles).toBeUndefined();
  });
  it('keeps large output graphs out of defaults and binds search and nested pagination as variables', () => {
    const minimal = native.build('products', {});
    expect(minimal.query).toContain('nodes{id title status}'); expect(minimal.query).not.toContain('variants');
    const text = 'sku:BLUE ) { orders { id } }';
    const built = native.build('products', { arguments: { first: 2, query: text }, selection: [{ field: 'nodes', children: [{ field: 'id' }, { field: 'variants', arguments: { first: 3, after: 'next-page' }, children: [{ field: 'nodes', children: [{ field: 'id' }, { field: 'price' }] }, { field: 'pageInfo', children: [{ field: 'hasNextPage' }, { field: 'endCursor' }] }] }] }] });
    expect(built.query).not.toContain(text); expect(Object.values(built.variables)).toContain(text); expect(Object.values(built.variables)).toContain('next-page'); expect(built.query).toContain('variants(first:$');
    const owner = native.build('metafieldsSet', { arguments: { metafields: [{ ownerId: 'gid://shopify/Product/1', namespace: 'custom', key: 'json', type: 'json', value: '{"ownerId":"not-an-authority","ownerType":"ARTICLE"}' }] } });
    expect(Object.values(owner.variables)).toContainEqual([{ ownerId: 'gid://shopify/Product/1', namespace: 'custom', key: 'json', type: 'json', value: '{"ownerId":"not-an-authority","ownerType":"ARTICLE"}' }]);
  });
  it('sends complete product input once and requires projected acknowledgement and user errors', async () => {
    const fetch = vi.fn().mockResolvedValue(response({ data: { productSet: { product: { id: 'gid://shopify/Product/1', title: 'Blue fixture-token', status: 'DRAFT' }, userErrors: [] } }, extensions: { cost: { requestedQueryCost: 12, actualQueryCost: 11 } } })); vi.stubGlobal('fetch', fetch);
    const input = { title: 'Blue', productOptions: [{ name: 'Size', values: [{ name: 'Small' }] }], variants: [{ optionValues: [{ optionName: 'Size', name: 'Small' }], price: '0.00' }], metafields: [{ namespace: 'custom', key: 'composition', type: 'json', value: '{"field":"cotton"}' }] };
    expect(await native.execute(config(), 'productSet', { arguments: { input } }, owners)).toMatchObject({ status: 'acknowledged', data: { productSet: { product: { title: 'Blue [redacted]' } } }, cost: { requested: 12, actual: 11 } });
    const [url, init] = fetch.mock.calls[0]; expect(url).toBe('https://merchant.myshopify.com/admin/api/2026-07/graphql.json'); expect(init.headers['x-shopify-access-token']).toBe('fixture-token'); expect(init.redirect).toBe('error');
    const wire = JSON.parse(init.body); expect(Object.values(wire.variables)).toContainEqual(input); expect(wire.query).toContain('userErrors{field message code}'); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('provides required inventory idempotency without changing the submitted zero quantity', () => {
    const built = native.build('inventorySetQuantities', { arguments: { input: { name: 'available', reason: 'correction', quantities: [{ inventoryItemId: 'gid://shopify/InventoryItem/1', locationId: 'gid://shopify/Location/2', quantity: 0, changeFromQuantity: 1 }] } }, selection: [{ field: 'inventoryAdjustmentGroup', children: [{ field: 'reason' }] }] });
    expect(built.query).toContain('@idempotent(key:$idempotencyKey)'); expect(built.variables.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/); expect(Object.values(built.variables)).toContainEqual(expect.objectContaining({ quantities: [expect.objectContaining({ quantity: 0 })] }));
  });
  it('rejects raw GraphQL, unreviewed fields, excessive traversal, wrong owner and batch overrun before token or IO', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const cases = [
      ['customer', { arguments: { id: 'gid://shopify/Customer/1' }, selection: [{ field: 'companyContactProfiles', children: [{ field: 'id' }] }] }],
      ['products', { query: '{ shop { id } }' }], ['orderEditBegin', { arguments: { id: 'gid://shopify/Order/1' } }],
      ['products', { arguments: { first: 101 } }], ['products', { selection: [{ field: '__schema' }] }],
      ['products', { selection: [{ field: 'nodes', children: [{ field: 'id' }, { field: 'id' }] }] }],
      ['products', { arguments: { first: 100 }, selection: [{ field: 'nodes', children: [{ field: 'variants', arguments: { first: 100 }, children: [{ field: 'nodes', children: [{ field: 'id' }] }] }] }] }],
      ['tagsAdd', { arguments: { id: 'gid://shopify/Article/1', tags: ['x'] } }],
      ['metafieldDefinitionDelete', { arguments: { id: 'gid://shopify/MetafieldDefinition/1', identifier: { ownerType: 'PRODUCT', namespace: 'custom', key: 'x' }, deleteAllAssociatedMetafields: true } }],
      ['productVariantsBulkDelete', { arguments: { productId: 'gid://shopify/Product/1', variantsIds: Array(11).fill('gid://shopify/ProductVariant/1') } }],
      ['productSet', { arguments: { input: { status: 'FABRICATED' } } }],
    ];
    for (const [name, parameters] of cases) await expect(native.execute(config(), name, parameters, owners)).rejects.toMatchObject({ code: 'E_BAD_INPUT' });
    expect(owners.token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not report failed or incomplete writes as successful and retains safe partial reconciliation data', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ data: { productSet: {} } })).mockResolvedValueOnce(response({ data: { productSet: { product: null, userErrors: [] } } })).mockResolvedValueOnce(response({ data: { productSet: { product: { id: 'gid://shopify/Product/1', title: 'Blue', status: 'DRAFT' }, userErrors: [{ field: ['title'], message: 'private provider text fixture-token', code: 'INVALID_INPUT' }] } } })); vi.stubGlobal('fetch', fetch);
    const p = { arguments: { input: { title: 'Blue' } } };
    await expect(native.execute(config(), 'productSet', p, owners)).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
    await expect(native.execute(config(), 'productSet', p, owners)).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
    const partial = await native.execute(config(), 'productSet', p, owners); expect(partial).toMatchObject({ status: 'partial_or_failed', error_count: 1, data: { productSet: { product: { id: 'gid://shopify/Product/1' } } } }); expect(JSON.stringify(partial)).not.toContain('private provider'); expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('validates nullable empty reads, exact selection shapes and union members', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ data: { product: null } })).mockResolvedValueOnce(response({ data: { products: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } })).mockResolvedValueOnce(response({ data: { product: { id: 12 } } })); vi.stubGlobal('fetch', fetch);
    expect(await native.execute(config(), 'product', { arguments: { id: 'gid://shopify/Product/1' } }, owners)).toEqual({ data: { product: null } });
    expect((await native.execute(config(), 'products', {}, owners)).data.products.nodes).toEqual([]);
    await expect(native.execute(config(), 'product', { arguments: { id: 'gid://shopify/Product/1' }, selection: [{ field: 'id' }] }, owners)).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
    const merchantJson = { ownerId: 'not-an-authority', ownerType: 'ARTICLE', password: 'merchant-label', access_token: 'merchant-key-name' };
    fetch.mockResolvedValue(response({ data: { product: { metafield: { jsonValue: merchantJson } } } }));
    const json = await native.execute(config(), 'product', { arguments: { id: 'gid://shopify/Product/1' }, selection: [{ field: 'metafield', arguments: { namespace: 'custom', key: 'json' }, children: [{ field: 'jsonValue' }] }] }, owners);
    expect(json.data.product.metafield.jsonValue).toEqual(merchantJson);
    expect(() => native.build('discountNode', { arguments: { id: 'gid://shopify/DiscountCodeNode/1' }, selection: [{ field: 'discount', children: [{ on_type: 'Product', children: [{ field: 'id' }] }] }] })).toThrow();
  });
  it('classifies throttling, denial, timeout, cancellation and oversized bodies with no mutation replay', async () => {
    for (const [error, expected] of [['THROTTLED', 'E_TOOL_CALL_RATE_LIMIT'], ['ACCESS_DENIED', 'E_TOOL_CALL_AUTH']]) {
      const fetch = vi.fn().mockResolvedValue(response({ errors: [{ message: 'private merchant text', extensions: { code: error } }] })); vi.stubGlobal('fetch', fetch);
      await expect(native.execute(config(), 'productSet', { arguments: { input: { title: 'Blue' } } }, owners)).rejects.toMatchObject({ code: expected }); expect(fetch).toHaveBeenCalledTimes(1);
    }
    const timeout = vi.fn().mockRejectedValue(new DOMException('private', 'TimeoutError')); vi.stubGlobal('fetch', timeout);
    await expect(native.execute(config(), 'productSet', { arguments: { input: { title: 'Blue' } } }, owners)).rejects.toMatchObject({ code: 'E_TOOL_CALL_TIMEOUT' }); expect(timeout).toHaveBeenCalledTimes(1);
    const cancelled = new AbortController(); cancelled.abort(); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(withRequestSignal(cancelled.signal, () => native.execute(config(), 'products', {}, owners))).rejects.toMatchObject({ code: 'E_TOOL_CALL_CANCELLED' }); expect(fetch).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ x: 'x'.repeat(1024 * 1024) })));
    await expect(native.execute(config(), 'products', {}, owners)).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
  });
});
