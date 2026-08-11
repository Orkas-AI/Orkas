// XSS hardening for the markdown link builders in `src/renderer/modules/utils.js`.
//
// Two layers defend the chat renderer against stored XSS (untrusted text:
// user input, LLM output, iOS relay commands, marketplace/skill/KB content):
//   1. DOMPurify on every renderMarkdown output + the isHtmlSnippet path
//      (DOM-side, not unit-tested here — DOMPurify ships its own suite and
//      needs a real DOM; the Node test env has none).
//   2. The PURE layer tested below: `_safeHref` scheme allow-list + escaping
//      the href into the attribute, so `javascript:`/`data:` never reach the
//      DOM and a quoted URL can't break out of `href="..."` even before
//      DOMPurify runs.
//
// The matching and look-alike non-matching fixtures below pin both the
// clickable shapes that MUST survive and resource-only/private shapes that
// MUST NOT become top-level links. Media protocols remain valid for src.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');
const {
  _safeHref,
  inlineFormat,
  _sanitizeHtmlWithoutPurifier,
  sanitizeHtml,
  sanitizeSvgIconHtml,
} = utils as {
  _safeHref: (url: string) => string;
  inlineFormat: (text: string) => string;
  _sanitizeHtmlWithoutPurifier: (html: string) => string;
  sanitizeHtml: (html: string) => string;
  sanitizeSvgIconHtml: (svg: string) => string;
};

afterEach(() => {
  delete (globalThis as typeof globalThis & { DOMPurify?: unknown }).DOMPurify;
});

describe('_safeHref — safe URI allow-list', () => {
  it('keeps standard safe schemes', () => {
    for (const u of [
      'https://example.com/a?b=1&c=2',
      'http://x.com',
      'mailto:a@b.com',
      'tel:+1234567890',
      'sms:+1234567890',
      'callto:+1234567890',
      'xmpp:a@b.com',
    ]) expect(_safeHref(u)).toBe(u);
  });

  it("does not expose the app's resource-only schemes as top-level links", () => {
    for (const u of [
      'chat-media://local/Users/test/car.png',
      'chat-app://app/123/index.html',
      'kb-file://doc/intro.md',
      'blob:https://app/9f2c-uuid',
      'cid:part-1',
    ]) expect(_safeHref(u)).toBe('');
  });

  it('keeps in-page anchors but drops ambiguous relative/path refs', () => {
    expect(_safeHref('#anchor')).toBe('#anchor');
    for (const u of ['/abs/path', './rel', '../up', 'plain/path']) {
      expect(_safeHref(u)).toBe('');
    }
  });

  it('drops javascript: / data: / vbscript: / file: (any case, leading ws)', () => {
    for (const u of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(document.cookie)',
      '  javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
    ]) expect(_safeHref(u)).toBe('');
  });

  it('handles null / undefined / empty', () => {
    expect(_safeHref(null as unknown as string)).toBe('');
    expect(_safeHref(undefined as unknown as string)).toBe('');
    expect(_safeHref('')).toBe('');
  });
});

describe('inlineFormat — markdown link XSS hardening', () => {
  it('renders a normal https link with the href intact', () => {
    const out = inlineFormat('[click](https://x.com)');
    expect(out).toContain('href="https://x.com"');
    expect((out.match(/<a /g) || []).length).toBe(1);
  });

  it('drops a javascript: link href (no live scheme in output)', () => {
    const out = inlineFormat('[tap](javascript:alert(document.cookie))');
    expect(out).not.toMatch(/href="javascript:/i);
    expect(out).not.toContain('<a ');
    expect(out).toContain('tap');
  });

  it('escapes a quote in the URL so it cannot break out of href=""', () => {
    const out = inlineFormat('[x](https://a.com"onmouseover=alert(1)');
    // The raw attribute-breakout sequence must not appear; the quote is encoded.
    expect(out).not.toContain('a.com"onmouseover');
    expect(out).toContain('&quot;');
  });

  it('renders a non-media app protocol reference as inert text', () => {
    const out = inlineFormat('[clip](chat-media://local/Users/test/notes.txt)');
    expect(out).toBe('clip');
  });

  it('keeps anchors in-page and external schemes in a separate browsing context', () => {
    expect(inlineFormat('[section](#details)')).toContain('href="#details"');
    expect(inlineFormat('[section](#details)')).not.toContain('target="_blank"');
    expect(inlineFormat('[mail](mailto:a@b.com)')).toContain('target="_blank"');
  });

  it('escapes the href in <url> autolinks', () => {
    const out = inlineFormat('<https://x.com/?a=1&b=2>');
    expect((out.match(/<a /g) || []).length).toBe(1);
    expect(out).toContain('&amp;'); // & in the query is entity-escaped
    expect(out).not.toContain('?a=1&b=2"'); // raw unescaped form absent
  });
});

describe('sanitizeHtml — missing-runtime containment', () => {
  it('escapes an untrusted HTML snippet when the renderer sanitizer is unavailable', () => {
    const dirty = '<img src=x onerror="window.pwned=1"><script>alert(1)</script>';
    const safe = _sanitizeHtmlWithoutPurifier(dirty);

    expect(safe).toContain('&lt;img');
    expect(safe).toContain('&lt;script&gt;');
    expect(safe).not.toContain('<img');
    expect(safe).not.toContain('<script>');
    expect(_sanitizeHtmlWithoutPurifier(null as unknown as string)).toBe('');
  });
});

describe('sanitizeHtml — DOMPurify hardening', () => {
  it('pins a DOMPurify release containing the prototype-pollution bypass fix', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/vendor/dompurify/purify.min.js'),
      'utf8',
    );
    const provenance = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/vendor/dompurify/README.txt'),
      'utf8',
    );
    expect(source).toContain('@license DOMPurify 3.4.13');
    expect(source).not.toContain('@license DOMPurify 3.2.4');
    expect(provenance).toContain('DOMPurify 3.4.13');
    expect(provenance).toContain('verified dompurify@3.4.13 npm package');
  });

  it('passes a null-prototype config that explicitly disables custom elements', () => {
    const sanitize = vi.fn((value: string) => value);
    (globalThis as typeof globalThis & { DOMPurify?: unknown }).DOMPurify = {
      sanitize,
      addHook: vi.fn(),
    };

    sanitizeHtml('<x-unsafe tabindex="0" onfocus="alert(1)">x</x-unsafe>');

    const config = sanitize.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.getPrototypeOf(config)).toBeNull();
    expect(config.CUSTOM_ELEMENT_HANDLING).toEqual({
      tagNameCheck: null,
      attributeNameCheck: null,
      allowCustomizedBuiltInElements: false,
    });
  });

  it('does not inherit attacker-controlled tag or attribute allow-lists', () => {
    const prototype = Object.prototype as Record<string, unknown>;
    const polluted = {
      ALLOWED_TAGS: ['x-unsafe', 'script'],
      ALLOWED_ATTR: ['onfocus', 'onerror'],
      ADD_TAGS: ['x-unsafe'],
    };
    const previous = new Map(
      Object.keys(polluted).map((key) => [
        key,
        Object.getOwnPropertyDescriptor(prototype, key),
      ]),
    );
    const sanitize = vi.fn((value: string) => value);
    try {
      for (const [key, value] of Object.entries(polluted)) {
        Object.defineProperty(prototype, key, {
          value,
          configurable: true,
          writable: true,
        });
      }
      (globalThis as typeof globalThis & { DOMPurify?: unknown }).DOMPurify = {
        sanitize,
        addHook: vi.fn(),
      };

      sanitizeHtml('<x-unsafe onfocus="alert(1)">x</x-unsafe>');

      const config = sanitize.mock.calls[0][1] as Record<string, unknown>;
      expect(Object.getPrototypeOf(config)).toBeNull();
      for (const key of Object.keys(polluted)) {
        expect(Object.prototype.hasOwnProperty.call(config, key)).toBe(false);
        expect(key in config).toBe(false);
      }
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(prototype, key, descriptor);
        else delete prototype[key];
      }
    }
  });
});

describe('sanitizeSvgIconHtml — connector icon hardening', () => {
  it('drops remote SVG icons when DOMPurify is unavailable', () => {
    expect(sanitizeSvgIconHtml('<svg onload="alert(1)"></svg>')).toBe('');
  });

  it('requires an SVG root', () => {
    expect(sanitizeSvgIconHtml('<img src=x onerror=alert(1)>')).toBe('');
  });

  it('sanitizes SVG with the restricted icon profile', () => {
    const sanitize = vi.fn(() => '<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"></path></svg>');
    (globalThis as typeof globalThis & { DOMPurify?: unknown }).DOMPurify = { sanitize };

    const out = sanitizeSvgIconHtml('<svg onload="alert(1)"><script>alert(1)</script><path /></svg>');

    expect(out).toBe('<svg viewBox="0 0 1 1"><path d="M0 0h1v1z"></path></svg>');
    expect(sanitize).toHaveBeenCalledTimes(1);
    const config = sanitize.mock.calls[0][1];
    expect(Object.getPrototypeOf(config)).toBeNull();
    expect(config.CUSTOM_ELEMENT_HANDLING).toEqual({
      tagNameCheck: null,
      attributeNameCheck: null,
      allowCustomizedBuiltInElements: false,
    });
    expect(config.USE_PROFILES).toEqual({ svg: true, svgFilters: true });
    expect(config.FORBID_TAGS).toContain('script');
    expect(config.FORBID_TAGS).toContain('foreignObject');
    expect(config.FORBID_TAGS).toContain('image');
  });
});
