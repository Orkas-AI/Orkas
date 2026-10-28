import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

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
  it('keeps the open-source sidebar footer focused on local Settings', () => {
    const html = read('src/renderer/index.html');
    const sidebarFooter = html.slice(
      html.indexOf('<div class="sidebar-footer-actions">'),
      html.indexOf('<div class="sidebar-resize-handle"'),
    );
    expect(sidebarFooter).toContain('id="settings-btn"');
    expect(sidebarFooter).not.toContain('new-chat-external-agent-btn');
    expect(sidebarFooter).not.toContain('class="sb-connect"');
    expect(sidebarFooter).not.toContain('sidebar-invite-btn');
    expect(sidebarFooter.match(/<button\b/g)).toHaveLength(1);
  });

  it('exposes localized voice input through the public ticket API', () => {
    const html = read('src/renderer/index.html');
    const button = /<button\b[^>]*id="new-chat-mic-btn"[^>]*>[\s\S]*?<\/button>/.exec(html)?.[0];
    expect(button).toBeTruthy();
    expect(button).toContain('type="button"');
    expect(button).toContain('data-i18n-title="chat.mic_title"');
    expect(button).toContain('data-ui-icon="mic"');
    expect(html.match(/id="new-chat-mic-btn"/g)).toHaveLength(1);
    expect(html).toContain('<script src="./modules/voice-input.js"></script>');
    const preload = read('src/main/preload.js');
    expect(preload).toContain("createSession: () => invoke('voiceInput.createSession')");
    expect(preload).toContain("ensureMicrophoneAccess: () => invoke('voiceInput.ensureMicrophoneAccess')");
  });

  it('hides the microphone when the public ticket capability is unavailable', () => {
    const button = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
    const context: any = { window: { orkas: {} }, document: { addEventListener() {} } };
    vm.createContext(context);
    vm.runInContext(read('src/renderer/modules/voice-input.js'), context);
    context.window.VoiceInput.attach(button, { value: 'Keep this draft' });
    expect(button.style.display).toBe('none');
  });

  it('keeps external CLI onboarding on the AI Team header only', () => {
    const html = read('src/renderer/index.html');
    const state = read('src/renderer/modules/state.js');
    const agents = read('src/renderer/modules/agents.js');
    const handler = state.slice(
      state.indexOf("document.getElementById('agents-connect-cli-btn')"),
      state.indexOf("document.getElementById('agents-back-btn')"),
    );
    expect(html).not.toContain('id="new-chat-external-agent-btn"');
    expect(html).toContain('id="agents-connect-cli-btn"');
    expect(state).not.toContain("document.getElementById('new-chat-external-agent-btn')");
    expect(handler).toContain("initialTab: 'external'");
    expect(handler).toContain('externalOnly: true');
    expect(handler).toContain("entryPoint: 'agents_connect_cli_button'");
    expect(agents).toContain('if (tabBar) tabBar.hidden = externalOnly;');
    expect(agents).toContain('closeAgentModal({ restoreFocus: true });');
  });

  it('uses the synced homepage shortcut set and order', () => {
    const html = read('src/renderer/index.html');
    const renderer = read('src/renderer/modules/conversation.js');
    const clientConfig = read('src/main/features/client_config.ts');
    const expected = [
      'data',
      'ecommerce',
      'ppt',
      'office',
      'image',
      'video',
      'ui_design',
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
    expect(css).not.toContain('.sb-connect');
    expect(css).not.toContain('.sidebar-external-agent-btn');
    expect(css).not.toContain('.new-chat-external-agent-btn');
    expect(css).toMatch(/\.sidebar-footer-actions\s*{[\s\S]*?flex-direction:\s*column;[\s\S]*?align-items:\s*stretch;/);
    expect(css).toMatch(/\.new-chat-input-area \.chat-rich-editor\s*{[\s\S]*?min-height:\s*80px;[\s\S]*?font-size:\s*16px;/);
    expect(css).toMatch(/\.new-chat-input-area \.chat-input-rich-wrap textarea\.chat-rich-source\s*{[\s\S]*?position:\s*absolute;[\s\S]*?width:\s*1px;[\s\S]*?opacity:\s*0;[\s\S]*?pointer-events:\s*none;/);
    expect(css).toMatch(/\.chat-rich-editor\s*{[\s\S]*?outline:\s*none;/);
    expect(css).toMatch(/\.chat-rich-editor:empty::before\s*{[\s\S]*?content:\s*attr\(data-placeholder\);/);
  });
});

describe('home locale changes', () => {
  it('repaints the public greeting/cards and keeps the replacement card clickable', async () => {
    const ts = await import('typescript');
    const source = read('src/renderer/modules/conversation.js');
    const ast = ts.createSourceFile('conversation.js', source, ts.ScriptTarget.Latest, true);
    const names = new Set(['_quickStartText', '_renderEmptyStateHeading', '_renderQuickStartScenarios', '_bindEmptyStateScenarioButtons']);
    const publicFunctions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name?.text || '')).map(node => node.getText(ast));
    const localeListeners = ast.statements.filter(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
      && node.expression.expression.getText(ast) === 'window.addEventListener'
      && node.expression.arguments[0]?.getText(ast) === "'i18n-change'"
      && node.expression.arguments[1]?.getText(ast).includes('_renderQuickStartScenarios(')).map(node => node.getText(ast));
    const windowEvents = new EventTarget();
    let lang = 'en';
    let card: (EventTarget & { dataset: Record<string, string> }) | null = null;
    let markup = '';
    const greeting = { textContent: '' };
    const grid = {
      get innerHTML() { return markup; },
      set innerHTML(value: string) {
        markup = value;
        card = Object.assign(new EventTarget(), { dataset: { scenario: 'task' } });
      },
    };
    const row = { querySelectorAll: () => card ? [card] : [] };
    const applied: unknown[][] = [];
    const context: any = {
      window: windowEvents,
      document: { getElementById: (id: string) => ({ 'new-chat-greeting': greeting, 'new-chat-scenario-grid': grid, 'new-chat-scenarios': row }[id]) },
      _emptyStateAccountName: '', _quickStartItems: [{ id: 'task' }],
      _SCENARIO_CONFIGS: { task: { labelKey: 'label', taskKey: 'task', deliverableKey: 'deliver', group: 'work' } },
      escapeHtml: (value: string) => value,
      _uiIconHtml: () => '',
      t: (key: string, vars?: { name?: string }) => `${lang}:${key}${vars?.name ? ':' + vars.name : ''}`,
      _applyQuickStartScenario: (...args: unknown[]) => applied.push(args),
    };
    vm.createContext(context);
    vm.runInContext([...publicFunctions, ...localeListeners].join('\n'), context);
    context._renderEmptyStateHeading();
    context._renderQuickStartScenarios();
    context._bindEmptyStateScenarioButtons(row);
    expect(greeting.textContent).toBe('en:new_chat.title:en:common.user_fallback');
    expect(markup).toContain('en:task');
    card!.dispatchEvent(new Event('click'));
    expect(applied).toEqual([['task', 1, { surface: 'home_grid' }]]);
    const originalCard = card;
    lang = 'zh';
    windowEvents.dispatchEvent(new Event('i18n-change'));
    expect(greeting.textContent).toBe('zh:new_chat.title:zh:common.user_fallback');
    expect(markup).toContain('zh:task');
    expect(markup).not.toContain('en:task');
    expect(card).not.toBe(originalCard);
    card!.dispatchEvent(new Event('click'));
    expect(applied).toEqual([['task', 1, { surface: 'home_grid' }], ['task', 1, { surface: 'home_grid' }]]);
  });
});
