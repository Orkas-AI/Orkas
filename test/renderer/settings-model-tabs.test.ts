import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const settingsSource = readFileSync(
  resolve(__dirname, '../../src/renderer/modules/settings.js'),
  'utf8',
);

const KINDS = ['chat', 'search', 'image', 'video', 'tts'];

class FakeClassList {
  private readonly values = new Set<string>();
  toggle(name: string, force: boolean) {
    if (force) this.values.add(name);
    else this.values.delete(name);
    return force;
  }
  contains(name: string) { return this.values.has(name); }
}

class FakeTab {
  dataset: Record<string, string>;
  classList = new FakeClassList();
  tabIndex = -1;
  attributes: Record<string, string> = {};
  focused = false;
  private readonly listeners = new Map<string, Array<(event?: unknown) => unknown>>();
  constructor(kind: string) { this.dataset = { settingsModelTab: kind }; }
  addEventListener(type: string, handler: (event?: unknown) => unknown) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
  focus() { this.focused = true; }
  click() { for (const handler of this.listeners.get('click') || []) handler({ currentTarget: this }); }
  keydown(key: string) {
    const event = { key, preventDefault: vi.fn() };
    for (const handler of this.listeners.get('keydown') || []) handler(event);
    return event;
  }
}

class FakePanel {
  hidden = false;
  dataset: Record<string, string>;
  constructor(kind: string) { this.dataset = { settingsModelPanel: kind }; }
}

function loadHarness() {
  const tabs = KINDS.map((kind) => new FakeTab(kind));
  const panels = KINDS.map((kind) => new FakePanel(kind));
  const click = vi.fn();
  const sandbox: any = {
    console,
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value ?? ''),
    document: {
      getElementById: () => null,
      querySelectorAll: (selector: string) => {
        if (selector === '[data-settings-model-tab]') return tabs;
        if (selector === '[data-settings-model-panel]') return panels;
        return [];
      },
    },
    Monitor: { click, event: vi.fn(), error: vi.fn() },
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke: vi.fn(async () => ({ ok: true })) },
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    URL,
  };
  sandbox.window.Monitor = sandbox.Monitor;
  vm.runInNewContext(settingsSource, sandbox, { filename: 'settings.js' });
  return { sandbox, tabs, panels, click };
}

const visibleKinds = (panels: FakePanel[]) => panels
  .filter((panel) => !panel.hidden)
  .map((panel) => panel.dataset.settingsModelPanel);

describe('Settings → Models purpose sub-tabs', () => {
  it('activates the chat sub-tab on bind without emitting navigation telemetry', () => {
    const { sandbox, tabs, panels, click } = loadHarness();
    sandbox._settingsBindModelTabsOnce();

    expect(visibleKinds(panels)).toEqual(['chat']);
    expect(tabs[0].classList.contains('is-active')).toBe(true);
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[0].attributes['aria-selected']).toBe('true');
    expect(tabs[1].tabIndex).toBe(-1);
    expect(tabs[1].attributes['aria-selected']).toBe('false');
    expect(click).not.toHaveBeenCalled();
  });

  it('switches on an explicit click without PC telemetry', () => {
    const { sandbox, tabs, panels, click } = loadHarness();
    sandbox._settingsBindModelTabsOnce();

    tabs[2].click();

    expect(visibleKinds(panels)).toEqual(['image']);
    expect(tabs[2].classList.contains('is-active')).toBe(true);
    expect(tabs[0].classList.contains('is-active')).toBe(false);
    expect(click).not.toHaveBeenCalled();
  });

  it('treats arrow-key navigation as an explicit selection and wraps around', () => {
    const { sandbox, tabs, panels, click } = loadHarness();
    sandbox._settingsBindModelTabsOnce();

    const event = tabs[0].keydown('ArrowLeft');

    expect(event.preventDefault).toHaveBeenCalled();
    expect(visibleKinds(panels)).toEqual(['tts']);
    expect(tabs[4].focused).toBe(true);
    expect(click).not.toHaveBeenCalled();

    tabs[4].keydown('Home');
    expect(visibleKinds(panels)).toEqual(['chat']);
    expect(click).not.toHaveBeenCalled();
  });

  it('keeps programmatic activation silent and falls back to chat for unknown kinds', () => {
    const { sandbox, panels, click } = loadHarness();
    sandbox._settingsBindModelTabsOnce();

    sandbox._settingsActivateModelTab('video');
    expect(visibleKinds(panels)).toEqual(['video']);
    sandbox._settingsActivateModelTab('bogus');
    expect(visibleKinds(panels)).toEqual(['chat']);
    expect(click).not.toHaveBeenCalled();
  });
});

describe('Settings model reorder recovery', () => {
  class Element {
    children: Element[] = [];
    disabled = false;
    className = '';
    listeners: Record<string, (event: { stopPropagation(): void }) => unknown> = {};
    prepend(child: Element) { this.children.unshift(child); }
    appendChild(child: Element) { this.children.push(child); }
    setAttribute() {}
    addEventListener(type: string, handler: Element['listeners'][string]) { this.listeners[type] = handler; }
    async click() { await this.listeners.click({ stopPropagation() {} }); }
  }

  it.each(['rejected result', 'rejected IPC'])('allows retry after a %s and respects the updated boundary', async (failure) => {
    const { sandbox } = loadHarness();
    sandbox.document.createElement = () => new Element();
    sandbox.uiAlert = vi.fn(async () => undefined);
    const invoke = sandbox.window.orkas.invoke;
    if (failure === 'rejected IPC') invoke.mockRejectedValueOnce(new Error('fixture transport failure'));
    else invoke.mockResolvedValueOnce({ ok: false, error: 'fixture save failure' });
    let ids = ['first', 'middle', 'last'];
    const onSuccess = vi.fn(async () => { ids = ['middle', 'first', 'last']; });
    const row = new Element();
    await sandbox._settingsAttachReorderDnd(row, {
      kind: 'chat', id: 'middle', getIds: () => ids, ipcName: 'auth.reorderEntries', onSuccess,
    });
    const [up, down] = row.children.find(child => child.className === 'entry-sort')!.children;
    await up.click();
    expect(sandbox.uiAlert).toHaveBeenCalledOnce();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(up.disabled).toBe(false);
    await up.click();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenLastCalledWith('auth.reorderEntries', { orderedIds: ['middle', 'first', 'last'] });
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(up.disabled).toBe(true);
    expect(down.disabled).toBe(false);
    await up.click();
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('does not dispatch a duplicate move while saving', async () => {
    const { sandbox } = loadHarness();
    sandbox.document.createElement = () => new Element();
    sandbox.uiAlert = vi.fn(async () => undefined);
    let finish!: (result: { ok: boolean }) => void;
    sandbox.window.orkas.invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const row = new Element();
    await sandbox._settingsAttachReorderDnd(row, {
      kind: 'search', id: 'last', getIds: () => ['first', 'last'],
      ipcName: 'search.reorderProfiles', onSuccess: vi.fn(),
    });
    const [up, down] = row.children.find(child => child.className === 'entry-sort')!.children;
    expect(down.disabled).toBe(true);
    const saving = up.click();
    await up.click();
    expect(sandbox.window.orkas.invoke).toHaveBeenCalledOnce();
    finish({ ok: false });
    await saving;
    expect(up.disabled).toBe(false);
  });
});
