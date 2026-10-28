import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const settingsSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/settings.js'),
  'utf8',
);

function loadHarness(invokeImpl: (channel: string, payload?: any) => Promise<any>) {
  const listeners = new Map<string, () => Promise<void>>();
  const metacognitionToggle: any = {
    checked: false,
    disabled: false,
    dataset: {},
    addEventListener(type: string, handler: () => Promise<void>) {
      listeners.set(`metacognition:${type}`, handler);
    },
  };
  const radios = ['workspace_approval', 'all_files_approval', 'all_files_auto'].map(value => ({
    value, checked: false,
    addEventListener(type: string, handler: () => Promise<void>) {
      listeners.set(`localexec:${value}:${type}`, handler);
    },
  }));
  const dataRootButton: any = {
    dataset: {},
    addEventListener(type: string, handler: () => Promise<void>) {
      listeners.set(`data-root:${type}`, handler);
    },
  };
  const elements: Record<string, any> = {
    'settings-localexec-modes': { dataset: {}, querySelectorAll: () => radios },
    'settings-metacognition-toggle': metacognitionToggle,
    'settings-metacognition-status': { textContent: '' },
    'settings-data-root-btn': dataRootButton,
    'settings-data-root-path': { textContent: '' },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const sandbox: any = {
    console,
    createLogger: () => logger,
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value ?? ''),
    document: {
      getElementById: (id: string) => elements[id] || null,
      querySelectorAll: () => [],
    },
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke: vi.fn(invokeImpl) },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  };
  vm.runInNewContext(settingsSource, sandbox, { filename: 'settings.js' });
  return {
    sandbox,
    listeners,
    metacognitionToggle,
    radios,
    logger,
  };
}

describe('Settings general preference recovery', () => {
  it('persists an early metacognition toggle while the initial read is still pending', async () => {
    let finishInitialRead: ((value: any) => void) | undefined;
    const initialRead = new Promise((resolve) => {
      finishInitialRead = resolve;
    });
    const h = loadHarness(async (channel) => {
      if (channel === 'prefs.getMetacognition') return initialRead;
      if (channel === 'prefs.setMetacognition') return { ok: true, enabled: true };
      return { ok: true };
    });

    h.sandbox._settingsBindMetacognitionOnce();
    const refresh = h.sandbox._settingsRefreshMetacognition();
    h.metacognitionToggle.checked = true;
    await h.listeners.get('metacognition:change')!();
    finishInitialRead!({ ok: true, enabled: false, envForcedOff: false });
    await refresh;

    expect(h.metacognitionToggle.checked).toBe(true);
    expect(h.metacognitionToggle.disabled).toBe(false);
  });

  it('keeps the environment kill switch authoritative when the preference write settles last', async () => {
    const initialRead = Promise.withResolvers<any>();
    const preferenceWrite = Promise.withResolvers<any>();
    const h = loadHarness(async (channel) => {
      if (channel === 'prefs.getMetacognition') return initialRead.promise;
      if (channel === 'prefs.setMetacognition') return preferenceWrite.promise;
      return { ok: true };
    });

    h.sandbox._settingsBindMetacognitionOnce();
    const refresh = h.sandbox._settingsRefreshMetacognition();
    h.metacognitionToggle.checked = true;
    const toggle = h.listeners.get('metacognition:change')!();
    initialRead.resolve({ ok: true, enabled: false, envForcedOff: true });
    await refresh;

    expect(h.metacognitionToggle.checked).toBe(false);
    expect(h.metacognitionToggle.disabled).toBe(true);

    preferenceWrite.resolve({ ok: true, enabled: true });
    await toggle;

    expect(h.metacognitionToggle.checked).toBe(false);
    expect(h.metacognitionToggle.disabled).toBe(true);
  });

  it('reconciles persisted metacognition state when an early toggle write is rejected', async () => {
    const initialRead = Promise.withResolvers<any>();
    let readCalls = 0;
    const h = loadHarness(async (channel) => {
      if (channel === 'prefs.getMetacognition') {
        readCalls += 1;
        if (readCalls === 1) return initialRead.promise;
        return { ok: true, enabled: true, envForcedOff: false };
      }
      if (channel === 'prefs.setMetacognition') return { ok: false, error: 'update_rejected' };
      return { ok: true };
    });

    h.sandbox._settingsBindMetacognitionOnce();
    const refresh = h.sandbox._settingsRefreshMetacognition();
    h.metacognitionToggle.checked = true;
    await h.listeners.get('metacognition:change')!();
    initialRead.resolve({ ok: true, enabled: true, envForcedOff: false });
    await refresh;

    expect(readCalls).toBe(2);
    expect(h.metacognitionToggle.checked).toBe(true);
    expect(h.metacognitionToggle.disabled).toBe(false);
  });

  it('keeps requested and actual metacognition state on a rejected write', async () => {
    const h = loadHarness(async (channel) => {
      if (channel === 'prefs.getMetacognition') {
        return { ok: true, enabled: false, envForcedOff: false };
      }
      if (channel === 'prefs.setMetacognition') return { ok: false, error: '/private/prefs' };
      return { ok: true };
    });

    await h.sandbox._settingsRefreshMetacognition();
    h.sandbox._settingsRenderMetacognition();
    h.metacognitionToggle.checked = true;
    await h.listeners.get('metacognition:change')!();

    expect(h.metacognitionToggle.checked).toBe(false);
    expect(h.metacognitionToggle.disabled).toBe(false);
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain('/private/prefs');
  });

  it('logs a rejected data-root open without exposing private paths', async () => {
    const h = loadHarness(async (channel) => (
      channel === 'app.openDataRoot'
        ? { ok: false, error: '/private/data-root' }
        : { ok: true }
    ));

    h.sandbox._settingsRenderDataRoot();
    await h.listeners.get('data-root:click')!();

    expect(h.logger.warn).toHaveBeenCalledWith('open data root rejected', { error_code: 'open_rejected' });
    expect(JSON.stringify(h.logger.warn.mock.calls)).not.toContain('/private/data-root');
  });


  it('keeps a newly saved access mode when the initial read settles late', async () => {
    const read = Promise.withResolvers<any>();
    const h = loadHarness(async (channel, payload) => {
      if (channel === 'permissions.getLocalExec') return read.promise;
      if (channel === 'permissions.setLocalExecMode') return { ok: true, mode: payload.mode };
      return { ok: true };
    });
    h.sandbox._settingsRenderLocalExec();
    const refresh = h.sandbox._settingsRefreshLocalExec();
    h.radios[0].checked = true;
    await h.listeners.get('localexec:workspace_approval:change')!();
    read.resolve({ ok: true, mode: 'all_files_auto' });
    await refresh;
    expect(h.radios.map(r => r.checked)).toEqual([true, false, false]);
  });

  it.each(['reject', 'throw'])('recovers the self-evolution control after a %s write', async (failure) => {
    const h = loadHarness(async (channel) => {
      if (channel === 'prefs.getMetacognition') return { ok: true, enabled: false, envForcedOff: false };
      if (channel === 'prefs.setMetacognition') {
        if (failure === 'throw') throw new Error('fixture write failure');
        return { ok: false };
      }
      return { ok: true };
    });
    await h.sandbox._settingsRefreshMetacognition();
    h.metacognitionToggle.checked = true;
    await h.listeners.get('metacognition:change')!();
    expect(h.metacognitionToggle.checked).toBe(false);
    expect(h.metacognitionToggle.disabled).toBe(false);
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
  });
});
