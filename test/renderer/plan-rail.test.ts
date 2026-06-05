import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

class FakeClassList {
  private readonly items = new Set<string>();

  toggle(name: string, force?: boolean) {
    const shouldAdd = force === undefined ? !this.items.has(name) : force;
    if (shouldAdd) this.items.add(name);
    else this.items.delete(name);
  }

  add(...names: string[]) {
    for (const name of names) this.items.add(name);
  }

  remove(...names: string[]) {
    for (const name of names) this.items.delete(name);
  }

  contains(name: string) {
    return this.items.has(name);
  }
}

class FakeElement {
  id: string;
  hidden = false;
  disabled = false;
  innerHTML = '';
  textContent = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  classList = new FakeClassList();
  root: FakeElement | null = null;

  constructor(id: string) {
    this.id = id;
  }

  contains(target: unknown) {
    return target === this || (target instanceof FakeElement && target.root === this);
  }

  closest(selector: string) {
    if (selector.startsWith('#')) return this.id === selector.slice(1) ? this : null;
    if (selector === '[data-step-index]') return this.dataset.stepIndex ? this : null;
    return null;
  }

  addEventListener() {}
}

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c] || c));
}

function cssBlock(selector: string) {
  const css = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] || '';
}

function createHarness(payload: { plan: any; control?: any }, opts: { confirm?: boolean } = {}) {
  const listeners = new Map<string, Function[]>();
  const calls: Array<{ url: string; method: string }> = [];
  const confirms: string[] = [];
  const root = new FakeElement('plan-rail');
  root.root = root;
  const elements = new Map<string, FakeElement>();
  const getEl = (id: string) => {
    if (!elements.has(id)) {
      const el = id === 'plan-rail' ? root : new FakeElement(id);
      el.root = root;
      elements.set(id, el);
    }
    return elements.get(id)!;
  };
  for (const id of ['plan-rail', 'plan-rail-body', 'plan-rail-progress', 'plan-rail-bar', 'plan-rail-control', 'plan-rail-expand']) {
    getEl(id);
  }

  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    encodeURIComponent,
    CSS: { escape: (s: string) => String(s) },
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    escapeHtml,
    t: (key: string) => ({
      'plan.action.stop': '停止',
      'plan.action.continue': '继续',
      'plan.confirm.stop': '确认停止执行计划？',
      'plan.confirm.continue': '确认继续执行计划？',
      'chat.recipient_commander': '指挥官',
    }[key] || key),
    uiConfirm: async (message: string) => {
      confirms.push(message);
      return opts.confirm !== false;
    },
    uiAlert: () => {},
    apiFetch: async (url: string, init?: { method?: string }) => {
      const method = init?.method || 'GET';
      calls.push({ url, method });
      if (method === 'POST') return { ok: true, json: async () => ({ ok: true }) };
      return {
        ok: true,
        json: async () => ({ ok: true, plan: payload.plan, control: payload.control || null }),
      };
    },
    document: {
      getElementById: getEl,
      querySelector: () => null,
      addEventListener(type: string, fn: Function) {
        const arr = listeners.get(type) || [];
        arr.push(fn);
        listeners.set(type, arr);
      },
    },
    window: {
      uiIconHtml: (name: string) => `[${name}]`,
      ConversationInfo: { refreshTasks() {} },
      ConversationRuntime: { observePlanRecoveryRun: () => ({ cancel() {} }) },
    },
  };
  context.window.window = context.window;

  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/plan-rail.js'), 'utf8');
  vm.runInContext(source, context);

  return {
    context,
    calls,
    confirms,
    getEl,
    async render() {
      context.window.PlanRail.bind('c1');
      await context.window.PlanRail.refresh('c1', { force: true });
    },
    async click(target: FakeElement) {
      for (const fn of listeners.get('click') || []) {
        await fn({ target, stopPropagation() {}, preventDefault() {} });
      }
    },
  };
}

const recoverablePlan = {
  steps: [
    { index: 1, title: '搜集', assignee: 'Alpha', status: 'done' },
    { index: 2, title: '分析', assignee: 'Beta', status: 'failed', failure_reason: 'fetch failed' },
  ],
};

describe('PlanRail unified control', () => {
  it('renders continue next to progress and does not render legacy retry / skip controls', async () => {
    const h = createHarness({ plan: recoverablePlan, control: { action: 'continue' } });
    await h.render();

    const control = h.getEl('plan-rail-control');
    expect(h.getEl('plan-rail').style.display).toBe('');
    expect(h.getEl('plan-rail-progress').textContent).toBe('1/2');
    expect(control.hidden).toBe(false);
    expect(control.dataset.planAction).toBe('continue');
    expect(control.textContent).toBe('继续');
    expect(control.classList.contains('is-continue')).toBe(true);

    const allHtml = `${control.textContent}\n${h.getEl('plan-rail-body').innerHTML}`;
    expect(allHtml).not.toContain('重试');
    expect(allHtml).not.toContain('跳过');
    expect(allHtml).not.toContain('停止全部');
  });

  it('uses the simplified confirmation text before stop / continue actions', async () => {
    for (const [action, message, endpoint] of [
      ['stop', '确认停止执行计划？', '/abort'],
      ['continue', '确认继续执行计划？', '/plan/continue'],
    ] as const) {
      const h = createHarness({ plan: recoverablePlan, control: { action } });
      await h.render();
      await h.click(h.getEl('plan-rail-control'));

      expect(h.confirms).toContain(message);
      expect(h.calls.some((c) => c.method === 'POST' && c.url.endsWith(endpoint))).toBe(true);
    }
  });

  it('does not call plan-control endpoints when confirmation is cancelled', async () => {
    const h = createHarness({ plan: recoverablePlan, control: { action: 'stop' } }, { confirm: false });
    await h.render();
    await h.click(h.getEl('plan-rail-control'));

    expect(h.confirms).toEqual(['确认停止执行计划？']);
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('hides the rail when all steps are completed, even if another worker is in flight', async () => {
    const h = createHarness({
      plan: {
        steps: [
          { index: 1, title: '搜集', assignee: 'Alpha', status: 'done' },
          { index: 2, title: '整理', assignee: 'Beta', status: 'skipped' },
        ],
      },
      control: { action: 'continue' },
    });
    await h.render();
    h.context.window.PlanRail.setInFlight('c1', ['unrelated-agent']);

    expect(h.getEl('plan-rail').style.display).toBe('none');
    expect(h.getEl('plan-rail-control').hidden).toBe(true);
  });

  it('renders blocked steps as waiting for input, not failed', async () => {
    const h = createHarness({
      plan: {
        steps: [
          { index: 1, title: '补充信息', assignee: 'FamilyTutor', status: 'blocked' },
          { index: 2, title: '分析', assignee: 'MathTutor', status: 'pending' },
        ],
      },
    });
    await h.render();

    const barHtml = h.getEl('plan-rail-bar').innerHTML;
    const bodyHtml = h.getEl('plan-rail-body').innerHTML;
    expect(barHtml).toContain('plan-rail-bar-cell is-blocked');
    expect(barHtml).not.toContain('plan-rail-bar-cell is-failed');
    expect(bodyHtml).toContain('plan-rail-step is-blocked');
    expect(bodyHtml).toContain('[document-pencil]');
  });
});

describe('Plan control button CSS', () => {
  it('keeps stop buttons on the normal button palette', () => {
    for (const selector of ['.plan-rail-control.is-stop', '.ci-tasks-control.is-stop']) {
      const block = cssBlock(selector);
      expect(block).toContain('color: var(--text-2)');
      expect(block).toContain('border-color: var(--border)');
      expect(block).toContain('background: var(--surface-2)');
      expect(block).not.toMatch(/danger|239,\s*68,\s*68/);
    }
  });
});
