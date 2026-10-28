import { composerAccessorSource } from './composer-test-source';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const modulesRoot = path.join(__dirname, '../../src/renderer/modules');
const modelSource = fs.readFileSync(path.join(modulesRoot, 'composer-model-picker.js'), 'utf8');
const agentsSource = fs.readFileSync(path.join(modulesRoot, 'agents.js'), 'utf8');
const workspaceSource = fs.readFileSync(path.join(modulesRoot, 'user-workspace.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');

function extractFunction(source: string, name: string): string {
  const markers = [`function ${name}`, `async function ${name}`];
  const start = markers
    .map((marker) => source.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  if (start === undefined) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function peerCloseResult(activeKind: 'model' | 'recipient' | 'workspace') {
  const helper = extractFunction(modelSource, '_closeOtherComposerPopovers');
  return vm.runInNewContext(`${composerAccessorSource}

    const closed = { model: 0, recipient: 0, workspace: 0 };
    function _closeComposerModelMenu() { closed.model += 1; }
    function _closeAgentPicker() { closed.recipient += 1; }
    const workspaceMenu = {
      _closeWorkspaceMenu() { closed.workspace += 1; },
      remove() { throw new Error('owned closer must be preferred'); },
    };
    const document = {
      getElementById(id) { return id === 'workspace-menu' ? workspaceMenu : null; },
    };
    ${helper}
    _closeOtherComposerPopovers(${JSON.stringify(activeKind)});
    closed;
  `);
}

function closeRecipientPicker(preserveAtKey: boolean) {
  const setOpen = extractFunction(agentsSource, '_setAgentPickerAnchorOpen');
  const closeStart = agentsSource.indexOf('function _closeAgentPicker');
  const closeEnd = agentsSource.indexOf('\nfunction _renderAgentPickerList', closeStart);
  const close = agentsSource.slice(closeStart, closeEnd);
  return vm.runInNewContext(`${composerAccessorSource}

    const classes = new Set();
    const attributes = {};
    const anchor = {
      classList: {
        toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      },
      setAttribute(name, value) { attributes[name] = value; },
    };
    const picker = { dataset: { anchorId: 'chat-recipient-chip' }, style: { display: 'flex' } };
    const document = {
      getElementById(id) {
        if (id === 'agent-picker') return picker;
        if (id === 'chat-recipient-chip') return anchor;
        return null;
      },
    };
    let _atKeyMark = { inputId: 'chat-input', posAfter: 1 };
    ${setOpen}
    ${close}
    _setAgentPickerAnchorOpen(anchor, true);
    const opened = { selected: classes.has('is-open'), expanded: attributes['aria-expanded'] };
    _closeAgentPicker({ preserveAtKey: ${JSON.stringify(preserveAtKey)} });
    ({
      opened,
      selected: classes.has('is-open'),
      expanded: attributes['aria-expanded'],
      display: picker.style.display,
      mark: _atKeyMark,
    });
  `);
}

// Run the whole classic script. Only DOM/IPC boundaries are simulated; the
// async open/close flow and the peer coordination functions stay real.
function delayedModelPicker() {
  class Element {
    id = '';
    disabled = false;
    isConnected = true;
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    attributes: Record<string, string> = {};
    children: Element[] = [];
    classes = new Set<string>();
    classList = {
      add: (name: string) => this.classes.add(name),
      remove: (name: string) => this.classes.delete(name),
    };
    setAttribute(name: string, value: string) { this.attributes[name] = value; }
    appendChild(child: Element) { this.children.push(child); }
    remove() { body.children = body.children.filter((child) => child !== this); }
    contains(child: Element) { return child === this || this.children.includes(child); }
    querySelector() { return null; }
    addEventListener() {}
    getBoundingClientRect() { return { right: 100, width: 100, height: 50 }; }
  }
  const body = new Element();
  const listeners = new Map<string, Set<unknown>>();
  const eventTarget = {
    addEventListener(name: string, listener: unknown) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: unknown) { listeners.get(name)?.delete(listener); },
    dispatchEvent(event: { type: string }) { [...(listeners.get(event.type) || [])].forEach((fn: any) => fn(event)); return true; },
  };
  const pending: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const context = vm.createContext({
    CustomEvent: class { constructor(public type: string, public detail: unknown) { this.detail = (detail as any)?.detail; } },
    document: {
      ...eventTarget, body,
      createElement: () => new Element(),
      getElementById: () => null,
      querySelectorAll: () => [],
      querySelector: () => null,
    },
    window: {
      ...eventTarget, innerWidth: 1000, innerHeight: 800,
      orkas: { invoke: () => new Promise((resolve) => pending.push(() => resolve({ ok: true, entries: [] }))) },
    },
    createLogger: () => ({ warn() {} }),
    t: (key: string) => key,
    escapeHtml: (value: string) => value,
    _dropdownVerticalPlacement: () => ({ top: 10, availableHeight: 500 }),
    setTimeout: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearTimeout() {},
  });
  vm.runInContext(composerAccessorSource, context);
  vm.runInContext(modelSource, context);
  const api = vm.runInContext('({ open: _toggleComposerModelMenu, close: _closeComposerModelMenu, peer: _closeOtherComposerPopovers })', context);
  return {
    ...api,
    context,
    emit: (name: string, event: unknown = {}) => [...(listeners.get(name) || [])].forEach((fn: any) => fn(event)),
    anchor: () => new Element(),
    release: () => pending.splice(0).forEach((resolve) => resolve()),
    flushTimers: () => timers.splice(0).forEach((fn) => fn()),
    menus: () => body.children.filter((child) => child.id === 'composer-model-menu'),
    listenerCount: () => ['mousedown', 'keydown', 'resize', 'scroll']
      .reduce((count, name) => count + (listeners.get(name)?.size || 0), 0),
  };
}

describe('composer popover coordination', () => {
  it('does not install an outside listener after an opened model panel is closed', async () => {
    const picker = delayedModelPicker();
    const opening = picker.open(picker.anchor());
    picker.release();
    await opening;
    expect(picker.menus()).toHaveLength(1);
    picker.close();
    picker.flushTimers();
    expect(picker.menus()).toHaveLength(0);
    expect(picker.listenerCount()).toBe(0);
  });

  it('cancels a delayed model opening when the same anchor is toggled again', async () => {
    const picker = delayedModelPicker();
    const anchor = picker.anchor();
    const first = picker.open(anchor);
    const second = picker.open(anchor);
    picker.release();
    await Promise.all([first, second]);
    picker.flushTimers();
    expect(picker.menus()).toHaveLength(0);
    expect(anchor.classes.has('is-open')).toBe(false);
    expect(picker.listenerCount()).toBe(0);
    const retry = picker.open(anchor);
    picker.release();
    await retry;
    expect(picker.menus()).toHaveLength(1);
    expect(anchor.attributes['aria-expanded']).toBe('true');
    picker.close();
    picker.flushTimers();
    expect(picker.menus()).toHaveLength(0);
    expect(anchor.attributes['aria-expanded']).toBe('false');
    expect(picker.listenerCount()).toBe(0);
  });

  it('keeps only the latest anchor when two model openings overlap', async () => {
    const picker = delayedModelPicker();
    const firstAnchor = picker.anchor();
    const lastAnchor = picker.anchor();
    const first = picker.open(firstAnchor);
    const last = picker.open(lastAnchor);
    picker.release();
    await Promise.all([first, last]);
    picker.flushTimers();
    expect(picker.menus()).toHaveLength(1);
    expect(firstAnchor.classes.has('is-open')).toBe(false);
    expect(lastAnchor.attributes['aria-expanded']).toBe('true');
    picker.close();
    expect(picker.menus()).toHaveLength(0);
    expect(picker.listenerCount()).toBe(0);
  });

  it.each(['recipient', 'workspace'])('does not reopen the model panel after %s takes over', async (peer) => {
    const picker = delayedModelPicker();
    const anchor = picker.anchor();
    const opening = picker.open(anchor);
    picker.peer(peer);
    picker.release();
    await opening;
    picker.flushTimers();
    expect(picker.menus()).toHaveLength(0);
    expect(anchor.classes.has('is-open')).toBe(false);
    expect(picker.listenerCount()).toBe(0);
  });

  it('does not open a model menu after its recipient disables the anchor', async () => {
    const picker = delayedModelPicker();
    const anchor = picker.anchor();
    const opening = picker.open(anchor);
    anchor.disabled = true;
    picker.release();
    await opening;
    picker.flushTimers();
    expect(picker.menus()).toHaveLength(0);
    expect(picker.listenerCount()).toBe(0);
  });

  it('closes recipient and workspace panels before opening the model panel', () => {
    expect(peerCloseResult('model')).toEqual({ model: 0, recipient: 1, workspace: 1 });
  });

  it('closes model and workspace panels before opening the recipient panel', () => {
    expect(peerCloseResult('recipient')).toEqual({ model: 1, recipient: 0, workspace: 1 });
  });

  it('closes model and recipient panels before opening the workspace panel', () => {
    expect(peerCloseResult('workspace')).toEqual({ model: 1, recipient: 1, workspace: 0 });
  });

  it('keeps the recipient anchor selected exactly while its picker is open', () => {
    expect(closeRecipientPicker(false)).toEqual({
      opened: { selected: true, expanded: 'true' },
      selected: false,
      expanded: 'false',
      display: 'none',
      mark: null,
    });
    expect(agentsSource).toContain('_setAgentPickerAnchorOpen(anchorBtn, true)');
    expect(styleSource).toMatch(/\.chat-recipient-chip\.is-open\s*\{/);
  });

  it('preserves a typed @ only for the selection path that consumes it next', () => {
    expect(closeRecipientPicker(true).mark).toEqual({ inputId: 'chat-input', posAfter: 1 });
    expect(agentsSource).toContain('_closeAgentPicker({ preserveAtKey: true })');
  });

  it('wires every picker opener into the same exclusivity boundary', () => {
    const modelOpen = modelSource.slice(
      modelSource.indexOf('async function _toggleComposerModelMenu'),
      modelSource.indexOf("document.addEventListener('DOMContentLoaded'"),
    );
    const agentOpen = agentsSource.slice(
      agentsSource.indexOf('async function _openAgentPicker'),
      agentsSource.indexOf('\nfunction _setAgentPickerAnchorOpen'),
    );
    const workspaceOpen = workspaceSource.slice(
      workspaceSource.indexOf('function _showWorkspaceDropdown'),
      workspaceSource.indexOf('\nfunction _createMenuItem'),
    );
    expect(modelOpen).toContain("_closeOtherComposerPopovers('model')");
    expect(agentOpen).toContain("_closeOtherComposerPopovers('recipient')");
    expect(workspaceOpen).toContain("_closeOtherComposerPopovers('workspace')");
  });
});


describe('composer model snapshot ordering', () => {
  const oldEntries = [{ entryId: 'entry-a', provider: 'custom', model: 'old', modelName: 'Old' }];
  const newEntries = [{ entryId: 'entry-b', provider: 'custom', model: 'new', modelName: 'New' }];
  it.each(['read', 'event', 'selection', 'version'])('does not replace newer %s state with an older list response', async cause => {
    const picker = delayedModelPicker();
    const context = picker.context;
    let release!: (value: unknown) => void;
    const gate = new Promise(resolve => { release = resolve; });
    let reads = 0;
    context.window.orkas.invoke = async (channel: string) => {
      if (channel === 'auth.listComposerEntries') return ++reads === 1 ? gate : { ok: true, entries: newEntries };
      return { ok: true, entries: newEntries };
    };
    if (cause !== 'read') {
      picker.emit('DOMContentLoaded'); // Starts the actual boot read and installs the real event listener.
    }
    const pending = cause === 'read' ? vm.runInContext('_refreshComposerModelEntries()', context) : undefined;
    try {
      if (cause === 'read') await vm.runInContext('_refreshComposerModelEntries()', context);
      else if (cause === 'event') picker.emit('orkas:model-entries-changed', { detail: { entries: newEntries } });
      else {
        context.__entries = oldEntries.map(entry => ({ ...entry }));
        vm.runInContext('_composerModelEntries = __entries;', context);
        if (cause === 'selection') {
          context.__selected = newEntries[0];
          await vm.runInContext('_selectComposerModel(__selected, "new-chat")', context);
        } else {
          await vm.runInContext('_updateComposerModelVersion(__entries[0], "new-chat", {id:"new",name:"New"}, null, null)', context);
        }
      }
      const expected = vm.runInContext('JSON.stringify(_composerModelEntries)', context);
      release({ ok: true, entries: oldEntries }); await pending;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(vm.runInContext('JSON.stringify(_composerModelEntries)', context)).toBe(expected);
      expect(JSON.parse(expected)[0].model).toBe('new');
    } finally { release({ ok: true, entries: [] }); await pending; picker.close(); }
  });

  it.each(['rejected', 'malformed'])('retains the published entries when the latest read is %s', async outcome => {
    const picker = delayedModelPicker();
    const context = picker.context;
    context.window.orkas.invoke = async () => ({ ok: true, entries: newEntries });
    await vm.runInContext('_refreshComposerModelEntries()', context);
    context.window.orkas.invoke = async () => {
      if (outcome === 'rejected') throw new Error('controlled transport failure');
      return { ok: true, entries: null };
    };
    await vm.runInContext('_refreshComposerModelEntries()', context);
    expect(vm.runInContext('JSON.stringify(_composerModelEntries)', context)).toBe(JSON.stringify(newEntries));
    picker.close();
  });
});
