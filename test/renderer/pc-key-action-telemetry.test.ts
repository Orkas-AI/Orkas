import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const modelSource = readFileSync(resolve(__dirname, '../../src/renderer/modules/composer-model-picker.js'), 'utf8');
const styleSource = readFileSync(resolve(__dirname, '../../src/renderer/style.css'), 'utf8');

function extractFunction(source: string, name: string): string {
  const asyncMarker = `async function ${name}`;
  const syncMarker = `function ${name}`;
  const start = source.indexOf(asyncMarker) >= 0
    ? source.indexOf(asyncMarker)
    : source.indexOf(syncMarker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

describe('public composer model selection', () => {
  it('logs model version discovery failures without exposing provider responses', async () => {
    const warn = vi.fn();
    const context: any = {
      Map,
      _composerModelOptionsByProvider: new Map(),
      _composerModelLog: { warn },
      window: {
        orkas: { invoke: vi.fn(async () => { throw new Error('provider response'); }) },
      },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(modelSource, '_composerModelEntryIsOfficial'),
      extractFunction(modelSource, '_refreshComposerModelOptions'),
    ].join('\n'), context);

    await context._refreshComposerModelOptions([{
      provider: 'openai',
      profileType: 'custom',
      modelEditable: true,
      selectable: true,
    }]);

    expect(warn).toHaveBeenCalledWith('model version discovery failed', { provider: 'openai' });
    expect(context._composerModelOptionsByProvider.get('openai')).toEqual([]);
  });

  it('positions model versions as a viewport-aware cascade instead of expanding the parent menu', () => {
    const context: any = { Math };
    vm.createContext(context);
    vm.runInContext(
      extractFunction(modelSource, '_composerModelCascadePlacement'),
      context,
    );

    expect(context._composerModelCascadePlacement(
      { left: 300, right: 500, top: 100 },
      { width: 220, height: 240 },
      1000,
      800,
    )).toMatchObject({ left: 505, top: 100, openLeft: false });
    expect(context._composerModelCascadePlacement(
      { left: 850, right: 950, top: 700 },
      { width: 220, height: 240 },
      1000,
      800,
    )).toMatchObject({ left: 625, top: 552, openLeft: true });
    expect(styleSource).toMatch(/\.composer-model-menu-version-list\s*\{[^}]*position:\s*fixed/s);
    expect(styleSource).not.toMatch(/\.composer-model-menu-version-list\s*\{[^}]*border-left/s);
  });

  it('shows the configured model on the provider row and keeps a fixed endpoint directly selectable', () => {
    class Element {
      type = '';
      className = '';
      textContent = '';
      innerHTML = '';
      disabled = false;
      dataset: Record<string, string> = {};
      children: Element[] = [];
      attributes = new Map<string, string>();
      listeners = new Map<string, () => unknown>();
      classList = { add: (name: string) => { this.className += ` ${name}`; } };
      setAttribute(name: string, value: string) { this.attributes.set(name, value); }
      getAttribute(name: string) { return this.attributes.get(name); }
      appendChild(child: Element) { this.children.push(child); return child; }
      addEventListener(name: string, handler: () => unknown) { this.listeners.set(name, handler); }
      focus() {}
    }
    const context: any = {
      Map,
      document: { createElement: () => new Element() },
      window: {},
      _composerModelOptionsByProvider: new Map(),
      _clearComposerModelVersionCloseTimer() {},
      _scheduleComposerModelVersionMenuClose() {},
      t: (key: string, values?: { account?: string }) => {
        if (key === 'provider.custom.label') return 'Custom (OpenAI-compatible)';
        return values?.account ? `${key}:${values.account}` : key;
      },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(modelSource, '_composerModelEntryLabel'),
      extractFunction(modelSource, '_composerModelProviderLabel'),
      extractFunction(modelSource, '_composerModelAccountLabel'),
      extractFunction(modelSource, '_composerModelEntryIsOfficial'),
      extractFunction(modelSource, '_composerModelVersionOptions'),
      extractFunction(modelSource, '_composerModelOfficialIncludedBody'),
      extractFunction(modelSource, '_composerModelOfficialDescription'),
      extractFunction(modelSource, '_buildComposerModelMenuItem'),
    ].join('\n'), context);

    const entry = {
      entryId: 'fixed-custom',
      provider: 'custom',
      providerLabel: 'Custom (OpenAI-compatible)',
      providerLabelKey: 'provider.custom.label',
      model: 'private-fixed-model',
      modelName: 'private-fixed-model',
      modelEditable: false,
      profileType: 'api_key',
      profileLabel: 'Team gateway',
      selectable: true,
    };
    const item = context._buildComposerModelMenuItem(
      entry,
      '',
      { dataset: { composerModelChip: 'new-chat' }, focus() {} },
    );

    const select = item.children[0];
    const copy = select.children[0];
    expect(copy.children[0].children[0].textContent).toBe('Custom (OpenAI-compatible)');
    expect(copy.children[1].children[0].textContent).toBe('Team gateway');
    expect(copy.children[1].children[2].textContent).toBe('private-fixed-model');
    expect(item.children).toHaveLength(1);
    expect(select.getAttribute('aria-haspopup')).toBeUndefined();
    expect(context._composerModelVersionOptions(entry)).toEqual([
      { id: 'private-fixed-model', name: 'private-fixed-model' },
    ]);
  });

  it('updates a nested model without promoting its provider row and marks it with a dot', async () => {
    function makeVersionItem(model: string, current: boolean) {
      let dot: any = current ? { className: 'composer-model-menu-version-current-dot' } : null;
      const classes = new Set<string>();
      const versionItem = {
        dataset: { model },
        attributes: new Map<string, string>(),
        classList: { toggle: (name: string, enabled: boolean) => (
          enabled ? classes.add(name) : classes.delete(name)
        ) },
        setAttribute(name: string, value: string) { this.attributes.set(name, value); },
        querySelector: () => dot,
        appendChild(nextDot: any) {
          dot = nextDot;
          nextDot.remove = () => { dot = null; };
        },
        get dot() { return dot; },
      };
      if (dot) dot.remove = () => { dot = null; };
      return versionItem;
    }
    const first = { entryId: 'active-entry', model: 'active-model', modelName: 'Active model' };
    const entry = {
      entryId: 'deepseek-entry',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      modelName: 'DeepSeek V4 Pro',
      profileType: 'api_key',
      selectable: true,
    };
    const oldVersion = makeVersionItem('deepseek-v4-pro', true);
    const nextVersion = makeVersionItem('deepseek-v4-flash', false);
    const replaceChildren = vi.fn();
    const invoke = vi.fn(async () => ({ ok: true }));
    const context: any = {
      _composerModelBusy: false,
      _composerModelEntries: [first, entry],
      _renderComposerModelChips: vi.fn(),
      CustomEvent: class CustomEvent {},
      Date,
      Math,
      document: {
        createElement: () => ({
          className: '',
          textContent: '',
          setAttribute() {},
        }),
      },
      window: {
        dispatchEvent: vi.fn(),
        orkas: { invoke },
      },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(modelSource, '_composerModelEntryIsOfficial'),
      extractFunction(modelSource, '_setComposerModelVersionItemCurrent'),
      extractFunction(modelSource, '_updateComposerModelVersion'),
    ].join('\n'), context);

    await context._updateComposerModelVersion(
      entry,
      'conversation',
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { querySelector: () => ({ replaceChildren }) },
      { querySelectorAll: () => [oldVersion, nextVersion] },
    );

    expect(invoke).toHaveBeenCalledWith('auth.updateEntryModel', {
      entryId: 'deepseek-entry',
      model: 'deepseek-v4-flash',
    });
    expect(context._composerModelEntries.map((candidate: { entryId: string }) => candidate.entryId))
      .toEqual(['active-entry', 'deepseek-entry']);
    expect(replaceChildren).toHaveBeenCalledWith('DeepSeek V4 Flash');
    expect(oldVersion.dot).toBeNull();
    expect(nextVersion.dot.textContent).toBe('●');
    expect(nextVersion.attributes.get('aria-checked')).toBe('true');
  });

  it('does not persist the already-selected model version', async () => {
    const invoke = vi.fn();
    const entry = {
      entryId: 'deepseek-entry',
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      profileType: 'api_key',
      selectable: true,
    };
    const context: any = {
      _composerModelBusy: false,
      _composerModelEntries: [entry],
      Date,
      Math,
      window: { orkas: { invoke } },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(modelSource, '_composerModelEntryIsOfficial'),
      extractFunction(modelSource, '_updateComposerModelVersion'),
    ].join('\n'), context);

    await context._updateComposerModelVersion(
      entry,
      'new-chat',
      { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    );

    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not persist the already-active first-level model', async () => {
    const invoke = vi.fn();
    const entry = {
      entryId: 'active-entry-id',
      profileType: 'api_key',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      selectable: true,
    };
    const context: any = {
      _composerModelBusy: false,
      _composerModelEntries: [entry],
      Date,
      Math,
      window: { orkas: { invoke } },
    };
    vm.createContext(context);
    vm.runInContext([
      extractFunction(modelSource, '_composerModelEntryIsOfficial'),
      extractFunction(modelSource, '_selectComposerModel'),
    ].join('\n'), context);

    await context._selectComposerModel(entry, 'new-chat');

    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not select a disabled public API-key entry through the action boundary', async () => {
    const invoke = vi.fn();
    const entry = {
      entryId: 'disabled-public-entry', provider: 'custom', profileType: 'api_key',
      model: 'fixture-model', selectable: false,
    };
    const context: any = {
      _composerModelBusy: false,
      _composerModelEntries: [],
      window: { orkas: { invoke } },
    };
    vm.createContext(context);
    vm.runInContext(extractFunction(modelSource, '_selectComposerModel'), context);
    await context._selectComposerModel(entry, 'new-chat');
    expect(invoke).not.toHaveBeenCalled();
    expect(context._composerModelBusy).toBe(false);
  });

});
