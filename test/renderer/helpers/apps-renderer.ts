// My Apps renderer journey harness: runs the shipped Apps panel markup from
// index.html with the real dialogs.js, i18n lookup, escapeHtml, composer and
// conversation-cache boundaries, then saved-apps.js, inside one `node:vm`
// context over the shared mini DOM. IPC is the only injected dependency, so
// cases observe user-visible copy, dialogs and cards instead of private calls.
// Optional extra modules (for example the commercial publication module) are
// loaded by the caller in index.html order before saved-apps.js.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { vi } from 'vitest';
import { composerAccessorSource } from '../composer-test-source';
import { conversationCacheSource } from '../conversation-cache-test-source';
import { MiniDocument, MiniElement, MiniEvent, visibleText } from './mini-dom';

const rendererDir = path.join(__dirname, '../../../src/renderer');
const read = (relative: string) => readFileSync(path.join(rendererDir, relative), 'utf8');
export const rendererModuleSource = (name: string) => read(`modules/${name}`);

function functionsFrom(file: string, names: string[]): string {
  const source = read(file);
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.includes(node.name?.text || ''));
  if (found.length !== names.length) throw new Error(`missing renderer functions in ${file}`);
  return found.map(node => node.getText(parsed)).join('\n');
}

const locales = {
  zh: JSON.parse(read('locales/zh.json')),
  en: JSON.parse(read('locales/en.json')),
};
const appsPanelMarkup = (() => {
  const html = read('index.html');
  const start = html.indexOf('<section class="panel" id="panel-apps">');
  const end = html.indexOf('</section>', start);
  if (start < 0 || end < 0) throw new Error('Apps panel markup not found');
  return html.slice(start, end + '</section>'.length);
})();
const i18nSource = 'var _tables = __tables; var _currentLang = __lang; function fallbackChain(lang) { return [lang, "en"]; }\n'
  + functionsFrom('modules/i18n.js', ['_lookup', 't', 'getLang']);

export type Invoke = (channel: string, payload?: any) => any;

export function loadAppsRenderer(options: { invoke: Invoke; lang?: 'zh' | 'en'; before?: Array<{ source: string; filename: string }>;
  orkas?: Record<string, any>; }) {
  const document = new MiniDocument();
  const warnings: any[] = [];
  const pendingTimers: Array<() => void> = [];
  const invoke = vi.fn(options.invoke);
  const window: any = {
    OrkasArtifactSecurity: { SANDBOX: 'allow-scripts', trustedArtifactMessage: () => false, safeExternalHttpUrl: () => '' },
    addEventListener: vi.fn(), removeEventListener: vi.fn(), open: vi.fn(), innerWidth: 1280, innerHeight: 800,
    orkas: { invoke, onPushEvent: () => () => {}, ...options.orkas },
  };
  const context: any = {
    console, Date, Math, Set, Map, Intl, Promise, Object, Array, JSON, Number, String, Error, URL,
    __tables: locales, __lang: options.lang || 'zh',
    window, document, navigator: { language: options.lang || 'zh' },
    MutationObserver: class { observe() {} disconnect() {} },
    requestAnimationFrame: (callback: () => void) => callback(),
    setTimeout: (callback: () => void, delay = 0) => { if (!delay) callback(); else pendingTimers.push(callback); return pendingTimers.length; },
    clearTimeout: () => {},
    createLogger: () => ({ warn: (...args: any[]) => warnings.push(args), error: (...args: any[]) => warnings.push(args), info: () => {} }),
    uiIconHtml: () => '',
    _aiSelectMount: (node: MiniElement, config: { value: string }) => {
      const trigger = document.createElement('button'); trigger.type = 'button'; node.append(trigger);
      return { getValue: () => config.value, close: () => {} };
    },
  };
  window.uiIconHtml = context.uiIconHtml;
  vm.createContext(context);
  document.body.innerHTML = appsPanelMarkup;
  document.body.append(Object.assign(document.createElement('textarea'), { id: 'chat-input' }));
  for (const [source, filename] of [
    [i18nSource, 'i18n.js'],
    [functionsFrom('modules/connectors.js', ['escapeHtml']), 'connectors.js'],
    [read('modules/dialogs.js'), 'dialogs.js'],
    [composerAccessorSource, 'composer-input.js'],
    [conversationCacheSource, 'conversation.js'],
  ] as const) vm.runInContext(source, context, { filename });
  for (const extra of options.before || []) vm.runInContext(extra.source, context, { filename: extra.filename });
  vm.runInContext(rendererModuleSource('commercial-entry.js'), context, { filename: 'commercial-entry.js' });
  vm.runInContext(rendererModuleSource('saved-apps.js'), context, { filename: 'saved-apps.js' });

  const $ = (selector: string) => document.querySelector(selector);
  const helpers = {
    context, window, document, invoke, warnings,
    $, $$: (selector: string) => document.querySelectorAll(selector),
    cards: () => document.querySelectorAll('#apps-grid .app-card').map(card => card.dataset.appId),
    card: (id: string) => document.querySelectorAll('#apps-grid .app-card').find(card => card.dataset.appId === id) || null,
    channels: () => invoke.mock.calls.map(call => call[0]),
    /** Open the card's "..." menu and choose the action, the way a user does. */
    async chooseMenuAction(appId: string, action: string) {
      const card = helpers.card(appId);
      if (!card) throw new Error(`card ${appId} is not rendered`);
      card.querySelector('[data-app-more]')!.click();
      const item = document.querySelector(`.app-row-menu [data-action="${action}"]`);
      if (!item) throw new Error(`menu action ${action} is not offered`);
      item.click();
      await flush();
    },

    openDialogs: () => document.querySelectorAll('.ui-dialog-overlay.open'),
    dialogText: (overlay: MiniElement) => visibleText(overlay.querySelector('.ui-dialog-message')!),
    press: (key: string) => document.press(key),
    input: (element: MiniElement, value: string) => { element.value = value; element.dispatchEvent(new MiniEvent('input')); },
  };
  return helpers;
}

/** Drain promise continuations queued by awaited IPC mocks. */
export async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
}

export function deferred<T = any>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}
