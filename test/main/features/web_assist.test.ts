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

function executeSubmitAction(options: { sensitive: boolean; scope?: WebAssistPageScope; label?: string; type?: string }): {
  result: Record<string, unknown>;
  clicks: number;
} {
  class FakeElement {
    children: FakeElement[] = [];
    disabled = false;
    form: { elements: FakeElement[] } | null = null;
    innerText: string;
    isContentEditable = false;
    labels: FakeElement[] = [];
    tagName: string;
    type: string;
    autocomplete: string;
    clicks = 0;

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

    scrollIntoView(): void {}
    focus(): void {}
    click(): void { this.clicks += 1; }
  }

  const submit = new FakeElement('button', options.type || 'submit', options.label || 'Save');
  const fields = options.sensitive
    ? [new FakeElement('input', 'password', 'Password', 'current-password')]
    : [new FakeElement('input', 'text', 'Display name')];
  submit.form = { elements: fields };
  const script = buildWebAssistActionScript({
    action: 'click',
    ref: {
      path: [0],
      signature: { tag: 'button', type: submit.type, role: '', label: submit.innerText },
    },
  }, options.scope);
  const result = vm.runInNewContext(script, {
    document: { children: [submit] },
    Element: FakeElement,
  }) as Record<string, unknown>;
  return { result, clicks: submit.clicks };
}

describe('Web Assist security boundary', () => {
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
    expect(normalizeWebAssistUserUrl('localhost:4400/docs')).toBe('https://localhost:4400/docs');
    expect(normalizeWebAssistUserUrl('127.0.0.1:4400/docs')).toBe('https://127.0.0.1:4400/docs');

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
        requires_user_action: true,
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
        fillable: false,
        requires_user_action: true,
      }],
    });
    expect(JSON.stringify(sanitized?.publicSnapshot)).not.toContain('must-never-escape');
    expect(JSON.stringify(sanitized?.publicSnapshot)).not.toContain('"path"');
    expect(sanitized?.refs.get('e1')).toMatchObject({ path: [0, 1, 2] });
  });

  it('uses fixed reviewed scripts and structurally protects sensitive actions', () => {
    const observeScript = webAssistObserveScript();
    expect(observeScript).toContain("type === 'password'");
    expect(observeScript).toContain("autocomplete.includes('one-time-code')");
    expect(observeScript).toContain('highImpactControl');
    expect(observeScript).toContain("'purchase'");
    expect(observeScript).toContain("'删除'");
    expect(observeScript).not.toContain('element.value');
    expect(observeScript).not.toContain('document.body.innerText');
    expect(observeScript).toContain("clone.querySelectorAll('code,pre,kbd,samp,input,textarea,select,[contenteditable=\"true\"]')");

    const actionScript = buildWebAssistActionScript({
      action: 'fill',
      text: '</script>;globalThis.compromised=true',
      ref: {
        path: [0, 1, 2],
        signature: { tag: 'input', type: 'text', role: '', label: 'Name' },
      },
    });
    expect(actionScript).not.toContain('</script>');
    expect(actionScript).toContain("code: 'user_action_required'");
    expect(actionScript).toContain("reason: 'sensitive_input'");
    expect(actionScript).toContain("'high_impact_action'");
    expect(actionScript).toContain("'form_submission_or_authorization'");
  });

  it('allows connector setup form submission but hands sensitive form completion to the user', () => {
    const ordinary = executeSubmitAction({ sensitive: false, scope: 'connector_setup' });
    expect(ordinary.result).toMatchObject({ ok: true, outcome: 'acted', action: 'click' });
    expect(ordinary.clicks).toBe(1);

    const sensitive = executeSubmitAction({ sensitive: true, scope: 'connector_setup' });
    expect(sensitive.result).toMatchObject({
      ok: false,
      code: 'user_action_required',
      reason: 'sensitive_form_submission',
    });
    expect(sensitive.clicks).toBe(0);
  });

  it.each([
    { type: 'submit', label: 'Save', reason: 'form_submission_or_authorization' },
    { type: 'button', label: 'Purchase now', reason: 'high_impact_action' },
  ])('preserves the general browser handback for $label', ({ type, label, reason }) => {
    const action = executeSubmitAction({ sensitive: false, type, label });
    expect(action.result).toMatchObject({ ok: false, code: 'user_action_required', reason });
    expect(action.clicks).toBe(0);
  });
});
