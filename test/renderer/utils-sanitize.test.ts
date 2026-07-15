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

import { afterEach, describe, it, expect, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');
const {
  _safeHref,
  inlineFormat,
  sanitizeHtml,
  sanitizeSvgIconHtml,
} = utils as {
  _safeHref: (url: string) => string;
  inlineFormat: (text: string) => string;
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

describe('sanitizeHtml — Node fallback (no DOM/DOMPurify)', () => {
  it('returns the input unchanged when DOMPurify is unavailable', () => {
    // In the Node test env there is no window/DOMPurify, so sanitizeHtml is a
    // passthrough — this pins that it does not throw and does not corrupt the
    // markdown renderer output that other Node tests assert on.
    const s = '<div class="markdown-body"><p>hi</p></div>';
    expect(sanitizeHtml(s)).toBe(s);
    expect(sanitizeHtml(null as unknown as string)).toBe('');
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
    expect(config.USE_PROFILES).toEqual({ svg: true, svgFilters: true });
    expect(config.FORBID_TAGS).toContain('script');
    expect(config.FORBID_TAGS).toContain('foreignObject');
    expect(config.FORBID_TAGS).toContain('image');
  });
});
