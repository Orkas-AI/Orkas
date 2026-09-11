import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type Task = { id: string; project_id?: string | null; enabled?: boolean };
type Project = { project_id: string; name: string };
type Group = { projectId: string; name: string; tasks: Task[] };
const { _autoGroupTasks: groupTasks } = require('../../src/renderer/modules/auto.js') as {
  _autoGroupTasks: (tasks: readonly Task[], projects: readonly Project[]) => Group[];
};

/** The Auto tab against the real list renderer, with the sidebar project cache
 *  and view state controlled by the test. Rows are stubbed: the cases assert
 *  which group sections the user sees and what the sidebar was asked to do. */
function loadAutoTab(options: { projects: Project[] | null; view: string }) {
  const sections: Array<{ projectId: string; name: string }> = [];
  const list: any = {
    clears: 0,
    querySelectorAll: () => [],
    appendChild(section: any) {
      sections.push({ projectId: section.dataset.projectId, name: /auto-group-name">([^<]*)</.exec(section.innerHTML)?.[1] || '' });
    },
  };
  Object.defineProperty(list, 'innerHTML', { set() { list.clears += 1; sections.length = 0; }, get() { return ''; } });
  const elements: Record<string, any> = {
    'auto-list': list,
    'auto-empty': { style: {} },
    'auto-header-count': { textContent: '' },
  };
  const sidebarLoads: unknown[] = [];
  const context: any = {
    console, setTimeout, clearTimeout, Map, Set, Array, Promise, Date, Math, JSON, String, Number, Object, RegExp,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value ?? ''),
    uiAlert() {},
    currentView: options.view,
    _projectsCache: options.projects,
    loadProjects: async (force?: boolean) => {
      sidebarLoads.push(force);
      context._projectsCache = [{ project_id: 'a', name: 'Loaded later' }];
      return context._projectsCache;
    },
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById: (id: string) => elements[id] || null,
      querySelectorAll: () => [],
      createElement: () => {
        const el: any = { className: '', dataset: {}, innerHTML: '', appendChild() {} };
        el.querySelector = (selector: string) => (selector === '.auto-group-list'
          ? { id: '', hidden: false, innerHTML: '', appendChild() {} }
          : { setAttribute() {}, getAttribute: () => 'true', addEventListener() {}, innerHTML: '' });
        return el;
      },
    },
    window: {
      addEventListener() {},
      orkas: { invoke: async () => ({ ok: true, tasks: [{ id: 't1', project_id: 'a' }, { id: 't2' }] }) },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/auto.js'), 'utf8'), context, { filename: 'auto.js' });
  // Device, sync notice, per-task counts and row markup are owned by other cases.
  vm.runInContext(`
    _ensureAutoCurrentDevice = async () => {};
    _refreshAutoSyncNotice = async () => {};
    _autoLoadTaskConversationCounts = async () => {};
    _closeAutoRowMenu = () => {};
    _autoRenderRow = (task) => ({ task });
  `, context);
  return {
    context,
    sidebarLoads,
    sectionNames: () => sections.map((section) => section.name),
    clears: () => list.clears,
  };
}

describe('automation tab and the sidebar project cache', () => {
  it('groups from the warm project cache without asking the sidebar to repaint', async () => {
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }], view: 'auto' });

    await tab.context.loadAutoList(true);

    expect(tab.sidebarLoads).toEqual([]);
    expect(tab.sectionNames()).toEqual(['auto.global', 'Alpha']);
  });

  it('loads projects through the sidebar once when nothing is cached yet', async () => {
    const tab = loadAutoTab({ projects: null, view: 'auto' });

    await tab.context.loadAutoList(true);

    expect(tab.sidebarLoads).toEqual([undefined]);
    expect(tab.sectionNames()).toEqual(['auto.global', 'Loaded later']);
  });

  it('defers a projects-driven rebuild while the tab is hidden and paints it on the next visit', async () => {
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }], view: 'auto' });
    await tab.context.loadAutoList(true);
    const paintsBefore = tab.clears();

    tab.context.currentView = 'project';
    tab.context._projectsCache[0].name = 'Renamed';
    tab.context.window.refreshAutoProjectGroups();
    expect(tab.clears()).toBe(paintsBefore);
    expect(tab.sectionNames()).toEqual(['auto.global', 'Alpha']);

    tab.context.currentView = 'auto';
    await tab.context.loadAutoList(false);
    expect(tab.clears()).toBe(paintsBefore + 1);
    expect(tab.sectionNames()).toEqual(['auto.global', 'Renamed']);
  });

  it('relabels a group at once when a project is renamed while the tab is visible', async () => {
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }], view: 'auto' });
    await tab.context.loadAutoList(true);

    tab.context._projectsCache[0].name = 'Renamed';
    tab.context.window.refreshAutoProjectGroups();

    expect(tab.sectionNames()).toEqual(['auto.global', 'Renamed']);
  });
});

describe('automation project groups', () => {
  it('puts global tasks first and follows sidebar order without reordering tasks inside a project', () => {
    // The sidebar is the ordering authority, even if its input is not an
    // alphabetic order guessed independently by the automation renderer.
    const projects = Object.freeze([
      { project_id: 'z', name: 'Zulu' },
      { project_id: 'a', name: 'Alpha' },
      { project_id: 'empty', name: 'No automations' },
    ]);
    const tasks = Object.freeze([
      { id: 'a1', project_id: 'a', enabled: false },
      { id: 'global1' },
      { id: 'z2', project_id: 'z' },
      { id: 'global2', project_id: null },
      { id: 'z1', project_id: 'z' },
      { id: 'global3', project_id: '' },
    ]);
    const groups = groupTasks(tasks, projects);
    expect(groups.map(group => group.projectId)).toEqual(['', 'z', 'a']);
    expect(groups.map(group => group.tasks.map(task => task.id))).toEqual([
      ['global1', 'global2', 'global3'], ['z2', 'z1'], ['a1'],
    ]);
    expect(groups[1].name).toBe('Zulu');
    expect(groups[2].tasks[0].enabled).toBe(false);
    expect(groups[1].tasks[0]).toBe(tasks[2]);
  });

  it('keeps unresolved project tasks distinct and moves them into sidebar order when metadata arrives', () => {
    const tasks = [{ id: 'unknown', project_id: 'later' }, { id: 'known', project_id: 'ready' }];
    const partial = groupTasks(tasks, [{ project_id: 'ready', name: 'Project 10' }]);
    expect(partial.map(group => group.projectId)).toEqual(['', 'ready', 'later']);
    expect(partial[0].tasks).toEqual([]);
    expect(partial[2].tasks).toEqual([tasks[0]]);
    const complete = groupTasks(tasks, [
      { project_id: 'later', name: 'Project 2' }, { project_id: 'ready', name: 'Project 10' },
    ]);
    expect(complete.map(group => group.name)).toEqual(['', 'Project 2', 'Project 10']);
    expect(complete.flatMap(group => group.tasks.map(task => task.id))).toEqual(['unknown', 'known']);
    expect(groupTasks([], [])).toEqual([{ projectId: '', name: '', tasks: [] }]);
  });
});
