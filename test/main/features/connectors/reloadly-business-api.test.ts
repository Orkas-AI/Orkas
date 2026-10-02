import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
const require = createRequire(import.meta.url);
const api = require('../../../../bin/reloadly-business-api.cjs');
const contracts = require('../../../../bin/reloadly-api-contracts.cjs');
const evidence = require('../../../fixtures/connectors/official-contracts/reloadly-20261001.json');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
const config = (product = 'giftcards', environment = 'sandbox') => ({ provider: 'reloadly', metadata: { product, environment }, credentials: { client_id: 'fixture-client', client_secret: 'fixture-secret' } });
const owners = { token: async () => 'fixture-token', base: (c: any) => `https://${({ airtime: 'topups', giftcards: 'giftcards', utilities: 'utilities' } as any)[c.metadata.product]}${c.metadata.environment === 'sandbox' ? '-sandbox' : ''}.reloadly.com` };
const response = (value: any, status = 200) => new Response(JSON.stringify(value), { status });
const balance = { balance: 100.25, currencyCode: 'USD' };
const gift = { productId: 10, quantity: 2, unitPrice: 5.5, senderName: 'Merchant', customIdentifier: 'order-001', productAdditionalRequirements: { userId: 'player-4' }, preOrder: true };
afterEach(() => vi.unstubAllGlobals());

it('discovers the current product inventory with full purchase inputs and keeps token acquisition outside business actions', () => {
  for (const [product, count] of [['airtime', 21], ['giftcards', 16], ['utilities', 5]] as const) {
    const source = evidence.products[product].model;
    const published = Object.entries(source.paths).flatMap(([path, item]: [string, any]) => path === '/oauth/token' ? [] : Object.keys(item).filter(method => ['get', 'post'].includes(method)));
    const actions = api.actionsFor(config(product));
    expect(published).toHaveLength(count); expect(Object.keys(actions)).toHaveLength(count);
    expect(Object.values(actions).every((row: any) => row.input_schema.additionalProperties === false)).toBe(true);
  }
  const body = api.actionsFor(config())['giftcards.order-a-gift-card'].input_schema.properties.body;
  expect(body.properties).toHaveProperty('productAdditionalRequirements'); expect(body.properties).toHaveProperty('preOrder');
  expect(body.required).toEqual(expect.arrayContaining(['senderName', 'unitPrice', 'customIdentifier']));
  expect(body.properties).not.toHaveProperty('countryCode'); expect(body.required).not.toContain('recipientEmail');
  expect(api.actionsFor(config('utilities'))).not.toHaveProperty('utilities.countries.list');
  expect(api.isNative('authentication.access-token')).toBe(false);
  const row = contracts.methods['giftcards.order-a-gift-card']; delete contracts.methods['giftcards.order-a-gift-card'];
  try { expect(() => api.build(config(), 'giftcards.order-a-gift-card', { body: gift })).toThrow(/unavailable/); }
  finally { contracts.methods['giftcards.order-a-gift-card'] = row; }
});

it('builds current query and path contracts without cross-product access or arbitrary transport fields', () => {
  expect(api.build(config(), 'giftcards.get-all-products', { query: { global: false, page: 2, productName: 'A & B' } }).route)
    .toBe('/products?size=20&page=2&productName=A+%26+B&global=false');
  expect(api.build(config('utilities'), 'utilities.get-transaction-by-id', { path: { id: 36 } }).route).toBe('/transactions/36');
  expect(api.build(config(), 'giftcards.get-redeem-instructions-by-product-id', { path: { productId: 4 } }).route).toBe('/products/4/redeem-instructions');
  expect(api.build(config('airtime'), 'airtime.auto-detect-an-operator', { path: { phone: '003238482221', countryisocode: 'PK' } }).route).toContain('/003238482221/');
  for (const parameters of [{ query: { size: 101 } }, { query: { page: 0 } }, { url: 'https://untrusted.invalid' }, { query: { token: 'input-secret' } }]) {
    expect(() => api.build(config(), 'giftcards.get-all-products', parameters)).toThrow(/Invalid/);
  }
  expect(() => api.build(config('utilities'), 'giftcards.get-all-products', {})).toThrow(/unavailable/);
  expect(() => api.build(config(), 'giftcards.get-transaction-by-id', { path: { transactionId: '../accounts' } })).toThrow(/identifier/);
});

it('sends one complete gift purchase after a fresh balance read and retains valid digital goods while removing credentials', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(balance)).mockResolvedValueOnce(response({ transactionId: 3116, status: 'SUCCESSFUL', recipientEmail: null, access_token: 'extra-auth', note: 'fixture-secret', product: { pinCode: 'BUSINESS-PIN', cardNumber: '00012345' } })); vi.stubGlobal('fetch', fetch);
  const result = await api.execute(config(), 'giftcards.order-a-gift-card', { body: gift }, owners);
  expect(result).toMatchObject({ status: 'acknowledged', balance_before: balance, transaction: { transactionId: 3116, recipientEmail: null, note: '[redacted]', product: { pinCode: 'BUSINESS-PIN', cardNumber: '00012345' } } });
  expect(result.transaction).not.toHaveProperty('access_token');
  expect(fetch.mock.calls.map(call => call[0])).toEqual(['https://giftcards-sandbox.reloadly.com/accounts/balance', 'https://giftcards-sandbox.reloadly.com/orders']);
  expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual(gift);
  expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer fixture-token', accept: 'application/com.reloadly.giftcards-v1+json' } });
  expect(fetch.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal);
});

it('preserves paid lookup risk even for GET and exposes asynchronous outcomes without claiming completion', async () => {
  expect(api.actionsFor(config('airtime'))['airtime.number-lookup-get'].risk).toBe('H');
  expect(api.actionsFor(config('airtime'))['airtime.number-lookup-post'].risk).toBe('H');
  const fetch = vi.fn().mockResolvedValueOnce(response(balance)).mockResolvedValueOnce(response({ id: 88, operatorId: 88, name: 'Operator' }))
    .mockResolvedValueOnce(response(balance)).mockResolvedValueOnce(response({ transactionId: 4602843 }))
    .mockResolvedValueOnce(response(balance)).mockResolvedValueOnce(response({ id: 36, status: 'PROCESSING', referenceId: 'bill-001', code: 'PAYMENT_PROCESSING_IN_PROGRESS', message: 'Processing' })); vi.stubGlobal('fetch', fetch);
  await api.execute(config('airtime'), 'airtime.number-lookup-get', { path: { phone: '003238482221', countryCode: 'PK' } }, owners);
  const async = await api.execute(config('airtime'), 'airtime.top-ups-async', { body: { operatorId: '535', amount: '5.25', recipientEmail: 'receiver@nauta.com.cu', customIdentifier: 'topup-001' } }, owners);
  const utility = await api.execute(config('utilities'), 'utilities.pay-bill', { body: { subscriberAccountNumber: '0012345', amount: 2.5, billerId: 5, amountId: 1, referenceId: 'bill-001', additionalInfo: { invoiceId: 'INV-9' } } }, owners);
  expect(async.status).toBe('pending'); expect(utility.status).toBe('pending');
  expect(fetch.mock.calls.map(call => new URL(call[0]).pathname)).toEqual(['/accounts/balance', '/operators/mnp-lookup/phone/003238482221/countries/PK', '/accounts/balance', '/topups-async', '/accounts/balance', '/pay']);
  expect(JSON.parse(fetch.mock.calls[5][1].body).subscriberAccountNumber).toBe('0012345');
});

it('rejects missing references and invalid purchases before any credential or provider work', async () => {
  const token = vi.fn(owners.token), fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  for (const body of [{ ...gift, customIdentifier: undefined }, { ...gift, quantity: 0 }, { ...gift, unitPrice: 0 }, { ...gift, productAdditionalRequirements: { unknown: 'value' } }]) {
    await expect(api.execute(config(), 'giftcards.order-a-gift-card', { body }, { ...owners, token })).rejects.toMatchObject({ code: 'E_BAD_INPUT' });
  }
  expect(token).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('does not spend after failed balance checks or replay ambiguous financial requests', async () => {
  for (const before of [{}, { balance: '100', currencyCode: 'USD' }, { balance: 100 }, { errorCode: 'INVALID_TOKEN' }]) {
    const fetch = vi.fn().mockResolvedValue(response(before)); vi.stubGlobal('fetch', fetch);
    await expect(api.execute(config(), 'giftcards.order-a-gift-card', { body: gift }, owners)).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' }); expect(fetch).toHaveBeenCalledTimes(1);
  }
  for (const failure of [new DOMException('Deadline', 'TimeoutError'), new TypeError('Disconnected')]) {
    const fetch = vi.fn().mockResolvedValueOnce(response(balance)).mockRejectedValueOnce(failure); vi.stubGlobal('fetch', fetch);
    await expect(api.execute(config(), 'giftcards.order-a-gift-card', { body: gift }, owners)).rejects.toThrow(/transaction history/); expect(fetch).toHaveBeenCalledTimes(2);
  }
  const fetch = vi.fn().mockResolvedValue(response(balance)); vi.stubGlobal('fetch', fetch); const controller = new AbortController(); controller.abort();
  await expect(withRequestSignal(controller.signal, () => api.execute(config(), 'giftcards.order-a-gift-card', { body: gift }, owners))).rejects.toMatchObject({ code: 'E_TOOL_CALL_CANCELLED' }); expect(fetch).not.toHaveBeenCalled();
});

it('rejects false acknowledgements and returns explicit failure for a provider-reported refund without exposing error text', async () => {
  for (const transaction of [{}, { transactionId: 1 }, { transactionId: 1, status: 'UNRECOGNIZED' }, { transactionId: 1, status: 'SUCCESSFUL', customIdentifier: 'another-order' }, { status: 'SUCCESSFUL' }, { errorCode: 'FAILED', message: 'private error text' }]) {
    const fetch = vi.fn().mockResolvedValueOnce(response(balance)).mockResolvedValueOnce(response(transaction)); vi.stubGlobal('fetch', fetch);
    await expect(api.execute(config(), 'giftcards.order-a-gift-card', { body: gift }, owners)).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' }); expect(fetch).toHaveBeenCalledTimes(2);
  }
  const fetch = vi.fn().mockResolvedValueOnce(response(balance)).mockResolvedValueOnce(response({ transactionId: 1, status: 'REFUNDED', message: 'private rejection detail' })); vi.stubGlobal('fetch', fetch);
  expect(await api.execute(config(), 'giftcards.order-a-gift-card', { body: gift }, owners)).toEqual({ status: 'partial_or_failed', balance_before: balance, transaction: { transactionId: 1, status: 'REFUNDED' } });
});

it('bounds provider failures and response reads without retries or raw provider error disclosure', async () => {
  for (const [status, code] of [[401, 'E_TOOL_CALL_AUTH'], [429, 'E_TOOL_CALL_RATE_LIMIT'], [500, 'E_TOOL_CALL_UPSTREAM']] as const) {
    const fetch = vi.fn().mockResolvedValue(response({ message: 'private provider detail' }, status)); vi.stubGlobal('fetch', fetch);
    await expect(api.execute(config(), 'giftcards.get-all-products', {}, owners)).rejects.toMatchObject({ code }); expect(fetch).toHaveBeenCalledTimes(1);
  }
  const huge = vi.fn().mockResolvedValue(response({ data: 'a'.repeat(1024 * 1024) })); vi.stubGlobal('fetch', huge);
  await expect(api.execute(config(), 'giftcards.get-all-products', {}, owners)).rejects.toThrow(/oversized/); expect(huge).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  const interrupted = vi.fn().mockResolvedValue({ ok: true, text: async () => { controller.abort(new Error('private cancellation reason')); throw new Error('body read interrupted'); } }); vi.stubGlobal('fetch', interrupted);
  await expect(withRequestSignal(controller.signal, () => api.execute(config(), 'giftcards.get-all-products', {}, owners))).rejects.toMatchObject({ code: 'E_TOOL_CALL_CANCELLED' });
  expect(interrupted).toHaveBeenCalledTimes(1);
});

it('preserves large numeric transaction and card identifiers exactly and can query the returned identifier', async () => {
  const raw = '{"transactionId":9007199254740993,"status":"SUCCESSFUL","amount":5.25,"text":"9007199254740993 and \\"quoted\\"","cardNumber":612020034514906433}';
  const fetch = vi.fn().mockResolvedValueOnce(new Response(raw)).mockResolvedValueOnce(response(balance)).mockResolvedValueOnce(new Response(raw)); vi.stubGlobal('fetch', fetch);
  const read = await api.execute(config(), 'giftcards.get-transaction-by-id', { path: { transactionId: '9007199254740993' } }, owners);
  expect(read.data).toMatchObject({ transactionId: '9007199254740993', cardNumber: '612020034514906433', amount: 5.25, text: '9007199254740993 and "quoted"' });
  expect(fetch.mock.calls[0][0]).toBe('https://giftcards-sandbox.reloadly.com/reports/transactions/9007199254740993');
  const paid = await api.execute(config(), 'giftcards.order-a-gift-card', { body: gift }, owners); expect(paid.transaction.transactionId).toBe('9007199254740993');
  expect(api.build(config('utilities'), 'utilities.get-transaction-by-id', { path: { id: '9007199254740993' } }).route).toBe('/transactions/9007199254740993');
  expect(() => api.build(config('utilities'), 'utilities.get-transaction-by-id', { path: { id: 9007199254740992 } })).toThrow(/Invalid/);
  for (const raw of ['{"id":1e400}', '{"id":9.007199254740993e15}', '{"id":09007199254740993}']) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(raw)));
    await expect(api.execute(config(), 'giftcards.get-all-products', {}, owners)).rejects.toMatchObject({ code: 'E_TOOL_CALL_UPSTREAM' });
  }
});

it('supports both official redemption representations and preserves pagination and nullable business data', async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ redemptionUrl: 'https://gift.example/redeem', cardNumber: '00012', pinCode: '1234' }))
    .mockResolvedValueOnce(response([{ cardNumber: '00012', pinCode: '1234' }]))
    .mockResolvedValueOnce(response({ content: [], totalElements: 0, totalPages: 0, size: 20, number: 0 })); vi.stubGlobal('fetch', fetch);
  for (const version of [2, 1]) {
    const result = await api.execute(config(), 'giftcards.get-a-redeem-code', { path: { transactionId: 1 }, redemption_version: version }, owners);
    expect(JSON.stringify(result)).toContain('1234'); expect(fetch.mock.calls[2 - version][1].headers.accept).toBe(`application/com.reloadly.giftcards-v${version}+json`);
  }
  expect(await api.execute(config('utilities'), 'utilities.get-all-transactions', {}, owners)).toEqual({ data: { content: [], totalElements: 0, totalPages: 0, size: 20, number: 0 } });
});
