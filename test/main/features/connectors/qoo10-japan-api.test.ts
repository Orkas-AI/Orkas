import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const api = require('../../../../bin/qoo10-japan-api.cjs');
const auth = require('../../../../bin/local-api-auth.cjs');
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs');
const codec = require('../../../../bin/local-api-credential-codec.cjs');
const KEY = 'fixture-qoo10-private-certification';
const config = () => ({ provider: 'qoo10_japan', metadata: {}, credentials: { certification_key: KEY } });
const reply = (ResultObject: unknown, ResultCode = 0) => new Response(JSON.stringify({ ResultCode, ResultObject, ResultMsg: KEY }));
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Qoo10 Japan seller QAPI', () => {
  it('makes the official pending-order default explicit and can request shipped or delivered orders', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ TotalItems: 0, TotalPages: 0, PresentPage: 0, Items: [] })));
    const c = { ...config(), credentials: await api.authorize(config()) };
    const fetchMock = vi.fn(async () => reply([])); vi.stubGlobal('fetch', fetchMock);
    // Method 10045: omitted/0 ShippingStat returns only states 1–3, not all orders.
    const pending = await api.execute(c, 'orders.list', { day: '20260916' });
    expect(pending.shipping_status).toBe('1-3');
    for (const shipping_status of ['4', '5']) {
      await api.execute(c, 'orders.list', { day: '20260916', shipping_status });
      expect(new URLSearchParams(fetchMock.mock.calls.at(-1)![1].body).get('ShippingStat')).toBe(shipping_status);
    }
  });
  it('rejects stock option fields beyond the official 50-character limit before issuing a write', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ TotalItems: 0, TotalPages: 0, PresentPage: 0, Items: [] })));
    const c = { ...config(), credentials: await api.authorize(config()) };
    const fetchMock = vi.fn(async () => reply(undefined)); vi.stubGlobal('fetch', fetchMock);
    // QAPI method 10022 parameter table specifies Max 50 for all three option fields.
    for (const key of ['option_name', 'option_value', 'option_code']) {
      await expect(api.execute(c, 'inventory.set', { item_code: '123456789', option_name: '色',
        option_value: '青', option_code: 'BLUE', quantity: 0, [key]: 'a'.repeat(51) })).rejects.toThrow(/parameter/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('recognizes official authorization codes while keeping nonexistent-API errors distinct at HTTP 200', async () => {
    // Gateway -90000 observed without authorization; remaining codes are in each method's official return-code table.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const envelope of [{ ErrorCode: -90000 }, { ErrorCode: -90002 }, { ErrorCode: -90003 },
      { ErrorCode: -90004 }, { ErrorCode: -90005 }, { ResultCode: -10000 }, { ErrorCode: -90001 }]) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...envelope, ErrorMsg: KEY, ResultMsg: KEY })));
      await expect(api.authorize(config())).rejects.toMatchObject({
        code: envelope.ErrorCode === -90001 ? 'E_TOOL_CALL_UPSTREAM' : 'E_TOOL_CALL_AUTH', message: expect.not.stringContaining(KEY),
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });
  it('authorizes with only the seller key, restarts from encrypted storage and preserves method versions, paging and risk lanes', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toMatch(/^https:\/\/api\.qoo10\.jp\/GMKT\.INC\.Front\.QAPIService\/ebayjapan\.qapi\//);
      expect(url).not.toContain(KEY);
      expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { GiosisCertificationKey: KEY } });
      expect(init.signal).toBeInstanceOf(AbortSignal);
      if (url.endsWith('GetAllGoodsInfo')) return reply({ TotalItems: 501, TotalPages: 2, PresentPage: 1, Items: [{ ItemCode: '123456789', SellerCode: 'sku' }] });
      if (url.endsWith('GetItemDetailInfo')) {
        expect(init.headers).toMatchObject({ QAPIVersion: '1.2' });
        return reply([{ ItemCode: '123456789', ItemPrice: '1000' }]);
      }
      if (url.endsWith('GetGoodsInventoryInfo')) return reply([{ Name1: '色', Value1: '青', ItemTypeCode: 'BLUE', Qty: 3 }]);
      if (url.endsWith('GetShippingInfo_v2')) return reply([{ orderNo: 123, orderQty: 2, total: 1000, Currency: 'JPY', buyer: 'Private', receiver: 'Private', shippingAddr: 'Private', ShippingMsg: 'Private' }]);
      if (url.endsWith('UpdateInventoryQtyUnit')) return reply(undefined);
      throw new Error('Unexpected method');
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(auth.SELF_AUTH_PROVIDERS.has('qoo10_japan')).toBe(true);
    const credentials = await auth.authorizeConfigured(config());
    const root = mkdtempSync(join(tmpdir(), 'orkas-qoo10-'));
    try {
      const file = join(root, 'credentials.enc'); const key = randomBytes(32).toString('base64url');
      codec.writeCredentialFile(file, key, credentials);
      expect(readFileSync(file, 'utf8')).not.toContain(KEY);
      const env = { ORKAS_LOCAL_API_PROVIDER: 'qoo10_japan', ORKAS_LOCAL_API_CREDENTIAL_FILE: file,
        ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: '{}' };
      const products = await adapter.callTool('execute_read', { action: 'products.list', parameters: { status: 'S2', page: 1 } }, env);
      expect(JSON.stringify(products)).toContain('TotalPages');
      for (const action of ['products.get', 'inventory.get']) await adapter.callTool('execute_read', { action, parameters: { item_code: '123456789' } }, env);
      const orders = await adapter.callTool('execute_read', { action: 'orders.list', parameters: { day: '20260916' } }, env);
      expect(JSON.stringify(orders)).toContain('orderNo');
      expect(JSON.stringify(orders)).not.toMatch(/Private|buyer|receiver|ShippingMsg/);
      const before = fetchMock.mock.calls.length;
      await expect(adapter.callTool('execute_read', { action: 'inventory.set' }, env)).rejects.toThrow(/risk mismatch/);
      expect(fetchMock).toHaveBeenCalledTimes(before);
      await adapter.callTool('execute_high_impact', { action: 'inventory.set', parameters: { item_code: '123456789', option_name: '色', option_value: '青', option_code: 'BLUE', quantity: 0 } }, env);
      expect(Object.fromEntries(new URLSearchParams(fetchMock.mock.calls.at(-1)![1].body as string))).toEqual({ returnType: 'json', ItemCode: '123456789', OptionName: '色', OptionValue: '青', OptionCode: 'BLUE', Qty: '0' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects invalid dates, arbitrary methods, metadata, key substitution and malformed input before network access', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply({ TotalItems: 0, TotalPages: 0, PresentPage: 0, Items: [] })));
    const c = { ...config(), credentials: await api.authorize(config()) };
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    for (const [name, params] of [['orders.list', { day: '20260230' }], ['products.list', { status: 'S9' }], ['products.list', { status: 'S2', endpoint: 'evil' }], ['raw.api', {}], ['inventory.set', { item_code: '1', option_name: 'x', option_value: 'x', option_code: 'x', quantity: -1 }]]) {
      await expect(api.execute(c, name, params)).rejects.toThrow();
    }
    await expect(api.execute({ ...c, metadata: { endpoint: 'https://evil.test' } }, 'products.list', { status: 'S2' })).rejects.toThrow();
    await expect(api.execute({ ...c, credentials: { ...c.credentials, certification_key: 'different-private-key' } }, 'products.list', { status: 'S2' })).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not persist invalid authorization or treat business errors and malformed results as success', async () => {
    const fetchMock = vi.fn(async () => reply({}, -100)); vi.stubGlobal('fetch', fetchMock);
    await expect(api.authorize(config())).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM', message: expect.not.stringContaining(KEY) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(reply({ Items: [] }));
    await expect(api.authorize(config())).rejects.toThrow(/pagination/);
  });
});
