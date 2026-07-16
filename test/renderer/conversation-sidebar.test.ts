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
  const pendingConvs = new Map<string, any>();
  const groupBusyConvs = new Map<string, boolean>();
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
    CSS: { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') },
    Array,
    String,
    Number,
    RegExp,
    currentCid: '',
    conversations: [],
    pendingConvs,
    groupBusyConvs,
    isGroupConversationBusy: (cid: string) => groupBusyConvs.has(cid),
    isConvPending: (cid: string) => pendingConvs.has(cid) || groupBusyConvs.has(cid),
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
      'chat.stream.compaction_tokens': `Context compressed: ${params?.before} -> ${params?.after} tokens`,
      'chat.stream.runtime_total': `Total time ${params?.duration}`,
      'chat.stream.runtime_model': `model ${params?.duration}`,
      'chat.stream.runtime_tools': `tools ${params?.duration}`,
      'chat.stream.runtime_context': `context ${params?.duration}`,
      'chat.stream.runtime_retry': `retry wait ${params?.duration}`,
      'chat.stream.duration_s': `${params?.s}s`,
      'chat.stream.duration_ms': `${params?.m}m ${params?.s}s`,
      'chat.stream.duration_hms': `${params?.h}h ${params?.m}m ${params?.s}s`,
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

describe('conversation create-agent inline gate', () => {
  it('hides while the current task is pending even without a scroll spacer', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';
    context.pendingConvs.set('c1', { loadingEl: null, aborted: false });

    const busy = context._isConvCreateAgentInlineRuntimeBusy('c1');

    expect(busy).toBe(true);
    expect(context._shouldShowConvCreateAgentInline(true, busy, false)).toBe(false);
  });

  it('also hides for group-runtime work that has no request controller', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';
    context.groupBusyConvs.set('c1', true);

    const busy = context._isConvCreateAgentInlineRuntimeBusy('c1');

    expect(busy).toBe(true);
    expect(context._shouldShowConvCreateAgentInline(true, busy, false)).toBe(false);
  });

  it('shows only for an idle user-only conversation', () => {
    const context = loadConversationRenderer();

    expect(context._shouldShowConvCreateAgentInline(true, false, false)).toBe(true);
    expect(context._shouldShowConvCreateAgentInline(true, false, true)).toBe(false);
    expect(context._shouldShowConvCreateAgentInline(false, false, false)).toBe(false);
  });
});

describe('conversation history initial window', () => {
  it('uses ten-message cursor pages for initial and older history requests', () => {
    const context = loadConversationRenderer();
    context.conversations.push({ conversation_id: 'c1', project_id: 'p1' });

    expect(context._historyRequestUrl('c1')).toBe('/api/conversations/c1/history?limit=10&project_id=p1');
    expect(context._historyRequestUrl('c1', 999)).toBe('/api/conversations/c1/history?limit=10&before=999&project_id=p1');
    expect(context._historyRequestUrl('global')).toBe('/api/conversations/global/history?limit=10&project_id=');
  });
});

describe('conversation run observer cleanup', () => {
  it('defers cleanup only while the primary send stream still owns the turn', () => {
    const context = loadConversationRenderer();

    expect(context._observerShouldDeferCleanup('c1', true)).toBe(false);
    expect(context._observerShouldDeferCleanup('c1', false)).toBe(false);

    vm.runInContext('_convChatCtrls.set("c1", { abort() {} })', context);

    expect(context._observerShouldDeferCleanup('c1', true)).toBe(true);
    expect(context._observerShouldDeferCleanup('c1', false)).toBe(false);
  });
});

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

  it('refreshes time bucket headers only when foreground return crosses a local day', () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      __renderCalls = 0;
      renderConversationList = function() { __renderCalls += 1; };
      _conversationBucketDateKey = _conversationLocalDateKey(new Date(2026, 4, 15, 23, 50, 0));
    `, context);

    const sameDay = vm.runInContext(
      '_refreshConversationBucketsForDateChange(new Date(2026, 4, 15, 23, 55, 0))',
      context,
    );
    const nextDay = vm.runInContext(
      '_refreshConversationBucketsForDateChange(new Date(2026, 4, 16, 0, 5, 0))',
      context,
    );
    const nextDayAgain = vm.runInContext(
      '_refreshConversationBucketsForDateChange(new Date(2026, 4, 16, 9, 0, 0))',
      context,
    );

    expect(sameDay).toBe(false);
    expect(nextDay).toBe(true);
    expect(nextDayAgain).toBe(false);
    expect(context.__renderCalls).toBe(1);
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

  it('renders a collapsed old-bucket header from deferred counts without task rows', () => {
    const context = loadConversationRenderer();
    context.timeBucket = () => 'last30';

    const html = context._renderConversationTimeBucketList([], {
      bucketScope: 'sidebar',
      deferredBucketCounts: { last30: 23 },
    });

    expect(html).toContain('Last 30 days');
    expect(html).toContain('is-collapsed');
    expect(html).toContain('conv-list-section-count">23');
    expect(html).not.toContain('conv-item');
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

  it('releases the send-time scroll pin on a downward wheel gesture', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    const spacer = {
      removed: false,
      remove() { this.removed = true; },
    };
    el._scrollPinActive = true;
    el.scrollTop = 800; // currently at the artificial spacer's bottom edge
    el.querySelector = (selector: string) => (
      selector === ':scope > .chat-scroll-spacer' && !spacer.removed ? spacer : null
    );

    context._bindStickToBottom(el);
    el.dispatch('wheel', { deltaY: 120 });

    expect(spacer.removed).toBe(true);
    expect(el._scrollPinActive).toBe(false);
    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
  });

  it('releases the send-time scroll pin on a touch scroll gesture', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    const spacer = {
      removed: false,
      remove() { this.removed = true; },
    };
    el._scrollPinActive = true;
    el.querySelector = (selector: string) => (
      selector === ':scope > .chat-scroll-spacer' && !spacer.removed ? spacer : null
    );

    context._bindStickToBottom(el);
    el.dispatch('touchmove');

    expect(spacer.removed).toBe(true);
    expect(el._scrollPinActive).toBe(false);
    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
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

  it('uses generic sticky scrolling for chat history', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.id = 'chat-history';

    context._stickBottomIfPinned(el);

    expect(el.scrollTop).toBe(1200);
  });

  it('preserves scroll position during background history reconcile', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.scrollTop = 240;

    context._restoreHistoryReloadScroll(el, { top: 240, bottom: 560, nearBottom: false });

    expect(el.scrollTop).toBe(240);
    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
  });

  it('keeps the user anchored to bottom across history reconcile relayout', async () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.scrollTop = 800;
    const snapshot = context._captureHistoryReloadScroll(el);

    el.scrollHeight = 400;
    context._restoreHistoryReloadScroll(el, snapshot);
    expect(el.scrollTop).toBe(0);

    el.scrollHeight = 1800;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(el.scrollTop).toBe(1400);
    expect(el._stickyEnabled).toBe(true);
    expect(el._stickyUserPaused).toBe(false);
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
    context._attachAssistantActions = () => {};
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
    context._attachAssistantActions = () => {};
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

describe('conversation history reconcile', () => {
  it('matches a live rendered reply by signature before forcing a reload', () => {
    const context = loadConversationRenderer();
    const gm = {
      id: 'm-final',
      from: 'commander',
      text: 'Finished answer',
      ts: '2026-06-28T11:20:00.000Z',
    };
    const el: any = { dataset: {} };
    context._stampRenderedGroupMessage(el, gm);
    const container = {
      querySelector(selector: string) {
        if (selector.includes('data-msg-id')) return null;
        if (selector.includes('data-group-msg-sig')) return el;
        return null;
      },
    };

    const found = context._findRenderedMessageForHistoryRecord(container, gm);

    expect(found).toBe(el);
    expect(el.dataset.msgId).toBe('m-final');
  });

  it('repositions an optimistic queued user bubble when its persisted timestamp arrives', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';

    function makeMsg(className: string, dataset: Record<string, string>) {
      const el: any = {
        className,
        dataset: { ...dataset },
        parentElement: null,
        matches(selector: string) {
          return selector === '.chat-message[data-ts]'
            && this.className.includes('chat-message')
            && this.dataset.ts != null;
        },
      };
      Object.defineProperty(el, 'previousElementSibling', {
        get() {
          if (!this.parentElement) return null;
          const idx = this.parentElement.children.indexOf(this);
          return idx > 0 ? this.parentElement.children[idx - 1] : null;
        },
      });
      Object.defineProperty(el, 'nextElementSibling', {
        get() {
          if (!this.parentElement) return null;
          const idx = this.parentElement.children.indexOf(this);
          return idx >= 0 && idx < this.parentElement.children.length - 1
            ? this.parentElement.children[idx + 1]
            : null;
        },
      });
      return el;
    }

    const user = makeMsg('chat-message user', { convPair: '1', ts: '900' });
    const assistant = makeMsg('chat-message assistant', { msgId: 'a1', ts: '1000' });
    const container: any = {
      children: [user, assistant],
      querySelector(selector: string) {
        if (selector.includes('data-msg-id')) {
          const id = selector.match(/data-msg-id="([^"]+)"/)?.[1];
          return this.children.find((el: any) => el.dataset.msgId === id) || null;
        }
        if (selector === ':scope > .chat-scroll-spacer') return null;
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector === '.chat-message.user[data-conv-pair]:not([data-msg-id])') {
          return this.children.filter((el: any) => el.className.includes('user') && !!el.dataset.convPair && !el.dataset.msgId);
        }
        if (selector === '.chat-message.user:not([data-msg-id])') {
          return this.children.filter((el: any) => el.className.includes('user') && !el.dataset.msgId);
        }
        if (selector === ':scope > .chat-message[data-ts]') {
          return this.children.filter((el: any) => el.dataset.ts != null);
        }
        return [];
      },
      removeChild(el: any) {
        const idx = this.children.indexOf(el);
        if (idx >= 0) this.children.splice(idx, 1);
        el.parentElement = null;
      },
      insertBefore(el: any, ref: any) {
        const oldIdx = this.children.indexOf(el);
        if (oldIdx >= 0) this.children.splice(oldIdx, 1);
        const refIdx = this.children.indexOf(ref);
        this.children.splice(refIdx >= 0 ? refIdx : this.children.length, 0, el);
        el.parentElement = this;
      },
      appendChild(el: any) {
        const oldIdx = this.children.indexOf(el);
        if (oldIdx >= 0) this.children.splice(oldIdx, 1);
        this.children.push(el);
        el.parentElement = this;
      },
    };
    user.parentElement = container;
    assistant.parentElement = container;
    context.document.getElementById = (id: string) => (id === 'chat-history' ? container : null);

    const claimed = context._claimPersistedUserMessage('c1', {
      id: 'u1',
      from: 'user',
      text: 'queued follow-up',
      ts: 1100,
    });

    expect(claimed).toBe(true);
    expect(container.children).toEqual([assistant, user]);
    expect(user.dataset.msgId).toBe('u1');
    expect(user.dataset.fromActor).toBe('user');
    expect(user.dataset.ts).toBe('1100');
  });
});

describe('conversation streaming math detection', () => {
  it('reuses decoded inline image nodes across streaming markdown repaints', () => {
    const context = loadConversationRenderer();
    const src = 'chat-media://local/Users/test/preview.png';
    const existingImage = {
      getAttribute(name: string) { return name === 'src' ? src : ''; },
    };
    const existingShell = {
      className: 'chat-image-shell chat-md-img-shell is-loaded',
      querySelector(selector: string) {
        if (selector === 'img.chat-md-img[src]') return existingImage;
        return null;
      },
    };
    const freshImage = {
      getAttribute(name: string) { return name === 'src' ? src : ''; },
    };
    let replacement: unknown = null;
    const freshShell = {
      className: 'chat-image-shell chat-md-img-shell is-loading',
      replaceWith(node: unknown) { replacement = node; },
      querySelector(selector: string) {
        if (selector === 'img.chat-md-img[src]') return freshImage;
        return null;
      },
    };
    const freshRoot = {
      querySelectorAll(selector: string) {
        if (selector === '.chat-md-img-shell') return [freshShell];
        if (selector === '.chat-md-video-shell' || selector === '.chat-md-audio-card') return [];
        return [];
      },
    };
    const stable = new Map([[context._streamingStableMediaKey('image', src), [existingShell]]]);

    context._streamingRestoreStableMedia(freshRoot, stable);

    expect(replacement).toBe(existingShell);
    expect(existingShell.className).toContain('is-loaded');
    expect(existingShell.className).not.toContain('is-loading');
  });

  it('reuses standalone dashboard and raw HTML media nodes', () => {
    const context = loadConversationRenderer();
    const src = 'https://example.test/dashboard-preview.png';
    const existingImage = {
      tagName: 'IMG',
      attributes: [],
      getAttribute(name: string) { return name === 'src' ? src : ''; },
      closest() { return null; },
    };
    let replacement: unknown = null;
    const freshImage = {
      tagName: 'IMG',
      attributes: [],
      getAttribute(name: string) { return name === 'src' ? src : ''; },
      closest() { return null; },
      replaceWith(node: unknown) { replacement = node; },
    };
    const freshRoot = {
      querySelectorAll(selector: string) {
        if (selector === 'img[src], video[src], audio[src]') return [freshImage];
        return [];
      },
    };
    const stable = new Map([[context._streamingStableMediaKey('image-node', src), [existingImage]]]);

    context._streamingRestoreStableMedia(freshRoot, stable);

    expect(replacement).toBe(existingImage);
  });

  it('reuses inline video nodes across streaming markdown repaints', () => {
    const context = loadConversationRenderer();
    const src = 'chat-media://local/Users/test/clip.mp4';
    const existingVideo = {
      getAttribute(name: string) { return name === 'src' ? src : ''; },
    };
    const existingShell = {
      querySelector(selector: string) {
        if (selector === 'video.chat-md-video[src]') return existingVideo;
        if (selector === 'video.chat-md-video[src], audio.chat-md-audio[src]') return existingVideo;
        return null;
      },
    };
    const freshVideo = {
      getAttribute(name: string) { return name === 'src' ? src : ''; },
    };
    let replacement: unknown = null;
    const freshShell = {
      replaceWith(node: unknown) { replacement = node; },
      querySelector(selector: string) {
        if (selector === 'video.chat-md-video[src]') return freshVideo;
        if (selector === 'video.chat-md-video[src], audio.chat-md-audio[src]') return freshVideo;
        return null;
      },
    };
    const freshRoot = {
      querySelectorAll(selector: string) {
        if (selector === '.chat-md-img-shell') return [];
        if (selector === '.chat-md-video-shell') return [freshShell];
        if (selector === '.chat-md-audio-card') return [];
        return [];
      },
    };
    const stable = new Map([[context._streamingStableMediaKey('video', src), [existingShell]]]);

    context._streamingRestoreStableMedia(freshRoot, stable);

    expect(replacement).toBe(existingShell);
  });

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
          path: '/Users/test/.orkas/data/u1/local/marketplace/agents/4430ca181349/agent.json',
        },
      },
    });

    expect(line).toContain('Agent: 学习路径设计师 · agent.json');
  });
});

describe('conversation process metadata formatting', () => {
  it('formats compaction and total runtime events for the process pane', () => {
    const context = loadConversationRenderer();

    const compaction = context._formatEventLine({
      stream: 'compaction',
      data: { tokensBefore: 20000, tokensAfter: 3000 },
    });
    const runtime = context._formatEventLine({
      stream: 'runtime',
      data: { duration_ms: 65_000 },
    });
    const runtimeWithBreakdown = context._formatEventLine({
      stream: 'runtime',
      data: {
        duration_ms: 65_000,
        provider_ms: 40_000,
        tool_ms: 5_000,
        compaction_ms: 15_000,
        retry_wait_ms: 5_000,
      },
    });
    const tool = context._formatEventLine({
      stream: 'tool',
      data: { phase: 'end', name: 'manage_execution_plan', duration_ms: 17 },
    });

    expect(compaction).toBe('Context compressed: 20000 -> 3000 tokens');
    expect(runtime).toBe('Total time 1m 5s');
    expect(runtimeWithBreakdown)
      .toBe('Total time 1m 5s · model 40s · tools 5s · context 15s · retry wait 5s');
    expect(tool).toContain('manage_execution_plan');
    expect(tool).toContain('17ms');
    expect(context._processSummaryRuntimeFromItems([
      { type: 'progress', text: 'Context compressed', event: { stream: 'compaction', data: {} } },
      { type: 'progress', text: 'Total time 1m 5s', event: { stream: 'runtime', data: { duration_ms: 65_000 } } },
    ])).toBe('1m 5s');
    expect(context._processSummaryRuntimeFromItems([
      { type: 'event', event: { stream: 'runtime', data: { durationMs: 1_234 } } },
    ])).toBe('1s');
    expect(context._processSummaryRuntimeFromItems([
      { type: 'progress', text: 'Context compressed', event: { stream: 'compaction', data: {} } },
    ])).toBe('');
    expect(context._eventProcessKind({ stream: 'context', data: {} }, 'Context prepared')).toBe('context');
    expect(context._eventProcessKind({ stream: 'compaction', data: {} }, compaction)).toBe('context');
    expect(context._eventProcessKind({ stream: 'runtime', data: {} }, runtime)).toBe('bound');
  });
});

describe('conversation auto recipient', () => {
  it('mirrors the server conversation floor into the input recipient', async () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _groupMembersCache.set("c1", [
        { kind: "agent", id: "a1", name: "交互老师" },
      ]);
      _serverFloorByCid.set("c1", "a1");
    `, context);

    await vm.runInContext('_evaluateAutoRecipient("c1")', context);

    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ id: 'a1', name: '交互老师' });
  });

  it('does not infer a recipient from in-flight actors when the server floor is empty', async () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _groupMembersCache.set("c1", [
        { kind: "agent", id: "a1", name: "交互老师" },
      ]);
      _latestInFlight.set("c1", ["a1"]);
      _serverFloorByCid.set("c1", "");
    `, context);

    await vm.runInContext('_evaluateAutoRecipient("c1")', context);

    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ kind: 'commander' });
  });

  it('clears the auto recipient when the server floor clears', async () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _groupMembersCache.set("c1", [
        { kind: "agent", id: "a1", name: "交互老师" },
      ]);
      _serverFloorByCid.set("c1", "a1");
    `, context);
    await vm.runInContext('_evaluateAutoRecipient("c1")', context);
    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ id: 'a1', name: '交互老师' });

    vm.runInContext('_serverFloorByCid.set("c1", "")', context);
    await vm.runInContext('_evaluateAutoRecipient("c1")', context);

    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ kind: 'commander' });
  });

  it('suppresses the floor and prefixes @commander when the user explicitly returns to commander', async () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _groupMembersCache.set("c1", [
        { kind: "agent", id: "a1", name: "交互老师" },
      ]);
      _serverFloorByCid.set("c1", "a1");
    `, context);
    await vm.runInContext('_evaluateAutoRecipient("c1")', context);
    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ id: 'a1', name: '交互老师' });

    context.setChatRecipient('conversation', { kind: 'commander' });
    await vm.runInContext('_evaluateAutoRecipient("c1")', context);

    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ kind: 'commander' });
    expect(context.applyRecipientPrefix('先回到你这里', 'conversation'))
      .toBe('@commander 先回到你这里');
  });

  it('prefixes from a send-time recipient snapshot instead of a later chip state', () => {
    const context = loadConversationRenderer();
    context._agentsCache = [
      { agent_id: 'a1', name: 'FamilyTutor' },
      { agent_id: 'a2', name: 'OtherTutor' },
    ];
    vm.runInContext(`
      currentCid = "c1";
      setChatRecipient("conversation", { kind: "agent", id: "a1", name: "FamilyTutor" });
      __snap = _takeRecipientSnapshotForSend("conversation");
      setChatRecipient("conversation", { kind: "agent", id: "a2", name: "OtherTutor" });
    `, context);

    expect(context.applyRecipientPrefix('继续', 'conversation', { recipientSnapshot: context.__snap }))
      .toBe('@FamilyTutor 继续');
  });

  it('stores the commander floor reset in the send-time snapshot', () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _serverFloorByCid.set("c1", "a1");
      setChatRecipient("conversation", { kind: "commander" });
      __snap = _takeRecipientSnapshotForSend("conversation");
      __stillPending = _pendingFloorResetByCid.has("c1");
    `, context);

    expect(context.__snap).toMatchObject({ kind: 'commander', resetFloor: true });
    expect(context.__stillPending).toBe(false);
    expect(context.applyRecipientPrefix('回来', 'conversation', { recipientSnapshot: context.__snap }))
      .toBe('@commander 回来');
  });

  it('drains queued messages with the enqueue-time recipient snapshot', () => {
    const context = loadConversationRenderer();
    context.messageQueues = new Map();
    context._QUEUE_KEY = (cid: string) => `queue_${cid}`;
    context._DRAFT_KEY = (cid: string) => `draft_${cid}`;
    context._agentsCache = [
      { agent_id: 'a1', name: 'FamilyTutor' },
      { agent_id: 'a2', name: 'OtherTutor' },
    ];
    const queueSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/queue-draft.js'), 'utf8');
    vm.runInContext(queueSource, context);
    vm.runInContext(`
      currentCid = "c1";
      __sent = [];
      sendInCurrentConversation = (content) => { __sent.push(content); };
      setChatRecipient("conversation", { kind: "agent", id: "a1", name: "FamilyTutor" });
      enqueueMessage("c1", "还有吗？", null, {
        recipient: _takeRecipientSnapshotForSend("conversation"),
      });
      setChatRecipient("conversation", { kind: "agent", id: "a2", name: "OtherTutor" });
      _dispatchNextQueued("c1");
    `, context);

    expect(context.__sent).toEqual(['@FamilyTutor 还有吗？']);
  });
});

describe('new chat quick-start scenarios', () => {
  it('falls back to commander without toast when the scenario agent is missing', async () => {
    const context = loadConversationRenderer();
    const toasts: any[] = [];
    let clickHandler: Function | null = null;
    const input = {
      value: '',
      focused: false,
      selection: [0, 0],
      focus() { this.focused = true; },
      setSelectionRange(start: number, end: number) { this.selection = [start, end]; },
      dispatchEvent() {},
    };
    const chip = {
      dataset: { scenario: 'ui_design' },
      addEventListener(type: string, fn: Function) {
        if (type === 'click') clickHandler = fn;
      },
    };
    const row = {
      dataset: {},
      querySelectorAll: () => [chip],
    };

    context._agentsCache = [];
    context.uiToast = (...args: any[]) => toasts.push(args);
    context.autoGrow = () => {};
    context.Event = class {
      type: string;
      constructor(type: string) { this.type = type; }
    };
    context.document.getElementById = (id: string) => {
      if (id === 'new-chat-scenarios') return row;
      if (id === 'new-chat-input') return input;
      return null;
    };

    context._initEmptyStateScenarios();
    expect(clickHandler).toBeTruthy();
    await clickHandler!();

    expect(context.getChatRecipient('new-chat')).toMatchObject({ kind: 'commander' });
    expect(input.value).toContain('Design the UI');
    expect(input.focused).toBe(true);
    expect(toasts).toHaveLength(0);
  });
});
