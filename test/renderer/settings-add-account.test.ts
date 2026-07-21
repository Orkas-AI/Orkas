import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class FakeClassList {
  private readonly values = new Set<string>();

  add(...names: string[]) { names.forEach((name) => this.values.add(name)); }
  remove(...names: string[]) { names.forEach((name) => this.values.delete(name)); }
  contains(name: string) { return this.values.has(name); }
}

class FakeElement {
  dataset: Record<string, string> = {};
  classList = new FakeClassList();
  className = '';
  innerHTML = '';
  textContent = '';
  onclick: null | ((event?: unknown) => unknown) = null;
  private readonly listeners = new Map<string, Array<(event?: unknown) => unknown>>();

  addEventListener(type: string, handler: (event?: unknown) => unknown) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  async click() {
    if (this.onclick) await this.onclick({ currentTarget: this, target: this });
    for (const handler of this.listeners.get('click') || []) {
      await handler({ currentTarget: this, target: this });
    }
  }
}

function loadSettingsClickHarness() {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
  const indexHtml = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
  const elements = new Map<string, FakeElement>();
  for (const id of [
    'settings-picker-provider',
    'settings-picker-model',
    'settings-add-entry-btn',
    'settings-picker-status',
    'oauth-flow-modal',
    'oauth-flow-title',
    'oauth-flow-body',
    'oauth-flow-close-btn',
  ]) {
    elements.set(id, new FakeElement());
  }
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'auth.listModels') {
      return { ok: true, models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }] };
    }
    if (channel === 'auth.startOAuth') {
      return { ok: false, error: 'stop after proving the dialog opened' };
    }
    return { ok: true };
  });

  const aiSelectMount = (element: FakeElement, config: Record<string, unknown> = {}) => {
    let value = typeof config.value === 'string' ? config.value : '';
    let options: Array<{ value: string }> = [];
    let changeHandler: (next: string) => unknown = () => undefined;
    return {
      setOptions(nextOptions: Array<{ value: string }>, next: { value?: string } = {}) {
        options = nextOptions || [];
        if (typeof next.value === 'string') value = next.value;
        if (value && !options.some((option) => option.value === value)) value = '';
        element.dataset.value = value;
      },
      getValue: () => value,
      setValue(next: string) {
        value = next || '';
        element.dataset.value = value;
      },
      onChange(handler: (next: string) => unknown) { changeHandler = handler; },
      emitChange(next: string) {
        value = next;
        element.dataset.value = value;
        return changeHandler(next);
      },
    };
  };

  const context: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value ?? ''),
    _aiSelectMount: aiSelectMount,
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'settings.js' });
  vm.runInContext(`
    _settingsState.providers = [{
      id: 'openai-codex',
      label: 'OpenAI Codex',
      supportsApiKey: false,
      supportsOAuth: true
    }];
    _settingsState.modelsCache = {};
  `, context);
  return { context, elements, indexHtml, invoke };
}

describe('settings model authorization add account', () => {
  it('opens the OAuth dialog when OpenAI Codex and GPT-5.6 are selected', async () => {
    const { context, elements, indexHtml, invoke } = loadSettingsClickHarness();
    for (const id of [
      'settings-picker-provider',
      'settings-picker-model',
      'settings-add-entry-btn',
      'oauth-flow-modal',
      'oauth-flow-title',
      'oauth-flow-body',
      'oauth-flow-close-btn',
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
    }

    await vm.runInContext('_settingsRenderPicker()', context);
    await vm.runInContext("_settingsState.pickerProviderSel.emitChange('openai-codex')", context);
    await vm.runInContext("_settingsState.pickerModelSel.emitChange('gpt-5.6-sol')", context);
    expect(vm.runInContext('_settingsState.pickerProviderSel.getValue()', context)).toBe('openai-codex');
    expect(vm.runInContext('_settingsState.pickerModelSel.getValue()', context)).toBe('gpt-5.6-sol');
    await elements.get('settings-add-entry-btn')!.click();

    expect(elements.get('oauth-flow-modal')!.classList.contains('open')).toBe(true);
    expect(invoke).toHaveBeenCalledWith('auth.startOAuth', { provider: 'openai-codex' });
  });
});
