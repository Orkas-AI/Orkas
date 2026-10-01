import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const gate = require('../../../bin/packaged-entrypoint-gate.cjs') as {
  BUILD_ONLY_BIN_FILES: readonly string[];
  CONNECTOR_RUNTIME_ENTRYPOINTS: readonly string[];
  CONNECTOR_RUNTIME_SMOKE_PROFILES: readonly { name: string; env: Record<string, string> }[];
  DORMANT_BIN_FILES: readonly string[];
  PACKAGED_BIN_ENTRYPOINTS: readonly string[];
  PACKAGED_BIN_HELPERS: readonly string[];
  PACKAGED_JS_LOADER_FILES: readonly { packageName: string; entry: string }[];
  PACKAGED_MCP_RUNTIME_FILES: readonly {
    lockPath: string;
    packagedPath?: string;
    packageName: string;
    entries: readonly string[];
  }[];
  PACKAGED_MCP_RUNTIME_UNPACK_GLOBS: readonly string[];
  requiredPackagedConnectorSmokeEntries(): string[];
  requiredPackagedEntrypointVerificationEntries(): string[];
  verifyBuildFilesConfig(build: unknown): string[];
  verifyPackagedConnectorRuntime(root: string): string[];
  verifyPackagedEntrypointPayload(root: string, options: { projectRoot: string }): string[];
  verifySourceEntrypointContract(root: string): string[];
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-entrypoint-gate-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function packagedFixture(): string {
  const pcRoot = path.join(tmpDir, 'app.asar.unpacked');
  const binRoot = path.join(pcRoot, 'bin');
  fs.mkdirSync(binRoot, { recursive: true });
  for (const name of gate.PACKAGED_BIN_ENTRYPOINTS) {
    fs.copyFileSync(path.join(process.cwd(), 'bin', name), path.join(binRoot, name));
  }
  for (const name of gate.PACKAGED_BIN_HELPERS) {
    fs.copyFileSync(path.join(process.cwd(), 'bin', name), path.join(binRoot, name));
  }

  const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
  for (const spec of gate.PACKAGED_JS_LOADER_FILES) {
    const packageDir = path.join(pcRoot, 'node_modules', ...spec.packageName.split('/'));
    const entry = path.join(packageDir, ...spec.entry.split('/'));
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: spec.packageName,
      version: lock.packages[`node_modules/${spec.packageName}`].version,
    }));
    fs.writeFileSync(entry, 'module.exports = {};\n');
  }
  for (const spec of gate.PACKAGED_MCP_RUNTIME_FILES) {
    const packageDir = path.join(pcRoot, ...(spec.packagedPath || spec.lockPath).split('/'));
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: spec.packageName,
      version: lock.packages[spec.lockPath].version,
    }));
    for (const relativeEntry of spec.entries) {
      const entry = path.join(packageDir, ...relativeEntry.split('/'));
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, 'module.exports = {};\n');
    }
  }
  return pcRoot;
}

function packagedRuntimeFixture(): string {
  const pcRoot = packagedFixture();
  for (const spec of gate.PACKAGED_MCP_RUNTIME_FILES) {
    const sourceDir = path.join(process.cwd(), ...spec.lockPath.split('/'));
    const packageDir = path.join(pcRoot, ...(spec.packagedPath || spec.lockPath).split('/'));
    fs.rmSync(packageDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(packageDir), { recursive: true });
    fs.cpSync(sourceDir, packageDir, { recursive: true });
    if (spec.packageName === '@modelcontextprotocol/sdk') {
      // electron-builder flattens the locked SDK dependencies into the
      // packaged root. Remove the source-only nested fallback so this fixture
      // cannot accidentally resolve a dependency that the package omitted.
      fs.rmSync(path.join(packageDir, 'node_modules'), { recursive: true, force: true });
    }
  }
  return pcRoot;
}

describe('packaged-entrypoint-gate', () => {
  it('keeps every source bin file classified and package exclusions synchronized', () => {
    const verified = gate.verifySourceEntrypointContract(process.cwd());

    expect(verified).toHaveLength(
      gate.PACKAGED_BIN_ENTRYPOINTS.length
        + gate.PACKAGED_BIN_HELPERS.length
        + gate.BUILD_ONLY_BIN_FILES.length
        + gate.DORMANT_BIN_FILES.length,
    );
    expect(gate.BUILD_ONLY_BIN_FILES).toContain('packaged-entrypoint-gate.cjs');
    expect(gate.BUILD_ONLY_BIN_FILES).toContain('packaged-dependency-gate.cjs');
    expect(gate.PACKAGED_BIN_HELPERS).toContain('auto-tasks-contract.cjs');
    expect(gate.PACKAGED_BIN_HELPERS).toContain('bridge-skill-runner.cjs');
    expect(gate.PACKAGED_BIN_HELPERS).toContain('local-cli-lark.cjs');
    expect(gate.PACKAGED_BIN_HELPERS).toContain('proxy-bootstrap.cjs');
    expect(gate.PACKAGED_BIN_HELPERS).toContain('shopify-setup-requirements.cjs');
    expect(gate.PACKAGED_BIN_ENTRYPOINTS).not.toContain('shopify-setup-requirements.cjs');
  });

  it('rejects a build-only helper that is not excluded from the app', () => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    packageJson.build.files = packageJson.build.files.filter(
      (entry: string) => entry !== '!bin/runtime-gate.cjs',
    );

    expect(() => gate.verifyBuildFilesConfig(packageJson.build)).toThrow(/runtime-gate\.cjs/);
  });

  it.each(['files', 'asarUnpack'] as const)(
    'rejects every MCP runtime glob omitted from build.%s',
    (field) => {
      for (const glob of gate.PACKAGED_MCP_RUNTIME_UNPACK_GLOBS) {
        const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
        packageJson.build[field] = packageJson.build[field].filter((entry: string) => entry !== glob);

        expect(
          () => gate.verifyBuildFilesConfig(packageJson.build),
          `${field} accepted missing connector runtime ${glob}`,
        ).toThrow(new RegExp(`${field} must include ${glob.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      }
    },
  );

  it('verifies the closed packaged bin tree and complete runtime dependency chains', () => {
    const pcRoot = packagedFixture();

    expect(gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toEqual(gate.requiredPackagedEntrypointVerificationEntries());
  });

  it('accepts the XML parser dependency nested beside a different hoisted strnum version', () => {
    const pcRoot = packagedFixture();
    const root = path.join(pcRoot, 'node_modules', 'strnum');
    const nested = path.join(pcRoot, 'node_modules', 'fast-xml-parser', 'node_modules', 'strnum');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.renameSync(root, nested);
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'strnum', version: '1.1.2' }));
    fs.writeFileSync(path.join(root, 'strnum.js'), 'module.exports = {};\n');

    expect(gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toEqual(gate.requiredPackagedEntrypointVerificationEntries());

    fs.rmSync(nested, { recursive: true });
    expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toThrow(/strnum version mismatch/);
  });

  it('rejects an incorrect parser-local strnum even when the hoisted version matches', () => {
    const pcRoot = packagedFixture();
    const nested = path.join(pcRoot, 'node_modules', 'fast-xml-parser', 'node_modules', 'strnum');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'strnum', version: '1.1.2' }));
    fs.writeFileSync(path.join(nested, 'strnum.js'), 'module.exports = {};\n');

    expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toThrow(/strnum version mismatch/);
  });

  it.each(['missing', 'invalid'] as const)('rejects a %s nested strnum entry without falling back', (failure) => {
    const pcRoot = packagedFixture();
    const nested = path.join(pcRoot, 'node_modules', 'fast-xml-parser', 'node_modules', 'strnum');
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.cpSync(path.join(pcRoot, 'node_modules', 'strnum'), nested, { recursive: true });
    const entry = path.join(nested, 'strnum.js');
    if (failure === 'missing') fs.rmSync(entry);
    else fs.writeFileSync(entry, 'module.exports = {;\n');

    expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toThrow(failure === 'missing' ? /missing strnum runtime/ : /invalid strnum runtime/);
  });

  it('rejects build-only or newly introduced files in the packaged bin tree', () => {
    const pcRoot = packagedFixture();
    fs.writeFileSync(path.join(pcRoot, 'bin', 'runtime-gate.cjs'), 'module.exports = {};\n');

    expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toThrow(/unregistered: runtime-gate\.cjs/);
  });

  it('rejects an incomplete loader chain', () => {
    const pcRoot = packagedFixture();
    fs.rmSync(path.join(pcRoot, 'node_modules', 'esbuild', 'lib', 'main.js'));

    expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toThrow(/missing esbuild loader lib\/main\.js/);
  });

  it.each(['browser-tool-contract.cjs', 'connector-discovery-contract.cjs', 'ebay-signature.cjs', 'temu-api-contracts.cjs', 'shein-api-contracts.cjs', 'lazada-api-contracts.cjs', 'amazon-business-api.cjs', 'amazon-api-contracts.cjs', 'square-business-api.cjs', 'square-api-contracts.cjs', 'ebay-business-api.cjs', 'ebay-api-contracts.cjs', 'etsy-business-api.cjs', 'etsy-api-contracts.cjs', 'bigcommerce-business-api.cjs', 'bigcommerce-api-contracts.cjs', 'woocommerce-business-api.cjs', 'woocommerce-api-contracts.cjs', 'commercelayer-business-api.cjs', 'commercelayer-api-contracts.cjs', 'constant-contact-business-api.cjs', 'constant-contact-api-contracts.cjs', 'shopify-business-api.cjs', 'shopify-api-contracts.cjs', 'shopline-business-api.cjs', 'shopline-api-contracts.cjs', 'shoplazza-business-api.cjs', 'shoplazza-api-contracts.cjs', 'reloadly-business-api.cjs', 'reloadly-api-contracts.cjs', 'lightspeed-business-api.cjs', 'lightspeed-api-contracts.cjs', 'shopline-graphql-api.cjs', 'shopline-graphql-contracts.cjs', 'base-shop-business-api.cjs', 'base-shop-api-contracts.cjs', 'walmart-business-api.cjs', 'walmart-api-contracts.cjs', 'qoo10-business-api.cjs', 'qoo10-api-contracts.cjs', 'futureshop-business-api.cjs', 'futureshop-api-contracts.cjs', 'shopee-business-api.cjs', 'shopee-api-contracts.cjs', 'tiktok-shop-business-api.cjs', 'tiktok-shop-api-contracts.cjs', 'yahoo-shopping-business-api.cjs', 'yahoo-shopping-api-contracts.cjs', 'douyin-business-api.cjs', 'douyin-api-contracts.cjs', 'aliexpress-business-api.cjs', 'aliexpress-api-contracts.cjs', 'mercado-libre-business-api.cjs', 'mercado-libre-api-contracts.cjs', 'kuaishou-business-api.cjs', 'kuaishou-api-contracts.cjs', 'alibaba-1688-business-api.cjs', 'alibaba-1688-api-contracts.cjs', 'youzan-business-api.cjs', 'youzan-api-contracts.cjs', 'icbu-business-api.cjs', 'icbu-api-contracts.cjs', 'weimob-business-api.cjs', 'weimob-api-contracts.cjs', 'taobao-business-api.cjs', 'taobao-api-contracts.cjs', 'jd-business-api.cjs', 'jd-api-contracts.cjs'])(
    'blocks a package missing the runtime helper %s', (name) => {
      const pcRoot = packagedFixture();
      fs.rmSync(path.join(pcRoot, 'bin', name));
      expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
        .toThrow(`missing: ${name}`);
    },
  );

  it('executes a packaged Temu business read using the flattened schema dependencies', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const api = require('./bin/temu-seller-api.cjs');
      const crypto = require('node:crypto');
      const config = { provider: 'temu', metadata: { region: 'us' }, credentials: {
        provider: 'temu', app_key: 'fixture-app', app_secret: 'fixture-secret', access_token: 'fixture-token',
        identity: { region: 'us', shop_id: '123', expires_at: Date.now() + 60000,
          app_fingerprint: crypto.createHash('sha256').update('fixture-app').digest('hex'), scopes: ['bg.order.list.v2.get'] }
      }};
      global.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (url !== 'https://openapi-b-us.temu.com/openapi/router' || body.pageNumber !== 2 || body.hasPreSaleOrder !== false) throw new Error('Unexpected wire contract');
        return new Response(JSON.stringify({ success: true, result: { pageItems: [], totalItemNum: 0 } }));
      };
      api.execute(config, 'bg.order.list.v2.get', { pageNumber: 2, hasPreSaleOrder: false })
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged Temu validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const run = () => spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: { pageItems: [], totalItemNum: 0 } });
    fs.rmSync(path.join(pcRoot, 'bin', 'temu-api-contracts.cjs'));
    const missing = run();
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('Packaged Temu validation failed');
  });

  it('executes a packaged SHEIN business read using the flattened schema dependencies', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const api = require('./bin/shein-seller-api.cjs');
      const crypto = require('node:crypto');
      const hash = value => crypto.createHash('sha256').update(value).digest('hex');
      const config = { provider: 'shein', metadata: {}, credentials: {
        provider: 'shein', app_id: 'fixture-app', app_secret: 'fixture-secret', open_key_id: 'fixture-open-key', secret_key: 'fixture-grant-secret',
        identity: { supplier_id: '123', app_fingerprint: hash('fixture-app'), grant_fingerprint: hash('fixture-open-key') }
      }};
      global.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (url !== 'https://openapi.sheincorp.com/open-api/order/order-list' || body.page !== 2 || body.queryType !== 2) throw new Error('Unexpected wire contract');
        return new Response(JSON.stringify({ code: '0', info: { count: 0, orderList: [] } }));
      };
      api.execute(config, 'POST /open-api/order/order-list', { body: { queryType: 2, startTime: '2026-09-28 00:00:00', endTime: '2026-09-29 00:00:00', page: 2, pageSize: 30 } })
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged SHEIN validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const run = () => spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    const result = run();
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: { count: 0, orderList: [] } });
    fs.rmSync(path.join(pcRoot, 'bin', 'shein-api-contracts.cjs'));
    const missing = run();
    expect(missing.status).toBe(1); expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('Packaged SHEIN validation failed');
  });

  it('executes a packaged Lazada business read using the flattened schema dependencies', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const api = require('./bin/lazada-seller-api.cjs');
      const crypto = require('node:crypto');
      const config = { provider: 'lazada', metadata: { country: 'sg' }, credentials: {
        provider: 'lazada', app_key: 'fixture-app', app_secret: 'fixture-secret', access_token: 'fixture-token',
        expires_at: Date.now() + 3600000, refresh_expires_at: Date.now() + 86400000,
        identity: { country: 'sg', shop_id: '123', app_fingerprint: crypto.createHash('sha256').update('fixture-app').digest('hex') }
      }};
      global.fetch = async (raw, init) => {
        const url = new URL(raw);
        if (url.hostname !== 'api.lazada.sg' || url.pathname !== '/rest/orders/get' || init.method !== 'GET'
          || url.searchParams.get('limit') !== '100' || !url.searchParams.has('update_after')) throw new Error('Unexpected wire contract');
        return new Response(JSON.stringify({ code: '0', data: { orders: [], count: 0, countTotal: 0 } }));
      };
      api.execute(config, 'GET /orders/get', { parameters: { update_after: '2026-09-28T00:00:00+08:00', limit: 100 } })
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged Lazada validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const run = () => spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    const result = run();
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: { code: '0', data: { orders: [], count: 0, countTotal: 0 } } });
    fs.rmSync(path.join(pcRoot, 'bin', 'lazada-api-contracts.cjs'));
    const missing = run();
    expect(missing.status).toBe(1); expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('Packaged Lazada validation failed');
  });

  it('executes a packaged Amazon native business read using flattened schema dependencies', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const api = require('./bin/amazon-business-api.cjs');
      const config = { provider: 'amazon_seller', metadata: { marketplace_id: 'ATVPDKIKX0DER', seller_id: 'A1SELLER23456789' }, credentials: {} };
      global.fetch = async (raw, init) => {
        const url = new URL(raw);
        if (url.origin !== 'https://sellingpartnerapi-na.amazon.com' || url.pathname !== '/orders/2026-01-01/orders' || init.method !== 'GET'
          || url.searchParams.get('paginationToken') !== 'PAGE-2' || url.searchParams.get('maxResultsPerPage') !== '100') throw new Error('Unexpected wire contract');
        return new Response(JSON.stringify({ orders: [], pagination: { nextToken: 'PAGE-3' } }));
      };
      api.execute(config, 'GET /orders/2026-01-01/orders', { query: { marketplaceIds: ['ATVPDKIKX0DER'], paginationToken: 'PAGE-2', maxResultsPerPage: 100 } },
        { base: () => 'https://sellingpartnerapi-na.amazon.com', token: async () => 'fixture-token' })
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged Amazon validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const run = () => spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    const result = run();
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: { orders: [], pagination: { nextToken: 'PAGE-3' } } });
    fs.rmSync(path.join(pcRoot, 'bin', 'amazon-api-contracts.cjs'));
    const missing = run();
    expect(missing.status).toBe(1); expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('Packaged Amazon validation failed');
  });

  it('executes a packaged Square native business read using flattened schema dependencies', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const api = require('./bin/square-business-api.cjs');
      const config = { provider: 'square', metadata: { environment: 'live' }, credentials: { access_token: 'fixture-token' } };
      global.fetch = async (raw, init) => {
        const url = new URL(raw);
        if (url.origin !== 'https://connect.squareup.com' || url.pathname !== '/v2/customers' || init.method !== 'GET'
          || url.searchParams.get('cursor') !== 'PAGE-2' || url.searchParams.get('limit') !== '100') throw new Error('Unexpected wire contract');
        return new Response(JSON.stringify({ customers: [], cursor: 'PAGE-3' }));
      };
      api.execute(config, 'GET /v2/customers', { query: { cursor: 'PAGE-2', limit: 100 } },
        { base: () => 'https://connect.squareup.com' })
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged Square validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const run = () => spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    const result = run();
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: { customers: [], cursor: 'PAGE-3' } });
    fs.rmSync(path.join(pcRoot, 'bin', 'square-api-contracts.cjs'));
    const missing = run();
    expect(missing.status).toBe(1); expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('Packaged Square validation failed');
  });

  it('executes a packaged eBay native business read using flattened schema dependencies', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const api = require('./bin/ebay-business-api.cjs');
      const config = { provider: 'ebay', metadata: { environment: 'live', marketplace_id: 'EBAY_US', content_language: 'en-US' }, credentials: { access_token: 'fixture-token', scope: 'https://api.ebay.com/oauth/api_scope/sell.inventory' } };
      global.fetch = async (raw, init) => {
        const url = new URL(raw);
        if (url.origin !== 'https://api.ebay.com' || url.pathname !== '/sell/inventory/v1/inventory_item' || init.method !== 'GET'
          || url.searchParams.get('offset') !== '100' || url.searchParams.get('limit') !== '100') throw new Error('Unexpected wire contract');
        return new Response(JSON.stringify({ inventoryItems: [], total: 0 }));
      };
      api.execute(config, 'GET /sell/inventory/v1/inventory_item', { query: { offset: '100', limit: '100' } },
        { base: () => 'https://api.ebay.com', token: async () => 'fixture-token' })
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged eBay validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const run = () => spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    const result = run();
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: { inventoryItems: [], total: 0 } });
    fs.rmSync(path.join(pcRoot, 'bin', 'ebay-api-contracts.cjs'));
    const missing = run();
    expect(missing.status).toBe(1); expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('Packaged eBay validation failed');
  });

  it.each([
    { provider: 'etsy', action: 'getShop', parameters: {}, metadata: { shop_id: '123' }, credentials: { access_token: 'fixture-token', scope: 'shops_r', identity: { shop_id: '123', user_id: '456' } },
      url: 'https://openapi.etsy.com/v3/application/shops/123', body: { shop_id: 123, shop_name: 'Fixture' } },
    { provider: 'bigcommerce', action: 'GET /v2/orders/{order_id}', parameters: { path: { order_id: 123 } }, metadata: { store_hash: 'abc123' }, credentials: { provider: 'bigcommerce', access_token: 'fixture-token', identity: { binding: 'abc123', shop_id: '123' } },
      url: 'https://api.bigcommerce.com/stores/abc123/v2/orders/123', body: { id: 123, billing_address: { zip: '10001', email: 'fixture@example.invalid', phone: '123' } } },
  ])('executes a packaged $provider native business read with flattened dependencies', fixture => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const fixture = ${JSON.stringify(fixture)};
      const api = require('./bin/' + fixture.provider + '-business-api.cjs');
      global.fetch = async (url, init) => {
        if (url !== fixture.url || init.method !== 'GET') throw new Error('Unexpected wire contract');
        return new Response(JSON.stringify(fixture.body));
      };
      api.execute({ provider: fixture.provider, metadata: fixture.metadata, credentials: fixture.credentials }, fixture.action, fixture.parameters,
        { token: async () => 'fixture-token', apiKey: () => 'fixture-key' })
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged merchant validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const run = () => spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    const result = run();
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: fixture.body });
    fs.rmSync(path.join(pcRoot, 'bin', fixture.provider + '-api-contracts.cjs'));
    const missing = run();
    expect(missing.status).toBe(1); expect(missing.stdout).toBe('');
    expect(missing.stderr).toBe('Packaged merchant validation failed');
  });

  it.each([
    { helper: 'woocommerce', provider: 'woocommerce', action: 'GET /orders/{id}', parameters: { path: { id: 1 } }, metadata: { store_url: 'https://fixture-commerce.com' }, credentials: { consumer_key: 'ck_' + 'a'.repeat(40), consumer_secret: 'cs_' + 'b'.repeat(40) }, base: 'https://fixture-commerce.com/wp-json/wc/v3',
      url: 'https://fixture-commerce.com/wp-json/wc/v3/orders/1', body: { id: 1, billing: { email: 'fixture@example.invalid' } } },
    { helper: 'commercelayer', provider: 'commerce_layer', action: 'GET /orders/{orderId}', parameters: { path: { orderId: 'order-1' } }, metadata: { organization_slug: 'sample-shop' }, credentials: { client_secret: 'fixture-secret' }, base: 'https://sample-shop.commercelayer.io',
      url: 'https://sample-shop.commercelayer.io/api/orders/order-1', body: { data: { type: 'orders', id: 'order-1', attributes: { customer_email: 'fixture@example.invalid' } } } },
    { helper: 'constant-contact', provider: 'constant_contact', action: 'GET /contacts', parameters: { query: { limit: 100 } }, metadata: {}, credentials: { scope: 'contact_data' }, base: '',
      url: 'https://api.cc.email/v3/contacts?limit=100', body: { contacts: [{ contact_id: 'C1', email_address: { address: 'fixture@example.invalid' } }] } },
    { helper: 'shopline', provider: 'shopline', action: 'GET /orders.json', parameters: { query: { limit: '1' } }, metadata: { store_domain: 'fixture.myshopline.com' }, credentials: { provider: 'shopline', access_token: 'fixture-token', identity: { binding: 'fixture.myshopline.com', shop_id: '1' } }, base: '',
      url: 'https://fixture.myshopline.com/admin/openapi/v20260901/orders.json?limit=1', body: { orders: [{ id: 'order-1', email: 'fixture@example.invalid' }] } },
    { helper: 'reloadly', provider: 'reloadly', action: 'giftcards.accounts-balance', parameters: {}, metadata: { product: 'giftcards', environment: 'sandbox' }, credentials: {}, base: 'https://giftcards-sandbox.reloadly.com',
      url: 'https://giftcards-sandbox.reloadly.com/accounts/balance', body: { balance: 100, currencyCode: 'USD' } },
    { helper: 'lightspeed', provider: 'lightspeed', action: 'GET /retailer', parameters: {}, metadata: { store_domain: 'fixture.retail.lightspeed.app' }, credentials: { provider: 'lightspeed', access_token: 'fixture-token' }, base: '',
      url: 'https://fixture.retail.lightspeed.app/api/2026-07/retailer', body: { data: { id: 'retailer-1', name: 'Fixture', domain_prefix: 'fixture' } } },
    { helper: 'walmart', provider: 'walmart', action: 'GET /v3/inventory', parameters: { query: { sku: 'fixture-sku' } }, metadata: { market: 'ca', environment: 'live' }, credentials: {}, base: 'https://marketplace.walmartapis.com',
      url: 'https://marketplace.walmartapis.com/v3/inventory?sku=fixture-sku', body: { sku: 'fixture-sku', quantity: { unit: 'EACH', amount: 3 } } },
    { helper: 'base-shop', provider: 'base_shop', action: 'base.items', parameters: { limit: 1 }, metadata: {}, credentials: { provider: 'base_shop', client_id: 'fixture-client', client_secret: 'fixture-secret', access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_at: Date.now() + 3600000, identity: { shop_id: 'shop-1', app_fingerprint: '4b59118bb005f5d2f5fca9b832d1705a01d3905bcfad57c39c2e079f0cd07773' } }, base: '',
      url: 'https://api.thebase.in/1/items?limit=1&offset=0', body: { items: [{ item_id: 1, title: 'Fixture', stock: 0 }] } },
    { helper: 'shoplazza', provider: 'shoplazza', action: 'product-detail', parameters: { path: { product_id: 'p1' } }, metadata: { store_domain: 'fixture.myshoplaza.com' }, credentials: { provider: 'shoplazza', access_token: 'fixture-token', identity: { binding: 'fixture.myshoplaza.com', shop_id: '1' } }, base: '',
      url: 'https://fixture.myshoplaza.com/openapi/2026-01/products/p1', body: { code: 'Success', data: { product: { id: 'p1', title: 'Fixture' } } }, expected: { product: { id: 'p1', title: 'Fixture' } } },
  ])('runs packaged $provider full-schema reads with no source-tree dependencies', fixture => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const fixture = ${JSON.stringify(fixture)};
      const api = require('./bin/' + fixture.helper + '-business-api.cjs');
      global.fetch = async (url, init) => {
        if (url !== fixture.url || init.method !== 'GET') throw new Error('Unexpected wire contract');
        if (fixture.provider === 'walmart' && (init.headers.WM_MARKET !== 'ca' || init.headers.WM_GLOBAL_VERSION !== '3.1' || init.headers['WM_SEC.ACCESS_TOKEN'] !== 'fixture-token')) throw new Error('Unexpected Walmart market authority');
        return new Response(JSON.stringify(fixture.body));
      };
      api.execute({ provider: fixture.provider, metadata: fixture.metadata, credentials: fixture.credentials }, fixture.action, fixture.parameters,
        { token: async () => 'fixture-token', base: () => fixture.base })
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged business validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ data: fixture.expected ?? fixture.body });
  });

  it.each(['qoo10', 'futureshop'])('runs packaged %s native reads through the existing credential owner', helper => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const helper = ${JSON.stringify(helper)};
      const crypto = require('node:crypto');
      require('node:dns').promises.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
      const api = require('./bin/' + helper + '-business-api.cjs');
      const isQoo = helper === 'qoo10';
      const metadata = isQoo ? {} : { api_origin: 'https://fixture-commerce.com' };
      const credentials = isQoo
        ? { provider: 'qoo10_japan', certification_key: 'fixture-qoo-certification', identity: { key_fingerprint: crypto.createHash('sha256').update('fixture-qoo-certification').digest('hex') } }
        : { provider: 'futureshop', client_id: 'fixture-client', client_secret: 'fixture-secret', shop_key: 'fixture-shop', identity: { fingerprint: crypto.createHash('sha256').update(JSON.stringify([metadata.api_origin, 'fixture-client', 'fixture-secret', 'fixture-shop'])).digest('hex') } };
      global.fetch = async (raw, init) => {
        if (isQoo) {
          if (raw !== 'https://api.qoo10.jp/GMKT.INC.Front.QAPIService/ebayjapan.qapi/CommonInfoLookup.SearchBrand' || init.method !== 'POST'
            || init.headers.GiosisCertificationKey !== credentials.certification_key || new URLSearchParams(init.body).get('keyword') !== 'Linen') throw new Error('Unexpected Qoo10 request');
          return new Response(JSON.stringify({ ResultCode: 0, ResultObject: [{ M_B_NO: '123', M_B_NM: 'Linen' }] }));
        }
        if (raw === metadata.api_origin + '/oauth/token' && init.method === 'POST') return new Response(JSON.stringify({ access_token: 'fixture-token', expires_in: 3600 }));
        if (raw !== metadata.api_origin + '/admin-api/v1/products?count=50' || init.method !== 'GET' || init.headers.authorization !== 'Bearer fixture-token') throw new Error('Unexpected futureshop request');
        return new Response(JSON.stringify({ productList: [{ productNo: 'sku-1', name: 'Linen' }] }));
      };
      api.execute({ provider: credentials.provider, metadata, credentials }, isQoo ? 'CommonInfoLookup.SearchBrand' : 'futureshop.products.search', isQoo ? { keyword: 'Linen' } : {})
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged native owner validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject(helper === 'qoo10'
      ? { data: { ResultCode: 0, ResultObject: [{ M_B_NO: '123', M_B_NM: 'Linen' }] } }
      : { data: { productList: [{ productNo: 'sku-1', name: 'Linen' }] }, next_cursor: null });
  });

  it.each(['shopee', 'tiktok-shop', 'yahoo-shopping'])('runs packaged %s native reads with encrypted merchant grants', helper => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const helper = ${JSON.stringify(helper)};
      const crypto = require('node:crypto'), path = require('node:path');
      const codec = require('./bin/local-api-credential-codec.cjs');
      const api = require('./bin/' + helper + '-business-api.cjs');
      const provider = helper === 'tiktok-shop' ? 'tiktok_shop' : helper === 'yahoo-shopping' ? 'yahoo_shopping' : helper;
      const metadata = provider === 'shopee' ? { shop_id: '123', region: 'global', environment: 'live' }
        : provider === 'tiktok_shop' ? { shop_id: '123', region: 'us' } : { seller_id: 'fixture-store' };
      const credentials = { provider, access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_at: Date.now() + 3600000,
        refresh_expires_at: Date.now() + 86400000, ...(provider === 'shopee'
          ? { partner_id: '456', partner_key: 'fixture-partner-key', identity: { binding_shop_id: '123', region: 'global', environment: 'live' } }
          : provider === 'tiktok_shop'
          ? { service_id: '456', app_key: 'fixture-app', app_secret: 'fixture-app-secret', user_type: 0, scopes: ['seller.logistics'],
            identity: { binding_shop_id: '123', region: 'us', shop_id: '123', shop_region: 'US', shop_cipher: 'fixture-cipher' } }
          : { client_id: 'fixture-client', client_secret: 'fixture-client-secret', identity: {
            fingerprint: crypto.createHash('sha256').update(JSON.stringify(['fixture-store', '', 'fixture-client', 'fixture-client-secret', ''])).digest('hex') } }) };
      const credentialFile = path.resolve('native-grant.enc'), credentialKey = crypto.randomBytes(32).toString('base64url');
      codec.writeCredentialFile(credentialFile, credentialKey, credentials);
      let calls = 0;
      global.fetch = async (raw, init) => {
        calls++;
        const url = new URL(raw);
        if (init.method !== 'GET' || init.redirect !== 'error') throw new Error('Unexpected native read transport');
        if (provider === 'shopee') {
          if (url.origin !== 'https://partner.shopeemobile.com' || url.pathname !== '/api/v2/shop/get_shop_info'
            || url.searchParams.get('access_token') !== credentials.access_token || url.searchParams.get('shop_id') !== '123') throw new Error('Unexpected Shopee authority');
          const signature = crypto.createHmac('sha256', credentials.partner_key).update('456' + url.pathname + url.searchParams.get('timestamp') + credentials.access_token + '123').digest('hex');
          if (url.searchParams.get('sign') !== signature) throw new Error('Wrong Shopee signature');
          return new Response(JSON.stringify({ error: '', shop_name: 'Fixture', region: 'SG', merchant_id: null }));
        }
        if (provider === 'tiktok_shop') {
          if (url.origin !== 'https://open-api.tiktokglobalshop.com' || url.pathname !== '/logistics/202309/warehouses'
            || url.searchParams.get('shop_cipher') !== 'fixture-cipher' || init.headers['x-tts-access-token'] !== credentials.access_token) throw new Error('Unexpected TikTok authority');
          const parameters = [...url.searchParams.keys()].filter(key => key !== 'sign' && key !== 'access_token').sort().map(key => key + url.searchParams.get(key)).join('');
          const signature = crypto.createHmac('sha256', credentials.app_secret).update(credentials.app_secret + url.pathname + parameters + credentials.app_secret).digest('hex');
          if (url.searchParams.get('sign') !== signature) throw new Error('Wrong TikTok signature');
          return new Response(JSON.stringify({ code: 0, data: { warehouses: [{ id: '100', name: 'Fixture', type: 'SALES_WAREHOUSE' }] }, request_id: 'fixture' }));
        }
        if (url.origin !== 'https://circus.shopping.yahooapis.jp' || url.pathname !== '/ShoppingWebService/V1/getShopCategory'
          || url.searchParams.get('seller_id') !== 'fixture-store' || init.headers.authorization !== 'Bearer fixture-access') throw new Error('Unexpected Yahoo authority');
        return new Response('<ResultSet totalResultsAvailable="0" totalResultsReturned="0"/>');
      };
      const action = provider === 'shopee' ? 'v2.shop.get_shop_info' : provider === 'tiktok_shop' ? 'tiktok_shop.get_logistics_202309_warehouses' : 'yahoo.v1.getShopCategory';
      api.execute({ provider, metadata, credentials, credentialFile, credentialKey }, action, {})
        .then(result => { if (calls !== 1) throw new Error('Unexpected request count'); process.stdout.write(JSON.stringify(result)); })
        .catch(() => { process.stderr.write('Packaged merchant grant validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject(helper === 'shopee'
      ? { data: { shop_name: 'Fixture', merchant_id: null } }
      : helper === 'tiktok-shop' ? { data: { code: 0, data: { warehouses: [{ id: '100' }] } } }
        : { data: { ResultSet: { '@totalResultsAvailable': '0', '@totalResultsReturned': '0' } } });
  });

  it.each(['douyin', 'aliexpress', 'mercado-libre', 'kuaishou'])('runs packaged %s merchant reads through the shipped adapter dependencies', helper => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const helper = ${JSON.stringify(helper)};
      const crypto = require('node:crypto');
      const adapter = require('./bin/direct-commerce-mcp-server.cjs');
      const api = require('./bin/' + helper + '-business-api.cjs');
      const isDouyin = helper === 'douyin', isAli = helper === 'aliexpress', isKwai = helper === 'kuaishou';
      const provider = isDouyin ? 'douyin_shop' : isAli ? 'aliexpress' : isKwai ? 'kuaishou_shop' : 'mercado_libre';
      const metadata = isDouyin ? { shop_id: '123' } : isAli ? {} : { user_id: '123' };
      const credentials = { provider, app_key: 'fixture-app', app_secret: 'fixture-secret', access_token: 'fixture-token',
        seller_id: '123', ...(isKwai ? { sign_secret: 'fixture-sign', scope: 'merchant_user' } : {}), expires_at: Date.now() + 3600000, refresh_expires_at: Date.now() + 86400000, identity: isKwai ? { shop_id: '123', open_id: 'fixture-seller' } : isDouyin ? { shop_id: '123' } : isAli
          ? { seller_id: '123', shop_id: '456', app_fingerprint: crypto.createHash('sha256').update('fixture-app').digest('hex') }
          : { user_id: '123', site_id: 'CBT' } };
      let calls = 0;
      global.fetch = async (raw, init) => {
        calls++;
        const url = new URL(raw);
        if (init.redirect !== 'error') throw new Error('Unexpected redirect policy');
        if (isKwai) {
          if (url.origin !== 'https://openapi.kwaixiaodian.com' || url.pathname !== '/open/shop/info/get'
            || init.method !== 'GET' || url.searchParams.get('access_token') !== 'fixture-token') throw new Error('Unexpected Kuaishou authority');
          return new Response(JSON.stringify({ result: 1, data: { shopName: 'Fixture shop', shopType: 5 } }));
        }
        if (isDouyin) {
          if (url.origin !== 'https://openapi-fxg.jinritemai.com' || url.pathname !== '/product/detail'
            || init.method !== 'POST' || JSON.parse(init.body).product_id !== '11') throw new Error('Unexpected Douyin request');
          return new Response(JSON.stringify({ code: 10000, data: { product_id: 11, name: 'Fixture' } }));
        }
        if (isAli) {
          const form = new URLSearchParams(init.body);
          if (url.href !== 'https://api-sg.aliexpress.com/sync' || init.method !== 'POST'
            || form.get('method') !== 'aliexpress.category.tree.list' || form.get('category_id') !== '0'
            || form.get('simplify') !== 'true' || form.get('session') !== 'fixture-token') throw new Error('Unexpected AliExpress request');
          return new Response(JSON.stringify({ code: '0', success: true, aeop_post_category_list: [] }));
        }
        if (url.href !== 'https://api.mercadolibre.com/marketplace/orders/search?limit=1' || init.method !== 'GET'
          || init.headers.authorization !== 'Bearer fixture-token') throw new Error('Unexpected Global Selling request');
        return new Response(JSON.stringify({ results: [], paging: { total: 0, limit: 1, offset: 0 } }));
      };
      api.execute({ provider, metadata, credentials }, isDouyin ? 'product.detail' : isAli ? 'aliexpress.category.tree.list' : isKwai ? 'open.shop.info.get' : 'api.get.marketplace.orders.search',
        isDouyin ? { product_id: '11' } : isAli ? { category_id: 0 } : isKwai ? {} : { query: { limit: 1 } },
        { token: async () => 'fixture-token', sign: isKwai ? adapter.signKuaishou : adapter.signDouyin, timestamp: () => '2026-10-01 12:00:00' })
        .then(result => { if (calls !== 1) throw new Error('Unexpected request count'); process.stdout.write(JSON.stringify(result)); })
        .catch(() => { process.stderr.write('Packaged commerce native validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject(helper === 'douyin' ? { data: { data: { product_id: 11 } } }
      : helper === 'aliexpress' ? { data: { aeop_post_category_list: [] } } : helper === 'kuaishou' ? { data: { data: { shopName: 'Fixture shop' } } } : { data: { results: [], paging: { total: 0 } } });
  });

  it('runs a packaged 1688 product read with the bound merchant signature', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const crypto = require('node:crypto');
      const api = require('./bin/alibaba-1688-business-api.cjs');
      const config = { provider: 'alibaba_1688', metadata: {}, credentials: { provider: 'alibaba_1688',
        app_key: 'fixture-app', app_secret: 'fixture-secret', identity: { member_id: 'fixture-seller' } } };
      let calls = 0;
      global.fetch = async (raw, init) => {
        calls++;
        const route = 'param2/1/com.alibaba.product/alibaba.product.get/fixture-app';
        if (raw !== 'https://gw.open.1688.com/openapi/' + route || init.method !== 'POST' || init.redirect !== 'error') throw new Error('Unexpected 1688 authority');
        const form = new URLSearchParams(init.body);
        if (form.get('productID') !== '123' || form.get('access_token') !== 'fixture-token' || form.get('webSite') !== '1688' || form.get('scene') !== '1688') throw new Error('Unexpected 1688 parameters');
        const message = route + [...form.keys()].filter(k => k !== '_aop_signature').sort().map(k => k + form.get(k)).join('');
        const signature = crypto.createHmac('sha1', 'fixture-secret').update(message).digest('hex').toUpperCase();
        if (form.get('_aop_signature') !== signature) throw new Error('Unexpected 1688 signature');
        return new Response(JSON.stringify({ productInfo: { productID: 123, subject: 'Fixture' } }));
      };
      api.execute(config, 'api.com.alibaba.product.alibaba.product.get.v1', { productID: '123' }, { token: async () => 'fixture-token' })
        .then(result => { if (calls !== 1) throw new Error('Unexpected request count'); process.stdout.write(JSON.stringify(result)); })
        .catch(() => { process.stderr.write('Packaged 1688 validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { productInfo: { productID: 123, subject: 'Fixture' } } });
  });

  it('runs a packaged Youzan shop read with the declared shop type', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const api = require('./bin/youzan-business-api.cjs');
      const config = { provider: 'youzan', metadata: { kdt_id: '123' }, credentials: {
        client_secret: 'fixture-secret', identity: { kdt_id: '123', type: 0 } } };
      let calls = 0;
      global.fetch = async (raw, init) => {
        calls++;
        const url = new URL(raw);
        if (url.origin !== 'https://open.youzanyun.com' || url.pathname !== '/api/youzan.shop.get/3.0.0'
          || url.searchParams.get('access_token') !== 'fixture-token' || init.method !== 'POST'
          || init.redirect !== 'error' || init.body !== '{}') throw new Error('Unexpected Youzan authority');
        return new Response(JSON.stringify({ code: 200, success: true, data: { id: 123, name: 'Fixture', type: 0 } }));
      };
      api.execute(config, 'youzan.shop.get.v3_0_0', {}, { token: async () => 'fixture-token' })
        .then(result => { if (calls !== 1) throw new Error('Unexpected request count'); process.stdout.write(JSON.stringify(result)); })
        .catch(() => { process.stderr.write('Packaged Youzan validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { code: 200, success: true, data: { id: 123, name: 'Fixture', type: 0 } } });
  });

  it.each(['jd_jos', 'taobao_top', 'weimob_wos'])('executes packaged %s native reads with the encrypted credential owner', provider => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const crypto = require('node:crypto');
      const path = require('node:path');
      const adapter = require('./bin/direct-commerce-mcp-server.cjs');
      const codec = require('./bin/local-api-credential-codec.cjs');
      const provider = ${JSON.stringify(provider)};
      const isJd = provider === 'jd_jos', isTop = provider === 'taobao_top';
      const credentials = { provider, app_key: 'fixture-app', app_secret: 'fixture-secret',
        client_id: 'fixture-client', client_secret: 'fixture-client-secret', access_token: 'fixture-token',
        refresh_token: 'fixture-refresh', expires_at: Date.now() + 3600000,
        identity: isJd ? { vender_id: '123', shop_id: '456' } : isTop ? { user_id: '123', nick: 'Fixture seller', seller_type: 'C' }
          : { business_operation_system_id: '123' } };
      const key = crypto.randomBytes(32).toString('base64url'), file = path.join(process.cwd(), 'fixture.enc');
      codec.writeCredentialFile(file, key, credentials);
      const env = { ORKAS_LOCAL_API_PROVIDER: provider, ORKAS_LOCAL_API_CREDENTIAL_FILE: file,
        ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: JSON.stringify(isJd || isTop ? {} : { shop_id: '123', shop_type: 'business_operation_system_id' }) };
      let calls = 0;
      global.fetch = async (raw, init) => {
        calls++;
        const url = new URL(raw), form = new URLSearchParams(init.body);
        if (init.method !== 'POST' || init.redirect !== (isTop ? 'manual' : 'error')) throw new Error('Unexpected transport');
        if (isJd) {
          if (url.href !== 'https://api.jd.com/routerjson' || form.get('method') !== 'jingdong.sku.read.findSkuById'
            || form.get('360buy_param_json') !== '{"skuId":9007199254740993}' || form.get('access_token') !== 'fixture-token') throw new Error('Unexpected JD request');
          return new Response('{"jingdong_sku_read_findSkuById_responce":{"sku":{"skuId":9007199254740993,"wareId":123,"skuName":"Fixture"}}}');
        }
        if (isTop) {
          if (url.href !== 'https://gw.api.taobao.com/router/rest' || form.get('method') !== 'taobao.user.seller.get'
            || form.get('session') !== 'fixture-token' || form.get('fields') !== 'nick,user_id') throw new Error('Unexpected TOP request');
          return new Response('{"user_seller_get_response":{"user":{"user_id":123,"nick":"Fixture seller"}}}');
        }
        if (url.origin !== 'https://dopen.weimob.com' || url.pathname !== '/apigw/bos/v2.0/info/get'
          || url.searchParams.get('accesstoken') !== 'fixture-token' || init.body !== '{}') throw new Error('Unexpected Weimob request');
        return new Response('{"code":{"errcode":"0","errmsg":"success"},"data":{"bosId":123,"bosName":"Fixture"}}');
      };
      adapter.callTool('execute_read', { action: isJd ? 'api.jingdong.sku.read.findSkuById' : isTop ? 'taobao.user.seller.get' : 'bos.info.get',
        parameters: isJd ? { skuId: '9007199254740993' } : isTop ? { fields: ['nick'] } : {} }, env)
        .then(result => { if (calls !== 1) throw new Error('Unexpected request count'); process.stdout.write(JSON.stringify(result)); })
        .catch(() => { process.stderr.write('Packaged merchant read failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ provider, result: { data: provider === 'jd_jos'
      ? { jingdong_sku_read_findSkuById_responce: { sku: { skuId: '9007199254740993' } } }
      : provider === 'taobao_top' ? { user_seller_get_response: { user: { user_id: 123, nick: 'Fixture seller' } } }
        : { code: { errcode: '0' }, data: { bosId: 123, bosName: 'Fixture' } } } });
  });

  it('executes packaged ICBU discovery and a native read through its existing merchant owner', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const crypto = require('node:crypto'), path = require('node:path');
      const adapter = require('./bin/direct-commerce-mcp-server.cjs');
      const codec = require('./bin/local-api-credential-codec.cjs');
      const key = crypto.randomBytes(32).toString('base64url'), file = path.join(process.cwd(), 'icbu.enc');
      const credentials = { provider: 'alibaba_icbu', app_key: 'fixture-app', app_secret: 'fixture-secret',
        access_token: 'fixture-token', refresh_token: 'fixture-refresh', expires_at: Date.now() + 3600000,
        refresh_expires_at: Date.now() + 86400000,
        identity: { account_id: '123', app_fingerprint: crypto.createHash('sha256').update('fixture-app').digest('hex') } };
      codec.writeCredentialFile(file, key, credentials);
      const env = { ORKAS_LOCAL_API_PROVIDER: 'alibaba_icbu', ORKAS_LOCAL_API_CREDENTIAL_FILE: file,
        ORKAS_LOCAL_API_CREDENTIAL_KEY: key, ORKAS_LOCAL_API_METADATA_JSON: '{}' };
      let calls = 0;
      global.fetch = async (raw, init) => {
        calls++;
        const form = new URLSearchParams(init.body);
        if (String(raw) !== 'https://eco.taobao.com/router/rest' || init.method !== 'POST'
          || form.get('method') !== 'alibaba.icbu.product.list' || form.get('session') !== 'fixture-token'
          || form.get('language') !== 'ENGLISH' || form.get('page_size') !== '1'
          || form.get('sign_method') !== 'hmac') throw new Error('Unexpected ICBU request');
        return new Response(JSON.stringify({ alibaba_icbu_product_list_response: { total_item: 1,
          products: { alibaba_product_brief_response: [{ product_id: 'opaque', id: 1, subject: 'Fixture' }] } } }));
      };
      adapter.callTool('execute_read', { action: 'alibaba.icbu.product.list', parameters: { language: 'ENGLISH', page_size: 1 } }, env)
        .then(result => { if(calls !== 1) throw new Error('Unexpected request count'); process.stdout.write(JSON.stringify(result)); })
        .catch(() => { process.stderr.write('Packaged ICBU read failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({ provider: 'alibaba_icbu', result: { data: {
      alibaba_icbu_product_list_response: { products: { alibaba_product_brief_response: [{ product_id: 'opaque', subject: 'Fixture' }] } },
    } } });
  });

  it('runs a packaged Shopify typed selection without exposing arbitrary GraphQL', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const api = require('./bin/shopify-business-api.cjs');
      global.fetch = async (raw, init) => {
        if (raw !== 'https://fixture.myshopify.com/admin/api/2026-07/graphql.json' || init.method !== 'POST') throw new Error('Unexpected wire authority');
        if (JSON.parse(init.body).query !== 'query{shop{id name}}') throw new Error('Unexpected typed selection');
        return new Response(JSON.stringify({ data: { shop: { id: 'gid://shopify/Shop/1', name: 'Fixture' } } }));
      };
      api.execute({ provider: 'shopify', metadata: { shop_domain: 'fixture.myshopify.com' }, credentials: {} }, 'shop',
        { selection: [{ field: 'id' }, { field: 'name' }] }, { token: async () => 'fixture-token' })
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged Shopify validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: { shop: { id: 'gid://shopify/Shop/1', name: 'Fixture' } } });
  });

  it('runs packaged SHOPLINE typed GraphQL discovery and a read with flattened dependencies', () => {
    const pcRoot = packagedRuntimeFixture();
    const source = `
      const api = require('./bin/shopline-graphql-api.cjs');
      const type = api.describeOutputType('GRAPHQL shop', 'Shop');
      if (!type.fields.name) throw new Error('Missing output field');
      global.fetch = async (url, init) => {
        if (url !== 'https://fixture.myshopline.com/admin/graph/v20260901/graphql.json' || init.method !== 'POST') throw new Error('Unexpected authority');
        if (JSON.parse(init.body).query !== 'query{shop{id name}}') throw new Error('Unexpected selection');
        return new Response(JSON.stringify({ data: { shop: { id: 'shop-1', name: 'Fixture' } } }));
      };
      api.execute({ provider: 'shopline', metadata: { store_domain: 'fixture.myshopline.com' }, credentials: { provider: 'shopline', access_token: 'fixture-token', identity: { binding: 'fixture.myshopline.com', shop_id: 'shop-1' } } }, 'GRAPHQL shop',
        { selection: [{ field: 'id' }, { field: 'name' }] })
        .then(result => process.stdout.write(JSON.stringify(result)))
        .catch(() => { process.stderr.write('Packaged GraphQL validation failed'); process.exitCode = 1; });
    `;
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.NODE_PATH; delete env.NODE_OPTIONS;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: pcRoot, env, encoding: 'utf8', timeout: 10000 });
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ data: { shop: { id: 'shop-1', name: 'Fixture' } } });
  });

  it('rejects a missing shared Shopify scope module in the packaged payload and real adapter startup', () => {
    const pcRoot = packagedRuntimeFixture();
    fs.rmSync(path.join(pcRoot, 'bin', 'shopify-setup-requirements.cjs'));
    expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toThrow(/missing: shopify-setup-requirements\.cjs/);
    expect(() => gate.verifyPackagedConnectorRuntime(pcRoot))
      .toThrow(/connector smoke failed for direct bin\/direct-commerce-mcp-server\.cjs.*shopify-setup-requirements/s);
  });

  it('rejects an incomplete MCP runtime dependency closure', () => {
    const pcRoot = packagedFixture();
    fs.rmSync(path.join(
      pcRoot,
      'node_modules',
      '@modelcontextprotocol',
      'sdk',
      'dist',
      'cjs',
      'server',
      'index.js',
    ));

    expect(() => gate.verifyPackagedEntrypointPayload(pcRoot, { projectRoot: process.cwd() }))
      .toThrow(/missing @modelcontextprotocol\/sdk runtime dist\/cjs\/server\/index\.js/);
  });

  it('initializes every packaged connector over direct and explicit-proxy stdio', () => {
    const pcRoot = packagedRuntimeFixture();

    expect(gate.verifyPackagedConnectorRuntime(pcRoot))
      .toEqual(gate.requiredPackagedConnectorSmokeEntries());
    expect(gate.requiredPackagedConnectorSmokeEntries()).toHaveLength(
      gate.CONNECTOR_RUNTIME_ENTRYPOINTS.length * gate.CONNECTOR_RUNTIME_SMOKE_PROFILES.length,
    );
  }, 60_000);

  it('reproduces the 1.6.2 failure when the packaged MCP SDK is absent', () => {
    const pcRoot = packagedRuntimeFixture();
    fs.rmSync(path.join(pcRoot, 'node_modules', '@modelcontextprotocol', 'sdk'), {
      recursive: true,
      force: true,
    });

    expect(() => gate.verifyPackagedConnectorRuntime(pcRoot))
      .toThrow(/connector smoke failed for direct bin\/[a-z-]+-mcp-server\.cjs.*@modelcontextprotocol\/sdk/s);
  });

  it('loads the explicit-proxy-only runtime instead of accepting a direct-mode false green', () => {
    const pcRoot = packagedRuntimeFixture();
    fs.rmSync(path.join(pcRoot, 'node_modules', 'undici'), { recursive: true, force: true });

    expect(() => gate.verifyPackagedConnectorRuntime(pcRoot))
      .toThrow(/connector smoke failed for env-proxy bin\/[a-z-]+-mcp-server\.cjs.*undici/s);
  });

  it('rejects a future connector import even before it is added to the manual package list', () => {
    const pcRoot = packagedRuntimeFixture();
    const entry = path.join(pcRoot, 'bin', 'bing-webmaster-mcp-server.cjs');
    const source = fs.readFileSync(entry, 'utf8');
    const shebangEnd = source.indexOf('\n') + 1;
    fs.writeFileSync(
      entry,
      `${source.slice(0, shebangEnd)}require('future-connector-runtime');\n${source.slice(shebangEnd)}`,
    );

    expect(() => gate.verifyPackagedConnectorRuntime(pcRoot))
      .toThrow(/connector smoke failed for direct bin\/[a-z-]+-mcp-server\.cjs.*future-connector-runtime/s);
  });

  it('rejects startup logs that corrupt the connector JSON-RPC stdout channel', () => {
    const pcRoot = packagedRuntimeFixture();
    const entry = path.join(pcRoot, 'bin', 'bing-webmaster-mcp-server.cjs');
    const source = fs.readFileSync(entry, 'utf8');
    const shebangEnd = source.indexOf('\n') + 1;
    fs.writeFileSync(
      entry,
      `${source.slice(0, shebangEnd)}process.stdout.write('unexpected startup log\\n');\n${source.slice(shebangEnd)}`,
    );

    expect(() => gate.verifyPackagedConnectorRuntime(pcRoot))
      .toThrow(/connector smoke produced invalid stdio for direct bin\/bing-webmaster-mcp-server\.cjs/);
  });
});
