import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '../..');

function read(rel: string) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function quickStartOrder(source: string, declaration: string) {
  const block = source.match(new RegExp(`const ${declaration}[^=]*= \\[([\\s\\S]*?)\\n\\];`));
  expect(block?.[1]).toBeTruthy();
  return [...block![1].matchAll(/\{\s*id:\s*'([^']+)'/g)].map((match) => match[1]);
}

describe('new chat home surface', () => {
  it('keeps the external agent entry while filtering voice input', () => {
    const html = read('src/renderer/index.html');

    expect(html).toContain('id="new-chat-external-agent-btn"');
    expect(html).toContain('data-i18n="new_chat.external_agent_entry"');
    expect(html).not.toContain('id="new-chat-mic-btn"');
    expect(html).not.toContain('data-ui-icon="mic"');
  });

  it('opens the homepage external-agent flow in place and restores composer focus on cancel', () => {
    const state = read('src/renderer/modules/state.js');
    const agents = read('src/renderer/modules/agents.js');
    const handler = state.slice(
      state.indexOf("document.getElementById('new-chat-external-agent-btn')"),
      state.indexOf("document.getElementById('create-agent-btn')"),
    );

    expect(handler).toContain("initialTab: 'external'");
    expect(handler).toContain('externalOnly: true');
    expect(handler).toContain("returnFocusId: 'new-chat-input'");
    expect(handler).not.toContain("setView('agents'");
    expect(agents).toContain('if (tabBar) tabBar.hidden = externalOnly;');
    expect(agents).toContain('closeAgentModal({ restoreFocus: true });');
  });

  it('uses the synced homepage shortcut set and order', () => {
    const html = read('src/renderer/index.html');
    const renderer = read('src/renderer/modules/conversation.js');
    const clientConfig = read('src/main/features/client_config.ts');
    const expected = [
      'data',
      'video',
      'image',
      'ui_design',
      'office',
      'creation',
      'rnd',
      'seo_geo',
    ];

    expect(html).toContain('class="new-chat-scenarios quick-panel" id="new-chat-scenarios"');
    expect(html).toContain('class="quick-grid" id="new-chat-scenario-grid"');
    expect(html).not.toContain('data-scenario=');
    expect(quickStartOrder(renderer, '_DEFAULT_QUICK_START_ITEMS')).toEqual(expected);
    expect(quickStartOrder(clientConfig, 'DEFAULT_QUICK_START_CONFIG')).toEqual(expected);
  });

  it('exposes Library-aware picker copy and accessible skill chip removal', () => {
    const html = read('src/renderer/index.html');

    expect(html).toContain('placeholder="Type @ to choose agents, skills, connectors, Library files."');
    expect(html).toContain('data-i18n-title="chat.recipient_picker_title_with_library"');
    expect(html).toContain('data-i18n-aria-label="chat.chip_remove_title"');
    expect(html).toContain('data-ui-icon="x"');
  });

  it('keeps the home layout constraints aligned with the synced PC surface', () => {
    const css = read('src/renderer/style.css');

    expect(css).toMatch(/#panel-new-chat\s*{[\s\S]*?position:\s*relative;/);
    expect(css).toContain('.new-chat-center > .oss-entry');
    expect(css).toContain('.new-chat-external-agent-btn');
    expect(css).toMatch(/\.new-chat-input-area \.chat-rich-editor\s*{[\s\S]*?min-height:\s*80px;[\s\S]*?font-size:\s*16px;/);
    expect(css).toMatch(/\.new-chat-input-area \.chat-input-rich-wrap textarea\.chat-rich-source\s*{[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*1px;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/);
    expect(css).toMatch(/\.chat-rich-editor\s*{[\s\S]*?outline:\s*none;/);
    expect(css).toMatch(/\.chat-rich-editor:empty::before\s*{[\s\S]*?content:\s*attr\(data-placeholder\);/);
  });
});
