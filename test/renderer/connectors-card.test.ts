import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('connectors card surface', () => {
  it('keeps the synced card grid sizing and compact menu styling', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/\.connectors-grid\s*{[\s\S]*?--connector-card-min:\s*280px;[\s\S]*?grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(min\(100%,\s*max\(var\(--connector-card-min\),\s*calc\(\(100% - \(3 \* var\(--connector-grid-gap\)\)\) \/ 4\)\)\),\s*1fr\)\);/);
    expect(css).toMatch(/\.connector-card\s*{[\s\S]*?padding:\s*14px 16px;/);
    expect(css).toMatch(/\.connector-card-menu-btn\s*{[\s\S]*?width:\s*22px;[\s\S]*?height:\s*22px;[\s\S]*?visibility:\s*hidden;/);
    expect(css).toContain('.connector-card:hover .connector-card-menu-btn');
    expect(css).toMatch(/\.connector-card-foot\s*{[\s\S]*?gap:\s*8px;[\s\S]*?min-width:\s*0;/);
    expect(css).toMatch(/\.connector-card-foot \.btn\s*{[\s\S]*?flex:\s*0 0 auto;/);
  });

  it('renders connected cards with Use and keeps enable/disable in the card menu', () => {
    const js = read('src/renderer/modules/connectors.js');

    expect(js).toContain('data-act="use-connector"');
    expect(js).toContain('connector-card-use');
    expect(js).toContain("setChatConnector('new-chat'");
    expect(js).toContain('data-act="toggle-enabled"');
    expect(js).toContain('_clearConnectorCardMenuState');
    expect(js).not.toContain('authorize-sheets');
    expect(js).not.toContain('connectors.google_sheets_authorize_files');
  });

  it('continues filtering PC credit-gated connector UI', () => {
    const js = read('src/renderer/modules/connectors.js');
    const css = read('src/renderer/style.css');
    const locales = ['en', 'zh', 'ja', 'pt'].map((lang) => read(`src/renderer/locales/${lang}.json`)).join('\n');
    const meteringKey = ['usage', '_metering'].join('');
    const pricingKey = ['credits', '_milli_per_call'].join('');
    const copyKey = ['connectors.badge.', 'credits', '_required'].join('');

    expect(js).not.toContain(meteringKey);
    expect(js).not.toContain(pricingKey);
    expect(js).not.toContain('_connectorCreditBadge');
    expect(css).not.toContain('connector-card-credit-badge');
    expect(locales).not.toContain(copyKey);
  });
});
