import * as fs from 'node:fs';
import * as path from 'node:path';
import vm from 'node:vm';

import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { LOCALES as MAIN_LOCALES } from '../../src/main/i18n';

const rendererRoot = path.resolve(__dirname, '../../src/renderer');
const i18nSource = fs.readFileSync(
  path.join(rendererRoot, 'modules', 'i18n.js'),
  'utf8',
);
const LANGS = ['en', 'zh', 'ja', 'pt'] as const;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolvePromise = resolveValue;
  });
  return { promise, resolve: resolvePromise };
}

function domElement(attributes: Record<string, string>, textContent: string) {
  return {
    attributes: { ...attributes },
    textContent,
    getAttribute(name: string) {
      return this.attributes[name] ?? null;
    },
    setAttribute(name: string, value: string) {
      this.attributes[name] = value;
    },
  };
}

function loadI18n(options: {
  boot?: unknown;
  getLanguage?: () => Promise<unknown>;
  getLocales?: () => Promise<unknown>;
  setLanguage?: (lang: string) => Promise<unknown>;
  textElements?: any[];
  placeholderElements?: any[];
  titleElements?: any[];
  ariaLabelElements?: any[];
} = {}) {
  const textElements = options.textElements || [];
  const placeholderElements = options.placeholderElements || [];
  const titleElements = options.titleElements || [];
  const ariaLabelElements = options.ariaLabelElements || [];
  const htmlAttributes: Record<string, string> = {};
  const events: Array<{ type: string; detail: unknown }> = [];
  const warnings: unknown[][] = [];
  class FakeCustomEvent {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  }
  const document = {
    documentElement: {
      setAttribute(name: string, value: string) {
        htmlAttributes[name] = value;
      },
    },
    querySelectorAll(selector: string) {
      if (selector === '[data-i18n]') return textElements;
      if (selector === '[data-i18n-placeholder]') return placeholderElements;
      if (selector === '[data-i18n-title]') return titleElements;
      if (selector === '[data-i18n-aria-label]') return ariaLabelElements;
      return [];
    },
  };
  const windowObject: Record<string, any> = {
    __orkasI18nBoot: options.boot ?? null,
    orkas: {
      getLanguage: options.getLanguage || (async () => ({ ok: true, language: 'en' })),
      getLocales: options.getLocales || (async () => ({ ok: true, tables: {} })),
      setLanguage: options.setLanguage || (async (lang: string) => ({ ok: true, language: lang })),
    },
    dispatchEvent(event: FakeCustomEvent) {
      events.push({ type: event.type, detail: event.detail });
    },
  };
  const sandbox: Record<string, any> = {
    window: windowObject,
    document,
    CustomEvent: FakeCustomEvent,
    createLogger: () => ({
      warn: (...args: unknown[]) => warnings.push(args),
    }),
    Set,
    Map,
    Object,
    Array,
    String,
    Number,
    Promise,
    Math,
  };
  vm.runInNewContext(i18nSource, sandbox, { filename: 'i18n.js' });
  return { sandbox, htmlAttributes, events, warnings };
}

function localeTables(side: 'main' | 'renderer') {
  return Object.fromEntries(LANGS.map((lang) => [
    lang,
    JSON.parse(fs.readFileSync(
      path.resolve(rendererRoot, '..', side, 'locales', `${lang}.json`),
      'utf8',
    )),
  ])) as Record<typeof LANGS[number], Record<string, string>>;
}

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

function translationKeyChoices(node: ts.Expression): string[] {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return [node.text];
  }
  if (ts.isParenthesizedExpression(node)) return translationKeyChoices(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [
      ...translationKeyChoices(node.whenTrue),
      ...translationKeyChoices(node.whenFalse),
    ];
  }
  return [];
}

function literalTranslationKeys(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const keys: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 't'
      && node.arguments.length > 0
    ) {
      keys.push(...translationKeyChoices(node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return keys;
}

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|js)$/.test(entry.name) ? [absolute] : [];
  });
}

describe('renderer i18n runtime', () => {
  it('uses English fallback and raw-key fallback without blanking content', () => {
    const text = domElement({ 'data-i18n': 'only.english' }, 'default');
    const { sandbox, htmlAttributes } = loadI18n({
      boot: {
        lang: 'zh',
        tables: {
          zh: { 'only.chinese': '中文' },
          en: { 'only.english': 'English fallback' },
        },
      },
      textElements: [text],
    });

    expect(text.textContent).toBe('English fallback');
    expect(sandbox.t('only.chinese')).toBe('中文');
    expect(sandbox.t('missing.key')).toBe('missing.key');
    expect(htmlAttributes.lang).toBe('zh-CN');
  });

  it('preserves static default copy when asynchronous locale loading fails', async () => {
    const text = domElement({ 'data-i18n': 'nav.agents' }, 'Agents');
    const { sandbox, htmlAttributes, warnings } = loadI18n({
      getLanguage: async () => { throw new Error('/private/account/language'); },
      getLocales: async () => { throw new Error('/private/app/locales'); },
      textElements: [text],
    });

    await expect(sandbox.initI18n()).resolves.toBe('en');

    expect(text.textContent).toBe('Agents');
    expect(htmlAttributes.lang).toBe('en');
    expect(JSON.stringify(warnings)).not.toContain('/private/');
  });

  it('keeps the previous language and emits no event when persistence fails', async () => {
    const text = domElement({ 'data-i18n': 'nav.agents' }, 'Agents');
    const { sandbox, events, warnings } = loadI18n({
      boot: {
        lang: 'en',
        tables: {
          en: { 'nav.agents': 'Agents' },
          pt: { 'nav.agents': 'Agentes' },
        },
      },
      setLanguage: async () => ({ ok: false, error: '/private/write/failure' }),
      textElements: [text],
    });

    await expect(sandbox.setLang('pt')).rejects.toThrow('language change failed');

    expect(sandbox.getLang()).toBe('en');
    expect(text.textContent).toBe('Agents');
    expect(events).toEqual([]);
    expect(JSON.stringify(warnings)).not.toContain('/private/write/failure');
  });

  it('does not switch to a language whose table is unavailable', async () => {
    const { sandbox, events } = loadI18n({
      boot: { lang: 'en', tables: { en: { hello: 'Hello' } } },
      getLocales: async () => ({
        ok: true,
        tables: { pt: { hello: { nested: 'invalid' } } },
      }),
    });

    await expect(sandbox.setLang('pt')).rejects.toThrow('language change failed');

    expect(sandbox.getLang()).toBe('en');
    expect(events).toEqual([]);
  });

  it('serializes rapid choices and applies only the latest successful language', async () => {
    const japanese = deferred<any>();
    const portuguese = deferred<any>();
    const setLanguage = vi.fn((lang: string) => (
      lang === 'ja' ? japanese.promise : portuguese.promise
    ));
    const text = domElement({ 'data-i18n': 'nav.agents' }, 'Agents');
    const { sandbox, events, htmlAttributes } = loadI18n({
      boot: {
        lang: 'en',
        tables: {
          en: { 'nav.agents': 'Agents' },
          ja: { 'nav.agents': 'エージェント' },
          pt: { 'nav.agents': 'Agentes' },
        },
      },
      setLanguage,
      textElements: [text],
    });

    const first = sandbox.setLang('ja');
    const second = sandbox.setLang('pt');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setLanguage.mock.calls.map(([lang]) => lang)).toEqual(['ja']);

    japanese.resolve({ ok: true, language: 'ja' });
    await expect(first).resolves.toBe('en');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setLanguage.mock.calls.map(([lang]) => lang)).toEqual(['ja', 'pt']);

    portuguese.resolve({ ok: true, language: 'pt' });
    await expect(second).resolves.toBe('pt');

    expect(sandbox.getLang()).toBe('pt');
    expect(text.textContent).toBe('Agentes');
    expect(htmlAttributes.lang).toBe('pt-BR');
    expect(events).toEqual([
      { type: 'i18n-change', detail: { lang: 'pt' } },
    ]);
  });

  it('reconciles to the last persisted choice when the newest queued choice fails', async () => {
    const setLanguage = vi.fn()
      .mockResolvedValueOnce({ ok: true, language: 'ja' })
      .mockResolvedValueOnce({ ok: false, error: 'write failed' });
    const text = domElement({ 'data-i18n': 'nav.agents' }, 'Agents');
    const { sandbox, events } = loadI18n({
      boot: {
        lang: 'en',
        tables: {
          en: { 'nav.agents': 'Agents' },
          ja: { 'nav.agents': 'エージェント' },
          pt: { 'nav.agents': 'Agentes' },
        },
      },
      setLanguage,
      textElements: [text],
    });

    const first = sandbox.setLang('ja');
    const second = sandbox.setLang('pt');

    await expect(first).resolves.toBe('en');
    await expect(second).rejects.toThrow('language change failed');

    expect(sandbox.getLang()).toBe('ja');
    expect(text.textContent).toBe('エージェント');
    expect(events).toEqual([
      { type: 'i18n-change', detail: { lang: 'ja' } },
    ]);
  });

  it('does not let a stale preference refresh overwrite a newer local choice', async () => {
    const refreshedLanguage = deferred<any>();
    const getLanguage = vi.fn(() => refreshedLanguage.promise);
    const text = domElement({ 'data-i18n': 'nav.agents' }, 'Agents');
    const { sandbox, events, htmlAttributes } = loadI18n({
      boot: {
        lang: 'en',
        tables: {
          en: { 'nav.agents': 'Agents' },
          ja: { 'nav.agents': 'エージェント' },
          pt: { 'nav.agents': 'Agentes' },
        },
      },
      getLanguage,
      textElements: [text],
    });

    const staleRefresh = sandbox.refreshLangFromMain();
    await vi.waitFor(() => expect(getLanguage).toHaveBeenCalledOnce());
    await expect(sandbox.setLang('pt')).resolves.toBe('pt');
    refreshedLanguage.resolve({ ok: true, language: 'ja' });
    await expect(staleRefresh).resolves.toBe('pt');

    expect(sandbox.getLang()).toBe('pt');
    expect(text.textContent).toBe('Agentes');
    expect(htmlAttributes.lang).toBe('pt-BR');
    expect(events).toEqual([{ type: 'i18n-change', detail: { lang: 'pt' } }]);
  });

  it('updates text, placeholder, title, accessible label and document language on success', async () => {
    const text = domElement({ 'data-i18n': 'label' }, 'Label');
    const placeholder = domElement({ 'data-i18n-placeholder': 'placeholder' }, '');
    const title = domElement({ 'data-i18n-title': 'title' }, '');
    const ariaLabel = domElement({ 'data-i18n-aria-label': 'aria' }, '');
    const { sandbox, htmlAttributes } = loadI18n({
      boot: {
        lang: 'en',
        tables: {
          en: { label: 'Label', placeholder: 'Search', title: 'Help', aria: 'Close' },
          ja: { label: 'ラベル', placeholder: '検索', title: 'ヘルプ', aria: '閉じる' },
        },
      },
      textElements: [text],
      placeholderElements: [placeholder],
      titleElements: [title],
      ariaLabelElements: [ariaLabel],
    });

    await expect(sandbox.setLang('ja')).resolves.toBe('ja');

    expect(text.textContent).toBe('ラベル');
    expect(placeholder.attributes.placeholder).toBe('検索');
    expect(title.attributes.title).toBe('ヘルプ');
    expect(ariaLabel.attributes['aria-label']).toBe('閉じる');
    expect(htmlAttributes.lang).toBe('ja');
  });
});

describe('locale resource contract', () => {
  it('keeps main and Renderer language metadata synchronized', () => {
    const { sandbox } = loadI18n();
    const rendererLocales = sandbox.getSupportedLanguages().map((item: any) => ({
      code: item.code,
      htmlLang: item.htmlLang,
      intlLocale: item.intlLocale,
      fallback: item.fallback,
    }));
    const mainLocales = MAIN_LOCALES.map((item) => ({
      code: item.code,
      htmlLang: item.htmlLang,
      intlLocale: item.intlLocale,
      fallback: item.fallback,
    }));

    expect(rendererLocales).toEqual(mainLocales);
  });

  it('keeps locale key sets, value types and placeholders identical', () => {
    const allowedEmpty = new Set([
      'force_update.status_error',
      'memory.export_sub',
      'memory.export_foot',
      'settings.video.sub',
    ]);
    for (const side of ['main', 'renderer'] as const) {
      const tables = localeTables(side);
      const englishKeys = Object.keys(tables.en).sort();
      for (const lang of LANGS) {
        expect(Object.keys(tables[lang]).sort(), `${side}/${lang} key set`)
          .toEqual(englishKeys);
        for (const [key, value] of Object.entries(tables[lang])) {
          expect(typeof value, `${side}/${lang}:${key}`).toBe('string');
          if (!value.trim()) {
            expect(side, `${side}/${lang}:${key} unexpected empty value`).toBe('renderer');
            expect(allowedEmpty.has(key), `${side}/${lang}:${key} unexpected empty value`)
              .toBe(true);
          }
          expect(placeholders(value), `${side}/${lang}:${key} placeholders`)
            .toEqual(placeholders(tables.en[key]));
        }
      }
    }
  });

  it('keeps shared Main and Renderer user messages semantically aligned', () => {
    const contextSpecificCopy = new Set([
      'provider.moonshot.note_paygo',
      'provider.kimi_coding.note_subscription',
      'chat.reply_interrupted',
    ]);
    const mainTables = localeTables('main');
    const rendererTables = localeTables('renderer');
    const sharedKeys = Object.keys(mainTables.en)
      .filter((key) => Object.hasOwn(rendererTables.en, key))
      .filter((key) => !contextSpecificCopy.has(key));

    for (const lang of LANGS) {
      for (const key of sharedKeys) {
        expect(rendererTables[lang][key], `${lang}:${key}`)
          .toBe(mainTables[lang][key]);
      }
    }
  });

  it('defines every literal Renderer translation key referenced by HTML or JS', () => {
    const rendererEnglish = localeTables('renderer').en;
    const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
    const keys = [
      ...[...html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)]
        .map((match) => match[1]),
      ...fs.readdirSync(path.join(rendererRoot, 'modules'))
        .filter((name) => name.endsWith('.js'))
        .flatMap((name) => literalTranslationKeys(path.join(rendererRoot, 'modules', name))),
    ];
    const missing = [...new Set(keys)].filter((key) => !Object.hasOwn(rendererEnglish, key));

    expect(missing).toEqual([]);
  });

  it('defines every literal Main translation key referenced by TypeScript or JavaScript', () => {
    const mainEnglish = localeTables('main').en;
    const mainRoot = path.resolve(rendererRoot, '..', 'main');
    const keys = sourceFiles(mainRoot).flatMap(literalTranslationKeys);
    const missing = [...new Set(keys)].filter((key) => !Object.hasOwn(mainEnglish, key));

    expect(missing).toEqual([]);
  });

  it('contains no duplicate JSON keys in any shipped locale table', () => {
    for (const side of ['main', 'renderer'] as const) {
      for (const lang of LANGS) {
        const file = path.resolve(rendererRoot, '..', side, 'locales', `${lang}.json`);
        const raw = fs.readFileSync(file, 'utf8');
        const parsed = JSON.parse(raw);
        const rawKeys = [...raw.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)]
          .map((match) => match[1]);
        expect(rawKeys.length, `${side}/${lang} raw key count`)
          .toBe(Object.keys(parsed).length);
        expect(new Set(rawKeys).size, `${side}/${lang} duplicate key`)
          .toBe(rawKeys.length);
      }
    }
  });
});
