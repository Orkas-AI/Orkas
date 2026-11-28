import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const storageKey = 'orkas-open-source-support-v1';
const source = readFileSync(join(__dirname, '../../src/renderer/modules/open-source-support.js'), 'utf8');

function surface(hidden = false) {
  const link = new EventTarget();
  const button = new EventTarget();
  return {
    hidden,
    link,
    button,
    checkVisibility() { return !this.hidden; },
    querySelector(selector: string) { return selector === 'a' ? link : button; },
  };
}

function mount(saved: object) {
  const card = surface(true);
  const settings = surface();
  const reports: string[] = [];
  const document = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    getElementById(id: string) {
      return id === 'home-open-source-support' ? card : id === 'settings-open-source' ? settings : null;
    },
  });
  const values = new Map([[storageKey, JSON.stringify(saved)]]);
  const window = {
    orkas: {
      onPushEvent() {},
      async invoke(_channel: string, payload: { surface: string; action: string }) {
        reports.push(`${payload.surface}:${payload.action}`);
      },
    },
  } as { orkas: object; OpenSourceSupport?: { onHomeEnter: () => void } };
  type Entry = { target: typeof card; isIntersecting: boolean; intersectionRatio: number };
  let notify: (entries: Entry[]) => void;
  runInNewContext(source, {
    window,
    document,
    localStorage: { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) },
    IntersectionObserver: class {
      constructor(callback: (entries: Entry[]) => void) { notify = callback; }
      observe() {}
      takeRecords() { return []; }
    },
  });
  return {
    card, settings, reports, enterHome: window.OpenSourceSupport!.onHomeEnter,
    saved: () => JSON.parse(values.get(storageKey)!),
    intersect(target: typeof card, ratio: number) {
      notify([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]);
    },
    setWindowVisible(visible: boolean) {
      document.visibilityState = visible ? 'visible' : 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

describe('OrkasOpen Star invitation reporting', () => {
  it('counts first and later visible periods after a restart and on returning to the surface', () => {
    const ui = mount({ eligible: true, recorded: ['home:show', 'settings:show'] });
    ui.enterHome();
    ui.intersect(ui.card, 0.4);
    expect(ui.reports).toEqual([]);
    ui.intersect(ui.card, 1);
    ui.intersect(ui.card, 0.8);
    expect(ui.reports).toEqual(['home:show']);
    ui.intersect(ui.card, 0);
    ui.intersect(ui.settings, 1);
    ui.intersect(ui.settings, 0);
    ui.intersect(ui.settings, 1);
    ui.intersect(ui.settings, 0);
    ui.setWindowVisible(false);
    ui.intersect(ui.card, 1);
    expect(ui.reports).toEqual(['home:show', 'settings:show', 'settings:show']);
    ui.setWindowVisible(true);
    expect(ui.reports).toEqual(['home:show', 'settings:show', 'settings:show', 'home:show']);
  });

  it('reports both settings clicks without an extra view and retains the home suppression decision', () => {
    const ui = mount({ eligible: true, recorded: ['settings:open'] });
    ui.intersect(ui.settings, 1);
    ui.settings.link.dispatchEvent(new Event('click'));
    ui.settings.link.dispatchEvent(new Event('click'));
    ui.enterHome();
    expect(ui.reports).toEqual(['settings:show', 'settings:open', 'settings:open']);
    expect(ui.saved().decision).toBe('opened');
    expect(ui.card.hidden).toBe(true);
  });

  it('reports closing the visible home card without fabricating another exposure', () => {
    const ui = mount({ eligible: true });
    ui.enterHome();
    ui.intersect(ui.card, 1);
    ui.card.button.dispatchEvent(new Event('click'));
    ui.enterHome();
    expect(ui.reports).toEqual(['home:show', 'home:dismiss']);
    expect(ui.saved().decision).toBe('dismissed');
    expect(ui.card.hidden).toBe(true);
  });
});
