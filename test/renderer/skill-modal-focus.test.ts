import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function loadModal() {
  const ids = new Map<string, ReturnType<typeof makeElement>>();
  let active: unknown;
  function makeElement(id: string, dataset: Record<string, string> = {}) {
    const classes = new Set<string>();
    return {
      id, dataset, value: '', textContent: '', className: '', style: { display: '' },
      classList: {
        add: (name: string) => { classes.add(name); },
        remove: (name: string) => { classes.delete(name); },
        contains: (name: string) => classes.has(name),
        toggle: (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name); },
      },
      setAttribute() {}, addEventListener() {},
      querySelectorAll: (): unknown[] => tabs,
      focus() {
        if (get('skill-modal').classList.contains('open')) active = this;
      },
    };
  }
  function get(id: string) {
    if (!ids.has(id)) ids.set(id, makeElement(id));
    return ids.get(id)!;
  }
  const tabs = ['manual', 'url', 'dir'].map((tab) => makeElement(tab, { skillTab: tab }));
  const panels = ['manual', 'url', 'dir'].map((tab) => makeElement(tab, { skillPanel: tab }));
  const context = vm.createContext({
    console, setTimeout, clearTimeout,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: (key: string) => key,
    window: { addEventListener() {} },
    document: {
      getElementById: get,
      querySelectorAll: (selector: string) => selector === '.skill-modal-tab' ? tabs
        : selector === '.skill-modal-panel' ? panels : [],
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/skills.js'), 'utf8'), context);
  return {
    get, tabs, panels, active: () => active,
    open: () => vm.runInContext('openSkillModal()', context) as Promise<void>,
    switchTab: (tab: string) => vm.runInContext(`_switchSkillTab(${JSON.stringify(tab)})`, context),
    close: () => vm.runInContext('closeSkillModal()', context),
  };
}

describe('skill modal focus lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('keeps focus on the description when the user moves there immediately after opening', async () => {
    const modal = loadModal();
    await modal.open();
    modal.get('skill-name').focus();
    modal.get('skill-name').value = 'desktop-check';
    modal.get('skill-description').focus();
    await vi.advanceTimersByTimeAsync(30);
    expect(modal.active()).toBe(modal.get('skill-description'));
    expect(modal.get('skill-name').value).toBe('desktop-check');
  });

  it.each([
    ['manual', 'skill-name'], ['url', 'skill-url-input'], ['dir', 'skill-dir-pick-btn'],
  ])('focuses the visible %s panel immediately without leaving delayed focus work', async (tab, id) => {
    const modal = loadModal();
    await modal.open();
    modal.switchTab(tab);
    expect(modal.active()).toBe(modal.get(id));
    expect(modal.panels.find((panel) => panel.dataset.skillPanel === tab)?.classList.contains('is-active')).toBe(true);
    modal.close();
    const focusedBefore = modal.active();
    await vi.advanceTimersByTimeAsync(30);
    expect(modal.active()).toBe(focusedBefore);
  });

  it('focuses the name when opening the now-visible modal', async () => {
    const modal = loadModal();
    await modal.open();
    expect(modal.active()).toBe(modal.get('skill-name'));
  });
});
