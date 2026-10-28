import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.resolve(__dirname, '../../src/renderer/modules/overlay-manager.js'), 'utf8');

function fixture() {
  const roots: any[] = [];
  let notify!: (records: any[]) => void;
  const queue: Array<() => void> = [];
  const invoke = vi.fn(async (_channel: string, payload: any) => ({ ok: true, ...payload }));
  const warn = vi.fn();
  const events = new Map<string, Array<() => void>>();
  const body: any = { nodeType: 1, matches: () => false, contains: (element: any) => roots.includes(element),
    querySelectorAll: () => roots, querySelector: () => null };
  const window: any = { orkas: { invoke }, getComputedStyle: (element: any) => ({
    display: element.hidden || element.parentHidden ? 'none' : 'block', visibility: element.visibility, position: element.position,
    getPropertyValue: () => element.layer,
  }), addEventListener: () => {} };
  const document: any = { body, documentElement: body, styleSheets: [{ cssRules: [{
    selectorText: '.fresh-surface', style: { getPropertyValue: () => 'overlay' },
  }] }], addEventListener: (event: string, callback: () => void) => {
    events.set(event, [...(events.get(event) || []), callback]);
  } };
  vm.runInNewContext(source, { window, document, createLogger: () => ({ warn }),
    MutationObserver: class { constructor(callback: any) { notify = callback; } observe() {} },
    queueMicrotask: (callback: () => void) => queue.push(callback),
  });
  const manager = window.OverlayManager;
  const drain = async () => { while (queue.length) queue.shift()!(); await manager.settled(); };
  const add = (name = 'fresh-surface', hidden = false) => {
    const classes = new Set([name]);
    const element: any = { nodeType: 1, isConnected: true, hidden, parentHidden: false,
      visibility: 'visible', position: 'fixed', role: '', layer: 'overlay', rect: { width: 300, height: 200 },
      matches: (selectors: string) => selectors.split(',').some(selector => classes.has(selector.trim().slice(1)) || selector.trim() === `[role="${element.role}"]`),
      contains: (node: any) => node === element, querySelectorAll: () => [], querySelector: () => null,
      getClientRects: () => element.hidden || element.parentHidden ? [] : [element.rect],
      classList: { contains: (name: string) => classes.has(name), toggle: (name: string, wanted: boolean) => wanted ? classes.add(name) : classes.delete(name) },
    };
    roots.push(element);
    notify([{ type: 'childList', target: body, addedNodes: [element], removedNodes: [] }]);
    return element;
  };
  const change = (element: any) => notify([{ type: 'attributes', target: element }]);
  const remove = (element: any) => {
    element.isConnected = false; roots.splice(roots.indexOf(element), 1);
    notify([{ type: 'childList', target: body, addedNodes: [], removedNodes: [element] }]);
  };
  return { manager, invoke, warn, add, change, remove, drain, body, notify, document,
    dispatch: (event: string) => events.get(event)?.forEach(callback => callback()) };
}

describe('application floating layer presentation', () => {
  it('automatically suppresses an unnamed shared-style surface and gates paint until native acknowledgement', async () => {
    const f = fixture();
    f.manager.setBrowserOpen(true); await f.drain();
    let acknowledge!: (value: unknown) => void;
    f.invoke.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    const surface = f.add();
    f.manager.refresh();
    expect(f.manager.hasOpenLayers()).toBe(true);
    expect(surface.classList.contains('ui-overlay-waiting')).toBe(true);
    expect(f.invoke).toHaveBeenLastCalledWith('webAssist.overlayState', expect.objectContaining({ blocked: true }));
    acknowledge({ ok: true, blocked: true }); await f.drain();
    expect(surface.classList.contains('ui-overlay-waiting')).toBe(false);
    f.remove(surface); await f.drain();
    expect(f.manager.count()).toBe(0);
    expect(f.invoke).toHaveBeenLastCalledWith('webAssist.overlayState', expect.objectContaining({ blocked: false }));
  });

  it('keeps suppression until the last nested surface is removed and does not duplicate IPC for unrelated content', async () => {
    const f = fixture(); f.manager.setBrowserOpen(true); await f.drain();
    const a = f.add(), b = f.add(); await f.drain();
    expect(f.manager.count()).toBe(2);
    f.invoke.mockClear();
    f.remove(a); await f.drain();
    expect(f.manager.count()).toBe(1);
    expect(f.invoke).not.toHaveBeenCalled();
    f.notify([{ type: 'childList', target: { nodeType: 1, matches: () => false, contains: () => false }, addedNodes: [], removedNodes: [] }]);
    await f.drain(); expect(f.invoke).not.toHaveBeenCalled();
    f.remove(b); await f.drain();
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith('webAssist.overlayState', expect.objectContaining({ blocked: false }));
  });

  it('repaints a page that stops being a layer before native acknowledgement', async () => {
    const f = fixture(); f.manager.setBrowserOpen(true); await f.drain();
    f.invoke.mockImplementationOnce(() => new Promise(() => {}));
    // A page panel briefly carries an overlay modifier (detail opened over
    // another page) and drops it again when the detail fails to load.
    const panel = f.add();
    f.manager.refresh();
    expect(panel.classList.contains('ui-overlay-waiting')).toBe(true);
    panel.classList.toggle('fresh-surface', false); f.change(panel); await f.drain();
    expect(f.manager.count()).toBe(0);
    expect(panel.classList.contains('ui-overlay-waiting')).toBe(false);
    expect(f.invoke).toHaveBeenLastCalledWith('webAssist.overlayState', expect.objectContaining({ blocked: false }));
  });

  it('handles hidden ancestors, empty roots, visibility-only closing and browser close without a dangling blocker', async () => {
    const f = fixture(); const a = f.add(); a.parentHidden = true; await f.drain();
    f.manager.setBrowserOpen(true); await f.drain(); expect(f.manager.count()).toBe(0);
    a.parentHidden = false; f.change(a); await f.drain(); expect(f.manager.count()).toBe(1);
    a.rect.height = 0; f.change(a); await f.drain(); expect(f.manager.count()).toBe(0);
    a.rect.height = 100; a.visibility = 'hidden'; f.change(a); await f.drain(); expect(f.manager.count()).toBe(0);
    a.visibility = 'visible'; f.change(a); await f.drain();
    f.manager.setBrowserOpen(false); await f.drain();
    expect(a.classList.contains('ui-overlay-waiting')).toBe(false);
    f.invoke.mockClear(); f.remove(a); await f.drain(); expect(f.invoke).not.toHaveBeenCalled();
  });

  it('ignores stale release acknowledgements during rapid close/reopen', async () => {
    const f = fixture(); f.manager.setBrowserOpen(true); await f.drain();
    const a = f.add(); await f.drain();
    let release!: (value: unknown) => void;
    f.invoke.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    f.remove(a); f.manager.refresh();
    const b = f.add(); f.manager.refresh(); await f.drain();
    release({ ok: true, blocked: false }); await Promise.resolve();
    expect(f.manager.count()).toBe(1);
    expect(b.classList.contains('ui-overlay-waiting')).toBe(false);
    expect(f.invoke).toHaveBeenLastCalledWith('webAssist.overlayState', expect.objectContaining({ blocked: true }));
  });

  it('keeps a surface unpainted after IPC failure and recovers on explicit refresh without uncontrolled retries', async () => {
    const f = fixture(); f.manager.setBrowserOpen(true); await f.drain();
    f.invoke.mockRejectedValueOnce(new Error('fixture disconnected'));
    const a = f.add(); f.manager.refresh();
    expect(await f.manager.settled()).toBe(false);
    expect(a.classList.contains('ui-overlay-waiting')).toBe(true);
    expect(f.warn).toHaveBeenCalledExactlyOnceWith('overlay presentation update failed');
    f.manager.refresh(); await f.drain();
    expect(a.classList.contains('ui-overlay-waiting')).toBe(false);
  });

  it('honors new stylesheet declarations without changing browser code and retains Escape ownership after removal', async () => {
    const f = fixture();
    f.document.styleSheets.push({ cssRules: [{ styleSheet: { cssRules: [{ selectorText: '.new-family', style: { getPropertyValue: () => 'overlay' } }] } }] });
    const style = { nodeType: 1, matches: (s: string) => s.startsWith('style'), querySelector: () => null, querySelectorAll: () => [] };
    f.notify([{ type: 'childList', target: f.body, addedNodes: [style], removedNodes: [] }]);
    const a = f.add('new-family'); await f.drain();
    expect(f.manager.count()).toBe(1);
    const event = { composedPath: () => [a, f.body] };
    f.remove(a); await f.drain();
    expect(f.manager.layerForEvent(event)).toBe(a);
  });

  it('keeps transcript streaming independent of whole-document rescans and extra native updates', async () => {
    const f = fixture(); f.manager.setBrowserOpen(true); f.add(); await f.drain();
    f.invoke.mockClear();
    f.body.querySelectorAll = () => { throw new Error('Whole document scanned during transcript streaming'); };
    const transcript = { nodeType: 1, matches: () => false, contains: () => false };
    const line = () => ({ nodeType: 1, matches: () => false, querySelector: () => null, querySelectorAll: () => [] });
    f.notify([{ type: 'childList', target: transcript, addedNodes: Array.from({ length: 2000 }, line), removedNodes: [] }]);
    await f.drain();
    expect(f.manager.count()).toBe(1);
    expect(f.invoke).not.toHaveBeenCalled();
  });

  it('recognizes a standard third-party floating menu without vendor selectors while ignoring inline menu regions', async () => {
    const f = fixture(); const menu = f.add('vendor-unknown'); menu.role = 'menu'; menu.layer = '';
    f.change(menu); await f.drain(); expect(f.manager.count()).toBe(1);
    menu.position = 'static'; f.change(menu); await f.drain(); expect(f.manager.count()).toBe(0);
  });

  it('reconciles a CSS-only hover transition without requiring a DOM mutation', async () => {
    const f = fixture(); const menu = f.add(); menu.visibility = 'hidden'; await f.drain();
    f.manager.setBrowserOpen(true); await f.drain();
    menu.visibility = 'visible'; f.dispatch('pointerover'); await f.drain();
    expect(f.manager.count()).toBe(1);
    expect(f.invoke).toHaveBeenLastCalledWith('webAssist.overlayState', expect.objectContaining({ blocked: true }));
    menu.visibility = 'hidden'; f.dispatch('pointerout'); await f.drain(); expect(f.manager.count()).toBe(0);
  });
});
