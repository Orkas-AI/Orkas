import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { onlyCssDeclarations } from './helpers/css-oracle';

// Scenario: the composer's recipient picker lists agents that already exist.
// Connecting Claude Code / Codex was reachable only from the AI Team page, so
// someone who opened the picker looking for a coding agent and found none had
// nowhere to go. The entry now sits under the roster -- pinned, so a scroll or
// a search that matches nothing cannot take it away -- and hands off to the
// same external-CLI dialog instead of selecting anything.

const agentsSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/agents.js'),
  'utf8',
);
const htmlSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/index.html'),
  'utf8',
);
const styleSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/style.css'),
  'utf8',
);

function extractFunction(name: string): string {
  const start = agentsSource.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = agentsSource.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < agentsSource.length; i += 1) {
    if (agentsSource[i] === '{') depth += 1;
    else if (agentsSource[i] === '}') {
      depth -= 1;
      if (depth === 0) return agentsSource.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

/** Runs the real module against a picker whose only interesting parts are the
 *  anchor it was opened from and the footer we toggle. */
function chromeHarness(anchorId: string) {
  const footer: any = { hidden: true };
  const search: any = { placeholder: '' };
  const picker: any = {
    dataset: { anchorId },
    style: { display: 'flex' },
    querySelectorAll: () => [] as any[],
    querySelector: () => null,
  };
  const elements: Record<string, any> = {
    'agent-picker': picker,
    'agent-picker-cli-footer': footer,
    'agent-picker-search': search,
  };
  const context: any = {
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    document: {
      getElementById: (id: string) => elements[id] || null,
      createElement: () => ({ style: {}, dataset: {}, classList: { add() {} } }),
    },
    t: (key: string) => key,
    escapeHtml: (s: string) => s,
    setTimeout: (fn: Function) => fn(),
    addEventListener() {},
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(agentsSource, context);
  const show = (tab: string) => {
    vm.runInContext(`_agentPickerTab = ${JSON.stringify(tab)}; _updateAgentPickerChrome();`, context);
    return footer.hidden === false;
  };
  return { context, footer, show };
}

describe('agent picker › coding-CLI entry visibility', () => {
  it.each(['chat-recipient-chip', 'new-chat-recipient-chip', 'project-chat-recipient-chip'])(
    'offers the entry on the Agents tab of %s',
    (anchor) => {
      expect(chromeHarness(anchor).show('agents')).toBe(true);
    },
  );

  it.each(['skills', 'connectors', 'library'])('leaves the %s tab alone', (tab) => {
    // The entry connects an agent; on a tab that lists skills, connectors or
    // Library files it would be answering a question nobody asked.
    expect(chromeHarness('chat-recipient-chip').show(tab)).toBe(false);
  });

  it('returns after a detour through another tab', () => {
    const picker = chromeHarness('chat-recipient-chip');
    expect(picker.show('agents')).toBe(true);
    expect(picker.show('connectors')).toBe(false);
    expect(picker.show('agents')).toBe(true);
  });

  it('stays out of the automation dialog picker', () => {
    // The automation dialog is a `.ui-dialog-overlay` (z-index 13000) and
    // `openAgentModal` opens a plain `.modal-overlay` (z-index 100): the create
    // dialog would open behind the task the user is still filling in.
    expect(chromeHarness('auto-recipient-chip').show('agents')).toBe(false);
  });
});

describe('agent picker › coding-CLI entry hand-off', () => {
  function clickHarness() {
    const cliEntry: any = { dataset: {}, handlers: {} as Record<string, Function>,
      addEventListener(type: string, fn: Function) { this.handlers[type] = fn; } };
    const picker: any = { dataset: { anchorId: 'chat-recipient-chip' } };
    const elements: Record<string, any> = {
      'agent-picker-connect-cli': cliEntry,
      'agent-picker': picker,
    };
    const context: any = {
      currentView: 'conversation',
      _RECIPIENT_ANCHOR_PAIRS: [],
      _closeAgentPicker: vi.fn(),
      _renderAgentPickerList() {},
      _moveAgentPickerTab() {},
      _moveAgentPickerActive() {},
      _consumeAtKeyChar() { return null; },
      _focusInput() {},
      bindRecipientAnchor() {},
      openAgentModal: vi.fn(),
      document: {
        getElementById: (id: string) => elements[id] || null,
        querySelectorAll: () => [] as any[],
        addEventListener() {},
      },
      addEventListener() {},
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(extractFunction('_agentsTrackClick'), context);
    vm.runInContext(extractFunction('bindAgentPickers'), context);
    vm.runInContext('bindAgentPickers();', context);
    return { context, cliEntry };
  }

  it('closes the picker and opens the external-only dialog for the same anchor', () => {
    const { context, cliEntry } = clickHarness();
    cliEntry.handlers.click({ stopPropagation() {} });

    expect(context._closeAgentPicker).toHaveBeenCalledOnce();
    expect(context.openAgentModal).toHaveBeenCalledExactlyOnceWith({
      initialTab: 'external',
      // `externalOnly` is the difference between the dedicated connect-an-agent
      // page and the create dialog parked on its second tab: it drops the tab
      // bar, so this entry lands on the page every other CLI entry opens.
      externalOnly: true,
      entryPoint: 'agent_picker_connect_cli',
      sourceView: 'conversation',
      // Cancelling the dialog puts focus back on the chip the picker hung off.
      returnFocusId: 'chat-recipient-chip',
    });
  });

  it('binds once even though the composers re-run the binder', () => {
    // `bindAgentPickers` runs again whenever a composer remounts. A second
    // listener on the same button would double-count every open.
    const { context, cliEntry } = clickHarness();
    vm.runInContext('bindAgentPickers();', context);
    cliEntry.handlers.click({ stopPropagation() {} });

    expect(context.openAgentModal).toHaveBeenCalledOnce();
  });
});

describe('agent picker › coding-CLI entry markup and style', () => {
  it('pins the entry below the roster inside the picker', () => {
    const picker = htmlSource.slice(
      htmlSource.indexOf('<div class="skill-picker" id="agent-picker"'),
      htmlSource.indexOf('<div class="agent-row-menu"'),
    );
    expect(picker).toContain('id="agent-picker-cli-footer"');
    // After the list, so the scrolling rows never carry it off screen.
    expect(picker.indexOf('id="agent-picker-cli-footer"'))
      .toBeGreaterThan(picker.indexOf('id="agent-picker-list"'));
    // Hidden until the chrome pass decides this picker should offer it.
    expect(picker).toMatch(/id="agent-picker-cli-footer"[^>]*\shidden/);
    // Both lines are translated: the action, and the CLIs it stands for.
    expect(picker).toContain('data-i18n="agents.connect_cli_btn"');
    expect(picker).toContain('data-i18n="agents.connect_cli_sub"');
  });

  it('puts the chevron on the trailing edge', () => {
    // `hydrateUiIcons` wraps every icon in a span of its own, so this class
    // lands on the inner <svg>, where an auto margin has no free space to
    // absorb and the arrow just trails the text. The copy column has to claim
    // the room instead.
    expect(onlyCssDeclarations(styleSource, '.skill-picker-cli-copy').flex).toBe('1');
    expect(onlyCssDeclarations(styleSource, '.skill-picker-cli-arrow')['margin-left'])
      .toBeUndefined();
  });

  it('keeps the entry visible when the box is capped', () => {
    const footer = onlyCssDeclarations(styleSource, '.skill-picker-footer');
    // The list is the scroll container, so it is the part that gives up space.
    expect(footer['flex-shrink']).toBe('0');
    // Nothing here sets `display`, which is what lets the `hidden` attribute
    // do the hiding; a `display` declaration would silently pin it open.
    expect(footer.display).toBeUndefined();
  });
});
