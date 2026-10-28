import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

const wire = vi.hoisted(() => ({ postJson: vi.fn(), bootWarn: vi.fn() }));
vi.mock('../../../src/main/features/marketplace', () => ({ postJson: wire.postJson }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: wire.bootWarn, error: vi.fn() }) }));
import * as boot from '../../../src/main/util/boot_init';
import { createMarketplaceCatalogReader } from '../../../src/main/features/marketplace_catalog';

// Execute the actual entry functions and actual boot admission queue, without
// importing the Electron entry module (which would open unrelated services).
const source = fs.readFileSync(path.resolve(__dirname, '../../../src/main/index.ts'), 'utf8');
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['clearMarketplaceDefaultsRetry', 'scheduleMarketplaceDefaultsRetry', 'runMarketplaceInstallReconcile', 'broadcastBuiltinMarketplaceSeedChanged']);
const declarations = parsed.statements.flatMap(node => {
  if (ts.isFunctionDeclaration(node) && names.has(node.name?.text || '')) return [node.getText(parsed)];
  if (ts.isVariableStatement(node)) {
    const selected = node.declarationList.declarations.filter(declaration => ts.isIdentifier(declaration.name)
      && /^marketplace(?:ReconcileInFlight|DefaultsRetry)/.test(declaration.name.text));
    return selected.map(declaration => `let ${declaration.getText(parsed)};`);
  }
  return [];
});
let registration = '';
function findRegistration(node: ts.Node): void {
  if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'registerDeferred'
      && node.arguments[0]?.getText(parsed) === "'marketplace:reconcile'") registration = node.getText(parsed);
  ts.forEachChild(node, findRegistration);
}
findRegistration(parsed);
if (!registration || declarations.length < 6) throw new Error('Marketplace startup entries are missing');
const compiled = ts.transpileModule(`${declarations.join('\n')}\nexports.run = runMarketplaceInstallReconcile;\nexports.retry = scheduleMarketplaceDefaultsRetry;\nexports.registerStartup = () => { ${registration}; };\nexports.publishBuiltin = broadcastBuiltinMarketplaceSeedChanged;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

type Options = { shouldContinue: () => boolean; catalogReader?: ReturnType<typeof createMarketplaceCatalogReader> };
function harness(catalog = false, retryDelayMs = 3_000) {
  const events: string[] = [];
  const readers: unknown[] = [];
  let active = true;
  const controller = new AbortController();
  const warn = vi.fn();
  const broadcast = vi.fn();
  const status = vi.fn();
  const seed = vi.fn(async () => { events.push('seed'); });
  const resolve = vi.fn(async (_uid: string, opts: Options) => {
    expect(opts.shouldContinue()).toBe(true);
    events.push('resolve');
    if (catalog) {
      const reader = opts.catalogReader || createMarketplaceCatalogReader(opts.shouldContinue);
      readers.push(reader);
      await reader.read('agents', ['installed-agent']);
    }
  });
  const defaults = vi.fn(async (): Promise<{ failed?: boolean; error?: string }> => { events.push('defaults'); return {}; });
  const check = vi.fn(async (_uid: string, opts: Options) => {
    events.push('catalog');
    if (catalog) {
      const reader = opts.catalogReader || createMarketplaceCatalogReader(opts.shouldContinue);
      readers.push(reader);
      await reader.read('agents', ['installed-agent']);
    }
  });
  const download = vi.fn(async () => { events.push('download'); return {}; });
  const repair = vi.fn(async () => { events.push('repair'); return 0; });
  const schedule = vi.fn(boot.scheduleBootBackground);
  const modules: Record<string, unknown> = {
    './features/builtin_marketplace': { resolveBuiltinMarketplaceInstalls: resolve },
    './features/marketplace': { hasKnownDefaultInstallWork: async () => true, ensureDefaultInstalls: defaults },
    './features/marketplace_reconcile': { setDefaultInstallSeedStatus: status, checkServerUpdatesForInstalls: check, reconcileInstalls: download },
    './features/skills': { repairLegacySkillEnabledIdsForActiveUser: repair },
  };
  const context = {
    exports: {} as { run: (reason: string, signal?: AbortSignal) => Promise<void>; retry: (key: string, uid: string, error: string) => void; registerStartup: () => void; publishBuiltin: (result: Record<string, number>) => void },
    require: (name: string) => {
      if (!(name in modules)) throw new Error(`Unexpected startup dependency: ${name}`);
      return modules[name];
    },
    setTimeout, clearTimeout, Date,
    ipc: { broadcastToRenderer: broadcast },
    users: { getActiveUserId: () => 'fixture-user' },
    marketplaceBootContextStillActive: () => active,
    marketplaceBootLog: { info: vi.fn(), warn },
    logErrorSummary: () => ({ name: 'Error' }),
    subscribeMarketplaceReconcileStatus: vi.fn(),
    seedBuiltinMarketplaceForCurrentUser: seed,
    scheduleBootBackground: schedule,
    registerDeferred: boot.registerDeferred,
    createMarketplaceCatalogReader,
    MARKETPLACE_DEFAULTS_RETRY_DELAYS_MS: [retryDelayMs, retryDelayMs, retryDelayMs],
    MARKETPLACE_DEFAULTS_REFRESH_INTERVAL_MS: 60_000,
    MARKETPLACE_SERVER_CHECK_INTERVAL_MS: 60_000,
  };
  vm.runInNewContext(compiled, context);
  return { ...context.exports, events, readers, seed, resolve, defaults, check, download, repair, schedule, controller, warn, status, broadcast, deactivate: () => { active = false; } };
}
async function settle(work: Promise<void>): Promise<void> { await vi.runAllTimersAsync(); await work; }
beforeEach(async () => {
  vi.useFakeTimers();
  boot._resetForTests();
  wire.bootWarn.mockClear();
  wire.postJson.mockReset().mockResolvedValue({ list: [{ id: 'installed-agent', version: '1' }] });
  await vi.advanceTimersByTimeAsync(2_000);
});
afterEach(() => { boot._resetForTests(); vi.useRealTimers(); expect(wire.bootWarn).not.toHaveBeenCalled(); });

describe('open-source startup marketplace resolution', () => {
  it('resolves seeded installs before versions, downloads and local enabled-state repair', async () => {
    const h = harness();
    await settle(h.run('startup'));
    expect(h.events).toEqual(['seed', 'resolve', 'defaults', 'catalog', 'download', 'repair']);
    expect(h.resolve).toHaveBeenCalledExactlyOnceWith('fixture-user', expect.objectContaining({ shouldContinue: expect.any(Function) }));
    expect(h.status.mock.calls.map(call => call[0])).toEqual([true, false]);
    expect(h.warn).not.toHaveBeenCalled();
    expect(wire.bootWarn).not.toHaveBeenCalled();
  });
  it('allows reconcile to recover unresolved URLs when lookup fails', async () => {
    const h = harness();
    h.resolve.mockRejectedValueOnce(new Error('Fixture lookup failure'));
    await settle(h.run('startup'));
    expect(h.events).toEqual(['seed', 'defaults', 'catalog', 'download', 'repair']);
    expect(h.warn).toHaveBeenCalledExactlyOnceWith('builtin marketplace resolve failed', { error: { name: 'Error' } });
    h.warn.mockClear(); h.events.length = 0;
    await settle(h.run('marketplace-defaults-retry'));
    expect(h.events).toEqual(['seed', 'resolve', 'defaults', 'catalog', 'download', 'repair']);
    expect(h.warn).not.toHaveBeenCalled();
  });
  it('clears progress after the active local user changes during resolution', async () => {
    const h = harness();
    h.resolve.mockImplementationOnce(async () => { h.events.push('resolve'); h.deactivate(); });
    await settle(h.run('startup'));
    expect(h.events).toEqual(['seed', 'resolve']);
    expect(h.status.mock.calls.map(call => call[0])).toEqual([true, false]);
    expect(h.warn).not.toHaveBeenCalled();
  });
  it('shares one real catalog snapshot per pass and refreshes it on the next pass', async () => {
    const h = harness(true);
    await settle(h.run('startup'));
    expect(wire.postJson).toHaveBeenCalledTimes(1);
    expect(h.readers[0]).toBe(h.readers[1]);
    await settle(h.run('manual-refresh'));
    expect(wire.postJson).toHaveBeenCalledTimes(2);
    expect(h.readers[2]).toBe(h.readers[3]);
    expect(h.readers[0]).not.toBe(h.readers[2]);
  });
  it('does not start a queued retry after boot shutdown', async () => {
    const h = harness();
    h.retry('fixture-user', 'fixture-user', 'Fixture unavailable');
    boot.stopBootWork();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.events).toEqual([]);
    expect(h.warn).not.toHaveBeenCalled();
  });
  it.each(['seed', 'resolve', 'defaults', 'catalog'] as const)('stops after cancellation during %s without retry or later writes', async phase => {
    const h = harness();
    const abort = async () => { h.events.push(phase); h.controller.abort(); };
    if (phase === 'seed') h.seed.mockImplementationOnce(abort);
    if (phase === 'resolve') h.resolve.mockImplementationOnce(abort);
    if (phase === 'defaults') h.defaults.mockImplementationOnce(async () => { await abort(); return { failed: true, error: 'Fixture cancelled' }; });
    if (phase === 'catalog') h.check.mockImplementationOnce(abort);
    await settle(h.run('startup', h.controller.signal));
    const ordered = ['seed', 'resolve', 'defaults', 'catalog'];
    expect(h.events).toEqual(ordered.slice(0, ordered.indexOf(phase) + 1));
    expect(h.download).not.toHaveBeenCalled();
    expect(h.repair).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });
  it('passes the actual deferred registration lifetime through to active lookup', async () => {
    const h = harness();
    h.resolve.mockImplementationOnce(async () => { h.events.push('resolve'); boot.stopBootWork(); });
    h.registerStartup();
    await boot.runBootPhases(0);
    await vi.runAllTimersAsync();
    expect(h.events).toEqual(['seed', 'resolve']);
    expect(h.status.mock.calls.map(call => call[0])).toEqual([true, false]);
  });
  it('drains active lookup before settling cancellation and releases disk during network wait', async () => {
    const h = harness();
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    h.resolve.mockImplementationOnce(async () => { h.events.push('resolve'); await held; });
    let ended = false;
    const work = h.run('startup', h.controller.signal).then(() => { ended = true; });
    try {
      await vi.advanceTimersByTimeAsync(10);
      expect(h.events).toEqual(['seed', 'resolve']);
      let diskFinished = false;
      const disk = boot.scheduleBootBackground('fixture-local-work', () => { diskFinished = true; }, 0, { resourceClass: 'disk' });
      await vi.advanceTimersByTimeAsync(10);
      expect(diskFinished).toBe(true);
      await disk.promise;
      expect(h.schedule.mock.calls.map(call => call[3]?.resourceClass)).toEqual(['disk', 'network']);
      h.controller.abort();
      await vi.advanceTimersByTimeAsync(10);
      expect(ended).toBe(false);
    } finally { release(); await settle(work); }
    expect(h.events).toEqual(['seed', 'resolve']);
    expect(h.warn).not.toHaveBeenCalled();
  });
  it('drains an overlapping pass before executing a fresh defaults retry', async () => {
    const h = harness(false, 30);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    h.defaults.mockResolvedValueOnce({ failed: true, error: 'Fixture unavailable' });
    h.check.mockImplementationOnce(async () => { h.events.push('catalog'); await held; });
    const work = h.run('startup');
    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(h.defaults).toHaveBeenCalledTimes(1);
    } finally { release(); await settle(work); }
    expect(h.defaults).toHaveBeenCalledTimes(2);
    expect(h.download).toHaveBeenCalledTimes(2);
    expect(h.repair).toHaveBeenCalledTimes(2);
    expect(h.warn).not.toHaveBeenCalled();
  });
  it('does not seed or open a catalog when its startup lifetime is already cancelled', async () => {
    const h = harness();
    h.controller.abort();
    await settle(h.run('startup', h.controller.signal));
    expect(h.events).toEqual([]);
    expect(h.status).not.toHaveBeenCalled();
  });
  it('keeps local repair reachable after a catalog update failure', async () => {
    const h = harness();
    h.check.mockRejectedValueOnce(new Error('Fixture update failure'));
    await settle(h.run('startup'));
    expect(h.events).toEqual(['seed', 'resolve', 'defaults', 'download', 'repair']);
    expect(h.warn).toHaveBeenCalledExactlyOnceWith('marketplace update check failed', { reason: 'startup', error: { name: 'Error' } });
    expect(h.status.mock.calls.map(call => call[0])).toEqual([true, false]);
  });
  it('isolates local repair failures and retries the repair on a later pass', async () => {
    const h = harness();
    h.repair.mockRejectedValueOnce(new Error('Fixture read failure'));
    await settle(h.run('startup'));
    expect(h.warn).toHaveBeenCalledExactlyOnceWith('legacy skill enabled-state repair failed', { error: { name: 'Error' } });
    expect(h.status.mock.calls.map(call => call[0])).toEqual([true, false]);
    h.warn.mockClear();
    await settle(h.run('manual-refresh'));
    expect(h.repair).toHaveBeenCalledTimes(2);
    expect(h.warn).not.toHaveBeenCalled();
  });
  it.each(['pruned_agents', 'pruned_skills', 'restored_agents', 'restored_skills', 'patched_agents', 'patched_skills'])('publishes local content changes for %s without a download', async field => {
    const h = harness();
    h.download.mockResolvedValueOnce({ [field]: 1 });
    await settle(h.run('startup'));
    expect(h.broadcast).toHaveBeenCalledExactlyOnceWith('marketplace:content-changed', {});
  });
  it('publishes one content change for a download and none for a no-op', async () => {
    const h = harness();
    await settle(h.run('startup'));
    expect(h.broadcast).not.toHaveBeenCalled();
    h.download.mockResolvedValueOnce({ pulled_agents: 1, patched_skills: 1 });
    await settle(h.run('manual-refresh'));
    expect(h.broadcast).toHaveBeenCalledExactlyOnceWith('marketplace:content-changed', {});
  });
  it('does not publish a late local result after cancellation', async () => {
    const h = harness();
    h.download.mockImplementationOnce(async () => { h.controller.abort(); return { pruned_agents: 1 }; });
    await settle(h.run('startup', h.controller.signal));
    expect(h.broadcast).not.toHaveBeenCalled();
  });

  it('publishes built-in changes separately from truthful seed progress', () => {
    const h = harness();
    h.publishBuiltin({ seeded_agents: 0, seeded_skills: 0, manifest_agents: 0, manifest_skills: 0 });
    expect(h.broadcast).not.toHaveBeenCalled();
    h.publishBuiltin({ seeded_agents: 1, seeded_skills: 0, manifest_agents: 0, manifest_skills: 0 });
    expect(h.broadcast.mock.calls.filter(call => call[0] === 'marketplace:content-changed')).toEqual([['marketplace:content-changed', {}]]);
    expect(h.broadcast.mock.calls.filter(call => call[0] === 'marketplace:reconcile-status').map(call => call[1])).toMatchObject([
      { state: 'running', phase: 'default_seed', pulled: 0, total: 1 },
      { state: 'done', phase: 'default_seed', pulled: 1, total: 1 },
    ]);
  });

});
