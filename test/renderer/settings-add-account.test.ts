import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const styleSource = readFileSync(resolve(__dirname, '../../src/renderer/style.css'), 'utf8');

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
  value = '';
  type = '';
  title = '';
  hidden = false;
  disabled = false;
  draggable = false;
  focused = false;
  style: Record<string, string> = {};
  onclick: null | ((event?: unknown) => unknown) = null;
  readonly children: FakeElement[] = [];
  get childNodes() { return this.children; }
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event?: unknown) => unknown>>();
  private readonly queryResults = new Map<string, FakeElement>();

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

  appendChild(child: FakeElement) {
    this.children.push(child);
    return child;
  }

  prepend(child: FakeElement) {
    this.children.unshift(child);
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string) {
    return this.attributes.get(name) || null;
  }

  querySelector(selector: string) {
    return this.queryResults.get(selector) || null;
  }

  setQueryResult(selector: string, element: FakeElement) {
    this.queryResults.set(selector, element);
  }

  focus() {
    this.focused = true;
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
    'add-account-modal',
    'add-account-title',
    'add-account-body',
    'add-account-actions',
    'oauth-flow-modal',
    'oauth-flow-title',
    'oauth-flow-body',
    'oauth-flow-close-btn',
    'settings-search-entries',
    'settings-image-entries',
    'settings-video-entries',
    'settings-tts-entries',
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
  const monitor = { event: vi.fn(), error: vi.fn(), click: vi.fn() };

  const context: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string, values?: Record<string, unknown>) => (
      values && typeof values.models === 'string' ? `${key}:${values.models}` : key
    ),
    escapeHtml: (value: unknown) => String(value ?? ''),
    uiAlert: vi.fn(async () => undefined),
    uiConfirm: vi.fn(async () => true),
    _aiSelectMount: aiSelectMount,
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new FakeElement(),
      querySelectorAll: () => [],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    window: {
      addEventListener: vi.fn(),
      Monitor: monitor,
      orkas: { invoke },
    },
    Monitor: monitor,
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
  return { context, elements, indexHtml, settingsSource: source, invoke, monitor };
}

describe('settings model authorization add account', () => {
  it('updates existing-entry models and reverts failed selections', async () => {
    const success = loadSettingsClickHarness();
    vm.runInContext('window.__settingsReloaded = false; _settingsReload = async () => { window.__settingsReloaded = true; };', success.context);
    success.context.__modelSel = { setValue: vi.fn() };

    await vm.runInContext(`_settingsUpdateEntryModel(
      { entryId: 'entry-1', model: 'deepseek-v4-pro' },
      'deepseek-v4-flash',
      __modelSel
    )`, success.context);

    expect(success.invoke).toHaveBeenCalledWith('auth.updateEntryModel', {
      entryId: 'entry-1',
      model: 'deepseek-v4-flash',
    });
    expect(vm.runInContext('window.__settingsReloaded', success.context)).toBe(true);

    const failure = loadSettingsClickHarness(async (channel) => {
      if (channel === 'auth.updateEntryModel') {
        return { ok: false, code: 'MODEL_NOT_AVAILABLE', error: 'private model response' };
      }
      return { ok: true };
    });
    failure.context.__modelSel = { setValue: vi.fn() };
    await vm.runInContext(`_settingsUpdateEntryModel(
      { entryId: 'entry-2', model: 'claude-opus-4-8' },
      'claude-future-private',
      __modelSel
    )`, failure.context);

    expect(failure.context.__modelSel.setValue).toHaveBeenCalledWith('claude-opus-4-8');
  });

  it('blocks invalid client-side model configuration before IPC', async () => {
    const { context, elements, invoke } = loadSettingsClickHarness();
    const body = elements.get('add-account-body')!;
    const actions = elements.get('add-account-actions')!;
    body.setQueryResult('.api-label-input', new FakeElement());
    body.setQueryResult('.api-key-input', new FakeElement());
    body.setQueryResult('.form-msg', new FakeElement());

    context._settingsShowApiKeyForm(
      { id: 'openai', label: 'OpenAI' },
      'gpt-5.6-sol',
    );
    await actions.children[1].click();

    expect(invoke).not.toHaveBeenCalledWith('auth.addApiKeyEntry', expect.anything());
    const customBody = elements.get('add-account-body')!;
    for (const selector of [
      '.custom-label-input',
      '.custom-base-url-input',
      '.custom-model-input',
      '.custom-max-tokens-input',
      '.custom-key-input',
      '.form-msg',
    ]) customBody.setQueryResult(selector, new FakeElement());
    context._settingsShowCustomModelForm({ id: 'custom', label: 'Custom' });
    await actions.children.at(-1)!.click();

    expect(invoke).not.toHaveBeenCalledWith('auth.addCustomModelEntry', expect.anything());
  });

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
    expect(settingsSource).toContain('custom-model-advanced');
    expect(settingsSource).toContain('custom-max-tokens-input');
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
        apiKey: ' local-key ',
        maxTokens: '   '
      })
    `, context)))).toEqual({
      label: '',
      baseUrl: 'http://127.0.0.1:8000/v1',
      model: 'qwen3-32b',
      apiKey: 'local-key',
    });
    expect(JSON.parse(JSON.stringify(vm.runInContext(`
      _settingsBuildCustomModelPayload({
        label: '',
        baseUrl: 'https://gateway.example.test/v1',
        model: 'reasoner',
        apiKey: 'key',
        maxTokens: ' 65536 '
      })
    `, context)))).toEqual({
      label: '',
      baseUrl: 'https://gateway.example.test/v1',
      model: 'reasoner',
      apiKey: 'key',
      maxTokens: '65536',
    });
  });

  it('keeps max output tokens numeric while hiding its native spinner controls', () => {
    const { settingsSource } = loadSettingsClickHarness();
    expect(settingsSource).toMatch(
      /<input type="number" class="custom-max-tokens-input form-input" min="1" max="16777216" step="1" placeholder="32768" inputmode="numeric" \/>/,
    );

    const inputRule = styleSource.match(/\.custom-max-tokens-input\s*\{([^}]*)\}/)?.[1];
    expect(inputRule).toBeDefined();
    expect(inputRule).toMatch(/-moz-appearance:\s*textfield;/);
    expect(inputRule).toMatch(/(?:^|\n)\s*appearance:\s*textfield;/);

    const webkitSpinnerRule = styleSource.match(
      /\.custom-max-tokens-input::\-webkit-inner-spin-button\s*,\s*\.custom-max-tokens-input::\-webkit-outer-spin-button\s*\{([^}]*)\}/,
    )?.[1];
    expect(webkitSpinnerRule).toBeDefined();
    expect(webkitSpinnerRule).toMatch(/-webkit-appearance:\s*none;/);
    expect(webkitSpinnerRule).toMatch(/margin:\s*0;/);
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

  it('puts the OpenRouter manual-ID item first and routes it to the API-key form', async () => {
    const { context, elements } = loadSettingsClickHarness(async (channel) => {
      if (channel === 'auth.listModels') {
        return { ok: true, models: [{ id: 'x-ai/grok-4.5', name: 'Grok 4.5' }] };
      }
      return { ok: true };
    });
    vm.runInContext(`
      _settingsState.providers = [{
        id: 'openrouter',
        label: 'OpenRouter',
        supportsApiKey: true,
        supportsOAuth: true
      }];
      _settingsState.modelsCache = {};
      window.__openedApiKeyForm = null;
      _settingsShowApiKeyForm = (provider, model) => {
        window.__openedApiKeyForm = { provider: provider.id, model };
      };
    `, context);

    await vm.runInContext('_settingsRenderPicker()', context);
    await vm.runInContext("_settingsState.pickerProviderSel.emitChange('openrouter')", context);
    expect(vm.runInContext(
      '_settingsState.pickerModelSel.getOptions().map((option) => option.value)',
      context,
    )).toEqual(['__openrouter_custom_model__', 'x-ai/grok-4.5']);

    await vm.runInContext(
      "_settingsState.pickerModelSel.emitChange('__openrouter_custom_model__')",
      context,
    );
    await elements.get('settings-add-entry-btn')!.click();
    expect(JSON.parse(JSON.stringify(vm.runInContext('window.__openedApiKeyForm', context)))).toEqual({
      provider: 'openrouter',
      model: '__openrouter_custom_model__',
    });
    expect(vm.runInContext(
      "_settingsResolveApiKeyModelId('openrouter', '__openrouter_custom_model__', '  vendor/new-model  ')",
      context,
    )).toBe('vendor/new-model');
    expect(vm.runInContext(
      "_settingsResolveApiKeyModelId('openrouter', 'x-ai/grok-4.5', 'ignored/model')",
      context,
    )).toBe('x-ai/grok-4.5');
  });

  it('requires and atomically submits a trimmed OpenRouter custom model ID', async () => {
    const { context, elements, invoke } = loadSettingsClickHarness();
    const body = elements.get('add-account-body')!;
    const actions = elements.get('add-account-actions')!;
    const modelInput = new FakeElement();
    const labelInput = new FakeElement();
    const keyInput = new FakeElement();
    const message = new FakeElement();
    body.setQueryResult('.openrouter-model-input', modelInput);
    body.setQueryResult('.api-label-input', labelInput);
    body.setQueryResult('.api-key-input', keyInput);
    body.setQueryResult('.form-msg', message);
    vm.runInContext('_settingsReload = async () => { window.__settingsReloaded = true; };', context);
    vm.runInContext(`
      _settingsShowApiKeyForm(
        { id: 'openrouter', label: 'OpenRouter', supportsApiKey: true, supportsOAuth: true },
        '__openrouter_custom_model__'
      )
    `, context);

    keyInput.value = ' sk-or-test ';
    await actions.children.at(-1)!.click();
    expect(message.textContent).toBe('settings.custom.error_model');
    expect(modelInput.focused).toBe(true);
    expect(invoke).not.toHaveBeenCalledWith('auth.addApiKeyEntry', expect.anything());

    modelInput.value = '  future-lab/frontier-2:free  ';
    labelInput.value = '  Relay account  ';
    await actions.children.at(-1)!.click();

    expect(invoke).toHaveBeenCalledWith('auth.addApiKeyEntry', {
      provider: 'openrouter',
      model: 'future-lab/frontier-2:free',
      apiKey: 'sk-or-test',
      label: 'Relay account',
    });
    expect(vm.runInContext('window.__settingsReloaded', context)).toBe(true);
  });

  it('keeps a saved custom OpenRouter ID selectable when it is not a shortcut', () => {
    const { context } = loadSettingsClickHarness();
    const state = JSON.parse(JSON.stringify(vm.runInContext(`
      _settingsEntryModelState(
        { provider: 'openrouter', model: 'future-lab/frontier-2', modelAvailable: true },
        [{ id: 'x-ai/grok-4.5', name: 'Grok 4.5' }]
      )
    `, context)));

    expect(state).toMatchObject({
      unavailable: false,
      value: 'future-lab/frontier-2',
      options: [
        { value: 'future-lab/frontier-2', label: 'future-lab/frontier-2' },
        { value: 'x-ai/grok-4.5', label: 'Grok 4.5' },
      ],
    });
  });

  it('keeps the concise custom model ID label aligned across locales', () => {
    const expected = {
      zh: '自定义模型 ID',
      en: 'Custom model ID',
      ja: 'カスタムモデル ID',
      pt: 'ID de modelo personalizado',
    };
    for (const [locale, label] of Object.entries(expected)) {
      const messages = JSON.parse(readFileSync(
        resolve(__dirname, `../../src/renderer/locales/${locale}.json`),
        'utf8',
      ));
      expect(messages['settings.picker.openrouter_custom_model']).toBe(label);
    }
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
      _oauthFlowTelemetry = { startedAt: Date.now(), done: false };
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

  it('contains thrown OAuth entry writes and removes the new credential', async () => {
    const privateFailure = '/Users/test/private/oauth.json?token=secret';
    const { context, elements, invoke } = loadSettingsClickHarness(async (channel) => {
      if (channel === 'auth.addEntry') throw new Error(privateFailure);
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
      _oauthFlowTelemetry = { startedAt: Date.now(), done: false };
      _oauthFlowRender(
        { id: 'openai-codex' },
        { kind: 'done', profileId: 'openai-codex:new-account' },
        __closeFlow
      );
    `, context);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoke).toHaveBeenCalledWith('auth.removeCredential', {
      profileId: 'openai-codex:new-account',
    });
    expect(closeFlow).not.toHaveBeenCalled();
    expect(JSON.stringify([
      elements.get('oauth-flow-body')!.innerHTML,
    ])).not.toContain(privateFailure);
  });

  it('does not persist OAuth success when the completed flow has no profile id', async () => {
    const { context, invoke } = loadSettingsClickHarness();
    context.__closeFlow = vi.fn();
    vm.runInContext(`
      _oauthFlowTarget = {
        provider: { id: 'openai-codex' },
        oauthProviderId: 'openai-codex',
        modelId: 'gpt-5.6-sol'
      };
      _oauthFlowTelemetry = { startedAt: Date.now(), done: false };
      _oauthFlowRender(
        { id: 'openai-codex' },
        { kind: 'done' },
        __closeFlow
      );
    `, context);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(invoke).not.toHaveBeenCalledWith('auth.addEntry', expect.anything());
    expect(context.__closeFlow).not.toHaveBeenCalled();
  });
});
