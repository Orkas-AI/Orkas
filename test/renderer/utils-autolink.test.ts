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
  _markdownAudioHtml,
  _markdownHtmlEmbedHtml,
  _isHtmlSrc,
  _chatMediaLocalPathFromUrl,
  _normalizeLocalMediaSrc,
  _chatVideoNativeControlsHit,
} = utils as {
  _BARE_URL_RE: RegExp;
  _linkifyBareUrls: (text: string) => string;
  inlineFormat: (text: string) => string;
  _markdownImageHtml: (src: string, alt: string, title?: string) => string;
  _markdownVideoHtml: (src: string, label: string, title?: string) => string;
  _markdownAudioHtml: (src: string, label: string, title?: string) => string;
  _markdownHtmlEmbedHtml: (src: string, label: string, title?: string) => string;
  _isHtmlSrc: (src: string) => boolean;
  _chatMediaLocalPathFromUrl: (src: string) => string;
  _normalizeLocalMediaSrc: (src: string) => string;
  _chatVideoNativeControlsHit: (clientY: number, rectTop: number, rectBottom: number) => boolean;
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
    expect(out).toContain('<span class="chat-image-shell chat-md-img-shell is-loading">');
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

  it.each([
    ['HTML', 'chat-media://local/Users/test/poster.html?v=123'],
    ['HTM', 'chat-media://local/Users/test/poster.htm#page'],
    ['uppercase extension', 'chat-media://local/Users/test/poster.HTML'],
    ['encoded Chinese path', 'chat-media://local/Users/test/%E5%9F%8E%E5%B8%82%E6%B5%B7%E6%8A%A5.html?v=123#preview'],
    ['encoded spaces and punctuation', 'chat-media://local/Users/test/poster%20%231%3F.html?v=123'],
  ])('routes local %s markdown image targets to an inline HTML mount point', (_label, src) => {
    const out = inlineFormat(`![poster preview](${src})`);
    expect(out).toContain('<span class="chat-md-html-embed is-loading"');
    expect(out).toContain('data-chat-md-html-embed="1"');
    expect(out).toContain(`data-html-src="${src}"`);
    expect(out).toContain('data-html-title="Preview: poster preview"');
    expect(out).not.toContain('<img ');
    expect(out).not.toContain('<iframe');
  });

  it('emits one independent mount point for each local HTML output', () => {
    const out = inlineFormat([
      '![first](chat-media://local/Users/test/first.html)',
      '![second](chat-media://local/Users/test/second.htm)',
    ].join('\n'));

    expect(out.match(/data-chat-md-html-embed="1"/g)).toHaveLength(2);
    expect(out).toContain('data-html-src="chat-media://local/Users/test/first.html"');
    expect(out).toContain('data-html-src="chat-media://local/Users/test/second.htm"');
  });

  it.each([
    'chat-media://local/Users/test/poster.html.png',
    'chat-media://local/Users/test/poster.html5',
    'chat-media://local/Users/test/poster.xhtml',
    'chat-media://local/Users/test/poster.png?download=poster.html',
    'chat-media://local/Users/test/poster.png#poster.html',
  ])('keeps the HTML lookalike %s on the normal image path', (src) => {
    const out = inlineFormat(`![poster](${src})`);
    expect(_isHtmlSrc(src)).toBe(false);
    expect(out).toContain('<img class="chat-md-img"');
    expect(out).not.toContain('data-chat-md-html-embed');
  });

  it('escapes HTML mount attributes and keeps unsafe non-local targets inert', () => {
    const local = _markdownHtmlEmbedHtml(
      'chat-media://local/Users/test/poster.html?x="y"',
      '<poster>',
      '"preview"',
    );
    expect(local).toContain('data-html-src="chat-media://local/Users/test/poster.html?x=&quot;y&quot;"');
    expect(local).toContain('data-html-title="&quot;preview&quot;"');
    expect(_markdownHtmlEmbedHtml('javascript:alert(1).html', '<poster>')).toBe('&lt;poster&gt;');
  });

  it('keeps a remote HTML target as an external preview link instead of embedding it', () => {
    const out = inlineFormat('![docs](https://example.test/preview.html)');
    expect(out).toContain('<a href="https://example.test/preview.html"');
    expect(out).toContain('>docs</a>');
    expect(out).not.toContain('data-chat-md-html-embed');
  });

  it('renders a normal markdown link to chat-media mp4 as an inline player', () => {
    const out = inlineFormat('[video](chat-media://local/Users/test/car_driving.mp4)');
    expect(out).toContain('<span class="chat-md-video-shell" data-chat-video-playback-surface="markdown_bubble">');
    expect(out).toContain('<video class="chat-md-video"');
    expect(out).toContain('width="640"');
    expect(out).toContain('height="360"');
    expect(out).toContain('controls');
    expect(out).toContain('controlslist="nodownload nofullscreen noremoteplayback"');
    expect(out).toContain('disablepictureinpicture');
    expect(out).toContain('disableremoteplayback');
    expect(out).toContain('preload="metadata"');
    expect(out).toContain('src="chat-media://local/Users/test/car_driving.mp4"');
    expect(out).toContain('class="chat-md-video-float"');
    expect(out).toContain('data-chat-md-video-open="1"');
    expect(out).toContain('data-video-src="chat-media://local/Users/test/car_driving.mp4"');
    expect(out).toContain('aria-label="Fullscreen"');
    expect(out).not.toContain('<a ');
  });

  // A finished 62s video reached the user as a dead player: the agent wrote
  // `[视频成片](sandbox:/Users/…/orkas-promo-final.mp4)` — a path convention from
  // its own training — and the media branches dispatch on the file extension
  // alone, so Chromium got a scheme it cannot fetch. Controls rendered, 0:00,
  // black frame, and the main process never saw a request. `_safeHref` is no
  // safety net here: it allows only http(s)/mailto/tel, so the alternative was
  // bare text. Two earlier conversations carry the same shape.
  it('plays a local file an agent addressed with its own path convention', () => {
    const cases = [
      'sandbox:/Users/test/render/orkas-promo-final.mp4',
      '/Users/test/render/orkas-promo-final.mp4',
      'file:///Users/test/render/orkas-promo-final.mp4',
    ];
    for (const src of cases) {
      for (const md of [`[视频成片](${src})`, `![成片](${src})`]) {
        const out = inlineFormat(md);
        expect(out, md).toContain('src="chat-media://local/Users/test/render/orkas-promo-final.mp4"');
        expect(out, md).toContain('<video class="chat-md-video"');
        // The floating-player button only appears once the src resolves back to
        // a local path, so it doubles as proof the rewrite reached the player.
        expect(out, md).toContain('data-chat-md-video-open="1"');
        expect(out, md).not.toContain('sandbox:');
      }
    }
  });

  it('leaves srcs it cannot resolve or must not touch alone', () => {
    // No base directory exists in the renderer, so a relative path stays as
    // authored — these are document illustrations, not chat media.
    expect(inlineFormat('![fig](k3-figs/post05/01-cover.png)')).toContain('src="k3-figs/post05/01-cover.png"');
    // Already-servable schemes are untouched.
    expect(inlineFormat('[clip](https://x.test/a.mp4)')).toContain('src="https://x.test/a.mp4"');
    expect(inlineFormat('[clip](chat-media://local/Users/test/a.mp4)'))
      .toContain('src="chat-media://local/Users/test/a.mp4"');
    // A non-media link keeps ordinary link handling: an unsafe scheme still
    // renders as text rather than becoming an anchor.
    expect(inlineFormat('[doc](sandbox:/Users/test/notes.txt)')).not.toContain('chat-media://');
    expect(_normalizeLocalMediaSrc('C:\\Users\\test\\render\\clip.mp4'))
      .toBe('chat-media://local/C:/Users/test/render/clip.mp4');
    expect(_normalizeLocalMediaSrc('/Users/test/has space.mp4'))
      .toBe('chat-media://local/Users/test/has%20space.mp4');
  });

  it('escapes markdown video attributes', () => {
    const out = _markdownVideoHtml('https://x.test/a.mp4?x="y"', '<clip>', '"preview"');
    expect(out).toContain('src="https://x.test/a.mp4?x=&quot;y&quot;"');
    expect(out).toContain('aria-label="&lt;clip&gt;"');
    expect(out).toContain('title="&quot;preview&quot;"');
    expect(out).not.toContain('data-chat-md-video-open');
  });

  it('decodes chat-media local video URLs back to absolute paths for the floating player', () => {
    expect(_chatMediaLocalPathFromUrl('chat-media://local/Users/test/has%20space.mp4')).toBe('/Users/test/has space.mp4');
    expect(_chatMediaLocalPathFromUrl('chat-media://local/C:/Users/test/clip.mp4')).toBe('C:/Users/test/clip.mp4');
    expect(_chatMediaLocalPathFromUrl('https://x.test/a.mp4')).toBe('');
  });

  it('reserves native video controls while allowing the rest of the surface to toggle playback', () => {
    expect(_chatVideoNativeControlsHit(351, 100, 360)).toBe(true);
    expect(_chatVideoNativeControlsHit(312, 100, 360)).toBe(true);
    expect(_chatVideoNativeControlsHit(311, 100, 360)).toBe(false);
    expect(_chatVideoNativeControlsHit(200, 100, 360)).toBe(false);
    expect(_chatVideoNativeControlsHit(361, 100, 360)).toBe(false);
  });

  it('renders a normal markdown link to chat-media mp3 as an inline audio player', () => {
    const out = inlineFormat('[audio](chat-media://local/Users/test/hello.mp3)');
    expect(out).toContain('<span class="chat-md-audio-card"');
    expect(out).toContain('<span class="chat-md-audio-name">audio</span>');
    expect(out).toContain('<audio class="chat-md-audio"');
    expect(out).toContain('controls');
    expect(out).toContain('controlslist="nodownload noremoteplayback"');
    expect(out).toContain('preload="metadata"');
    expect(out).toContain('src="chat-media://local/Users/test/hello.mp3"');
    expect(out).not.toContain('<a ');
  });

  it('escapes markdown audio attributes', () => {
    const out = _markdownAudioHtml('https://x.test/a.mp3?x="y"', '<clip>', '"preview"');
    expect(out).toContain('<span class="chat-md-audio-card"');
    expect(out).toContain('<span class="chat-md-audio-name">&lt;clip&gt;</span>');
    expect(out).toContain('src="https://x.test/a.mp3?x=&quot;y&quot;"');
    expect(out).toContain('aria-label="&lt;clip&gt;"');
    expect(out).toContain('title="&quot;preview&quot;"');
  });

  it('renders non-media private-protocol references as inert text', () => {
    const out = inlineFormat('[clip](chat-media://local/Users/test/notes.txt)');
    expect(out).toBe('clip');
    expect(out).not.toContain('<a ');
    expect(out).not.toContain('<video ');
    expect(out).not.toContain('<audio ');
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
