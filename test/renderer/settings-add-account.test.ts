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
  placeholder = '';
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

  keyDown(key: string) {
    for (const handler of this.listeners.get('keydown') || []) {
      handler({ key, keyCode: key === 'Enter' ? 13 : 0, isComposing: false, preventDefault: vi.fn() });
    }
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

  removeAttribute(name: string) {
    this.attributes.delete(name);
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
    'settings-add-modal',
    'add-account-modal',
    'add-account-title',
    'add-account-body',
    'add-account-actions',
    'oauth-flow-modal',
    'oauth-flow-title',
    'oauth-flow-body',
    'oauth-flow-close-btn',
    'settings-search-entries',
    'settings-image-provider',
    'settings-image-key-input',
    'settings-image-key-row',
    'settings-image-add-btn',
    'settings-image-status',
    'settings-image-entries',
    'settings-video-provider',
    'settings-video-key-input',
    'settings-video-add-btn',
    'settings-video-status',
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

  const selects = new Map<FakeElement, any>();
  const aiSelectMount = (element: FakeElement, config: Record<string, unknown> = {}) => {
    let value = typeof config.value === 'string' ? config.value : '';
    let options = (config.options || []) as Array<{ value: string; label?: string }>;
    let changeHandler: (next: string) => unknown = () => undefined;
    element.dataset.value = value;
    element.setQueryResult('.ai-select-trigger', new FakeElement());
    const api = {
      setOptions(nextOptions: Array<{ value: string }>, next: { value?: string } = {}) {
        options = nextOptions || [];
        if (typeof next.value === 'string') value = next.value;
        if (value && !options.some((option) => option.value === value)) value = '';
        element.dataset.value = value;
      },
      close: vi.fn(),
      getValue: () => value,
      getOptions: () => options,
      setAriaLabel() {},
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
    selects.set(element, api);
    return api;
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
    requestAnimationFrame: (callback: () => void) => callback(),
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
  return { context, elements, indexHtml, settingsSource: source, invoke, monitor, selects };
}

it.each(['anthropic', 'responses'])('submits the %s protocol picker selection without losing a gateway prefix', async protocol => {
  const { context, elements, invoke, selects } = loadSettingsClickHarness();
  const body = elements.get('add-account-body')!;
  for (const [selector, value] of Object.entries({
    '.custom-label-input': 'Gateway', '.custom-protocol-input': 'anthropic',
    '.custom-base-url-input': protocol === 'responses' ? 'https://gateway.example.test/proxy/v1/responses' : 'https://gateway.example.test/proxy/v1/messages',
    '.custom-model-input': 'claude-gateway-alias', '.custom-max-tokens-input': '8192',
    '.custom-key-input': 'synthetic-form-key', '.form-msg': '',
  })) { const field = new FakeElement(); field.value = value; body.setQueryResult(selector, field); }
  context._settingsShowCustomModelForm({ id: 'custom', label: 'Custom' });
  const protocolPicker = selects.get(body.querySelector('.custom-protocol-input')!);
  expect(protocolPicker.getValue()).toBe('openai');
  expect(protocolPicker.getOptions().map((option: {value: string}) => option.value)).toContain(protocol);
  protocolPicker.emitChange(protocol);
  expect(body.querySelector('.custom-base-url-input')!.placeholder).toBe(protocol === 'anthropic' ? 'https://api.example.com' : 'https://api.example.com/v1');
  await elements.get('add-account-actions')!.children.at(-1)!.click();
  expect(invoke).toHaveBeenCalledWith('auth.addCustomModelEntry', {
    label: 'Gateway', protocol, baseUrl: protocol === 'responses' ? 'https://gateway.example.test/proxy/v1/responses' : 'https://gateway.example.test/proxy/v1/messages',
    model: 'claude-gateway-alias', maxTokens: '8192', apiKey: 'synthetic-form-key',
  });
});

describe('settings model authorization add account', () => {
  it.each(['doubao-seedance-2-0-fast-260128', 'doubao-seedance-2-0-mini'])('preserves a flattened video model choice through the real add button: %s', async (model) => {
    const option = { id: `doubao:${model}`, provider: 'doubao', model, label: `DouBao · ${model}` };
    const { context, elements, invoke } = loadSettingsClickHarness(async (channel) => (
      channel === 'videoAuth.list' ? { ok: true, profiles: [], providers: [option] } : { ok: true }
    ));
    elements.get('settings-video-key-input')!.value = 'fixture-video-key';
    await context._settingsRefreshVideoProfiles();
    context._settingsRenderVideoPicker();
    context.__selected = option.id;
    vm.runInContext('_settingsState.videoProviderSel.setValue(__selected)', context);
    await elements.get('settings-video-add-btn')!.click();
    expect(invoke).toHaveBeenCalledWith('videoAuth.add', { provider: 'doubao', model, apiKey: 'fixture-video-key', label: 'default' });
    expect(elements.get('settings-video-key-input')!.value).toBe('');
  });

  it('does not submit an unknown video option or lose its entered key', async () => {
    const { context, elements, invoke } = loadSettingsClickHarness();
    elements.get('settings-video-key-input')!.value = 'fixture-video-key';
    context._settingsRenderVideoPicker();
    vm.runInContext("_settingsState.videoProviderSel.setValue('doubao:unknown-model')", context);
    await elements.get('settings-video-add-btn')!.click();
    expect(invoke.mock.calls.some(([channel]) => channel === 'videoAuth.add')).toBe(false);
    expect(elements.get('settings-video-key-input')!.value).toBe('fixture-video-key');
  });

  it('labels saved video models by their provider/model pair', async () => {
    const { context } = loadSettingsClickHarness(async (channel) => (
      channel === 'videoAuth.list' ? { ok: true, profiles: [], providers: [
        { id: 'doubao:standard', provider: 'doubao', model: 'standard', label: 'DouBao · Standard' },
        { id: 'doubao:fast', provider: 'doubao', model: 'fast', label: 'DouBao · Fast' },
      ] } : { ok: true }
    ));
    await context._settingsRefreshVideoProfiles();
    expect(context._videoProviderLabel('doubao', 'fast')).toBe('DouBao · Fast');
  });

  it('uses the model options returned by imageAuth and preserves the selected model on save', async () => {
    const model = 'doubao-seedream-5-0-pro-260628';
    const option = { id: `doubao:${model}`, provider: 'doubao', model, label: 'DouBao · Seedream 5.0 Pro' };
    const { context, elements, invoke } = loadSettingsClickHarness(async (channel) => (
      channel === 'imageAuth.list' ? { ok: true, profiles: [], providers: [option] } : { ok: true }
    ));
    const key = new FakeElement();
    key.value = 'fixture-image-key';
    elements.set('settings-image-key-input', key);
    elements.set('settings-image-provider', new FakeElement());
    elements.set('settings-image-status', new FakeElement());
    await context._settingsRefreshImageProfiles();
    context._settingsRenderImagePicker();
    expect(vm.runInContext('_settingsState.imageProviderSel.getOptions()', context)).toEqual([
      expect.objectContaining({ value: option.id, label: option.label }),
    ]);
    context.__selected = option.id;
    vm.runInContext('_settingsState.imageProviderSel.setValue(__selected)', context);
    await context._settingsClickAddImageKey();
    expect(invoke).toHaveBeenCalledWith('imageAuth.add', { provider: 'doubao', model, apiKey: 'fixture-image-key', label: 'default' });
  });

  it('adds Keenable search without a key while other search providers still need one', async () => {
    const { context, elements, invoke, selects } = loadSettingsClickHarness();
    const key = new FakeElement();
    const status = new FakeElement();
    elements.set('settings-search-provider', new FakeElement());
    elements.set('settings-search-key-input', key);
    elements.set('settings-search-status', status);
    context._settingsRenderSearchPicker();
    const picker = selects.get(elements.get('settings-search-provider')!);
    expect(picker.getOptions()).toContainEqual(expect.objectContaining({ value: 'keenable', label: 'Keenable' }));

    picker.emitChange('tavily');
    expect(key.placeholder).toBe('');
    await context._settingsClickAddSearchKey();
    expect(status.textContent).toBe('settings.search.error_key_needed');
    expect(invoke).not.toHaveBeenCalledWith('searchAuth.add', expect.anything());

    picker.emitChange('keenable');
    expect(key.placeholder).toBe('settings.search.api_key_optional');
    await context._settingsClickAddSearchKey();
    expect(invoke).toHaveBeenCalledWith('searchAuth.add', { provider: 'keenable', apiKey: '', label: 'default' });
  });

  it('turns a rejected OAuth start IPC into the visible error state', async () => {
    const { context, elements } = loadSettingsClickHarness(async () => { throw new Error('fixture IPC failure'); });
    await expect(context._settingsStartOAuthFlow({ id: 'openai-codex', label: 'Codex' }, 'gpt-5.5')).resolves.toBeUndefined();
    expect(elements.get('oauth-flow-body')!.innerHTML).toContain('settings.oauth.start_failed');
  });

  it('resets the language picker and explains a failed language change', async () => {
    const { context, elements } = loadSettingsClickHarness();
    elements.set('settings-language-select', new FakeElement());
    context.getLang = () => 'en';
    context.isSupportedLang = () => true;
    context.setLang = vi.fn(async () => { throw new Error('fixture preference failure'); });
    context.getSupportedLangs = () => ['en', 'zh'];
    context._settingsBindLanguageOnce();
    await vm.runInContext("_settingsLanguageSel.emitChange('zh')", context);
    expect(context.uiAlert).toHaveBeenCalledWith('settings.language.change_failed');
    expect(vm.runInContext('_settingsLanguageSel.getValue()', context)).toBe('en');
  });

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
      '.custom-protocol-input',
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
    const customForm = settingsSource.slice(
      settingsSource.indexOf('function _settingsShowCustomModelForm'),
      settingsSource.indexOf('function _settingsOpenModal'),
    );
    expect(customForm).toContain('_settingsCloseAddModal();');
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
      protocol: 'openai',
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
      protocol: 'openai',
      baseUrl: 'https://gateway.example.test/v1',
      model: 'reasoner',
      apiKey: 'key',
      maxTokens: '65536',
    });
  });

  it('shows a localized validation message when main rejects a custom API key header', async () => {
    const { context, elements } = loadSettingsClickHarness(async (channel) => (
      channel === 'auth.addCustomModelEntry'
        ? { ok: false, code: 'CUSTOM_API_KEY_INVALID', error: 'internal fallback' }
        : { ok: true }
    ));
    const body = elements.get('add-account-body')!;
    const actions = elements.get('add-account-actions')!;
    const fields = {
      '.custom-protocol-input': 'openai',
      '.custom-label-input': '',
      '.custom-base-url-input': 'https://gateway.example.test/v1',
      '.custom-model-input': 'acme/reasoner-v2',
      '.custom-max-tokens-input': '',
      '.custom-key-input': 'щ-custom-key',
      '.form-msg': '',
    };
    for (const [selector, value] of Object.entries(fields)) {
      const element = new FakeElement();
      element.value = value;
      body.setQueryResult(selector, element);
    }

    context._settingsShowCustomModelForm({ id: 'custom', label: 'Custom' });
    await actions.children.at(-1)!.click();

    expect(body.querySelector('.form-msg')?.textContent)
      .toBe('settings.custom.error_api_key_invalid');
    for (const locale of ['zh', 'en', 'ja', 'pt']) {
      const messages = JSON.parse(readFileSync(
        resolve(__dirname, `../../src/renderer/locales/${locale}.json`),
        'utf8',
      ));
      expect(messages['settings.custom.error_api_key_invalid'], locale).toBeTruthy();
    }
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
      _oauthFlowOwner = { closeFlow: __closeFlow, settling: false };
      _oauthFlowOwner = { closeFlow: __closeFlow, settling: false };
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
      _oauthFlowOwner = { closeFlow: __closeFlow, settling: false };
      _oauthFlowOwner = { closeFlow: __closeFlow, settling: false };
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
      _oauthFlowOwner = { closeFlow: __closeFlow, settling: false };
      _oauthFlowOwner = { closeFlow: __closeFlow, settling: false };
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

it('shows legacy unsupported video profiles as unavailable instead of active', async () => {
  const { context, elements } = loadSettingsClickHarness(async (channel) => (
    channel === 'videoAuth.list' ? {
      ok: true,
      providers: [{ id: 'orkas-api', provider: 'orkas-api', model: 'orkas-video', label: 'Orkas · Video' }],
      profiles: [{ id: 'legacy', provider: 'doubao', model: 'doubao-seedance-2-0-260128', available: false, label: 'Legacy', apiKeyMasked: '***' }],
    } : { ok: true }
  ));
  await context._settingsRefreshVideoProfiles();
  context._settingsRenderVideoEntries();
  const row = elements.get('settings-video-entries')!.children[0];
  expect(row.className).not.toContain('is-default');
  expect(row.children.find((child) => child.className === 'entry-rank')?.textContent).toBe('new_chat.model_picker.unavailable');
  const main = row.children.find((child) => child.className === 'entry-main');
  expect(main?.children.find((child) => child.className === 'form-hint')?.textContent).toBe('settings.video.provider_unavailable');
});


describe('credential form repeated keyboard submission', () => {
  it.each([
    ['api_key', 'success'], ['api_key', 'rejected'], ['api_key', 'thrown'],
    ['custom', 'success'], ['custom', 'rejected'], ['custom', 'thrown'],
  ])('submits the %s form once while pending and preserves %s recovery', async (method, outcome) => {
    const channel = method === 'custom' ? 'auth.addCustomModelEntry' : 'auth.addApiKeyEntry';
    let release!: (result: Record<string, unknown>) => void;
    let reject!: (error: Error) => void;
    const gate = new Promise<Record<string, unknown>>((resolve, fail) => { release = resolve; reject = fail; });
    let attempts = 0;
    const { context, elements, invoke, monitor } = loadSettingsClickHarness(async current => {
      if (current !== channel) return { ok: true };
      attempts += 1;
      return attempts === 1 ? gate : { ok: true };
    });
    vm.runInContext('_settingsReload = async () => {};', context);
    const body = elements.get('add-account-body')!;
    const values = method === 'custom' ? {
      '.custom-label-input': '', '.custom-protocol-input': '',
      '.custom-base-url-input': 'https://gateway.example.test/v1',
      '.custom-model-input': 'fixture-model', '.custom-max-tokens-input': '',
      '.custom-key-input': 'synthetic-form-key', '.form-msg': '',
    } : {
      '.api-label-input': '', '.api-key-input': 'synthetic-form-key', '.form-msg': '',
    };
    for (const [selector, value] of Object.entries(values)) {
      const field = new FakeElement(); field.value = value; body.setQueryResult(selector, field);
    }
    if (method === 'custom') context._settingsShowCustomModelForm({ id: 'custom', label: 'Custom' });
    else context._settingsShowApiKeyForm({ id: 'openai', label: 'OpenAI' }, 'gpt-5.6-sol');
    const input = body.querySelector(method === 'custom' ? '.custom-key-input' : '.api-key-input')!;
    const save = elements.get('add-account-actions')!.children.at(-1)!;
    try {
      input.keyDown('Enter');
      expect(save.disabled).toBe(true);
      input.keyDown('Enter'); input.keyDown('Enter');
      expect(invoke.mock.calls.filter(call => call[0] === channel)).toHaveLength(1);
      if (outcome === 'thrown') reject(new Error('synthetic write failure'));
      else release(outcome === 'rejected' ? { ok: false, code: 'WRITE_FAILED' } : { ok: true });
      await vi.waitFor(() => expect(outcome === 'success'
        ? elements.get('add-account-modal')!.classList.contains('open') : save.disabled).toBe(false));
      if (outcome === 'success') {
        expect(elements.get('add-account-modal')!.classList.contains('open')).toBe(false);
      } else {
        expect(elements.get('add-account-modal')!.classList.contains('open')).toBe(true);
        expect(save.disabled).toBe(false);
        input.keyDown('Enter');
        await vi.waitFor(() => expect(elements.get('add-account-modal')!.classList.contains('open')).toBe(false));
        expect(invoke.mock.calls.filter(call => call[0] === channel)).toHaveLength(2);
      }
    } finally {
      release({ ok: true });
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  });
});


describe('credential dialog response ownership', () => {
  function openCredential(context: any, elements: Map<string, FakeElement>, method: string) {
    const body = elements.get('add-account-body')!;
    const values = method === 'custom' ? {
      '.custom-label-input': '', '.custom-protocol-input': '',
      '.custom-base-url-input': 'https://gateway.example.test/v1',
      '.custom-model-input': 'fixture-model', '.custom-max-tokens-input': '',
      '.custom-key-input': 'synthetic-dialog-key', '.form-msg': '',
    } : { '.api-label-input': '', '.api-key-input': 'synthetic-dialog-key', '.form-msg': '' };
    for (const [selector, value] of Object.entries(values)) {
      const field = new FakeElement(); field.value = value; body.setQueryResult(selector, field);
    }
    if (method === 'custom') context._settingsShowCustomModelForm({ id: 'custom', label: 'Custom' });
    else context._settingsShowApiKeyForm({ id: 'openai', label: 'OpenAI' }, 'gpt-5.6-sol');
  }

  it.each(['api_key', 'custom'].flatMap(method => [
    [method, 'closed', 'success'], [method, 'reopened', 'success'], [method, 'reopened', 'rejected'],
  ]))('does not close or repaint a newer dialog after %s finishes %s with %s', async (method, destination, outcome) => {
    let release!: (result: Record<string, unknown>) => void;
    const gate = new Promise<Record<string, unknown>>(resolve => { release = resolve; });
    const channel = method === 'custom' ? 'auth.addCustomModelEntry' : 'auth.addApiKeyEntry';
    const { context, elements, invoke, monitor } = loadSettingsClickHarness(async current => current === channel ? gate : { ok: true });
    vm.runInContext('_settingsReload = async () => {};', context);
    openCredential(context, elements, method);
    const actions = elements.get('add-account-actions')!;
    const pending = actions.children.at(-1)!.click();
    try {
      await actions.children.at(-2)!.click();
      if (destination === 'reopened') openCredential(context, elements, method === 'custom' ? 'api_key' : 'custom');
      const body = elements.get('add-account-body')!.innerHTML;
      const title = elements.get('add-account-title')!.textContent;
      release(outcome === 'success' ? { ok: true } : { ok: false, code: 'WRITE_FAILED' });
      await pending;
      expect(elements.get('add-account-modal')!.classList.contains('open')).toBe(destination === 'reopened');
      expect(elements.get('add-account-body')!.innerHTML).toBe(body);
      expect(elements.get('add-account-title')!.textContent).toBe(title);
      expect(invoke.mock.calls.filter(call => call[0] === channel)).toHaveLength(1);
    } finally {
      release({ ok: true }); await pending;
      context._settingsCloseModal(elements.get('add-account-modal'));
    }
  });
});

describe('OAuth dialog asynchronous ownership', () => {
  function controlIntervals(context: any) {
    const active = new Map<number, () => Promise<void>>();
    let next = 0;
    context.setInterval = (callback: () => Promise<void>) => { active.set(++next, callback); return next; };
    context.clearInterval = (id: number) => { active.delete(id); };
    return active;
  }
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it.each(['closed', 'reopened'])('cancels a late startup response after its modal was %s', async destination => {
    let release!: (result: Record<string, unknown>) => void;
    const gate = new Promise<Record<string, unknown>>(resolve => { release = resolve; });
    let starts = 0;
    const { context, elements, invoke } = loadSettingsClickHarness(async channel => {
      if (channel === 'auth.startOAuth') return ++starts === 1 ? gate : { ok: true, flowId: 'new-flow' };
      return { ok: true, status: { kind: 'starting' } };
    });
    const active = controlIntervals(context);
    const pending = context._settingsStartOAuthFlow({ id: 'old-provider' }, 'old-model');
    try {
      await elements.get('oauth-flow-close-btn')!.click();
      if (destination === 'reopened') await context._settingsStartOAuthFlow({ id: 'new-provider' }, 'new-model');
      const body = elements.get('oauth-flow-body')!.innerHTML;
      release({ ok: true, flowId: 'old-flow' }); await pending;
      expect(invoke).toHaveBeenCalledWith('auth.cancelOAuthFlow', { flowId: 'old-flow' });
      expect(active.size).toBe(destination === 'reopened' ? 1 : 0);
      for (const callback of active.values()) await callback();
      const polls = invoke.mock.calls.filter(call => call[0] === 'auth.pollOAuthFlow');
      expect(polls.map(call => call[1])).toEqual(destination === 'reopened' ? [{ flowId: 'new-flow' }] : []);
      expect(elements.get('oauth-flow-modal')!.classList.contains('open')).toBe(destination === 'reopened');
      if (destination === 'closed') expect(elements.get('oauth-flow-body')!.innerHTML).toBe(body);
    } finally {
      release({ ok: true, flowId: 'old-flow' }); await pending;
      await elements.get('oauth-flow-close-btn')!.click(); active.clear();
    }
  });

  it.each(['starting', 'done', 'error'].flatMap(kind => ['closed', 'reopened'].map(destination => [kind, destination])))('discards an obsolete %s poll after the dialog was %s', async (kind, destination) => {
    let release!: (result: Record<string, unknown>) => void;
    const gate = new Promise<Record<string, unknown>>(resolve => { release = resolve; });
    let starts = 0;
    const { context, elements, invoke, monitor } = loadSettingsClickHarness(async channel => {
      if (channel === 'auth.startOAuth') return { ok: true, flowId: ++starts === 1 ? 'old-flow' : 'new-flow' };
      if (channel === 'auth.pollOAuthFlow') return gate;
      return { ok: true };
    });
    vm.runInContext('_settingsReload = async () => {};', context);
    const active = controlIntervals(context);
    await context._settingsStartOAuthFlow({ id: 'old-provider' }, 'old-model');
    const pending = [...active.values()][0]();
    try {
      await elements.get('oauth-flow-close-btn')!.click();
      if (destination === 'reopened') await context._settingsStartOAuthFlow({ id: 'new-provider' }, 'new-model');
      const body = elements.get('oauth-flow-body')!.innerHTML;
      release({ ok: true, status: { kind, profileId: 'old-provider:old-profile', message: 'old progress', error: 'old error' } });
      await pending; await settle();
      expect(invoke.mock.calls.filter(call => ['auth.addEntry', 'auth.removeCredential'].includes(call[0]))).toHaveLength(0);
      expect(elements.get('oauth-flow-body')!.innerHTML).toBe(body);
      expect(elements.get('oauth-flow-modal')!.classList.contains('open')).toBe(destination === 'reopened');
      expect(active.size).toBe(destination === 'reopened' ? 1 : 0);
    } finally {
      release({ ok: true, status: { kind: 'starting' } }); await pending; await settle();
      await elements.get('oauth-flow-close-btn')!.click(); active.clear();
    }
  });

  it('commits one model entry when two in-flight polls return the same completed flow', async () => {
    let releasePoll!: (value: Record<string, unknown>) => void;
    let releaseWrite!: (value: Record<string, unknown>) => void;
    const poll = new Promise<Record<string, unknown>>(resolve => { releasePoll = resolve; });
    const write = new Promise<Record<string, unknown>>(resolve => { releaseWrite = resolve; });
    const { context, elements, invoke, monitor } = loadSettingsClickHarness(async channel => {
      if (channel === 'auth.startOAuth') return { ok: true, flowId: 'single-flow' };
      if (channel === 'auth.pollOAuthFlow') return poll;
      if (channel === 'auth.addEntry') return write;
      return { ok: true };
    });
    vm.runInContext('_settingsReload = async () => {};', context);
    const active = controlIntervals(context);
    await context._settingsStartOAuthFlow({ id: 'openai-codex' }, 'gpt-5.6-sol');
    const callback = [...active.values()][0];
    const pending = [callback(), callback()];
    try {
      releasePoll({ ok: true, status: { kind: 'done', profileId: 'openai-codex:single' } });
      await Promise.all(pending); await settle();
      expect(invoke.mock.calls.filter(call => call[0] === 'auth.addEntry')).toHaveLength(1);
      releaseWrite({ ok: true }); await settle();
      expect(elements.get('oauth-flow-modal')!.classList.contains('open')).toBe(false);
    } finally {
      releasePoll({ ok: true, status: { kind: 'starting' } }); releaseWrite({ ok: true });
      await Promise.all(pending); await settle();
      await elements.get('oauth-flow-close-btn')!.click(); active.clear();
    }
  });
});


describe('OAuth admitted write compatibility across dialog changes', () => {
  it.each(['models', 'entry-success', 'entry-failure', 'cleanup'])('finishes its already-admitted %s operation without changing the newer dialog', async stage => {
    let release!: (result: Record<string, unknown>) => void;
    const gate = new Promise<Record<string, unknown>>(resolve => { release = resolve; });
    let entered = false;
    let starts = 0;
    const { context, elements, invoke, monitor } = loadSettingsClickHarness(async channel => {
      if (channel === 'auth.startOAuth') return { ok: true, flowId: ++starts === 1 ? 'old-flow' : 'new-flow' };
      if (channel === 'auth.pollOAuthFlow') return { ok: true, status: { kind: 'done', profileId: 'backend:completed' } };
      if (channel === 'auth.listModels') {
        if (stage === 'models') { entered = true; return gate; }
        return { ok: true, models: [{ id: 'chosen-model' }] };
      }
      if (channel === 'auth.addEntry') {
        if (stage.startsWith('entry-')) { entered = true; return gate; }
        return stage === 'cleanup' ? { ok: false, code: 'WRITE_FAILED' } : { ok: true };
      }
      if (channel === 'auth.removeCredential' && stage === 'cleanup') { entered = true; return gate; }
      return { ok: true };
    });
    const active = new Map<number, () => Promise<void>>(); let next = 0;
    context.setInterval = (callback: () => Promise<void>) => { active.set(++next, callback); return next; };
    context.clearInterval = (id: number) => { active.delete(id); };
    context.__reload = vi.fn(async () => {});
    vm.runInContext('_settingsReload = __reload;', context);
    await context._settingsStartOAuthFlow({ id: stage === 'models' ? 'visible-provider' : 'backend', oauthProvider: 'backend' }, 'chosen-model');
    const pending = [...active.values()][0]();
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      await elements.get('oauth-flow-close-btn')!.click();
      await context._settingsStartOAuthFlow({ id: 'new-provider' }, 'new-model');
      const body = elements.get('oauth-flow-body')!.innerHTML;
      release(stage === 'models' ? { ok: true, models: [{ id: 'chosen-model' }] }
        : stage === 'entry-failure' ? { ok: false, code: 'WRITE_FAILED' } : { ok: true });
      await pending;
      await new Promise(resolve => setTimeout(resolve, 0));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(invoke.mock.calls.filter(call => call[0] === 'auth.addEntry')).toEqual([[
        'auth.addEntry', { provider: 'backend', model: 'chosen-model', profileId: 'backend:completed' },
      ]]);
      expect(invoke.mock.calls.filter(call => call[0] === 'auth.removeCredential')).toEqual(
        ['entry-failure', 'cleanup'].includes(stage) ? [['auth.removeCredential', { profileId: 'backend:completed' }]] : [],
      );
      expect(context.__reload).toHaveBeenCalledTimes(['models', 'entry-success'].includes(stage) ? 1 : 0);
      expect(elements.get('oauth-flow-modal')!.classList.contains('open')).toBe(true);
      expect(elements.get('oauth-flow-body')!.innerHTML).toBe(body);
      expect(active.size).toBe(1);
    } finally {
      release({ ok: true, models: [{ id: 'chosen-model' }] }); await pending;
      await new Promise(resolve => setTimeout(resolve, 0));
      await elements.get('oauth-flow-close-btn')!.click(); active.clear();
    }
  });
});


it('does not undo the first completed OAuth entry when a duplicate completion would fail', async () => {
  let releasePoll!: (value: Record<string, unknown>) => void;
  let releaseWrite!: (value: Record<string, unknown>) => void;
  const poll = new Promise<Record<string, unknown>>(resolve => { releasePoll = resolve; });
  const write = new Promise<Record<string, unknown>>(resolve => { releaseWrite = resolve; });
  let writes = 0;
  const { context, elements, invoke, monitor } = loadSettingsClickHarness(async channel => {
    if (channel === 'auth.startOAuth') return { ok: true, flowId: 'single-flow' };
    if (channel === 'auth.pollOAuthFlow') return poll;
    if (channel === 'auth.addEntry') {
      if (++writes === 1) return write;
      await write;
      // The first response reaches its success handler before this later
      // failure. Its committed credential must not enter duplicate cleanup.
      return new Promise(resolve => setTimeout(() => resolve({ ok: false, code: 'WRITE_FAILED' }), 0));
    }
    return { ok: true };
  });
  const active = new Map<number, () => Promise<void>>(); let next = 0;
  context.setInterval = (callback: () => Promise<void>) => { active.set(++next, callback); return next; };
  context.clearInterval = (id: number) => { active.delete(id); };
  vm.runInContext('_settingsReload = async () => {};', context);
  await context._settingsStartOAuthFlow({ id: 'openai-codex' }, 'gpt-5.6-sol');
  const callback = [...active.values()][0]; const pending = [callback(), callback()];
  try {
    releasePoll({ ok: true, status: { kind: 'done', profileId: 'openai-codex:committed' } });
    await Promise.all(pending);
    releaseWrite({ ok: true });
    await new Promise(resolve => setTimeout(resolve, 0));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(invoke.mock.calls.filter(call => call[0] === 'auth.removeCredential')).toHaveLength(0);
    expect(invoke.mock.calls.filter(call => call[0] === 'auth.addEntry')).toHaveLength(1);
  } finally {
    releasePoll({ ok: true, status: { kind: 'starting' } }); releaseWrite({ ok: true });
    await Promise.all(pending); await new Promise(resolve => setTimeout(resolve, 0));
    await elements.get('oauth-flow-close-btn')!.click(); active.clear();
  }
});


describe('legacy context capacity remediation', () => {
  it('keeps a too-small saved model visible and removable without ranking or reordering it', () => {
    const { context } = loadSettingsClickHarness();
    const row = context._settingsRenderEntryRow({
      entryId: 'legacy-small', provider: 'custom', model: 'old-small',
      profileId: 'profile-small', modelEditable: false,
      availability: 'context_too_small', availabilityReason: 'Choose a model with at least 32000 tokens.',
    }, null);
    expect(row.draggable).toBe(false);
    expect(row.children.some((child: FakeElement) => child.className === 'entry-sort')).toBe(false);
    expect(row.children.find((child: FakeElement) => child.className === 'entry-rank')?.textContent).toBe('');
    const main = row.children.find((child: FakeElement) => child.className === 'entry-main');
    expect(main?.children.some((child: FakeElement) => child.textContent === 'Choose a model with at least 32000 tokens.')).toBe(true);
    const actions = row.children.find((child: FakeElement) => child.className === 'entry-actions');
    expect(actions?.children.some((child: FakeElement) => child.className === 'icon-btn danger')).toBe(true);
  });
});
