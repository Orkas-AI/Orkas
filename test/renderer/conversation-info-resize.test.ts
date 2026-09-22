import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const source = readFileSync(join(__dirname, '../../src/renderer/modules/conversation-info.js'), 'utf8');
const resizeSource = readFileSync(join(__dirname, '../../src/renderer/modules/task-side-panel.js'), 'utf8');
const storageKey = 'orkas.conversationInfo.width';

function createHarness(viewport = 1800, saved?: string) {
  const listeners = new Map<string, (event: any) => void>();
  const attributes = new Map<string, string>();
  const storage = new Map(saved === undefined ? [] : [[storageKey, saved]]);
  const container = { getBoundingClientRect: () => ({ width: window.innerWidth - 280, right: window.innerWidth }) };
  const panel = {
    hidden: true,
    parentElement: container,
    style: {} as Record<string, string>,
    getBoundingClientRect: () => ({ width: Number.parseFloat(panel.style.width) }),
  };
  const handle = {
    dataset: {} as Record<string, string>,
    setAttribute: (key: string, value: string) => attributes.set(key, value),
    setPointerCapture: vi.fn(),
    addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
  };
  const windowListeners = new Map<string, () => void>();
  const window = {
    innerWidth: viewport,
    addEventListener: (type: string, listener: () => void) => windowListeners.set(type, listener),
  };
  const context = {
    window,
    document: {
      readyState: 'complete',
      body: { classList: { add() {}, remove() {} } },
      getElementById: (id: string) => id === 'conversation-info-panel' ? panel : id === 'conversation-info-resize' ? handle : null,
      querySelectorAll: () => [],
    },
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  };
  runInNewContext(resizeSource + source, context);
  const dispatch = (type: string, event = {}) => listeners.get(type)!({ preventDefault() {}, ...event });
  const secondPanel = { ...panel, style: {} as Record<string, string> };
  const secondHandle = { ...handle, addEventListener() {} };
  const getElement = context.document.getElementById;
  context.document.getElementById = (id: string) => id === 'video-review-panel' ? secondPanel
    : id === 'video-review-resize' ? secondHandle : getElement(id);
  const second = (window as any).TaskSidePanel.bind('video-review-panel', 'video-review-resize');
  return { panel, attributes, storage, dispatch, secondPanel, second, resize: (width: number) => {
    window.innerWidth = width;
    windowListeners.get('resize')!();
  } };
}

describe('conversation info resizing', () => {
  it('defaults to 30% of the app width with a 400px minimum before the user resizes', () => {
    const harness = createHarness();
    expect(harness.panel.style.width).toBe('540px');
    harness.resize(1500);
    expect(harness.panel.style.width).toBe('450px');
    harness.resize(1280);
    expect(harness.panel.style.width).toBe('400px');
    expect(harness.storage.has(storageKey)).toBe(false);
  });

  it('allows dragging beyond the default and restores the saved width on reload', () => {
    const harness = createHarness();
    harness.dispatch('pointerdown', { button: 0, pointerId: 1 });
    harness.dispatch('pointermove', { clientX: 1000 });
    expect(harness.panel.style.width).toBe('800px');
    expect(harness.panel.style.flexBasis).toBe('800px');
    expect(harness.attributes.get('aria-valuenow')).toBe('800');
    harness.dispatch('pointerup');
    expect(harness.storage.get(storageKey)).toBe('800');
    expect(createHarness(1800, harness.storage.get(storageKey)).panel.style.width).toBe('800px');
  });

  it('keeps the panel minimum and leaves space for the conversation at the drag limit', () => {
    const harness = createHarness();
    harness.dispatch('pointerdown', { button: 0, pointerId: 1 });
    harness.dispatch('pointermove', { clientX: 1790 });
    expect(harness.panel.style.width).toBe('400px');
    harness.dispatch('pointermove', { clientX: -100 });
    expect(harness.panel.style.width).toBe('1100px');
    expect(harness.attributes.get('aria-valuemax')).toBe('1100');
    harness.dispatch('pointercancel');
    harness.dispatch('pointermove', { clientX: 1000 });
    expect(harness.panel.style.width).toBe('1100px');
    harness.resize(1280);
    expect(harness.panel.style.width).toBe('580px');
  });

  it('shares the selected width with the video panel', () => {
    const harness = createHarness();
    harness.dispatch('pointerdown', { button: 0, pointerId: 1 });
    harness.dispatch('pointermove', { clientX: 1000 });
    harness.dispatch('pointerup');
    harness.second.apply();
    expect(harness.secondPanel.style.width).toBe('800px');
    expect(harness.secondPanel.style.flexBasis).toBe('800px');
  });

  it('resizes from the displayed default using the keyboard and ignores IME input', () => {
    const harness = createHarness();
    harness.dispatch('keydown', { key: 'ArrowLeft', isComposing: true });
    expect(harness.storage.has(storageKey)).toBe(false);
    harness.dispatch('keydown', { key: 'ArrowLeft' });
    expect(harness.panel.style.width).toBe('564px');
    expect(harness.storage.get(storageKey)).toBe('564');
    harness.dispatch('keydown', { key: 'ArrowRight' });
    expect(harness.panel.style.width).toBe('540px');
  });
});
