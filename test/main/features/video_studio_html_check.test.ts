import { describe, expect, it } from 'vitest';
import { parseHtmlStructure } from '../../../src/main/features/video_studio_html_check';

describe('HTML copy character references', () => {
  it.each([
    ['¥99', '¥99'], ['&yen;99', '¥99'], ['&#165;99', '¥99'], ['&#xA5;99', '¥99'],
    ['&euro;9 &pound;8 &copy;', '€9 £8 ©'], ['A&nbsp;B', 'A B'],
    ['&#x1F600; &#20013;', '😀 中'], ['&#128;9', '€9'],
    ['&amp;yen;99', '&yen;99'], ['&amp;#165;99', '&#165;99'],
    ['&amp;lt;b&amp;gt;', '&lt;b&gt;'], ['&lt;b&gt;', '<b>'],
    ['&AMP; &QUOT; &LT; &GT;', '& " < >'], ['&#38;yen;99', '&yen;99'],
    ['&unknown;', '&unknown;'], ['&#0; &#xD800; &#1114112;', '� � �'],
  ])('extracts %s as the once-decoded text %s', (source, expected) => {
    expect(parseHtmlStructure(`<div>${source}</div>`).textContent).toBe(expected);
  });

  it('keeps script/style/comment/attribute text out of copy and leaves resource identities unchanged', () => {
    const structure = parseHtmlStructure('<script>const price="&#165;99";</script>'
      + '<style>body:before{content:"&yen;99"}</style><!-- ¥99 -->'
      + '<img src="assets/a&amp;b.png" alt="¥99"><div>&amp;yen;99</div>');
    expect(structure.textContent).toBe('&yen;99');
    expect(structure.tags.find(tag => tag.tagName === 'img')?.attrs).toEqual({ src: 'assets/a&b.png', alt: '¥99' });
  });

  it('decodes long supplied copy and keeps escaped markup as text rather than resource references', () => {
    const count = 100001;
    expect(parseHtmlStructure(`<div>${'&copy;'.repeat(count)}</div>`).textContent).toBe('©'.repeat(count));
    const escaped = parseHtmlStructure('<div>&lt;img src="outside.png"&gt;</div>');
    expect(escaped.tags.map(tag => tag.tagName)).toEqual(['div']);
    expect(escaped.textContent).toBe('<img src="outside.png">');
  });
});
