import { expect, test } from './fixtures/orkas';

test.describe('shared Renderer primitives', () => {
  test('fills dashboard table frames inside chat bubbles at wide and narrow widths', async ({ appPage }) => {
    const layouts = await appPage.evaluate(() => {
      const host = document.createElement('div');
      host.style.position = 'absolute';
      document.body.appendChild(host);
      const table = {
        type: 'Table',
        props: {
          columns: [{ key: 'label', label: '指标' }, { key: 'value', label: '数值', numeric: true }],
          rows: [{ label: '已完成', value: '128' }, { label: '待处理', value: '24' }],
        },
      };
      const results = [];
      try {
        for (const width of [1000, 600, 360, 240]) {
          host.style.width = `${width}px`;
          for (const style of ['minimal', 'card']) {
            const spec = {
              schema_version: 1,
              theme: { style },
              root: {
                type: 'Grid', props: { columns: 2 },
                children: [table, { type: 'Card', props: { title: '项目' }, children: [table] }],
              },
            };
            host.innerHTML = `<div class="chat-history"><div class="chat-message assistant"><div class="chat-bubble"><div class="markdown-body">${
              (window as any).renderMarkdownFull(`:::dashboard\n${JSON.stringify(spec)}\n:::`)
            }</div></div></div></div>`;
            const bubble = host.querySelector<HTMLElement>('.chat-bubble')!;
            results.push({
              width, style, bubbleOverflow: bubble.scrollWidth - bubble.clientWidth,
              tables: Array.from(host.querySelectorAll<HTMLTableElement>('.db-table')).map((node) => ({
                frameWidth: node.parentElement!.clientWidth,
                tableWidth: node.getBoundingClientRect().width,
                rowWidths: Array.from(node.rows).map((row) => row.getBoundingClientRect().width),
                values: Array.from(node.querySelectorAll('td[data-numeric]')).map((cell) => cell.textContent),
                alignment: getComputedStyle(node.querySelector('td[data-numeric]')!).textAlign,
              })),
            });
          }
        }
        return results;
      } finally {
        host.remove();
      }
    });
    for (const layout of layouts) {
      expect(layout.bubbleOverflow, JSON.stringify(layout)).toBeLessThanOrEqual(1);
      expect(layout.tables).toHaveLength(2);
      for (const table of layout.tables) {
        expect(table.frameWidth, JSON.stringify(layout)).toBeGreaterThan(0);
        expect(table.values).toEqual(['128', '24']);
        expect(table.alignment).toBe('right');
        expect(table.rowWidths).toHaveLength(3);
        for (const rowWidth of table.rowWidths) {
          expect(rowWidth, JSON.stringify(layout)).toBeGreaterThanOrEqual(table.frameWidth - 1);
          expect(Math.abs(rowWidth - table.tableWidth)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test('keeps wide dashboard and ordinary Markdown tables scrollable within chat bubbles', async ({ appPage }) => {
    const result = await appPage.evaluate(() => {
      const host = document.createElement('div');
      host.style.position = 'absolute';
      host.style.width = '320px';
      const columns = Array.from({ length: 10 }, (_, index) => ({ key: `c${index}`, label: `Column ${index}`, numeric: true }));
      const values = columns.map((_, index) => `${index}123456789.00`);
      const spec = { root: { type: 'Table', props: { columns, rows: [Object.fromEntries(columns.map((column, index) => [column.key, values[index]]))] } } };
      const markdown = `:::dashboard\n${JSON.stringify(spec)}\n:::\n\n|${columns.map((column) => column.label).join('|')}|\n|${columns.map(() => '---').join('|')}|\n|${values.join('|')}|`;
      host.innerHTML = `<div class="chat-history"><div class="chat-message assistant"><div class="chat-bubble"><div class="markdown-body">${(window as any).renderMarkdownFull(markdown)}</div></div></div></div>`;
      document.body.appendChild(host);
      try {
        const bubble = host.querySelector<HTMLElement>('.chat-bubble')!;
        return {
          bubbleOverflow: bubble.scrollWidth - bubble.clientWidth,
          tables: ['.db-table-wrap', 'table:not(.db-table)'].map((selector) => {
            const scroller = host.querySelector<HTMLElement>(selector)!;
            scroller.scrollLeft = 100;
            return {
              overflow: scroller.scrollWidth - scroller.clientWidth,
              scrollLeft: scroller.scrollLeft,
              values: Array.from(scroller.querySelectorAll('td')).map((cell) => cell.textContent),
            };
          }),
          values,
        };
      } finally {
        host.remove();
      }
    });
    expect(result.bubbleOverflow).toBeLessThanOrEqual(1);
    for (const table of result.tables) {
      expect(table.overflow).toBeGreaterThan(0);
      expect(table.scrollLeft).toBeGreaterThan(0);
      expect(table.values).toEqual(result.values);
    }
  });

  test('hydrates the icon catalog, contains sanitizer loss, and loads offline math on demand', async ({
    appPage,
  }) => {
    const iconState = await appPage.locator('[data-ui-icon]').evaluateAll((nodes) => ({
      count: nodes.length,
      missing: nodes.filter((node) => !node.querySelector('svg')).length,
      exposed: nodes.filter((node) => node.getAttribute('aria-hidden') !== 'true').length,
    }));
    expect(iconState.count).toBeGreaterThan(30);
    expect(iconState).toMatchObject({ missing: 0, exposed: 0 });

    const fallback = await appPage.evaluate(() => {
      const root = window as any;
      const purifier = root.DOMPurify;
      root.DOMPurify = undefined;
      try {
        const safe = root.sanitizeHtml(
          '<img src=x onerror="window.__sharedPrimitivePwned=1"><script>window.__sharedPrimitivePwned=1</script>',
        );
        const host = document.createElement('div');
        host.innerHTML = safe;
        return {
          safe,
          images: host.querySelectorAll('img').length,
          scripts: host.querySelectorAll('script').length,
          pwned: !!root.__sharedPrimitivePwned,
        };
      } finally {
        root.DOMPurify = purifier;
      }
    });
    expect(fallback.safe).toContain('&lt;img');
    expect(fallback).toMatchObject({ images: 0, scripts: 0, pwned: false });

    const math = await appPage.evaluate(async () => {
      const html = await (window as any).typesetMathHtml('<span>$x+1=2$</span>');
      return {
        rendered: html.includes('mjx-container'),
        runtimes: document.querySelectorAll('script[data-orkas-mathjax="1"]').length,
      };
    });
    expect(math).toEqual({ rendered: true, runtimes: 1 });
  });

  test('rejects an XSS attack matrix after prototype pollution', async ({ appPage }) => {
    const result = await appPage.evaluate(async () => {
      const root = window as any;
      const prototype = Object.prototype as Record<string, unknown>;
      const pollution: Record<string, unknown> = {
        CUSTOM_ELEMENT_HANDLING: {
          tagNameCheck: /.*/,
          attributeNameCheck: /.*/,
          allowCustomizedBuiltInElements: true,
        },
        ALLOWED_TAGS: ['x-unsafe', 'script', 'img', 'svg', 'a', 'button'],
        ALLOWED_ATTR: ['onfocus', 'onerror', 'onload', 'href', 'is'],
        ADD_TAGS: ['x-unsafe', 'script'],
        ADD_ATTR: ['onfocus', 'onerror', 'onload', 'is'],
        FORBID_TAGS: [],
      };
      const previous = new Map(
        Object.keys(pollution).map((key) => [
          key,
          Object.getOwnPropertyDescriptor(prototype, key),
        ]),
      );
      try {
        for (const [key, value] of Object.entries(pollution)) {
          Object.defineProperty(prototype, key, {
            value,
            configurable: true,
            writable: true,
          });
        }
        const safe = [
          '<x-unsafe tabindex="0" onfocus="window.__domPurifyBypass=1">focus me</x-unsafe>',
          '<button is="x-unsafe" tabindex="0" onfocus="window.__domPurifyBypass=2">button</button>',
          '<img src="x-invalid" onerror="window.__domPurifyBypass=3">',
          '<svg onload="window.__domPurifyBypass=4"><script>window.__domPurifyBypass=5</script></svg>',
          '<a href="javascript:window.__domPurifyBypass=6">link</a>',
        ].map((payload) => root.sanitizeHtml(payload));
        const host = document.createElement('div');
        host.innerHTML = safe.join('\n');
        document.body.appendChild(host);
        host.querySelectorAll<HTMLElement>('[tabindex]').forEach((node) => node.focus());
        host.querySelectorAll('img').forEach((node) => node.dispatchEvent(new Event('error')));
        host.querySelectorAll('svg').forEach((node) => node.dispatchEvent(new Event('load')));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const state = {
          safe,
          customElements: host.querySelectorAll('x-unsafe').length,
          scripts: host.querySelectorAll('script').length,
          eventAttributes: host.querySelectorAll('[onfocus], [onerror], [onload]').length,
          dangerousUrls: Array.from(host.querySelectorAll('[href]')).filter((node) => (
            /^\s*javascript:/i.test(node.getAttribute('href') || '')
          )).length,
          executed: !!root.__domPurifyBypass,
        };
        host.remove();
        delete root.__domPurifyBypass;
        return state;
      } finally {
        for (const [key, descriptor] of previous) {
          if (descriptor) Object.defineProperty(prototype, key, descriptor);
          else delete prototype[key];
        }
      }
    });

    expect(result).toMatchObject({
      customElements: 0,
      scripts: 0,
      eventAttributes: 0,
      dangerousUrls: 0,
      executed: false,
    });
    expect(result.safe.join('')).not.toMatch(/onfocus|onerror|onload|javascript:/i);
  });

  test('exposes the shared dropdown state and supports keyboard-only selection', async ({ appPage }) => {
    await appPage.locator('#settings-btn').click();
    await appPage.locator('[data-settings-tab="general"]').click();
    const select = appPage.locator('#settings-language-select');
    const trigger = select.locator('.ai-select-trigger');

    await expect(trigger).toHaveAttribute('role', 'combobox');
    await expect(trigger).toHaveAttribute('aria-label', '语言 / Language');
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');

    const controls = await trigger.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const listbox = appPage.locator(`#${controls}`);
    await expect(listbox).toBeVisible();
    await expect(listbox).toHaveAttribute('role', 'listbox');
    const selected = listbox.locator('[role="option"][aria-selected="true"]');
    await expect(selected).toHaveCount(1);
    const selectedId = await selected.getAttribute('id');

    await trigger.press('ArrowDown');
    let activeId = await trigger.getAttribute('aria-activedescendant');
    if (activeId === selectedId) {
      await trigger.press('ArrowUp');
      activeId = await trigger.getAttribute('aria-activedescendant');
    }
    expect(activeId).toBeTruthy();
    expect(activeId).not.toBe(selectedId);
    const activeValue = await appPage.locator(`#${activeId}`).getAttribute('data-value');
    expect(activeValue).toMatch(/^(en|zh|ja|pt)$/);
    await trigger.press('Enter');

    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(select).toHaveAttribute('data-value', activeValue as string);
    const htmlLang = { en: 'en', zh: 'zh-CN', ja: 'ja', pt: 'pt-BR' }[activeValue as 'en' | 'zh' | 'ja' | 'pt'];
    await expect(appPage.locator('html')).toHaveAttribute('lang', htmlLang);
  });
});
