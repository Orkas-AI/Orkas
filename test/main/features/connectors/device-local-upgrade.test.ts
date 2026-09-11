/** Upgrade contract: real migration, manager bootstrap and card rendering; only the
 * external MCP process/runtime is stubbed. Live provider consent remains a manual canary. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vm from 'node:vm';

const probe = vi.hoisted(() => ({ connect: vi.fn(), listTools: vi.fn(), transports: [] as any[] }));
vi.mock('../../../../src/main/features/connectors/mcp-client', () => ({
  McpConnection: class {
    constructor(_id: string, transport: unknown) { probe.transports.push(transport); }
    connect() { return probe.connect(); }
    listTools() { return probe.listTools(); }
    async close() {}
    get isConnected() { return true; }
  },
}));
vi.mock('../../../../src/main/util/bundled-runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/util/bundled-runtime')>(),
  bundledNodeExecutable: () => '/test-runtime/node',
  bundledNpxCli: () => '/test-runtime/npx-cli.js',
}));

const uid = 'cli-upgrade-account';
let root: string;
let priorRoot: string | undefined;
let manager: typeof import('../../../../src/main/features/connectors/manager') | undefined;
const tools = [{ name: 'execute_read', description: 'Read authorized documents', input_schema: { type: 'object' } }];
const renderer = fs.readFileSync(path.join(__dirname, '../../../../src/renderer/modules/connectors.js'), 'utf8');
const locale = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../../src/renderer/locales/zh.json'), 'utf8'));

function card(entry: unknown, instances: unknown[]) {
  const context: any = {
    console, __entry: entry, __instances: instances,
    createLogger: () => ({ info() {}, warn() {}, error() {} }),
    t: (key: string) => locale[key] || key,
    getLang: () => 'zh', sanitizeSvgIconHtml: () => '',
    formatChatUseLabel: ({ name }: { name: string }) => name,
    document: { createElement: () => {
      const fields = new Map();
      return {
        innerHTML: '', dataset: {},
        querySelector(selector: string) {
          if (!this.innerHTML.includes(`class="${selector.slice(1)}`)) return null;
          if (!fields.has(selector)) fields.set(selector, { textContent: '', title: '' });
          return fields.get(selector);
        },
        querySelectorAll: () => [],
      };
    } },
    window: { addEventListener() {}, orkas: { onPushEvent() {} } },
  };
  vm.createContext(context);
  vm.runInContext(renderer, context, { filename: 'connectors.js' });
  vm.runInContext('_connectorsState.instances = __instances', context);
  const rendered = vm.runInContext('_renderCatalogCard(__entry, __instances[0] || null)', context);
  return {
    html: rendered.innerHTML as string,
    error: rendered.querySelector('.connector-card-error')?.textContent || '',
    live: context.isConnectorLive('feishu') as boolean,
  };
}

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

async function setup(installed: boolean, status = 'error') {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(uid);
  const paths = await import('../../../../src/main/paths');
  const { findCatalogEntry } = await import('../../../../src/main/features/connectors/catalog');
  const entry = findCatalogEntry('feishu')!;
  const cloud = paths.userConnectorsConfigFile(uid);
  const old = {
    id: 'feishu', display_name: 'Feishu',
    status: status === 'error' ? { kind: 'error', message: 'transport unresolved', at: 1 } : { kind: 'connected', since: 1 },
    auth_error: { message: 'foreign authorization error', at: 1 },
    transport: { kind: 'stdio', command: '/other-device/node', args: ['/other-device/adapter.cjs'] },
    tools_cache: [{ name: 'foreign_tool' }], tools_cached_at: Date.now(), enabled_subtools: ['execute_read'],
    created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-09T00:00:00Z',
  };
  write(cloud, { version: 2, connections: { feishu: old } });
  const runtime = path.join(paths.userLocalConfigDir(uid), 'connector-cli', entry.id);
  if (installed) {
    const pin = entry.local_cli!;
    write(path.join(runtime, '.orkas-cli-integrity.json'), {
      package: `${pin.package_name}@${pin.package_version}`, integrity: pin.package_integrity,
    });
    // Opaque provider-owned file: migration and status verification must not rewrite it.
    write(path.join(runtime, 'provider-state.json'), { fixture: 'existing-device-authorization' });
  }
  manager = await import('../../../../src/main/features/connectors/manager');
  return { entry, old, cloud, runtime, paths, users, feature: manager };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-upgrade-'));
  priorRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  probe.transports.length = 0;
  probe.connect.mockReset().mockResolvedValue(undefined);
  probe.listTools.mockReset().mockResolvedValue(tools);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected external request'); }));
});
afterEach(async () => {
  await manager?.shutdownAll();
  manager = undefined;
  vi.unstubAllGlobals();
  if (priorRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = priorRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('CLI upgrade visible outcomes', () => {
  it.each(['error', 'connected'])('replaces a foreign %s row with an available card without starting a CLI', async (status) => {
    const { entry, old, cloud, runtime, feature } = await setup(false, status);
    // Negative control reproduces the pre-upgrade visible failure from a foreign row.
    if (status === 'error') expect(card(entry, [old]).error).toContain('连接未完成');
    await feature.bootstrap(uid);
    const instances = feature.listInstances(uid);
    expect(instances).toEqual([]);
    const visible = card(entry, instances);
    expect(visible.error).toBe('');
    expect(visible.live).toBe(false);
    expect(visible.html).toContain('data-act="connect"');
    expect(visible.html).not.toContain('data-act="use-connector"');
    expect(probe.connect).not.toHaveBeenCalled();
    expect(fs.existsSync(runtime)).toBe(false);
    expect(JSON.parse(fs.readFileSync(cloud, 'utf8')).connections.feishu).toBeUndefined();
    await feature.shutdownAll();
    await feature.bootstrap(uid);
    expect(feature.listInstances(uid)).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('clears an inherited error only after this device verifies, and survives restart and account switching', async () => {
    const { entry, cloud, runtime, feature, paths, users } = await setup(true);
    const providerFile = path.join(runtime, 'provider-state.json');
    const providerBefore = fs.readFileSync(providerFile, 'utf8');
    let completeProbe!: () => void;
    probe.listTools.mockImplementationOnce(() => new Promise((resolve) => { completeProbe = () => resolve(tools); }));
    const boot = feature.bootstrap(uid);
    try {
      await vi.waitFor(() => expect(probe.listTools).toHaveBeenCalled());
      const pending = feature.listInstances(uid);
      expect(pending[0].status.kind).toBe('connecting');
      expect(card(entry, pending).error).toBe('');
      expect(card(entry, pending).live).toBe(false);
    } finally { completeProbe?.(); await boot; }
    const instances = feature.listInstances(uid);
    expect(instances[0]).toMatchObject({ status: { kind: 'connected' }, enabled_subtools: ['execute_read'], tools_cache: tools });
    expect(instances[0].auth_error).toBeUndefined();
    expect(card(entry, instances)).toMatchObject({ error: '', live: true });
    expect(card(entry, instances).html).toContain('data-act="use-connector"');
    expect(probe.transports[0].cwd).toBe(runtime);
    expect(JSON.stringify(probe.transports)).not.toContain('/other-device/');
    expect(fs.readFileSync(providerFile, 'utf8')).toBe(providerBefore);
    expect(JSON.parse(fs.readFileSync(cloud, 'utf8')).connections.feishu).toBeUndefined();
    await feature.shutdownAll();
    await feature.bootstrap(uid);
    expect(card(entry, feature.listInstances(uid)).live).toBe(true);
    const localBefore = fs.readFileSync(paths.userDeviceConnectorsConfigFile(uid), 'utf8');
    users.activateUser('other-account');
    await feature.bootstrap('other-account');
    expect(card(entry, feature.listInstances('other-account'))).toMatchObject({ error: '', live: false });
    users.activateUser(uid);
    await feature.bootstrap(uid);
    expect(card(entry, feature.listInstances(uid)).live).toBe(true);
    expect(fs.readFileSync(paths.userDeviceConnectorsConfigFile(uid), 'utf8')).toBe(localBefore);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps a real device authorization failure visible and clears it after authorization is restored and rechecked', async () => {
    const { entry, cloud, feature } = await setup(true);
    probe.listTools.mockRejectedValueOnce(new Error('official lark-cli account is not authorized; reconnect this connector'));
    await feature.bootstrap(uid);
    const failed = feature.listInstances(uid);
    expect(failed[0].status.kind).toBe('error');
    expect(card(entry, failed).live).toBe(false);
    expect(card(entry, failed).error).toContain('异常');
    expect(card(entry, failed).html).toContain('data-act="connect"');
    expect(card(entry, failed).html).not.toContain('data-act="use-connector"');
    expect(JSON.parse(fs.readFileSync(cloud, 'utf8')).connections.feishu).toBeUndefined();
    await feature.refreshTools(uid, 'feishu');
    expect(card(entry, feature.listInstances(uid))).toMatchObject({ error: '', live: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});
