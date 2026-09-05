import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadRenderer(module: 'agents' | 'skills') {
  const elements = new Map<string, any>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, {
      style: {}, dataset: {}, attrs: {}, hidden: false, readOnly: false,
      textContent: '', innerHTML: '', innerText: '', value: '',
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(name: string, value: string) { this.attrs[name] = value; },
      addEventListener() {}, querySelector() { return null; },
    });
    return elements.get(id);
  };
  const context: any = {
    console, setTimeout, clearTimeout,
    createLogger: () => ({ info() {}, warn() {}, error() {} }),
    window: { addEventListener() {} },
    document: { getElementById: element, querySelector: () => null },
    t: (key: string) => key, getLang: () => 'en',
    escapeHtml: (s: string) => s, renderMarkdownFull: (s: string) => `<p>${s}</p>`,
    normalizeDisplayText: (s: string) => s, pickDesc: (agent: any) => agent.description,
    uiAlert: vi.fn(),
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(process.cwd(), `src/renderer/modules/${module}.js`), 'utf8'), context);
  return { context, element };
}

describe('resource editing integration', () => {
  it.each(['marketplace', 'custom'])('keeps %s Agent definition permissions when entering memory edit mode', (source) => {
    const { context, element } = loadRenderer('agents');
    // These independent detail panels are outside the definition editor.
    for (const name of ['HeaderCategory', 'Runtime', 'CliSettings', 'ProjectDir', 'Avatar', 'Stats', 'Knowhow', 'OutputFormatSection']) {
      context[`_renderAgentDetail${name}`] = () => {};
    }
    context._renderAgentHeaderCategory = () => {};
    context._renderAgentEnabledButton = () => {};
    context._renderAgentOutputFormatSection = () => {};
    context._renderSourceMetaHtml = () => '';
    context._renderAgentDetailMemory = vi.fn();
    const agent = { agent_id: 'a1', name: 'Writer', source, description: 'Writes drafts', workflow: 'Draft the answer' };
    expect(context._canEnterAgentEditMode(agent)).toBe(true);
    context._renderAgentDetail(agent, true);
    expect(context._renderAgentDetailMemory).toHaveBeenCalledWith(expect.objectContaining({ agent_id: 'a1' }), true);
    const editable = source === 'custom';
    expect(element('agents-detail-name-input').readOnly).toBe(!editable);
    expect(element('agents-detail-desc').attrs.contenteditable).toBe(editable ? 'plaintext-only' : 'false');
    expect(element('agents-detail-workflow').attrs.contenteditable).toBe(editable ? 'plaintext-only' : 'false');
    if (!editable) expect(element('agents-detail-workflow').innerHTML).toBe('<p>Draft the answer</p>');
  });

  it('finishes an Agent rename by refreshing its selected name, cache and recipient chip', async () => {
    const { context, element } = loadRenderer('agents');
    context.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true, agent: { name: 'NewName' } }) }));
    context.loadAgents = vi.fn(async () => {});
    context._renderRecipientChip = vi.fn();
    vm.runInContext("_selectedAgent = { id: 'a1', name: 'OldName', source: 'custom' }; _pendingAgentField = { field: 'name', value: 'NewName' };", context);
    await context._flushAgentFieldSave({ validate: true });
    expect(context.apiFetch).toHaveBeenCalledWith('/api/agents/a1/update', expect.objectContaining({ method: 'PUT' }));
    expect(context.uiAlert).not.toHaveBeenCalled();
    expect(vm.runInContext('_selectedAgent.name', context)).toBe('NewName');
    expect(element('agents-detail-name-input').value).toBe('NewName');
    expect(context.loadAgents).toHaveBeenCalledWith(true);
    expect(context._renderRecipientChip).toHaveBeenCalledOnce();
  });

  it('uses the renamed Skill directory for subsequent saves and edit chat', async () => {
    const { context } = loadRenderer('skills');
    context.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true, skill: { id: 'beta' } }) }));
    context.loadSkills = vi.fn(async () => {});
    vm.runInContext("_selectedSkill = { id: 'alpha', name: 'alpha', source: 'custom', filepath: 'SKILL.md' }; _skillEditSkillId = 'alpha'; _skillTreeCache.set('custom:alpha', []); _expandedDirs.add('custom:alpha'); _pendingSkillField = { field: 'name', value: 'beta' };", context);
    expect(await context._flushSkillFieldSave({ validate: true })).toBe(true);
    expect(context.uiAlert).not.toHaveBeenCalled();
    expect(vm.runInContext('[_selectedSkill.id, _skillEditSkillId, _skillTreeCache.size, _expandedDirs.has("custom:alpha")]', context)).toEqual(['beta', 'beta', 0, false]);
    vm.runInContext("_pendingSkillField = { field: 'description', value: 'Updated' };", context);
    expect(await context._flushSkillFieldSave()).toBe(true);
    expect(context.apiFetch.mock.calls.map((call: any[]) => call[0])).toEqual(['/api/skills/alpha/update', '/api/skills/beta/update?skipRename=1']);
  });
});
