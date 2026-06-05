import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
  }[c] || c));
}

function loadConversationRenderer() {
  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    requestAnimationFrame: (fn: Function) => {
      setTimeout(fn, 0);
      return 1;
    },
    encodeURIComponent,
    URLSearchParams,
    Date,
    JSON,
    Map,
    Set,
    Array,
    String,
    Number,
    RegExp,
    currentCid: '',
    conversations: [],
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    escapeHtml,
    t: (key: string, params: any = {}) => ({
      'chat.new_conv_title': 'New task',
      'chat.conv_pin_title': 'Pin',
      'chat.conv_unpin_title': 'Unpin',
      'chat.conv_rename_title': 'Rename',
      'chat.conv_del_title': 'Delete',
      'project.menu.more_actions': 'More actions',
      'auto.title': 'Automation',
      'agents.use_label': `Agent: ${params?.agent || ''}`,
      'skills.use_label': `Skill: ${params?.skill || ''}`,
      'sidebar.bucket.today': 'Today',
      'sidebar.bucket.last30': 'Last 30 days',
    }[key] || key),
    _BUCKET_ORDER: ['today', 'last30'],
    timeBucket: () => 'today',
    renderAvatarHtml: () => '',
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    window: {
      addEventListener() {},
      uiIconHtml: (name: string, className: string) => `<svg class="${escapeHtml(className)}" data-icon="${escapeHtml(name)}"></svg>`,
      ConversationRuntime: {},
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
  vm.runInContext(source, context);
  return context;
}

describe('conversation sidebar task row actions', () => {
  it('renders a single menu button after the title', () => {
    const context = loadConversationRenderer();
    const html = context._renderConversationSidebarItem({
      conversation_id: 'c1',
      title: 'Pinned layout',
      pinned_at: '',
    });

    const titleIdx = html.indexOf('class="conv-item-title"');
    const actionsIdx = html.indexOf('class="conv-item-actions"');
    const menuIdx = html.indexOf('class="conv-item-action conv-item-menu"');

    expect(titleIdx).toBeGreaterThan(-1);
    expect(actionsIdx).toBeGreaterThan(titleIdx);
    expect(menuIdx).toBeGreaterThan(actionsIdx);
    expect(html).toContain('data-hide-pin="0"');
  });

  it('marks the menu as no-pin in surfaces that explicitly hide pinning', () => {
    const context = loadConversationRenderer();
    const html = context._renderConversationSidebarItem({
      conversation_id: 'c2',
      title: 'Automation run task',
      origin_auto_task_id: 'auto-1',
    }, { hidePin: true });

    expect(html).toContain('class="conv-item-actions"');
    expect(html).toContain('conv-item-menu');
    expect(html).toContain('data-hide-pin="1"');
  });

  it('renders an inline title input while renaming a row', () => {
    const context = loadConversationRenderer();
    vm.runInContext('_conversationInlineRenameCid = "c1"', context);

    const html = context._renderConversationSidebarItem({
      conversation_id: 'c1',
      title: 'Editable task',
    });

    expect(html).toContain('class="conv-item-title-input"');
    expect(html).toContain('data-conv-rename-cid="c1"');
    expect(html).not.toContain('class="conv-item-title" title="Editable task"');
  });

  it('renders nested task lists with time bucket headers', () => {
    const context = loadConversationRenderer();
    const html = context._renderConversationTimeBucketList([
      {
        conversation_id: 'c1',
        title: 'Project task',
        updated_at: '2026-06-02T00:00:00.000Z',
      },
    ], { nested: true });

    expect(html).toContain('class="conv-list-section-header"');
    expect(html).toContain('Today');
    expect(html).toContain('conv-item-nested');
  });

  it('keeps tasks older than 7 days unrendered while the bucket is collapsed', () => {
    const context = loadConversationRenderer();
    context.timeBucket = () => 'last30';

    const collapsed = context._renderConversationTimeBucketList([
      {
        conversation_id: 'old1',
        title: 'Old task',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
    ], { bucketScope: 'sidebar' });

    expect(collapsed).toContain('is-collapsible is-collapsed');
    expect(collapsed).toContain('Last 30 days');
    expect(collapsed).toContain('data-icon="chevron-right"');
    expect(collapsed).not.toContain('▸');
    expect(collapsed).not.toContain('▾');
    expect(collapsed).not.toContain('Old task');

    vm.runInContext('_conversationExpandedBuckets.add("sidebar:last30")', context);
    const expanded = context._renderConversationTimeBucketList([
      {
        conversation_id: 'old1',
        title: 'Old task',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
    ], { bucketScope: 'sidebar' });
    expect(expanded).toContain('Old task');
    expect(expanded).toContain('data-icon="chevron-down"');

    vm.runInContext('_conversationExpandedBuckets.delete("sidebar:last30")', context);
    const collapsedAgain = context._renderConversationTimeBucketList([
      {
        conversation_id: 'old1',
        title: 'Old task',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
    ], { bucketScope: 'sidebar' });
    expect(collapsedAgain).not.toContain('Old task');
  });

  it('builds pin or unpin menu items only where pinning is enabled', () => {
    const context = loadConversationRenderer();
    context.conversations = [
      { conversation_id: 'c1', title: 'Normal' },
      { conversation_id: 'c2', title: 'Pinned', pinned_at: '2026-06-02T00:00:00.000Z' },
    ];

    expect(context._conversationActionItems('c1').map((it: any) => it.label))
      .toEqual(['Pin', 'Rename', 'Delete']);
    expect(context._conversationActionItems('c2').map((it: any) => it.label))
      .toEqual(['Unpin', 'Rename', 'Delete']);
    expect(context._conversationActionItems('c1', { hidePin: true }).map((it: any) => it.label))
      .toEqual(['Rename', 'Delete']);
  });
});

describe('conversation background stream buffering', () => {
  it('does not render background task events into the visible task', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'visible';
    context.__placeholderCalls = 0;
    vm.runInContext(`
      _ensureActorPlaceholder = function() {
        __placeholderCalls += 1;
        throw new Error('background event rendered into current DOM');
      };
    `, context);

    context._handleGroupBusEvent('background', null, {
      type: 'process',
      cid: 'background',
      actor: 'agent-1',
      turn_id: 'turn-1',
      data: { type: 'delta', text: 'hidden' },
    });

    expect(context.__placeholderCalls).toBe(0);
    expect(vm.runInContext('_backgroundGroupEventBuffers.has("background")', context)).toBe(true);
  });

  it('buffers cross-cid live deltas and replays them when the task is opened', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'visible';

    context._handleGroupBusEvent('background', null, {
      type: 'process',
      cid: 'background',
      actor: 'agent-1',
      turn_id: 'turn-1',
      data: { type: 'delta', text: 'hello' },
    });
    context._handleGroupBusEvent('background', null, {
      type: 'process',
      cid: 'background',
      actor: 'agent-1',
      turn_id: 'turn-1',
      data: { type: 'delta', text: ' world' },
    });

    expect(vm.runInContext('_backgroundGroupEventBuffers.get("background").length', context)).toBe(1);
    expect(vm.runInContext('_backgroundGroupEventBuffers.get("background")[0].data.text', context)).toBe('hello world');

    const replayed: any[] = [];
    context.__replayed = replayed;
    vm.runInContext(`
      _handleGroupBusEvent = function(cid, msg, ev) {
        __replayed.push({ cid: cid, msg: msg, ev: ev });
      };
    `, context);
    context.currentCid = 'background';

    expect(context._replayBufferedGroupEvents('background')).toBe(true);
    expect(replayed).toHaveLength(1);
    expect(replayed[0].cid).toBe('background');
    expect(replayed[0].ev.data.text).toBe('hello world');
    expect(vm.runInContext('_backgroundGroupEventBuffers.has("background")', context)).toBe(false);
  });
});

describe('conversation sticky scroll', () => {
  function fakeScrollEl() {
    const listeners: Record<string, Function[]> = {};
    return {
      scrollTop: 500,
      scrollHeight: 1200,
      clientHeight: 400,
      _stickyEnabled: true,
      _stickyUserPaused: false,
      style: {
        scrollBehavior: '',
        removeProperty(name: string) {
          if (name === 'scroll-behavior') this.scrollBehavior = '';
        },
      },
      addEventListener(type: string, fn: Function) {
        (listeners[type] ||= []).push(fn);
      },
      dispatch(type: string, event: any = {}) {
        for (const fn of listeners[type] || []) fn(event);
      },
    } as any;
  }

  it('does not force bottom while the user scrolls up during streaming', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();

    context._bindStickToBottom(el);
    el.dispatch('wheel', { deltaY: -120 });
    context._stickBottomIfPinned(el);

    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
    expect(el.scrollTop).toBe(500);
  });

  it('resumes bottom-follow after the user returns to the bottom', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();

    context._bindStickToBottom(el);
    el.dispatch('wheel', { deltaY: -120 });
    el.scrollTop = 800;
    el.dispatch('scroll');
    context._stickBottomIfPinned(el);

    expect(el._stickyEnabled).toBe(true);
    expect(el._stickyUserPaused).toBe(false);
    expect(el.scrollTop).toBe(1200);
  });

  it('treats scrollbar drag away from bottom as a manual pause', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();

    context._bindStickToBottom(el);
    el.scrollTop = 300;
    el.dispatch('scroll');
    context._stickBottomIfPinned(el);

    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
    expect(el.scrollTop).toBe(300);
  });

  it('leaves outer scroll alone while scroll-pin spacer is active', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    const spacer = { style: { height: '180px' } };
    let refreshed = false;

    el._scrollPinActive = true;
    el.querySelector = (selector: string) => (
      selector === ':scope > .chat-scroll-spacer' ? spacer : null
    );
    context._setChatScrollOffset = () => { refreshed = true; };

    context._stickBottomIfPinned(el);

    expect(refreshed).toBe(false);
    expect(el.scrollTop).toBe(500);
  });

  it('keeps task chat auto-stick disabled by default', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.id = 'chat-history';

    context._stickBottomIfPinned(el);

    expect(el.scrollTop).toBe(500);
  });

  it('softly follows task chat output when the devtools switch is enabled', async () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.id = 'chat-history';
    let scrollOptions: any = null;
    el.scrollTo = (opts: any) => {
      scrollOptions = opts;
      el.scrollTop = opts.top;
    };
    context.localStorage.getItem = (key: string) => (
      key === 'orkas.dev.taskChatAutoStick' ? '1' : null
    );

    context._stickBottomIfPinned(el);
    expect(el.scrollTop).toBe(500);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(el.scrollTop).toBe(1200);
    expect(scrollOptions).toEqual({ top: 1200, behavior: 'smooth' });
  });

  it('arms task chat auto-stick when the devtools switch is turned on', async () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.id = 'chat-history';
    el._stickyEnabled = false;
    el._stickyUserPaused = true;
    el.scrollTop = 200;
    el.scrollTo = (opts: any) => {
      el.scrollTop = opts.top;
    };
    context.document.getElementById = (id: string) => (id === 'chat-history' ? el : null);
    context.localStorage.getItem = (key: string) => (
      key === 'orkas.dev.taskChatAutoStick' ? '1' : null
    );

    context._setTaskChatAutoStickEnabled(true);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(el._stickyEnabled).toBe(true);
    expect(el._stickyUserPaused).toBe(false);
    expect(el.scrollTop).toBe(1200);
  });

  it('sticks task chat to the last bubble instead of bottom whitespace', async () => {
    const context = loadConversationRenderer();
    const bubble = {
      getBoundingClientRect: () => ({ bottom: 520 }),
    } as any;
    const el = fakeScrollEl();
    el.id = 'chat-history';
    el.scrollTop = 100;
    el.scrollHeight = 1600;
    el.clientHeight = 400;
    el.getBoundingClientRect = () => ({ top: 0 });
    el.querySelectorAll = (selector: string) => (
      selector === ':scope > .chat-message' ? [bubble] : []
    );
    let scrollOptions: any = null;
    el.scrollTo = (opts: any) => {
      scrollOptions = opts;
      el.scrollTop = opts.top;
    };
    context.localStorage.getItem = (key: string) => (
      key === 'orkas.dev.taskChatAutoStick' ? '1' : null
    );

    context._stickBottomIfPinned(el);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(scrollOptions).toEqual({ top: 244, behavior: 'smooth' });
    expect(el.scrollTop).toBe(244);
  });

  it('sticks task chat while the scroll-pin spacer is active', async () => {
    const context = loadConversationRenderer();
    const bubble = {
      getBoundingClientRect: () => ({ bottom: 560 }),
    } as any;
    const el = fakeScrollEl();
    el.id = 'chat-history';
    el._scrollPinActive = true;
    el.scrollTop = 100;
    el.scrollHeight = 1800;
    el.clientHeight = 400;
    el.getBoundingClientRect = () => ({ top: 0 });
    el.querySelectorAll = (selector: string) => (
      selector === ':scope > .chat-message' ? [bubble] : []
    );
    let scrollOptions: any = null;
    el.scrollTo = (opts: any) => {
      scrollOptions = opts;
      el.scrollTop = opts.top;
    };
    context.localStorage.getItem = (key: string) => (
      key === 'orkas.dev.taskChatAutoStick' ? '1' : null
    );

    context._stickBottomIfPinned(el);

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(scrollOptions).toEqual({ top: 284, behavior: 'smooth' });
    expect(el.scrollTop).toBe(284);
  });

  it('preserves scroll position during background history reconcile', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.scrollTop = 240;

    context._restoreHistoryReloadScroll(el, { top: 240 });

    expect(el.scrollTop).toBe(240);
    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
  });

  it('still jumps to bottom when opening conversation history explicitly', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.scrollTop = 0;

    context._scrollToBottomNoAnim(el);

    expect(el.scrollTop).toBe(1200);
    expect(el._stickyEnabled).toBe(true);
    expect(el._stickyUserPaused).toBe(false);
  });

  it('does not force bottom when a streaming reply finalizes', () => {
    const context = loadConversationRenderer();
    const parent = fakeScrollEl();
    context.renderMarkdownFull = (text: string) => escapeHtml(text);
    context._stripSurvivingStructuralBlocks = (text: string) => text;
    const finalEl = {
      style: { display: 'none' },
      innerHTML: '',
      querySelector: () => null,
    } as any;
    const msg = {
      dataset: { streamBuf: 'partial' },
      parentElement: parent,
      querySelector(selector: string) {
        if (selector === '[data-role="final"]') return finalEl;
        return null;
      },
    } as any;

    context._streamingSetFinal(msg, 'done', { archive: false });

    expect(parent.scrollTop).toBe(500);
    expect(finalEl.style.display).toBe('');
    expect(msg.dataset.finalText).toBe('done');
  });

  it('waits for offscreen math before painting a finalized streaming reply', async () => {
    const context = loadConversationRenderer();
    context.renderMarkdownFull = (text: string) => escapeHtml(text);
    context._stripSurvivingStructuralBlocks = (text: string) => text;
    context.typesetMathHtml = async (html: string) => html.replace(
      '\\(y=2x+b\\)',
      '<mjx-container>y=2x+b</mjx-container>',
    );
    const finalEl = {
      style: { display: '' },
      innerHTML: '<div class="markdown-body">old</div>',
      isConnected: true,
      querySelector: (selector: string) => (
        selector === '.markdown-body' ? {} : null
      ),
    } as any;
    const msg = {
      dataset: {
        streamDisplay: '公式 \\(y=2x+b\\)',
        streamBuf: '公式 \\(y=2x+b\\)',
      },
      parentElement: fakeScrollEl(),
      _streamMathTimer: setTimeout(() => {}, 1000),
      querySelector(selector: string) {
        if (selector === '[data-role="final"]') return finalEl;
        return null;
      },
    } as any;

    context._streamingSetFinal(msg, '公式 \\(y=2x+b\\)', { archive: false });

    expect(finalEl.innerHTML).toContain('old');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(finalEl.innerHTML).toContain('<mjx-container>y=2x+b</mjx-container>');
    expect(msg._streamMathTimer).toBeNull();
  });
});

describe('conversation streaming math detection', () => {
  it('detects closed inline and display math while streaming', () => {
    const context = loadConversationRenderer();

    const sig = context._streamMathSignatureForText([
      'inline $E=mc^2$',
      'display:',
      '$$',
      '\\int_0^1 x^2 dx',
      '$$',
      'latex native \\(a+b\\) and \\[c=d\\]',
    ].join('\n'));

    expect(sig).toContain('$E=mc^2$');
    expect(sig).toContain('$$\n\\int_0^1 x^2 dx\n$$');
    expect(sig).toContain('\\(a+b\\)');
    expect(sig).toContain('\\[c=d\\]');
  });

  it('ignores incomplete math, currency, and code examples', () => {
    const context = loadConversationRenderer();

    const sig = context._streamMathSignatureForText([
      'still typing $E=mc',
      'cost is $50 / $100',
      '`$x+y$`',
      '```md',
      '$$hidden$$',
      '```',
    ].join('\n'));

    expect(sig).toBe('');
  });

  it('paints non-math streaming markdown immediately without MathJax', () => {
    const context = loadConversationRenderer();
    let calls = 0;
    context.renderMarkdownFull = (text: string) => `<p>${escapeHtml(text)}</p>`;
    context.typesetMathHtml = async (html: string) => {
      calls += 1;
      return html;
    };
    const finalEl = { innerHTML: '', isConnected: true };
    const msg = { dataset: {}, parentElement: null };

    context._paintStreamingFinalMarkdown(msg, finalEl, 'plain text');

    expect(calls).toBe(0);
    expect(finalEl.innerHTML).toContain('<p>plain text</p>');
    expect(msg.dataset.streamPaintedDisplay).toBe('plain text');
  });

  it('does not paint raw TeX while streaming math is typeset offscreen', async () => {
    const context = loadConversationRenderer();
    context.renderMarkdownFull = (text: string) => escapeHtml(text);
    context.typesetMathHtml = async (html: string) => html.replace(
      '\\(y=2x+b\\)',
      '<mjx-container>y=2x+b</mjx-container>',
    );
    const finalEl = { innerHTML: '<div>previous</div>', isConnected: true };
    const msg = { dataset: {}, parentElement: null };

    context._paintStreamingFinalMarkdown(msg, finalEl, '公式 \\(y=2x+b\\)');

    expect(finalEl.innerHTML).toBe('<div>previous</div>');
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(finalEl.innerHTML).toContain('<mjx-container>y=2x+b</mjx-container>');
    expect(finalEl.innerHTML).not.toContain('\\(y=2x+b\\)');
  });

  it('drops stale offscreen math paints when newer stream content arrives', async () => {
    const context = loadConversationRenderer();
    context.renderMarkdownFull = (text: string) => escapeHtml(text);
    const pending: Array<(value: string) => void> = [];
    context.typesetMathHtml = (html: string) => new Promise((resolve) => {
      pending.push((value: string) => resolve(value || html));
    });
    const finalEl = { innerHTML: '<div>previous</div>', isConnected: true };
    const msg = { dataset: {}, parentElement: null };

    context._paintStreamingFinalMarkdown(msg, finalEl, '旧公式 \\(a+b\\)');
    await new Promise((resolve) => setTimeout(resolve, 60));
    context._paintStreamingFinalMarkdown(msg, finalEl, '新公式 \\(c+d\\)');

    pending[0]('<mjx-container>old</mjx-container>');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finalEl.innerHTML).toBe('<div>previous</div>');

    await new Promise((resolve) => setTimeout(resolve, 60));
    pending[1]('<mjx-container>new</mjx-container>');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(finalEl.innerHTML).toBe('<mjx-container>new</mjx-container>');
    expect(msg.dataset.streamPaintedDisplay).toBe('新公式 \\(c+d\\)');
  });

  it('coalesces streaming math paints to the latest text', async () => {
    const context = loadConversationRenderer();
    let calls = 0;
    context.renderMarkdownFull = (text: string) => escapeHtml(text);
    context.typesetMathHtml = async (html: string) => {
      calls += 1;
      return html.replace(/\\\((.*?)\\\)/g, '<mjx-container>$1</mjx-container>');
    };
    const finalEl = { innerHTML: '<div>previous</div>', isConnected: true };
    const msg = { dataset: {}, parentElement: null };

    context._paintStreamingFinalMarkdown(msg, finalEl, '\\(a+b\\)');
    context._paintStreamingFinalMarkdown(msg, finalEl, '\\(a+b\\) 和 \\(c+d\\)');

    expect(calls).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(1);
    expect(finalEl.innerHTML).toContain('<mjx-container>a+b</mjx-container>');
    expect(finalEl.innerHTML).toContain('<mjx-container>c+d</mjx-container>');
  });
});

describe('conversation process read_file resource labels', () => {
  it('formats read_file(agent.json) with the agent display name from event metadata', () => {
    const context = loadConversationRenderer();

    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'read_file',
        arguments: { path: '/tmp/agents/4430ca181349/agent.json' },
        agent_id: '4430ca181349',
        agent_name: '学习路径设计师',
      },
    });

    expect(line).toContain('read_file');
    expect(line).toContain('Agent: 学习路径设计师 · agent.json');
    expect(line).not.toContain('4430ca181349/agent.json');
  });

  it('falls back to _agentsCache when old events only carry an agent.json path', () => {
    const context = loadConversationRenderer();
    context._agentsCache = [{ agent_id: '4430ca181349', name: '学习路径设计师' }];

    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'read_file',
        arguments: {
          path: '/Users/user/.orkas/data/u1/local/marketplace/agents/4430ca181349/agent.json',
        },
      },
    });

    expect(line).toContain('Agent: 学习路径设计师 · agent.json');
  });
});

describe('conversation auto recipient', () => {
  const members = [
    { kind: 'agent', id: 'a1', name: '交互老师', interactive: true },
    { kind: 'agent', id: 'a2', name: '普通助手', interactive: false },
  ];

  it('keeps live or blocked interactive agents as the input recipient', () => {
    const context = loadConversationRenderer();

    expect(context._pickInteractiveAgent({
      steps: [{ index: 1, assignee: '交互老师', status: 'done' }],
    }, members, [])).toBeNull();

    expect(context._pickInteractiveAgent({
      steps: [{ index: 1, assignee: '交互老师', status: 'in_progress' }],
    }, members, ['a1'])).toMatchObject({ id: 'a1', name: '交互老师' });

    expect(context._pickInteractiveAgent({
      steps: [{ index: 1, assignee: '普通助手', status: 'blocked' }],
    }, members, [])).toBeNull();

    expect(context._pickInteractiveAgent({
      steps: [{ index: 1, assignee: '交互老师', status: 'blocked' }],
    }, members, [])).toMatchObject({ id: 'a1', name: '交互老师' });
  });

  it('keeps direct interactive-agent conversations on that agent', () => {
    const context = loadConversationRenderer();
    vm.runInContext('currentCid = "c1"; _lastInteractiveTurnAgent.set("c1", "a1")', context);

    expect(context._pickInteractiveAgent(null, members, ['a1']))
      .toMatchObject({ id: 'a1', name: '交互老师' });

    expect(context._pickInteractiveAgent(null, members, []))
      .toMatchObject({ id: 'a1', name: '交互老师' });

    expect(context._pickInteractiveAgent({ steps: [], completed: true }, members, []))
      .toBeNull();

    expect(context._pickInteractiveAgent({
      steps: [{ index: 1, assignee: '交互老师', status: 'done' }],
    }, members, [])).toBeNull();
  });

  it('restores the non-plan interactive candidate from visible history', () => {
    const context = loadConversationRenderer();
    vm.runInContext('currentCid = "c1"', context);

    context._restoreInteractiveTurnCandidateFromHistory('c1', [
      { from: 'user', text: 'teach me' },
      { from: 'a1', text: 'try this question' },
    ]);
    expect(context._pickInteractiveAgent(null, members, []))
      .toMatchObject({ id: 'a1', name: '交互老师' });

    context._restoreInteractiveTurnCandidateFromHistory('c1', [
      { from: 'a1', text: 'try this question' },
      { from: 'user', text: 'my answer' },
    ]);
    expect(context._pickInteractiveAgent(null, members, [])).toBeNull();
  });
});
