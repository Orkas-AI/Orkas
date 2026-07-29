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
  hidden = false;
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

function loadSettingsClickHarness(
  invokeOverride?: (channel: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>,
) {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
  const indexHtml = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
  const elements = new Map<string, FakeElement>();
  for (const id of [
    'settings-picker-provider',
    'settings-picker-model-row',
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
  const invoke = vi.fn(async (channel: string, payload?: Record<string, unknown>) => {
    if (invokeOverride) return invokeOverride(channel, payload);
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
      getOptions: () => options,
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
  return { context, elements, indexHtml, settingsSource: source, invoke };
}

describe('settings model authorization add account', () => {
  it('opens the dedicated configuration flow for the Custom provider', async () => {
    const { context, elements, indexHtml, settingsSource, invoke } = loadSettingsClickHarness();
    expect(indexHtml).toContain('id="settings-picker-model-row"');
    expect(settingsSource).toContain('class="form-hint custom-model-intro"');
    expect(settingsSource).toMatch(/type="password" class="api-key-input\b/);
    expect(settingsSource).toMatch(/type="password" class="custom-key-input\b/);
    for (const inputId of [
      'settings-search-key-input',
      'settings-image-key-input',
      'settings-video-key-input',
      'settings-tts-key-input',
    ]) {
      expect(indexHtml).toMatch(new RegExp(`<input type="password"[^>]+id="${inputId}"`));
    }
    expect(settingsSource).not.toContain('custom-model-advanced');
    expect(settingsSource).not.toContain('settings.custom.base_url_hint');
    expect(settingsSource).not.toContain('CUSTOM_LABEL_REQUIRED');
    vm.runInContext(`
      _settingsState.providers = [{
        id: 'custom',
        label: 'Custom (OpenAI-compatible)',
        labelKey: 'provider.custom.label',
        supportsApiKey: true,
        supportsOAuth: false,
        customOpenAICompatible: true
      }];
      _settingsState.modelsCache = {};
      window.__openedCustomProvider = '';
      _settingsShowCustomModelForm = (provider) => {
        window.__openedCustomProvider = provider.id;
      };
    `, context);

    await vm.runInContext('_settingsRenderPicker()', context);
    await vm.runInContext("_settingsState.pickerProviderSel.emitChange('custom')", context);
    expect(elements.get('settings-picker-model-row')!.hidden).toBe(true);
    await elements.get('settings-add-entry-btn')!.click();

    expect(vm.runInContext('window.__openedCustomProvider', context)).toBe('custom');
    expect(invoke).not.toHaveBeenCalledWith('auth.listModels', { provider: 'custom' });
    expect(vm.runInContext(
      "_settingsValidateCustomBaseUrl('https://gateway.example.test/v1')",
      context,
    )).toBe('');
    expect(vm.runInContext(
      "_settingsValidateCustomBaseUrl('https://gateway.example.test/v1/chat/completions')",
      context,
    )).toBe('');
    expect(JSON.parse(JSON.stringify(vm.runInContext(`
      _settingsBuildCustomModelPayload({
        label: ' ',
        baseUrl: ' http://127.0.0.1:8000/v1/chat/completions ',
        model: ' qwen3-32b ',
        apiKey: ' local-key '
      })
    `, context)))).toEqual({
      label: '',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'qwen3-32b',
      apiKey: 'local-key',
    });
  });

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

  it('keeps the current provider models when an older request resolves last', async () => {
    const pending = new Map<string, {
      resolve: (value: Record<string, unknown>) => void;
      promise: Promise<Record<string, unknown>>;
    }>();
    for (const provider of ['openai', 'anthropic']) {
      let resolve!: (value: Record<string, unknown>) => void;
      const promise = new Promise<Record<string, unknown>>((done) => { resolve = done; });
      pending.set(provider, { resolve, promise });
    }
    const { context } = loadSettingsClickHarness(async (channel, payload) => {
      if (channel !== 'auth.listModels') return { ok: true };
      return pending.get(String(payload?.provider))!.promise;
    });
    vm.runInContext(`
      _settingsState.providers = [
        { id: 'openai', label: 'OpenAI', supportsApiKey: true, supportsOAuth: false },
        { id: 'anthropic', label: 'Anthropic', supportsApiKey: true, supportsOAuth: false }
      ];
      _settingsState.modelsCache = {};
    `, context);

    await vm.runInContext('_settingsRenderPicker()', context);
    const slowOpenAi = vm.runInContext(
      "_settingsState.pickerProviderSel.emitChange('openai')",
      context,
    );
    const currentAnthropic = vm.runInContext(
      "_settingsState.pickerProviderSel.emitChange('anthropic')",
      context,
    );
    pending.get('anthropic')!.resolve({
      ok: true,
      models: [{ id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }],
    });
    await currentAnthropic;
    pending.get('openai')!.resolve({
      ok: true,
      models: [{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }],
    });
    await slowOpenAi;

    expect(vm.runInContext('_settingsState.pickerProviderSel.getValue()', context)).toBe('anthropic');
    expect(vm.runInContext(
      '_settingsState.pickerModelSel.getOptions().map((option) => option.value)',
      context,
    )).toEqual(['claude-opus-4-8']);
  });

  it('keeps OAuth failure visible and removes the new credential when its model entry cannot be saved', async () => {
    const { context, elements, invoke } = loadSettingsClickHarness(async (channel) => {
      if (channel === 'auth.addEntry') {
        return { ok: false, error: 'The selected model is no longer available' };
      }
      if (channel === 'auth.removeCredential') return { ok: true, removed: true };
      return { ok: true };
    });
    const closeFlow = vi.fn();
    context.__closeFlow = closeFlow;
    vm.runInContext(`
      _oauthFlowTarget = {
        provider: { id: 'openai-codex' },
        oauthProviderId: 'openai-codex',
        modelId: 'gpt-5.6-sol'
      };
      _oauthFlowRender(
        { id: 'openai-codex' },
        { kind: 'done', profileId: 'openai-codex:new-account' },
        __closeFlow
      );
    `, context);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoke).toHaveBeenCalledWith('auth.addEntry', {
      provider: 'openai-codex',
      model: 'gpt-5.6-sol',
      profileId: 'openai-codex:new-account',
    });
    expect(invoke).toHaveBeenCalledWith('auth.removeCredential', {
      profileId: 'openai-codex:new-account',
    });
    expect(elements.get('oauth-flow-body')!.innerHTML).toContain('The selected model is no longer available');
    expect(closeFlow).not.toHaveBeenCalled();
  });
});
