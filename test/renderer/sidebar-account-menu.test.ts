import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('open-source sidebar settings boundary', () => {
  it('uses a direct local Settings entry and ships no account-menu runtime', () => {
    const rendererRoot = resolve(__dirname, '../../src/renderer');
    const html = readFileSync(resolve(rendererRoot, 'index.html'), 'utf8');

    expect(existsSync(resolve(rendererRoot, 'modules/sidebar_account.js'))).toBe(false);
    expect(html).toContain('id="settings-btn"');
    expect(html).not.toContain(['sidebar', 'account', 'popover'].join('-'));
    expect(html).not.toContain('data-sidebar-account-action');
    expect(html).not.toContain(['settings', 'feedback', 'open'].join('-'));
  });
});
