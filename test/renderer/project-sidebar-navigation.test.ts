import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = (name: string) => readFileSync(join(__dirname, `../../src/renderer/modules/${name}.js`), 'utf8');

function mount({ cached = true, collapsed = false, previous = '' } = {}) {
  const scrolled: string[] = [];
  const nodes = new Map<string, any>();
  const deferred: Array<() => void> = [];
  const featureLoads: Array<() => void> = [];
  const ready: Array<() => void> = [];
  const pushes = new Map<string, (payload: any) => Promise<void>>();
  const projects = ['alpha', 'beta'].map(project_id => ({ project_id, name: project_id }));
  const node = () => ({
    innerHTML: '', textContent: '', hidden: false, dataset: {} as Record<string, string>,
    attributes: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(key: string, value: string) { this.attributes[key] = value; },
    getAttribute(key: string) { return this.attributes[key]; },
    querySelector: (_selector: string): any => null,
    querySelectorAll: (_selector: string): any[] => [],
    addEventListener() {},
  });
  for (const id of ['panel-project', 'panel-settings', 'new-chat-btn', 'agents-btn', 'skills-btn',
    'project-detail-title', 'project-detail-content', 'projects-list', 'projects-section-toggle']) {
    nodes.set(id, node());
  }
  const list = nodes.get('projects-list');
  const toggle = nodes.get('projects-section-toggle');
  toggle.attributes['aria-expanded'] = String(!collapsed);
  list.hidden = collapsed;
  toggle.click = vi.fn(() => {
    list.hidden = !list.hidden;
    toggle.attributes['aria-expanded'] = String(!list.hidden);
  });
  list.querySelector = (selector: string) => {
    if (selector !== '.project-row.active') return null;
    const id = /class="project-row active" data-pid="([^"]+)"/.exec(list.innerHTML)?.[1];
    return id ? { scrollIntoView: () => scrolled.push(id) } : null;
  };
  const loadProjectDetail = vi.fn();
  const context: any = {
    currentView: 'settings', currentCid: null, conversations: [], _projectDetailPid: previous, currentUserId: 'rename-user',
    _composerNavigationEpoch: 0, composerBindOwner() {}, _saveLastView() {},
    _bootLog: { info() {}, warn() {} }, createLogger: () => ({ info() {}, warn() {} }),
    _clearLazyFeatureError() {}, _showLazyFeatureError() {},
    setTimeout: () => 0, clearTimeout() {}, performance, t: String, escapeHtml: String,
    localStorage: { getItem: () => null, setItem() {} },
    document: {
      addEventListener(name: string, run: () => void) { if (name === 'DOMContentLoaded') ready.push(run); }, getElementById: (id: string) => nodes.get(id) || null,
      querySelector: () => null, querySelectorAll: () => [],
    },
    addEventListener() {},
    orkas: { invoke: vi.fn(async () => ({ ok: true, projects })), onPushEvent: (name: string, run: any) => pushes.set(name, run) },
    _deferSidebarNavWork: (_key: string, run: () => void) => deferred.push(run),
    loadRendererFeature: () => new Promise<void>(resolve => featureLoads.push(resolve)),
    loadProjectDetail,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source('projects'), context);
  const boot = source('boot');
  vm.runInContext(boot.slice(boot.indexOf('function _loadViewFeature('), boot.indexOf('function _lazyFeaturePanel(')), context);
  vm.runInContext(boot.slice(boot.indexOf('function setView(')), context);
  if (cached) vm.runInContext(`_projectsCache = ${JSON.stringify(projects)}`, context);
  const selected = () => [...list.innerHTML.matchAll(/class="project-row active" data-pid="([^"]+)"/g)]
    .map(match => match[1]);
  ready[0]();
  return { context, pushes, nodes, projects, list, toggle, scrolled, selected, deferred, featureLoads, loadProjectDetail };
}

describe('project navigation follows the destination in the sidebar', () => {
  it('updates the open detail immediately after a sidebar rename, preserving drafts while the list refresh waits', async () => {
    const h = mount({ previous: 'alpha' });
    h.context.currentView = 'project';
    h.context._projectDetailMeta = {
      project: { project_id: 'alpha', name: 'alpha' },
      draft: 'Keep editing',
    };
    const draft = { value: 'Unsubmitted title', selectionStart: 3 };
    h.nodes.set('project-detail-title-input', draft);
    h.nodes.get('project-detail-title').textContent = 'alpha';
    h.nodes.get('project-detail-content').innerHTML = 'Unsaved workspace';
    const renamed = { ...h.context._projectDetailMeta.project, name: 'Release readiness' };
    let releaseList!: (value: any) => void;
    const listResult = new Promise(resolve => { releaseList = resolve; });
    h.context.orkas.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'projects.rename') return { ok: true, project: renamed };
      if (channel === 'projects.list') return listResult;
      throw new Error(`Unexpected channel: ${channel}`);
    });
    h.context._startProjectInlineRename('alpha');
    const listeners = new Map<string, (...args: any[]) => any>();
    h.context._bindInlineRenameInput({
      dataset: { renamePid: 'alpha' }, value: 'Release readiness',
      addEventListener: (name: string, listener: any) => listeners.set(name, listener),
    });
    const rename = listeners.get('blur')!();
    await new Promise(resolve => setImmediate(resolve));

    // Saved identity is visible before an unrelated list read finishes.
    expect(h.nodes.get('project-detail-title').textContent).toBe('Release readiness');
    expect(h.context._projectDetailMeta.project.name).toBe('Release readiness');
    expect(h.list.innerHTML).toContain('Release readiness');
    expect(h.context._projectDetailMeta.draft).toBe('Keep editing');
    expect(h.nodes.get('project-detail-content').innerHTML).toBe('Unsaved workspace');
    expect(draft).toEqual({ value: 'Unsubmitted title', selectionStart: 3 });
    expect(h.loadProjectDetail).not.toHaveBeenCalled();
    releaseList({ ok: true, projects: [renamed, h.projects[1]] });
    await rename;
    expect(h.nodes.get('project-detail-title').textContent).toBe('Release readiness');
  });

  it.each([true, false])('preserves the displayed project on another project rename or a rejected rename (success=%s)', async success => {
    const openProject = success ? 'beta' : 'alpha';
    const h = mount({ previous: openProject });
    h.context._projectDetailMeta = { project: { project_id: openProject, name: openProject } };
    h.nodes.get('project-detail-title').textContent = openProject;
    h.context.orkas.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'projects.rename') return success
        ? { ok: true, project: { project_id: 'alpha', name: 'Renamed alpha' } }
        : { ok: false, error: 'name_dup' };
      return { ok: true, projects: [{ project_id: 'alpha', name: 'Renamed alpha' }, h.projects[1]] };
    });
    h.context._startProjectInlineRename('alpha');
    const listeners = new Map<string, (...args: any[]) => any>();
    h.context._bindInlineRenameInput({
      dataset: { renamePid: 'alpha' }, value: 'Renamed alpha',
      addEventListener: (name: string, listener: any) => listeners.set(name, listener),
    });
    await listeners.get('blur')!();
    expect(h.nodes.get('project-detail-title').textContent).toBe(openProject);
    expect(h.context._projectDetailMeta.project).toEqual({ project_id: openProject, name: openProject });
    if (!success) {
      expect(vm.runInContext('_projectsCache[0].name', h.context)).toBe('alpha');
      expect(h.context._renderProjectRow(h.projects[0], [])).toContain('project.name_dup_inline');
    }
  });


  it('reflects a host rename in the sidebar and open title without replacing drafts or accepting another account event', async () => {
    const h = mount({ previous: 'alpha' });
    h.context._projectDetailMeta = { project: { project_id: 'alpha', name: 'alpha' }, draft: 'Keep editing' };
    const draft = { value: 'Unsubmitted title', selectionStart: 3 };
    h.nodes.set('project-detail-title-input', draft);
    h.nodes.get('project-detail-content').innerHTML = 'Unsaved workspace';
    h.projects[0].name = 'Release readiness';
    expect(h.pushes.has('projects:renamed')).toBe(true);
    await h.pushes.get('projects:renamed')!({ userId: 'rename-user', projectId: 'alpha', name: 'Release readiness' });
    expect(h.list.innerHTML).toContain('Release readiness');
    expect(h.nodes.get('project-detail-title').textContent).toBe('Release readiness');
    expect(h.context._projectDetailMeta.project.name).toBe('Release readiness');
    expect(h.context._projectDetailMeta.draft).toBe('Keep editing');
    expect(h.nodes.get('project-detail-content').innerHTML).toBe('Unsaved workspace');
    expect(draft).toEqual({ value: 'Unsubmitted title', selectionStart: 3 });
    h.context.orkas.invoke.mockClear();
    await h.pushes.get('projects:renamed')!({ userId: 'other-user', projectId: 'alpha', name: 'Foreign name' });
    expect(h.context.orkas.invoke).not.toHaveBeenCalled();
    expect(h.nodes.get('project-detail-title').textContent).toBe('Release readiness');
  });
  it.each(['', 'alpha'])('selects and reveals the target before detail loading, with previous detail %j', previous => {
    const h = mount({ previous, collapsed: true });
    h.context.setView('project', 'beta');
    expect(h.selected()).toEqual(['beta']);
    expect(h.list.hidden).toBe(false);
    expect(h.scrolled).toEqual(['beta']);
    expect(h.loadProjectDetail).not.toHaveBeenCalled();

    // Manual collapse and scrolling after entry win over background renders.
    h.toggle.click();
    h.context.renderProjectsSection();
    expect(h.list.hidden).toBe(true);
    expect(h.scrolled).toEqual(['beta']);
    h.context.setView('settings');
    expect(h.selected()).toEqual([]);
  });

  it('reveals a cold-start target once the project list arrives', async () => {
    const h = mount({ cached: false, collapsed: true });
    h.context.setView('project', 'beta');
    expect(h.scrolled).toEqual([]);
    await h.context.loadProjects();
    expect(h.selected()).toEqual(['beta']);
    expect(h.list.hidden).toBe(false);
    expect(h.scrolled).toEqual(['beta']);
    await h.context.loadProjects(true);
    expect(h.scrolled).toEqual(['beta']);
  });

  it('does not reveal a late project list after navigating away', async () => {
    const h = mount({ cached: false, collapsed: true });
    h.context.setView('project', 'beta');
    h.context.setView('settings');
    await h.context.loadProjects();
    expect(h.selected()).toEqual([]);
    expect(h.list.hidden).toBe(true);
    expect(h.scrolled).toEqual([]);
  });

  it('ignores the old deferred detail when switching projects during feature loading', async () => {
    const h = mount();
    h.context.setView('project', 'alpha');
    h.deferred.shift()!();
    h.context.setView('project', 'beta');
    h.deferred.shift()!();
    expect(h.selected()).toEqual(['beta']);
    h.featureLoads[1]();
    await new Promise(resolve => setImmediate(resolve));
    h.featureLoads[0]();
    await new Promise(resolve => setImmediate(resolve));
    expect(h.loadProjectDetail.mock.calls.map(([pid]) => pid)).toEqual(['beta']);
    expect(h.selected()).toEqual(['beta']);
    expect(h.scrolled).toEqual(['alpha', 'beta']);
  });
});
