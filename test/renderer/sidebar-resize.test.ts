import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/sidebar-resize.js'),
  'utf8',
);

type Listener = (event?: any) => void;

class FakeClassList {
  private readonly values = new Set<string>();

  add(value: string): void { this.values.add(value); }
  remove(value: string): void { this.values.delete(value); }
  contains(value: string): boolean { return this.values.has(value); }
}

class FakeElement {
  readonly classList = new FakeClassList();
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  tabIndex = -1;

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) || []) listener(event);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

function createHarness(options: { width?: number; saved?: string } = {}) {
  const handle = new FakeElement();
  const sidebar = new FakeElement();
  const body = new FakeElement();
  const windowListeners = new Map<string, Listener[]>();
  const storage = new Map<string, string>();
  if (options.saved !== undefined) storage.set('orkas:sidebar-width', options.saved);
  let renderedWidth = 280;
  const style = {
    setProperty: vi.fn((name: string, value: string) => {
      if (name === '--sidebar-width') renderedWidth = Number.parseFloat(value);
    }),
  };
  const window = {
    innerWidth: options.width ?? 1280,
    addEventListener: vi.fn((type: string, listener: Listener) => {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    }),
    removeEventListener: vi.fn((type: string, listener: Listener) => {
      windowListeners.set(type, (windowListeners.get(type) || []).filter((item) => item !== listener));
    }),
  };
  const localStorage = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => storage.set(key, value)),
  };
  const document = {
    readyState: 'complete',
    documentElement: { style },
    body,
    getElementById: (id: string) => id === 'sidebar-resize-handle' ? handle : null,
    querySelector: (selector: string) => selector === '.sidebar' ? sidebar : null,
    addEventListener: vi.fn(),
  };
  (sidebar as any).getBoundingClientRect = () => ({ width: renderedWidth });
  vm.runInNewContext(source, { window, document, localStorage, Number, Math }, {
    filename: 'sidebar-resize.js',
  });

  const dispatchWindow = (type: string, event: Record<string, unknown> = {}) => {
    for (const listener of [...(windowListeners.get(type) || [])]) listener(event);
  };
  return {
    handle,
    body,
    window,
    storage,
    style,
    renderedWidth: () => renderedWidth,
    dispatchWindow,
  };
}

describe('sidebar resize', () => {
  it('ignores malformed storage and exposes an operable separator contract', () => {
    const harness = createHarness({ saved: '360px' });

    expect(harness.renderedWidth()).toBe(280);
    expect(harness.handle.tabIndex).toBe(0);
    expect(harness.handle.getAttribute('aria-valuemin')).toBe('180');
    expect(harness.handle.getAttribute('aria-valuemax')).toBe('480');
    expect(harness.handle.getAttribute('aria-valuenow')).toBe('280');
  });

  it('keeps the CSS fallback aligned with the wider default and restores it on reset', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/style.css'),
      'utf8',
    );
    const sidebarBlock = css.match(/\.sidebar\s*\{[\s\S]*?\}/)?.[0] || '';
    const harness = createHarness({ saved: '340' });

    expect(sidebarBlock).toContain('width: var(--sidebar-width, 280px)');
    harness.handle.dispatch('dblclick');
    expect(harness.renderedWidth()).toBe(280);
    expect(harness.storage.get('orkas:sidebar-width')).toBe('280');
    expect(harness.handle.getAttribute('aria-valuenow')).toBe('280');
  });

  it('supports keyboard resizing and persists the user-selected width', () => {
    const harness = createHarness({ saved: '260' });
    const preventDefault = vi.fn();

    harness.handle.dispatch('keydown', { key: 'ArrowRight', preventDefault });
    expect(harness.renderedWidth()).toBe(270);
    expect(harness.storage.get('orkas:sidebar-width')).toBe('270');
    expect(harness.handle.getAttribute('aria-valuenow')).toBe('270');

    harness.handle.dispatch('keydown', { key: 'Home', preventDefault });
    expect(harness.renderedWidth()).toBe(180);
    harness.handle.dispatch('keydown', { key: 'End', preventDefault });
    expect(harness.renderedWidth()).toBe(480);
    expect(preventDefault).toHaveBeenCalledTimes(3);
  });

  it('preserves main-content space in a narrow window and restores the preference when widened', () => {
    const harness = createHarness({ width: 700, saved: '480' });
    expect(harness.renderedWidth()).toBe(380);
    expect(harness.handle.getAttribute('aria-valuemax')).toBe('380');
    expect(harness.storage.get('orkas:sidebar-width')).toBe('480');

    harness.window.innerWidth = 1280;
    harness.dispatchWindow('resize');
    expect(harness.renderedWidth()).toBe(480);
    expect(harness.handle.getAttribute('aria-valuemax')).toBe('480');

    harness.window.innerWidth = 700;
    harness.dispatchWindow('resize');
    harness.handle.dispatch('keydown', { key: 'ArrowLeft', preventDefault: vi.fn() });
    expect(harness.renderedWidth()).toBe(370);
    expect(harness.storage.get('orkas:sidebar-width')).toBe('370');
  });

  it('finishes an interrupted drag on window blur without leaving global resize state behind', () => {
    const harness = createHarness({ saved: '260' });
    const preventDefault = vi.fn();
    harness.handle.dispatch('mousedown', { button: 0, clientX: 100, preventDefault });
    harness.dispatchWindow('mousemove', { clientX: 180 });
    expect(harness.renderedWidth()).toBe(340);
    expect(harness.body.classList.contains('is-sidebar-resizing')).toBe(true);

    harness.dispatchWindow('blur');
    expect(harness.body.classList.contains('is-sidebar-resizing')).toBe(false);
    expect(harness.handle.classList.contains('is-active')).toBe(false);
    expect(harness.storage.get('orkas:sidebar-width')).toBe('340');
  });
});
