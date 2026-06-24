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
// Per PC/CLAUDE.md §9 (text-processing parsers need both matching and
// look-alike non-matching fixtures), this pins both the safe shapes that MUST
// survive (http/https/mailto/tel + the app's chat-media/chat-app/kb-file/blob
// schemes + relative refs) and the dangerous shapes that MUST be dropped.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');
const {
  _safeHref,
  inlineFormat,
  sanitizeHtml,
} = utils as {
  _safeHref: (url: string) => string;
  inlineFormat: (text: string) => string;
  sanitizeHtml: (html: string) => string;
};

describe('_safeHref — safe URI allow-list', () => {
  it('keeps standard safe schemes', () => {
    for (const u of [
      'https://example.com/a?b=1&c=2',
      'http://x.com',
      'mailto:a@b.com',
      'tel:+1234567890',
    ]) expect(_safeHref(u)).toBe(u);
  });

  it("keeps the app's privileged schemes (media/artifact/KB/blob)", () => {
    for (const u of [
      'chat-media://local/Users/user/car.png',
      'chat-app://app/123/index.html',
      'kb-file://doc/intro.md',
      'blob:https://app/9f2c-uuid',
    ]) expect(_safeHref(u)).toBe(u);
  });

  it('keeps scheme-less relative / anchor / path refs', () => {
    for (const u of ['/abs/path', './rel', '../up', '#anchor', 'plain/path']) {
      expect(_safeHref(u)).toBe(u);
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
    expect(out).toContain('href=""');
  });

  it('escapes a quote in the URL so it cannot break out of href=""', () => {
    const out = inlineFormat('[x](https://a.com"onmouseover=alert(1)');
    // The raw attribute-breakout sequence must not appear; the quote is encoded.
    expect(out).not.toContain('a.com"onmouseover');
    expect(out).toContain('&quot;');
  });

  it('preserves the app chat-media scheme in a markdown link', () => {
    const out = inlineFormat('[clip](chat-media://local/Users/user/notes.txt)');
    expect(out).toContain('href="chat-media://local/Users/user/notes.txt"');
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
