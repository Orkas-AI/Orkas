import { composerAccessorSource } from './composer-test-source';
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const renderer = path.join(__dirname, '../../src/renderer');
const source = fs.readFileSync(path.join(renderer, 'modules/conversation.js'), 'utf8');
const locales = Object.fromEntries(['zh', 'en'].map(lang => [lang,
  JSON.parse(fs.readFileSync(path.join(renderer, 'locales', `${lang}.json`), 'utf8'))]));

function boot() {
  let lang = 'zh';
  const listeners = new Map<string, Function[]>();
  const input = { value: '', placeholder: '', disabled: false, focus() {} };
  const classes = new Set<string>();
  const button = { disabled: false, title: '', classList: {
    contains: (name: string) => classes.has(name),
    remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
    toggle: (name: string, enabled: boolean) => enabled ? classes.add(name) : classes.delete(name),
  } };
  const label = { textContent: '', setAttribute() {}, removeAttribute() {} };
  const pending = new Map();
  const context: any = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    currentCid: 'c1', conversations: [], pendingConvs: pending, groupBusyConvs: new Map(), _composerInputs: new Map(),
    convAgentEnabledByCid: new Map(),
    isConvPending: (cid: string) => pending.has(cid),
    createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
    t: (key: string, params: Record<string, string> = {}) =>
      String(locales[lang][key] || key).replace(/\{(\w+)\}/g, (_, name) => params[name] ?? `{${name}}`),
    localStorage: { getItem: () => null, setItem() {} },
    apiFetch: async () => ({ json: async () => ({ ok: true }) }),
    document: {
      readyState: 'loading', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
      getElementById: (id: string) => ({ 'chat-input': input, 'chat-send-btn': button,
        'chat-recipient-name': label }[id] || null),
    },
    window: { uiIconHtml: () => '', ConversationRuntime: {},
      addEventListener: (name: string, fn: Function) => {
        listeners.set(name, [...(listeners.get(name) || []), fn]);
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(composerAccessorSource, context);
  vm.runInContext(source, context);
  vm.runInContext(`_agentsCache = [
    { agent_id: 'a', name: 'Writer' }, { agent_id: 'b', name: 'Researcher' }
  ];`, context);
  return {
    input, button, classes, context,
    pick: (id = '') => context.setChatRecipient('conversation', id
      ? { kind: 'agent', id, name: id } : { kind: 'commander', id: '', name: '' }),
    runtime: (actors: string[], cid = 'c1', turnsOnly = false) => {
      context.actors = actors;
      context.runtimeCid = cid;
      context.turnsOnly = turnsOnly;
      vm.runInContext(`
        _latestInFlight.set(runtimeCid, turnsOnly ? [] : actors);
        _latestActiveTurns.set(runtimeCid, actors.map(actor => ({ actor, turn_id: 'turn-' + actor })));
      `, context);
      if (actors.length) pending.set(cid, {}); else pending.delete(cid);
      context._updateConvSendUI(cid);
    },
    language: (next: string) => {
      lang = next;
      for (const listener of listeners.get('i18n-change') || []) listener();
    },
  };
}

describe('composer execution guidance', () => {
  it('keeps the original @ guidance when nobody is executing, including a pending request without actors', () => {
    const app = boot();
    app.pick('a');
    app.runtime([]);
    expect(app.input.placeholder).toBe(locales.zh['chat.input_placeholder']);
    app.context.pendingConvs.set('c1', {});
    app.context._updateConvSendUI('c1');
    expect(app.input.placeholder).toBe(locales.zh['chat.input_placeholder']);
  });

  it('updates immediately when switching between a busy Agent, an idle Agent and Commander', () => {
    const app = boot();
    app.runtime(['a']);
    app.pick('a');
    expect(app.input.placeholder).toBe('发给 Writer 的消息将排队执行');
    app.pick('b');
    expect(app.input.placeholder).toBe('发给 Researcher 的消息会立即执行');
    app.pick();
    expect(app.input.placeholder).toBe('发给 指挥官 的消息会立即执行');
    expect(app.classes.has('streaming')).toBe(true);
  });

  it('uses actor identity rather than display names and ignores work in other conversations', () => {
    const app = boot();
    vm.runInContext("_agentsCache[1].name = 'Writer'", app.context);
    app.pick('b');
    app.runtime(['b'], 'other-conversation');
    app.context._updateConvSendUI('c1');
    expect(app.input.placeholder).toBe(locales.zh['chat.input_placeholder']);
    app.runtime(['a']);
    expect(app.input.placeholder).toBe('发给 Writer 的消息会立即执行');
  });

  it('recognizes active turns and retains a suspended Commander execution reported only in in_flight', () => {
    const app = boot();
    app.pick('a');
    app.runtime(['a'], 'c1', true);
    expect(app.input.placeholder).toBe('发给 Writer 的消息将排队执行');
    app.pick();
    vm.runInContext("_latestInFlight.set('c1', ['commander'])", app.context);
    app.context._updateConvSendUI('c1');
    expect(app.input.placeholder).toBe('发给 指挥官 的消息将排队执行');
  });

  it('returns to immediate guidance when the target finishes and to @ guidance when all work finishes', () => {
    const app = boot();
    app.pick('a');
    app.runtime(['a', 'b']);
    expect(app.input.placeholder).toBe('发给 Writer 的消息将排队执行');
    app.runtime(['b']);
    expect(app.input.placeholder).toBe('发给 Writer 的消息会立即执行');
    app.runtime([]);
    expect(app.input.placeholder).toBe(locales.zh['chat.input_placeholder']);
    expect(app.classes.has('streaming')).toBe(false);
  });

  it('refreshes active guidance on language changes and Agent renames', () => {
    const app = boot();
    app.pick('a');
    app.runtime(['a']);
    app.language('en');
    expect(app.input.placeholder).toBe('Messages to Writer will be queued');
    vm.runInContext("_agentsCache[0].name = 'Editor'", app.context);
    app.context._renderRecipientChip('conversation');
    expect(app.input.placeholder).toBe('Messages to Editor will be queued');
    app.runtime(['b']);
    expect(app.input.placeholder).toBe('Messages to Editor will run immediately');
  });

  it('restores @ guidance after local cancellation before another runtime snapshot arrives', () => {
    const app = boot();
    app.pick('a');
    app.runtime(['a']);
    // Stop retires the local request before a fresh state_changed can arrive.
    app.context.pendingConvs.clear();
    app.context._updateConvSendUI('c1');
    expect(app.input.placeholder).toBe(locales.zh['chat.input_placeholder']);
  });

  it('preserves disabled-Agent and queue-edit guidance when the recipient chip refreshes', () => {
    const app = boot();
    app.pick('a');
    app.runtime(['a']);
    app.context.convAgentEnabledByCid.set('c1', false);
    app.context._updateConvSendUI('c1');
    const disabled = app.input.placeholder;
    app.pick('b');
    expect(app.input.placeholder).toBe(disabled);
    app.context.convAgentEnabledByCid.clear();
    app.context._isQueueItemEditing = () => true;
    app.context._queueComposerSaving = new Set();
    app.context._updateConvSendUI('c1');
    expect(app.input.placeholder).toBe(locales.zh['chat.queue_editing_placeholder']);
    app.pick('a');
    expect(app.input.placeholder).toBe(locales.zh['chat.queue_editing_placeholder']);
  });
});
