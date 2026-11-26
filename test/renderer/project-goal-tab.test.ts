/**
 * Project goal tab (Common/docs/plans/commander-project-continuity.md §3.6).
 *
 * What only this layer decides: which Context tab a project opens on, that a
 * slow answer for another project never paints over the open one, that the
 * tab stays hidden when unavailable, and that goal text renders as text.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/project-goal.js'), 'utf8');

type Stub = Record<string, any>;

function element(): Stub {
  const classes = new Set<string>();
  const attrs: Record<string, string> = {};
  const listeners: Record<string, Array<(event: any) => void>> = {};
  return {
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    title: '',
    dataset: {},
    attrs,
    listeners,
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
    },
    setAttribute(name: string, value: string) { attrs[name] = value; },
    removeAttribute(name: string) { delete attrs[name]; },
    addEventListener(name: string, handler: (event: any) => void) { (listeners[name] ||= []).push(handler); },
    focus() {},
    getBoundingClientRect: () => ({ right: 0, bottom: 0 }),
  };
}

const IDS = [
  'project-goal-tab', 'project-goal-head', 'project-goal-status', 'project-goal-body',
  'project-goal-text', 'project-goal-criteria', 'project-goal-empty', 'project-goal-setup-btn', 'project-goal-edit-btn',
  'project-goal-menu-btn', 'project-goal-feedback', 'project-goal-modal', 'project-goal-input', 'project-goal-criteria-editor',
  'project-goal-criteria-add', 'project-goal-cancel-btn', 'project-goal-save-btn', 'project-goal-counter',
];

interface Answer { goal?: unknown; enabled?: boolean }

function mount(answers: Record<string, Answer>) {
  const elements: Record<string, Stub> = Object.fromEntries(IDS.map((id) => [id, element()]));
  const invoked: Array<{ channel: string; payload: any }> = [];
  const pending: Array<() => void> = [];
  let hold = false;
  const doc = { visibilityState: 'visible', focused: true };
  const context = vm.createContext({
    console,
    currentUserId: 'account_a',
    currentView: 'project',
    _projectDetailPid: 'p_a',
    _projectDetailMeta: { project: { project_id: 'p_a' } },
    _projectSideActiveTabs: { context: 'instructions', resources: 'agents' },
    _syncProjectSideTabState: () => {},
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    getLang: () => 'en',
    getLocaleMeta: () => ({ intlLocale: 'en' }),
    escapeHtml: (value: string) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
    uiIconHtml: (name: string) => `[${name}]`,
    document: {
      get visibilityState() { return doc.visibilityState; },
      hasFocus: () => doc.focused,
      addEventListener() {},
      getElementById: (id: string) => elements[id] || null,
      querySelectorAll: () => [],
    },
    window: {
      addEventListener() {},
      orkas: {
        onPushEvent() {},
        invoke: async (channel: string, payload: any) => {
          invoked.push({ channel, payload });
          if (hold) await new Promise<void>((resolve) => pending.push(resolve));
          const answer = answers[payload?.projectId] || {};
          if (channel === 'projects.goal.get') {
            if (answer.enabled === false) return { ok: true, enabled: false };
            return { ok: true, shared: false, goal: null, ...(answer.goal as object) };
          }
          return { ok: true };
        },
      },
    },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(source, context, { filename: 'project-goal.js' });
  const run = (code: string) => vm.runInContext(code, context);
  return {
    elements, invoked, doc, run, context,
    hold: (on: boolean) => { hold = on; },
    release: () => { while (pending.length) pending.shift()!(); },
  };
}

const GOAL = { goal: '把店铺月销做到 10 万', success_criteria: ['月销连续两个月不低于 10 万'], status: 'active', updated_at: '', achieved_at: null };

describe('project goal tab', () => {
  it('keeps Goal out of the project navigation while availability loads and after it is disabled', async () => {
    const view = mount({ p_a: { enabled: false } });
    const goalTab = view.elements['project-goal-tab'];
    view.hold(true);
    const loading = view.run('loadProjectGoal("p_a", { chooseTab: true })');
    expect(goalTab.hidden).toBe(true);
    view.hold(false);
    view.release();
    await loading;
    expect(goalTab.hidden).toBe(true);
    expect(view.elements['project-goal-setup-btn'].disabled).toBe(true);
    view.run('_projectDetailPid = "p_b"');
    await view.run('loadProjectGoal("p_b", { chooseTab: true })');
    expect(goalTab.hidden).toBe(true);
    expect(view.run('_projectSideActiveTabs.context')).toBe('instructions');
    expect(view.invoked.map((call) => call.payload.projectId)).toEqual(['p_a']);
  });

  it('never applies a pending clear confirmation to another account', async () => {
    const view = mount({ p_a: { goal: { goal: GOAL } } });
    await view.run('loadProjectGoal("p_a")');
    view.run('globalThis.showContextMenu = (_event, items) => { globalThis.menuItems = items; };'
      + 'globalThis.uiConfirm = () => new Promise(resolve => { globalThis.confirmClear = resolve; });'
      + '_openProjectGoalMenu(document.getElementById("project-goal-menu-btn"));');
    const pending = view.run('menuItems[1].onClick()');
    view.run('currentUserId = "account_b"; confirmClear(true)');
    await pending;
    expect(view.invoked.filter((call) => call.channel === 'projects.goal.set')).toEqual([]);
  });

  it('opens on Goal when the project has a goal, on Rules otherwise, and keeps a tab the user picked', async () => {
    const view = mount({ p_a: { goal: { goal: GOAL } }, p_b: {}, p_c: { goal: { goal: { ...GOAL, status: 'achieved' } } } });
    await view.run('loadProjectGoal("p_a", { chooseTab: true })');
    expect(view.run('_projectSideActiveTabs.context')).toBe('goal');
    expect(view.elements['project-goal-text'].textContent).toBe('把店铺月销做到 10 万');
    expect(view.elements['project-goal-status'].textContent).toBe('project.goal.status_active');
    expect(view.elements['project-goal-criteria'].innerHTML).toBe('<li>月销连续两个月不低于 10 万</li>');
    expect(view.elements['project-goal-empty'].hidden).toBe(true);

    view.run('_projectDetailPid = "p_b"');
    await view.run('loadProjectGoal("p_b", { chooseTab: true })');
    expect(view.run('_projectSideActiveTabs.context')).toBe('instructions');
    // No goal is ordinary: only the quiet setup entry shows.
    expect(view.elements['project-goal-head'].hidden).toBe(true);
    expect(view.elements['project-goal-empty'].hidden).toBe(false);

    view.run('_projectDetailPid = "p_c"');
    await view.run('loadProjectGoal("p_c", { chooseTab: true })');
    expect(view.run('_projectSideActiveTabs.context')).toBe('goal');
    expect(view.elements['project-goal-status'].textContent).toBe('project.goal.status_achieved');
    // A background refresh never moves the tab.
    view.run('_projectSideActiveTabs.context = "memory"');
    await view.run('loadProjectGoal("p_c")');
    expect(view.run('_projectSideActiveTabs.context')).toBe('memory');

    // Once the user picks a tab, opening another project keeps it.
    view.run('_projectSideActiveTabs.context = "memory"; projectGoalNoteTabChoice()');
    view.run('_projectDetailPid = "p_a"');
    await view.run('loadProjectGoal("p_a", { chooseTab: true })');
    expect(view.run('_projectSideActiveTabs.context')).toBe('memory');
  });

  it('renders the goal and its criteria as text and hides the tab of a shared project', async () => {
    const view = mount({
      p_a: { goal: { goal: { ...GOAL, goal: '<b>把店铺月销做到 10 万</b>', success_criteria: ['<i>月销</i>'] } } },
      p_s: { goal: { shared: true } },
    });
    await view.run('loadProjectGoal("p_a", { chooseTab: true })');
    expect(view.elements['project-goal-text'].textContent).toBe('<b>把店铺月销做到 10 万</b>');
    expect(view.elements['project-goal-criteria'].innerHTML).toBe('<li>&lt;i&gt;月销&lt;/i&gt;</li>');
    expect(view.elements['project-goal-tab'].hidden).toBe(false);

    view.run('_projectSideActiveTabs.context = "goal"; _projectDetailPid = "p_s"');
    await view.run('loadProjectGoal("p_s", { chooseTab: true })');
    expect(view.elements['project-goal-tab'].hidden).toBe(true);
    expect(view.run('_projectSideActiveTabs.context')).toBe('instructions');
  });

  it('never paints a slow answer for another project over the open one', async () => {
    const view = mount({ p_a: { goal: { goal: GOAL } }, p_b: {} });
    view.hold(true);
    const slow = view.run('loadProjectGoal("p_a", { chooseTab: true })');
    view.run('_projectDetailPid = "p_b"');
    view.hold(false);
    await view.run('loadProjectGoal("p_b", { chooseTab: true })');
    view.release();
    await slow;
    expect(view.elements['project-goal-text'].textContent).toBe('');
    expect(view.elements['project-goal-empty'].hidden).toBe(false);
    expect(view.run('_projectGoalState.pid')).toBe('p_b');
  });
});
