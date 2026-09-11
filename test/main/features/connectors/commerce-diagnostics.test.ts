import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const require = createRequire(import.meta.url);
const { writeCredentialFile } = require('../../../../bin/local-api-credential-codec.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
const dirs: string[] = [];
const privateMarker = 'private-provider-payload-canary';

function setup(provider = 'square') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-diagnostics-'));
  dirs.push(dir);
  const key = randomBytes(32).toString('base64url');
  const file = path.join(dir, 'credentials.enc');
  const credentials = provider === 'shopify' ? { client_id: 'fixture-app', client_secret: 'fixture-secret' }
    : provider === 'woocommerce' ? { consumer_key: `ck_${'a'.repeat(40)}`, consumer_secret: `cs_${'b'.repeat(40)}` }
      : { access_token: 'fixture-token' };
  const metadata = provider === 'shopify' ? { shop_domain: 'fixture.myshopify.com' }
    : provider === 'lightspeed' ? { store_domain: 'fixture.retail.lightspeed.app' }
    : provider === 'woocommerce' ? { store_url: 'https://fixture.example.com' } : { environment: 'sandbox' };
  writeCredentialFile(file, key, { provider, ...credentials });
  const modulePath = require.resolve('../../../../bin/direct-commerce-mcp-server.cjs');
  const cached = require.cache[modulePath];
  delete require.cache[modulePath];
  const adapter = require(modulePath);
  if (cached) require.cache[modulePath] = cached;
  const env = {
    ORKAS_LOCAL_API_PROVIDER: provider, ORKAS_LOCAL_API_CREDENTIAL_FILE: file,
    ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(metadata),
  };
  return { adapter, env, read: () => adapter.callToolResult('execute_read', {
    action: provider === 'woocommerce' ? 'products.list' : provider === 'shopify' ? 'shop.get' : 'locations.list',
  }, env) };
}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('commerce faults preserve public error codes without leaking private provider data', () => {
  it('verifies Lightspeed via the documented retailer route and preserves the 2.1 product update payload', async () => {
    // Official v1.0/reference/getretailer and docs/products_variants_update.
    const { adapter, env } = setup('lightspeed');
    const fetchMock = vi.fn(async () => json(200, { data: { id: 'retailer-id' } }));
    vi.stubGlobal('fetch', fetchMock);
    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities.identity).toEqual({ data: { id: 'retailer-id' } });
    expect(fetchMock.mock.calls[0][0]).toBe('https://fixture.retail.lightspeed.app/api/2.0/retailer');
    const body = { common: { name: 'Corrected name' }, details: { sku: 'SKU-1' } };
    await adapter.callTool('execute_write', { action: 'products.update', parameters: { id: 'product-id', body } }, env);
    expect(fetchMock.mock.calls[1][0]).toBe('https://fixture.retail.lightspeed.app/api/2.1/products/product-id');
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'PUT', body: JSON.stringify(body) });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retains Square batch reconciliation data but never counts HTTP-200 item errors as full success', async () => {
    // Square handling-errors documents item errors inside successful bulk responses.
    const { adapter, env } = setup();
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, { deleted_object_ids: ['deleted-id'],
      errors: [{ category: 'API_ERROR', code: 'INTERNAL_SERVER_ERROR', detail: privateMarker }] }))
      .mockResolvedValueOnce(json(200, { deleted_object_ids: ['second-id'], errors: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const args = { action: 'catalog.batch_delete', parameters: { body: { object_ids: ['deleted-id', 'second-id'] } } };
    const result = await adapter.callToolResult('execute_destructive', args, env);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).result.deleted_object_ids).toEqual(['deleted-id']);
    expect(result._meta.orkas.errorCode).toBe('E_TOOL_CALL_UPSTREAM');
    expect(JSON.stringify(result._meta)).not.toContain(privateMarker);
    expect(fetchMock).toHaveBeenCalledOnce();
    const next = await adapter.callToolResult('execute_destructive', args, env);
    expect(next.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('preserves a discovery failure across the real JSON-RPC SDK and keeps stdio clean', async () => {
    const { env } = setup();
    const preload = path.join(path.dirname(env.ORKAS_LOCAL_API_CREDENTIAL_FILE), 'fetch.cjs');
    fs.writeFileSync(preload, `global.fetch = async () => ({ok:false,status:429,text:async()=>JSON.stringify({message:${JSON.stringify(privateMarker)}})});`);
    const transport = new StdioClientTransport({ command: process.env.ORKAS_TEST_NODE || process.execPath,
      args: ['--require', preload, path.resolve('bin/direct-commerce-mcp-server.cjs')], env, stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += chunk; });
    const client = new Client({ name: 'diagnostic-fixture', version: '1.0.0' });
    try {
      await client.connect(transport);
      const error = await client.listTools().then(() => null, caught => caught);
      expect(error).not.toBeNull();
      expect(error.data).toMatchObject({ orkas: { errorCode: 'E_TOOL_CALL_RATE_LIMIT' } });
      expect(JSON.stringify(error)).not.toContain(privateMarker);
    } finally { await client.close(); }
    expect(stderr).toBe('');
  });

  it.each([
    [401, 'E_TOOL_CALL_AUTH', 'auth'], [403, 'E_TOOL_CALL_AUTH', 'auth'],
    [429, 'E_TOOL_CALL_RATE_LIMIT', 'upstream'], [503, 'E_TOOL_CALL_UPSTREAM', 'upstream'],
    [400, 'E_BAD_INPUT', 'validation'], [422, 'E_BAD_INPUT', 'validation'],
  ])('preserves authoritative HTTP %s through the MCP envelope', async (status, code) => {
    const fetchMock = vi.fn(async () => json(Number(status), { message: privateMarker }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await setup().read();
    expect(result).toMatchObject({ isError: true, _meta: { orkas: { errorCode: code } } });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(fetchMock).toHaveBeenCalledOnce(); // Error handling must not retry.
  });

  it.each(['square', 'woocommerce'])('keeps timeout and network causes across %s privacy wrappers', async provider => {
    const fixture = setup(provider);
    for (const [fault, code] of [[new TypeError(privateMarker), 'E_TOOL_CALL_NETWORK'],
      [new DOMException(privateMarker, 'TimeoutError'), 'E_TOOL_CALL_TIMEOUT']] as const) {
      const fetchMock = vi.fn(async () => { throw fault; });
      vi.stubGlobal('fetch', fetchMock);
      const result = await fixture.read();
      expect(result).toMatchObject({ isError: true, _meta: { orkas: { errorCode: code } } });
      expect(result._meta.orkas.errorCode).toBe(code);
      expect(JSON.stringify(result)).not.toContain(privateMarker);
      expect(fetchMock).toHaveBeenCalledOnce();
    }
  });

  it('excludes a user cancellation with a private custom reason and sends no request', async () => {
    const fixture = setup();
    const controller = new AbortController();
    controller.abort(privateMarker);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await withRequestSignal(controller.signal, fixture.read);
    expect(result).toMatchObject({ isError: true, _meta: { orkas: { errorCode: 'E_TOOL_CALL_CANCELLED' } } });
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not count an HTML gateway response as a successful API read, and recovers on the next call', async () => {
    const fixture = setup();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200,
      text: async () => `<html>${privateMarker}</html>` }).mockResolvedValueOnce(json(200, { locations: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const failure = await fixture.read();
    expect(failure).toMatchObject({ isError: true });
    expect(failure._meta.orkas.errorCode).toBe('E_TOOL_CALL_UPSTREAM');
    expect(JSON.stringify(failure)).not.toContain(privateMarker);
    const recovered = await fixture.read();
    expect(recovered.isError).toBeUndefined();
    expect(JSON.parse(recovered.content[0].text).result).toEqual({ locations: [] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('Shopify 2026-07 official query and error contracts', () => {
  function shopifyFetch(body: unknown) {
    const fetchMock = vi.fn().mockResolvedValueOnce(json(200, {
      access_token: 'fixture-token', expires_in: 86400,
      scope: 'write_products,write_orders,write_customers,write_inventory,read_locations,write_draft_orders,write_returns,write_discounts,write_publications,write_merchant_managed_fulfillment_orders',
    })).mockResolvedValue(json(200, body));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('adds the required inventory idempotency directive without changing input or retrying', async () => {
    // https://shopify.dev/docs/api/admin-graphql/2026-07/mutations/inventorySetQuantities
    const { adapter, env } = setup('shopify');
    const fetchMock = shopifyFetch({ data: { inventorySetQuantities: { inventoryAdjustmentGroup: {}, userErrors: [] } } });
    const input = { name: 'available', reason: 'correction', quantities: [{ inventoryItemId: 'gid://shopify/InventoryItem/1',
      locationId: 'gid://shopify/Location/2', quantity: 12, changeFromQuantity: 10 }] };
    await adapter.callTool('execute_high_impact', { action: 'inventory.set_quantities', parameters: { input } }, env);
    const request = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(request.query).toContain('$idempotencyKey:String!');
    expect(request.query).toContain('@idempotent(key:$idempotencyKey)');
    expect(request.variables.input).toEqual(input);
    expect(request.variables.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an overlong cancellation note before dispatch, while accepting the official 255-character boundary', async () => {
    const { adapter, env } = setup('shopify');
    const fetchMock = shopifyFetch({ data: { orderCancel: { job: { id: 'job', done: false }, userErrors: [] } } });
    const parameters = { order_id: 'gid://shopify/Order/1', reason: 'OTHER', restock: false,
      refund_method: { originalPaymentMethodsRefund: true }, staff_note: 'x'.repeat(256) };
    await expect(adapter.callTool('execute_destructive', { action: 'orders.cancel', parameters }, env)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await adapter.callTool('execute_destructive', { action: 'orders.cancel', parameters: { ...parameters, staff_note: 'x'.repeat(255) } }, env);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).variables.staffNote).toHaveLength(255);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['returns.get', { id: 'gid://shopify/Return/1' }, 'updatedAt', 'returnLineItems'],
    ['publications.list', {}, 'catalog{title type}', 'pageInfo'],
  ])('only selects documented fields for %s', async (action, parameters, absent, retained) => {
    // Return has no updatedAt; Catalog has no type. Both invalidate the whole query.
    // https://shopify.dev/docs/api/admin-graphql/2026-07/objects/Return
    // https://shopify.dev/docs/api/admin-graphql/2026-07/interfaces/Catalog
    const { adapter, env } = setup('shopify');
    const fetchMock = shopifyFetch({ data: { resource: {} } });
    await adapter.callTool('execute_read', { action, parameters }, env);
    const query = JSON.parse(fetchMock.mock.calls[1][1].body).query;
    expect(query).not.toContain(absent);
    expect(query).toContain(retained);
  });

  it.each([
    [{ errors: [{ extensions: { code: 'THROTTLED' }, message: privateMarker }] }, 'E_TOOL_CALL_RATE_LIMIT'],
    [{ errors: [{ extensions: { code: 'ACCESS_DENIED' }, message: privateMarker }] }, 'E_TOOL_CALL_AUTH'],
    [{ errors: [{ extensions: { code: privateMarker }, message: privateMarker }] }, 'E_TOOL_CALL_UPSTREAM'],
    [{ data: { productCreate: { userErrors: [{ field: ['title'], message: privateMarker }] } } }, 'E_BAD_INPUT'],
    [{ data: null }, 'E_TOOL_CALL_UPSTREAM'],
  ])('classifies HTTP-200 GraphQL failure by structured data, never by private prose (%#)', async (body, code) => {
    const fixture = setup('shopify');
    const fetchMock = shopifyFetch(body);
    const result = await fixture.read();
    expect(result).toMatchObject({ isError: true, _meta: { orkas: { errorCode: code } } });
    expect(result._meta.orkas.errorCode).toBe(code);
    expect(JSON.stringify(result)).not.toContain(privateMarker);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
