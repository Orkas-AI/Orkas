import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/memory.js'),
  'utf8',
);

function clickable() {
  const listeners: Record<string, () => void> = {};
  return {
    dataset: {} as Record<string, string>,
    addEventListener(type: string, handler: () => void) { listeners[type] = handler; },
    click() { listeners.click?.(); },
  };
}

describe('settings memory entry', () => {
  it('binds immediately when the lazy feature loads after DOMContentLoaded', async () => {
    const card = clickable();
    const dataTab = clickable();
    const desc = { textContent: '' };
    const setView = vi.fn();
    const invoke = vi.fn(async () => ({
      ok: true,
      files: { user: { count: 2 }, shared: { count: 3 } },
    }));
    const context = vm.createContext({
      console,
      document: {
        readyState: 'complete',
        getElementById(id: string) {
          if (id === 'memory-entry-card') return card;
          if (id === 'memory-entry-desc') return desc;
          return null;
        },
        querySelector(selector: string) {
          return selector === '[data-settings-tab="data"]' ? dataTab : null;
        },
        addEventListener() {},
      },
      window: { orkas: { invoke }, addEventListener() {} },
      setView,
      t: (key: string, vars?: { n?: number }) => key === 'memory.entry_desc' ? `count:${vars?.n || 0}` : key,
      setTimeout,
      clearTimeout,
    });

    vm.runInContext(source, context, { filename: 'memory.js' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    card.click();
    expect(setView).toHaveBeenCalledWith('memory');
    expect(desc.textContent).toBe('count:5');
    expect(card.dataset.bound).toBe('1');
    expect(dataTab.dataset.memoryBound).toBe('1');
  });
});
