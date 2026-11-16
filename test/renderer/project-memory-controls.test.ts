import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const rendererRoot = path.join(__dirname, '../../src/renderer');
const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
const source = fs.readFileSync(path.join(rendererRoot, 'modules/project-detail.js'), 'utf8');
const styles = fs.readFileSync(path.join(rendererRoot, 'style.css'), 'utf8');
const locales = Object.fromEntries(['en', 'zh', 'ja', 'pt'].map((locale) => [
  locale,
  JSON.parse(fs.readFileSync(path.join(rendererRoot, 'locales', `${locale}.json`), 'utf8')),
]));

describe('project memory controls', () => {
  it('exposes add/edit/delete controls through project-scoped memory IPC', () => {
    expect(html).toContain('id="project-memory-add-btn"');
    expect(html).toContain('id="project-memory-editor-input"');
    expect(source).toContain("isEdit ? 'memory.replace' : 'memory.add'");
    expect(source).toContain("_mutateProjectMemory('memory.remove', { oldText: text })");
    expect(source).toContain("target: 'project'");
    expect(source).toContain('projectId: pid');
  });

  it('uses a dedicated editor state with concise context guidance', () => {
    expect(html).toContain('data-i18n="project.instructions.subtitle"');
    expect(html).toContain('data-i18n="project.memory.subtitle"');
    expect(html).toContain('class="project-detail-tab-group" role="tablist"');
    expect(html).toMatch(/project-side-card-head project-side-card-head-tabs[\s\S]*?data-project-side-tabs="context"/);
    expect(html).toMatch(/project-side-card-head project-side-card-head-tabs[\s\S]*?data-project-side-tabs="resources"/);
    expect(styles).toContain('.project-memory-editor:not([hidden]) ~ .project-memory-list');
    expect(styles).toContain('.project-memory-editor:not([hidden]) ~ .empty');
    expect(source).toContain('input.setSelectionRange(end, end)');
    expect(source).not.toContain('input.select()');
  });

  it('labels the shared instructions and memory card as context in every locale', () => {
    expect(html).toContain('data-i18n="project.context.title">Context</span>');
    expect(locales.en['project.context.title']).toBe('Context');
    expect(locales.zh['project.context.title']).toBe('上下文');
    expect(locales.ja['project.context.title']).toBe('コンテキスト');
    expect(locales.pt['project.context.title']).toBe('Contexto');
  });

  it('keeps live progress out of project-memory guidance in every locale', () => {
    const forbidden: Record<string, RegExp> = {
      en: /\b(progress|update)\b/i,
      zh: /进展|进度/,
      ja: /進捗/,
      pt: /avanços|atualizaç/i,
    };
    for (const [locale, table] of Object.entries(locales)) {
      const guidance = `${table['project.memory.subtitle']} ${table['project.memory.placeholder']}`;
      expect(guidance, locale).not.toMatch(forbidden[locale]);
    }
  });

  it('swaps the guidance line for the heading once an entry exists', () => {
    const nodes: Record<string, any> = {
      'project-memory-list': { innerHTML: '', style: {}, children: [] as any[], appendChild(child: any) { this.children.push(child); } },
      'project-memory-empty': { style: {} },
      'project-memory-count': { textContent: '' },
      'project-memory-section-head': { hidden: false },
    };
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById: (id: string) => nodes[id] || null,
        querySelector: () => null,
        createElement: () => ({
          appendChild() {}, className: '', dataset: {}, style: {}, textContent: '',
          setAttribute() {}, addEventListener() {},
        }),
      },
      window: { addEventListener() {}, orkas: { invoke: async () => ({ ok: true }) } },
      escapeHtml: (value: string) => value,
      t: (key: string) => key,
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });

    vm.runInContext('_projectMemory = []; _renderProjectMemoryList()', context);
    expect(nodes['project-memory-section-head'].hidden).toBe(true);
    expect(nodes['project-memory-empty'].style.display).toBe('');

    vm.runInContext("_projectMemory = ['The release checklist is the source of truth.']; _renderProjectMemoryList()", context);
    expect(nodes['project-memory-section-head'].hidden).toBe(false);
    expect(nodes['project-memory-empty'].style.display).toBe('none');
    expect(nodes['project-memory-count'].textContent).toBe('1');
  });

  it('guards project-instruction saves with dirty, limit, and error states', () => {
    expect(source).toContain("window.orkas.invoke('projects.instructions.set'");
    expect(source).toContain("input.value !== (input.dataset.savedValue || '')");
    expect(source).toContain('saveBtn.disabled = !dirty || over');
    expect(source).toContain("uiAlert(t('project.instructions.save_failed'))");
    expect(source).toContain("input.dataset.projectId = String(_projectDetailPid || '')");
    // Async save ownership is exercised through the actual handler in
    // project-instructions-editor.test.ts, including navigation and drafts.
  });
});

function mountMemory() {
  const node = (): any => ({
    dataset: {}, style: {}, hidden: false, value: '', disabled: false, maxLength: 4000,
    listeners: {} as Record<string, (...args: any[]) => any>,
    appendChild() {}, setAttribute() {}, focus() {}, setSelectionRange() {},
    addEventListener(name: string, handler: (...args: any[]) => any) { this.listeners[name] = handler; },
  });
  const nodes: Record<string, any> = Object.fromEntries([
    'project-memory-list', 'project-memory-editor', 'project-memory-editor-input',
    'project-memory-editor-save', 'project-memory-editor-cancel', 'project-memory-editor-counter',
  ].map(id => [id, node()]));
  const requests: any[] = [], alerts: unknown[] = [];
  const context = vm.createContext({
    console, currentUserId: 'account_a', currentView: 'project',
    createLogger: () => ({warn() {}, info() {}, error() {}}),
    document: { readyState: 'loading', addEventListener() {},
      getElementById: (id: string) => nodes[id] || null, querySelector: () => null, createElement: node },
    window: {addEventListener() {}, orkas: {invoke: async (channel: string, payload: unknown) => {
      requests.push({channel, payload}); return {ok: true, entries: ['Protected fact']};
    }}},
    uiAlert: (message: unknown) => alerts.push(message), escapeHtml: (s: string) => s,
    t: (key: string) => key, setTimeout, clearTimeout,
  });
  vm.runInContext(source, context, {filename: 'project-detail.js'});
  vm.runInContext('_projectDetailPid = "project_a"; _projectMemory = ["Shared wording", "Protected fact"]', context);
  context._bindProjectMemory();
  return {context, nodes, requests, alerts};
}

it.each(['project', 'account'])('does not delete another scope after an old memory confirmation crosses %s', async transition => {
  const {context, nodes, requests} = mountMemory();
  let finish!: (value: boolean) => void;
  context.uiConfirm = () => new Promise(resolve => { finish = resolve; });
  const button = {dataset: {action: 'project-memory-delete', memoryIndex: '0'}};
  const deleting = nodes['project-memory-list'].listeners.click({target: {closest: () => button}});
  if (transition === 'project') vm.runInContext('_projectDetailPid = "project_b"; _projectMemory = ["Shared wording", "B protected fact"]', context);
  else context.currentUserId = 'account_b';
  finish(true);
  await deleting;
  expect(requests).toEqual([]);
  expect(vm.runInContext('_projectMemory', context)).toEqual(transition === 'project' ? ['Shared wording', 'B protected fact'] : ['Shared wording', 'Protected fact']);
});

it('still deletes the confirmed memory entry in its unchanged project', async () => {
  const {context, nodes, requests} = mountMemory();
  context.uiConfirm = async () => true;
  const button = {dataset: {action: 'project-memory-delete', memoryIndex: '0'}};
  await nodes['project-memory-list'].listeners.click({target: {closest: () => button}});
  expect(requests).toEqual([{channel: 'memory.remove', payload: {target: 'project', projectId: 'project_a', oldText: 'Shared wording'}}]);
  expect(vm.runInContext('_projectMemory', context)).toEqual(['Protected fact']);
});

it.each(['new draft', 'new editor', 'project', 'account'])('preserves the %s when a prior memory save completes', async transition => {
  const {context, nodes} = mountMemory();
  let finish!: (value: unknown) => void;
  context.window.orkas.invoke = () => new Promise(resolve => { finish = resolve; });
  context._openProjectMemoryEditor('add');
  const input = nodes['project-memory-editor-input'];
  input.value = 'Submitted memory fact';
  const saving = context._saveProjectMemoryEditor();
  if (transition === 'new editor') context._openProjectMemoryEditor('add');
  if (transition === 'project') {
    vm.runInContext('_projectDetailPid = "project_b"; _projectMemory = ["B protected fact"]', context);
    context._openProjectMemoryEditor('add');
  }
  if (transition === 'account') context.currentUserId = 'account_b';
  input.value = 'Current unsaved memory draft';
  finish({ok: true, entries: ['Submitted memory fact', 'Protected fact']});
  await saving;
  expect(nodes['project-memory-editor'].hidden).toBe(false);
  expect(input.value).toBe('Current unsaved memory draft');
  if (transition === 'account') expect(vm.runInContext('_projectMemory', context)).toEqual(['Shared wording', 'Protected fact']);
  if (transition === 'project') expect(vm.runInContext('_projectMemory', context)).toEqual(['B protected fact']);
});

it('keeps a successful unchanged memory save and closes only that editor', async () => {
  const {context, nodes, requests} = mountMemory();
  context._openProjectMemoryEditor('add');
  nodes['project-memory-editor-input'].value = 'New fact';
  await context._saveProjectMemoryEditor();
  expect(requests).toEqual([{channel: 'memory.add', payload: {target: 'project', projectId: 'project_a', content: 'New fact'}}]);
  expect(nodes['project-memory-editor'].hidden).toBe(true);
});

it.each(['rejection', 'exception'])('keeps a memory mutation %s from alerting a later account', async outcome => {
  const {context, nodes, alerts} = mountMemory();
  let finish!: (value: unknown) => void, fail!: (error: Error) => void;
  context.window.orkas.invoke = () => new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  context._openProjectMemoryEditor('add');
  nodes['project-memory-editor-input'].value = 'Submitted fact';
  const saving = context._saveProjectMemoryEditor();
  context.currentUserId = 'account_b';
  if (outcome === 'exception') fail(new Error('controlled mutation failure')); else finish({ok: false, error: 'controlled rejection'});
  await saving;
  expect(alerts).toEqual([]);
});
