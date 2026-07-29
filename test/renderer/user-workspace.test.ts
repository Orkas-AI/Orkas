import { describe, it, expect, beforeEach } from 'vitest';

type Dataset = Record<string, string>;

class FakeElement {
  tagName: string;
  className = '';
  dataset: Dataset = {};
  parentNode: FakeElement | null = null;
  childNodes: FakeElement[] = [];
  type = '';
  title = '';
  innerHTML = '';
  id = '';
  textContent = '';
  scrollHeight = 0;
  style: Record<string, string> = {};
  rect = { top: 0, bottom: 150, left: 0, width: 200, height: 150 };

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  get nextSibling(): FakeElement | null {
    if (!this.parentNode) return null;
    const index = this.parentNode.childNodes.indexOf(this);
    return index >= 0 ? (this.parentNode.childNodes[index + 1] || null) : null;
  }

  get classList() {
    return {
      contains: (cls: string) => this.className.split(/\s+/).filter(Boolean).includes(cls),
      add: (cls: string) => {
        if (!this.classList.contains(cls)) this.className = `${this.className} ${cls}`.trim();
      },
      remove: (cls: string) => {
        this.className = this.className.split(/\s+/).filter((part) => part && part !== cls).join(' ');
      },
    };
  }

  appendChild(child: FakeElement) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore(child: FakeElement, ref: FakeElement | null) {
    if (child.parentNode) child.remove();
    child.parentNode = this;
    const index = ref ? this.childNodes.indexOf(ref) : -1;
    if (index >= 0) this.childNodes.splice(index, 0, child);
    else this.childNodes.push(child);
    return child;
  }

  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    const index = siblings.indexOf(this);
    if (index >= 0) siblings.splice(index, 1);
    this.parentNode = null;
  }

  addEventListener() {}

  contains(target: FakeElement): boolean {
    if (target === this) return true;
    return this.childNodes.some((child) => child.contains(target));
  }

  getBoundingClientRect() {
    return this.rect;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const visit = (node: FakeElement) => {
      for (const child of node.childNodes) {
        if (child.matches(selector)) out.push(child);
        visit(child);
      }
    };
    visit(this);
    return out;
  }

  matches(selector: string): boolean {
    const match = selector.match(/^\.([a-z0-9_-]+)(?:\[data-ws-target="([^"]+)"\])?$/i);
    if (!match) return false;
    const [, className, wsTarget] = match;
    if (!this.classList.contains(className)) return false;
    return !wsTarget || this.dataset.wsTarget === wsTarget;
  }
}

function makeBar() {
  const bar = new FakeElement('div');
  bar.className = 'chat-bottom-bar';
  const recipient = new FakeElement('button');
  recipient.className = 'chat-recipient-chip';
  const skill = new FakeElement('div');
  skill.className = 'chat-skill-chip';
  const send = new FakeElement('button');
  send.className = 'chat-send-btn';
  bar.appendChild(recipient);
  bar.appendChild(skill);
  bar.appendChild(send);
  return { bar, recipient, skill, send };
}

function loadUserWorkspace() {
  // Production loads this dependency first via index.html.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const placement = require('../../src/renderer/modules/dropdown-placement.js');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any)._dropdownVerticalPlacement = placement._dropdownVerticalPlacement;
  const body = new FakeElement('body');
  const windowListeners = new Map<string, Array<() => void>>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).document = {
    body,
    documentElement: { clientWidth: 800, clientHeight: 600 },
    createElement: (tagName: string) => new FakeElement(tagName),
    querySelector: () => null,
    getElementById: (id: string) => {
      const visit = (node: FakeElement): FakeElement | null => {
        if (node.id === id) return node;
        for (const child of node.childNodes) {
          const found = visit(child);
          if (found) return found;
        }
        return null;
      };
      return visit(body);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).window = {
    innerWidth: 800,
    innerHeight: 600,
    uiIconHtml: () => '<span class="workspace-chip-chevron"></span>',
    addEventListener: (type: string, listener: () => void) => {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).__workspaceWindowListeners = windowListeners;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).t = (key: string) => ({
    'workspace.chip_title': 'Pick workspace',
    'workspace.chip_label': 'Workspace: ',
    'workspace.default_header': 'Default',
    'workspace.unselected': 'Not selected',
  } as Record<string, string>)[key] || key;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).escapeHtml = (value: unknown) => String(value ?? '');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('../../src/renderer/modules/user-workspace.js') as {
    _mountWorkspaceChipInBar: (bar: FakeElement, target: string) => FakeElement | null;
    _showWorkspaceDropdown: (anchor: FakeElement, target: string) => void;
    _wsDisplayName: (info: { currentPath: string; isDefault: boolean }) => string;
    _wsInfoByTarget: Record<string, {
      currentPath: string;
      defaultPath: string;
      isDefault: boolean;
      recentPaths: string[];
      scope: string;
    }>;
    _workspaceMenuPlacement: (
      anchorRect: { top: number; bottom: number; left: number },
      menuRect: { width: number; height: number },
      viewportWidth: number,
      viewportHeight: number,
    ) => { left: number; top: number; maxWidth: number; maxHeight: number; openAbove: boolean };
  };
}

describe('user workspace chip mount', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../../src/renderer/modules/user-workspace.js')];
  });

  it('is idempotent for the same composer target', () => {
    const { _mountWorkspaceChipInBar } = loadUserWorkspace();
    const { bar, recipient, skill } = makeBar();

    const first = _mountWorkspaceChipInBar(bar, 'new-chat');
    const second = _mountWorkspaceChipInBar(bar, 'new-chat');

    expect(second).toBe(first);
    expect(bar.querySelectorAll('.workspace-chip[data-ws-target="new-chat"]')).toHaveLength(1);
    expect(bar.childNodes).toEqual([recipient, first, skill, bar.querySelector('.chat-send-btn')]);
  });

  it('removes duplicate chips left by a repeated boot', () => {
    const { _mountWorkspaceChipInBar } = loadUserWorkspace();
    const { bar } = makeBar();

    const first = _mountWorkspaceChipInBar(bar, 'conversation');
    const duplicate = new FakeElement('button');
    duplicate.className = 'workspace-chip';
    duplicate.dataset.wsTarget = 'conversation';
    bar.appendChild(duplicate);

    const mounted = _mountWorkspaceChipInBar(bar, 'conversation');

    expect(mounted).toBe(first);
    expect(duplicate.parentNode).toBeNull();
    expect(bar.querySelectorAll('.workspace-chip[data-ws-target="conversation"]')).toHaveLength(1);
  });

  it('shows a localized semantic label for the default workspace', () => {
    const { _wsDisplayName } = loadUserWorkspace();

    expect(_wsDisplayName({
      currentPath: '/Users/test/userWorkSpace',
      isDefault: true,
    })).toBe('Default');
  });

  it('keeps the folder name for a custom workspace', () => {
    const { _wsDisplayName } = loadUserWorkspace();

    expect(_wsDisplayName({
      currentPath: '/Users/test/client-project',
      isDefault: false,
    })).toBe('client-project');
  });

  it('refreshes the dynamic prefix and default label after a language change', () => {
    const { _wsInfoByTarget } = loadUserWorkspace();
    const chip = new FakeElement('button');
    const prefix = new FakeElement('span');
    prefix.className = 'workspace-chip-prefix';
    const label = new FakeElement('span');
    label.className = 'workspace-chip-label';
    chip.appendChild(prefix);
    chip.appendChild(label);
    _wsInfoByTarget['new-chat'] = {
      currentPath: '',
      defaultPath: '/Users/test/userWorkSpace',
      isDefault: true,
      recentPaths: [],
      scope: 'default',
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).t = (key: string) => ({
      'workspace.chip_title': '点击选择工作区',
      'workspace.chip_label': '工作区：',
      'workspace.default_header': '默认',
    } as Record<string, string>)[key] || key;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).document.querySelector = (selector: string) => (
      selector === '#panel-new-chat .workspace-chip' ? chip : null
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listeners = (globalThis as any).__workspaceWindowListeners as Map<string, Array<() => void>>;

    for (const listener of listeners.get('i18n-change') || []) listener();

    expect(prefix.textContent).toBe('工作区：');
    expect(label.textContent).toBe('默认');
    expect(chip.title).toBe('点击选择工作区');
  });
});

describe('user workspace menu placement', () => {
  beforeEach(() => {
    delete require.cache[require.resolve('../../src/renderer/modules/user-workspace.js')];
  });

  it('constrains a tall and wide menu to the application viewport', () => {
    const { _workspaceMenuPlacement } = loadUserWorkspace();

    expect(_workspaceMenuPlacement(
      { top: 150, bottom: 180, left: -20 },
      { width: 280, height: 320 },
      260,
      240,
    )).toEqual({
      left: 8,
      top: 8,
      maxWidth: 244,
      maxHeight: 138,
      openAbove: true,
    });
  });

  it('opens below when there is more room beneath the anchor', () => {
    const { _workspaceMenuPlacement } = loadUserWorkspace();

    expect(_workspaceMenuPlacement(
      { top: 20, bottom: 50, left: 24 },
      { width: 200, height: 150 },
      400,
      240,
    )).toEqual({
      left: 24,
      top: 54,
      maxWidth: 384,
      maxHeight: 178,
      openAbove: false,
    });
  });

  it('still opens below when it fits there and there is more room above', () => {
    const { _workspaceMenuPlacement } = loadUserWorkspace();

    expect(_workspaceMenuPlacement(
      { top: 500, bottom: 530, left: 24 },
      { width: 200, height: 120 },
      800,
      800,
    )).toEqual({
      left: 24,
      top: 534,
      maxWidth: 784,
      maxHeight: 258,
      openAbove: false,
    });
  });

  it('shows default first and omits section headers when recent workspaces exist', () => {
    const { _showWorkspaceDropdown, _wsInfoByTarget } = loadUserWorkspace();
    const anchor = new FakeElement('button');
    anchor.rect = { top: 500, bottom: 530, left: 24, width: 120, height: 30 };
    _wsInfoByTarget['new-chat'] = {
      currentPath: '/Users/test/userWorkSpace',
      defaultPath: '/Users/test/userWorkSpace',
      isDefault: true,
      recentPaths: ['/Users/test/logs'],
      scope: 'default',
    };

    _showWorkspaceDropdown(anchor, 'new-chat');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = (globalThis as any).document.body as FakeElement;
    const menu = body.querySelector('.workspace-menu');
    expect(menu).not.toBeNull();
    expect(menu?.querySelectorAll('.workspace-menu-header')).toHaveLength(0);
    const items = menu?.querySelectorAll('.workspace-menu-item') || [];
    expect(items[0]?.childNodes[0]?.textContent).toBe('Default');
    expect(items[1]?.childNodes[0]?.textContent).toBe('logs');
  });
});
