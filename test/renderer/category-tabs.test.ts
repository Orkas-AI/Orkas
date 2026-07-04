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
    t: (key: string, vars?: any) => ({
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
      'skills.global_group_hint': '来自本机共享的技能文件夹',
      'skills.global_group_expand': '展开',
      'skills.global_group_collapse': '收起',
      'skills.no_match': '无匹配技能',
      'skills.source_custom': '自定义',
      'skills.source_marketplace': '市场',
      'component.disable': '停用',
      'component.enable': '启用',
      'settings.packages.update': '更新',
      'settings.packages.remove': '移除',
      'settings.packages.kind_skill': '技能',
      'settings.packages.kind_cli': '命令行',
      'settings.packages.kind_both': '技能 + 命令行',
      'settings.packages.skills_count': '{count} 个技能',
      'marketplace.all': '全部',
    } as Record<string, string>)[key]?.replace('{count}', String(vars?.count ?? '')) || key,
    normalizeDisplayText: (value: unknown) => String(value ?? '').trim(),
    pickLocalizedName: (c: any) => c?.name_zh || c?.name_en || c?.code || '',
    pickLocalizedField: (item: any, base: string, lang: string) => item?.[`${base}_${lang}`] || item?.[base] || '',
    pickDesc: (item: any) => item?.description_zh || item?.description_en || item?.description || '',
    renderAvatarHtml: () => '<span class="avatar"></span>',
    normalizeCatalogSource: (source: string) => source || '',
    isMarketplaceCatalogSource: (source: string) => source === 'marketplace',
    isDevMode: () => true,
    _mpCategoriesCache: [
      { code: 'data', name_zh: '数据', name_en: 'Data' },
      { code: 'general', name_zh: '通用', name_en: 'General' },
    ],
    _mpCanonicalCategoryCode: (code: unknown) => String(code || '').trim() === 'writing' ? 'creation' : String(code || '').trim(),
    _mpMaybeRefreshCategoriesForCodes: () => {},
    _mpShowReviewStatusUi: () => false,
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
    expect(el('skills-grid').innerHTML).toContain('smoke-pack');
    expect(el('skills-grid').innerHTML).toContain('技能 + 命令行 · 1 个技能');
    expect(el('skills-grid').innerHTML).toContain('data-open-package-card');
    expect(el('skills-grid').innerHTML).toContain('data-open-package-more');
    expect(el('skills-grid').innerHTML).not.toContain('External Smoke');
    expect(el('skills-grid').innerHTML).not.toContain('data-open-use');
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
    expect(el('skills-grid').innerHTML).toContain('smoke-pack');
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

  it('hides marketplace review status chips on agent and skill cards', () => {
    const { context, el } = loadCategoryRenderers();

    context.renderAgentsGrid([{
      agent_id: 'a1',
      name: 'Agent One',
      source: 'marketplace',
      category: 'general',
      status: 'approved',
    }]);
    context.renderSkillsGrid([{
      id: 's1',
      name: 'Skill One',
      source: 'marketplace',
      category: 'general',
      status: 'reviewing',
    }]);

    expect(el('agents-grid').innerHTML).not.toContain('is-status');
    expect(el('agents-grid').innerHTML).not.toContain('approved');
    expect(el('skills-grid').innerHTML).not.toContain('is-status');
    expect(el('skills-grid').innerHTML).not.toContain('reviewing');
  });

  it('uses friendly external package display names while keeping the package key internal', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _skillsCache = [];
      _openSkillsCache = [];
      _packagesCache = [{
        name: 'cli',
        display_name: 'PPT-Master',
        kind: 'skill',
        enabled: true,
        skill_count: 95,
        bin_names: []
      }];
      renderSkillsGrid([]);
    `, context);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('PPT-Master');
    expect(html).toContain('技能 · 95 个技能');
    expect(html).toContain('data-open-package-name="cli"');
    expect(html).not.toContain('<span class="skill-card-name">cli</span>');
  });

  it('aggregates namespace-shaped global-folder skills into source cards', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _skillsCache = [];
      _openSkillsCache = [
        { id: 'lark-base', name: 'Lark Base', source: 'global', enabled: true, description: 'base' },
        { id: 'lark-doc', name: 'Lark Doc', source: 'global', enabled: true, description: 'doc' },
        { id: 'single-helper', name: 'Single Helper', source: 'global', enabled: true, description: 'solo' }
      ];
      _expandedGlobalSkillGroups = new Set();
      renderSkillsGrid([]);
    `, context);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('全局文件夹');
    expect(html).toContain('<span class="skill-card-name">lark</span>');
    expect(html).not.toContain('全局文件夹 · 2 个技能');
    expect(html).toContain('data-global-skill-group="lark"');
    expect(html).toContain('data-global-skill-group-more="lark"');
    expect(html).toContain('data-global-skill-group-toggle="lark"');
    expect(html).toContain('2 个技能：Lark Base、Lark Doc');
    expect(html).toContain('展开');
    expect(html).toContain('Single Helper');
    expect(html).not.toContain('Lark-CLI');
    expect(html).not.toContain('<span class="skill-card-name">Lark Base</span>');
    expect(html).not.toContain('data-open-id="lark-base"');
  });

  it('shows grouped global-folder skill cards after that source card is expanded', () => {
    const { context, el } = loadCategoryRenderers();
    vm.runInContext(`
      _skillsCache = [];
      _openSkillsCache = [
        { id: 'lark-base', name: 'Lark Base', source: 'global', enabled: true, description: 'base' },
        { id: 'lark-doc', name: 'Lark Doc', source: 'global', enabled: true, description: 'doc' }
      ];
      _expandedGlobalSkillGroups = new Set(['lark']);
      renderSkillsGrid([]);
    `, context);

    const html = el('skills-grid').innerHTML;
    expect(html).toContain('<span class="skill-card-name">lark</span>');
    expect(html).not.toContain('Lark-CLI');
    expect(html).toContain('收起');
    expect(html).toContain('Lark Base');
    expect(html).toContain('data-open-id="lark-base"');
    expect(html).toContain('data-open-use');
  });

  it('toggles namespace-shaped global-folder skill groups together', async () => {
    const { context } = loadCategoryRenderers();
    const calls: Array<{ channel: string; payload: any }> = [];
    context.window.orkas.invoke = async (channel: string, payload: any) => {
      calls.push({ channel, payload });
      return { ok: true };
    };
    vm.runInContext(`
      _skillsCache = [];
      _openSkillsCache = [
        { id: 'lark-base', name: 'Lark Base', source: 'global', enabled: true },
        { id: 'lark-doc', name: 'Lark Doc', source: 'global', enabled: true },
        { id: 'single-helper', name: 'Single Helper', source: 'global', enabled: true }
      ];
    `, context);

    await context._setGlobalSkillGroupEnabled('lark', false);

    expect(calls).toEqual([
      { channel: 'skills.setEnabled', payload: { id: 'lark-base', enabled: false } },
      { channel: 'skills.setEnabled', payload: { id: 'lark-doc', enabled: false } },
    ]);
    expect(vm.runInContext('_openSkillsCache.map((s) => [s.id, s.enabled])', context)).toEqual([
      ['lark-base', false],
      ['lark-doc', false],
      ['single-helper', true],
    ]);
  });

  it('lists global open-tier skills in the commander skill picker groups without expanding external packages', () => {
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
    expect(html).not.toContain('外部包');
    expect(html).not.toContain('External Smoke');
    expect(html).toContain('全局文件夹');
    expect(html).toContain('Global Helper');
    expect(html).not.toContain('Disabled Package');
  });

  it('keeps external package recipes out of the picker while preserving global open-tier selection', async () => {
    const { context } = loadCategoryRenderers();
    context.pickedSkillCalls = [];
    context.getChatRecipient = () => ({ kind: 'commander' });
    vm.runInContext(`
      _skillsCache = [
        { id: 'trusted', name: 'Trusted Skill', source: 'custom', enabled: true, description_zh: 'd' }
      ];
      _openSkillsCache = [
        { id: 'global-helper', name: 'Global Helper', source: 'global', enabled: true, description: 'pkg' }
      ];
      setChatSkill = (target, id, name) => { pickedSkillCalls.push([target, id, name]); };
    `, context);

    // Commander: all picker tabs; global open-tier skill selectable.
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills', 'connectors', 'library']);
    await context._triggerPickerItem('skill', 'global-helper', 'Global Helper', 'new-chat-recipient-chip');
    expect(context.pickedSkillCalls).toEqual([['new-chat', 'global-helper', 'Global Helper']]);

    // Agent recipient uses the same visible picker tabs; runtime capability
    // gates live in the main process. Trusted skill selection still works.
    context.pickedSkillCalls = [];
    context.getChatRecipient = () => ({ kind: 'agent', id: 'agent-1', name: 'Agent One' });
    expect(vm.runInContext('_agentPickerVisibleTabs("new-chat-recipient-chip")', context))
      .toEqual(['agents', 'skills', 'connectors', 'library']);
    await context._triggerPickerItem('skill', 'trusted', 'Trusted Skill', 'new-chat-recipient-chip');
    expect(context.pickedSkillCalls).toEqual([['new-chat', 'trusted', 'Trusted Skill']]);
  });

  it('hides external package recipe groups from the picker for an agent recipient', () => {
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
    expect(html).toContain('Global Helper');
  });
});
