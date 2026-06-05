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
  querySelectorAll() { return []; }
  addEventListener() {}
}

function loadCategoryRenderers() {
  const elements = new Map<string, FakeElement>();
  const el = (id: string) => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id)!;
  };
  const context: any = {
    console,
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
});
