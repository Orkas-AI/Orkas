import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

function loadModelGuardActionGate() {
  const main = { firstChild: null, insertBefore: vi.fn() };
  const createElement = vi.fn(() => ({ querySelector: vi.fn() }));
  const setView = vi.fn();
  const activateSettingsTab = vi.fn();
  const uiAlert = vi.fn();
  const warnings = vi.fn();
  const errors = vi.fn();
  const sandbox: any = {
    console,
    CustomEvent: class CustomEvent {
      detail: unknown;
      constructor(_name: string, init: { detail?: unknown } = {}) { this.detail = init.detail; }
    },
    createLogger: () => ({ warn: warnings, error: errors, info: vi.fn() }),
    t: (key: string) => key,
    document: {
      querySelector: vi.fn((selector: string) => selector === '.main-content' ? main : null),
      createElement,
    },
    setView: (view: string, cid: unknown, options: unknown) => setView(view, cid, options),
    uiAlert,
    setTimeout: (listener: () => void) => { listener(); return 1; },
  };
  sandbox.window = {
    orkas: {
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'auth.hasConfiguredModel') return { ok: true, configured: false };
        if (channel === 'auth.listEntries') return { ok: true, entries: [] };
        throw new Error(`unexpected channel: ${channel}`);
      }),
    },
    dispatchEvent: vi.fn(),
    activateSettingsTab,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    readFileSync(resolve(__dirname, '../../src/renderer/modules/model-guard.js'), 'utf8'),
    sandbox,
    { filename: 'model-guard.js' },
  );
  return { sandbox, main, createElement, setView, activateSettingsTab, uiAlert, warnings, errors };
}

describe('public model configuration action guard', () => {
  it('keeps an unavailable model state silent until an LLM-backed action is attempted', async () => {
    const guard = loadModelGuardActionGate();
    await guard.sandbox.refreshModelGuard();
    await guard.sandbox.refreshModelGuard();

    expect(guard.sandbox.isModelConfigured()).toBe(false);
    expect(guard.createElement).not.toHaveBeenCalled();
    expect(guard.main.insertBefore).not.toHaveBeenCalled();
    expect(guard.setView).not.toHaveBeenCalled();
    expect(guard.uiAlert).not.toHaveBeenCalled();
    expect(guard.sandbox.window.orkas.invoke.mock.calls.map(([channel]: [string]) => channel)).toEqual([
      'auth.hasConfiguredModel', 'auth.listEntries',
      'auth.hasConfiguredModel', 'auth.listEntries',
    ]);
    expect(guard.sandbox.ensureModelConfigured()).toBe(false);
    expect(guard.setView).toHaveBeenLastCalledWith('settings', null, {
      entryPoint: 'model_guard_blocked_action',
    });
    expect(guard.activateSettingsTab).toHaveBeenCalledWith('credentials');
    expect(guard.uiAlert).toHaveBeenCalledWith('model_guard.modal');
    expect(guard.warnings).not.toHaveBeenCalled();
    expect(guard.errors).not.toHaveBeenCalled();
  });

  it('keeps background model-gated paths silent when no model is available', async () => {
    const guard = loadModelGuardActionGate();
    await guard.sandbox.refreshModelGuard();

    expect(guard.sandbox.ensureModelConfigured({ silent: true })).toBe(false);
    expect(guard.uiAlert).not.toHaveBeenCalled();
    expect(guard.setView).not.toHaveBeenCalled();
    expect(guard.activateSettingsTab).not.toHaveBeenCalled();
    expect(guard.createElement).not.toHaveBeenCalled();
    expect(guard.main.insertBefore).not.toHaveBeenCalled();
    expect(guard.warnings).not.toHaveBeenCalled();
    expect(guard.errors).not.toHaveBeenCalled();
  });

  it('ignores a stale unavailable-model refresh that resolves after a repaired state', async () => {
    const guard = loadModelGuardActionGate();
    const resolvers: Array<(value: Record<string, unknown>) => void> = [];
    guard.sandbox.window.orkas.invoke = vi.fn((channel: string) => {
      if (channel === 'auth.hasConfiguredModel') return new Promise(resolve => resolvers.push(resolve));
      if (channel === 'auth.listEntries') return Promise.resolve({ ok: true, entries: [] });
      return Promise.reject(new Error(`unexpected channel: ${channel}`));
    });

    const staleUnavailable = guard.sandbox.refreshModelGuard();
    const repaired = guard.sandbox.refreshModelGuard();
    resolvers[1]({ ok: true, configured: true });
    await repaired;
    resolvers[0]({ ok: true, configured: false });
    await staleUnavailable;

    expect(guard.sandbox.isModelConfigured()).toBe(true);
    expect(guard.sandbox.ensureModelConfigured()).toBe(true);
    expect(guard.createElement).not.toHaveBeenCalled();
    expect(guard.setView).not.toHaveBeenCalled();
    expect(guard.uiAlert).not.toHaveBeenCalled();
    expect(guard.warnings).not.toHaveBeenCalled();
    expect(guard.errors).not.toHaveBeenCalled();
  });
});
