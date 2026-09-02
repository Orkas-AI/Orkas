import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class FakeElement {
  value = '';
  hidden = false;
  disabled = false;
  textContent = '';
  className = '';
  innerHTML = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeElement[] = [];
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Array<(event?: any) => unknown>>();

  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  getAttribute(name: string) { return this.attributes.get(name) || null; }
  removeAttribute(name: string) { this.attributes.delete(name); }
  appendChild(child: FakeElement) { this.children.push(child); return child; }
  querySelector() { return null; }

  addEventListener(type: string, handler: (event?: any) => unknown) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  async dispatch(type: string, event: Record<string, unknown> = {}) {
    for (const handler of this.listeners.get(type) || []) {
      await handler({ currentTarget: this, target: this, preventDefault: vi.fn(), ...event });
    }
  }

  click() { return this.dispatch('click'); }
}

function loadQuickSetupHarness(language = 'en') {
  const source = readFileSync(resolve(__dirname, '../../src/renderer/modules/settings.js'), 'utf8');
  const html = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
  const elements = new Map<string, FakeElement>();
  for (const id of [
    'settings-orkas-api-create-key',
    'settings-orkas-api-key-input',
    'settings-orkas-api-configure',
    'settings-orkas-api-status',
    'settings-entries',
    'settings-search-entries',
    'settings-image-entries',
    'settings-video-entries',
    'settings-tts-entries',
  ]) elements.set(id, new FakeElement());

  const invoke = vi.fn(async () => ({ ok: true }));
  const refreshModelGuard = vi.fn(async () => true);
  const context: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string) => key,
    getLang: () => language,
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: () => new FakeElement(),
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
    refreshModelGuard,
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'settings.js' });
  vm.runInContext(`
    window.__orkasApiRefreshes = 0;
    _settingsRefreshAllCredentialSections = async () => { window.__orkasApiRefreshes += 1; };
    _settingsBindOrkasApiOnce();
  `, context);
  return { context, elements, html, source, invoke, refreshModelGuard };
}

describe('Orkas public API quick setup', () => {
  it('uses concise configure copy in every supported locale', () => {
    const html = readFileSync(resolve(__dirname, '../../src/renderer/index.html'), 'utf8');
    expect(html).toContain('data-i18n="settings.orkas_api.configure">Configure</button>');

    const expected = { en: 'Configure', zh: '配置', ja: '設定', pt: 'Configurar' };
    for (const [locale, copy] of Object.entries(expected)) {
      const catalog = JSON.parse(readFileSync(
        resolve(__dirname, `../../src/renderer/locales/${locale}.json`),
        'utf8',
      ));
      expect(catalog['settings.orkas_api.configure']).toBe(copy);
      expect(catalog).not.toHaveProperty('settings.orkas_api.configure_all');
    }
  });

  it('uses the standard settings card background and border', () => {
    const css = readFileSync(resolve(__dirname, '../../src/renderer/style.css'), 'utf8');
    expect(css).toMatch(/\.settings-group\s*{[^}]*background:\s*var\(--surface\);[^}]*border:\s*1px solid var\(--border\);/s);
    expect(css).not.toContain('.settings-orkas-api-group::before');
    expect(css).not.toMatch(/\.settings-orkas-api-group\s*{[^}]*(?:linear-gradient|border-color)/s);
  });

  it('uses the complete Orkas service labels in pickers and configured rows', () => {
    const { context, elements, source } = loadQuickSetupHarness();
    expect(source).not.toContain("label: 'Orkas API'");
    expect(vm.runInContext("_SEARCH_PROVIDER_OPTIONS.find((p) => p.id === 'orkas-api').label", context))
      .toBe('Orkas · Search');
    expect(vm.runInContext("_IMAGE_PROVIDER_OPTIONS.find((p) => p.id === 'orkas-api').label", context))
      .toBe('Orkas · Image');
    expect(vm.runInContext("_VIDEO_AUTH_PROVIDER_OPTIONS.find((p) => p.id === 'orkas-api').label", context))
      .toBe('Orkas · Video');
    expect(vm.runInContext("_ttsProviderLabel('orkas-api')", context)).toBe('Orkas · Voice');

    vm.runInContext(`
      _settingsAttachReorderDnd = () => {};
      _settingsState.searchProfiles = [{ id: 's1', provider: 'orkas-api', label: 'Orkas', apiKeyMasked: 'sk-…1' }];
      _settingsState.imageProfiles = [{ id: 'i1', provider: 'orkas-api', model: 'orkas-image', label: 'Orkas', apiKeyMasked: 'sk-…1' }];
      _settingsState.videoProfiles = [{ id: 'v1', provider: 'orkas-api', model: 'orkas-video', label: 'Orkas', apiKeyMasked: 'sk-…1' }];
      _settingsState.ttsProfiles = [{ id: 't1', provider: 'orkas-api', model: 'orkas-tts-1', label: 'Orkas', apiKeyMasked: 'sk-…1' }];
      _settingsRenderSearchEntries();
      _settingsRenderImageEntries();
      _settingsRenderVideoEntries();
      _settingsRenderTtsEntries();
    `, context);

    const configuredLabel = (id: string) => elements.get(id)!
      .children[0]!.children[1]!.children[0]!.innerHTML;
    expect(configuredLabel('settings-search-entries')).toContain('>Orkas · Search</span>');
    expect(configuredLabel('settings-image-entries')).toContain('>Orkas · Image</span>');
    expect(configuredLabel('settings-video-entries')).toContain('>Orkas · Video</span>');
    expect(configuredLabel('settings-tts-entries')).toContain('>Orkas · Voice</span>');
    expect(source).toContain('settings.orkas_api.recommended');
    expect(source).toContain('settings.orkas_api.includes');
  });

  it('renders both configured official model rows in Settings', () => {
    const { context, elements } = loadQuickSetupHarness();
    context.t = (key: string, values?: { models?: string }) => (
      values?.models ? `${key}: ${values.models}` : key
    );
    vm.runInContext(`
      _settingsAttachReorderDnd = () => {};
      _settingsState.entries = [
        {
          entryId: 'orkas-standard', provider: 'orkas-api', providerLabel: 'Orkas',
          model: 'orkas-llm-1.5', modelName: 'Orkas-1.5', modelEditable: false,
          modelAvailable: true, official: true, recommended: true,
          includedModels: ['DeepSeek V4', 'GPT-5.6 Luna', 'Claude-Sonnet-5', 'Gemini-3.6 Flash'],
          profileType: 'api_key', profileAvailable: true, profileLabel: 'Orkas'
        },
        {
          entryId: 'orkas-pro', provider: 'orkas-api', providerLabel: 'Orkas',
          model: 'orkas-llm-1.5-pro', modelName: 'Orkas-1.5 Pro', modelEditable: false,
          modelAvailable: true, official: true,
          includedModels: ['GPT-5.6 Sol', 'Claude Opus 5', 'Kimi K3'],
          profileType: 'api_key', profileAvailable: true, profileLabel: 'Orkas'
        }
      ];
      _settingsRenderEntries();
    `, context);

    const rows = elements.get('settings-entries')!.children;
    expect(rows).toHaveLength(2);
    expect(rows[0]!.children[1]!.children[0]!.innerHTML).toContain('Orkas-1.5');
    expect(rows[1]!.children[1]!.children[0]!.innerHTML).toContain('Orkas-1.5 Pro');
    expect(rows[0]!.children[1]!.children[1]!.children[1]!.textContent)
      .toContain('DeepSeek V4 · GPT-5.6 Luna · Claude-Sonnet-5 · Gemini-3.6 Flash');
    expect(rows[1]!.children[1]!.children[1]!.children[1]!.textContent)
      .toContain('GPT-5.6 Sol · Claude Opus 5 · Kimi K3');
  });

  it('configures all services from the real card click binding without exposing a clear action', async () => {
    const { context, elements, html, source, invoke, refreshModelGuard } = loadQuickSetupHarness();
    for (const id of [
      'settings-orkas-api-group',
      'settings-orkas-api-key-input',
      'settings-orkas-api-configure',
    ]) expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('settings-orkas-api-clear');
    expect(source).not.toContain('orkasApi.clearAll');
    expect(source).not.toContain('/v1/capabilities');

    elements.get('settings-orkas-api-key-input')!.value = '  public-orkas-key  ';
    await elements.get('settings-orkas-api-create-key')!.click();
    await elements.get('settings-orkas-api-configure')!.click();

    expect(invoke).toHaveBeenCalledWith('auth.openExternal', {
      url: 'https://orkas.ai/views/account/account.html?lang=en#api-keys',
    });
    expect(invoke).toHaveBeenCalledWith('orkasApi.configureAll', {
      apiKey: 'public-orkas-key',
    });
    expect(elements.get('settings-orkas-api-key-input')!.value).toBe('');
    expect(vm.runInContext('window.__orkasApiRefreshes', context)).toBe(1);
    expect(refreshModelGuard).toHaveBeenCalledOnce();
  });

  it.each(['zh', 'en', 'ja', 'pt'])('carries the %s desktop language to the API-key page', async (language) => {
    const { elements, invoke } = loadQuickSetupHarness(language);

    await elements.get('settings-orkas-api-create-key')!.click();

    expect(invoke).toHaveBeenCalledWith('auth.openExternal', {
      url: `https://orkas.ai/views/account/account.html?lang=${language}#api-keys`,
    });
  });

  it('preserves existing query parameters and fragments while localizing Orkas Web URLs', () => {
    const { context } = loadQuickSetupHarness('ja');

    expect(vm.runInContext(
      "_settingsLocalizedOrkasWebUrl('https://orkas.ai/views/account/account.html?source=settings#api-keys')",
      context,
    )).toBe('https://orkas.ai/views/account/account.html?source=settings&lang=ja#api-keys');
    expect(vm.runInContext(
      "_settingsLocalizedOrkasWebUrl('https://example.com/account?source=settings#api-keys')",
      context,
    )).toBe('https://example.com/account?source=settings#api-keys');
  });

  it('keeps dynamic setup status bound to an i18n key after language changes', async () => {
    const { context, elements } = loadQuickSetupHarness();
    elements.get('settings-orkas-api-key-input')!.value = 'public-orkas-key';
    await elements.get('settings-orkas-api-configure')!.click();

    const status = elements.get('settings-orkas-api-status')!;
    expect(status.getAttribute('data-i18n')).toBe('settings.orkas_api.configure_ok');
    context.t = (key: string) => `translated:${key}`;
    vm.runInContext('_settingsRenderOrkasApiCard()', context);
    expect(status.textContent).toBe('translated:settings.orkas_api.configure_ok');
  });

  it('supports Enter to configure and blocks an empty key before IPC', async () => {
    const { elements, invoke } = loadQuickSetupHarness();
    const keyInput = elements.get('settings-orkas-api-key-input')!;
    await keyInput.dispatch('keydown', { key: 'Enter', isComposing: false });
    expect(invoke).not.toHaveBeenCalledWith('orkasApi.configureAll', expect.anything());

    keyInput.value = 'enter-key';
    await keyInput.dispatch('keydown', { key: 'Enter', isComposing: false });
    expect(invoke).toHaveBeenCalledWith('orkasApi.configureAll', { apiKey: 'enter-key' });
  });
});
