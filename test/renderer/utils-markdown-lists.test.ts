import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { renderMarkdown } = require('../../src/renderer/modules/utils.js') as {
  renderMarkdown: (md: string) => string;
};

describe('markdown ordered-list numbering', () => {
  it('restarts a new list when the source restarts at 1 after a paragraph', () => {
    const html = renderMarkdown(`前置建议：

1. 先扫描
2. 再确认
3. 最后处理

建议的根治顺序：

1. 先做诊断
2. 再做改造
3. 最后回填`);

    expect(html.match(/<ol(?:\s[^>]*)?>/g)).toEqual(['<ol>', '<ol>']);
    expect(html).not.toContain('<ol start="4">');
  });

  it('honors an explicit non-one start on a new list', () => {
    const html = renderMarkdown(`前置说明。

4. 从第四项继续
5. 完成`);

    expect(html).toContain('<ol start="4">');
  });
});
