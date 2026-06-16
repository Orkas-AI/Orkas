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
