import { composerAccessorSource } from './composer-test-source';
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

class FakeElement {
  value = '';
  textContent = '';
  className = '';
  focused = false;
  hidden = false;
  disabled = false;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  removedClasses: string[] = [];
  classList = {
    add() {},
    remove: (name: string) => { this.removedClasses.push(name); },
    contains() { return false; },
  };
  contains(_target?: unknown) { return false; }
  focus() { this.focused = true; }
  addEventListener() {}
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

function loadAgentRenderer() {
  const elements = new Map<string, FakeElement>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id)!;
  };
  let now = 100;
  const context: any = {
    console,
    clearTimeout,
    setTimeout: (fn: () => void) => { fn(); return 1; },
    performance: { now: () => { now += 25; return now; } },
    createLogger: () => ({ warn() {}, error() {}, info() {} }),
    document: {
      getElementById: (id: string) => element(id),
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      createElement: () => new FakeElement(),
      body: { appendChild() {} },
    },
    window: {
        addEventListener() {},
      innerWidth: 1024,
      innerHeight: 768,
      orkas: { invoke: async () => ({ ok: true }) },
    },
    t: (key: string, vars?: Record<string, string>) => {
      if (key === 'chat.recipient_commander') return 'Commander';
      if (key === 'agents.seed_workflow_model') return `${vars?.name || ''}:${vars?.description || ''}`;
      return key;
    },
    getLang: () => 'en',
    normalizeDisplayText: (value: unknown) => String(value || '').trim(),
    normalizeCatalogSource: (source: string) => source || '',
    isMarketplaceCatalogSource: (source: string) => source === 'marketplace',
    escapeHtml: (value: unknown) => String(value || ''),
    pickDesc: () => '',
    pickLocalizedField: (item: any, field: string) => item?.[field] || '',
    renderAvatarHtml: () => '',
    isDevMode: () => false,
    _toggleComposerRecipient: vi.fn(),
    uiAlert: async () => {},
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(composerAccessorSource, context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/agents.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'agents.js' });
  return { context, element };
}


function clickCancel(context: any) {
  const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
  const modal = html.slice(html.indexOf('id="agent-modal"'), html.indexOf('<!-- Create/Edit Skill Modal -->'));
  const handler = modal.match(/<button\b[^>]*onclick="([^"]+)"[^>]*data-i18n="common.cancel"/)?.[1];
  expect(handler).toBeTruthy();
  vm.runInContext(handler!, context);
}

describe('public agent creation and resource workflows', () => {
  it('closes the default create modal and restores the originating composer on Cancel', () => {
    const { context, element } = loadAgentRenderer();
    context.openAgentModal({ returnFocusId: 'new-chat-input' });
    clickCancel(context);
    expect(element('agent-modal').removedClasses).toContain('open');
    expect(element('new-chat-input').focused).toBe(true);
  });

  it('wires the shared modal Cancel button through the tab-aware handler', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    const modal = html.slice(
      html.indexOf('id="agent-modal"'),
      html.indexOf('<!-- Create/Edit Skill Modal -->'),
    );

    expect(modal).toContain('onclick="cancelAgentModal()"');
    expect(modal).not.toContain('onclick="closeAgentModal()"');
  });

  it('restores focus to the new-chat composer when its external-agent modal is cancelled', () => {
    const { context, element } = loadAgentRenderer();
    context.document.querySelector = (selector: string) => (
      selector === '#agent-modal-tabs .is-active'
        ? { dataset: { agentTab: 'external' } }
        : null
    );

    context.openAgentModal({
      initialTab: 'external',
      externalOnly: true,
      returnFocusId: 'new-chat-input',
    });
    clickCancel(context);

    expect(element('agent-modal').removedClasses).toContain('open');
    expect(element('agent-modal-tabs').hidden).toBe(true);
    expect(element('new-chat-input').focused).toBe(true);
  });

  it('restores the create and external tabs for the regular Agents-page flow', () => {
    const { context, element } = loadAgentRenderer();
    const styles = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');

    context.openAgentModal({ initialTab: 'external', externalOnly: true });
    expect(element('agent-modal-tabs').hidden).toBe(true);
    expect(styles).toContain('.skill-modal-tabs[hidden] {\n  display: none !important;\n}');
    // Binding an existing CLI is not authoring a new agent, and the title has
    // to follow the entry — including across a later language change, which
    // re-reads the key, not the rendered string.
    expect(element('agent-modal-title').dataset.i18n).toBe('agent_modal.title_connect');
    expect(element('agent-modal-title').textContent).toBe('agent_modal.title_connect');

    context.openAgentModal();
    expect(element('agent-modal-tabs').hidden).toBe(false);
    expect(element('agent-modal-title').dataset.i18n).toBe('agent_modal.title');
  });

  it('disables save only when the External flow has no available CLI', () => {
    const { context, element } = loadAgentRenderer();

    context.openAgentModal({ initialTab: 'external' });
    expect(element('agent-save-btn').disabled).toBe(true);

    context.setExternalAgentCreateAvailability(true);
    expect(element('agent-save-btn').disabled).toBe(false);

    context.setExternalAgentCreateAvailability(false);
    expect(element('agent-save-btn').disabled).toBe(true);

    context._switchAgentTab('create');
    expect(element('agent-save-btn').disabled).toBe(false);
  });

  it('does not let deferred modal focus steal input from the summary field', () => {
    const { context, element } = loadAgentRenderer();
    const timers: Array<() => void> = [];
    context.setTimeout = (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    };
    const modal = element('agent-modal');
    const summary = element('agent-desc-input');
    modal.contains = (target: unknown) => target === summary;

    context.openAgentModal();
    context.document.activeElement = summary;
    timers.forEach((fn) => fn());

    expect(timers).toHaveLength(1);
    expect(element('agent-name-input').focused).toBe(false);
  });

  it('keeps a successful Agent toggle authoritative when list refresh fails', async () => {
    const { context } = loadAgentRenderer();
    context.window.orkas.invoke = async () => ({ ok: true });
    vm.runInContext(`
      _agentsCache = [];
      _selectedAgent = null;
      loadAgents = async () => { throw new Error('refresh failed'); };
    `, context);

    await expect(context._flipAgentEnabled('agent-one', false)).resolves.toBe(true);

  });

  it('keeps a successful Agent delete authoritative when refresh fails', async () => {
    const { context } = loadAgentRenderer();
    context.uiConfirm = async () => true;
    const request = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    context.apiFetch = request;
    vm.runInContext(`
      _selectedAgent = { id: 'agent-one', name: 'Private Agent', source: 'custom' };
      loadAgents = async () => { throw new Error('refresh failed'); };
      loadConversations = async () => {};
    `, context);

    await context.deleteSelectedAgent();
    expect(request).toHaveBeenCalledExactlyOnceWith('/api/agents/agent-one', { method: 'DELETE' });
    expect(vm.runInContext('_selectedAgent', context)).toBeNull();

  });

  it('blocks external-agent creation when the selected CLI has a compatibility warning', async () => {
    const { context, element } = loadAgentRenderer();
    element('agent-ext-name-input').value = 'Codex';
    element('agent-ext-desc-input').value = 'Runs local coding tasks';
    context.getExternalCliValue = () => 'codex';
    context.getExternalCliSelectionWarning = () => 'Version 0.139.0 is too old. Update the CLI.';
    let createRequests = 0;
    context.apiFetch = async () => {
      createRequests += 1;
      return { json: async () => ({ ok: true }) };
    };

    await context._saveExternalAgent({ msgEl: element('agent-form-msg') });

    expect(element('agent-form-msg').textContent).toBe(
      'Version 0.139.0 is too old. Update the CLI.',
    );
    expect(element('agent-form-msg').className).toBe('form-msg err');
    expect(createRequests).toBe(0);
  });

  it.each([
    {
      reason: 'no_cli',
      cli: null,
      name: '',
      desc: '',
      errorCode: 'no_cli',
    },
    {
      reason: 'no_name',
      cli: 'codex',
      name: '',
      desc: 'Runs local coding tasks',
      errorCode: 'no_name',
    },
    {
      reason: 'invalid name',
      cli: 'codex',
      name: 'Claude.Code',
      desc: 'Runs local coding tasks',
      errorCode: 'name_invalid',
    },
    {
      reason: 'reserved name',
      cli: 'codex',
      name: 'Commander',
      desc: 'Runs local coding tasks',
      errorCode: 'name_reserved',
    },
    {
      reason: 'no description',
      cli: 'codex',
      name: 'Codex',
      desc: '',
      errorCode: 'no_desc',
    },
  ])('rejects invalid external creation without a write: $reason', async ({ cli, name, desc, errorCode }) => {
    const { context, element } = loadAgentRenderer();
    element('agent-ext-name-input').value = name;
    element('agent-ext-desc-input').value = desc;
    context.getExternalCliValue = () => cli;
    context.getExternalCliSelectionWarning = () => '';

    const write = vi.fn();
    context.apiFetch = write;
    await context._saveExternalAgent({ msgEl: element('agent-form-msg') });

    expect(write).not.toHaveBeenCalled();
    expect(element('agent-form-msg').className).toBe('form-msg err');
    expect(element('agent-form-msg').textContent).toBe(({ no_cli: 'agents.ext_cli_needed', no_name: 'agents.input_name_needed', name_invalid: 'agents.name_invalid', name_reserved: 'agents.name_reserved', no_desc: 'agents.input_desc_needed' } as Record<string, string>)[errorCode]);
  });

  it('removes whitespace from an external-agent name before saving', async () => {
    const { context, element } = loadAgentRenderer();
    const requests: any[] = [];
    element('agent-ext-name-input').value = 'Claude Code';
    element('agent-ext-desc-input').value = 'Runs local coding tasks';
    context.getExternalCliValue = () => 'codex';
    context.getExternalCliSelectionWarning = () => '';
    context.apiFetch = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return {
        json: async () => ({
          ok: true,
          agent: { agent_id: 'agent-created', name: body.name },
        }),
      };
    };
    context.closeAgentModal = () => {};
    context.setView = () => {};
    context.loadAgents = async () => {};
    context._showAgentsDetailView = async () => {};

    await context._saveExternalAgent({ msgEl: element('agent-form-msg') });

    expect(element('agent-ext-name-input').value).toBe('ClaudeCode');
    expect(requests[0].name).toBe('ClaudeCode');
  });

  it.each(['claude', 'codex', 'openclaw', 'opencode', 'hermes'].flatMap(cli => (
    ['en', 'zh', 'ja', 'pt'].map(lang => ({ cli, lang }))
  )))('fills and saves the real $cli default in a $lang UI after an empty description', async ({ cli, lang }) => {
    const { context, element } = loadAgentRenderer();
    for (const module of ['utils.js', 'local-agents.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', module), 'utf8'), context);
    }
    const requests: any[] = [];
    context.getLang = () => lang;
    context.getExternalCliValue = () => cli;
    context.getExternalCliSelectionWarning = () => '';
    const seed = context.getCliDefaults(cli);
    const expected = lang === 'zh' ? seed.description_zh : seed.description_en;
    expect(expected.trim()).not.toBe('');
    context._applyExternalCliDefaults(cli);
    expect(element('agent-ext-name-input').value).toBe(seed.name);
    expect(element('agent-ext-desc-input').value).toBe(expected);
    element('agent-ext-desc-input').value = '   ';
    context.apiFetch = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      return {
        json: async () => ({
          ok: true,
          agent: { agent_id: 'agent-created', name: body.name },
        }),
      };
    };
    context.closeAgentModal = () => {};
    context.setView = () => {};
    context.loadAgents = async () => {};
    context._showAgentsDetailView = async () => {};

    await context._saveExternalAgent({ msgEl: element('agent-form-msg') });

    expect(element('agent-ext-desc-input').value).toBe(expected);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      name: seed.name, description: expected, runtime: { kind: 'cli', cli },
    });
  });

  it.each(['en', 'zh'])('refreshes untouched CLI defaults but preserves user text in a %s UI', (lang) => {
    const { context, element } = loadAgentRenderer();
    for (const module of ['utils.js', 'local-agents.js']) {
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', module), 'utf8'), context);
    }
    context.getLang = () => lang;
    context._applyExternalCliDefaults('claude');
    element('agent-ext-name-input').value = 'MyAgent';
    context._applyExternalCliDefaults('codex');
    expect(element('agent-ext-name-input').value).toBe('MyAgent');
    expect(element('agent-ext-desc-input').value).toBe(context.getCliDefaults('codex')[`description_${lang}`]);

    const custom = lang === 'zh' ? '仅处理团队的发布任务。' : 'Only handle release work for my team.';
    element('agent-ext-desc-input').value = custom;
    context._applyExternalCliDefaults('hermes');
    expect(element('agent-ext-desc-input').value).toBe(custom);
    context._applyExternalCliDefaults(null);
    expect(element('agent-ext-desc-input').value).toBe(custom);
    expect(element('agent-ext-name-input').value).toBe('MyAgent');
  });

  it('adds a suffix when an untouched default external-agent name is taken', async () => {
    const { context, element } = loadAgentRenderer();
    const names: string[] = [];
    element('agent-ext-name-input').value = 'Codex';
    element('agent-ext-desc-input').value = 'Runs local coding tasks';
    context.getExternalCliValue = () => 'codex';
    context.getExternalCliSelectionWarning = () => '';
    context.getCliDefaults = () => ({ name: 'Codex' });
    context.apiFetch = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      names.push(body.name);
      return {
        json: async () => names.length === 1
          ? { ok: false, code: 'E_AGENT_NAME_TAKEN' }
          : {
              ok: true,
              agent: { agent_id: 'agent-created', name: body.name },
            },
      };
    };
    context.closeAgentModal = () => {};
    context.setView = () => {};
    context.loadAgents = async () => {};
    context._showAgentsDetailView = async () => {};

    await context._saveExternalAgent({ msgEl: element('agent-form-msg') });

    expect(names).toEqual(['Codex', 'Codex-2']);
    expect(element('agent-ext-name-input').value).toBe('Codex-2');
  });

  it('does not silently rename a custom external-agent name when it is taken', async () => {
    const { context, element } = loadAgentRenderer();
    const names: string[] = [];
    element('agent-ext-name-input').value = 'MyCodingAgent';
    element('agent-ext-desc-input').value = 'Runs local coding tasks';
    context.getExternalCliValue = () => 'codex';
    context.getExternalCliSelectionWarning = () => '';
    context.getCliDefaults = () => ({ name: 'Codex' });
    context.apiFetch = async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      names.push(body.name);
      return {
        json: async () => ({
          ok: false,
          code: 'E_AGENT_NAME_TAKEN',
          error: 'name taken',
        }),
      };
    };

    await context._saveExternalAgent({ msgEl: element('agent-form-msg') });

    expect(names).toEqual(['MyCodingAgent']);
    expect(element('agent-ext-name-input').value).toBe('MyCodingAgent');
    expect(element('agent-form-msg').className).toBe('form-msg err');
    expect(element('agent-form-msg').textContent).toBeTruthy();
  });

  it('keeps resource-card skill use selected in the new-chat composer', async () => {
    const { context } = loadAgentRenderer();
    const useSelections: Array<[string, Record<string, unknown> | null]> = [];
    context.apiFetch = async () => ({
      json: async () => ({ ok: true, agent: { agent_id: 'agent-card', name: 'Card Agent' } }),
    });
    context.setView = () => {};
    context.setChatRecipient = () => {};
    // Picker selections toggle the recipient marker in the composer text
    // (conversation.js); the agent module only forwards the pick.
    context._toggleComposerRecipient = (target: string, recipient: Record<string, unknown>) => context.setChatRecipient(target, recipient);
    context.setChatUseSelection = (target: string, selection: Record<string, unknown> | null) => {
      useSelections.push([target, selection]);
    };
    context.setChatSkill = () => {};

    await context.useAgent('agent-card');
    await context.useSkill('skill-card', 'Card Skill', 'global');
    await context._triggerPickerItem('agent', 'agent-chat', 'Chat Agent', 'new-chat-recipient-chip', {});
    await context._triggerPickerItem('skill', 'skill-chat', 'Chat Skill', 'new-chat-recipient-chip', {});
    await context._triggerPickerItem('agent', 'agent-auto', 'Auto Agent', 'auto-recipient-chip', {});
    await context._triggerPickerItem('skill', 'skill-auto', 'Auto Skill', 'auto-recipient-chip', {});

    expect(useSelections).toContainEqual(['new-chat', {
      kind: 'skill', id: 'skill-card', name: 'Card Skill', source: 'global',
    }]);
  });

});
