import { describe, it, expect } from 'vitest';

const {
  STORAGE_KEY,
  readCollapsedState,
  initSidebarSections,
  trackSidebarSectionToggle,
} = require('../../src/renderer/modules/sidebar-sections.js');

function createClassList() {
  const values = new Set<string>();
  return {
    toggle(name: string, enabled: boolean) {
      if (enabled) values.add(name);
      else values.delete(name);
    },
    contains(name: string) {
      return values.has(name);
    },
  };
}

function createElement() {
  const listeners: Record<string, Function> = {};
  const attributes: Record<string, string> = {};
  return {
    hidden: false,
    dataset: {} as Record<string, string>,
    classList: createClassList(),
    addEventListener(type: string, listener: Function) {
      listeners[type] = listener;
    },
    click() {
      listeners.click?.();
    },
    setAttribute(name: string, value: string) {
      attributes[name] = value;
    },
    getAttribute(name: string) {
      return attributes[name];
    },
  };
}

function createHarness(initialState: unknown = {}) {
  const projectsSection = createElement();
  const tasksSection = createElement();
  const projectsToggle = createElement();
  const tasksToggle = createElement();
  const projectsBody = createElement();
  const tasksBody = createElement();
  const values = new Map<string, string>([
    [STORAGE_KEY, JSON.stringify(initialState)],
  ]);
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
  const byId: Record<string, any> = {
    'projects-section-toggle': projectsToggle,
    'tasks-section-toggle': tasksToggle,
    'projects-list': projectsBody,
    'conversation-list': tasksBody,
  };
  const document = {
    getElementById(id: string) {
      return byId[id] ?? null;
    },
    querySelector(selector: string) {
      if (selector === '.sidebar-projects-section') return projectsSection;
      if (selector === '.sidebar-conversations-section') return tasksSection;
      return null;
    },
  };
  const translate = (key: string, params?: { section?: string }) => {
    if (key === 'sidebar.projects') return 'Projects';
    if (key === 'sidebar.conversations') return 'Tasks';
    if (key === 'sidebar.section_collapse') return `Collapse ${params?.section}`;
    if (key === 'sidebar.section_expand') return `Expand ${params?.section}`;
    return key;
  };
  return {
    document,
    storage,
    values,
    projectsSection,
    tasksSection,
    projectsToggle,
    tasksToggle,
    projectsBody,
    tasksBody,
    translate,
  };
}

describe('sidebar top-level section collapse', () => {
  it('restores Projects and Tasks independently with accessible toggle state', () => {
    const harness = createHarness({ projects: true, tasks: false });

    initSidebarSections(harness.document, harness.storage, harness.translate);

    expect(harness.projectsBody.hidden).toBe(true);
    expect(harness.tasksBody.hidden).toBe(false);
    expect(harness.projectsSection.classList.contains('is-collapsed')).toBe(true);
    expect(harness.tasksSection.classList.contains('is-collapsed')).toBe(false);
    expect(harness.projectsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(harness.projectsToggle.getAttribute('aria-label')).toBe('Expand Projects');
    expect(harness.tasksToggle.getAttribute('aria-expanded')).toBe('true');
    expect(harness.tasksToggle.getAttribute('aria-label')).toBe('Collapse Tasks');
  });

  it('persists a toggle without changing the other section', () => {
    const harness = createHarness({ projects: false, tasks: true });
    initSidebarSections(harness.document, harness.storage, harness.translate);

    harness.projectsToggle.click();

    expect(harness.projectsBody.hidden).toBe(true);
    expect(harness.tasksBody.hidden).toBe(true);
    expect(JSON.parse(harness.values.get(STORAGE_KEY) || '{}')).toEqual({
      projects: true,
      tasks: true,
    });
  });

  it('reports a section reopen so its list can reset to the first page', () => {
    const harness = createHarness({ projects: false, tasks: true });
    const toggles: Array<{ name: string; collapsed: boolean }> = [];
    initSidebarSections(harness.document, harness.storage, harness.translate, (detail: any) => {
      toggles.push(detail);
    });

    harness.tasksToggle.click();

    expect(toggles).toEqual([{ name: 'tasks', collapsed: false }]);
    expect(harness.tasksBody.hidden).toBe(false);
  });

  it('tracks the resulting open or close state with a bounded section name', () => {
    const calls: unknown[][] = [];
    const monitor = { click: (...args: unknown[]) => calls.push(args) };

    trackSidebarSectionToggle({ name: 'projects', collapsed: true }, monitor);
    trackSidebarSectionToggle({ name: 'tasks', collapsed: false }, monitor);

    expect(calls).toEqual([
      ['sidebar_section_toggle', { section: 'projects', control_state: 'close' }],
      ['sidebar_section_toggle', { section: 'tasks', control_state: 'open' }],
    ]);
  });

  it('treats corrupt or non-boolean stored values as expanded', () => {
    const storage = { getItem: () => '{bad json', setItem() {} };
    expect(readCollapsedState(storage)).toEqual({});

    const harness = createHarness({ projects: 'true', tasks: 1 });
    initSidebarSections(harness.document, harness.storage, harness.translate);

    expect(harness.projectsBody.hidden).toBe(false);
    expect(harness.tasksBody.hidden).toBe(false);
  });
});
