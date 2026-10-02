import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const utils = require('../../src/renderer/modules/utils.js');

const {
  renderMarkdown,
  sanitizeMathExpressionForMathJax,
} = utils as {
  renderMarkdown: (md: string) => string;
  sanitizeMathExpressionForMathJax: (expr: string) => string;
};

describe('markdown math rendering', () => {
  it('preserves nested code/math and literal replacement characters in the same reply', () => {
    const html = renderMarkdown('Example `$y$` and ``\\(a+b\\)``.\n\n$$x_1 + y_2$$\n\n```txt\n$1 $& $$ <tag>\n```');
    expect(html).toContain('<code>$y$</code>');
    expect(html).toContain('<code>\\(a+b\\)</code>');
    expect(html).toContain('$$x_1 + y_2$$');
    expect(html).toContain('<pre><code>$1 $&amp; $$ &lt;tag&gt;</code></pre>');
    expect(html).not.toContain('\x00BLOCK');
  });

  it('keeps every distinct code sample and formula in a long technical answer', () => {
    const sections = Array.from({ length: 1000 }, (_, i) =>
      `## Example ${i}\n\nUse \`value_${i}\` and $x_{${i}}$.\n\n\`\`\`js\nconst value_${i} = ${i};\n\`\`\`\n`);
    const html = renderMarkdown(sections.join('\n'));
    for (let i = 0; i < sections.length; i++) {
      expect(html).toContain(`<code>value_${i}</code>`);
      expect(html).toContain(`$x_{${i}}$`);
      expect(html).toContain(`<pre><code>const value_${i} = ${i};</code></pre>`);
    }
    expect(html.match(/<pre>/g)).toHaveLength(1000);
    expect(html).not.toContain('\x00BLOCK');
  });

  it('converts blank underscores inside math to valid TeX underlines', () => {
    const html = renderMarkdown('点 \\((x,y)=(__, __)\\)，代入 \\(y=2x+b\\)，所以 __ = 2×__ + b。');

    expect(html).toContain('\\((x,y)=(\\underline{\\hspace{1.5em}}, \\underline{\\hspace{1.5em}})\\)');
    expect(html).toContain('所以 __ = 2×__ + b');
  });

  it('keeps normal single-subscript TeX unchanged', () => {
    expect(sanitizeMathExpressionForMathJax('x_i + a_{n+1}')).toBe('x_i + a_{n+1}');
  });

  it('normalizes boldsymbol so the offline MathJax bundle does not lazy-load extensions', () => {
    const html = renderMarkdown('抛物线解析式： $\\boldsymbol{y=2x^2-8x+6}$');

    expect(html).toContain('$\\mathbf{y=2x^2-8x+6}$');
    expect(html).not.toContain('\\boldsymbol');
  });
});
