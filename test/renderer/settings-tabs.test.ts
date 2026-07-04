import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const root = path.join(__dirname, '../..');

class FakeClassList {
  classes = new Set<string>();

  constructor(initial: string[] = []) {
    initial.forEach((cls) => this.classes.add(cls));
  }

  contains(cls: string) {
    return this.classes.has(cls);
  }

  toggle(cls: string, force?: boolean) {
    const next = force === undefined ? !this.classes.has(cls) : force;
    if (next) this.classes.add(cls);
    else this.classes.delete(cls);
    return next;
  }
}

class FakeElement {
  dataset: Record<string, string>;
  classList: FakeClassList;
  hidden = false;
  listeners = new Map<string, Array<() => void>>();

  constructor(dataset: Record<string, string>, classes: string[] = []) {
    this.dataset = dataset;
    this.classList = new FakeClassList(classes);
  }

  addEventListener(type: string, handler: () => void) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  click() {
    for (const handler of this.listeners.get('click') || []) handler();
  }
}

function loadSettingsTabsModule() {
  const tabs = [
    new FakeElement({ settingsTab: 'data' }, ['settings-tab', 'is-active']),
    new FakeElement({ settingsTab: 'credentials' }, ['settings-tab']),
    new FakeElement({ settingsTab: 'general' }, ['settings-tab']),
  ];
  const panes = [
    new FakeElement({ settingsPane: 'data' }, ['settings-tab-pane']),
    new FakeElement({ settingsPane: 'credentials' }, ['settings-tab-pane']),
    new FakeElement({ settingsPane: 'general' }, ['settings-tab-pane']),
  ];
  panes[1].hidden = true;
  panes[2].hidden = true;

  const document = {
    querySelectorAll(selector: string) {
      if (selector === '.settings-tab') return tabs;
      if (selector === '.settings-tab-pane') return panes;
      return [];
    },
    querySelector(selector: string) {
      if (selector === '.settings-tab.is-active') {
        return tabs.find((tab) => tab.classList.contains('is-active')) || null;
      }
      return null;
    },
  };
  const context: any = { document, window: {} };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(root, 'src/renderer/modules/settings_tabs.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'settings_tabs.js' });
  return { window: context.window, tabs, panes };
}

describe('settings tabs module', () => {
  it('is loaded before settings.js from index.html', () => {
    const indexHtml = fs.readFileSync(path.join(root, 'src/renderer/index.html'), 'utf8');
    const modulePath = path.join(root, 'src/renderer/modules/settings_tabs.js');
    const tabsScript = '<script src="./modules/settings_tabs.js"></script>';
    const settingsScript = '<script src="./modules/settings.js"></script>';

    expect(fs.existsSync(modulePath)).toBe(true);
    expect(indexHtml.indexOf(tabsScript)).toBeGreaterThanOrEqual(0);
    expect(indexHtml.indexOf(settingsScript)).toBeGreaterThanOrEqual(0);
    expect(indexHtml.indexOf(tabsScript)).toBeLessThan(indexHtml.indexOf(settingsScript));
  });

  it('binds clicks and toggles the matching settings pane', () => {
    const { window, tabs, panes } = loadSettingsTabsModule();

    window.initSettingsTabs();
    tabs[1].click();

    expect(tabs[0].classList.contains('is-active')).toBe(false);
    expect(tabs[1].classList.contains('is-active')).toBe(true);
    expect(tabs[2].classList.contains('is-active')).toBe(false);
    expect(panes[0].hidden).toBe(true);
    expect(panes[1].hidden).toBe(false);
    expect(panes[2].hidden).toBe(true);
  });

  it('falls back to the first surviving tab when asked for a stripped tab', () => {
    const { window, tabs, panes } = loadSettingsTabsModule();

    window.activateSettingsTab('account');

    expect(tabs[0].classList.contains('is-active')).toBe(true);
    expect(panes[0].hidden).toBe(false);
    expect(panes[1].hidden).toBe(true);
    expect(panes[2].hidden).toBe(true);
  });
});
