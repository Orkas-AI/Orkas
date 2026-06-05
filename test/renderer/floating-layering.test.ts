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
});
