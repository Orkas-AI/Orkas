import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');

class FakeClassList {
  private classes = new Set<string>();

  constructor(initial: string[] = []) {
    initial.forEach((name) => this.classes.add(name));
  }

  add(name: string) { this.classes.add(name); }
  remove(name: string) { this.classes.delete(name); }
  contains(name: string) { return this.classes.has(name); }
  toggle(name: string, force?: boolean) {
    const enabled = force === undefined ? !this.classes.has(name) : force;
    if (enabled) this.classes.add(name);
    else this.classes.delete(name);
    return enabled;
  }
}

class FakeElement {
  classList: FakeClassList;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  value = '';
  scrollHeight = 0;
  private listeners = new Map<string, Array<(event?: any) => void>>();

  constructor(initialClasses: string[] = []) {
    this.classList = new FakeClassList(initialClasses);
  }

  addEventListener(type: string, handler: (event?: any) => void) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  querySelector() { return null; }

  click() {
    for (const handler of this.listeners.get('click') || []) {
      handler({ currentTarget: this, target: this });
    }
  }
}

function loadRendererNavigation() {
  const elements = new Map<string, FakeElement>();
  const panelIds = [
    'panel-new-chat', 'panel-auto', 'panel-agents', 'panel-skills',
    'panel-connectors', 'panel-contexts', 'panel-apps', 'panel-settings',
    'panel-memory', 'panel-devtools', 'panel-project', 'panel-marketplace',
    'panel-conversation',
  ];
  for (const id of panelIds) {
    elements.set(id, new FakeElement(id === 'panel-new-chat' ? ['panel', 'active'] : ['panel']));
  }

  const documentListeners = new Map<string, Array<(event?: any) => void>>();
  const document = {
    documentElement: { classList: new FakeClassList() },
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id)!;
    },
    querySelectorAll(selector: string) {
      if (selector === '.panel') return panelIds.map((id) => elements.get(id)!);
      return [];
    },
    addEventListener(type: string, handler: (event?: any) => void) {
      const handlers = documentListeners.get(type) || [];
      handlers.push(handler);
      documentListeners.set(type, handlers);
    },
  };

  const loadRendererFeature = vi.fn(async () => undefined);
  const loadSettings = vi.fn(async () => undefined);
  const noop = () => undefined;
  const window = {
    addEventListener: noop,
    orkas: {},
    loadRendererFeature,
  } as any;
  window.window = window;

  const context: any = {
    window,
    document,
    navigator: { userAgent: 'test' },
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, length: 0, key: () => null },
    performance: { now: () => 0 },
    requestAnimationFrame: (handler: () => void) => { handler(); return 1; },
    setTimeout,
    clearTimeout,
    createLogger: () => ({ info: noop, warn: noop, error: noop, debug: noop }),
    loadRendererFeature,
    loadSettings,
    _bindGlobalSearch: noop,
    handleNewChatSubmit: noop,
    handleChatSubmit: noop,
    toggleAgentEditMode: noop,
    deleteSelectedAgent: noop,
    clearAgentChat: noop,
    bindAgentPickers: noop,
  };

  vm.createContext(context);
  for (const file of ['state.js', 'boot.js']) {
    const source = fs.readFileSync(path.join(root, 'src/renderer/modules', file), 'utf8');
    vm.runInContext(source, context, { filename: file });
  }
  return { context, elements, loadRendererFeature, loadSettings };
}

describe('settings sidebar navigation', () => {
  it('opens the settings panel and starts its lazy feature from a real click binding', async () => {
    const { context, elements, loadRendererFeature, loadSettings } = loadRendererNavigation();

    context.bindStaticHandlers();
    elements.get('settings-btn')!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(elements.get('panel-settings')!.classList.contains('active')).toBe(true);
    expect(elements.get('panel-new-chat')!.classList.contains('active')).toBe(false);
    expect(elements.get('settings-btn')!.classList.contains('active')).toBe(true);
    expect(loadRendererFeature).toHaveBeenCalledWith('settings');
    expect(loadSettings).toHaveBeenCalledOnce();
  });
});
