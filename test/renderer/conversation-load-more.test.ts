import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('conversation load-more control', () => {
  it('uses quantity-free copy in every supported locale', () => {
    const expected = {
      zh: '加载更多',
      en: 'Load more',
      ja: 'さらに読み込む',
      pt: 'Carregar mais',
    };

    for (const [locale, label] of Object.entries(expected)) {
      const messages = JSON.parse(read(`src/renderer/locales/${locale}.json`));
      expect(messages['sidebar.load_more_conversations']).toBe(label);
    }
  });

  it('provides responsive, focus, disabled, and loading styles', () => {
    const styles = read('src/renderer/style.css');

    expect(styles).toMatch(/\.conversation-list-load-more\s*\{[\s\S]*?width:\s*calc\(100% - 16px\)/);
    expect(styles).toMatch(/\.conversation-list-load-more\s*\{[\s\S]*?border:\s*0;/);
    expect(styles).toContain('.conversation-list-load-more:focus-visible');
    expect(styles).toContain('.conversation-list-load-more:disabled');
    expect(styles).toContain('.conversation-list-load-more[aria-busy="true"]::before');
    expect(styles).toMatch(/\.project-conv-list > \.conversation-list-load-more\s*\{[\s\S]*?margin-bottom:\s*0;/);
    expect(styles).toMatch(/\.project-conv-list:has\(> \.conversation-list-load-more\) \+ \.project-row\s*\{[\s\S]*?margin-top:\s*0;/);
  });

  it('exposes pending requests to assistive technology in every list context', () => {
    for (const source of [
      'src/renderer/modules/conversation.js',
      'src/renderer/modules/project-detail.js',
      'src/renderer/modules/projects.js',
      'src/renderer/modules/auto.js',
    ]) {
      expect(read(source)).toContain("setAttribute('aria-busy', 'true')");
      expect(read(source)).toContain("removeAttribute('aria-busy')");
    }
  });

  it('uses one pagination control instead of collapsible time buckets', () => {
    const conversation = read('src/renderer/modules/conversation.js');
    const styles = read('src/renderer/style.css');

    expect(conversation).not.toContain('data-conv-bucket-toggle');
    expect(conversation).not.toContain('data-conv-bucket-more');
    expect(conversation).toContain('data-unprojected-conv-more');
    expect(conversation).not.toContain('_conversationExpandedBuckets');
    expect(styles).not.toContain('.conv-list-section-header.is-collapsible');
    expect(styles).not.toContain('.conv-list-section-count');
  });
});
