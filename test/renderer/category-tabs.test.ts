import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

class FakeClassList {
  classes = new Set<string>();
  add(cls: string) { this.classes.add(cls); }
  remove(cls: string) { this.classes.delete(cls); }
  contains(cls: string) { return this.classes.has(cls); }
  toggle(cls: string, force?: boolean) {
    const next = force === undefined ? !this.classes.has(cls) : force;
    if (next) this.classes.add(cls);
    else this.classes.delete(cls);
  }
}

class FakeElement {
  innerHTML = '';
  style: Record<string, string> = {};
  classList = new FakeClassList();
  focused = false;
  querySelectorAll() { return []; }
  addEventListener() {}
  focus() { this.focused = true; }
}

function loadCategoryRenderers() {
  const elements = new Map<string, FakeElement>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id)!;
  };
  const context: any = {
    console,
    setTimeout,
    createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {} }),
    document: { getElementById: (id: string) => el(id), querySelectorAll: () => [] },
    window: { addEventListener: () => {}, orkas: { invoke: async () => ({ list: [] }) } },
    escapeHtml: (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    } as Record<string, string>)[ch]),
    getLang: () => 'zh',
    t: (key: string) => ({
      'agents.custom_group': '自定义',
      'agents.builtin_group': '平台',
      'agents.use_tooltip': '使用',
      'agents.more_actions': '更多',
      'agents.placeholder_unset': '未设置',
      'agents.unnamed': '未命名',
      'skills.custom_group': '自定义',
      'skills.builtin_group': '平台',
      'skills.use_tooltip': '使用',
      'skills.more_actions': '更多',
      'skills.no_desc': '无描述',
      'skills.external_group': '外部包',
      'skills.global_group': '全局文件夹',
      'skills.no_match': '无匹配技能',
      'skills.source_custom': '自定义',
      'skills.source_marketplace': '市场',
      'component.disable': '停用',
      'component.enable': '启用',
      'settings.packages.update': '更新',
      'settings.packages.remove': '移除',
      'settings.packages.kind_cli': '命令行',
      'settings.packages.kind_both': '技能 + 命令行',
      'marketplace.all': '全部',
    } as Record<string, string>)[key] || key,
    pickLocalizedName: (c: any) => c?.name_zh || c?.name_en || c?.code || '',
    pickDesc: (item: any) => item?.description_zh || item?.description_en || item?.description || '',
    renderAvatarHtml: () => '<span class="avatar"></span>',
    normalizeCatalogSource: (source: string) => source || '',
    isMarketplaceCatalogSource: (source: string) => source === 'marketplace',
    _mpCategoriesCache: [
      { code: 'data', name_zh: '数据', name_en: 'Data' },
      { code: 'general', name_zh: '通用', name_en: 'General' },
    ],
    _mpCanonicalCategoryCode: (code: unknown) => String(code || '').trim() === 'writing' ? 'creation' : String(code || '').trim(),
    _mpMaybeRefreshCategoriesForCodes: () => {},
    _mpReviewStatusLabel: (status: string) => status,
  };
  vm.createContext(context);
  for (const file of ['agents.js', 'skills.js']) {
    const code = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules', file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  }
  return { context, el };
}

describe('agent and skill category tabs', () => {
  it('maps missing and non-registry agent categories to General instead of Unknown', () => {
    const { context, el } = loadCategoryRenderers();
    const agents = [
      { agent_id: 'a1', name: 'No Category', source: 'custom', category: '' },
      { agent_id: 'a2', name: 'Bad Category', source: 'custom', category: 'not-in-registry' },
      { agent_id: 'a3', name: 'Data Agent', source: 'custom', category: 'data' },
    ];

    context.renderAgentsGrid(agents);
    expect(el('agents-categories').innerHTML).toContain('通用');
    expect(el('agents-categories').innerHTML).not.toContain('未知');

    vm.runInContext('_agentsActiveCategory = "general"', context);
    context.renderAgentsGrid(agents);
    expect(el('agents-grid').innerHTML).toContain('No Category');
    expect(el('agents-grid').innerHTML).toContain('Bad Category');
    expect(el('agents-grid').innerHTML).not.toContain('Data Agent');
  });

  it('maps missing and non-registry skill categories to General instead of Unknown', () => {
    const { context, el } = loadCategoryRenderers();
    const skills = [
      { id: 's1', name: 'No Category', source: 'custom', category: '' },
      { id: 's2', name: 'Bad Category', source: 'custom', category: 'not-in-registry' },
      { id: 's3', name: 'Data Skill', source: 'custom', category: 'data' },
    ];

    context.renderSkillsGrid(skills);
    expect(el('skills-categories').innerHTML).toContain('通用');
    expect(el('skills-categories').innerHTML).not.toContain('未知');

    vm.runInContext('_skillsActiveCategory = "general"', context);
    context.renderSkillsGrid(skills);
    expect(el('skills-grid').innerHTML).toContain('No Category');
    expect(el('skills-grid').innerHTML).toContain('Bad Category');
    expect(el('skills-grid').innerHTML).not.toContain('Data Skill');
  });

  it('refreshes open-tier skills even when the trusted skills cache is reused', async () => {
    const { context, el } = loadCategoryRenderers();
    let openRows: any[] = [];
    let openFetches = 0;
    context.apiFetch = async () => ({
      json: async () => ({
        ok: true,
        skills: [{ id: 'trusted', name: 'Trusted Skill', source: 'custom', category: 'general' }],
      }),
    });
    context.window.orkas.invoke = async (channel: string) => {
      if (channel === 'skills.listOpen') {
        openFetches += 1;
        return { ok: true, skills: openRows };
      }
      return { ok: true };
    };

    await context.loadSkills();
    expect(openFetches).toBe(1);
    expect(el('skills-grid').innerHTML).not.toContain('External Smoke');

    openRows = [{
      id: 'external-smoke',
      name: 'External Smoke',
      source: 'external',
      enabled: true,
      package_name: 'smoke-pack',
      package_kind: 'both',
      package_enabled: true,
    }];
    await context.loadSkills();

    expect(openFetches).toBe(2);
    expect(el('skills-grid').innerHTML).toContain('外部包');
    expect(el('skills-grid').innerHTML).toContain('External Smoke');
    expect(el('skills-grid').innerHTML).toContain('smoke-pack · 技能 + 命令行');
    expect(el('skills-grid').innerHTML).toContain('data-open-more');
    // Open-tier cards carry a "use" (play) button like trusted cards.
    expect(el('skills-grid').innerHTML).toContain('data-open-use');
    expect(el('skills-grid').innerHTML).not.toContain('skill-card-chip is-external');
    expect(el('skills-grid').innerHTML).not.toContain('data-open-toggle');

    openRows = [{
      id: 'external-smoke',
      name: 'External Smoke',
      source: 'external',
      enabled: false,
      package_name: 'smoke-pack',
      package_kind: 'both',
      package_enabled: false,
    }];
    await context.loadSkills();

    expect(openFetches).toBe(3);
    expect(el('skills-grid').innerHTML).toContain('External Smoke');
    expect(el('skills-grid').innerHTML).toContain('is-disabled');
  });

  it('renders CLI-only external packages as cards in the Skills tab', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _skillsCache = [];
      _openSkillsCache = [];
      _packagesCache = [{
        name: 'orkas-cli-smoke',
        kind: 'cli',
        enabled: true,
        skill_count: 0,
        bin_names: ['orkas-cli-smoke']
      }];
      renderSkillsGrid([]);
    `, context);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('外部包');
    expect(html).toContain('orkas-cli-smoke');
    expect(html).toContain('命令行 · `orkas-cli-smoke`');
    expect(html).toContain('skill-card is-readonly');
    expect(html).toContain('data-open-package-card');
    expect(html).toContain('data-open-package-more');
    expect(html).not.toContain('packages-list');
    expect(html).not.toContain('package-row');
  });

  it('lists open-tier skills in the commander skill picker groups', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _skillsCache = [
        { id: 'trusted', name: 'Trusted Skill', source: 'custom', enabled: true, description_zh: 'trusted desc' }
      ];
      _openSkillsCache = [
        { id: 'external-smoke', name: 'External Smoke', source: 'external', enabled: true, description: 'package skill' },
        { id: 'global-helper', name: 'Global Helper', source: 'global', enabled: true, description: 'global skill' },
        { id: 'disabled-package', name: 'Disabled Package', source: 'external', enabled: false, description: 'disabled' }
      ];
      _renderSkillPickerList(document.getElementById('agent-picker-list'), '', 'new-chat-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    expect(html).toContain('自定义');
    expect(html).toContain('Trusted Skill');
    expect(html).toContain('外部包');
    expect(html).toContain('External Smoke');
    expect(html).toContain('全局文件夹');
    expect(html).toContain('Global Helper');
    expect(html).not.toContain('Disabled Package');
  });

  it('keeps open-tier skills commander-only but offers trusted skills to agent recipients', async () => {
    const { context } = loadCategoryRenderers();
    context.pickedSkillCalls = [];
    context.getChatRecipient = () => ({ kind: 'commander' });
    vm.runInContext(`
      _skillsCache = [
        { id: 'trusted', name: 'Trusted Skill', source: 'custom', enabled: true, description_zh: 'd' }
      ];
      _openSkillsCache = [
        { id: 'external-smoke', name: 'External Smoke', source: 'external', enabled: true, description: 'pkg' }
      ];
      setChatSkill = (target, name) => { pickedSkillCalls.push([target, name]); };
    `, context);

    // Commander: all three tabs; open-tier skill selectable.
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills', 'connectors']);
    await context._triggerPickerItem('skill', 'external-smoke', 'External Smoke', 'new-chat-recipient-chip');
    expect(context.pickedSkillCalls).toEqual([['new-chat', 'External Smoke']]);

    // Agent recipient: skills tab stays (connectors drop). Open-tier skill is
    // refused; a trusted (custom/marketplace) skill goes through — the agent
    // runs it via the orkas bridge.
    context.pickedSkillCalls = [];
    context.getChatRecipient = () => ({ kind: 'agent', id: 'agent-1', name: 'Agent One' });
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills']);
    await context._triggerPickerItem('skill', 'external-smoke', 'External Smoke', 'new-chat-recipient-chip');
    expect(context.pickedSkillCalls).toEqual([]);
    await context._triggerPickerItem('skill', 'trusted', 'Trusted Skill', 'new-chat-recipient-chip');
    expect(context.pickedSkillCalls).toEqual([['new-chat', 'Trusted Skill']]);
  });

  it('hides open-tier skill groups from the picker for an agent recipient', () => {
    const { context, el } = loadCategoryRenderers();
    context.getChatRecipient = () => ({ kind: 'agent', id: 'agent-1', name: 'Agent One' });
    vm.runInContext(`
      _skillsCache = [
        { id: 'trusted', name: 'Trusted Skill', source: 'custom', enabled: true, description_zh: 'trusted desc' }
      ];
      _openSkillsCache = [
        { id: 'external-smoke', name: 'External Smoke', source: 'external', enabled: true, description: 'package skill' },
        { id: 'global-helper', name: 'Global Helper', source: 'global', enabled: true, description: 'global skill' }
      ];
      _renderSkillPickerList(document.getElementById('agent-picker-list'), '', 'new-chat-recipient-chip');
    `, context);

    const html = el('agent-picker-list').innerHTML;
    expect(html).toContain('Trusted Skill');
    expect(html).not.toContain('External Smoke');
    expect(html).not.toContain('Global Helper');
  });
});
