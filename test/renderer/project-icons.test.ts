import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Projects keep the same visual identity while users switch pages or choose
// a destination. Actual directory entries remain folders, even in a shared Library.
const projects = [
  { project_id: 'private', name: 'Private' },
  { project_id: 'shared', name: 'Shared' },
  { project_id: 'ended', name: 'Ended' },
  { project_id: 'pending', name: 'Pending' },
];
const expected = ['folder', 'folder', 'folder', 'folder'];

function harness(...modules: string[]) {
  const overlays: any[] = [];
  const selections: any[] = [];
  const element = (): any => {
    const node: any = { children: [], dataset: {}, style: {}, className: '', innerHTML: '', attributes: {}, handlers: {},
      appendChild(child: any) { this.children.push(child); return child; },
      setAttribute(key: string, value: string) { this.attributes[key] = value; },
      addEventListener(key: string, fn: any) { this.handlers[key] = fn; },
      querySelector(selector: string) { return this.parts[selector] ||= element(); },
      querySelectorAll() { return []; }, parts: {}, remove() {}, focus() {},
      classList: { add() {}, toggle() {}, remove() {}, contains() { return false; } },
    };
    return node;
  };
  const host = element();
  const context: any = {
    currentUserId: 'me', currentView: 'todos', setTimeout: () => 0, clearTimeout() {},
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: String, escapeHtml: String, addEventListener() {},
    localStorage: { getItem: () => null },
    _uiKeepDialogFocus: () => () => {}, _uiRestoreDialogFocus() {},
    _uiIsTopDialogOverlay: () => true,
    document: { readyState: 'loading', addEventListener() {}, removeEventListener() {},
      createElement: element, querySelectorAll: () => [], querySelector: () => null,
      getElementById: (id: string) => id === 'contexts-project-select' ? host : null,
      body: { appendChild: (overlay: any) => overlays.push(overlay), contains: () => true },
    },
    _aiSelectMount(_host: any, config: any) {
      selections.push(config);
      return { state: {}, close() {}, setValue() {}, setAriaLabel() {}, setOptions(options: any) { selections.push({ options }); } };
    },
    orkas: { invoke: async (channel: string) => channel === 'projects.list' ? { projects } : { tree: [] } },
  };
  context.window = context;
  vm.createContext(context);
  for (const module of ['icons', ...modules]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, `../../src/renderer/modules/${module}.js`), 'utf8'), context);
  }
  return { context, overlays, selections };
}

function icon(html: string) {
  return /\bis-(folder-open|folder|globe)\b/.exec(html)?.[1];
}

describe('project identity across PC pages', () => {
  it('keeps local project icons in todo scope chips, driver buttons and card links', () => {
    const { context } = harness('project-detail', 'todos');
    const groups = projects.map(project => ({ project, tasks: [], agents: [] }));
    expect(context._renderGlobalTodoScopeSwitcher(groups).children.map((node: any) => icon(node.innerHTML))).toEqual(expected);
    expect(groups.map(group => icon(context._renderGlobalTodoDriverToggle(group, true).innerHTML))).toEqual(expected);
    const cards = projects.map(project => context._renderTodoCard({ id: 'task', status: 'todo', assignee_uid: 'me' }, {
      pid: project.project_id, project, showProject: true, agents: [], members: [],
    }));
    expect(cards.map(card => icon(card.children.find((node: any) => node.className === 'todo-card-meta')
      .children.find((node: any) => node.className === 'todo-card-project').innerHTML))).toEqual(expected);
  });

  it('refreshes the Library scope selector after project refresh and keeps global scope a folder', () => {
    const { context, selections } = harness('contexts');
    context._renderCtxScopeSelector(projects);
    expect(Object.fromEntries(selections.at(-1).options.map((option: any) => [option.value, option.iconName])))
      .toEqual({ '': 'folder', private: 'folder', shared: 'folder', ended: 'folder', pending: 'folder' });
    context._renderCtxScopeSelector(projects.map(project => ({ ...project })));
    expect(selections.at(-1).options.map((option: any) => option.iconName)).toEqual(Array(5).fill('folder'));
  });

  it('shows shared identity when filing a conversation under a project', async () => {
    const { context, overlays } = harness('conversation-to-project');
    const choice = context._openConversationProjectPicker(projects);
    const overlay = overlays[0];
    const rows = [...overlay.innerHTML.matchAll(/data-project-id="[^"]+">([\s\S]*?)<\/button>/g)];
    expect(rows.map(row => icon(row[1]))).toEqual(expected);
    overlay.querySelector('[data-act="cancel"]').handlers.click();
    await expect(choice).resolves.toBeNull();
  });

  it('distinguishes shared transfer destinations while retaining directory folder icons', async () => {
    const { context, overlays, selections } = harness('library-transfer');
    const dialog = context.LibraryTransfer.open({ source: { scope: 'project', projectId: 'shared' }, paths: ['brief.md'] });
    // The picker waits for project metadata before it mounts.
    await new Promise(resolve => setImmediate(resolve));
    expect(selections[0].options.map((option: any) => option.iconName)).toEqual(['folder', ...expected]);
    const folders = overlays[0].querySelector('[data-transfer-folders]').innerHTML;
    expect(icon(folders)).toBe('folder-open');
    expect(folders).not.toContain('is-globe');
    overlays[0].querySelector('[data-transfer-cancel]').handlers.click();
    await dialog;
  });
});
