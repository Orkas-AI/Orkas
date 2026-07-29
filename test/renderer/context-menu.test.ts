import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/context-menu.js'),
  'utf8',
);

type Listener = (event?: any) => void;

class FakeClassList {
  constructor(private readonly element: FakeElement) {}

  private values(): Set<string> {
    return new Set(this.element.className.split(/\s+/).filter(Boolean));
  }

  add(value: string): void {
    const values = this.values();
    values.add(value);
    this.element.className = [...values].join(' ');
  }

  remove(value: string): void {
    const values = this.values();
    values.delete(value);
    this.element.className = [...values].join(' ');
  }

  toggle(value: string, force: boolean): void {
    if (force) this.add(value);
    else this.remove(value);
  }

  contains(value: string): boolean {
    return this.values().has(value);
  }
}

class FakeElement {
  className = '';
  readonly classList = new FakeClassList(this);
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  parentNode: FakeElement | null = null;
  textContent = '';
  innerHTML = '';
  tabIndex = 0;
  disabled = false;
  type = '';

  constructor(
    readonly tagName: string,
    private readonly documentRef: { activeElement: FakeElement | null },
  ) {}

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement): void {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'tabindex') this.tabIndex = Number(value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const matches = selector === '.context-menu-item'
      ? this.children.filter((child) => child.classList.contains('context-menu-item'))
      : [];
    return matches;
  }

  contains(target: unknown): boolean {
    return target === this || this.children.some((child) => child.contains(target));
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 180, height: Math.max(40, this.children.length * 36) };
  }

  focus(): void {
    this.documentRef.activeElement = this;
  }
}

function createHarness() {
  const documentListeners = new Map<string, Listener[]>();
  const windowListeners = new Map<string, Listener[]>();
  const documentState = { activeElement: null as FakeElement | null };
  const body = new FakeElement('BODY', documentState);
  const priorFocus = new FakeElement('BUTTON', documentState);
  priorFocus.focus();
  const document = {
    body,
    get activeElement() { return documentState.activeElement; },
    createElement: (tag: string) => new FakeElement(tag.toUpperCase(), documentState),
    addEventListener: vi.fn((type: string, listener: Listener) => {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    }),
  };
  const window = {
    innerWidth: 500,
    innerHeight: 300,
    addEventListener: vi.fn((type: string, listener: Listener) => {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    }),
  } as Record<string, any>;
  const warn = vi.fn();
  vm.runInNewContext(source, {
    window,
    document,
    createLogger: () => ({ warn }),
    escapeHtml: (value: unknown) => String(value),
    uiIconHtml: (name: string) => `<svg data-icon="${name}"></svg>`,
    Promise,
    Number,
    Math,
  }, { filename: 'context-menu.js' });

  return {
    window,
    document,
    priorFocus,
    warn,
    dispatchDocument(type: string, event: Record<string, unknown> = {}) {
      for (const listener of documentListeners.get(type) || []) listener(event);
    },
    dispatchWindow(type: string, event: Record<string, unknown> = {}) {
      for (const listener of windowListeners.get(type) || []) listener(event);
    },
    menu() {
      return body.children.find((child) => child.classList.contains('context-menu')) || null;
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('context menu', () => {
  it('filters invalid items, clamps to the viewport, and focuses the first enabled action', () => {
    const harness = createHarness();
    harness.window.showContextMenu(
      { clientX: -20, clientY: -10 },
      [
        null,
        { label: 'Disabled', disabled: true, onClick: vi.fn() },
        { label: '<Copy>', onClick: vi.fn() },
        { label: 'Missing action' },
      ],
    );

    const menu = harness.menu();
    expect(menu).not.toBeNull();
    expect(menu?.style.left).toBe('4px');
    expect(menu?.style.top).toBe('4px');
    const buttons = menu?.querySelectorAll('.context-menu-item') || [];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].disabled).toBe(true);
    expect(harness.document.activeElement).toBe(buttons[1]);
    expect(buttons[1].tabIndex).toBe(0);
    expect(buttons[1].children.at(-1)?.textContent).toBe('<Copy>');
  });

  it('wraps keyboard navigation, supports Home/End, and ignores IME keystrokes', () => {
    const harness = createHarness();
    const first = vi.fn();
    const last = vi.fn();
    harness.window.showContextMenu(
      { clientX: 490, clientY: 290 },
      [
        { label: 'First', onClick: first },
        { label: 'Disabled', disabled: true, onClick: vi.fn() },
        { label: 'Last', onClick: last },
      ],
    );
    const buttons = harness.menu()!.querySelectorAll('.context-menu-item');
    expect(harness.document.activeElement).toBe(buttons[0]);

    harness.dispatchDocument('keydown', { key: 'ArrowUp', preventDefault: vi.fn() });
    expect(harness.document.activeElement).toBe(buttons[2]);
    harness.dispatchDocument('keydown', { key: 'ArrowDown', preventDefault: vi.fn() });
    expect(harness.document.activeElement).toBe(buttons[0]);
    harness.dispatchDocument('keydown', { key: 'End', preventDefault: vi.fn() });
    expect(harness.document.activeElement).toBe(buttons[2]);
    harness.dispatchDocument('keydown', {
      key: 'Enter',
      isComposing: true,
      preventDefault: vi.fn(),
    });
    expect(last).not.toHaveBeenCalled();
    harness.dispatchDocument('keydown', { key: 'Enter', preventDefault: vi.fn() });
    expect(last).toHaveBeenCalledTimes(1);
    expect(harness.document.activeElement).toBe(harness.priorFocus);
  });

  it('contains rejected async actions without logging raw error details', async () => {
    const harness = createHarness();
    harness.window.showContextMenu(
      { clientX: 20, clientY: 20 },
      [{
        label: 'Fail',
        onClick: () => Promise.reject(new Error('secret clipboard token')),
      }],
    );
    harness.menu()!.querySelectorAll('.context-menu-item')[0].dispatch('click', {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    await flushPromises();

    expect(harness.warn).toHaveBeenCalledWith('context menu action failed');
    expect(JSON.stringify(harness.warn.mock.calls)).not.toContain('secret clipboard token');
  });

  it('dismisses on scroll and restores focus to the prior control', () => {
    const harness = createHarness();
    harness.window.showContextMenu(
      { clientX: 20, clientY: 20 },
      [{ label: 'Copy', onClick: vi.fn() }],
    );
    expect(harness.document.activeElement).not.toBe(harness.priorFocus);

    harness.dispatchWindow('scroll');
    expect(harness.menu()).toBeNull();
    expect(harness.document.activeElement).toBe(harness.priorFocus);
  });
});
