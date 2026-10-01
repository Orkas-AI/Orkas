import { describe, expect, it } from 'vitest';

const { renderMarkdown } = require('../../src/renderer/modules/utils.js');

// A streamed prefix must keep the established renderer's interpretation even
// when the next token retroactively closes syntax or suppresses earlier media.
// Real DOMPurify/context parsing and live-node continuity are covered by the
// owning chat_e2e_streaming_markdown browser cases.
const scenarios = [
  ['nested lists and quotes', '# Plan\n\n- one\n  - child\n\n  3. nested\n- [x] done\n\n> quote\n> second\n\nend'],
  ['growing tables', '| A | B |\n| :--- | ---: |\n| **one** | `two` |\n| three | four |\n\nend'],
  ['unequal fences and inline code', 'Mention ```` ``` ````.\n\n````js\n```\n$x$\n<div>literal</div>\n````\n\nend'],
  ['code spanning blank lines', 'before `one\n\ntwo` after\n\n```text\none\n\ntwo\n```'],
  ['math and currency', 'Cost $50 / $100.\n\n$$a\n\n+b$$\n\\[c\n+d\\]\n\\(e+f\\) and $g$ and `$h$`'],
  ['media dedup across blocks', '[image](chat-media://fixture/image.png)\n\ntext\n\n![image](chat-media://fixture/image.png)'],
  ['raw HTML context', 'before\n\n<div class="box">\n\n**inside**\n\n</div>\n\nend'],
  ['frontmatter and directives', '---\ntitle: sample\n---\n# Result\n\n:::chart-bar\n[{"label":"A","value":2}]\n:::'],
  ['protected block indexes shift', 'before $a$\n\n`$b$`\n\n$$c$$\n\n```txt\nx\n```'],
];

describe('streamed Markdown block compatibility', () => {
  it.each(scenarios)('preserves %s through every split and replacement', (_name, source) => {
    const cache: any = {};
    for (let end = 1; end <= source.length; end++) {
      const prefix = source.slice(0, end);
      expect(renderMarkdown(prefix, cache), `prefix ${end}`).toBe(renderMarkdown(prefix));
      expect(cache.blocks.join('')).toBe(renderMarkdown(prefix));
    }
    for (const replacement of ['replacement $z$', source.slice(0, 15), source, '']) {
      expect(renderMarkdown(replacement, cache)).toBe(renderMarkdown(replacement));
    }
  });

  it('retains only the current document as a reply grows and is replaced', () => {
    const cache: any = {};
    const prefix = '# Stable\n\nParagraph **one**.\n\n';
    for (let i = 0; i < 120; i++) renderMarkdown(prefix + `tail-${i}`, cache);
    const retained = [...cache.inline.keys(), ...cache.sanitized.keys()].join('\n');
    expect(retained).toContain('tail-119');
    expect(retained).not.toContain('tail-118');
    renderMarkdown('Replacement', cache);
    expect([...cache.inline.keys(), ...cache.sanitized.keys()].join('\n')).not.toContain('Stable');
    renderMarkdown('', cache);
    expect(cache.inline.size + cache.sanitized.size + cache.blocks.length).toBe(0);
  });
});
