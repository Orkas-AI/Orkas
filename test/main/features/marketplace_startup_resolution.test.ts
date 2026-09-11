import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';

// Execute the actual startup function with isolated feature boundaries; importing
// the Electron entry module would launch windows and unrelated startup services.
const source = fs.readFileSync(path.resolve(__dirname, '../../../src/main/index.ts'), 'utf8');
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const startup = parsed.statements.find((node): node is ts.FunctionDeclaration =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'runMarketplaceInstallReconcile');
if (!startup) throw new Error('Marketplace startup entry is missing');
const compiled = ts.transpileModule(`${startup.getText(parsed)}\nexports.run = runMarketplaceInstallReconcile;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness() {
  const events: string[] = [];
  let active = true;
  const warn = vi.fn();
  const status = vi.fn();
  const resolve = vi.fn(async (_uid: string, opts: { shouldContinue: () => boolean }) => {
    expect(opts.shouldContinue()).toBe(true);
    events.push('resolve');
  });
  const modules: Record<string, unknown> = {
    './features/builtin_marketplace': { resolveBuiltinMarketplaceInstalls: resolve },
    './features/marketplace': {
      hasKnownDefaultInstallWork: async () => true,
      ensureDefaultInstalls: async () => { events.push('defaults'); return {}; },
    },
    './features/marketplace_reconcile': {
      setDefaultInstallSeedStatus: status,
      checkServerUpdatesForInstalls: async () => { events.push('catalog'); },
      reconcileInstalls: async () => { events.push('download'); return {}; },
    },
  };
  const context = {
    exports: {} as { run: (reason: string) => Promise<void> },
    require: (name: string) => {
      if (!(name in modules)) throw new Error('Unexpected startup dependency');
      return modules[name];
    },
    users: { getActiveUserId: () => 'fixture-user' },
    marketplaceBootContextStillActive: () => active,
    marketplaceBootLog: { info: vi.fn(), warn },
    logErrorSummary: () => ({ name: 'Error' }),
    marketplaceReconcileInFlight: null,
    marketplaceReconcileInFlightKey: '',
    subscribeMarketplaceReconcileStatus: vi.fn(),
    seedBuiltinMarketplaceForCurrentUser: async () => { events.push('seed'); },
    clearMarketplaceDefaultsRetry: vi.fn(),
    scheduleMarketplaceDefaultsRetry: vi.fn(),
    MARKETPLACE_DEFAULTS_REFRESH_INTERVAL_MS: 60_000,
    MARKETPLACE_SERVER_CHECK_INTERVAL_MS: 60_000,
  };
  vm.runInNewContext(compiled, context);
  return { run: context.exports.run, events, resolve, warn, status, deactivate: () => { active = false; } };
}

describe('open-source startup marketplace resolution', () => {
  it('resolves seeded local installs before checking versions and downloading updates', async () => {
    const h = harness();
    await h.run('startup');
    expect(h.events).toEqual(['seed', 'resolve', 'defaults', 'catalog', 'download']);
    expect(h.resolve).toHaveBeenCalledExactlyOnceWith('fixture-user', expect.objectContaining({ shouldContinue: expect.any(Function) }));
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('allows reconcile to recover unresolved URLs if the startup resolution is unavailable', async () => {
    const h = harness();
    h.resolve.mockRejectedValueOnce(new Error('Fixture lookup failure'));
    await h.run('startup');
    expect(h.events).toEqual(['seed', 'defaults', 'catalog', 'download']);
    expect(h.warn).toHaveBeenCalledExactlyOnceWith('builtin marketplace resolve failed', { error: { name: 'Error' } });
    h.warn.mockClear();
    h.events.length = 0;
    await h.run('marketplace-defaults-retry');
    expect(h.events).toEqual(['seed', 'resolve', 'defaults', 'catalog', 'download']);
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('stops further startup work and clears progress after an account change during resolution', async () => {
    const h = harness();
    h.resolve.mockImplementationOnce(async () => { h.events.push('resolve'); h.deactivate(); });
    await h.run('startup');
    expect(h.events).toEqual(['seed', 'resolve']);
    expect(h.status.mock.calls.map(call => call[0])).toEqual([true, false]);
    expect(h.warn).not.toHaveBeenCalled();
  });
});
