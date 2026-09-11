import { createRequire } from 'node:module';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { afterEach, describe, expect, it, vi } from 'vitest';
import shopifyRequirements from '../../../../bin/shopify-setup-requirements.cjs';

const require = createRequire(import.meta.url);
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs') as {
  withRequestSignal: <T>(signal: AbortSignal, operation: () => Promise<T>) => Promise<T>;
};
const codec = require('../../../../bin/local-api-credential-codec.cjs') as {
  encryptPayload: (key: string, payload: Record<string, unknown>) => string;
  decryptPayload: (key: string, payload: string) => Record<string, unknown>;
  readCredentialFile: (file: string, key: string) => Record<string, unknown>;
  writeCredentialFile: (file: string, key: string, payload: Record<string, unknown>) => void;
};
const adapter = require('../../../../bin/direct-commerce-mcp-server.cjs') as {
  TOOLS: Array<{ name: string; _meta: { orkas: { actionPolicy: { risk: string } } } }>;
  SHOPIFY_ACTIONS: Record<string, { risk: string }>;
  CONSTANT_CONTACT_ACTIONS: Record<string, { risk: string }>;
  COMMERCE_LAYER_ACTIONS: Record<string, { risk: string }>;
  LIGHTSPEED_ACTIONS: Record<string, { risk: string }>;
  RELOADLY_ACTIONS: Record<string, Record<string, { risk: string }>>;
  SQUARE_ACTIONS: Record<string, { risk: string }>;
  INSTACART_ACTIONS: Record<string, { risk: string }>;
  WOOCOMMERCE_ACTIONS: Record<string, { risk: string }>;
  WALMART_COMMON_ACTIONS: Record<string, { risk: string }>;
  WALMART_RETURN_ACTIONS: Record<string, { risk: string }>;
  EBAY_ACTIONS: Record<string, { risk: string }>;
  ETSY_ACTIONS: Record<string, { risk: string }>;
  AMAZON_ACTIONS: Record<string, { risk: string }>;
  MERCADO_LIBRE_ACTIONS: Record<string, { risk: string }>;
  TAOBAO_ACTIONS: Record<string, { risk: string }>;
  ALIBABA_1688_ACTIONS: Record<string, { risk: string }>;
  JD_ACTIONS: Record<string, { risk: string }>;
  PINDUODUO_ACTIONS: Record<string, { risk: string }>;
  DOUYIN_SHOP_ACTIONS: Record<string, { risk: string }>;
  KUAISHOU_SHOP_ACTIONS: Record<string, { risk: string }>;
  YOUZAN_ACTIONS: Record<string, { risk: string }>;
  WEIMOB_WOS_ACTIONS: Record<string, { risk: string }>;
  XIAOHONGSHU_ARK_ACTIONS: Record<string, { risk: string }>;
  signDouyin: (appKey: string, method: string, paramJson: string, timestamp: string, secret: string) => string;
  signKuaishou: (parameters: Record<string, string>, secret: string) => string;
  signXiaohongshu: (pathName: string, query: Record<string, string>, appKey: string, timestamp: string, appSecret: string) => string;
  SQUARE_API_VERSION: string;
  validateParameters: (value: unknown) => Record<string, unknown>;
  validateActionParameters: (spec: unknown, value: unknown) => Record<string, unknown>;
  validateReloadlyPurchase: (product: string, body: unknown) => void;
  validateSquareMutation: (action: string, body: unknown) => void;
  validateInstacartPage: (action: string, body: unknown) => void;
  validateWalmartMutation: (action: string, sku: string, body: unknown) => Record<string, unknown>;
  configured: (env: NodeJS.ProcessEnv) => { credentials: Record<string, unknown>; credentialFile: string; credentialKey: string };
  instacartBase: (config: any) => string;
  instacartMcpEndpoint: (config: any) => string;
  instacartMcpCapabilities: (config: any, fetchImpl?: typeof fetch) => Promise<any>;
  safeId: (value: unknown) => string;
  queryString: (value: unknown) => string;
  redact: (value: unknown) => string;
  actionsFor: (config: { provider: string; metadata: Record<string, string> }) => Record<string, { risk: string }>;
  callTool: (name: string, args: Record<string, unknown>, env: NodeJS.ProcessEnv) => Promise<any>;
};

const tempDirs: string[] = [];

function envFor(
  provider: 'shopify' | 'constant_contact' | 'lightspeed' | 'woocommerce' | 'walmart' | 'ebay' | 'etsy' | 'amazon_seller' | 'mercado_libre' | 'taobao_top' | 'alibaba_1688' | 'jd_jos' | 'pinduoduo' | 'douyin_shop' | 'kuaishou_shop' | 'youzan' | 'weimob_wos' | 'xiaohongshu_ark' | 'reloadly' | 'square' | 'instacart' | 'commerce_layer',
  credentials: Record<string, unknown>,
  metadata: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orkas-${provider}-`));
  tempDirs.push(dir);
  const key = crypto.randomBytes(32).toString('base64url');
  const file = path.join(dir, 'credentials.enc');
  codec.writeCredentialFile(file, key, { provider, ...credentials });
  return {
    ORKAS_LOCAL_API_PROVIDER: provider,
    ORKAS_LOCAL_API_CREDENTIAL_FILE: file,
    ORKAS_LOCAL_API_CREDENTIAL_KEY: key,
    ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(metadata),

  };
}

function response(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: vi.fn(async () => JSON.stringify(body)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('direct commerce stdio adapter', () => {
  it.each(['cancel', 'disconnect', 'continue'])('keeps pending token acquisition inside MCP request ownership: %s', async (mode) => {
    const env = envFor('shopify', { client_id: 'fixture-client', client_secret: 'fixture-secret' }, {
      shop_domain: 'fixture.myshopify.com',
    });
    const dir = path.dirname(env.ORKAS_LOCAL_API_CREDENTIAL_FILE!);
    const started = path.join(dir, 'token-started');
    const mutation = path.join(dir, 'mutation');
    const preload = path.join(dir, 'fetch-fixture.cjs');
    const scopes = [
      'read_products', 'write_products', 'read_orders', 'write_orders', 'read_customers',
      'write_customers', 'read_inventory', 'write_inventory', 'read_locations', 'read_draft_orders',
      'write_draft_orders', 'read_returns', 'write_returns', 'read_discounts', 'write_discounts',
      'read_publications', 'write_publications', 'write_assigned_fulfillment_orders',
    ].join(' ');
    // Intercept every outbound request in the real adapter process. This fixture
    // deliberately completes token acquisition after cancellation to prove that
    // the subsequent business request is checked before dispatch as well.
    fs.writeFileSync(preload, [
      "const fs = require('node:fs');",
      'global.fetch = async (url) => {',
      "  if (String(url).endsWith('/admin/oauth/access_token')) {",
      `    fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
      '    await new Promise(resolve => setTimeout(resolve, 350));',
      `    return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'fixture-token', scope: ${JSON.stringify(scopes)} }) };`,
      '  }',
      "  if (!String(url).endsWith('/graphql.json')) throw new Error('unexpected fixture URL');",
      `  fs.writeFileSync(${JSON.stringify(mutation)}, 'write');`,
      "  return { ok: true, status: 200, text: async () => JSON.stringify({ data: { productCreate: { product: { id: 'fixture-id' }, userErrors: [] } } }) };",
      '};',
    ].join('\n'));
    const transport = new StdioClientTransport({
      command: process.env.ORKAS_TEST_NODE || process.execPath,
      args: ['--require', preload, path.resolve('bin/direct-commerce-mcp-server.cjs')],
      env: env as Record<string, string>, stderr: 'pipe',
    });
    transport.stderr?.resume();
    const client = new Client({ name: 'commerce-cancel-regression', version: '1.0.0' });
    const controller = new AbortController();
    try {
      await client.connect(transport);
      const pending = client.callTool({ name: 'execute_write', arguments: {
        action: 'products.create', parameters: { input: { title: 'fixture' } },
      } }, undefined, { signal: controller.signal }).catch((error) => error);
      await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true));
      if (mode === 'cancel') controller.abort();
      else if (mode === 'disconnect') await client.close();
      const result = await pending;
      if (mode === 'continue') {
        expect(result).not.toBeInstanceOf(Error);
        expect(result.isError).not.toBe(true);
      } else {
        await new Promise(resolve => setTimeout(resolve, 550));
      }
      expect(fs.existsSync(mutation)).toBe(mode === 'continue');
    } finally {
      await client.close();
    }
  });

  it('aborts active provider IO without cancelling another request or dispatching an already-cancelled one', async () => {
    const first = new AbortController();
    const second = new AbortController();
    const signals: AbortSignal[] = [];
    let finishSecond!: () => void;
    const fetchMock = vi.fn((_url: string, init: { signal: AbortSignal }) => new Promise((resolve, reject) => {
      signals.push(init.signal);
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      finishSecond = () => resolve(response(200, { code: 0, events: [] }));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('square', { access_token: 'fixture-token' }, { environment: 'sandbox' });
    const request = () => adapter.callTool('execute_read', { action: 'locations.list' }, env);
    const cancelled = withRequestSignal(first.signal, request).catch((error) => error);
    const continuing = withRequestSignal(second.signal, request);
    try {
      await vi.waitFor(() => expect(signals).toHaveLength(2));
      first.abort();
      expect(await cancelled).toBeInstanceOf(Error);
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
      await expect(withRequestSignal(first.signal, request)).rejects.toThrow();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      finishSecond();
      expect(await continuing).toMatchObject({ result: { events: [] } });
    } finally {
      finishSecond?.();
      await Promise.allSettled([cancelled, continuing]);
    }
  });

  it('encrypts authenticated credential files and rejects tampering', () => {
    const key = crypto.randomBytes(32).toString('base64url');
    const encrypted = codec.encryptPayload(key, { client_secret: 'never-plaintext' });
    expect(encrypted).toMatch(/^ORKAPI1:/);
    expect(encrypted).not.toContain('never-plaintext');
    expect(codec.decryptPayload(key, encrypted)).toEqual({ client_secret: 'never-plaintext' });

    const envelope = JSON.parse(Buffer.from(encrypted.slice('ORKAPI1:'.length), 'base64url').toString('utf8'));
    envelope.data = `${envelope.data[0] === 'A' ? 'B' : 'A'}${envelope.data.slice(1)}`;
    const tampered = `ORKAPI1:${Buffer.from(JSON.stringify(envelope)).toString('base64url')}`;
    expect(() => codec.decryptPayload(key, tampered)).toThrow();
    expect(() => codec.decryptPayload(crypto.randomBytes(32).toString('base64url'), encrypted)).toThrow();
  });

  it('exposes only six governed tools and exact provider action manifests', () => {
    expect(adapter.TOOLS.map((tool) => tool.name)).toEqual([
      'list_capabilities', 'describe_action', 'execute_read', 'execute_write',
      'execute_high_impact', 'execute_destructive',
    ]);
    expect(Object.fromEntries(adapter.TOOLS.map((tool) => [
      tool.name, tool._meta.orkas.actionPolicy.risk,
    ]))).toEqual({
      list_capabilities: 'R', describe_action: 'R', execute_read: 'R',
      execute_write: 'W', execute_high_impact: 'H', execute_destructive: 'D',
    });
    expect(adapter.SHOPIFY_ACTIONS).toMatchObject({
      'shop.get': { risk: 'R' }, 'products.create': { risk: 'W' },
      'collections.get': { risk: 'R' }, 'inventory_items.update': { risk: 'W' },
      'discounts.code_basic_create': { risk: 'H' }, 'publications.publish': { risk: 'H' },
      'orders.cancel': { risk: 'D' }, 'product_variants.bulk_delete': { risk: 'D' },
      'refunds.create': { risk: 'H' }, 'products.delete': { risk: 'D' },
    });
    expect(adapter.CONSTANT_CONTACT_ACTIONS).toMatchObject({
      'contacts.list': { risk: 'R' }, 'campaigns.create': { risk: 'W' },
      'campaigns.schedule': { risk: 'H' }, 'contacts.delete': { risk: 'D' },
    });
    expect(adapter.COMMERCE_LAYER_ACTIONS).toMatchObject({
      'application.get': { risk: 'R' }, 'customers.list': { risk: 'R' },
      'customers.create': { risk: 'W' }, 'customers.update': { risk: 'W' },
      'customers.delete': { risk: 'D' }, 'orders.list': { risk: 'R' },
      'skus.list': { risk: 'R' }, 'stock_items.list': { risk: 'R' },
    });
    expect(adapter.LIGHTSPEED_ACTIONS).toMatchObject({
      'store.get': { risk: 'R' }, 'products.create': { risk: 'W' },
      'sales.create': { risk: 'H' }, 'sales.delete': { risk: 'D' },
    });
    expect(adapter.RELOADLY_ACTIONS.giftcards).toMatchObject({
      'balance.get': { risk: 'R' }, 'orders.create': { risk: 'H' },
    });
    expect(adapter.SQUARE_ACTIONS).toMatchObject({
      'merchant.get': { risk: 'R' }, 'catalog.batch_upsert': { risk: 'W' },
      'orders.create': { risk: 'H' }, 'payments.create': { risk: 'H' },
      'invoices.publish': { risk: 'H' }, 'subscriptions.cancel': { risk: 'D' },
      'loyalty.rewards.redeem': { risk: 'H' }, 'gift_cards.activities.create': { risk: 'H' },
      'disputes.accept': { risk: 'D' }, 'payouts.get': { risk: 'R' },
    });
    expect(Object.keys(adapter.SQUARE_ACTIONS)).toHaveLength(105);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.SQUARE_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 51, W: 12, H: 26, D: 16 });
    expect(adapter.INSTACART_ACTIONS).toEqual({
      'retailers.list': expect.objectContaining({ risk: 'R' }),
      'recipe_page.create': expect.objectContaining({ risk: 'H' }),
      'shopping_list_page.create': expect.objectContaining({ risk: 'H' }),
    });
    expect(adapter.WOOCOMMERCE_ACTIONS).toMatchObject({
      'store.status': { risk: 'R' }, 'products.create': { risk: 'H' },
      'categories.create': { risk: 'W' }, 'orders.update': { risk: 'H' },
      'refunds.create': { risk: 'H' }, 'reviews.create': { risk: 'H' },
      'products.delete': { risk: 'D' }, 'coupons.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.WOOCOMMERCE_ACTIONS)).toHaveLength(68);
    expect(adapter.WALMART_COMMON_ACTIONS).toMatchObject({
      'account.permissions': { risk: 'R' }, 'items.get': { risk: 'R' },
      'inventory.set': { risk: 'H' }, 'price.set': { risk: 'H' },
      'orders.ship': { risk: 'H' }, 'orders.cancel': { risk: 'D' },
    });
    expect(adapter.WALMART_RETURN_ACTIONS).toEqual({
      'returns.list': expect.objectContaining({ risk: 'R' }),
      'returns.get': expect.objectContaining({ risk: 'R' }),
    });
    expect(adapter.EBAY_ACTIONS).toMatchObject({
      'account.privileges': { risk: 'R' }, 'fulfillment_policies.create': { risk: 'W' },
      'inventory_items.replace': { risk: 'H' }, 'offers.publish': { risk: 'H' },
      'shipping_fulfillments.create': { risk: 'H' }, 'offers.withdraw': { risk: 'D' },
    });
    expect(Object.keys(adapter.EBAY_ACTIONS)).toHaveLength(43);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.EBAY_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 18, W: 4, H: 12, D: 9 });
    expect(adapter.ETSY_ACTIONS).toMatchObject({
      'shop.get': { risk: 'R' }, 'listings.create_draft': { risk: 'W' },
      'listing_inventory.update': { risk: 'H' }, 'receipt_shipments.create': { risk: 'H' },
      'listings.delete': { risk: 'D' }, 'shipping_profiles.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.ETSY_ACTIONS)).toHaveLength(35);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.ETSY_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 16, W: 5, H: 9, D: 5 });
    expect(adapter.AMAZON_ACTIONS).toMatchObject({
      'account.marketplace_participations': { risk: 'R' }, 'orders.search': { risk: 'R' },
      'listings.put': { risk: 'H' }, 'listings.patch': { risk: 'H' }, 'listings.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.AMAZON_ACTIONS)).toHaveLength(17);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.AMAZON_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 14, W: 0, H: 2, D: 1 });
    expect(adapter.MERCADO_LIBRE_ACTIONS).toMatchObject({
      'account.get': { risk: 'R' }, 'orders.search': { risk: 'R' },
      'listings.create': { risk: 'H' }, 'questions.answer': { risk: 'H' },
      'listings.delete_marketplace': { risk: 'D' }, 'questions.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.MERCADO_LIBRE_ACTIONS)).toHaveLength(22);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.MERCADO_LIBRE_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 16, W: 0, H: 4, D: 2 });
    expect(adapter.TAOBAO_ACTIONS).toMatchObject({
      'account.get': { risk: 'R' }, 'orders.list': { risk: 'R' },
      'orders.memo_add': { risk: 'W' }, 'inventory.update': { risk: 'H' },
      'listings.unpublish': { risk: 'H' }, 'listings.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.TAOBAO_ACTIONS)).toHaveLength(11);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.TAOBAO_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 5, W: 2, H: 3, D: 1 });
    expect(adapter.ALIBABA_1688_ACTIONS).toMatchObject({
      'account.get': { risk: 'R' }, 'orders.list': { risk: 'R' },
      'inventory.adjust': { risk: 'H' }, 'shipments.offline': { risk: 'H' },
      'products.expire': { risk: 'H' }, 'products.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.ALIBABA_1688_ACTIONS)).toHaveLength(12);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.ALIBABA_1688_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 6, W: 0, H: 5, D: 1 });
    expect(adapter.JD_ACTIONS).toMatchObject({
      'account.get': { risk: 'R' }, 'orders.list': { risk: 'R' },
      'orders.memo_update': { risk: 'W' }, 'inventory.set': { risk: 'H' },
      'refunds.decide': { risk: 'H' }, 'products.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.JD_ACTIONS)).toHaveLength(23);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.JD_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 12, W: 2, H: 8, D: 1 });
    expect(adapter.PINDUODUO_ACTIONS).toMatchObject({
      'account.get': { risk: 'R' }, 'orders.list_basic': { risk: 'R' },
      'orders.note_update': { risk: 'W' }, 'inventory.update': { risk: 'H' },
      'refunds.return_approve': { risk: 'H' }, 'products.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.PINDUODUO_ACTIONS)).toHaveLength(20);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.PINDUODUO_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 9, W: 1, H: 9, D: 1 });
    expect(adapter.DOUYIN_SHOP_ACTIONS).toMatchObject({
      'account.get': { risk: 'R' }, 'orders.list': { risk: 'R' },
      'orders.memo_update': { risk: 'W' }, 'inventory.update': { risk: 'H' },
      'refunds.decide': { risk: 'H' }, 'products.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.DOUYIN_SHOP_ACTIONS)).toHaveLength(22);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.DOUYIN_SHOP_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 11, W: 1, H: 9, D: 1 });
    expect(adapter.KUAISHOU_SHOP_ACTIONS).toMatchObject({
      'account.get': { risk: 'R' }, 'orders.list': { risk: 'R' },
      'products.create': { risk: 'H' }, 'refunds.reject': { risk: 'H' },
      'shipments.send': { risk: 'H' }, 'products.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.KUAISHOU_SHOP_ACTIONS)).toHaveLength(22);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.KUAISHOU_SHOP_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 10, W: 0, H: 11, D: 1 });
    expect(adapter.YOUZAN_ACTIONS).toMatchObject({
      'account.get': { risk: 'R' }, 'orders.list': { risk: 'R' },
      'inventory.update': { risk: 'H' }, 'shipments.send': { risk: 'H' },
      'products.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.YOUZAN_ACTIONS)).toHaveLength(13);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.YOUZAN_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 6, W: 0, H: 6, D: 1 });
    expect(adapter.WEIMOB_WOS_ACTIONS).toMatchObject({
      'account.get': { risk: 'R' }, 'orders.list': { risk: 'R' },
      'inventory.update': { risk: 'H' }, 'refunds.reject': { risk: 'H' },
      'products.delete': { risk: 'D' },
    });
    expect(Object.keys(adapter.WEIMOB_WOS_ACTIONS)).toHaveLength(20);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.WEIMOB_WOS_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 9, W: 0, H: 10, D: 1 });
    expect(adapter.XIAOHONGSHU_ARK_ACTIONS).toMatchObject({
      'connection.check': { risk: 'R' }, 'orders.list': { risk: 'R' },
      'products.spu_create': { risk: 'W' }, 'orders.export': { risk: 'H' },
      'inventory.set': { risk: 'H' }, 'cancellations.audit': { risk: 'H' },
    });
    expect(Object.keys(adapter.XIAOHONGSHU_ARK_ACTIONS)).toHaveLength(38);
    expect(Object.fromEntries(['R', 'W', 'H', 'D'].map((risk) => [
      risk, Object.values(adapter.XIAOHONGSHU_ARK_ACTIONS).filter((spec) => spec.risk === risk).length,
    ]))).toEqual({ R: 17, W: 5, H: 16, D: 0 });
    expect(adapter.signDouyin(
      'app-key', 'product.detail', '{"a":1,"b":2}', '2025-01-02 03:04:05', 'secret',
    )).toBe('4eaefa2d3044c9f9711928edc8cfe5df1b7a8fd2d79d5d62866c79bbc4a09f2a');
    expect(adapter.signKuaishou({ b: '2', a: '1' }, 'secret'))
      .toBe('ed7440a1245c50018f251c9f5b76b6a2058049f6f80d6951e3774888ff55f244');
    expect(adapter.signXiaohongshu('/ark/open_api/v1/items', {
      page_no: '1', page_size: '50', status: '0',
    }, 'xhs', '1469902537', '9a539709cafc1efc9ef05838be468a28'))
      .toBe('72be6fad4dd0e5104dbdebbcdadb2a06');
  });

  it('uses Commerce Layer integration credentials against one bound organization and fixed JSON:API resources', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { access_token: 'commerce-layer-access', expires_in: 7200 }))
      .mockResolvedValueOnce(response(200, { data: { type: 'applications', id: 'app-1' } }))
      .mockResolvedValueOnce(response(200, { data: [{ type: 'customers', id: 'customer-1' }] }))
      .mockResolvedValueOnce(response(200, { data: { type: 'customers', id: 'customer-1', attributes: { email: 'new@example.com' } } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('commerce_layer', {
      client_id: 'commerce-layer-client', client_secret: 'commerce-layer-secret',
    }, { organization_slug: 'sample-shop' });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    const customers = await adapter.callTool('execute_read', {
      action: 'customers.list',
      parameters: { query: { 'page[size]': 25, 'filter[email_eq]': 'buyer@example.com' } },
    }, env);
    const updated = await adapter.callTool('execute_write', {
      action: 'customers.update',
      parameters: { id: 'customer-1', attributes: { email: 'new@example.com' } },
    }, env);

    expect(capabilities.identity).toEqual({ data: { type: 'applications', id: 'app-1' } });
    expect(customers.result.data[0].id).toBe('customer-1');
    expect(updated.result.data.attributes.email).toBe('new@example.com');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://auth.commercelayer.io/oauth/token',
      'https://sample-shop.commercelayer.io/api/application',
      'https://sample-shop.commercelayer.io/api/customers?page%5Bsize%5D=25&filter%5Bemail_eq%5D=buyer%40example.com',
      'https://sample-shop.commercelayer.io/api/customers/customer-1',
    ]);
    const updateInit = fetchMock.mock.calls[3][1];
    expect(updateInit).toMatchObject({
      method: 'PATCH',
      headers: {
        authorization: 'Bearer commerce-layer-access',
        accept: 'application/vnd.api+json',
        'content-type': 'application/vnd.api+json',
      },
    });
    expect(JSON.parse(updateInit.body)).toEqual({
      data: { type: 'customers', id: 'customer-1', attributes: { email: 'new@example.com' } },
    });
    await expect(adapter.callTool('execute_read', {
      action: 'orders.list', parameters: { query: { url: 'https://attacker.test' } },
    }, env)).rejects.toThrow('not allowed');
  });

  it('binds WooCommerce Basic auth to one reviewed HTTPS store and separates risk lanes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { environment: { site_url: 'https://shop.example.com/store' } }))
      .mockResolvedValueOnce(response(200, { id: 42, name: 'Updated product' }))
      .mockResolvedValueOnce(response(200, { id: 42, deleted: true }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('woocommerce', {
      consumer_key: `ck_${'a'.repeat(40)}`, consumer_secret: `cs_${'b'.repeat(40)}`,
    }, { store_url: 'https://shop.example.com/store' });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'woocommerce', binding: { store_url: 'https://shop.example.com/store' },
      identity: {
        store_url: 'https://shop.example.com/store',
        site_url: 'https://shop.example.com/store',
      },
      actions: expect.arrayContaining([
        { action: 'categories.create', risk: 'W', description: expect.any(String) },
        { action: 'products.update', risk: 'H', description: expect.any(String) },
        { action: 'products.delete', risk: 'D', description: expect.any(String) },
      ]),
    });
    const basic = `Basic ${Buffer.from(`ck_${'a'.repeat(40)}:cs_${'b'.repeat(40)}`).toString('base64')}`;
    expect(fetchMock.mock.calls[0]).toEqual([
      'https://shop.example.com/store/wp-json/wc/v3/system_status',
      expect.objectContaining({
        method: 'GET', redirect: 'manual',
        headers: expect.objectContaining({ authorization: basic }),
      }),
    ]);

    await expect(adapter.callTool('execute_write', {
      action: 'products.update', parameters: { id: '42', body: { regular_price: '19.99' } },
    }, env)).rejects.toThrow(/risk mismatch/);
    await adapter.callTool('execute_high_impact', {
      action: 'products.update', parameters: { id: '42', body: { regular_price: '19.99' } },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'products.delete', parameters: { id: '42', query: { force: true } },
    }, env);
    expect(fetchMock.mock.calls[1][0]).toBe('https://shop.example.com/store/wp-json/wc/v3/products/42');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PUT');
    expect(fetchMock.mock.calls[2][0]).toBe('https://shop.example.com/store/wp-json/wc/v3/products/42?force=true');
    expect(fetchMock.mock.calls[2][1]?.method).toBe('DELETE');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('evil.test');
  });

  it('rejects unsafe WooCommerce bindings and hides provider response details', async () => {
    const unsafe = envFor('woocommerce', {
      consumer_key: `ck_${'a'.repeat(40)}`, consumer_secret: `cs_${'b'.repeat(40)}`,
    }, { store_url: 'https://127.0.0.1/private' });
    await expect(adapter.callTool('execute_read', { action: 'store.status' }, unsafe))
      .rejects.toThrow('WooCommerce request failed');

    vi.stubGlobal('fetch', vi.fn(async () => response(401, {
      message: 'private-shop-owner@example.com has invalid credentials',
    })));
    const env = envFor('woocommerce', {
      consumer_key: `ck_${'a'.repeat(40)}`, consumer_secret: `cs_${'b'.repeat(40)}`,
    }, { store_url: 'https://shop.example.com' });
    const error = await adapter.callTool('execute_read', { action: 'store.status' }, env)
      .catch((caught) => caught as Error);
    expect(error.message).toBe('WooCommerce request failed (HTTP 401)');
    expect(error.message).not.toContain('private-shop-owner');
  });

  it('verifies complete Walmart seller permissions and keeps token, market, and environment bound', async () => {
    const scopes = {
      item: 'view_only', price: 'full_access', orders: 'full_access',
      inventory: 'full_access', returns: 'view_only', reports: 'view_only',
    };
    const requiredScopes = {
      item: 'view_only', price: 'full_access', orders: 'full_access',
      inventory: 'full_access', returns: 'view_only',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { is_valid: true, expire_at: '1788460000000', scopes }))
      .mockResolvedValueOnce(response(200, { access_token: 'walmart-short-token', expires_in: 900 }))
      .mockResolvedValueOnce(response(200, { ItemResponse: [{ sku: 'SKU-1' }] }))
      .mockResolvedValueOnce(response(200, { sku: 'SKU-1', quantity: { amount: 7, unit: 'EACH' } }))
      .mockResolvedValueOnce(response(200, { order: { purchaseOrderId: 'PO-1', status: 'Canceled' } }))
      .mockResolvedValueOnce(response(200, { order: { purchaseOrderId: 'PO-2', status: 'Acknowledged' } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('walmart', {
      client_id: 'seller-client-id', client_secret: 'seller-client-secret',
    }, { environment: 'sandbox', market: 'us' });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'walmart', binding: { environment: 'sandbox', market: 'us' },
      identity: { is_valid: true, environment: 'sandbox', market: 'us', scopes: requiredScopes },
      actions: expect.arrayContaining([
        { action: 'items.get', risk: 'R', description: expect.any(String) },
        { action: 'inventory.set', risk: 'H', description: expect.any(String) },
        { action: 'orders.cancel', risk: 'D', description: expect.any(String) },
        { action: 'returns.list', risk: 'R', description: expect.any(String) },
      ]),
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://sandbox.walmartapis.com/v3/token/detail');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      authorization: expect.stringMatching(/^Basic /), WM_MARKET: 'us', WM_SANDBOX: 'v2',
    });

    await adapter.callTool('execute_read', {
      action: 'items.get', parameters: { id: 'SKU-1', query: { productIdType: 'SKU' } },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'inventory.set', parameters: {
        sku: 'SKU-1', body: { sku: 'SKU-1', quantity: { amount: 7, unit: 'EACH' } },
      },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'orders.cancel', parameters: { id: 'PO-1', body: { orderCancellation: { orderLines: { orderLine: [{}] } } } },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'orders.acknowledge', parameters: { id: 'PO-2' },
    }, env);
    expect(fetchMock.mock.calls[1][0]).toBe('https://sandbox.walmartapis.com/v3/token');
    expect(fetchMock.mock.calls[1][1]?.body).toBe('grant_type=client_credentials');
    expect(fetchMock.mock.calls[2][0]).toBe('https://sandbox.walmartapis.com/v3/items/SKU-1?productIdType=SKU');
    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({
      'WM_SEC.ACCESS_TOKEN': 'walmart-short-token', WM_MARKET: 'us', WM_SANDBOX: 'v2',
    });
    expect(fetchMock.mock.calls[2][1]?.headers).not.toHaveProperty('authorization');
    expect(fetchMock.mock.calls[3][0]).toBe('https://sandbox.walmartapis.com/v3/inventory?sku=SKU-1');
    expect(fetchMock.mock.calls[4][0]).toBe('https://sandbox.walmartapis.com/v3/orders/PO-1/cancel');
    expect(fetchMock.mock.calls[5][0]).toBe('https://sandbox.walmartapis.com/v3/orders/PO-2/acknowledge');
    expect(fetchMock.mock.calls[5][1]).not.toHaveProperty('body');
    expect(() => adapter.validateWalmartMutation('inventory.set', 'SKU-1', {
      sku: 'SKU-2', quantity: { amount: 1, unit: 'EACH' },
    })).toThrow(/SKU does not match/);
    expect(() => adapter.validateWalmartMutation('inventory.nodes_set', 'SKU-1', {
      inventories: { nodes: Array.from({ length: 11 }, (_, index) => ({
        shipNode: `NODE-${index}`, inputQty: { amount: 1, unit: 'EACH' },
      })) },
    })).toThrow(/1-10 ship nodes/);
    expect(() => adapter.validateWalmartMutation('price.set', 'SKU-1', {
      pricing: [{ currentPrice: { amount: -1, currency: 'USD' } }],
    })).toThrow(/invalid pricing/);
    expect(() => adapter.validateWalmartMutation('orders.refund', undefined, {
      orderRefund: { orderLines: { orderLine: Array.from({ length: 11 }, () => ({})) } },
    })).toThrow(/1-10 reviewed order lines/);
  });

  it('fails Walmart connection on incomplete write permissions and omits unavailable returns markets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200, {
      is_valid: true,
      scopes: { item: 'full_access', price: 'view_only', orders: 'full_access', inventory: 'full_access' },
    })));
    const caEnv = envFor('walmart', {
      client_id: 'seller-client-id-ca', client_secret: 'seller-client-secret-ca',
    }, { environment: 'live', market: 'ca' });
    await expect(adapter.callTool('list_capabilities', {}, caEnv))
      .rejects.toThrow('missing required permissions: price (full_access)');
    expect(adapter.actionsFor({ provider: 'walmart', metadata: { environment: 'live', market: 'ca' } }))
      .not.toHaveProperty('returns.list');
    expect(adapter.actionsFor({ provider: 'walmart', metadata: { environment: 'live', market: 'mx' } }))
      .toHaveProperty('returns.list');
    expect(() => adapter.actionsFor({ provider: 'walmart', metadata: { environment: 'sandbox', market: 'ca' } }))
      .toThrow('Walmart dynamic sandbox is available only for the US market');
  });

  it('refreshes eBay OAuth locally and binds every action to one environment and marketplace', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, {
        access_token: 'new-ebay-access', expires_in: 7200,
        scope: 'https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      }))
      .mockResolvedValueOnce(response(200, { sellingLimit: { amount: { value: '10000', currency: 'USD' } } }))
      .mockResolvedValueOnce(response(200, { offers: [{ offerId: 'OFFER-1', sku: 'SKU-1' }] }))
      .mockResolvedValueOnce(response(200, { locale: 'en-US', sku: 'SKU-1' }))
      .mockResolvedValueOnce(response(200, { listingId: 'LISTING-1' }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('ebay', {
      client_id: 'ebay-client-id', client_secret: 'ebay-client-secret', ru_name: 'Orkas-Merchant-Redirect-Name',
      access_token: 'expired-ebay-access', refresh_token: 'long-lived-ebay-refresh', expires_at: 0,
      refresh_expires_at: Date.now() + 86_400_000,
      scope: 'https://api.ebay.com/oauth/api_scope/sell.account https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.fulfillment',
      identity: { environment: 'sandbox', marketplace_id: 'EBAY_US', content_language: 'en-US' },
    }, { environment: 'sandbox', marketplace_id: 'EBAY_US', content_language: 'en-US' });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'ebay',
      binding: { environment: 'sandbox', marketplace_id: 'EBAY_US', content_language: 'en-US' },
      actions: expect.arrayContaining([
        { action: 'offers.list', risk: 'R', description: expect.any(String) },
        { action: 'offers.create', risk: 'W', description: expect.any(String) },
        { action: 'offers.publish', risk: 'H', description: expect.any(String) },
        { action: 'offers.withdraw', risk: 'D', description: expect.any(String) },
      ]),
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.sandbox.ebay.com/identity/v1/oauth2/token');
    expect(fetchMock.mock.calls[0][1]?.headers.authorization).toMatch(/^Basic /);
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('grant_type=refresh_token');
    expect(fetchMock.mock.calls[1][0]).toBe('https://api.sandbox.ebay.com/sell/account/v1/privilege');

    await adapter.callTool('execute_read', {
      action: 'offers.list', parameters: { sku: 'SKU-1', query: { limit: 20 } },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'inventory_items.replace', parameters: { sku: 'SKU-1', body: { availability: { shipToLocationAvailability: { quantity: 8 } } } },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'offers.withdraw', parameters: { offer_id: 'OFFER-1' },
    }, env);
    expect(fetchMock.mock.calls[2][0]).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/offer?limit=20&sku=SKU-1');
    expect(fetchMock.mock.calls[3][0]).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/inventory_item/SKU-1');
    expect(fetchMock.mock.calls[3][1]).toMatchObject({
      method: 'PUT', headers: expect.objectContaining({
        authorization: 'Bearer new-ebay-access', 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'Content-Language': 'en-US',
      }),
    });
    expect(fetchMock.mock.calls[4][0]).toBe('https://api.sandbox.ebay.com/sell/inventory/v1/offer/OFFER-1/withdraw');
    const persisted = codec.readCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE!, env.ORKAS_LOCAL_API_CREDENTIAL_KEY!);
    expect(persisted).toMatchObject({ access_token: 'new-ebay-access', refresh_token: 'long-lived-ebay-refresh' });
    await expect(adapter.callTool('execute_write', {
      action: 'offers.create', parameters: { body: { marketplaceId: 'EBAY_GB', sku: 'SKU-1' } },
    }, env)).rejects.toThrow('marketplace does not match');
    expect(() => adapter.configured(envFor('ebay', {
      client_id: 'ebay-client-id', client_secret: 'ebay-client-secret',
      access_token: 'token', refresh_token: 'refresh',
      identity: { environment: 'sandbox', marketplace_id: 'EBAY_US', content_language: 'en-US' },
    }, { environment: 'live', marketplace_id: 'EBAY_GB', content_language: 'en-GB' })))
      .toThrow('does not match the synced binding');
  });

  it('uses Etsy PKCE-grant credentials only against the bound shop and preserves request encodings', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, {
        access_token: '12345.new-etsy-access', refresh_token: '12345.rotated-etsy-refresh', expires_in: 3600,
        scope: 'shops_r shops_w listings_r listings_w listings_d transactions_r transactions_w',
      }))
      .mockResolvedValueOnce(response(200, { shop_id: 67890, user_id: 12345, shop_name: 'Handmade' }))
      .mockResolvedValueOnce(response(201, { listing_id: 101, state: 'draft' }))
      .mockResolvedValueOnce(response(200, { products: [{ product_id: 1 }] }))
      .mockResolvedValueOnce(response(204, {}));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('etsy', {
      keystring: 'etsykeystring123456', shared_secret: 'etsy-shared-secret',
      access_token: '12345.expired', refresh_token: '12345.old-refresh', expires_at: 0,
      scope: 'shops_r shops_w listings_r listings_w listings_d transactions_r transactions_w',
      identity: { shop_id: '67890', user_id: '12345' },
    }, { shop_id: '67890' });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'etsy', binding: { shop_id: '67890' },
      identity: { shop_id: 67890, user_id: 12345, shop_name: 'Handmade' },
      actions: expect.arrayContaining([
        { action: 'listings.create_draft', risk: 'W', description: expect.any(String) },
        { action: 'receipt_shipments.create', risk: 'H', description: expect.any(String) },
        { action: 'listings.delete', risk: 'D', description: expect.any(String) },
      ]),
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.etsy.com/v3/public/oauth/token');
    expect(fetchMock.mock.calls[1][0]).toBe('https://openapi.etsy.com/v3/application/shops/67890');
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      authorization: 'Bearer 12345.new-etsy-access', 'x-api-key': 'etsykeystring123456:etsy-shared-secret',
    });

    await adapter.callTool('execute_write', {
      action: 'listings.create_draft', parameters: { body: { quantity: 2, title: 'Handmade mug', who_made: 'i_did' } },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'listing_inventory.update', parameters: { listing_id: '101', body: { products: [{ sku: 'MUG-1', offerings: [] }] } },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'shop_sections.delete', parameters: { section_id: '77' },
    }, env);
    expect(fetchMock.mock.calls[2][0]).toBe('https://openapi.etsy.com/v3/application/shops/67890/listings');
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'POST', body: expect.stringContaining('title=Handmade+mug') });
    expect(fetchMock.mock.calls[3][0]).toBe('https://openapi.etsy.com/v3/application/listings/101/inventory');
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ products: [{ sku: 'MUG-1', offerings: [] }] }) });
    expect(fetchMock.mock.calls[4][0]).toBe('https://openapi.etsy.com/v3/application/shops/67890/sections/77');
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('evil.test'))).toBe(true);
    const persisted = codec.readCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE!, env.ORKAS_LOCAL_API_CREDENTIAL_KEY!);
    expect(persisted).toMatchObject({ access_token: '12345.new-etsy-access', refresh_token: '12345.rotated-etsy-refresh' });
    expect(() => adapter.configured(envFor('etsy', {
      keystring: 'etsykeystring123456', shared_secret: 'etsy-shared-secret',
      access_token: '12345.token', refresh_token: '12345.refresh',
      identity: { shop_id: '67890', user_id: '12345' },
    }, { shop_id: '99999' }))).toThrow('does not match the synced shop binding');
  });

  it('uses current Amazon SP-API endpoints, forces one seller marketplace, and excludes restricted order data', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { access_token: 'amazon-lwa-access', expires_in: 3600 }))
      .mockResolvedValueOnce(response(200, { payload: [{ marketplace: { id: 'ATVPDKIKX0DER' }, participation: { isParticipating: true } }] }))
      .mockResolvedValueOnce(response(200, { orders: [{ orderId: 'ORDER-1' }] }))
      .mockResolvedValueOnce(response(200, { sku: 'SKU-1', status: 'ACCEPTED' }))
      .mockResolvedValueOnce(response(200, { sku: 'SKU-1', status: 'ACCEPTED' }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('amazon_seller', {
      client_id: 'amzn1.application-oa2-client.test', client_secret: 'amazon-client-secret',
      refresh_token: 'Atzr|amazon-refresh-token-value-1234567890',
    }, { environment: 'live', marketplace_id: 'ATVPDKIKX0DER', seller_id: 'A1SELLER23456789' });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'amazon_seller',
      binding: { environment: 'live', marketplace_id: 'ATVPDKIKX0DER', seller_id: 'A1SELLER23456789' },
      identity: { seller_id: 'A1SELLER23456789', marketplace_id: 'ATVPDKIKX0DER' },
    });
    expect(capabilities.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'orders.search', risk: 'R' }),
      expect.objectContaining({ action: 'listings.put', risk: 'H' }),
      expect.objectContaining({ action: 'listings.delete', risk: 'D' }),
    ]));
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.amazon.com/auth/o2/token');
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('grant_type=refresh_token');
    expect(fetchMock.mock.calls[1][0]).toBe('https://sellingpartnerapi-na.amazon.com/sellers/v1/marketplaceParticipations');
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      'x-amz-access-token': 'amazon-lwa-access',
      'user-agent': 'Orkas/1.7.0 (Language=JavaScript; Platform=Desktop)',
    });
    expect(fetchMock.mock.calls[1][1]?.headers).not.toHaveProperty('authorization');

    await adapter.callTool('execute_read', {
      action: 'orders.search', parameters: { created_after: '2026-08-01T00:00:00Z', page_size: 25 },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'listings.put', parameters: {
        sku: 'SKU-1', product_type: 'LUGGAGE', requirements: 'LISTING',
        body: { productType: 'ATTACKER_OVERRIDE', requirements: 'LISTING_OFFER_ONLY', attributes: { item_name: [{ value: 'Bag' }] } },
      },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'listings.delete', parameters: { sku: 'SKU-1' },
    }, env);
    expect(fetchMock.mock.calls[2][0]).toContain('/orders/2026-01-01/orders?');
    expect(fetchMock.mock.calls[2][0]).toContain('marketplaceIds=ATVPDKIKX0DER');
    expect(fetchMock.mock.calls[2][0]).not.toContain('includedData');
    expect(fetchMock.mock.calls[3][0]).toBe('https://sellingpartnerapi-na.amazon.com/listings/2021-08-01/items/A1SELLER23456789/SKU-1?marketplaceIds=ATVPDKIKX0DER');
    expect(JSON.parse(fetchMock.mock.calls[3][1]?.body)).toMatchObject({
      productType: 'LUGGAGE', requirements: 'LISTING', attributes: { item_name: [{ value: 'Bag' }] },
    });
    expect(fetchMock.mock.calls[4][1]?.method).toBe('DELETE');
    await expect(adapter.callTool('execute_read', {
      action: 'catalog.search', parameters: { keywords: 'bag', identifiers: ['123'], identifiers_type: 'UPC' },
    }, env)).rejects.toThrow('either keywords or identifiers');
  });

  it('rotates Mercado Libre refresh tokens atomically and binds seller-scoped routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, {
        access_token: 'mercado-access-new', refresh_token: 'mercado-refresh-rotated', expires_in: 21_600,
        scope: 'offline_access read write', user_id: 1305627900,
      }))
      .mockResolvedValueOnce(response(200, { id: 1305627900, nickname: 'seller-main', site_id: 'CBT' }))
      .mockResolvedValueOnce(response(200, { results: [{ id: 200000000001 }] }))
      .mockResolvedValueOnce(response(200, { id: 7000000001, status: 'ANSWERED' }))
      .mockResolvedValueOnce(response(200, ['Question deleted.']));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('mercado_libre', {
      client_id: 'mercado-app-id', client_secret: 'mercado-client-secret',
      redirect_uri: 'https://merchant.example.com/oauth/mercado-libre',
      access_token: 'mercado-access-expired', refresh_token: 'mercado-refresh-old', expires_at: 0,
      scope: 'offline_access read write', identity: { user_id: '1305627900', nickname: 'seller-main', site_id: 'CBT' },
    }, { user_id: '1305627900' });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'mercado_libre', binding: { user_id: '1305627900' },
      identity: { id: 1305627900, nickname: 'seller-main' },
    });
    expect(capabilities.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'orders.search', risk: 'R' }),
      expect.objectContaining({ action: 'questions.answer', risk: 'H' }),
      expect.objectContaining({ action: 'questions.delete', risk: 'D' }),
    ]));
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.mercadolibre.com/oauth/token');
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('refresh_token=mercado-refresh-old');
    const persisted = codec.readCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE!, env.ORKAS_LOCAL_API_CREDENTIAL_KEY!);
    expect(persisted).toMatchObject({ access_token: 'mercado-access-new', refresh_token: 'mercado-refresh-rotated' });

    await adapter.callTool('execute_read', {
      action: 'orders.search', parameters: { query: { 'seller.id': '999', sort: 'date_desc' } },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'questions.answer', parameters: { question_id: '7000000001', text: 'Yes, it is available.' },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'questions.delete', parameters: { question_id: '7000000001' },
    }, env);
    expect(fetchMock.mock.calls[2][0]).toContain('/marketplace/orders/search?');
    expect(fetchMock.mock.calls[2][0]).toContain('seller.id=1305627900');
    expect(fetchMock.mock.calls[2][0]).not.toContain('seller.id=999');
    expect(fetchMock.mock.calls[3][0]).toBe('https://api.mercadolibre.com/marketplace/answers');
    expect(JSON.parse(fetchMock.mock.calls[3][1]?.body)).toEqual({ question_id: 7000000001, text: 'Yes, it is available.' });
    expect(fetchMock.mock.calls[4][0]).toBe('https://api.mercadolibre.com/marketplace/questions/7000000001');
    expect(() => adapter.configured(envFor('mercado_libre', {
      client_id: 'mercado-app-id', client_secret: 'mercado-client-secret', refresh_token: 'mercado-refresh',
      identity: { user_id: '1305627900' },
    }, { user_id: '999999999' }))).toThrow('seller binding');
  });

  it('signs fixed Taobao TOP actions, binds the seller identity, and excludes order PII fields', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { user_seller_get_response: { user: { user_id: 123456789, nick: 'merchant-shop', has_shop: true } } }))
      .mockResolvedValueOnce(response(200, { trades_sold_get_response: { trades: { trade: [{ tid: 90001, status: 'WAIT_SELLER_SEND_GOODS' }] } } }))
      .mockResolvedValueOnce(response(200, { item_quantity_update_response: { item: { num_iid: 10001 } } }))
      .mockResolvedValueOnce(response(200, { item_delete_response: { item: { num_iid: 10001 } } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('taobao_top', {
      app_key: '12345678', app_secret: 'taobao-app-secret', redirect_uri: 'https://merchant.example.com/oauth/taobao',
      access_token: 'taobao-access-token', expires_at: Date.now() + 3_600_000,
      identity: { user_id: '123456789', nick: 'merchant-shop' },
    });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'taobao_top', identity: { user_id: 123456789, nick: 'merchant-shop' },
      actions: expect.arrayContaining([
        expect.objectContaining({ action: 'orders.list', risk: 'R' }),
        expect.objectContaining({ action: 'inventory.update', risk: 'H' }),
        expect.objectContaining({ action: 'listings.delete', risk: 'D' }),
      ]),
    });
    await adapter.callTool('execute_read', {
      action: 'orders.list', parameters: { page_no: 2, page_size: 20, status: 'WAIT_SELLER_SEND_GOODS' },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'inventory.update', parameters: { item_id: '10001', sku_id: '20002', quantity: 6, mode: 'absolute' },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'listings.delete', parameters: { item_id: '10001' },
    }, env);

    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://gw.api.taobao.com/router/rest');
      const form = new URLSearchParams(String(init?.body || ''));
      expect(form.get('app_key')).toBe('12345678');
      expect(form.get('session')).toBe('taobao-access-token');
      expect(form.get('sign_method')).toBe('hmac-sha256');
      expect(form.get('sign')).toMatch(/^[A-F0-9]{64}$/);
      expect(form.has('url')).toBe(false);
    }
    const orderForm = new URLSearchParams(String(fetchMock.mock.calls[1][1]?.body));
    expect(orderForm.get('method')).toBe('taobao.trades.sold.get');
    expect(orderForm.get('fields')).not.toMatch(/buyer|receiver|address|mobile|phone/i);
    expect(new URLSearchParams(String(fetchMock.mock.calls[2][1]?.body)).get('type')).toBe('1');
    expect(new URLSearchParams(String(fetchMock.mock.calls[3][1]?.body)).get('method')).toBe('taobao.item.delete');

    const expired = envFor('taobao_top', {
      app_key: '12345678', app_secret: 'taobao-app-secret', access_token: 'expired-access', expires_at: 0,
      identity: { user_id: '123456789', open_uid: 'AAH-open-user', nick: 'merchant-shop' },
    });
    await expect(adapter.callTool('execute_read', { action: 'account.get' }, expired))
      .rejects.toThrow('reconnect this seller account');
  });

  it('uses current 1688 param2 signing, rotates tokens, and fixes seller-safe order and fulfillment routes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, {
        access_token: 'alibaba-access-new', refresh_token: 'alibaba-refresh-new', expires_in: 36_000,
        memberId: 'b2b-1623492085', aliId: '8888888888',
      }))
      .mockResolvedValueOnce(response(200, { success: true, result: { memberId: 'b2b-1623492085', loginId: 'factory-owner' } }))
      .mockResolvedValueOnce(response(200, { success: true, result: { memberId: 'b2b-1623492085', loginId: 'factory-owner' } }))
      .mockResolvedValueOnce(response(200, { success: true, result: [{
        orderId: '206026099675498520', buyerLoginId: 'buyer-account',
        receiverInfo: { toFullName: 'Buyer Name', toMobile: '13800000000', toAddress: 'Buyer address' },
        productItems: [{ name: '安全保留的商品名' }],
      }] }))
      .mockResolvedValueOnce(response(200, { success: true, result: { logisticsId: 'ZX113988430670174' } }))
      .mockResolvedValueOnce(response(200, { success: true, result: true }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('alibaba_1688', {
      app_key: '87654321', app_secret: 'alibaba-1688-secret', redirect_uri: 'http://127.0.0.1:49152/oauth/1688',
      access_token: 'alibaba-access-expired', refresh_token: 'alibaba-refresh-old', expires_at: 0,
      identity: { member_id: 'b2b-1623492085', ali_id: '8888888888', login_id: 'factory-owner' },
    });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'alibaba_1688', identity: { memberId: 'b2b-1623492085', loginId: 'factory-owner' },
      actions: expect.arrayContaining([
        expect.objectContaining({ action: 'orders.list', risk: 'R' }),
        expect.objectContaining({ action: 'shipments.offline', risk: 'H' }),
        expect.objectContaining({ action: 'products.delete', risk: 'D' }),
      ]),
    });
    const persisted = codec.readCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE!, env.ORKAS_LOCAL_API_CREDENTIAL_KEY!);
    expect(persisted).toMatchObject({ access_token: 'alibaba-access-new', refresh_token: 'alibaba-refresh-new' });

    const orderResult = await adapter.callTool('execute_read', {
      action: 'orders.list', parameters: { page: 1, page_size: 20, status: 'waitsellersend' },
    }, env);
    expect(JSON.stringify(orderResult)).not.toMatch(/buyer-account|Buyer Name|13800000000|Buyer address/);
    expect(JSON.stringify(orderResult)).toContain('安全保留的商品名');
    await adapter.callTool('execute_high_impact', {
      action: 'shipments.offline', parameters: {
        order_id: '206026099675498520',
        entries: [{ order_entry_id: '206026099675498521', amount: 2, weight_kg: 1.25 }],
        carrier_code: 'SF', carrier_name: '顺丰', tracking_number: 'SF1234567890',
      },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'products.delete', parameters: { product_id: '576037284255' },
    }, env);

    expect(fetchMock.mock.calls[0][0]).toBe('https://gw.open.1688.com/openapi/http/1/system.oauth2/getToken/87654321');
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('refresh_token=alibaba-refresh-old');
    for (const [url, init] of fetchMock.mock.calls.slice(1)) {
      expect(String(url)).toMatch(/^https:\/\/gw\.open\.1688\.com\/openapi\/param2\/1\//);
      const form = new URLSearchParams(String(init?.body || ''));
      expect(form.get('access_token')).toBe('alibaba-access-new');
      expect(form.get('_aop_timestamp')).toMatch(/^\d{13}$/);
      expect(form.get('_aop_signature')).toMatch(/^[A-F0-9]{40}$/);
      expect(form.has('url')).toBe(false);
    }
    const orderForm = new URLSearchParams(String(fetchMock.mock.calls[3][1]?.body));
    expect(orderForm.get('needBuyerAddressAndPhone')).toBe('false');
    expect(orderForm.get('needMemoInfo')).toBe('false');
    expect(orderForm.has('buyerLoginId')).toBe(false);
    const shipmentForm = new URLSearchParams(String(fetchMock.mock.calls[4][1]?.body));
    expect(JSON.parse(String(shipmentForm.get('extBody')))).toEqual({
      cpCode: 'SF', logisticsCpName: '顺丰', mailNo: 'SF1234567890',
    });
    expect(fetchMock.mock.calls[5][0]).toContain('/com.alibaba.product/alibaba.product.delete/87654321');
  });

  it('signs fixed JD.com seller actions, binds the shop identity, and strips order PII', async () => {
    const identity = { vender_id: 802001, shop_id: 900001, shop_name: '京东测试店' };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { jingdong_seller_vender_info_get_responce: { vender_info_result: identity } }))
      .mockResolvedValueOnce(response(200, { jingdong_pop_order_search_responce: { searchorderinfo_result: {
        orderInfoList: [{ orderId: '287901234567', orderState: 'WAIT_SELLER_STOCK_OUT', buyerPin: 'buyer-pin',
          receiverInfo: { fullName: 'Buyer Name', mobile: '13800000000', address: 'Buyer address' },
          itemInfoList: [{ skuId: '1002003', wareName: '安全保留的商品名' }] }],
      } } }))
      .mockResolvedValueOnce(response(200, { jingdong_ware_stock_sku_set_responce: { code: '0' } }))
      .mockResolvedValueOnce(response(200, { jingdong_pop_order_shipment_responce: { code: '0' } }))
      .mockResolvedValueOnce(response(200, { jingdong_ware_write_delete_responce: { code: '0' } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('jd_jos', {
      app_key: 'jd-app-key', app_secret: 'jd-app-secret', redirect_uri: 'https://merchant.example.com/oauth/jd',
      access_token: 'jd-access-token', refresh_token: 'jd-refresh-token', expires_at: Date.now() + 3_600_000,
      identity: { vender_id: '802001', shop_id: '900001', shop_name: '京东测试店', xid: 'jd-xid' },
    });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'jd_jos', identity: { vender_id: 802001, shop_id: 900001 },
      actions: expect.arrayContaining([
        expect.objectContaining({ action: 'orders.list', risk: 'R' }),
        expect.objectContaining({ action: 'inventory.set', risk: 'H' }),
        expect.objectContaining({ action: 'products.delete', risk: 'D' }),
      ]),
    });
    const orderResult = await adapter.callTool('execute_read', {
      action: 'orders.list', parameters: { order_state: 'WAIT_SELLER_STOCK_OUT', page: 1, page_size: 20 },
    }, env);
    expect(JSON.stringify(orderResult)).not.toMatch(/buyer-pin|Buyer Name|13800000000|Buyer address/);
    expect(JSON.stringify(orderResult)).toContain('安全保留的商品名');
    await adapter.callTool('execute_high_impact', {
      action: 'inventory.set', parameters: {
        update_mode: 'absolute', stock_reference_id: 'orkas-stock-20260904-1',
        sku_stocks: [{ sku_id: '1002003', stock: 8, stock_model: 'POP_SOP' }],
      },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'shipments.create', parameters: { order_id: '287901234567', logistics_id: '56', waybill: 'SF1234567890' },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'products.delete', parameters: { product_id: '100998877' },
    }, env);

    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://api.jd.com/routerjson');
      const form = new URLSearchParams(String(init?.body || ''));
      expect(form.get('app_key')).toBe('jd-app-key');
      expect(form.get('access_token')).toBe('jd-access-token');
      expect(form.get('sign')).toMatch(/^[A-F0-9]{32}$/);
      expect(form.has('url')).toBe(false);
    }
    const orderForm = new URLSearchParams(String(fetchMock.mock.calls[1][1]?.body));
    expect(orderForm.get('method')).toBe('jingdong.pop.order.search');
    const orderParameters = JSON.parse(String(orderForm.get('360buy_param_json')));
    expect(orderParameters.paramOrderJSFQuery.optional_fields).not.toMatch(/buyer|receiver|address|mobile|phone|invoice|pin/i);
    const stockParameters = JSON.parse(String(new URLSearchParams(String(fetchMock.mock.calls[2][1]?.body)).get('360buy_param_json')));
    expect(stockParameters.req).toMatchObject({ updateModel: 'fullStockIn', stockRfId: 'orkas-stock-20260904-1' });
    expect(new URLSearchParams(String(fetchMock.mock.calls[3][1]?.body)).get('method')).toBe('jingdong.pop.order.shipment');
    expect(new URLSearchParams(String(fetchMock.mock.calls[4][1]?.body)).get('method')).toBe('jingdong.ware.write.delete');
  });

  it('signs fixed Pinduoduo actions, uses basic orders, and strips consumer information', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { mall_info_get_response: { mall_id: 700001, mall_name: '拼多多测试店', merchant_type: 1 } }))
      .mockResolvedValueOnce(response(200, { order_basic_list_get_response: { order_list: [{
        order_sn: '240904123456789', order_status: 1, buyer_name: 'Buyer Name', receiver_phone: '13800000000',
        receiver_address: 'Buyer address', item_list: [{ goods_id: 10001, goods_name: '安全保留的商品名' }],
      }] } }))
      .mockResolvedValueOnce(response(200, { goods_quantity_update_response: { is_success: true } }))
      .mockResolvedValueOnce(response(200, { logistics_online_send_response: { is_success: true } }))
      .mockResolvedValueOnce(response(200, { refund_agree_response: { result: true } }))
      .mockResolvedValueOnce(response(200, { goods_delete_response: { is_success: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('pinduoduo', {
      client_id: 'pdd-client-id', client_secret: 'pdd-client-secret', redirect_uri: 'https://merchant.example.com/oauth/pdd',
      access_token: 'pdd-access-token', refresh_token: 'pdd-refresh-token', expires_at: Date.now() + 3_600_000,
      identity: { mall_id: '700001', mall_name: '拼多多测试店' },
    });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'pinduoduo', identity: { mall_id: 700001, mall_name: '拼多多测试店' },
      actions: expect.arrayContaining([
        expect.objectContaining({ action: 'orders.list_basic', risk: 'R' }),
        expect.objectContaining({ action: 'shipments.update', risk: 'H' }),
        expect.objectContaining({ action: 'products.delete', risk: 'D' }),
      ]),
    });
    const orderResult = await adapter.callTool('execute_read', {
      action: 'orders.list_basic', parameters: {
        start_confirmed_at: 1_788_451_200, end_confirmed_at: 1_788_537_600, order_status: 1, page: 1,
      },
    }, env);
    expect(JSON.stringify(orderResult)).not.toMatch(/Buyer Name|13800000000|Buyer address/);
    expect(JSON.stringify(orderResult)).toContain('安全保留的商品名');
    await adapter.callTool('execute_high_impact', {
      action: 'inventory.update', parameters: { product_id: '10001', sku_id: '20002', quantity: 6, mode: 'absolute' },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'shipments.update', parameters: { order_id: '240904123456789', logistics_id: '44', tracking_number: 'SF1234567890' },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'refunds.approve', parameters: { order_id: '240904123456789', after_sales_id: '9876001', description: '同意退款' },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'products.delete', parameters: { product_ids: ['10001', '10002'] },
    }, env);

    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://gw-api.pinduoduo.com/api/router');
      const form = new URLSearchParams(String(init?.body || ''));
      expect(form.get('client_id')).toBe('pdd-client-id');
      expect(form.get('access_token')).toBe('pdd-access-token');
      expect(form.get('sign')).toMatch(/^[A-F0-9]{32}$/);
      expect(form.has('url')).toBe(false);
    }
    const orderForm = new URLSearchParams(String(fetchMock.mock.calls[1][1]?.body));
    expect(orderForm.get('type')).toBe('pdd.order.basic.list.get');
    expect(orderForm.get('start_confirm_at')).toBe('1788451200');
    const inventoryForm = new URLSearchParams(String(fetchMock.mock.calls[2][1]?.body));
    expect(inventoryForm.get('type')).toBe('pdd.goods.quantity.update');
    expect(inventoryForm.get('update_type')).toBe('1');
    expect(new URLSearchParams(String(fetchMock.mock.calls[3][1]?.body)).get('redelivery_type')).toBe('2');
    expect(new URLSearchParams(String(fetchMock.mock.calls[4][1]?.body)).get('type')).toBe('pdd.refund.agree');
    expect(JSON.parse(String(new URLSearchParams(String(fetchMock.mock.calls[5][1]?.body)).get('goods_ids')))).toEqual(['10001', '10002']);
    await expect(adapter.callTool('execute_read', {
      action: 'orders.list_basic', parameters: {
        start_confirmed_at: 1_788_451_200, end_confirmed_at: 1_788_537_601, order_status: 1,
      },
    }, env)).rejects.toThrow('order confirmation window');
  });

  it('signs fixed Douyin Shop actions, binds the shop, separates risks, and strips order PII', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { code: 10000, data: {
        auth_id: '700000000000000001', status: 1, shop_name: '抖店测试店',
      } }))
      .mockResolvedValueOnce(response(200, { code: 10000, data: { list: [{
        shop_order_id: '900000000000000001', buyer_name: 'Buyer Name',
        receiver_phone: '13800000000', receiver_address: 'Buyer address',
        product_name: '安全保留的商品名',
      }] } }))
      .mockResolvedValueOnce(response(200, { code: 10000, data: { is_success: true } }))
      .mockResolvedValueOnce(response(200, { code: 10000, data: { is_success: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('douyin_shop', {
      app_key: 'douyin-app-key', app_secret: 'douyin-app-secret',
      access_token: 'douyin-access-token', refresh_token: 'douyin-refresh-token',
      expires_at: Date.now() + 3_600_000,
      identity: { shop_id: '700000000000000001', shop_name: '抖店测试店' },
    }, { shop_id: '700000000000000001' });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'douyin_shop', binding: { shop_id: '700000000000000001' },
      identity: { auth_id: '700000000000000001', status: 1, shop_name: '抖店测试店' },
      actions: expect.arrayContaining([
        expect.objectContaining({ action: 'orders.list', risk: 'R' }),
        expect.objectContaining({ action: 'orders.memo_update', risk: 'W' }),
        expect.objectContaining({ action: 'inventory.update', risk: 'H' }),
        expect.objectContaining({ action: 'products.delete', risk: 'D' }),
      ]),
    });
    const orderResult = await adapter.callTool('execute_read', {
      action: 'orders.list', parameters: { query: { page: 0, size: 20 } },
    }, env);
    expect(JSON.stringify(orderResult)).not.toMatch(/Buyer Name|13800000000|Buyer address/);
    expect(JSON.stringify(orderResult)).toContain('安全保留的商品名');
    await adapter.callTool('execute_high_impact', {
      action: 'inventory.update', parameters: {
        product_id: '3506108675121111111', sku_id: '1751540901742600', quantity: 8,
      },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'products.delete', parameters: { product_id: '3506108675121111111' },
    }, env);

    expect(String(fetchMock.mock.calls[0][0])).toMatch(/^https:\/\/openapi-fxg\.jinritemai\.com\/open\/getAuthInfo\?/);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/^https:\/\/openapi-fxg\.jinritemai\.com\/order\/searchList\?/);
    expect(String(fetchMock.mock.calls[2][0])).toMatch(/^https:\/\/openapi-fxg\.jinritemai\.com\/sku\/syncStock\?/);
    expect(String(fetchMock.mock.calls[3][0])).toMatch(/^https:\/\/openapi-fxg\.jinritemai\.com\/product\/del\?/);
    for (const [url, init] of fetchMock.mock.calls) {
      const parsed = new URL(String(url));
      expect(parsed.searchParams.get('app_key')).toBe('douyin-app-key');
      expect(parsed.searchParams.get('v')).toBe('2');
      expect(parsed.searchParams.get('sign_method')).toBe('hmac-sha256');
      expect(parsed.searchParams.get('sign')).toMatch(/^[a-f0-9]{64}$/);
      expect(parsed.searchParams.has('url')).toBe(false);
      expect(init?.headers).toMatchObject({ 'content-type': 'application/json' });
      expect(JSON.parse(String(init?.body))).toEqual(JSON.parse(String(parsed.searchParams.get('param_json'))));
    }
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({
      product_id: '3506108675121111111', sku_id: '1751540901742600', stock_num: 8,
    });
  });

  it('signs fixed Kuaishou Shop actions, binds seller/shop, rotates tokens, and strips PII', async () => {
    const now = Date.now();
    const scope = 'user_base,user_info,merchant_user,merchant_item,merchant_order,merchant_refund,merchant_logistics';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { result: 1, data: {
        access_token: 'kuaishou-access-new', refresh_token: 'kuaishou-refresh-new',
        open_id: 'seller-open-id', expires_in: 172800, scope,
      } }))
      .mockResolvedValueOnce(response(200, { result: 1, data: {
        open_id: 'seller-open-id', seller_name: '快手卖家',
      } }))
      .mockResolvedValueOnce(response(200, { result: 1, data: {
        shop_id: '800000000000000001', shop_name: '快手测试店',
      } }))
      .mockResolvedValueOnce(response(200, { result: 1, data: {
        open_id: 'seller-open-id', seller_name: '快手卖家',
      } }))
      .mockResolvedValueOnce(response(200, { result: 1, data: {
        shop_id: '800000000000000001', shop_name: '快手测试店',
      } }))
      .mockResolvedValueOnce(response(200, { result: 1, data: { orderList: [{
        oid: '900000000000000001', buyer_name: 'Buyer Name',
        receiver_mobile: '13800000000', receiver_address: 'Buyer address',
        item_name: '安全保留的商品名',
      }] } }))
      .mockResolvedValueOnce(response(200, { result: 1, data: { result: true } }))
      .mockResolvedValueOnce(response(200, { result: 1, data: { result: true } }))
      .mockResolvedValueOnce(response(200, { result: 1, data: { result: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('kuaishou_shop', {
      app_key: 'kuaishou-app-key', app_secret: 'kuaishou-app-secret',
      sign_secret: 'kuaishou-sign-secret',
      access_token: 'kuaishou-access-expired', refresh_token: 'kuaishou-refresh-old',
      expires_at: 0, scope,
      identity: {
        open_id: 'seller-open-id', shop_id: '800000000000000001', shop_name: '快手测试店',
      },
    });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'kuaishou_shop',
      identity: {
        seller: { open_id: 'seller-open-id' },
        shop: { shop_id: '800000000000000001', shop_name: '快手测试店' },
      },
      actions: expect.arrayContaining([
        expect.objectContaining({ action: 'orders.list', risk: 'R' }),
        expect.objectContaining({ action: 'inventory.update', risk: 'H' }),
        expect.objectContaining({ action: 'refunds.reject', risk: 'H' }),
        expect.objectContaining({ action: 'products.delete', risk: 'D' }),
      ]),
    });
    const orderResult = await adapter.callTool('execute_read', {
      action: 'orders.list', parameters: {
        query_type: 1, begin_time: now - 86_400_000, end_time: now, page_size: 20,
      },
    }, env);
    expect(JSON.stringify(orderResult)).not.toMatch(/Buyer Name|13800000000|Buyer address/);
    expect(JSON.stringify(orderResult)).toContain('安全保留的商品名');
    await adapter.callTool('execute_high_impact', {
      action: 'inventory.update', parameters: {
        item_id: '700000000000000001', sku_id: '700000000000000002',
        quantity: 3, change_type: 2,
      },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'refunds.reject', parameters: {
        refund_id: '600000000000000001', reason_code: '1001',
        refund_version: 2, description: '商品已发出',
      },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'products.delete', parameters: { item_id: '700000000000000001' },
    }, env);

    expect(fetchMock.mock.calls[0][0]).toBe('https://openapi.kwaixiaodian.com/oauth2/refresh_token');
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('refresh_token=kuaishou-refresh-old');
    const persisted = codec.readCredentialFile(
      env.ORKAS_LOCAL_API_CREDENTIAL_FILE!, env.ORKAS_LOCAL_API_CREDENTIAL_KEY!,
    );
    expect(persisted).toMatchObject({
      access_token: 'kuaishou-access-new', refresh_token: 'kuaishou-refresh-new',
    });
    for (const [url, init] of fetchMock.mock.calls.slice(1)) {
      expect(String(url)).toMatch(/^https:\/\/openapi\.kwaixiaodian\.com\/open\//);
      const form = init?.method === 'POST'
        ? new URLSearchParams(String(init.body || ''))
        : new URL(String(url)).searchParams;
      expect(form.get('appkey')).toBe('kuaishou-app-key');
      expect(form.get('access_token')).toBe('kuaishou-access-new');
      expect(form.get('signMethod')).toBe('HMAC_SHA256');
      expect(form.get('sign')).toMatch(/^[a-f0-9]{64}$/);
      expect(form.has('url')).toBe(false);
    }
    expect(new URL(String(fetchMock.mock.calls[5][0])).pathname).toBe('/open/order/cursor/list');
    const stock = new URLSearchParams(String(fetchMock.mock.calls[6][1]?.body));
    expect(stock.get('method')).toBe('open.item.sku.stock.update');
    expect(JSON.parse(String(stock.get('param')))).toMatchObject({
      skuChangeStock: 3, changeType: 2,
    });
    expect(new URLSearchParams(String(fetchMock.mock.calls[7][1]?.body)).get('method'))
      .toBe('open.refund.reject');
    expect(new URLSearchParams(String(fetchMock.mock.calls[8][1]?.body)).get('method'))
      .toBe('open.item.delete');
  });

  it('renews a store-bound Youzan token and exposes only fixed reviewed seller APIs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { data: {
        access_token: 'youzan-access-new', authority_id: '900000001',
        expires: Date.now() + 7 * 86_400_000, scope: ['trade', 'item'],
      } }))
      .mockResolvedValueOnce(response(200, { code: 200, success: true, data: {
        kdt_id: 900000001, name: '有赞测试店',
      } }))
      .mockResolvedValueOnce(response(200, { code: 200, success: true, data: { items: [{
        tid: '240101000000001', buyer_name: 'Buyer Name', receiver_mobile: '13800000000',
        receiver_address: 'Buyer address', title: '安全保留的商品名',
      }] } }))
      .mockResolvedValueOnce(response(200, { code: 200, success: true, data: { is_success: true } }))
      .mockResolvedValueOnce(response(200, { code: 200, success: true, data: { is_success: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('youzan', {
      client_id: 'youzan-client-id', client_secret: 'youzan-client-secret',
      access_token: 'youzan-access-expired', expires_at: 0,
      identity: { kdt_id: '900000001', shop_name: '有赞测试店' },
    }, { kdt_id: '900000001' });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'youzan', binding: { kdt_id: '900000001' },
      identity: { kdt_id: '900000001', name: '有赞测试店' },
      actions: expect.arrayContaining([
        expect.objectContaining({ action: 'orders.list', risk: 'R' }),
        expect.objectContaining({ action: 'products.publish', risk: 'H' }),
        expect.objectContaining({ action: 'products.delete', risk: 'D' }),
      ]),
    });
    const orders = await adapter.callTool('execute_read', {
      action: 'orders.list', parameters: { query: { page_no: 1, page_size: 20 } },
    }, env);
    expect(JSON.stringify(orders)).not.toMatch(/Buyer Name|13800000000|Buyer address/);
    expect(JSON.stringify(orders)).toContain('安全保留的商品名');
    await adapter.callTool('execute_high_impact', {
      action: 'products.publish', parameters: { item_id: '700000001' },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'products.delete', parameters: { item_id: '700000001' },
    }, env);

    expect(fetchMock.mock.calls[0][0]).toBe('https://open.youzanyun.com/auth/token');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      authorize_type: 'silent', grant_id: '900000001', refresh: true,
    });
    expect(fetchMock.mock.calls.slice(1).map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/youzan.shop.get/3.0.0', '/api/youzan.trades.sold.get/4.0.0',
      '/api/youzan.item.update.listing/3.0.0', '/api/youzan.item.delete/3.0.0',
    ]);
    for (const [url] of fetchMock.mock.calls.slice(1)) {
      expect(new URL(String(url)).searchParams.get('access_token')).toBe('youzan-access-new');
    }
    expect(codec.readCredentialFile(
      env.ORKAS_LOCAL_API_CREDENTIAL_FILE!, env.ORKAS_LOCAL_API_CREDENTIAL_KEY!,
    )).toMatchObject({ access_token: 'youzan-access-new' });
  });

  it('binds Weimob WOS identity, uses v2.0 fixed routes, and strips order PII', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { code: { errcode: '0', errmsg: 'success' }, data: {
        data: [{ vid: 6000321521837, vidName: '微盟测试店' }], pageNum: 1, pageSize: 100,
      } }))
      .mockResolvedValueOnce(response(200, { code: { errcode: '0', errmsg: 'success' }, data: { list: [{
        orderNo: '100000001', buyer_name: 'Buyer Name', receiver_mobile: '13800000000',
        receiver_address: 'Buyer address', goodsName: '安全保留的商品名',
      }] } }))
      .mockResolvedValueOnce(response(200, { code: { errcode: '0', errmsg: 'success' }, data: { returnResult: true } }))
      .mockResolvedValueOnce(response(200, { code: { errcode: '0', errmsg: 'success' }, data: { returnResult: true } }))
      .mockResolvedValueOnce(response(200, { code: { errcode: '0', errmsg: 'success' }, data: { returnResult: true } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('weimob_wos', {
      client_id: 'weimob-client-id', client_secret: 'weimob-client-secret',
      access_token: 'weimob-access-token', expires_at: Date.now() + 3_600_000,
      identity: { business_operation_system_id: '900000001' },
    }, { shop_id: '900000001', shop_type: 'business_operation_system_id' });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'weimob_wos', binding: {
        shop_id: '900000001', shop_type: 'business_operation_system_id',
      },
      identity: { business_operation_system_id: '900000001' },
      actions: expect.arrayContaining([
        expect.objectContaining({ action: 'orders.list', risk: 'R' }),
        expect.objectContaining({ action: 'refunds.reject', risk: 'H' }),
        expect.objectContaining({ action: 'products.delete', risk: 'D' }),
      ]),
    });
    const orders = await adapter.callTool('execute_read', {
      action: 'orders.list', parameters: { payload: { pageNum: 1, pageSize: 20 } },
    }, env);
    expect(JSON.stringify(orders)).not.toMatch(/Buyer Name|13800000000|Buyer address/);
    expect(JSON.stringify(orders)).toContain('安全保留的商品名');
    await adapter.callTool('execute_high_impact', {
      action: 'inventory.update', parameters: {
        payload: { quantityEditType: 1, basicInfo: { vid: '6000321521837' }, goodsStockList: [] },
      },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'products.publish', parameters: { vid: '6000321521837', goods_ids: ['100019717999837'] },
    }, env);
    await adapter.callTool('execute_destructive', {
      action: 'products.delete', parameters: { vid: '6000321521837', goods_ids: ['100019717999837'] },
    }, env);

    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/apigw/bos/v2.0/organization/getList', '/apigw/weimob_shop/v2.0/order/list/search',
      '/apigw/weimob_shop/v2.0/stock/update',
      '/apigw/weimob_shop/v2.0/goods/onlinestatus/update', '/apigw/weimob_shop/v2.0/goods/delete',
    ]);
    for (const [url] of fetchMock.mock.calls) {
      expect(new URL(String(url)).searchParams.get('accesstoken')).toBe('weimob-access-token');
    }
    expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toMatchObject({ quantityEditType: 0 });
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({
      goodsIdList: ['100019717999837'], isOnline: true,
      basicInfo: { vid: '6000321521837' },
    });
  });

  it('uses signed production-only Xiaohongshu Ark routes and treats order export as high impact', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { success: true, error_code: 0, data: { items: [] } }))
      .mockResolvedValueOnce(response(200, { success: true, error_code: 0, data: { packages: [{
        package_id: 'P10001', receiver_name: 'Buyer Name', receiver_mobile: '13800000000',
        receiver_address: 'Buyer address', status: 'confirmed',
      }] } }))
      .mockResolvedValueOnce(response(200, { success: true, error_code: 0, data: {
        package_id: 'P10001', buyer_name: 'Buyer Name', address: 'Buyer address', status: 'waiting',
      } }))
      .mockResolvedValueOnce(response(200, { success: true, error_code: 0, data: { qty: 8 } }))
      .mockResolvedValueOnce(response(200, { success: true, error_code: 0, data: { status: 'shipped' } }));
    vi.stubGlobal('fetch', fetchMock);
    const appKey = 'xhs-merchant-app-key';
    const env = envFor('xiaohongshu_ark', {
      app_key: appKey, app_secret: 'xiaohongshu-app-secret',
      identity: {
        app_key_fingerprint: crypto.createHash('sha256').update(appKey).digest('hex').slice(0, 16),
      },
    });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'xiaohongshu_ark', binding: {},
      identity: { production_api: true, app_key_fingerprint: expect.stringMatching(/^[a-f0-9]{16}$/) },
      actions: expect.arrayContaining([
        expect.objectContaining({ action: 'products.spu_create', risk: 'W' }),
        expect.objectContaining({ action: 'orders.list', risk: 'R' }),
        expect.objectContaining({ action: 'orders.export', risk: 'H' }),
      ]),
    });
    const orders = await adapter.callTool('execute_read', {
      action: 'orders.list', parameters: { query: { page_no: 1, page_size: 20 } },
    }, env);
    expect(JSON.stringify(orders)).not.toMatch(/Buyer Name|13800000000|Buyer address/);
    await expect(adapter.callTool('execute_read', {
      action: 'orders.export', parameters: { package_id: 'P10001' },
    }, env)).rejects.toThrow(/risk mismatch/);
    const exported = await adapter.callTool('execute_high_impact', {
      action: 'orders.export', parameters: { package_id: 'P10001' },
    }, env);
    expect(exported).toEqual({
      provider: 'xiaohongshu_ark', action: 'orders.export', risk: 'H',
      result: { package_id: 'P10001', status: 'waiting' },
    });
    await adapter.callTool('execute_high_impact', {
      action: 'inventory.set', parameters: { item_id: 'ITEM10001', quantity: 8 },
    }, env);
    await adapter.callTool('execute_high_impact', {
      action: 'shipments.send', parameters: {
        package_id: 'P10001', express_company_code: 'zhongtong', express_no: 'TRACK10001',
      },
    }, env);

    expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/ark/open_api/v1/items/lite', '/ark/open_api/v0/packages',
      '/ark/open_api/v0/packages/P10001', '/ark/open_api/v0/inventories/item/ITEM10001',
      '/ark/open_api/v0/packages/P10001',
    ]);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).toMatch(/^https:\/\/ark\.xiaohongshu\.com\//);
      const headers = init?.headers as Record<string, string>;
      expect(headers['app-key']).toBe(appKey);
      expect(headers.sign).toMatch(/^[a-f0-9]{32}$/);
      expect(headers.timestamp).toMatch(/^[0-9]{10}$/);
    }
    expect(JSON.parse(String(fetchMock.mock.calls[3][1]?.body))).toEqual({ qty: 8 });
    expect(JSON.parse(String(fetchMock.mock.calls[4][1]?.body))).toEqual({
      status: 'shipped', express_company_code: 'zhongtong', express_no: 'TRACK10001',
    });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('flssandbox.xiaohongshu.com');
  });

  it('coalesces concurrent Mercado Libre refreshes so a single-use token is redeemed once', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, {
        access_token: 'mercado-access-new', refresh_token: 'mercado-refresh-rotated', expires_in: 21_600,
        scope: 'offline_access read write', user_id: 1305627900,
      }))
      .mockResolvedValueOnce(response(200, { id: 200000000001 }))
      .mockResolvedValueOnce(response(200, { id: 200000000002 }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('mercado_libre', {
      client_id: 'mercado-app-id', client_secret: 'mercado-client-secret',
      access_token: 'mercado-access-expired', refresh_token: 'mercado-refresh-single-use', expires_at: 0,
      scope: 'offline_access read write', identity: { user_id: '1305627900' },
    }, { user_id: '1305627900' });

    await Promise.all([
      adapter.callTool('execute_read', { action: 'orders.get', parameters: { order_id: '200000000001' } }, env),
      adapter.callTool('execute_read', { action: 'orders.get', parameters: { order_id: '200000000002' } }, env),
    ]);

    expect(fetchMock.mock.calls.filter(([url]) => url === 'https://api.mercadolibre.com/oauth/token')).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const persisted = codec.readCredentialFile(env.ORKAS_LOCAL_API_CREDENTIAL_FILE!, env.ORKAS_LOCAL_API_CREDENTIAL_KEY!);
    expect(persisted).toMatchObject({ access_token: 'mercado-access-new', refresh_token: 'mercado-refresh-rotated' });
  });

  it('does not expose provider response bodies through eBay, Etsy, Amazon, or Mercado Libre errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(403, {
      message: 'private-buyer@example.com cannot access private-order-123',
    })));
    const ebayEnv = envFor('ebay', {
      client_id: 'ebay-client-id', client_secret: 'ebay-client-secret',
      access_token: 'ebay-access-token', refresh_token: 'ebay-refresh-token',
      expires_at: Date.now() + 3_600_000,
      identity: { environment: 'live', marketplace_id: 'EBAY_US', content_language: 'en-US' },
    }, { environment: 'live', marketplace_id: 'EBAY_US', content_language: 'en-US' });
    const ebayError = await adapter.callTool('execute_read', {
      action: 'orders.get', parameters: { order_id: 'ORDER-1' },
    }, ebayEnv).catch((caught) => caught as Error);
    expect(ebayError.message).toBe('eBay request failed (HTTP 403)');
    expect(ebayError.message).not.toContain('private-buyer');

    const etsyEnv = envFor('etsy', {
      keystring: 'etsykeystring123456', shared_secret: 'etsy-shared-secret',
      access_token: '12345.etsy-access', refresh_token: '12345.etsy-refresh',
      expires_at: Date.now() + 3_600_000, identity: { shop_id: '67890', user_id: '12345' },
    }, { shop_id: '67890' });
    const etsyError = await adapter.callTool('execute_read', {
      action: 'receipts.get', parameters: { receipt_id: '101' },
    }, etsyEnv).catch((caught) => caught as Error);
    expect(etsyError.message).toBe('Etsy request failed (HTTP 403)');
    expect(etsyError.message).not.toContain('private-order');

    const amazonEnv = envFor('amazon_seller', {
      client_id: 'amazon-client-id', client_secret: 'amazon-client-secret',
      refresh_token: 'Atzr|amazon-refresh-token-value-1234567890',
    }, { environment: 'sandbox', marketplace_id: 'ATVPDKIKX0DER', seller_id: 'A1SELLER23456789' });
    const amazonError = await adapter.callTool('execute_read', {
      action: 'orders.get', parameters: { order_id: 'ORDER-1' },
    }, amazonEnv).catch((caught) => caught as Error);
    expect(amazonError.message).toBe('Amazon Seller authorization request failed (HTTP 403)');
    expect(amazonError.message).not.toContain('private-buyer');

    const mercadoEnv = envFor('mercado_libre', {
      client_id: 'mercado-app-id', client_secret: 'mercado-client-secret',
      access_token: 'mercado-access', refresh_token: 'mercado-refresh', expires_at: Date.now() + 3_600_000,
      identity: { user_id: '1305627900' },
    }, { user_id: '1305627900' });
    const mercadoError = await adapter.callTool('execute_read', {
      action: 'orders.get', parameters: { order_id: '200000000001' },
    }, mercadoEnv).catch((caught) => caught as Error);
    expect(mercadoError.message).toBe('Mercado Libre request failed (HTTP 403)');
    expect(mercadoError.message).not.toContain('private-buyer');
  });

  it('rejects raw transports, nested credentials, unknown fields, and the wrong risk lane', async () => {
    expect(() => adapter.validateParameters({ url: 'https://evil.test' })).toThrow(/not allowed/);
    expect(() => adapter.validateParameters({ body: { authorization: 'Bearer secret' } })).toThrow(/not allowed/);
    expect(() => adapter.validateActionParameters(
      { input_schema: { properties: { first: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false } },
      { first: '100' },
    )).toThrow('invalid action parameter');
    expect(() => adapter.validateActionParameters(
      { input_schema: { properties: {}, additionalProperties: false } }, { surprise: true },
    )).toThrow('unknown action parameter');
    expect(() => adapter.validateActionParameters(
      adapter.SHOPIFY_ACTIONS['product_variants.bulk_create'],
      { product_id: 'gid://shopify/Product/1', variants: Array.from({ length: 11 }, () => ({ price: '1.00' })) },
    )).toThrow('invalid action parameter: variants');
    expect(() => adapter.validateActionParameters(
      adapter.SHOPIFY_ACTIONS['orders.cancel'],
      { order_id: 'gid://shopify/Order/1', refund_method: {}, restock: true, reason: 'UNREVIEWED' },
    )).toThrow('invalid action parameter: reason');
    expect(adapter.safeId('gid://shopify/Product/1')).toBe('gid%3A%2F%2Fshopify%2FProduct%2F1');
    expect(() => adapter.safeId('../escape')).toThrow('invalid id');
    expect(adapter.queryString({ page: 2, active: true })).toBe('?page=2&active=true');
    expect(adapter.redact('{"access_token":"secret","name":"safe"}')).toBe('{"access_token":"[redacted]","name":"safe"}');

    const env = envFor('lightspeed', { access_token: 'personal-token' }, {
      store_domain: 'merchant.retail.lightspeed.app',
    });
    await expect(adapter.callTool('execute_read', {
      action: 'products.create', parameters: { body: { name: 'Product' } },
    }, env)).rejects.toThrow(/risk mismatch/);
    await expect(adapter.callTool('execute_write', {
      action: 'products.create', parameters: { body: { access_token: 'leak' } },
    }, env)).rejects.toThrow(/not allowed/);
  });

  it('validates the bound Lightspeed account before listing its reviewed capabilities', async () => {
    const fetchMock = vi.fn(async () => response(200, { store_id: 'store-1', name: 'Merchant' }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('lightspeed', { access_token: 'personal-token' }, {
      store_domain: 'merchant.retail.lightspeed.app',
    });

    const result = await adapter.callTool('list_capabilities', {}, env);

    expect(result).toMatchObject({
      provider: 'lightspeed', identity: { store_id: 'store-1' },
      actions: expect.arrayContaining([{ action: 'sales.create', risk: 'H', description: expect.any(String) }]),
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://merchant.retail.lightspeed.app/api/2.0/retailer',
      expect.objectContaining({
        method: 'GET', redirect: 'manual',
        headers: expect.objectContaining({ authorization: 'Bearer personal-token' }),
      }),
    );
  });

  it('binds Square to the selected environment, current API version, exact actions, and idempotent money writes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { merchant: { id: 'MERCHANT-1', business_name: 'Merchant' } }))
      .mockResolvedValueOnce(response(200, { gift_card: { id: 'GIFT-CARD-1', state: 'ACTIVE' } }))
      .mockResolvedValueOnce(response(200, { payment: { id: 'PAYMENT-1', status: 'COMPLETED' } }))
      .mockResolvedValueOnce(response(200, { refund: { id: 'REFUND-1', status: 'PENDING' } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('square', { access_token: 'square-personal-token' }, {
      environment: 'sandbox',
    });

    const capabilities = await adapter.callTool('list_capabilities', {}, env);
    expect(capabilities).toMatchObject({
      provider: 'square', binding: { environment: 'sandbox' },
      identity: { merchant: { id: 'MERCHANT-1' } },
      actions: expect.arrayContaining([
        { action: 'payments.create', risk: 'H', description: expect.any(String) },
        { action: 'disputes.accept', risk: 'D', description: expect.any(String) },
      ]),
    });
    expect(fetchMock.mock.calls[0][0]).toBe('https://connect.squareupsandbox.com/v2/merchants/me');
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({
      authorization: 'Bearer square-personal-token',
      'square-version': '2026-08-19',
    });

    await adapter.callTool('execute_read', {
      action: 'gift_cards.get_by_gan', parameters: { body: { gan: '7783320001001635' } },
    }, env);
    expect(fetchMock.mock.calls[1][0]).toBe('https://connect.squareupsandbox.com/v2/gift-cards/from-gan');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('POST');
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ gan: '7783320001001635' });

    await expect(adapter.callTool('execute_high_impact', {
      action: 'payments.create', parameters: {
        body: { source_id: 'source-1', amount_money: { amount: 500, currency: 'USD' } },
      },
    }, env)).rejects.toThrow(/idempotency_key/);
    const payment = await adapter.callTool('execute_high_impact', {
      action: 'payments.create', parameters: { body: {
        idempotency_key: 'payment-order-001', source_id: 'source-1',
        amount_money: { amount: 500, currency: 'USD' },
      } },
    }, env);
    expect(payment.result).toEqual({ payment: { id: 'PAYMENT-1', status: 'COMPLETED' } });
    expect(fetchMock.mock.calls[2][0]).toBe('https://connect.squareupsandbox.com/v2/payments');

    const refund = await adapter.callTool('execute_high_impact', {
      action: 'refunds.create', parameters: { body: {
        idempotency_key: 'refund-order-001', payment_id: 'PAYMENT-1',
        amount_money: { amount: 100, currency: 'USD' },
      } },
    }, env);
    expect(refund.result).toEqual({ refund: { id: 'REFUND-1', status: 'PENDING' } });
    expect(fetchMock.mock.calls[3][0]).toBe('https://connect.squareupsandbox.com/v2/refunds');
    expect(fetchMock).toHaveBeenCalledTimes(4);

    expect(() => adapter.validateSquareMutation('inventory.changes_batch_create', {
      idempotency_key: 'inventory-change-001', changes: Array.from({ length: 11 }, () => ({})),
    })).toThrow(/1-10 items/);
    expect(() => adapter.validateSquareMutation('refunds.create', {
      idempotency_key: 'refund-order-002', payment_id: 'PAYMENT-1',
      amount_money: { amount: -1, currency: 'USD' },
    })).toThrow(/positive amount_money/);
  });

  it('never mixes Square production and sandbox hosts', async () => {
    const fetchMock = vi.fn(async () => response(200, { merchant: { id: 'LIVE-MERCHANT' } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('square', { access_token: 'square-production-token' }, {
      environment: 'live',
    });

    await adapter.callTool('execute_read', { action: 'merchant.get' }, env);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://connect.squareup.com/v2/merchants/me',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
    expect(fetchMock.mock.calls[0][0]).not.toContain('squareupsandbox.com');
  });

  it('verifies an Instacart development key through the official MCP without creating a page', async () => {
    const calls: Array<{ url: string; method: string; authorization: string; session: string; rpcMethod?: string }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method || 'GET');
      const headers = new Headers(init?.headers);
      const rpc = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({
        url, method, authorization: headers.get('authorization') || '',
        session: headers.get('mcp-session-id') || '', rpcMethod: rpc?.method,
      });
      if (method === 'DELETE') return new Response(null, { status: 204 });
      if (rpc?.method === 'initialize') {
        return Response.json({
          jsonrpc: '2.0', id: rpc.id, result: {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} }, serverInfo: { name: 'instacart', version: '1.0.0' },
          },
        }, { headers: { 'mcp-session-id': 'instacart-test-session' } });
      }
      if (rpc?.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (rpc?.method === 'tools/list') {
        return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [
          { name: 'create-recipe', inputSchema: { type: 'object' } },
          { name: 'create-shopping-list', inputSchema: { type: 'object' } },
        ] } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      }
      throw new Error(`unexpected MCP request: ${rpc?.method || method}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('instacart', { api_key: 'keys.1234567890abcdef1234567890abcdef' }, { environment: 'sandbox' });

    const result = await adapter.callTool('list_capabilities', {}, env);

    expect(result).toMatchObject({
      provider: 'instacart', binding: { environment: 'sandbox' },
      identity: {
        environment: 'sandbox', official_mcp_tools: ['create-recipe', 'create-shopping-list'],
      },
      actions: expect.arrayContaining([
        { action: 'retailers.list', risk: 'R', description: expect.any(String) },
        { action: 'recipe_page.create', risk: 'H', description: expect.any(String) },
      ]),
    });
    expect(calls.every((call) => call.url === 'https://mcp.dev.instacart.tools/mcp')).toBe(true);
    expect(calls.every((call) => call.authorization === 'Bearer keys.1234567890abcdef1234567890abcdef')).toBe(true);
    expect(calls.map((call) => call.rpcMethod).filter(Boolean)).toEqual(expect.arrayContaining([
      'initialize', 'notifications/initialized', 'tools/list',
    ]));
    expect(calls.filter((call) => call.rpcMethod !== 'initialize').every(
      (call) => call.session === 'instacart-test-session',
    )).toBe(true);
    expect(calls.at(-1)?.method).toBe('DELETE');
    expect(calls.some((call) => call.rpcMethod?.startsWith('tools/call'))).toBe(false);
    expect(adapter.instacartMcpEndpoint({ metadata: { environment: 'live' } }))
      .toBe('https://mcp.instacart.com/mcp');
  });

  it('uses only fixed Instacart shopper routes and fresh confirmation for shareable pages', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/retailers?')) return response(200, { retailers: [{ retailer_key: 'market', name: 'Market' }] });
      return response(200, { products_link_url: 'https://www.instacart.com/store/recipes/example' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('instacart', { api_key: 'keys.1234567890abcdef1234567890abcdef' }, { environment: 'sandbox' });

    const retailers = await adapter.callTool('execute_read', {
      action: 'retailers.list', parameters: { postal_code: '94105', country_code: 'US' },
    }, env);
    const recipe = await adapter.callTool('execute_high_impact', {
      action: 'recipe_page.create', parameters: { body: {
        title: 'Tomato pasta', expires_in: 30,
        ingredients: [{ name: 'tomatoes', measurements: [{ quantity: 2, unit: 'each' }] }],
        landing_page_configuration: { partner_linkback_url: 'https://merchant.example/recipes/1', enable_pantry_items: true },
      } },
    }, env);
    const shoppingList = await adapter.callTool('execute_high_impact', {
      action: 'shopping_list_page.create', parameters: { body: {
        title: 'Weekly groceries', link_type: 'shopping_list',
        line_items: [{ name: 'milk', line_item_measurements: [{ quantity: 1, unit: 'gallon' }] }],
      } },
    }, env);

    expect(retailers.result).toEqual({ retailers: [{ retailer_key: 'market', name: 'Market' }] });
    expect(recipe.risk).toBe('H');
    expect(shoppingList.risk).toBe('H');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://connect.dev.instacart.tools/idp/v1/retailers?postal_code=94105&country_code=US',
      'https://connect.dev.instacart.tools/idp/v1/products/recipe',
      'https://connect.dev.instacart.tools/idp/v1/products/products_link',
    ]);
    expect(fetchMock.mock.calls.every((call) => call[1]?.headers.authorization === 'Bearer keys.1234567890abcdef1234567890abcdef')).toBe(true);
    expect(adapter.instacartBase({ metadata: { environment: 'live' } })).toBe('https://connect.instacart.com');
    await expect(adapter.callTool('execute_write', {
      action: 'recipe_page.create', parameters: { body: { title: 'No', ingredients: [{ name: 'milk' }] } },
    }, env)).rejects.toThrow(/risk mismatch/);
  });

  it('rejects unsafe or ambiguous Instacart payloads and hides provider response bodies', async () => {
    expect(() => adapter.validateInstacartPage('recipe_page.create', {
      title: 'Recipe', image_url: 'http://internal.test/image.png', ingredients: [{ name: 'milk' }],
    })).toThrow(/HTTPS URL/);
    expect(() => adapter.validateInstacartPage('recipe_page.create', {
      title: 'Recipe', ingredients: [{ name: 'milk', product_ids: [1], upcs: ['123456789012'] }],
    })).toThrow(/both product_ids and upcs/);
    expect(() => adapter.validateInstacartPage('shopping_list_page.create', {
      title: 'List', link_type: 'recipe', line_items: [{ name: 'milk' }],
    })).toThrow(/must be shopping_list/);
    expect(() => adapter.validateInstacartPage('shopping_list_page.create', {
      title: 'List', line_items: [{ name: 'milk', upcs: ['123456789012'] }, { name: 'more milk', upcs: ['123456789012'] }],
    })).toThrow(/unique 12- or 14-digit UPCs/);
    expect(() => adapter.validateInstacartPage('recipe_page.create', {
      title: 'Recipe', ingredients: [{ name: 'milk', product_ids: [42, 42] }],
    })).toThrow(/unique positive integers/);
    expect(() => adapter.validateInstacartPage('shopping_list_page.create', {
      title: 'List', line_items: Array.from({ length: 101 }, () => ({ name: 'item' })),
    })).toThrow(/1-100 items/);

    vi.stubGlobal('fetch', vi.fn(async () => response(400, {
      message: 'private-buyer@example.com rejected this request',
    })));
    const env = envFor('instacart', { api_key: 'keys.1234567890abcdef1234567890abcdef' }, { environment: 'sandbox' });
    const failed = adapter.callTool('execute_read', {
      action: 'retailers.list', parameters: { postal_code: '94105', country_code: 'US' },
    }, env);
    const error = await failed.catch((caught) => caught as Error);
    expect(error.message).toBe('Instacart request failed (HTTP 400)');
    expect(error.message).not.toContain('private-buyer');
  });

  it('hides provider response bodies for non-Instacart request failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(400, {
      message: 'private-buyer@example.test /Users/test/private.json',
    })));
    const env = envFor('shopify', {
      client_id: 'shopify-client', client_secret: 'shopify-secret',
    }, { shop_domain: 'merchant.myshopify.com' });

    const failed = adapter.callTool('execute_read', { action: 'shop.get' }, env);
    const error = await failed.catch((caught) => caught as Error);

    expect(error.message).toBe('provider request failed (HTTP 400)');
    expect(error.message).not.toContain('private-buyer');
    expect(error.message).not.toContain('/Users/');
  });

  it('uses Shopify client credentials, current Admin GraphQL, and modern fulfillment scopes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, {
        access_token: 'shopify-access-token', expires_in: 86_400,
        scope: [
          'read_products', 'write_products', 'read_orders', 'write_orders',
          'read_customers', 'write_customers', 'read_inventory', 'write_inventory',
          'read_locations', 'read_draft_orders', 'write_draft_orders',
          'read_returns', 'write_returns', 'read_discounts', 'write_discounts',
          'read_publications', 'write_publications',
          'write_merchant_managed_fulfillment_orders',
        ].join(','),
      }))
      .mockResolvedValueOnce(response(200, { data: { shop: { id: 'gid://shopify/Shop/1', name: 'Merchant' } } }))
      .mockResolvedValueOnce(response(200, { data: { orderCancel: {
        job: null, orderCancelUserErrors: [{
          field: ['orderId'], message: 'private-buyer@example.test /Users/test/private.json', code: 'INVALID',
        }],
      } } }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('shopify', {
      client_id: 'shopify-client', client_secret: 'shopify-secret',
    }, { shop_domain: 'merchant.myshopify.com' });

    const result = await adapter.callTool('execute_read', { action: 'shop.get' }, env);

    expect(result).toMatchObject({ provider: 'shopify', action: 'shop.get', risk: 'R' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://merchant.myshopify.com/admin/oauth/access_token');
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain('grant_type=client_credentials');
    expect(fetchMock.mock.calls[1][0]).toBe('https://merchant.myshopify.com/admin/api/2026-07/graphql.json');
    expect(fetchMock.mock.calls[1][1]?.headers).toMatchObject({
      'x-shopify-access-token': 'shopify-access-token',
    });

    const rejected = adapter.callTool('execute_destructive', {
      action: 'orders.cancel', parameters: {
        order_id: 'gid://shopify/Order/1', refund_method: { originalPaymentMethodsRefund: true },
        restock: true, reason: 'CUSTOMER', notify_customer: true, staff_note: 'Customer request',
      },
    }, env);
    const rejectedError = await rejected.catch((caught) => caught as Error);
    expect(rejectedError.message).toBe('Shopify rejected the operation');
    expect(rejectedError.message).not.toContain('private-buyer');
    expect(rejectedError.message).not.toContain('/Users/');
    const cancelRequest = JSON.parse(String(fetchMock.mock.calls[2][1]?.body));
    expect(cancelRequest.query).toContain('orderCancelUserErrors');
    expect(cancelRequest.variables).toMatchObject({
      orderId: 'gid://shopify/Order/1', restock: true, reason: 'CUSTOMER', notifyCustomer: true,
      refundMethod: { originalPaymentMethodsRefund: true },
    });
  });

  describe('Shopify shared setup scope requirements', () => {
    // Each fixture represents a separate connector process, with an empty token cache.
    function freshAdapter(): typeof adapter {
      const modulePath = require.resolve('../../../../bin/direct-commerce-mcp-server.cjs');
      const cached = require.cache[modulePath];
      delete require.cache[modulePath];
      try { return require(modulePath); }
      finally { if (cached) require.cache[modulePath] = cached; }
    }

    function readShop(scopes: string[]) {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(response(200, {
          access_token: 'fixture-shopify-token', scope: scopes.join(','), expires_in: 86400,
        }))
        .mockResolvedValueOnce(response(200, { data: { shop: { id: 'gid://shopify/Shop/1' } } }));
      vi.stubGlobal('fetch', fetchMock);
      const env = envFor('shopify', { client_id: 'fixture-client', client_secret: 'fixture-secret' }, {
        shop_domain: 'fixture.myshopify.com',
      });
      return { fetchMock, result: freshAdapter().callTool('execute_read', { action: 'shop.get' }, env) };
    }

    it.each(shopifyRequirements.fulfillment_scopes_any_of)('accepts only one applicable fulfillment scope: %s', async scope => {
      const { fetchMock, result } = readShop([...shopifyRequirements.required_scopes, scope]);
      await expect(result).resolves.toMatchObject({ provider: 'shopify', action: 'shop.get' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('accepts Shopify compressed write grants as including the matching read permissions', async () => {
      // Shopify AuthScopes expands write_X into read_X. The real dev-store
      // token response omits redundant read scopes even when both are requested.
      const { fetchMock, result } = readShop([
        'write_products', 'write_orders', 'write_customers', 'write_inventory', 'read_locations',
        'write_draft_orders', 'write_returns', 'write_discounts', 'write_publications',
        'write_merchant_managed_fulfillment_orders',
      ]);
      await expect(result).resolves.toMatchObject({ provider: 'shopify', action: 'shop.get',
        result: { shop: { id: 'gid://shopify/Shop/1' } } });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it.each(shopifyRequirements.required_scopes)('rejects a missing required scope before API use: %s', async missing => {
      const { fetchMock, result } = readShop([
        // Removing read_X alone is not denial while write_X remains granted.
        ...shopifyRequirements.required_scopes.filter(scope => scope !== missing
          && !(missing.startsWith('read_') && scope === `write_${missing.slice(5)}`)),
        'write_merchant_managed_fulfillment_orders',
      ]);
      await expect(result).rejects.toThrow(`Shopify app is missing required Admin API scopes: ${missing}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([{ scopes: [] }, { scopes: ['write_fulfillments'] }])('rejects absent or legacy fulfillment grants: $scopes', async ({ scopes }) => {
      const { fetchMock, result } = readShop([...shopifyRequirements.required_scopes, ...scopes]);
      await expect(result).rejects.toThrow(`one of: ${shopifyRequirements.fulfillment_scopes_any_of.join(' / ')}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('rotates Constant Contact refresh credentials before the harmless account read', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, {
        access_token: 'new-access-token', refresh_token: 'new-refresh-token', expires_in: 3600,
        scope: 'account_read contact_data campaign_data offline_access', token_type: 'Bearer',
      }))
      .mockResolvedValueOnce(response(200, { encoded_account_id: 'account-1', organization_name: 'Merchant' }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('constant_contact', {
      client_id: 'constant-client', access_token: 'old-access-token',
      refresh_token: 'old-refresh-token', expires_at: 0,
      scope: 'account_read contact_data campaign_data offline_access',
    });

    const result = await adapter.callTool('execute_read', { action: 'account.get' }, env);

    expect(result.result).toEqual({ encoded_account_id: 'account-1', organization_name: 'Merchant' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://authz.constantcontact.com/oauth2/default/v1/token',
      'https://api.cc.email/v3/account/summary',
    ]);
    const persisted = codec.readCredentialFile(
      env.ORKAS_LOCAL_API_CREDENTIAL_FILE!, env.ORKAS_LOCAL_API_CREDENTIAL_KEY!,
    );
    expect(persisted).toMatchObject({
      provider: 'constant_contact', access_token: 'new-access-token', refresh_token: 'new-refresh-token',
    });
    expect(fs.readFileSync(env.ORKAS_LOCAL_API_CREDENTIAL_FILE!, 'utf8')).not.toContain('new-refresh-token');
  });

  it('uses official Reloadly transaction routes and reads balance immediately before spending', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200, { access_token: 'reloadly-token', expires_in: 3600 }))
      .mockResolvedValueOnce(response(200, { balance: 100, currencyCode: 'USD' }))
      .mockResolvedValueOnce(response(200, { transactionId: 3116, status: 'SUCCESSFUL' }))
      .mockResolvedValueOnce(response(200, { transactionId: 3116, status: 'SUCCESSFUL' }));
    vi.stubGlobal('fetch', fetchMock);
    const env = envFor('reloadly', {
      client_id: 'reloadly-client', client_secret: 'reloadly-secret',
    }, { product: 'giftcards', environment: 'sandbox' });
    const purchase = {
      productId: 10, countryCode: 'US', quantity: 2, unitPrice: 5,
      customIdentifier: 'order-unique-001', recipientEmail: 'buyer@example.com',
    };

    const created = await adapter.callTool('execute_high_impact', {
      action: 'orders.create', parameters: { body: purchase },
    }, env);
    const fetched = await adapter.callTool('execute_read', {
      action: 'orders.get', parameters: { id: '3116' },
    }, env);

    expect(created.result).toEqual({
      balance_before: { balance: 100, currencyCode: 'USD' },
      transaction: { transactionId: 3116, status: 'SUCCESSFUL' },
    });
    expect(fetched.result).toEqual({ transactionId: 3116, status: 'SUCCESSFUL' });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://auth.reloadly.com/oauth/token',
      'https://giftcards-sandbox.reloadly.com/accounts/balance',
      'https://giftcards-sandbox.reloadly.com/orders',
      'https://giftcards-sandbox.reloadly.com/reports/transactions/3116',
    ]);
    expect(() => adapter.validateReloadlyPurchase('giftcards', {
      ...purchase, customIdentifier: '',
    })).toThrow(/idempotent reconciliation/);
  });
});
