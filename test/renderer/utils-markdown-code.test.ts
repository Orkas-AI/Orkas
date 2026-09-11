// Pin backtick handling in `src/renderer/modules/utils.js` phase 1.
//
// Motivating failure (2026-08-27): a reply that documented this renderer wrote
// a literal fence in prose as a four-backtick inline span. The fence regex was
// hardcoded to three backticks and could open mid-sentence, so it read that as
// "``` plus a stray backtick" and re-paired every later fence in the message.
// One construct cost the reply its whole table, three of four headings and half
// its list items, and — worse — the HTML sample inside the *next* real fence
// escaped the code block and rendered as live DOM.
//
// Two rules close it, both CommonMark: a fence opens a line, and delimiters
// pair on backtick-run length. Two divergences are kept on purpose because the
// dashboard recovery path in `utils-dashboard.test.ts` depends on them — the
// newline after the info string is optional, and the closer may sit on the
// opening line. `>` counts as line-opening whitespace since fences are
// protected before blockquotes are parsed.

import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderMarkdown } = require('../../src/renderer/modules/utils.js') as {
  renderMarkdown: (md: string) => string;
};

const count = (html: string, needle: RegExp) => (html.match(needle) || []).length;

describe('inline code spans pair on backtick-run length', () => {
  it('shows a literal backtick through a double-backtick span', () => {
    expect(renderMarkdown('用 `` ` `` 表示反引号')).toContain('<code>`</code>');
  });

  it('shows a literal fence through a four-backtick span', () => {
    expect(renderMarkdown('用 ```` ``` ```` 表示围栏')).toContain('<code>```</code>');
  });

  it('keeps a single-backtick span working', () => {
    expect(renderMarkdown('用 `code` 表示')).toContain('<code>code</code>');
  });

  it('strips one padding space per side, per CommonMark', () => {
    expect(renderMarkdown('`` a ``')).toContain('<code>a</code>');
    // Only one, and only when both sides have it.
    expect(renderMarkdown('``  a  ``')).toContain('<code> a </code>');
    expect(renderMarkdown('`` a``')).toContain('<code> a</code>');
  });

  it('does not let a shorter run close a longer opener', () => {
    // The lone ` inside is content, not a terminator.
    expect(renderMarkdown('`` a ` b ``')).toContain('<code>a ` b</code>');
  });

  it('treats a mid-sentence fence as inline code, not a block', () => {
    const html = renderMarkdown('去掉外层 ` ```markdown ` 壳');
    expect(html).toContain('<code>```markdown</code>');
    expect(html).not.toContain('<pre>');
  });
});

describe('fenced code blocks', () => {
  it('renders an ordinary fence', () => {
    const html = renderMarkdown('```js\nconst a = 1;\n```');
    expect(html).toContain('<pre><code>const a = 1;</code></pre>');
  });

  it('lets a four-backtick fence carry a three-backtick fence', () => {
    const html = renderMarkdown('````\n```\ninner\n```\n````');
    expect(count(html, /<pre>/g)).toBe(1);
    expect(html).toContain('```\ninner\n```');
  });

  it('keeps a fence inside a blockquote — quoted history arrives as `> ```text`', () => {
    const html = renderMarkdown('> ```text\n> foo\n> ```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('foo');
  });

  it('keeps an indented fence inside a list item', () => {
    const html = renderMarkdown('- item\n  ```js\n  const a = 1;\n  ```');
    expect(html).toContain('<li');
    expect(html).toContain('<pre><code>');
  });

  it('keeps the closer allowed on the opening line (dashboard recovery relies on it)', () => {
    expect(renderMarkdown('```fence-placeholder```')).toContain('<pre><code>');
  });
});

describe('a fence mentioned in prose does not re-pair the fences after it', () => {
  // The exact shape of the broken reply, compressed: prose fence mention,
  // then a table, then a real fence holding an HTML sample.
  const md = [
    '所以 ```` ``` ```` 里的示例不会被当成真嵌入。',
    '',
    '| 输入 | 结果 |',
    '|---|---|',
    '| 链接 + 嵌入 | 1 张 |',
    '',
    '## 输出',
    '',
    '```html',
    '<p><img src="chat-media://local/tmp/card.png" alt="card"></p>',
    '```',
    '',
    '收尾。',
  ].join('\n');

  it('leaves everything between the mention and the real fence as live markdown', () => {
    const html = renderMarkdown(md);
    expect(count(html, /<table/g)).toBe(1);
    expect(html).toContain('<h2>输出</h2>');
    expect(html).toContain('<code>```</code>');
    expect(html).toContain('<p>收尾。</p>');
  });

  it('keeps the HTML sample escaped inside its code block instead of live in the DOM', () => {
    const html = renderMarkdown(md);
    expect(count(html, /<pre>/g)).toBe(1);
    expect(html).toContain('&lt;img src=&quot;chat-media://local/tmp/card.png&quot;');
    // The sample must not become a real element.
    expect(html).not.toContain('<img ');
  });
});
