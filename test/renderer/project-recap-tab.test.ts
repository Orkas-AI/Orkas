/**
 * The project page's What's new tab
 * (Common/docs/plans/commander-project-continuity.md §3.3, §3.6).
 *
 * What only this layer decides: the tab is present only with news and counts
 * it, lists P15 rows with titles and notes as text, asks for the tab on a new
 * visit with news unless the navigation asked for another tab, never on a
 * refresh, counts as seen only while the tab is open in front of the user,
 * keeps one visit's list stable across refreshes, reports one telemetry row
 * per visit, looks again once a pending second is over, and never paints
 * another project's answer over the open one.
 * Which tab then shows (and which comes back) is the project page's tab
 * switcher, covered by projects_e2e_goal_tab.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/project-recap.js'), 'utf8');

type Stub = Record<string, any>;

function element(): Stub {
  const listeners: Record<string, Array<(event: any) => void>> = {};
  return {
    hidden: false,
    innerHTML: '',
    textContent: '',
    dataset: {},
    listeners,
    addEventListener(name: string, handler: (event: any) => void) { (listeners[name] ||= []).push(handler); },
  };
}

const IDS = ['project-recap-tab', 'project-recap-count', 'project-recap-list'];

function mount(answers: Record<string, unknown>) {
  const elements: Record<string, Stub> = Object.fromEntries(IDS.map((id) => [id, element()]));
  const invoked: Array<{ channel: string; payload: any }> = [];
  const pending: Array<() => void> = [];
  const synced: string[] = [];
  let hold = false;
  const doc = { visibilityState: 'visible', focused: true };
  const context: Record<string, any> = {
    console,
    currentUserId: 'account_a',
    currentView: 'project',
    _projectDetailPid: 'p_a',
    _projectDetailActiveTab: 'tasks',
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    getLang: () => 'en',
    getLocaleMeta: () => ({ intlLocale: 'en' }),
    escapeHtml: (value: string) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${Object.values(params).join(',')}` : key),
    uiIconHtml: (name: string) => `[${name}]`,
    document: {
      get visibilityState() { return doc.visibilityState; },
      hasFocus: () => doc.focused,
      addEventListener() {},
      getElementById: (id: string) => elements[id] || null,
    },
    window: {
      addEventListener() {},
      orkas: {
        onPushEvent() {},
        invoke: async (channel: string, payload: any) => {
          invoked.push({ channel, payload });
          if (channel === 'projects.recap.markSeen') return { ok: true, seen: true };
          if (hold) await new Promise<void>((resolve) => pending.push(resolve));
          const answer = answers[payload?.projectId];
          return typeof answer === 'function' ? answer(payload) : { ok: true, shared: false, total: 0, lines: [], ...(answer as object) };
        },
      },
    },
    setTimeout,
    clearTimeout,
  };
  // The project page's tab switcher: opening on the news selects the tab, and
  // showing the active panel acknowledges.
  const opened: string[] = [];
  context._openProjectDetailNewsTab = () => {
    opened.push(context._projectDetailPid);
    context._projectDetailActiveTab = 'recap';
  };
  context._syncProjectDetailTabState = () => {
    synced.push(context._projectDetailActiveTab);
    vm.runInContext('acknowledgeProjectRecapIfVisible()', context);
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'project-recap.js' });
  const run = (code: string) => vm.runInContext(code, context);
  return {
    elements, invoked, doc, run, synced, opened,
    hold: (on: boolean) => { hold = on; },
    release: () => { while (pending.length) pending.shift()!(); },
    marks: () => invoked.filter((call) => call.channel === 'projects.recap.markSeen').map((call) => call.payload),
    reads: () => invoked.filter((call) => call.channel === 'projects.recap.get').map((call) => call.payload),
  };
}

const NEWS = {
  since: '2026-11-09T16:00:00',
  total: 6,
  computed_at: '2026-11-16T16:00:00',
  counts: { stuck: 1, review: 1, done: 4, automation: 0, added: 0 },
  lines: [
    { line: 'stuck', count: 1, items: [{ kind: 'task', id: 't_aaaaaaaaaaaa', text: '店铺后台数据导出', note: '需要店铺后台的登录授权', at: '2026-11-16T14:00:00' }] },
    { line: 'review', count: 1, items: [{ kind: 'task', id: 't_bbbbbbbbbbbb', text: '<b>Q4 新品清单</b>\n细节', note: '清单在资料库 q4-list.xlsx', at: '2026-11-16T15:00:00' }] },
    { line: 'done', count: 4, items: [{ kind: 'task', id: 't_cccccccccccc', text: '竞品价格对比', at: '2026-11-16T15:00:00' }] },
  ],
};

describe("project page What's new tab", () => {
  afterEach(() => { vi.useRealTimers(); });

  it('is present only with news, counts it, and lists P15 rows with titles and notes as text', async () => {
    const view = mount({ p_a: NEWS, p_b: {} });
    await view.run('loadProjectRecap("p_a", { newVisit: true })');
    expect(view.elements['project-recap-tab'].hidden).toBe(false);
    expect(view.elements['project-recap-count'].textContent).toBe('6');
    const list = view.elements['project-recap-list'].innerHTML;
    expect(list.match(/class="home-row project-recap-row"/g)).toHaveLength(3);
    expect(list).toContain('<span class="home-row-source">project.recap.line_review</span>清单在资料库 q4-list.xlsx · ');
    expect(list).toContain('&lt;b&gt;Q4 新品清单&lt;/b&gt;');
    expect(list).not.toContain('<b>');
    expect(list).not.toContain('细节');
    expect(list).toContain('[warning]');
    expect(list).toContain('data-recap-id="t_aaaaaaaaaaaa"');
    expect(list).toContain('project.recap.more:3');

    view.run('_projectDetailPid = "p_b"');
    await view.run('loadProjectRecap("p_b", { newVisit: true })');
    expect(view.elements['project-recap-tab'].hidden).toBe(true);
    expect(view.elements['project-recap-count'].textContent).toBe('');
    expect(view.elements['project-recap-list'].innerHTML).toBe('');
  });

  it('asks for the tab on a new visit with news, unless the navigation asked for another tab, and never on a refresh', async () => {
    let answer: unknown = {};
    const view = mount({ p_a: () => ({ ok: true, shared: false, total: 0, lines: [], ...(answer as object) }) });
    view.run('_projectDetailActiveTab = "todo"');
    await view.run('loadProjectRecap("p_a", { newVisit: true })');
    expect(view.opened).toEqual([]);
    // News arriving while the user works elsewhere adds the tab without a jump.
    answer = NEWS;
    await view.run('loadProjectRecap("p_a")');
    expect(view.elements['project-recap-tab'].hidden).toBe(false);
    expect(view.opened).toEqual([]);
    expect(view.run('_projectDetailActiveTab')).toBe('todo');
    // A navigation that asked for a tab keeps it, and the news is not seen.
    await view.run('loadProjectRecap("p_a", { newVisit: true, openOnNews: false })');
    expect(view.opened).toEqual([]);
    expect(view.elements['project-recap-tab'].hidden).toBe(false);
    expect(view.marks()).toEqual([]);
    // Coming back to the project opens on it.
    await view.run('loadProjectRecap("p_a", { newVisit: true })');
    expect(view.opened).toEqual(['p_a']);
    expect(view.run('_projectDetailActiveTab')).toBe('recap');
    expect(view.marks()).toHaveLength(1);
  });

  it('counts as seen only while the tab is open in front of the user, with one telemetry row per visit', async () => {
    const later = { ...NEWS, total: 7, computed_at: '2026-11-16T16:05:00',
      lines: [...NEWS.lines, { line: 'added', count: 1, items: [{ kind: 'task', id: 't_dddddddddddd', text: '整理库存', at: '2026-11-16T16:04:00' }] }] };
    let answer: unknown = NEWS;
    const view = mount({ p_a: () => ({ ok: true, shared: false, ...(answer as object) }) });
    view.doc.visibilityState = 'hidden';
    await view.run('loadProjectRecap("p_a", { newVisit: true })');
    expect(view.run('_projectDetailActiveTab')).toBe('recap');
    view.doc.visibilityState = 'visible';
    view.doc.focused = false;
    view.run('acknowledgeProjectRecapIfVisible()');
    view.doc.focused = true;
    view.run('_projectDetailActiveTab = "tasks"');
    view.run('acknowledgeProjectRecapIfVisible()');
    view.run('_projectDetailActiveTab = "recap"; currentView = "conversation"');
    view.run('acknowledgeProjectRecapIfVisible()');
    expect(view.marks()).toEqual([]);

    view.run('currentView = "project"');
    view.run('acknowledgeProjectRecapIfVisible()');
    view.run('acknowledgeProjectRecapIfVisible()');
    expect(view.marks()).toEqual([{ projectId: 'p_a', computedAt: '2026-11-16T16:00:00', counts: NEWS.counts }]);

    // A refresh in the same visit keeps its start, adds the new change and
    // moves the record without a second telemetry row.
    answer = later;
    await view.run('loadProjectRecap("p_a")');
    expect(view.reads().at(-1)).toEqual({ projectId: 'p_a', since: '2026-11-09T16:00:00' });
    expect(view.elements['project-recap-count'].textContent).toBe('7');
    expect(view.marks().at(-1)).toEqual({ projectId: 'p_a', computedAt: '2026-11-16T16:05:00', counts: {} });

    // A new visit starts from the stored record again.
    await view.run('loadProjectRecap("p_a", { newVisit: true })');
    expect(view.reads().at(-1)).toEqual({ projectId: 'p_a' });
  });

  it('retries an unrecorded visible impression on the next look and preserves the visit counts', async () => {
    const view = mount({ p_a: NEWS });
    view.doc.focused = false;
    await view.run('loadProjectRecap("p_a", { newVisit: true })');
    view.run(`window.orkas.invoke = async () => { throw new Error('project_recap_seen_write_failed'); }`);
    view.doc.focused = true;
    view.run('acknowledgeProjectRecapIfVisible()');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(view.run('_projectRecapState.seenThrough')).toBe('');
    expect(view.run('_projectRecapState.reported')).toBe(false);
    view.run(`window.__marks = []; window.orkas.invoke = async (channel, args) => {
      window.__marks.push(args); return { ok: true, seen: true };
    }`);
    view.run('acknowledgeProjectRecapIfVisible()');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(JSON.parse(view.run('JSON.stringify(window.__marks)'))).toEqual([
      { projectId: 'p_a', computedAt: NEWS.computed_at, counts: NEWS.counts },
    ]);
    view.run('acknowledgeProjectRecapIfVisible()');
    expect(view.run('window.__marks.length')).toBe(1);
  });

  it('retains an unrecorded visit across a refresh while its acknowledgement is still pending', async () => {
    const view = mount({ p_a: NEWS });
    let rejectWrite!: (error: Error) => void;
    view.doc.focused = false;
    await view.run('loadProjectRecap("p_a", { newVisit: true })');
    view.run('window.__markAttempts = []');
    const mark = new Promise((_resolve, reject) => { rejectWrite = reject; });
    const contextInvoke = view.run('window.orkas.invoke');
    view.run('window').orkas.invoke = (channel: string, args: unknown) => {
      if (channel === 'projects.recap.markSeen') {
        view.run('window.__markAttempts').push(args);
        return mark;
      }
      return contextInvoke(channel, args);
    };
    view.doc.focused = true;
    view.run('acknowledgeProjectRecapIfVisible()');
    await view.run('loadProjectRecap("p_a")');
    rejectWrite(new Error('project_recap_seen_write_failed'));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(view.run('_projectRecapState.seenThrough')).toBe('');
    expect(view.run('_projectRecapState.reported')).toBe(false);
    expect(view.run('window.__markAttempts.length')).toBe(1);
  });

  it('looks again once the second is over when a change from that second was left for the next digest', async () => {
    vi.useFakeTimers();
    let answer: unknown = { since: '2026-11-09T16:00:00', settling: true };
    const view = mount({ p_a: () => ({ ok: true, shared: false, total: 0, lines: [], ...(answer as object) }) });
    await view.run('loadProjectRecap("p_a", { newVisit: true })');
    expect(view.elements['project-recap-tab'].hidden).toBe(true);
    answer = NEWS;
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.reads()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(view.reads()).toEqual([{ projectId: 'p_a' }, { projectId: 'p_a', since: '2026-11-09T16:00:00' }]);
    expect(view.elements['project-recap-tab'].hidden).toBe(false);
    // Part of the same visit: the tab appears without taking over.
    expect(view.opened).toEqual([]);
    // Nothing is pending any more.
    await vi.advanceTimersByTimeAsync(5000);
    expect(view.reads()).toHaveLength(2);
  });

  it('keeps the list when a refresh fails and never paints a slow answer for another project', async () => {
    const view = mount({ p_a: NEWS, p_b: {} });
    await view.run('loadProjectRecap("p_a", { newVisit: true })');
    view.run('window.orkas.invoke = async () => { throw new Error("offline"); }');
    await view.run('loadProjectRecap("p_a")');
    expect(view.elements['project-recap-tab'].hidden).toBe(false);
    expect(view.elements['project-recap-list'].innerHTML).toContain('t_aaaaaaaaaaaa');

    const fresh = mount({ p_a: NEWS, p_b: {} });
    fresh.hold(true);
    const slow = fresh.run('loadProjectRecap("p_a", { newVisit: true })');
    fresh.run('_projectDetailPid = "p_b"');
    fresh.hold(false);
    await fresh.run('loadProjectRecap("p_b", { newVisit: true })');
    fresh.release();
    await slow;
    expect(fresh.elements['project-recap-tab'].hidden).toBe(true);
    expect(fresh.run('_projectDetailActiveTab')).toBe('tasks');
    expect(fresh.run('_projectRecapState.pid')).toBe('p_b');
  });
});
