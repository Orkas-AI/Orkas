// Pin the bare URL autolink behavior in `src/renderer/modules/utils.js`.
//
// Set A — URLs that MUST end at the right boundary:
//   ASCII whitespace, fullwidth punctuation (comma / period / colon /
//   semicolon / question / exclamation / paren), CJK ideographs, kana,
//   hangul. The reported bug shipped a Chinese full-width comma right
//   after a URL pulling the rest of the sentence into the anchor; the
//   matrix below covers that shape and its siblings.
// Set B — literal mentions that must NOT be re-wrapped: URLs already
//   inside an `<a>` href or wrapped from earlier markdown phases. The
//   negative lookbehind prevents the bare-URL pass from double-wrapping.
//
// Adding a guard / branch / extra char-class tweak to `_BARE_URL_RE`?
// Per PC/CLAUDE.md §9: extend this fixture set with the motivating
// shape AND keep the existing fixtures green. The previous form of this
// regex shipped without test coverage and lasted years before the CJK
// case was reported; that gap is what this file closes.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');
const {
  _BARE_URL_RE,
  _linkifyBareUrls,
  inlineFormat,
  _markdownImageHtml,
  _markdownVideoHtml,
} = utils as {
  _BARE_URL_RE: RegExp;
  _linkifyBareUrls: (text: string) => string;
  inlineFormat: (text: string) => string;
  _markdownImageHtml: (src: string, alt: string, title?: string) => string;
  _markdownVideoHtml: (src: string, label: string, title?: string) => string;
};

const A = (url: string) =>
  `<a href="${url}" target="_blank" rel="noopener">${url}</a>`;

// --- Set A: URLs must end at the correct boundary ------------------------

describe('set A — bare URL termination boundary', () => {
  it('A1. ASCII whitespace (baseline)', () => {
    expect(_linkifyBareUrls('see https://x.com here'))
      .toBe(`see ${A('https://x.com')} here`);
  });

  it('A2. fullwidth comma (the reported bug)', () => {
    const buf = 'see https://skills.sh/，然后参考';
    const out = _linkifyBareUrls(buf);
    expect(out).toBe(`see ${A('https://skills.sh/')}，然后参考`);
  });

  it('A3. CJK ideographic period', () => {
    const buf = 'see https://x.com。末尾';
    expect(_linkifyBareUrls(buf)).toBe(`see ${A('https://x.com')}。末尾`);
  });

  it('A4. fullwidth colon / semicolon / question / exclamation', () => {
    for (const punct of ['：', '；', '？', '！']) {
      const buf = `see https://x.com${punct}rest`;
      expect(_linkifyBareUrls(buf)).toBe(`see ${A('https://x.com')}${punct}rest`);
    }
  });

  it('A5. fullwidth parens', () => {
    expect(_linkifyBareUrls('see https://x.com（note'))
      .toBe(`see ${A('https://x.com')}（note`);
    expect(_linkifyBareUrls('see https://x.com）'))
      .toBe(`see ${A('https://x.com')}）`);
  });

  it('A6. URL preceded by fullwidth colon (Chinese sentence start)', () => {
    const buf = '可以参考：https://x.com。';
    expect(_linkifyBareUrls(buf))
      .toBe(`可以参考：${A('https://x.com')}。`);
  });

  it('A7. URL ending at hiragana', () => {
    const buf = 'https://x.comひ';
    expect(_linkifyBareUrls(buf)).toBe(`${A('https://x.com')}ひ`);
  });

  it('A8. URL ending at katakana', () => {
    const buf = 'https://x.comカ';
    expect(_linkifyBareUrls(buf)).toBe(`${A('https://x.com')}カ`);
  });

  it('A9. URL ending at hangul', () => {
    const buf = 'https://x.com가';
    expect(_linkifyBareUrls(buf)).toBe(`${A('https://x.com')}가`);
  });

  it('A10. URL ending at CJK ideograph (no punctuation)', () => {
    const buf = 'https://x.com中文';
    expect(_linkifyBareUrls(buf)).toBe(`${A('https://x.com')}中文`);
  });

  it('A11. trailing ASCII period — period outside the link', () => {
    expect(_linkifyBareUrls('see https://x.com.'))
      .toBe(`see ${A('https://x.com')}.`);
  });

  it('A12. URL with query string and fragment', () => {
    const url = 'https://x.com/path?q=v&k=1#frag';
    expect(_linkifyBareUrls(`go ${url}`)).toBe(`go ${A(url)}`);
  });

  it('A13. URL on its own line — full URL captured', () => {
    expect(_linkifyBareUrls('https://skillhub.cn/skills/find-skills'))
      .toBe(A('https://skillhub.cn/skills/find-skills'));
  });

  it('A14. multiple URLs in one CJK sentence', () => {
    const buf = '参考 https://a.com/，还有 https://b.com/。';
    const out = _linkifyBareUrls(buf);
    expect(out).toContain(A('https://a.com/'));
    expect(out).toContain(A('https://b.com/'));
    expect(out).not.toContain('href="https://a.com/，');
    expect(out).not.toContain('href="https://b.com/。');
  });
});

// --- Set B: must not double-wrap or re-wrap ------------------------------

describe('set B — already-wrapped URLs must not be re-wrapped', () => {
  it('B1. URL inside `<a href="...">` is left alone (lookbehind catches `"`)', () => {
    const wrapped = `<a href="https://x.com">https://x.com</a>`;
    expect(_linkifyBareUrls(wrapped)).toBe(wrapped);
  });

  it('B2. markdown `[text](url)` round-trips through inlineFormat without re-wrap', () => {
    const out = inlineFormat('[click](https://x.com)');
    // exactly one <a> tag
    expect((out.match(/<a /g) || []).length).toBe(1);
    expect(out).toContain('href="https://x.com"');
  });

  it('B3. `<https://x.com>` autolink round-trips without re-wrap', () => {
    const out = inlineFormat('<https://x.com>');
    expect((out.match(/<a /g) || []).length).toBe(1);
  });

  it('B4. URL inside an existing img src attr is not re-matched', () => {
    const wrapped = `<img src="https://x.com/img.png" alt="">`;
    expect(_linkifyBareUrls(wrapped)).toBe(wrapped);
  });
});

describe('markdown media links', () => {
  it('renders normal markdown images with the chat image class', () => {
    const out = inlineFormat('![car](chat-media://local/Users/test/car.png "preview")');
    expect(out).toContain('<img class="chat-md-img"');
    expect(out).toContain('src="chat-media://local/Users/test/car.png"');
    expect(out).toContain('alt="car"');
    expect(out).toContain('title="preview"');
  });

  it('escapes markdown image attributes', () => {
    const out = _markdownImageHtml('https://x.test/a.png?x="y"', '<car>', '"preview"');
    expect(out).toContain('src="https://x.test/a.png?x=&quot;y&quot;"');
    expect(out).toContain('alt="&lt;car&gt;"');
    expect(out).toContain('title="&quot;preview&quot;"');
  });

  it('renders a normal markdown link to chat-media mp4 as an inline player', () => {
    const out = inlineFormat('[video](chat-media://local/Users/test/car_driving.mp4)');
    expect(out).toContain('<video class="chat-md-video"');
    expect(out).toContain('controls');
    expect(out).toContain('controlslist="nodownload nofullscreen noremoteplayback"');
    expect(out).toContain('disablepictureinpicture');
    expect(out).toContain('disableremoteplayback');
    expect(out).toContain('preload="metadata"');
    expect(out).toContain('src="chat-media://local/Users/test/car_driving.mp4"');
    expect(out).not.toContain('<a ');
  });

  it('escapes markdown video attributes', () => {
    const out = _markdownVideoHtml('https://x.test/a.mp4?x="y"', '<clip>', '"preview"');
    expect(out).toContain('src="https://x.test/a.mp4?x=&quot;y&quot;"');
    expect(out).toContain('aria-label="&lt;clip&gt;"');
    expect(out).toContain('title="&quot;preview&quot;"');
  });

  it('keeps non-video markdown links as anchors', () => {
    const out = inlineFormat('[clip](chat-media://local/Users/test/notes.txt)');
    expect(out).toContain('<a ');
    expect(out).toContain('href="chat-media://local/Users/test/notes.txt"');
    expect(out).not.toContain('<video ');
  });
});

// --- Boundary regex sanity ----------------------------------------------

describe('_BARE_URL_RE termination set', () => {
  it('rejects fullwidth comma as URL char', () => {
    // ， (fullwidth comma) must NOT be captured as part of URL body
    const m = 'see https://x.com，more'.match(_BARE_URL_RE);
    expect(m && m[0]).toBe('https://x.com');
  });

  it('rejects CJK ideograph as URL char', () => {
    const m = 'see https://x.com中more'.match(_BARE_URL_RE);
    expect(m && m[0]).toBe('https://x.com');
  });

  it('still accepts ASCII URL chars including `?`, `=`, `&`, `#`, `%`, `_`', () => {
    const m = 'go https://x.com/path?q=v&k=1#a_b%20c here'.match(_BARE_URL_RE);
    expect(m && m[0]).toBe('https://x.com/path?q=v&k=1#a_b%20c');
  });
});

// --- Empty / no-op inputs -----------------------------------------------

describe('empty / no-op inputs', () => {
  it('empty string passes through', () => {
    expect(_linkifyBareUrls('')).toBe('');
  });

  it('plain prose without URL passes through', () => {
    const buf = '今天天气不错';
    expect(_linkifyBareUrls(buf)).toBe(buf);
  });
});
