import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

class FakeClassList {
  private readonly items = new Set<string>();

  setFromString(value: string) {
    this.items.clear();
    for (const item of String(value || '').split(/\s+/)) {
      if (item) this.items.add(item);
    }
  }

  add(...names: string[]) {
    for (const name of names) this.items.add(name);
  }

  remove(...names: string[]) {
    for (const name of names) this.items.delete(name);
  }

  contains(name: string) {
    return this.items.has(name);
  }
}

class FakeElement {
  id = '';
  readonly tagName: string;
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = new FakeClassList();
  hidden = false;
  disabled = false;
  value = '';
  offsetParent: unknown = {};
  private listeners = new Map<string, Function[]>();
  private _className = '';
  private _innerHTML = '';
  private _textContent = '';

  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
  }

  set className(value: string) {
    this._className = String(value || '');
    this.classList.setFromString(this._className);
  }

  get className() {
    return this._className;
  }

  set innerHTML(value: string) {
    this._innerHTML = String(value || '');
    this.children.splice(0);
    if (this._innerHTML.includes('delete-confirm-title')) {
      this.appendChild(makeEl('div', 'delete-confirm-title'));
      this.appendChild(makeEl('div', 'delete-confirm-path-list'));
      this.appendChild(makeEl('div', 'delete-confirm-message'));
      const actions = makeEl('div', 'delete-confirm-actions');
      const cancel = makeEl('button', 'btn');
      cancel.dataset.deleteAct = 'cancel';
      const ok = makeEl('button', 'btn btn-danger');
      ok.dataset.deleteAct = 'ok';
      actions.appendChild(cancel);
      actions.appendChild(ok);
      this.appendChild(actions);
      const result = makeEl('div', 'delete-confirm-result');
      result.hidden = true;
      this.appendChild(result);
    }
  }

  get innerHTML() {
    return this._innerHTML;
  }

  set textContent(value: string) {
    this._textContent = String(value ?? '');
  }

  get textContent() {
    return this._textContent;
  }

  get firstChild() {
    return this.children[0] || null;
  }

  appendChild(child: FakeElement) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  removeChild(child: FakeElement) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }

  querySelector(selector: string): FakeElement | null {
    return findInTree(this, selector);
  }

  addEventListener(type: string, fn: Function) {
    const arr = this.listeners.get(type) || [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  dispatchEvent(ev: { type: string }) {
    for (const fn of this.listeners.get(ev.type) || []) fn(ev);
    return true;
  }

  async click() {
    for (const fn of this.listeners.get('click') || []) {
      await fn({ target: this, preventDefault() {}, stopPropagation() {} });
    }
  }

  scrollIntoView() {}
}

function makeEl(tagName: string, className = '') {
  const el = new FakeElement(tagName);
  el.className = className;
  return el;
}

function findInTree(root: FakeElement, selector: string): FakeElement | null {
  for (const child of root.children) {
    if (matches(child, selector)) return child;
    const nested = findInTree(child, selector);
    if (nested) return nested;
  }
  return null;
}

function matches(el: FakeElement, selector: string) {
  if (selector.startsWith('.')) return el.classList.contains(selector.slice(1));
  const attrMatch = /^\[data-([a-z-]+)="([^"]+)"\]$/.exec(selector);
  if (attrMatch) {
    const key = attrMatch[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    return el.dataset[key] === attrMatch[2];
  }
  if (/^[a-z]+$/i.test(selector)) return el.tagName.toLowerCase() === selector.toLowerCase();
  return false;
}

function loadHarness() {
  const elements = new Map<string, FakeElement>();
  const history = makeEl('div');
  history.id = 'chat-history';
  const input = makeEl('textarea');
  input.id = 'chat-input';
  const send = makeEl('button');
  send.id = 'chat-send-btn';
  elements.set(history.id, history);
  elements.set(input.id, input);
  elements.set(send.id, send);

  const invokeCalls: Array<{ channel: string; payload: any }> = [];
  let sendClicks = 0;
  send.click = async () => { sendClicks += 1; };

  const dict: Record<string, string> = {
    'local.delete_file.title': 'Confirm file deletion',
    'local.delete_file.message': 'Delete this file?',
    'local.delete_file.batch_title': 'Confirm deletion of {count} files',
    'local.delete_file.batch_message': 'Delete these {count} files?',
    'local.delete_file.confirm_button': 'Delete',
    'local.delete_file.batch_confirm_button': 'Delete all {count}',
    'local.delete_file.cancel_button': 'Cancel',
    'local.delete_file.confirmed': 'Deletion confirmed',
    'local.delete_file.batch_confirmed': 'Deletion confirmed for {count} files',
    'local.delete_file.cancelled': 'Cancelled',
    'local.delete_file.batch_cancelled': 'Cancelled {count} files',
    'local.delete_file.user_continue': 'Confirmed, please continue.',
  };

  const context: any = {
    console,
    Map,
    Set,
    Object,
    String,
    RegExp,
    setTimeout,
    clearTimeout,
    createLogger: () => ({ info() {}, warn() {} }),
    t: (key: string, vars?: Record<string, unknown>) => {
      let text = dict[key] || key;
      for (const [k, v] of Object.entries(vars || {})) {
        text = text.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
      return text;
    },
    Event: class {
      type: string;
      constructor(type: string) { this.type = type; }
    },
    KeyboardEvent: class {
      type: string;
      key: string;
      code: string;
      constructor(type: string, init: { key?: string; code?: string } = {}) {
        this.type = type;
        this.key = init.key || '';
        this.code = init.code || '';
      }
    },
    document: {
      getElementById: (id: string) => elements.get(id) || null,
      createElement: (tagName: string) => makeEl(tagName),
    },
    window: {
      orkas: {
        invoke: async (channel: string, payload: any) => {
          invokeCalls.push({ channel, payload });
          return { ok: true };
        },
      },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const code = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/delete-file-confirm.js'),
    'utf8',
  );
  vm.runInContext(code, context, { filename: 'delete-file-confirm.js' });
  return {
    context,
    history,
    input,
    send,
    invokeCalls,
    get sendClicks() { return sendClicks; },
  };
}

function pathTexts(card: FakeElement) {
  const list = card.querySelector('.delete-confirm-path-list');
  if (!list) return [];
  return list.children.map((row) => row.querySelector('code')?.textContent || '');
}

describe('delete-file-confirm batching', () => {
  it('groups multiple pending delete confirmations into one card', async () => {
    const h = loadHarness();

    h.context._handleDeleteFileConfirmRequest({ confirm_id: 'tok-a', path: 'a.txt', cid: 'c1', turn_id: 'turn-1' });
    h.context._handleDeleteFileConfirmRequest({ confirm_id: 'tok-b', path: 'b.txt', cid: 'c1', turn_id: 'turn-1' });

    expect(h.history.children).toHaveLength(1);
    const card = h.history.children[0];
    expect(card.dataset.deleteConfirmCount).toBe('2');
    expect(card.querySelector('.delete-confirm-title')?.textContent).toBe('Confirm deletion of 2 files');
    expect(pathTexts(card)).toEqual(['a.txt', 'b.txt']);

    await card.querySelector('[data-delete-act="ok"]')!.click();

    expect(h.invokeCalls).toEqual([
      { channel: 'delete_file.visible', payload: { confirm_id: 'tok-a' } },
      { channel: 'delete_file.visible', payload: { confirm_id: 'tok-b' } },
      { channel: 'delete_file.respond', payload: { confirm_id: 'tok-a', granted: true } },
      { channel: 'delete_file.respond', payload: { confirm_id: 'tok-b', granted: true } },
    ]);
    expect(h.sendClicks).toBe(1);
    expect(h.input.value).toBe('Confirmed, please continue.');
    expect(card.classList.contains('is-confirmed')).toBe(true);
    expect(card.querySelector('.delete-confirm-result')?.textContent).toBe('Deletion confirmed for 2 files');
  });

  it('cancels every token in the grouped card without auto-continuing', async () => {
    const h = loadHarness();

    h.context._handleDeleteFileConfirmRequest({ confirm_id: 'tok-a', path: 'a.txt', cid: 'c1', turn_id: 'turn-1' });
    h.context._handleDeleteFileConfirmRequest({ confirm_id: 'tok-b', path: 'b.txt', cid: 'c1', turn_id: 'turn-1' });

    const card = h.history.children[0];
    await card.querySelector('[data-delete-act="cancel"]')!.click();

    expect(h.invokeCalls).toEqual([
      { channel: 'delete_file.visible', payload: { confirm_id: 'tok-a' } },
      { channel: 'delete_file.visible', payload: { confirm_id: 'tok-b' } },
      { channel: 'delete_file.respond', payload: { confirm_id: 'tok-a', granted: false } },
      { channel: 'delete_file.respond', payload: { confirm_id: 'tok-b', granted: false } },
    ]);
    expect(h.sendClicks).toBe(0);
    expect(card.classList.contains('is-cancelled')).toBe(true);
    expect(card.querySelector('.delete-confirm-result')?.textContent).toBe('Cancelled 2 files');
  });

  it('does not merge a new turn into an older pending card', () => {
    const h = loadHarness();

    h.context._handleDeleteFileConfirmRequest({ confirm_id: 'tok-old', path: 'old.txt', cid: 'c1', turn_id: 'turn-1' });
    h.context._handleDeleteFileConfirmRequest({ confirm_id: 'tok-new', path: 'new.txt', cid: 'c1', turn_id: 'turn-2' });

    expect(h.history.children).toHaveLength(2);
    expect(h.history.children[0].dataset.deleteConfirmCount).toBe('1');
    expect(h.history.children[1].dataset.deleteConfirmCount).toBe('1');
    expect(pathTexts(h.history.children[0])).toEqual(['old.txt']);
    expect(pathTexts(h.history.children[1])).toEqual(['new.txt']);
  });
});
