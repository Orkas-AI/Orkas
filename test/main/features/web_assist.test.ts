import * as path from 'node:path';
import * as vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import {
  isWebAssistPermissionAllowed,
  normalizeWebAssistUserUrl,
  normalizeWebAssistBounds,
  safeWebAssistUrl,
} from '../../../src/main/features/web_assist';
import {
  buildWebAssistActionScript,
  sanitizeWebAssistObservation,
  webAssistObserveScript,
  type WebAssistPageScope,
} from '../../../src/main/features/web_assist_page';
import { WS_ROOT, userWebAssistProfileDir } from '../../../src/main/paths';

function executeSubmitAction(options: {
  sensitive: boolean;
  action?: 'click' | 'check' | 'uncheck' | 'drag';
  checked?: boolean;
  scope?: WebAssistPageScope;
  tag?: 'button' | 'input';
  label?: string;
  type?: string;
  autocomplete?: string;
  becomesSensitive?: boolean;
  nextLabel?: string;
  becomesDisabled?: boolean;
}): {
  result: Record<string, unknown>;
  clicks: number;
  checked: boolean;
  requiresUserAction: boolean;
} {
  class FakeElement {
    children: FakeElement[] = [];
    parentNode: unknown;
    disabled = false;
    form: { elements: FakeElement[] } | null = null;
    innerText: string;
    isContentEditable = false;
    labels: FakeElement[] = [];
    tagName: string;
    type: string;
    autocomplete: string;
    clicks = 0;
    checked = false;

    constructor(tag: string, type: string, label: string, autocomplete = '') {
      this.tagName = tag.toUpperCase();
      this.type = type;
      this.innerText = label;
      this.autocomplete = autocomplete;
    }

    getAttribute(name: string): string | null {
      if (name === 'type') return this.type;
      if (name === 'aria-label') return null;
      if (name === 'role') return null;
      if (name === 'aria-disabled') return null;
      return null;
    }

    getBoundingClientRect() { return { width: 100, height: 30 }; }
    scrollIntoView(): void {}
    focus(): void {}
    click(): void {
      this.clicks += 1;
      if (this.type === 'checkbox') this.checked = !this.checked;
      if (this.type === 'radio') this.checked = true;
    }
  }

  const submit = new FakeElement(options.tag || 'button', options.type || 'submit', options.label ?? 'Save');
  submit.checked = options.checked ?? false;
  const fields = options.sensitive
    ? [new FakeElement('input', 'password', 'Password', 'current-password')]
    : [new FakeElement('input', 'text', 'Display name', options.autocomplete)];
  submit.form = { elements: fields };
  const document = {
    children: [submit],
    querySelectorAll: (selector: string) => selector.startsWith('a[href]') ? [submit] : [],
  };
  submit.parentNode = document;
  const context = { crypto: require('node:crypto').webcrypto,
    document, Element: FakeElement, ShadowRoot: class {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  };
  const observation = vm.runInNewContext(webAssistObserveScript(options.scope), context);
  if (options.becomesSensitive) fields[0].type = 'password';
  if (options.nextLabel) submit.innerText = options.nextLabel;
  if (options.becomesDisabled) submit.disabled = true;
  const script = buildWebAssistActionScript({
    action: options.action || 'click',
    ref: {
      path: observation.elements[0].path,
      signature: observation.elements[0].signature,
    },
  }, options.scope);
  const result = vm.runInNewContext(script, context) as Record<string, unknown>;
  // Task actions are never flagged for the user (2026-10-03); the flag is no
  // longer emitted at all, so an absent flag counts as not flagged.
  return { result, clicks: submit.clicks, checked: submit.checked, requiresUserAction: observation.elements[0].requires_user_action === true };
}

describe('Web Assist security boundary', () => {
  it('permits sensitive native targeting in connector setup without returning values', () => {
    const action = executeSubmitAction({ sensitive: false, scope: 'connector_setup', action: 'drag', tag: 'input', type: 'password', label: 'Secret' });
    expect(action.result).toMatchObject({ ok: false, code: 'invalid_action' });
    expect(action.clicks).toBe(0);
  });

  it('round-trips long complete addresses while retaining search limits and credential rejection', () => {
    const url = `https://example.com/work?q=${'a'.repeat(2200)}&x=one&x=two&encoded=%2F%26#section`;
    expect(normalizeWebAssistUserUrl(url)).toBe(url);
    expect(normalizeWebAssistUserUrl(url.slice('https://'.length))).toBe(url);
    expect(normalizeWebAssistUserUrl('query '.repeat(500))).toBeNull();
    expect(normalizeWebAssistUserUrl(url.replace('https://', 'https://user:password@'))).toBeNull();
  });
  it('accepts credential-free web pages and rejects privileged schemes', () => {
    expect(safeWebAssistUrl('https://seller.example.test/setup?shop=42#permissions'))
      .toBe('https://seller.example.test/setup?shop=42#permissions');
    expect(safeWebAssistUrl('http://localhost:4000/connect')).toBe('http://localhost:4000/connect');

    for (const value of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,unsafe',
      'orkas://oauth/callback',
      'https://user:secret@seller.example.test/setup',
      'https://seller.example.test/\nfile:///etc/passwd',
      '',
    ]) {
      expect(safeWebAssistUrl(value), value).toBeNull();
    }
  });

  it('opens address-bar URLs and domains directly, then searches ordinary text with Bing', () => {
    expect(normalizeWebAssistUserUrl('example.com/docs')).toBe('https://example.com/docs');
    expect(normalizeWebAssistUserUrl('http://localhost:4400')).toBe('http://localhost:4400/');
    expect(normalizeWebAssistUserUrl('localhost:4400/docs')).toBe('http://localhost:4400/docs');
    expect(normalizeWebAssistUserUrl('127.0.0.1:4400/docs')).toBe('http://127.0.0.1:4400/docs');

    for (const query of ['orkas', '上海 天气']) {
      const result = normalizeWebAssistUserUrl(query);
      expect(result, query).not.toBeNull();
      const search = new URL(result as string);
      expect(search.origin).toBe('https://www.bing.com');
      expect(search.pathname).toBe('/search');
      expect(search.searchParams.get('q')).toBe(query);
    }

    for (const value of ['file:///tmp/private', 'javascript:alert(1)', 'user:secret@example.com', '']) {
      expect(normalizeWebAssistUserUrl(value), value).toBeNull();
    }
  });

  it.each([
    ['localhost', 'http://localhost/'],
    ['localhost:4400/docs?item=one#board', 'http://localhost:4400/docs?item=one#board'],
    ['LOCALHOST:443/one%20two?x=%2F&x=two#hash', 'http://localhost:443/one%20two?x=%2F&x=two#hash'],
    ['127.0.0.1:443/ready', 'http://127.0.0.1:443/ready'],
    ['127.0.0.2:8080/', 'http://127.0.0.2:8080/'],
    ['127.1:4400/docs', 'http://127.0.0.1:4400/docs'],
    ['[::1]:4400/docs', 'http://[::1]:4400/docs'],
    ['[0:0:0:0:0:0:0:1]:443/ready', 'http://[::1]:443/ready'],
  ])('opens a scheme-less loopback address over HTTP: %s', (input, expected) => {
    expect(normalizeWebAssistUserUrl(input)).toBe(expected);
  });

  it.each([
    ['localhost.example.test:4400/docs', 'https://localhost.example.test:4400/docs'],
    ['127.0.0.1.example.test:4400/docs', 'https://127.0.0.1.example.test:4400/docs'],
    ['192.168.1.1:4400/docs', 'https://192.168.1.1:4400/docs'],
    ['[2001:db8::1]:4400/docs', 'https://[2001:db8::1]:4400/docs'],
    ['example.com:80/docs', 'https://example.com:80/docs'],
    ['http://localhost:443/docs', 'http://localhost:443/docs'],
    ['https://localhost:4400/docs', 'https://localhost:4400/docs'],
    ['http://[::1]:443/docs', 'http://[::1]:443/docs'],
    ['https://127.0.0.1:4400/docs', 'https://127.0.0.1:4400/docs'],
  ])('preserves explicit protocols and non-loopback address defaults: %s', (input, expected) => {
    expect(normalizeWebAssistUserUrl(input)).toBe(expected);
  });

  it('clamps renderer geometry to the owner window and rejects unusable rectangles', () => {
    expect(normalizeWebAssistBounds(
      { x: -10.2, y: 12.9, width: 2_000, height: 2_000 },
      { width: 900, height: 640 },
    )).toEqual({ x: 0, y: 12, width: 900, height: 628 });

    expect(normalizeWebAssistBounds(
      { x: 860, y: 610, width: 300, height: 300 },
      { width: 900, height: 640 },
    )).toBeNull();
    expect(normalizeWebAssistBounds(
      { x: 0, y: 0, width: Number.NaN, height: 300 },
      { width: 900, height: 640 },
    )).toBeNull();
  });

  it('allows provider copy buttons without granting clipboard read or device access', () => {
    expect(isWebAssistPermissionAllowed('clipboard-sanitized-write')).toBe(true);
    expect(isWebAssistPermissionAllowed('clipboard-read')).toBe(false);
    expect(isWebAssistPermissionAllowed('media')).toBe(false);
    expect(isWebAssistPermissionAllowed('geolocation')).toBe(false);
  });

  it('stores each user browser profile only under that user local tree', () => {
    const alice = userWebAssistProfileDir('alice');
    const bob = userWebAssistProfileDir('bob');
    expect(alice).toBe(path.join(WS_ROOT, 'alice', 'local', 'web-assist', 'profile'));
    expect(bob).toBe(path.join(WS_ROOT, 'bob', 'local', 'web-assist', 'profile'));
    expect(alice).not.toBe(bob);
    expect(alice).not.toContain(`${path.sep}cloud${path.sep}`);
  });

  it('publishes snapshot-scoped refs without DOM paths or form values', () => {
    const sanitized = sanitizeWebAssistObservation({
      ok: true,
      title: 'Provider console',
      text: 'Create an app',
      text_truncated: false,
      element_count: 1,
      elements_truncated: false,
      elements: [{
        path: [0, 1, 2],
        signature: { tag: 'input', type: 'password', role: '', label: 'Secret' },
        tag: 'input',
        role: '',
        label: 'Secret',
        input_type: 'password',
        placeholder: '',
        href: '',
        disabled: false,
        checked: null,
        sensitive: true,
        fillable: false,
        options: [],
        value: 'must-never-escape',
      }],
    }, 'page-1', 'https://provider.example/setup');

    expect(sanitized?.publicSnapshot).toMatchObject({
      page_id: 'page-1',
      display_url: 'https://provider.example/setup',
      untrusted_content: true,
      elements: [{
        ref: 'e1',
        sensitive: true,
      }],
    });
    expect(JSON.stringify(sanitized?.publicSnapshot)).not.toContain('must-never-escape');
    expect(JSON.stringify(sanitized?.publicSnapshot)).not.toContain('"path"');
    expect(sanitized?.refs.get('e1')).toMatchObject({ path: [0, 1, 2] });
  });

  // Defaults were about half of an observation's tokens. Absence now means the
  // default, so every value that differs from it must still be sent.
  it('sends only element fields that differ from their defaults', () => {
    const raw = (overrides: Record<string, unknown>) => ({
      path: [0], signature: { tag: String(overrides.tag), type: '', role: '', label: '' },
      tag: 'a', role: '', label: '', input_type: '', placeholder: '', href: '',
      disabled: false, checked: null, sensitive: false, fillable: false, options: [], option_count: 0,
      ...overrides,
    });
    const sanitized = sanitizeWebAssistObservation({
      ok: true,
      title: 'Shop',
      text: '',
      elements: [
        raw({ tag: 'a', label: '加入购物车', href: 'https://shop.example/item?id=7&from=list' }),
        raw({ tag: 'input', input_type: 'checkbox', label: 'Remember me', checked: false }),
        raw({ tag: 'button', role: 'button', label: 'Pay', disabled: true }),
        raw({ tag: 'input', input_type: 'password', label: 'Password', placeholder: 'Password', sensitive: true, fillable: true }),
        raw({ tag: 'select', label: 'Size', option_count: 0 }),
        raw({ tag: 'select', label: 'Color', options: ['Red', 'Blue'], option_count: 2 }),
      ],
    }, 'page-1', 'https://shop.example/list');

    expect(sanitized?.publicSnapshot.elements).toEqual([
      { ref: 'e1', tag: 'a', label: '加入购物车', href: 'https://shop.example/item?id=7&from=list' },
      { ref: 'e2', tag: 'input', label: 'Remember me', input_type: 'checkbox', checked: false },
      { ref: 'e3', tag: 'button', role: 'button', label: 'Pay', disabled: true },
      { ref: 'e4', tag: 'input', label: 'Password', input_type: 'password', placeholder: 'Password', sensitive: true, fillable: true },
      { ref: 'e5', tag: 'select', label: 'Size', option_count: 0 },
      { ref: 'e6', tag: 'select', label: 'Color', option_count: 2, options: ['Red', 'Blue'] },
    ]);
  });

  it('windows page text at the requested offset instead of always reading the top', () => {
    // Runs the real observe script. It used to cap the joined text at 12000
    // characters *before* slicing 6000 out, so a document's tail was
    // unreachable at any price; this pins the replacement.
    class FakeBlock {
      nodeType = 1;
      tagName = 'P';
      childNodes: any[];
      constructor(text: string) { this.childNodes = [{ nodeType: 3, nodeValue: text }]; }
      getAttribute() { return null; }
    }
    const letters = 'ABCDEFGHIJKLMNOPQRST'.split('');
    const blocks = letters.map(letter => new FakeBlock(letter.repeat(1000)));
    const joined = letters.map(letter => letter.repeat(1000)).join('\n\n');
    const observe = (textOffset?: number) => vm.runInNewContext(
      webAssistObserveScript('browser', textOffset === undefined ? {} : { textOffset }),
      {
        crypto: require('node:crypto').webcrypto, document: {
          title: 'long page',
          body: Object.assign(new FakeBlock(''), { childNodes: blocks }),
          querySelectorAll: (selector: string) => (selector.includes('h1,h2,h3,h4,p') ? blocks : []),
        },
        Element: FakeBlock,
        ShadowRoot: class {},
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      },
    ) as any;

    expect(joined).toHaveLength(20 * 1000 + 38);

    const first = observe();
    expect(first.text).toBe(joined.slice(0, 6000));
    expect(first).toMatchObject({
      text_offset: 0, text_total: joined.length, text_next_offset: 6000, text_truncated: true,
    });

    const second = observe(6000);
    expect(second.text).toBe(joined.slice(6000, 12000));
    expect(second).toMatchObject({ text_offset: 6000, text_next_offset: 12000, text_truncated: true });

    // Past the old ceiling, and reachable only because the cap moved.
    const third = observe(12000);
    expect(third.text).toBe(joined.slice(12000, 18000));
    expect(third).toMatchObject({ text_offset: 12000, text_next_offset: 18000, text_truncated: true });

    const tail = observe(18000);
    expect(tail.text).toBe(joined.slice(18000));
    // The final block existed nowhere in a reply before the ceiling moved.
    expect(tail.text).toContain('T'.repeat(1000));
    expect(tail).toMatchObject({ text_offset: 18000, text_next_offset: null, text_truncated: false });

    // An offset past the end returns nothing rather than wrapping or throwing.
    const past = observe(joined.length + 500);
    expect(past.text).toBe('');
    expect(past).toMatchObject({ text_offset: joined.length, text_truncated: false });
  });

  it('windows interactive elements at the requested offset and numbers refs from it', () => {
    // Runs the real observe script. The control-layer fixture simulates this
    // windowing, so only a test that executes the script can catch a change to
    // it — an earlier text-paging test looked green while the script's own
    // slice was broken.
    class FakeLink {
      children: FakeLink[] = [];
      parentNode: unknown;
      disabled = false;
      form = null;
      isContentEditable = false;
      labels: FakeLink[] = [];
      tagName = 'A';
      type = '';
      constructor(public innerText: string, private href: string) {}
      getAttribute(name: string): string | null {
        if (name === 'href') return this.href;
        return null;
      }
      getBoundingClientRect() { return { width: 80, height: 20 }; }
      closest() { return null; }
    }

    const TOTAL = 130;
    const links = Array.from({ length: TOTAL }, (_, i) => new FakeLink(`link ${i + 1}`, `https://example.com/${i + 1}`));
    const makeDocument = () => {
      const doc: any = {
        title: 'many controls',
        children: links,
        querySelectorAll: (selector: string) => (selector.includes('a[href]') ? links : []),
      };
      for (const link of links) link.parentNode = doc;
      return doc;
    };
    const observe = (elementOffset?: number) => vm.runInNewContext(
      webAssistObserveScript('browser', elementOffset === undefined ? {} : { elementOffset }),
      {
        crypto: require('node:crypto').webcrypto, document: makeDocument(),
        Element: FakeLink,
        ShadowRoot: class {},
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      },
    ) as any;

    const first = observe();
    expect(first.elements).toHaveLength(80);
    expect(first).toMatchObject({
      element_offset: 0, element_count: TOTAL, element_next_offset: 80, elements_truncated: true,
    });
    expect(first.elements[0].label).toBe('link 1');

    const second = observe(80);
    expect(second.elements).toHaveLength(TOTAL - 80);
    expect(second).toMatchObject({
      element_offset: 80, element_count: TOTAL, element_next_offset: null, elements_truncated: false,
    });
    // The window really moved: page two starts where page one stopped.
    expect(second.elements[0].label).toBe('link 81');
    expect(second.elements.at(-1).label).toBe(`link ${TOTAL}`);

    // An offset past the end returns nothing rather than wrapping.
    const past = observe(TOTAL + 10);
    expect(past.elements).toHaveLength(0);
    expect(past).toMatchObject({ element_offset: TOTAL, elements_truncated: false });
  });

  it('reads a non-HTML document instead of reporting it as a blank page', () => {
    // A JSON or text document used to come back with text:"" and no element,
    // which a caller cannot tell from a page that genuinely had nothing. The
    // code/pre strip is aimed at a code block inside a page; this document has
    // no other content, and no form values for that strip to protect.
    const payload = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ q: `query ${i}`, clicks: i })) });
    expect(payload.length).toBeGreaterThan(6000);

    const observe = (contentType: string, pre: string | null, textOffset?: number) => vm.runInNewContext(
      webAssistObserveScript('browser', textOffset === undefined ? {} : { textOffset }),
      {
        crypto: require('node:crypto').webcrypto, document: {
          title: 'report.json',
          contentType,
          querySelectorAll: () => [],
          querySelector: (selector: string) => (
            selector === 'pre' && pre !== null ? { textContent: pre } : null
          ),
        },
        Element: class {},
        ShadowRoot: class {},
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      },
    ) as any;

    const first = observe('application/json', payload);
    expect(first).toMatchObject({
      ok: true, document_kind: 'non_html', content_type: 'application/json',
      text_offset: 0, text_total: payload.length, text_next_offset: 6000, text_truncated: true,
      element_count: 0,
    });
    expect(first.text).toBe(payload.slice(0, 6000));

    // The same window moves, so a long export is reachable end to end.
    const second = observe('application/json', payload, 6000);
    expect(second.text).toBe(payload.slice(6000, 12000));

    // Newlines survive: the shape of a text document is part of reading it.
    const lines = observe('text/plain', 'line one\nline two');
    expect(lines.text).toBe('line one\nline two');

    // Chromium gives XML a tree viewer with no <pre>. Report the kind and no
    // payload rather than pretending either way.
    const xml = observe('text/xml', null);
    expect(xml).toMatchObject({ document_kind: 'non_html', content_type: 'text/xml', text: '', text_total: 0 });

    // HTML is untouched, including a document that declares no type.
    for (const htmlType of ['text/html', 'application/xhtml+xml', '']) {
      const html = observe(htmlType, 'code block that must stay stripped');
      expect(html.document_kind, htmlType).toBeUndefined();
      expect(html.text, htmlType).toBe('');
    }

    // The kind has to survive the sanitizer, or the caller still cannot tell an
    // unreadable document from an empty one.
    const passed = sanitizeWebAssistObservation(first, 'page-1', 'https://example.com/report.json');
    expect(passed?.publicSnapshot).toMatchObject({
      document_kind: 'non_html', content_type: 'application/json', text_total: payload.length,
    });
    const htmlSnapshot = sanitizeWebAssistObservation(
      observe('text/html', null), 'page-2', 'https://example.com/',
    );
    expect(htmlSnapshot?.publicSnapshot).not.toHaveProperty('document_kind');
  });

  it('serializes model text as data and structurally protects sensitive readback', () => {
    const observeScript = webAssistObserveScript();
    expect(observeScript).not.toContain('element.value');
    expect(observeScript).not.toContain('document.body.innerText');
    expect(observeScript).toContain('skippedTags.has(node.tagName) || node.isContentEditable');

    const actionScript = buildWebAssistActionScript({
      action: 'fill',
      text: '</script>;globalThis.compromised=true',
      ref: {
        path: [0, 1, 2],
        signature: { tag: 'input', type: 'text', role: '', label: 'Name' },
      },
    });
    expect(actionScript).not.toContain('</script>');
    expect(actionScript).toContain("code: 'value_not_readable'");
    expect(actionScript).toContain("autocomplete.includes('one-time-code')");
  });

  it.each(['browser', 'connector_setup'] as const)('automates authorized ordinary and sensitive submissions in %s', (scope) => {
    for (const label of ['Save', 'Search', 'Send', '发送', '提交', '确认', 'Apply', '送信', '確認', 'Enviar', 'Confirmar']) {
      for (const type of ['button', 'submit']) {
        const ordinary = executeSubmitAction({ sensitive: false, scope, label, type });
        expect(ordinary.requiresUserAction, label).toBe(false);
        expect(ordinary.result, label).toMatchObject({ ok: true, outcome: 'acted', action: 'click' });
        expect(ordinary.clicks, label).toBe(1);
      }
    }
    for (const fields of [
      { sensitive: true },
      { sensitive: false, autocomplete: 'current-password' },
      { sensitive: false, autocomplete: 'new-password' },
      { sensitive: false, autocomplete: 'one-time-code' },
      { sensitive: false, autocomplete: 'section-payment cc-number' },
      { sensitive: false, autocomplete: 'SECTION-PAYMENT CC-CSC' },
    ]) {
      const sensitive = executeSubmitAction({ ...fields, scope, label: 'Confirm' });
      expect(sensitive.requiresUserAction).toBe(false);
      expect(sensitive.result).toMatchObject({ ok: true });
      expect(sensitive.clicks).toBe(1);
    }
  });

  it.each([
    { tag: 'button' as const, type: 'submit', label: '' },
    { tag: 'input' as const, type: 'submit', label: 'Submit' },
    { tag: 'input' as const, type: 'image', label: 'Send' },
  ])('allows task submissions with ordinary or sensitive fields', (control) => {
    const ordinary = executeSubmitAction({ ...control, sensitive: false });
    expect(ordinary).toMatchObject({ requiresUserAction: false, result: { ok: true }, clicks: 1 });
    const sensitive = executeSubmitAction({ ...control, sensitive: true });
    expect(sensitive).toMatchObject({
      requiresUserAction: false, result: { ok: true }, clicks: 1,
    });
  });

  it.each([
    { nextLabel: 'Delete account', code: 'stale_element' },
    { becomesDisabled: true, code: 'element_disabled' },
  ])('rejects an observed ordinary button whose state changes: $code', (change) => {
    const action = executeSubmitAction({ sensitive: false, label: 'Confirm', ...change });
    expect(action).toMatchObject({ requiresUserAction: false, result: { ok: false, code: change.code }, clicks: 0 });
  });

  it('permits an authorized submission when a form adds sensitive controls', () => {
    const action = executeSubmitAction({ sensitive: false, scope: 'connector_setup', label: 'Send', becomesSensitive: true });
    expect(action.requiresUserAction).toBe(false);
    expect(action.result).toMatchObject({ ok: true });
    expect(action.clicks).toBe(1);
  });

  // Latin label evidence uses whole action words; sensitive payment fields
  // are covered independently by the form-submission cases above.
  it.each(['Purchase now', 'Pay now', '确认支付', '删除', 'Authorize', 'Publish', 'CAPTCHA'])(
    'executes a task button labelled %s without classifying its text', (label) => {
      const action = executeSubmitAction({ sensitive: false, type: 'submit', label });
      expect(action.requiresUserAction).toBe(false);
      expect(action.result).toMatchObject({ ok: true });
      expect(action.clicks).toBe(1);
    },
  );

  it.each([
    { action: 'click', type: 'checkbox', checked: false, label: 'Authorize access' },
    { action: 'check', type: 'checkbox', checked: false, label: 'Authorize access' },
    { action: 'uncheck', type: 'checkbox', checked: true, label: 'Cancel subscription' },
    { action: 'check', type: 'radio', checked: false, label: 'Approve payment' },
  ] as const)('executes $type $action regardless of its label', (control) => {
    const action = executeSubmitAction({ sensitive: false, tag: 'input', ...control });
    expect(action.result).toMatchObject({ ok: true });
    expect(action.clicks).toBe(1);
    expect(action.checked).toBe(control.type === 'radio' || control.action !== 'uncheck');
  });

  it.each([
    { action: 'check', type: 'checkbox', checked: false, expected: true },
    { action: 'uncheck', type: 'checkbox', checked: true, expected: false },
    { action: 'check', type: 'radio', checked: false, expected: true },
  ] as const)('retains ordinary and connector-setup $type $action behavior', (control) => {
    for (const scope of ['browser', 'connector_setup'] as const) {
      const action = executeSubmitAction({
        sensitive: false, tag: 'input', ...control, scope,
        label: scope === 'browser' ? 'Show details' : 'Authorize access',
      });
      expect(action.result).toMatchObject({ ok: true, outcome: 'acted', action: control.action });
      expect(action.clicks).toBe(1);
      expect(action.checked).toBe(control.expected);
    }
  });

  it.each([
    { action: 'check', checked: true },
    { action: 'uncheck', checked: false },
  ] as const)('keeps an already satisfied high-impact $action free of side effects', (control) => {
    const action = executeSubmitAction({
      sensitive: false, tag: 'input', type: 'checkbox', label: 'Authorize access', ...control,
    });
    expect(action.result).toMatchObject({ ok: true, outcome: 'acted', action: control.action });
    expect(action.clicks).toBe(0);
    expect(action.checked).toBe(control.checked);
  });

});

describe('browser field value readback', () => {
  function reader(tag = 'INPUT', type = 'text', autocomplete = '', value = '') {
    class Field {
      tagName = tag; disabled = true; readOnly = true;
      type = type; autocomplete = autocomplete; value = value;
      innerText = value; isContentEditable = tag === 'DIV';
      selectedOptions = [{ label: '日本語' }];
      getAttribute(name: string) { return name === 'aria-label' ? 'Draft' : name === 'type' ? this.type : null; }
      scrollIntoView() { throw new Error('Read must not move or focus the field'); }
    }
    const field = new Field();
    return (offset = 0) => vm.runInNewContext(buildWebAssistActionScript({
      action: 'read_value', textOffset: offset,
      ref: { path: [0], signature: { tag: tag.toLowerCase(), type, role: '', label: 'Draft' } },
    }), { document: { children: [field] }, Element: Field });
  }

  it.each(['INPUT', 'TEXTAREA', 'DIV'])('reconstructs exact multiline Unicode from %s without mutating it', tag => {
    const value = ('  中文🙂\t日本語\n\n').repeat(1100) + '  tail\n';
    const read = reader(tag, tag === 'INPUT' ? 'text' : '', '', value);
    let offset = 0, actual = '';
    for (;;) {
      const chunk = read(offset);
      expect(chunk).toMatchObject({ ok: true, value_total: value.length, value_offset: offset, untrusted_content: true });
      actual += chunk.value;
      if (chunk.value_next_offset === null) break;
      offset = chunk.value_next_offset;
    }
    expect(actual).toBe(value);
    expect(read(value.length)).toMatchObject({ ok: true, value: '', value_next_offset: null });
    expect(read(value.length + 1)).toMatchObject({ ok: false, code: 'invalid_offset' });
  });

  it('returns a selected value and bounded label without relying on visible page text', () => {
    expect(reader('SELECT', '', '', 'ja')()).toMatchObject({ ok: true, value: 'ja', selected_options: ['日本語'] });
    expect(reader('INPUT', 'text', '', '')()).toMatchObject({ ok: true, value: '', value_total: 0 });
  });

  it.each([
    ['INPUT', 'password', ''], ['INPUT', 'text', 'section-login current-password'],
    ['INPUT', 'text', 'new-password'], ['INPUT', 'text', 'one-time-code'],
    ['INPUT', 'text', 'cc-number'], ['TEXTAREA', '', 'cc-csc'], ['DIV', '', 'one-time-code'],
    ['INPUT', 'file', ''], ['INPUT', 'hidden', ''],
  ])('refuses %s %s %s without returning any value or length', (tag, type, autocomplete) => {
    const result = reader(tag, type, autocomplete, 'fixture-secret')();
    expect(result).toMatchObject({ ok: false, code: 'value_not_readable' });
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    expect(result).not.toHaveProperty('value_total');
  });
});
