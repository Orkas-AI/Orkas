import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

function readRendererCss() {
  return fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
}

function zIndexForSelector(css: string, selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{[\\s\\S]*?z-index:\\s*(\\d+)`));
  return match ? Number(match[1]) : null;
}

describe('floating layer ordering', () => {
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

  it('keeps a data-attribute fallback for the sidebar settings status badge', () => {
    const css = readRendererCss();
    const badgeBlock = css.match(/\.sidebar-settings-alerts\s*\{[\s\S]*?\}/)?.[0] || '';
    const buttonBlock = css.match(/#settings-btn\s*\{[\s\S]*?\}/)?.[0] || '';
    const alertButtonBlock = css.match(/#settings-btn\.has-sidebar-alert\s*\{[\s\S]*?\}/)?.[0] || '';
    const buttonBadgeBlock = css.match(/#settings-btn::after\s*\{[\s\S]*?\}/)?.[0] || '';
    expect(buttonBlock).toContain('padding-right: 8px');
    expect(alertButtonBlock).toContain('padding-right: 104px');
    expect(buttonBadgeBlock).toContain('content: attr(data-sidebar-status)');
    expect(buttonBadgeBlock).toContain('right: 8px');
    expect(buttonBadgeBlock).toContain('min-width: 56px');
    expect(badgeBlock).toContain('clip-path');
    expect(badgeBlock).toContain('width: 1px');
    expect(badgeBlock).toContain('height: 1px');
    const syncingBadgeBlock = css.match(/#settings-btn\.is-syncing::after\s*\{[\s\S]*?\}/)?.[0] || '';
    expect(syncingBadgeBlock).toContain('background: var(--primary-soft)');
    expect(syncingBadgeBlock).toContain('color: var(--primary-text)');
  });

  it('anchors the sidebar settings dot next to the label text', () => {
    const css = readRendererCss();
    const buttonBadgeBlock = css.match(/#settings-btn::after\s*\{[\s\S]*?\}/)?.[0] || '';
    const labelDotBlock = css.match(/#settings-btn\.has-dot \.sidebar-footer-label::after\s*\{[\s\S]*?\}/)?.[0] || '';
    expect(buttonBadgeBlock).toContain('content: attr(data-sidebar-status)');
    expect(labelDotBlock).toContain("content: ''");
    expect(labelDotBlock).toContain('width: 6px');
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
