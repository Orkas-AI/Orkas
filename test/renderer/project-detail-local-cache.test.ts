import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');

function mountWithSlowSecondaryCard({ delayInstructionsFor = '' } = {}) {
  let finishAutoTasks!: (value: unknown) => void;
  const delayedAutoTasks = new Promise((resolve) => { finishAutoTasks = resolve; });
  let finishInstructions: ((value: unknown) => void) | null = null;
  const nodes: Record<string, any> = {
    'project-agents-list': { innerHTML: '', style: {}, querySelectorAll: () => [] },
    'project-detail-agents-count': { textContent: '' },
    'project-detail-content': { classList: { toggle() {} }, setAttribute() {} },
    'project-instructions-input': { value: '', dataset: {}, disabled: false },
    'project-instructions-read': { textContent: '', hidden: false },
    'project-instructions-empty': { hidden: false },
    'project-instructions-edit-btn': { disabled: false },
    'project-instructions-setup-btn': { disabled: false },
    'project-files-list': { innerHTML: '', querySelectorAll: () => [] },
    'project-files-status': { textContent: '', style: {} },
    'project-detail-files-count': { textContent: '' },
  };
  const context = vm.createContext({
    console,
    performance,
    currentUserId: 'member',
    _byDisplayName: (a: any, b: any) => a.name.localeCompare(b.name),
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    document: {
      readyState: 'loading',
      addEventListener() {},
      getElementById: (id: string) => nodes[id] || null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: { addEventListener() {}, orkas: { invoke(channel: string, args: { projectId?: string }) {
      if (channel === 'projects.get') return Promise.resolve({ ok: true, project: { project_id: args.projectId } });
      if (channel === 'projects.bindings.list') return Promise.resolve({ ok: true, bindings: { agents: ['writer'] }, agentDetails: [{ agent_id: 'writer', name: 'Cached Writer' }] });
      if (channel === 'projects.files.tree') return Promise.resolve({ ok: true, tree: [
        { type: 'file', name: 'cached.md', relPath: 'cached.md', kind: 'text', mtime: 0 },
      ] });
      if (channel === 'projects.files.status') return Promise.resolve({ ok: true, files: [] });
      if (channel === 'projects.instructions.get') {
        if (args.projectId === delayInstructionsFor) {
          return new Promise((resolve) => { finishInstructions = resolve; });
        }
        return Promise.resolve({ ok: true, content: args.projectId === 'project_a'
          ? 'Saved local rules' : 'Other project rules', limit: 4000 });
      }
      if (channel === 'memory.list') return Promise.resolve({ ok: true, entries: ['Saved memory'] });
      if (channel === 'autoTasks.list') return delayedAutoTasks;
      throw new Error(`Unexpected IPC channel: ${channel}`);
    } } },
    composerBindOwner() {},
    _setTodoLoadError() {},
    _renderProjectTodosList() {},
    _setProjectAutoTabCount() {},
    _renderProjectDetail() {},
    _buildProjectKbStatusMap: () => ({}),
    _flattenProjectLibraryFiles: () => [],
    _kickProjectKbReconcileIfNeeded() {},
    _scheduleProjectKbStatusRefreshIfNeeded() {},
    _updateProjectInstructionsFoot() {},
    escapeHtml: (value: unknown) => String(value ?? ''),
    setTimeout,
    clearTimeout,
    t: (key: string) => key,
  });
  vm.runInContext(source, context, { filename: 'project-detail.js' });
  vm.runInContext('_renderProjectDetail = function () {}; _kickProjectKbReconcileIfNeeded = function () {}; _scheduleProjectKbStatusRefreshIfNeeded = function () {};', context);
  return { context, nodes, finishAutoTasks,
    releaseInstructions() { finishInstructions?.({ ok: true, content: 'Saved local rules', limit: 4000 }); } };
}

describe('project detail local cache after restart', () => {
  it.each(['secondary card', 'instructions read'])('keeps an acknowledged rules save after an older %s finishes', async pending => {
    const { context, nodes, finishAutoTasks, releaseInstructions } = mountWithSlowSecondaryCard({
      delayInstructionsFor: pending === 'instructions read' ? 'project_a' : '',
    });
    const handlers: Record<string, () => Promise<void>> = {};
    nodes['project-instructions-input'].addEventListener = () => {};
    nodes['project-instructions-save-btn'] = { disabled: false,
      addEventListener: (name: string, handler: () => Promise<void>) => { handlers[name] = handler; } };
    nodes['project-instructions-edit-btn'].addEventListener = () => {};
    nodes['project-instructions-setup-btn'].addEventListener = () => {};
    const invoke = context.window.orkas.invoke;
    context.window.orkas.invoke = (channel: string, args: any) => channel === 'projects.instructions.set'
      ? Promise.resolve({ ok: true }) : invoke(channel, args);
    vm.runInContext('_projectDetailPid = "project_a"; _projectDetailMeta = { instructions: { content: "Saved local rules", limit: 4000 } }', context);
    context._renderProjectInstructions();
    const loading = context.loadProjectDetail('project_a');
    await new Promise(resolve => setTimeout(resolve, 0));
    context._bindProjectInstructions();
    nodes['project-instructions-input'].value = 'New acknowledged rules';
    await handlers.click();
    expect(nodes['project-instructions-read'].textContent).toBe('New acknowledged rules');
    releaseInstructions();
    finishAutoTasks({ ok: true, tasks: [] });
    await loading;
    context._renderProjectInstructions();
    expect(vm.runInContext('_projectDetailMeta.instructions.content', context)).toBe('New acknowledged rules');
    expect(nodes['project-instructions-read'].textContent).toBe('New acknowledged rules');
    expect(nodes['project-files-list'].innerHTML).toContain('cached.md');
    expect(nodes['project-agents-list'].innerHTML).toContain('Cached Writer');
  });

  it('does not restore a deleted file from a project load started before deletion', async () => {
    const { context, nodes, finishAutoTasks } = mountWithSlowSecondaryCard();
    let finishTree!: (value: unknown) => void;
    const originalInvoke = context.window.orkas.invoke;
    context.window.orkas.invoke = (channel: string, args: any) => {
      if (channel === 'projects.files.tree') return new Promise(resolve => { finishTree = resolve; });
      if (channel === 'projects.files.delete') return Promise.resolve({ ok: true });
      return originalInvoke(channel, args);
    };
    vm.runInContext(`_projectDetailPid = 'project_a'; _projectDetailMeta = {
      project: { project_id: 'project_a' }, files: [{ type: 'file', name: 'cached.md', relPath: 'cached.md' }]
    }`, context);
    context.uiConfirm = vi.fn(async () => true);
    const loading = context.loadProjectDetail('project_a');
    await new Promise(resolve => setTimeout(resolve, 0));
    await context._deleteProjectFile('cached.md');
    expect(nodes['project-files-list'].innerHTML).not.toContain('cached.md');
    finishTree({ ok: true, tree: [{ type: 'file', name: 'cached.md', relPath: 'cached.md' }] });
    finishAutoTasks({ ok: true, tasks: [] });
    await loading;
    expect(vm.runInContext('_projectDetailMeta.files', context)).toEqual([]);
    expect(nodes['project-files-list'].innerHTML).not.toContain('cached.md');
    expect(nodes['project-instructions-read'].textContent).toBe('Saved local rules');
  });

  it('preserves automation content while its feature loads without a loading placeholder', async () => {
    const { context, nodes } = mountWithSlowSecondaryCard();
    const list = { innerHTML: 'Saved automation' };
    nodes['project-auto-list'] = list;
    let release!: () => void;
    context.loadRendererFeature = () => new Promise<void>(resolve => { release = resolve; });
    vm.runInContext('_projectDetailPid = "project_a"; _projectDetailActiveTab = "auto"; _projectDetailLoadSeq = 1;', context);
    const opening = context._ensureProjectAutoTabLoaded('project_a');
    expect(list.innerHTML).toBe('Saved automation');
    context.loadProjectAutoList = vi.fn(async () => { list.innerHTML = 'Updated automation'; });
    release();
    await opening;
    expect(list.innerHTML).toBe('Updated automation');
    expect(context.loadProjectAutoList).toHaveBeenCalledWith('project_a');
  });

it('does not paint memory returned after the account changes', async () => {
    const { context, finishAutoTasks } = mountWithSlowSecondaryCard();
    context.currentUserId = 'first';
    const invoke = context.window.orkas.invoke;
    let finishMemory!: (value: unknown) => void;
    context.window.orkas.invoke = (channel: string, args: any) => channel === 'memory.list'
      ? new Promise(resolve => { finishMemory = resolve; }) : invoke(channel, args);
    const opening = context.loadProjectDetail('project_a');
    finishAutoTasks({ ok: true, tasks: [] });
    await opening;
    context.currentUserId = 'second';
    finishMemory({ ok: true, entries: ['First account memory'] });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(vm.runInContext('_projectMemory', context)).toEqual([]);
  });

it('shows saved project rules and files while a secondary card is still loading', async () => {
    const { context, nodes, finishAutoTasks } = mountWithSlowSecondaryCard();
    const opening = context.loadProjectDetail('project_a') as Promise<void>;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(nodes['project-instructions-read'].textContent).toBe('Saved local rules');
    expect(nodes['project-instructions-empty'].hidden).toBe(true);
    expect(nodes['project-files-list'].innerHTML).toContain('cached.md');
    expect(nodes['project-agents-list'].innerHTML).toContain('Cached Writer');
    expect(vm.runInContext('_projectMemory', context)).toEqual(['Saved memory']);
    expect(nodes['project-detail-files-count'].textContent).toBe('1');

    finishAutoTasks({ ok: true, tasks: [] });
    await opening;
  });

it('does not show the previous project’s late local rules after navigation', async () => {
    const { context, nodes, finishAutoTasks, releaseInstructions } = mountWithSlowSecondaryCard({ delayInstructionsFor: 'project_a' });
    const first = context.loadProjectDetail('project_a') as Promise<void>;
    const second = context.loadProjectDetail('project_b') as Promise<void>;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nodes['project-instructions-read'].textContent).toBe('Other project rules');

    releaseInstructions();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nodes['project-instructions-read'].textContent).toBe('Other project rules');

    finishAutoTasks({ ok: true, tasks: [] });
    await Promise.all([first, second]);
  });
});
