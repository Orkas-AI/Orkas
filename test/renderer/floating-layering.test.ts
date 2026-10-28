import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readRendererCss() {
  return fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
}

function zIndexForSelector(css: string, selector: string) {
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g);
  const rule = Array.from(rules).find(([, selectors]) =>
    selectors.split(',').some(value => value.trim() === selector),
  );
  const declaration = rule?.[2].match(/(?:^|;)\s*z-index\s*:\s*(-?\d+)\s*(?:!important\s*)?(?:;|$)/i);
  return declaration ? Number(declaration[1]) : null;
}

describe('floating layer ordering', () => {
  it.each([
    ['adjacent rule', '.skill-picker { position: fixed; } .other { z-index: 14000; }', null],
    ['descendant selector', '.parent .skill-picker { z-index: 14000; }', null],
    ['commented declaration', '.skill-picker { /* z-index: 14000; */ position: fixed; }', null],
    ['custom property', '.skill-picker { --z-index: 14000; }', null],
    ['different class', '.skill-picker-other { z-index: 14000; }', null],
    ['missing selector', '.other { z-index: 14000; }', null],
    ['signed value', '.skill-picker { z-index: -1; }', -1],
    ['important declaration', '.skill-picker { z-index : 14000 !important; }', 14000],
    ['shared selector list', '.other, .skill-picker { z-index: 14000; }', 14000],
  ] as const)('reads only the owning declaration: %s', (_label, css, expected) => {
    expect(zIndexForSelector(css, '.skill-picker')).toBe(expected);
  });

  it('keeps body-level pickers above shared dialog overlays', () => {
    const css = readRendererCss();
    const dialogZ = zIndexForSelector(css, '.ui-dialog-overlay');
    expect(dialogZ).not.toBeNull();

    for (const selector of ['.ai-select-popover', '.skill-picker']) {
      const pickerZ = zIndexForSelector(css, selector);
      expect(pickerZ, selector).not.toBeNull();
      expect(pickerZ, selector).toBeGreaterThan(dialogZ as number);
    }
  });


  it('anchors the sidebar settings dot next to the label text', () => {
    const css = readRendererCss();
    const labelDotBlock = css.match(/#settings-btn\.has-dot \.sidebar-footer-label::after\s*\{[\s\S]*?\}/)?.[0] || '';
    expect(labelDotBlock).toContain("content: ''");
    expect(css).toContain('--attention-dot-size: 4px');
    expect(labelDotBlock).toContain('width: var(--attention-dot-size)');
    expect(labelDotBlock).toContain('height: var(--attention-dot-size)');
    expect(labelDotBlock).toContain('margin-left: 6px');
    expect(css).toContain('.has-dot:not(.sidebar-footer-btn)::after');
    expect(css).not.toMatch(/(^|[,\n]\s*)\.has-dot::after\s*\{/);
    expect(css).not.toMatch(/(^|[,\n]\s*)\.has-dot\.is-(red|orange)::after\b/);
  });

  it('keeps primary disabled buttons visually disabled', () => {
    const css = readRendererCss();
    const primaryBlock = css.match(/\.btn-primary:disabled\s*\{[\s\S]*?\}/)?.[0] || '';

    expect(primaryBlock).toContain('opacity: 0.6');
    expect(primaryBlock).toContain('cursor: not-allowed');
  });
});
