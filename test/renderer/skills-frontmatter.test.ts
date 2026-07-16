import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadSkillRendererHelpers() {
  const context: any = {
    console,
    createLogger: () => ({ warn: () => {}, info: () => {}, error: () => {} }),
    t: (key: string) => ({
      'skills.import_seed_display': '整理已导入的技能',
    } as Record<string, string>)[key] || key,
    window: { addEventListener: () => {} },
    normalizeDisplayText: (value: unknown) => String(value || '')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\{2,}/g, '\\')
      .replace(/\s+/g, ' ')
      .trim(),
  };
  context.global = context;
  context.globalThis = context;
  vm.createContext(context);
  const code = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'modules', 'skills.js'), 'utf8');
  vm.runInContext(code, context, { filename: 'skills.js' });
  return context;
}

describe('skills renderer frontmatter parsing', () => {
  it('normalizes escaped quotes before showing skill descriptions', () => {
    const context = loadSkillRendererHelpers();
    const pairs = context._parseSkillFrontmatterPairs([
      '---',
      'name: "growth"',
      'description: "适合\\"创建 skill\\" 和 \\"编辑 skill\\""',
      '---',
      '',
    ].join('\n'));

    expect(pairs).toContainEqual(['description', '适合"创建 skill" 和 "编辑 skill"']);
  });

  it('keeps import seed instructions in model text instead of visible text', () => {
    const context = loadSkillRendererHelpers();
    const seed = context._skillImportAutoSeedFromResponse({
      seedModelText: '已按源文件直接安装这些技能：growth。请只读取现有 SKILL.md。',
    });

    expect(seed).toEqual({
      displayText: '整理已导入的技能',
      modelText: '已按源文件直接安装这些技能：growth。请只读取现有 SKILL.md。',
      force: true,
    });
    expect(seed.displayText).not.toContain('SKILL.md');
  });

  it('opens import edit chat after the file view without waiting for source tree expansion', async () => {
    const context = loadSkillRendererHelpers();
    const calls: string[] = [];
    context.__calls = calls;
    vm.runInContext(`
      closeSkillModal = () => { __calls.push('close'); };
      loadSkills = async () => { __calls.push('load'); };
      setView = (view) => { __calls.push('set:' + view); };
      _ensureSkillsSourceExpanded = async () => { __calls.push('source:expand'); };
      _showSkillsDetailView = async (source, id, opts) => {
        __calls.push('detail:start:' + source + ':' + id + ':' + (opts && opts.expandSource === false ? 'no-tree' : 'tree'));
        await new Promise((resolve) => { globalThis.__releaseDetail = resolve; });
        _selectedSkill = { source, id, filepath: 'SKILL.md', name: 'Imported' };
        __calls.push('detail:end');
      };
      toggleSkillEditMode = async (opts) => {
        __calls.push('toggle:' + (opts.autoSeed && opts.autoSeed.modelText) + ':' + opts.autoSeed.force);
      };
    `, context);

    const pending = context._afterSkillCreated('imported', true, {
      displayText: '整理已导入的技能',
      modelText: '已直接安装这些技能：imported。',
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toEqual(['close', 'load', 'set:skills', 'detail:start:custom:imported:no-tree']);
    context.__releaseDetail();
    await pending;
    await Promise.resolve();

    expect(calls).toEqual([
      'close',
      'load',
      'set:skills',
      'detail:start:custom:imported:no-tree',
      'detail:end',
      'toggle:已直接安装这些技能：imported。:undefined',
      'source:expand',
    ]);
  });

  it('routes folder import confirmation into the edit-chat create tail', async () => {
    const context = loadSkillRendererHelpers();
    const calls: string[] = [];
    const msgEl = { textContent: '', className: '' };
    context.__calls = calls;
    context.apiFetch = async (url: string, opts: any) => {
      calls.push(`api:${url}:${opts?.method || 'GET'}:${JSON.parse(opts?.body || '{}').srcDir}`);
      return {
        json: async () => ({
          ok: true,
          skill: { id: 'imported' },
          seedModelText: '已直接安装这些技能：imported。',
        }),
      };
    };
    vm.runInContext(`
      _setSkillModalBusy = (busy) => { __calls.push('busy:' + busy); };
      _waitForSkillModalBusyPaint = async () => { __calls.push('paint'); };
      _afterSkillCreated = async (sid, isNew, autoSeed) => {
        __calls.push('after:' + sid + ':' + isNew + ':' + autoSeed.modelText + ':' + autoSeed.force);
      };
    `, context);

    await context._saveSkillFromDirWithQuality({ msgEl, srcDir: '/tmp/imported', force: false });

    expect(calls).toEqual([
      'busy:true',
      'paint',
      'api:/api/skills/create-from-dir:POST:/tmp/imported',
      'after:imported:true:已直接安装这些技能：imported。:true',
      'busy:false',
    ]);
    expect(msgEl.textContent).toBe('skills.saving');
  });

  it('tracks URL skill creation success', async () => {
    const context = loadSkillRendererHelpers();
    const monitorCalls: any[] = [];
    const calls: string[] = [];
    let now = 100;
    const msgEl = { textContent: '', className: '' };
    context.__calls = calls;
    context.performance = { now: () => { now += 25; return now; } };
    context.window.Monitor = {
      click: (action: string, payload: any) => monitorCalls.push(['click', action, payload]),
      event: (action: string, payload: any) => monitorCalls.push(['event', action, payload]),
      error: (action: string, payload: any) => monitorCalls.push(['error', action, payload]),
    };
    context.apiFetch = async (url: string, opts: any) => {
      calls.push(`api:${url}:${opts?.method || 'GET'}`);
      return {
        json: async () => ({
          ok: true,
          skill: { id: 'url-skill', name: 'URL Skill' },
        }),
      };
    };
    vm.runInContext(`
      document = {
        getElementById: () => ({ value: 'https://example.com/skill', focus() {} }),
      };
      _setSkillModalBusy = (busy) => { __calls.push('busy:' + busy); };
      _waitForSkillModalBusyPaint = async () => { __calls.push('paint'); };
      _afterSkillCreated = async (sid, isNew) => { __calls.push('after:' + sid + ':' + isNew); };
    `, context);

    await context._saveSkillFromUrl({ msgEl });

    expect(monitorCalls).toEqual([
      ['click', 'skill_create_submit', { creation_method: 'url' }],
      ['event', 'skill_create_result', {
        creation_method: 'url',
        result: 'success',
        duration_ms: 25,
        skill_id: 'url-skill',
        resource_kind: 'skill',
        resource_id: 'url-skill',
        resource_name: 'URL Skill',
        skill_count: 1,
      }],
    ]);
    expect(calls).toEqual([
      'busy:true',
      'paint',
      'api:/api/skills/create-from-url:POST',
      'after:url-skill:true',
      'busy:false',
    ]);
  });

  it('sends forced import auto-seed even when edit chat history is not empty', async () => {
    const context = loadSkillRendererHelpers();
    const calls: string[] = [];
    context.__calls = calls;
    vm.runInContext(`
      document = {
        getElementById: (id) => ({ style: {}, dataset: {}, textContent: '', classList: { add(){}, remove(){}, contains(){ return false; } } }),
        querySelectorAll: (selector) => selector === '#skills-chat-messages .chat-message' ? [{}] : [],
      };
      _selectedSkill = { source: 'custom', id: 'imported', filepath: 'SKILL.md' };
      _updateEditButtonLabel = () => {};
      selectSkillFile = async () => { __calls.push('select'); };
      _chatAttachRefreshFromServer = async () => { __calls.push('attachments'); };
      _skillChatCtrl = {
        loadHistory: async () => { __calls.push('history'); },
        send: async (content, extra) => { __calls.push('send:' + content + ':' + extra.model_text); },
      };
      _ensureSkillChatController = () => _skillChatCtrl;
    `, context);

    await context.toggleSkillEditMode({
      autoSeed: {
        displayText: '整理已导入的技能',
        modelText: '已直接安装这些技能：imported。',
        force: true,
      },
    });

    expect(calls).toEqual([
      'select',
      'history',
      'attachments',
      'send:整理已导入的技能:skills.help_finish_seed_model\n\n已直接安装这些技能：imported。',
    ]);
  });
});
