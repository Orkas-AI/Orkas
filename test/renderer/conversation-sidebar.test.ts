import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function cssDeclarationsForSelector(source: string, selector: string): Array<Record<string, string>> {
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: Array<Record<string, string>> = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].split(',').map(item => item.trim());
    if (!selectors.includes(selector)) continue;
    const declarations: Record<string, string> = {};
    for (const entry of match[2].split(';')) {
      const separator = entry.indexOf(':');
      if (separator < 0) continue;
      const property = entry.slice(0, separator).trim();
      const value = entry.slice(separator + 1).trim();
      if (property && value) declarations[property] = value;
    }
    rules.push(declarations);
  }
  return rules;
}

function onlyCssDeclarations(source: string, selector: string): Record<string, string> {
  const rules = cssDeclarationsForSelector(source, selector);
  if (rules.length !== 1) {
    throw new Error(`Expected one CSS rule for ${selector}, found ${rules.length}`);
  }
  return rules[0];
}

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
    setInterval,
    clearInterval,
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
    setGroupConversationBusy: (cid: string, busy: boolean) => {
      if (busy) groupBusyConvs.set(cid, true);
      else groupBusyConvs.delete(cid);
    },
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
      'project.todo.status_blocked': 'Blocked',
      'chat.status.failed_short': 'Failed',
      'auto.title': 'Automation',
      'agents.use_label': `Agent: ${params?.agent || ''}`,
      'skills.use_label': `Skill: ${params?.skill || ''}`,
      'chat.stream.compaction_tokens': `Conversation organized · ${params?.before} → ${params?.after} tokens`,
      'chat.stream.compaction': 'Conversation organized',
      'chat.stream.compacting': 'Organize conversation',
      'chat.stream.error': `Error: ${params?.msg}`,
      'chat.stream.reasoning_error_with': `Thinking failed · ${params?.msg}`,
      'chat.stream.approval_with': `Awaiting confirmation: ${params?.p}`,
      'chat.stream.plan_with_steps': `Plan (${params?.n} steps): ${params?.titles}`,
      'chat.stream.plan': `Plan ${params?.p}`,
      'chat.stream.phase_progress': 'progress',
      'chat.process.with_target': `${params?.action} · ${params?.target}`,
      'chat.process.with_status': `${params?.label} · ${params?.status}`,
      'chat.process.started_action': `Started · ${params?.label}`,
      'chat.process.action_view_skill': 'View skill',
      'chat.process.action_use_skill': 'Use skill',
      'chat.process.action_view_agent': 'View agent',
      'chat.process.action_view_file': 'View file',
      'chat.process.action_check_file': 'Check file',
      'chat.process.action_render_file': 'Render file',
      'chat.process.action_view_directory': 'View folder',
      'chat.process.target_current_workspace': 'Current task workspace',
      'chat.process.action_get_file_info': 'Get file info',
      'chat.process.action_read_file': 'Read file',
      'chat.process.action_view_image': 'View image',
      'chat.process.action_modify_skill': 'Edit skill',
      'chat.process.action_modify_agent': 'Edit agent',
      'chat.process.action_modify_file': 'Edit file',
      'chat.process.action_create_file': 'Create file',
      'chat.process.action_delete_skill': 'Delete skill',
      'chat.process.action_delete_agent': 'Delete agent',
      'chat.process.action_delete_file': 'Delete file',
      'chat.process.action_recognize_text': 'Recognize text',
      'chat.process.action_search_files': 'Search files',
      'chat.process.action_search_web': 'Search the web',
      'chat.process.action_view_web': 'View webpage',
      'chat.process.action_view_reference': 'View reference',
      'chat.process.action_search_reference': 'Search references',
      'chat.process.action_view_conversation': 'View conversation',
      'chat.process.action_search_conversation': 'Search conversation',
      'chat.process.action_run_command': 'Run command',
      'chat.process.action_generate_image': 'Generate image',
      'chat.process.action_generate_audio': 'Generate audio',
      'chat.process.action_create_plan': 'Create plan',
      'chat.process.action_execute_plan': 'Execute plan',
      'chat.process.action_update_plan': 'Update plan',
      'chat.process.action_organize_conversation': 'Organize conversation',
      'chat.process.action_use_connector': 'Use connector',
      'chat.process.action_view_connector': 'View connector',
      'chat.process.action_add_connector': 'Add connector',
      'chat.process.action_call_agent': 'Call agent',
      'chat.process.action_handoff_commander': 'Hand off to Commander',
      'chat.process.action_execute': 'Run action',
      'chat.process.action_start_agent': 'Start agent',
      'chat.process.action_background_task': 'Background task',
      'chat.process.action_not_allowed': 'Not allowed',
      'chat.process.status_done': 'Done',
      'chat.process.status_failed': 'Failed',
      'chat.process.video_narration_timing_mismatch': `Narration ${params?.measured}s outside ${params?.min}-${params?.max}s`,
      'chat.process.video_narration_timing_decision': `Narration ${params?.measured}s still outside ${params?.min}-${params?.max}s; decide next step`,
      'chat.process.repeated_failure_decision': 'Current candidate failed repeatedly; decide next step',
      'chat.process.status_stopped': 'Stopped',
      'chat.process.agent_ready': 'Agent connected',
      'chat.process.task_running': 'Handle task',
      'chat.process.task_done': 'Task complete',
      'chat.process.response_timeout': 'Response timed out',
      'chat.process.wait_agent_response': `Wait for agent response · ${params?.duration}`,
      'chat.process.cli_login_required': 'External agent sign-in required',
      'chat.process.connection_recovered': 'Connection restored',
      'chat.stream.approval': 'Awaiting confirmation',
      'chat.stream.waiting_input': 'Awaiting input',
      'chat.stream.retry_wait': `retrying in ${params?.duration}`,
      'chat.stream.background_started': `Background task started${params?.detail || ''}`,
      'chat.stream.background_running': `Background task running${params?.detail || ''}`,
      'chat.stream.background_completed': `Background task completed${params?.detail || ''}`,
      'chat.stream.background_failed': `Background task failed${params?.detail || ''}`,
      'chat.stream.background_stopped': `Background task stopped${params?.detail || ''}`,
      'chat.stream.tool_progress': `Tool running${params?.detail || ''}`,
      'chat.stream.thinking': 'Thinking',
      'chat.activity_working': 'Working',
      'chat.stream.model_rerouted': `Switch model${params?.detail || ''}`,
      'chat.stream.authenticating': 'Verify identity',
      'chat.stream.rate_limit': 'Wait for service',
      'model.retrying': 'Retrying',
      'model.retrying_n': `Retrying (attempt ${params?.attempt})`,
      'chat.stream.context_history_start': 'Organize conversation history',
      'chat.stream.context_history_done': 'Conversation history organized',
      'chat.stream.context_history_failed': 'Could not organize conversation history',
      'chat.stream.context_active_start': 'Organize current task progress',
      'chat.stream.context_active_done': 'Current task progress organized',
      'chat.stream.context_active_failed': 'Could not organize current task progress',
      'chat.stream.runtime_total': `Total time ${params?.duration}`,
      'chat.stream.runtime_model': `model ${params?.duration}`,
      'chat.stream.runtime_tools': `tools ${params?.duration}`,
      'chat.stream.runtime_context': `conversation organization ${params?.duration}`,
      'chat.stream.runtime_retry': `retry wait ${params?.duration}`,
      'chat.stream.duration_s': `${params?.s}s`,
      'chat.stream.duration_ms': `${params?.m}m ${params?.s}s`,
      'chat.stream.duration_hms': `${params?.h}h ${params?.m}m ${params?.s}s`,
      'sidebar.bucket.today': 'Today',
      'sidebar.bucket.last30': 'Last 30 days',
      'sidebar.load_more_conversations': 'Load more',
      'sidebar.commander_running': `${params?.n} running`,
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

describe('sidebar running task counts', () => {
  it('shows the app-wide total on Commander and isolates Tasks and Project totals', () => {
    const context = loadConversationRenderer();
    const commanderChip: any = { hidden: true, textContent: '' };
    const tasksChip: any = { hidden: true, textContent: '' };
    const projectOneChip: any = {
      hidden: true,
      textContent: '',
      dataset: { projectRunningChip: 'p1' },
    };
    const projectTwoChip: any = {
      hidden: true,
      textContent: '',
      dataset: { projectRunningChip: 'p2' },
    };
    context.conversations.push(
      { conversation_id: 'c1', project_id: 'p1' },
      { conversation_id: 'c2', project_id: 'p1' },
      { conversation_id: 'c3', project_id: 'p2' },
      { conversation_id: 'c4', project_id: '' },
    );
    context.pendingConvs.set('c1', { aborted: false });
    context.pendingConvs.set('c2', { aborted: true });
    context.pendingConvs.set('c3', { aborted: false });
    // Recovery can expose group activity before pendingConvs is populated.
    context.groupBusyConvs.set('c4', true);
    context.document.getElementById = (id: string) => (
      id === 'commander-running-chip' ? commanderChip
        : id === 'tasks-running-chip' ? tasksChip
          : null
    );
    context.document.querySelectorAll = (selector: string) => (
      selector === '[data-project-running-chip]'
        ? [projectOneChip, projectTwoChip]
        : []
    );

    context._refreshSidebarRunningChips();

    expect(commanderChip).toMatchObject({ hidden: false, textContent: '3 running' });
    expect(tasksChip).toMatchObject({ hidden: false, textContent: '1 running' });
    expect(projectOneChip).toMatchObject({ hidden: false, textContent: '1 running' });
    expect(projectTwoChip).toMatchObject({ hidden: false, textContent: '1 running' });

    context.groupBusyConvs.delete('c4');
    context._refreshSidebarRunningChips();
    expect(tasksChip).toMatchObject({ hidden: true, textContent: '' });
    expect(commanderChip).toMatchObject({ hidden: false, textContent: '2 running' });
    expect(projectOneChip).toMatchObject({ hidden: false, textContent: '1 running' });
    expect(projectTwoChip).toMatchObject({ hidden: false, textContent: '1 running' });
  });

  it('clears the Project title count as soon as its last task stops', () => {
    const context = loadConversationRenderer();
    const projectChip: any = {
      hidden: true,
      textContent: '',
      dataset: { projectRunningChip: 'p1' },
    };
    context.conversations.push({ conversation_id: 'c1', project_id: 'p1' });
    context.pendingConvs.set('c1', { aborted: false });
    context.document.querySelectorAll = (selector: string) => (
      selector === '[data-project-running-chip]' ? [projectChip] : []
    );

    context._refreshSidebarRunningChips();
    expect(projectChip).toMatchObject({ hidden: false, textContent: '1 running' });

    context.pendingConvs.delete('c1');
    context._refreshSidebarRunningChips();
    expect(projectChip).toMatchObject({ hidden: true, textContent: '' });
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

  it('cancels an old turn pin before rebuilding history for a task switch', () => {
    const context = loadConversationRenderer();
    const frames: Function[] = [];
    const appended: any[] = [];
    const history = {
      isConnected: true,
      classList: { remove() {} },
      innerHTML: '',
      style: {
        scrollBehavior: '',
        removeProperty() {},
      },
      addEventListener() {},
      querySelector: () => null,
      appendChild(node: any) { appended.push(node); },
    } as any;
    const msg = { isConnected: true } as any;
    context.currentCid = 'c1';
    context.performance = performance;
    context.requestAnimationFrame = (fn: Function) => {
      frames.push(fn);
      return frames.length;
    };
    context.document.getElementById = (id: string) => (id === 'chat-history' ? history : null);
    context._ensureCreateAgentInlineObserver = () => {};
    context._refreshGroupMembers = async () => [];
    context.apiFetch = () => new Promise(() => {});

    context._pinMessageToTopWithDynamicSpacer(msg, history);
    expect(frames).toHaveLength(1);

    void context.loadConversationHistory('c1');
    frames.shift()?.();

    expect(history._scrollPinActive).toBe(false);
    expect(appended).toHaveLength(0);
  });

  it('recognizes a stale deleted-conversation result as recoverable', () => {
    const context = loadConversationRenderer();

    expect(context._isConversationMissingResponse({ ok: false, error: 'conversation not found' })).toBe(true);
    expect(context._isConversationMissingResponse({ ok: false, code: 'E_CONVERSATION_NOT_FOUND' })).toBe(true);
    expect(context._isConversationMissingResponse({ ok: false, error: 'database unavailable' })).toBe(false);
  });

  it('drops a missing current conversation and returns to the new-task view', async () => {
    const context = loadConversationRenderer();
    const views: string[] = [];
    context.currentCid = 'gone';
    context.conversations.push({ conversation_id: 'gone' }, { conversation_id: 'keep' });
    context.abortConvStream = () => {};
    context._forgetConvLocal = () => {};
    context.renderConversationList = () => {};
    context.setView = (view: string) => { views.push(view); context.currentCid = null; };
    context.loadConversations = async () => {};

    await context._recoverMissingConversation('gone');

    expect(context.conversations.map((item: any) => item.conversation_id)).toEqual(['keep']);
    expect(views).toEqual(['new-chat']);
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

  it('renders no status marker for an idle entry', () => {
    const context = loadConversationRenderer();
    const html = context._renderConversationSidebarItem({
      conversation_id: 'c1',
      title: 'Normal task',
    });

    expect(html).not.toContain('conv-item-status-dot');
    expect(html).not.toContain('conv-item-status-label');
  });

  it('places the live running icon to the left of an automation icon', () => {
    const context = loadConversationRenderer();
    const autoIcon: any = { kind: 'automation' };
    const title: any = { kind: 'title', parentElement: null };
    const badge: any = {
      kind: 'running',
      className: '',
      classList: { add() {} },
      innerHTML: '',
    };
    const row: any = {
      children: [autoIcon, title],
      insertBefore(node: any, anchor: any) {
        const anchorIndex = this.children.indexOf(anchor);
        this.children.splice(anchorIndex, 0, node);
      },
    };
    title.parentElement = row;
    const item = {
      querySelector(selector: string) {
        if (selector === '.conv-status-badge') return null;
        if (selector === '.conv-item-title') return title;
        if (selector === '.conv-item-row > .conv-item-auto-icon') return autoIcon;
        return null;
      },
    };
    context.document.querySelector = () => item;
    context.document.createElement = () => badge;
    context._getQueue = () => [];
    context.pendingConvs.set('c1', { aborted: false });

    context._updateConvSidebarBadge('c1');

    expect(row.children).toEqual([badge, autoIcon, title]);
  });

  it('shows a text label without a dot for an abnormal (blocked) status', () => {
    const context = loadConversationRenderer();
    const html = context._renderConversationSidebarItem({
      conversation_id: 'c1',
      title: 'Stuck task',
      status: 'blocked',
    });

    const labelIdx = html.indexOf('class="conv-item-status-label is-blocked"');
    const titleIdx = html.indexOf('class="conv-item-title"');
    const actionsIdx = html.indexOf('class="conv-item-actions"');

    expect(html).not.toContain('conv-item-status-dot');
    expect(labelIdx).toBeGreaterThan(titleIdx); // label after the title
    expect(labelIdx).toBeLessThan(actionsIdx); // and before the hover actions
    expect(html).toContain('>Blocked<');
  });

  it('never fabricates a status: unknown and normal values stay unadorned', () => {
    const context = loadConversationRenderer();
    const unknown = context._renderConversationSidebarItem({
      conversation_id: 'c1',
      title: 'Mystery',
      status: 'totally-made-up',
    });
    expect(unknown).not.toContain('conv-item-status-dot');
    expect(unknown).not.toContain('conv-item-status-label');

    const done = context._renderConversationSidebarItem({
      conversation_id: 'c2',
      title: 'Finished',
      status: 'done',
    });
    expect(done).not.toContain('conv-item-status-dot');
    expect(done).not.toContain('conv-item-status-label');
  });

  it('renders a failed label without a dot for a conversation marked failed in-session', () => {
    const context = loadConversationRenderer();
    // Simulate the in-session overlay set by the streaming controller onDone.
    vm.runInContext('_failedConvs.add("c1")', context);

    const html = context._renderConversationSidebarItem({
      conversation_id: 'c1',
      title: 'Analyze Google earnings',
    });

    expect(html).not.toContain('conv-item-status-dot');
    const labelIdx = html.indexOf('class="conv-item-status-label is-failed"');
    const titleIdx = html.indexOf('class="conv-item-title"');
    const actionsIdx = html.indexOf('class="conv-item-actions"');
    expect(labelIdx).toBeGreaterThan(titleIdx);
    expect(labelIdx).toBeLessThan(actionsIdx);
    expect(html).toContain('>Failed<');
  });

  it('failed overlay wins over a backend status and clears when the cid leaves the set', () => {
    const context = loadConversationRenderer();
    vm.runInContext('_failedConvs.add("c1")', context);
    // Even with a backend `status`, the in-session failure takes precedence.
    expect(context._convRowStatus({ conversation_id: 'c1', status: 'done' })).toBe('failed');

    vm.runInContext('_failedConvs.delete("c1")', context);
    expect(context._convRowStatus({ conversation_id: 'c1', status: 'done' })).toBe('done');
    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe('idle');
  });

  it('derives the failed mark from history: a persisted failure reply (failure_kind + danger text)', () => {
    const context = loadConversationRenderer();
    // Shape mirrors the on-disk `<cid>.jsonl` model/provider failure record.
    const history = [
      { from: 'user', text: '为什么自由现金会劣化' },
      {
        from: 'commander',
        failure_kind: 'model',
        failure_code: 'provider_error',
        text: '<span style="color:var(--danger)">⚠️ 模型调用失败：All configured model candidates failed</span>',
      },
    ];
    context._syncFailedFromHistory('c1', history);
    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe('failed');
  });

  it('uses the latest persisted message instead of a stale failed index status after reopen', () => {
    const context = loadConversationRenderer();
    vm.runInContext('_failedConvs.add("c1")', context);

    // A clean persisted reply is the user's durable result. A future/legacy
    // index may still carry an older failed status, but it must not override
    // what reopening the task just proved from history.
    context._syncFailedFromHistory('c1', [
      { from: 'user', text: 'hi' },
      { from: 'commander', text: 'Here is the answer.' },
    ]);
    expect(context._convRowStatus({ conversation_id: 'c1', status: 'failed' })).toBe('idle');

    // A trailing unanswered user message is pending, not failed. It also
    // neutralizes a stale failed index without pretending the turn settled.
    vm.runInContext('_failedConvs.add("c2")', context);
    context._syncFailedFromHistory('c2', [
      { from: 'commander', text: 'Prior reply.' },
      { from: 'user', text: 'follow-up, no reply yet' },
    ]);
    expect(context._convRowStatus({ conversation_id: 'c2', status: 'failed' })).toBe('idle');
  });

  it('does NOT flag a healthy reply that merely mentions error text (no structured failure_kind)', () => {
    const context = loadConversationRenderer();
    // A successful reply about the failure feature itself: contains danger
    // styling + the words "模型调用失败" but carries no `failure_kind`. Must stay idle.
    context._syncFailedFromHistory('c1', [
      { from: 'user', text: '把头像去掉' },
      {
        from: 'commander',
        text: '好的，已完成。异常态用 <span style="color:var(--danger)">模型调用失败</span> 的样式展示。',
      },
    ]);
    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe('idle');
  });

  it('_isStructuredFailure keys off failure_kind/failed/error only — never text content', () => {
    const context = loadConversationRenderer();
    expect(context._isStructuredFailure({ failure_kind: 'model' })).toBe(true);
    expect(context._isStructuredFailure({ failed: true })).toBe(true);
    expect(context._isStructuredFailure({ error: true })).toBe(true);
    // Danger-styled / error-mentioning TEXT with no structured flag → not failed.
    expect(context._isStructuredFailure({ text: '<span style="color:var(--danger)">模型调用失败</span>' })).toBe(false);
    expect(context._isStructuredFailure({})).toBe(false);
    expect(context._isStructuredFailure(null)).toBe(false);
  });

  it('marks a BACKGROUND conversation failed the moment its turn-end reply fails (no open needed)', () => {
    const context = loadConversationRenderer();
    // currentCid is '' in the harness, so 'bg' is a non-open background conv.
    context._handleGroupBusEvent('bg', null, {
      type: 'message',
      turn_end: true,
      msg: { from: 'commander', failure_kind: 'model', text: '⚠️ 模型调用失败' },
    });
    expect(context._convRowStatus({ conversation_id: 'bg' })).toBe('failed');
  });

  it('clears a background conversation when its latest turn-end reply is clean', () => {
    const context = loadConversationRenderer();
    vm.runInContext('_failedConvs.add("bg")', context);
    context._handleGroupBusEvent('bg', null, {
      type: 'message',
      turn_end: true,
      msg: { from: 'commander', text: 'All done successfully.' },
    });
    expect(context._convRowStatus({ conversation_id: 'bg' })).toBe('idle');
  });

  it.each([
    ['completed', 'idle'],
    ['waiting_input', 'idle'],
    ['cancelled', 'idle'],
    ['failed', 'failed'],
  ])('shows the user-visible task outcome for a canonical %s terminal', (status, expected) => {
    const context = loadConversationRenderer();
    vm.runInContext('_failedConvs.add("c1")', context);

    context._syncFailedFromTaskTerminal({
      type: 'terminal',
      conversation_id: 'c1',
      run_id: 'run-1',
      status,
      finished_at_ms: 2_000,
    });

    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe(expected);
  });

  it('does not let an older replayed terminal overwrite a newer terminal result', () => {
    const context = loadConversationRenderer();

    context._syncFailedFromTaskTerminal({
      type: 'terminal',
      conversation_id: 'c1',
      run_id: 'new-run',
      status: 'completed',
      finished_at_ms: 3_000,
    });
    context._syncFailedFromTaskTerminal({
      type: 'terminal',
      conversation_id: 'c1',
      run_id: 'old-run',
      status: 'failed',
      finished_at_ms: 2_000,
    });

    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe('idle');
  });

  it('does not let an older failed terminal overwrite a newer successful reply', () => {
    const context = loadConversationRenderer();
    context._handleGroupBusEvent('c1', null, {
      type: 'message',
      turn_end: true,
      turn_id: 'new-turn',
      msg: {
        from: 'commander',
        text: 'The task completed successfully.',
        ts: '2026-08-08T12:00:03.000Z',
      },
    });

    context._syncFailedFromTaskTerminal({
      type: 'terminal',
      conversation_id: 'c1',
      run_id: 'old-run',
      status: 'failed',
      finished_at_ms: new Date('2026-08-08T12:00:02.000Z').getTime(),
    });

    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe('idle');
  });

  it('keeps canonical completion authoritative over a stale failed index row', () => {
    const context = loadConversationRenderer();
    context._syncFailedFromTaskTerminal({
      type: 'terminal',
      conversation_id: 'c1',
      run_id: 'run-1',
      status: 'completed',
      finished_at_ms: 2_000,
    });

    expect(context._convRowStatus({ conversation_id: 'c1', status: 'failed' })).toBe('idle');
  });

  it('ignores malformed and cross-conversation terminals without clearing a real failure', () => {
    const context = loadConversationRenderer();
    context._syncFailedFromTaskTerminal({
      type: 'terminal',
      conversation_id: 'c1',
      run_id: 'failed-run',
      status: 'failed',
      finished_at_ms: 2_000,
    });

    context._syncFailedFromTaskTerminal({
      type: 'terminal',
      conversation_id: 'c1',
      run_id: 'malformed-run',
      status: 'mystery',
      finished_at_ms: 3_000,
    });
    context._syncFailedFromTaskTerminal({
      type: 'terminal',
      conversation_id: 'c2',
      run_id: 'other-run',
      status: 'completed',
      finished_at_ms: 4_000,
    });

    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe('failed');
    expect(context._convRowStatus({ conversation_id: 'c2' })).toBe('idle');
  });

  it('does not mark on a mid-turn (non turn-end) message', () => {
    const context = loadConversationRenderer();
    context._handleGroupBusEvent('bg', null, {
      type: 'message',
      turn_end: false,
      msg: { from: 'commander', failure_kind: 'model', text: 'partial' },
    });
    expect(context._convRowStatus({ conversation_id: 'bg' })).toBe('idle');
  });

  it('looks only at the last reply: a clean latest reply clears an earlier failure', () => {
    const context = loadConversationRenderer();
    context._syncFailedFromHistory('c1', [
      { from: 'user', text: 'q1' },
      { from: 'commander', failure_kind: 'model', text: '⚠️ 模型调用失败' },
      { from: 'user', text: 'q2 (retry)' },
      { from: 'commander', text: 'Here is the successful answer.' },
    ]);
    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe('idle');
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

  it('renders old time buckets as static sections instead of nested collapsibles', () => {
    const context = loadConversationRenderer();
    context.timeBucket = () => 'last30';

    const html = context._renderConversationTimeBucketList([
      {
        conversation_id: 'old1',
        title: 'Old task',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
    ]);

    expect(html).toContain('Last 30 days');
    expect(html).toContain('Old task');
    expect(html).not.toContain('data-conv-bucket-toggle');
    expect(html).not.toContain('conv-list-section-caret');
    expect(html).not.toContain('conv-list-section-count');
  });

  it('groups loaded rows by time without inserting pagination inside a bucket', () => {
    const context = loadConversationRenderer();
    context.timeBucket = (iso: string) => iso.startsWith('2025') ? 'last30' : 'today';

    const html = context._renderConversationTimeBucketList([
      { conversation_id: 'recent', title: 'Recent task', updated_at: '2026-05-01T00:00:00.000Z' },
      { conversation_id: 'old', title: 'Old task', updated_at: '2025-05-01T00:00:00.000Z' },
    ]);

    expect(html).toContain('Today');
    expect(html).toContain('Last 30 days');
    expect(html).toContain('Recent task');
    expect(html).toContain('Old task');
    expect(html).not.toContain('Load more');
    expect(html).not.toContain('data-conv-bucket-toggle');
    expect(html).not.toContain('data-conv-bucket-more');
  });

  it('resets a project list to its first 10 tasks when reopened', async () => {
    const context = loadConversationRenderer();
    const requestedOffsets: number[] = [];
    context.apiFetch = async (url: string) => {
      const offset = Number(new URL(url, 'https://orkas.local').searchParams.get('offset'));
      requestedOffsets.push(offset);
      return {
        json: async () => ({
          ok: true,
          conversations: Array.from({ length: 10 }, (_, index) => ({
            conversation_id: `p1-${offset + index}`,
            project_id: 'p1',
            title: `Task ${offset + index}`,
            updated_at: '2026-05-01T00:00:00.000Z',
          })),
          total: 25,
          next_offset: offset + 10 < 25 ? offset + 10 : null,
        }),
      };
    };
    context.conversations = Array.from({ length: 20 }, (_, index) => ({
      conversation_id: `old-p1-${index}`,
      project_id: 'p1',
    }));
    vm.runInContext(`
      __renderCalls = 0;
      renderConversationList = function() { __renderCalls += 1; };
      _conversationProjectPages.set('p1', { initialized: true, total: 25, nextOffset: 20 });
    `, context);

    await context.loadConversationProject('p1', { reset: true });

    expect(requestedOffsets).toEqual([0]);
    expect(context.conversations).toHaveLength(10);
    expect(context.__renderCalls).toBe(1);
    expect(vm.runInContext('_conversationProjectPages.get("p1").nextOffset', context)).toBe(10);
  });

  it('resets the unified non-project timeline to its first 10 rows when reopened', async () => {
    const context = loadConversationRenderer();
    const requestedOffsets: number[] = [];
    context.apiFetch = async (url: string) => {
      const parsed = new URL(url, 'https://orkas.local');
      const offset = Number(parsed.searchParams.get('offset'));
      requestedOffsets.push(offset);
      return {
        json: async () => ({
          ok: true,
          conversations: Array.from({ length: 10 }, (_, index) => ({
            conversation_id: `outside-${offset + index}`,
            title: `Task ${offset + index}`,
            updated_at: '2026-05-01T00:00:00.000Z',
          })),
          total: 25,
          next_offset: offset + 10 < 25 ? offset + 10 : null,
        }),
      };
    };
    context.conversations = Array.from({ length: 20 }, (_, index) => ({
      conversation_id: `old-outside-${index}`,
      title: `Old task ${index}`,
    }));
    vm.runInContext(`
      __renderCalls = 0;
      renderConversationList = function() { __renderCalls += 1; };
      _unprojectedConversationPage.initialized = true;
      _unprojectedConversationPage.total = 25;
      _unprojectedConversationPage.nextOffset = 20;
      _unprojectedConversationPage.loading = false;
    `, context);

    await context._resetUnprojectedConversations();

    expect(requestedOffsets).toEqual([0]);
    expect(context.conversations).toHaveLength(10);
    expect(context.__renderCalls).toBe(1);
    expect(vm.runInContext('_unprojectedConversationPage.nextOffset', context)).toBe(10);
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

describe('conversation cross-conversation event isolation', () => {
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
  });

  it('does not promote a background task in the sidebar when its reply lands', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'visible';
    context.conversations = [
      {
        conversation_id: 'visible',
        last_active_at: '2026-07-30T12:00:00.000Z',
      },
      {
        conversation_id: 'background',
        last_active_at: '2026-07-30T10:00:00.000Z',
      },
    ];
    context.__renderCalls = 0;
    vm.runInContext(`
      renderConversationList = function() { __renderCalls += 1; };
      appendChatMessage = function() { return null; };
    `, context);

    context._handleGroupBusEvent('background', null, {
      type: 'message',
      cid: 'background',
      turn_id: 'turn-1',
      turn_end: true,
      msg: {
        id: 'message-1',
        ts: '2026-07-30T11:00:00.000Z',
        from: 'agent-1',
        to: ['user'],
        text: 'done',
      },
    });

    expect(context.conversations.map((item: any) => item.conversation_id))
      .toEqual(['visible', 'background']);
    expect(context.conversations[1].last_active_at).toBe('2026-07-30T11:00:00.000Z');
    expect(context.__renderCalls).toBe(1);

    // Opening the conversation rebuilds it from jsonl; there is no buffered
    // backlog to replay, so ordering must already be settled by the line above.
    context.currentCid = 'background';
    expect(context.conversations.map((item: any) => item.conversation_id))
      .toEqual(['visible', 'background']);
    expect(context.conversations[1].last_active_at).toBe('2026-07-30T11:00:00.000Z');
    expect(context.__renderCalls).toBe(1);
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

  it('keeps the process rail pinned across non-user layout growth', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.scrollTop = 800;

    context._bindProcessStickToBottom(el);
    el.scrollHeight = 1260;
    context._stickProcessBottomIfPinned(el);

    expect(el._processStickyBound).toBe(true);
    expect(el._processStickyEnabled).toBe(true);
    expect(el.scrollTop).toBe(1260);
  });

  it('pauses process-rail following after an explicit user scroll-up', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.scrollTop = 800;

    context._bindProcessStickToBottom(el);
    el.dispatch('wheel', { deltaY: -120 });
    el.scrollHeight = 1260;
    context._stickProcessBottomIfPinned(el);

    expect(el._processStickyEnabled).toBe(false);
    expect(el._processStickyUserPaused).toBe(true);
    expect(el.scrollTop).toBe(800);
  });

  it('resumes process-rail following after the user returns to the bottom', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    el.scrollTop = 800;

    context._bindProcessStickToBottom(el);
    el.dispatch('wheel', { deltaY: -120 });
    el.scrollHeight = 1260;
    el.scrollTop = 860;
    el.dispatch('scroll');
    el.scrollHeight = 1320;
    context._stickProcessBottomIfPinned(el);

    expect(el._processStickyEnabled).toBe(true);
    expect(el._processStickyUserPaused).toBe(false);
    expect(el.scrollTop).toBe(1320);
  });

  it('binds user scroll gestures when a fresh history schedules its first send-time pin', () => {
    const context = loadConversationRenderer();
    const frames: Function[] = [];
    context.requestAnimationFrame = (fn: Function) => {
      frames.push(fn);
      return frames.length;
    };
    const el = fakeScrollEl();
    el.querySelector = () => null;
    const msg = { isConnected: true } as any;

    context._pinMessageToTopWithDynamicSpacer(msg, el);

    // A new task enters the conversation with skipLoad=true, so history
    // hydration never gets a chance to install these gesture listeners.
    // The send-time pin must make its own scroll surface interactive before
    // the delayed spacer is activated.
    expect(el._stickyBound).toBe(true);
  });

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

  it('releases the send-time scroll pin when a bare scroll moves away from its target', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    const spacer = {
      removed: false,
      remove() { this.removed = true; },
    };
    el._scrollPinActive = true;
    el._scrollPinTargetTop = 500;
    el.querySelector = (selector: string) => (
      selector === ':scope > .chat-scroll-spacer' && !spacer.removed ? spacer : null
    );

    context._bindStickToBottom(el);
    el.scrollTop = 320;
    el.dispatch('scroll');

    expect(spacer.removed).toBe(true);
    expect(el._scrollPinActive).toBe(false);
    expect(el._scrollPinTargetTop).toBeUndefined();
    expect(el._stickyEnabled).toBe(false);
    expect(el._stickyUserPaused).toBe(true);
    expect(el.scrollTop).toBe(320);
  });

  it('keeps the send-time scroll pin for its own delayed scroll event', () => {
    const context = loadConversationRenderer();
    const el = fakeScrollEl();
    const spacer = {
      removed: false,
      remove() { this.removed = true; },
    };
    el._scrollPinActive = true;
    el._scrollPinTargetTop = 500;
    el.querySelector = (selector: string) => (
      selector === ':scope > .chat-scroll-spacer' && !spacer.removed ? spacer : null
    );

    context._bindStickToBottom(el);
    el.dispatch('scroll');

    expect(spacer.removed).toBe(false);
    expect(el._scrollPinActive).toBe(true);
    expect(el._scrollPinTargetTop).toBe(500);
  });

  it('cancels a delayed send-time pin when the stream settles before layout frames run', () => {
    const context = loadConversationRenderer();
    const frames: Function[] = [];
    context.requestAnimationFrame = (fn: Function) => {
      frames.push(fn);
      return frames.length;
    };
    const appended: any[] = [];
    const el = {
      isConnected: true,
      _stickyEnabled: true,
      style: {
        scrollBehavior: '',
        removeProperty() {},
      },
      addEventListener() {},
      querySelector: () => null,
      appendChild(node: any) { appended.push(node); },
    } as any;
    const msg = { isConnected: true } as any;

    context._pinMessageToTopWithDynamicSpacer(msg, el);
    expect(frames).toHaveLength(1);

    // Mirrors createChatController's terminal finally block. The already
    // queued rAF is intentionally still invoked below to prove the epoch
    // guard works even when the host cannot cancel it.
    context._setChatScrollOffset(false, el);
    frames.shift()?.();

    expect(appended).toHaveLength(0);
    expect(el._scrollPinActive).toBe(false);
    expect(el._scrollPinInnerRaf).toBeNull();
  });

  it('clears the active task scroll pin before terminal settlement drains its queue', () => {
    const context = loadConversationRenderer();
    const spacer = {
      removed: false,
      remove() { this.removed = true; },
    };
    const history = {
      _scrollPinActive: true,
      querySelector: (selector: string) => (
        selector === ':scope > .chat-scroll-spacer' && !spacer.removed ? spacer : null
      ),
    } as any;
    let pinAtQueueDrain: boolean | null = null;
    context.currentCid = 'c1';
    context.pendingConvs.set('c1', { aborted: false });
    context.document.getElementById = (id: string) => (id === 'chat-history' ? history : null);
    context._stopRuntimeActorRecovery = () => {};
    context._stopGroupEventObserver = () => {};
    context.isGroupConversationBusy = () => false;
    context.stopPolling = () => {};
    context._updateConvSidebarBadge = () => {};
    context._settleDanglingActorPlaceholders = () => {};
    context._updateConvSendUI = () => {};
    context._dispatchNextQueued = () => {
      pinAtQueueDrain = history._scrollPinActive;
    };

    context._finishStreamingMsg('c1');

    expect(spacer.removed).toBe(true);
    expect(history._scrollPinActive).toBe(false);
    expect(pinAtQueueDrain).toBe(false);
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
  // Matching used to fall back to a sender+second-timestamp+text-hash
  // signature, which two genuinely different replies can share. Identity is now
  // the record's render key, so a live segment row is matched exactly and a
  // look-alike from another turn is not.
  it('matches a live rendered reply by its render key, not by look-alike content', () => {
    const context = loadConversationRenderer();
    const gm = {
      id: 'm-final',
      from: 'commander',
      turn_id: 'turn-1',
      seg: 0,
      text: 'Finished answer',
      ts: '2026-06-28T11:20:00.000Z',
    };
    const live: any = { dataset: { renderKey: 's:turn-1:0' } };
    const lookAlike: any = { dataset: { renderKey: 's:turn-2:0' } };
    const container = {
      querySelector(selector: string) {
        if (selector.includes('data-msg-id')) return null;
        return this.querySelectorAll(selector)[0] || null;
      },
      querySelectorAll(selector: string) {
        const renderKey = selector.match(/data-render-key="([^"]+)"/)?.[1];
        if (!renderKey) return [];
        return [live, lookAlike].filter((el) => el.dataset.renderKey === renderKey);
      },
    };

    const found = context._findRenderedGroupMessage(container, gm);
    if (found) context._syncRenderedGroupMessageIdentity(found, gm);

    expect(found).toBe(live);
    expect(live.dataset.msgId).toBe('m-final');
    expect(lookAlike.dataset.msgId).toBeUndefined();
  });

  // Two sends can be in flight at once (queue drain, retry) and can carry the
  // same text within the same second. The positional fallback claims whichever
  // un-stamped user bubble is last, so the second record would re-claim the
  // first bubble and the first send's bubble would never get its id. The
  // renderer-generated `client_msg_id`, echoed back by the bus, makes each
  // claim exact.
  it('claims each concurrent optimistic user bubble by its own client id', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'c1';

    const mk = (clientMsgId: string) => ({
      className: 'chat-message user',
      dataset: { clientMsgId },
      parentElement: null as any,
    });
    const first = mk('c-aaa');
    const second = mk('c-bbb');
    const container: any = {
      children: [first, second],
      querySelector(selector: string) {
        const byMsgId = selector.match(/data-msg-id="([^"]+)"/)?.[1];
        if (byMsgId) return this.children.find((el: any) => el.dataset.msgId === byMsgId) || null;
        const byClientId = selector.match(/data-client-msg-id="([^"]+)"/)?.[1];
        if (byClientId) {
          return this.children.find((el: any) => el.dataset.clientMsgId === byClientId
            && !el.dataset.msgId) || null;
        }
        return null;
      },
      querySelectorAll: () => [],
    };
    first.parentElement = container;
    second.parentElement = container;
    context.document.getElementById = (id: string) => (id === 'chat-history' ? container : null);
    context._moveUserBeforeOrphanLivePlaceholder = () => {};

    const sameText = 'run it';
    const sameTs = '2026-07-30T16:42:37';
    expect(context._claimPersistedUserMessage('c1', {
      id: 'u-second', from: 'user', text: sameText, ts: sameTs, client_msg_id: 'c-bbb',
    })).toBe(true);
    expect(context._claimPersistedUserMessage('c1', {
      id: 'u-first', from: 'user', text: sameText, ts: sameTs, client_msg_id: 'c-aaa',
    })).toBe(true);

    // Each bubble ends up with its own persisted id — no cross-claim, and no
    // bubble left without one.
    expect(first.dataset.msgId).toBe('u-first');
    expect(second.dataset.msgId).toBe('u-second');
  });

  it('repositions queued user and finalized AI bubbles when persisted timestamps arrive', () => {
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

    const user = makeMsg('chat-message user', {
      convPair: '1',
      ts: '900',
      retryContent: 'queued follow-up',
    });
    const laterUser = makeMsg('chat-message user', {
      convPair: '2',
      ts: '950',
      retryContent: 'later queued turn',
    });
    const assistant = makeMsg('chat-message assistant', { msgId: 'a1', ts: '1000' });
    const container: any = {
      children: [user, laterUser, assistant],
      querySelector(selector: string) {
        if (selector.includes('data-msg-id')) {
          const id = selector.match(/data-msg-id="([^"]+)"/)?.[1];
          return this.children.find((el: any) => el.dataset.msgId === id) || null;
        }
        if (selector === ':scope > .chat-scroll-spacer') return null;
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector === '.chat-message.user[data-conv-pair]:not([data-msg-id]):not([data-client-msg-id])') {
          return this.children.filter((el: any) => el.className.includes('user')
            && !!el.dataset.convPair && !el.dataset.msgId && !el.dataset.clientMsgId);
        }
        if (selector === '.chat-message.user:not([data-msg-id]):not([data-client-msg-id])') {
          return this.children.filter((el: any) => el.className.includes('user')
            && !el.dataset.msgId && !el.dataset.clientMsgId);
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
    laterUser.parentElement = container;
    assistant.parentElement = container;
    context.document.getElementById = (id: string) => (id === 'chat-history' ? container : null);

    const claimed = context._claimPersistedUserMessage('c1', {
      id: 'u1',
      from: 'user',
      text: 'queued follow-up',
      ts: 1100,
    });

    expect(claimed).toBe(true);
    expect(container.children).toEqual([laterUser, assistant, user]);
    expect(user.dataset.msgId).toBe('u1');
    expect(user.dataset.fromActor).toBe('user');
    expect(user.dataset.ts).toBe('1100');
    expect(laterUser.dataset.msgId).toBeUndefined();

    context._syncRenderedGroupMessageIdentity(assistant, {
      id: 'a1',
      from: 'commander',
      ts: 1200,
    });
    expect(container.children).toEqual([laterUser, user, assistant]);
    expect(assistant.dataset.ts).toBe('1200');

    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/conversation.js'),
      'utf8',
    );
    const finalizeStart = source.indexOf('function _finalizeActorPlaceholder');
    const finalizeEnd = source.indexOf('\nfunction ', finalizeStart + 1);
    const finalizeBody = source.slice(finalizeStart, finalizeEnd);
    expect(finalizeBody).toContain('_syncRenderedGroupMessageIdentity(ph, gm);');
  });

  it('moves a live AI bubble once after newer send-now user activity', () => {
    const context = loadConversationRenderer();

    function makeMsg(role: 'user' | 'assistant', dataset: Record<string, string>) {
      const classes = new Set(['chat-message', role]);
      const el: any = {
        className: `chat-message ${role}`,
        classList: { contains: (name: string) => classes.has(name) },
        dataset: { ...dataset },
        parentElement: null,
        matches(selector: string) {
          return selector === '.chat-message[data-ts]' && this.dataset.ts != null;
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

    const assistant = makeMsg('assistant', { placeholder: '1', ts: '1000' });
    const firstUser = makeMsg('user', { ts: '1100' });
    const secondUser = makeMsg('user', { ts: '1200' });
    let timestampScans = 0;
    let domMoves = 0;
    const container: any = {
      children: [assistant, firstUser, secondUser],
      querySelector(selector: string) {
        if (selector === ':scope > .chat-scroll-spacer') return null;
        return null;
      },
      querySelectorAll(selector: string) {
        if (selector === ':scope > .chat-message[data-ts]') {
          timestampScans += 1;
          return this.children.filter((el: any) => el.dataset.ts != null);
        }
        return [];
      },
      insertBefore(el: any, ref: any) {
        domMoves += 1;
        const oldIdx = this.children.indexOf(el);
        if (oldIdx >= 0) this.children.splice(oldIdx, 1);
        const refIdx = this.children.indexOf(ref);
        this.children.splice(refIdx >= 0 ? refIdx : this.children.length, 0, el);
        el.parentElement = this;
      },
      appendChild(el: any) {
        domMoves += 1;
        const oldIdx = this.children.indexOf(el);
        if (oldIdx >= 0) this.children.splice(oldIdx, 1);
        this.children.push(el);
        el.parentElement = this;
      },
    };
    for (const el of container.children) el.parentElement = container;

    // Coalesce multiple user inserts into the newest boundary. The first
    // visible AI update crosses both rows with one timestamp scan/DOM move.
    expect(context._markEarlierLiveMessagesForUser(container, firstUser)).toBe(1);
    expect(context._markEarlierLiveMessagesForUser(container, secondUser)).toBe(1);
    expect(assistant.dataset.activitySortFloor).toBe('1200');
    expect(context._advanceStreamingMessageActivityPosition(assistant, 1150)).toBe(true);
    expect(container.children).toEqual([firstUser, secondUser, assistant]);
    expect(assistant.dataset.ts).toBe('1201');
    expect(timestampScans).toBe(1);
    expect(domMoves).toBe(1);

    // Token updates after the row is current take the constant-time no-op path:
    // no history scan, no DOM mutation, and no synthetic timestamp churn.
    expect(context._advanceStreamingMessageActivityPosition(assistant, 1300)).toBe(false);
    expect(assistant.dataset.ts).toBe('1201');
    expect(timestampScans).toBe(1);
    expect(domMoves).toBe(1);
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
      style: {
        properties: new Map([
          ['--chat-image-natural-width', '900px'],
          ['--chat-image-aspect-ratio', '900 / 1600'],
        ]),
        getPropertyValue(name: string) { return this.properties.get(name) || ''; },
      },
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
    expect(existingShell.style.getPropertyValue('--chat-image-natural-width')).toBe('900px');
    expect(existingShell.style.getPropertyValue('--chat-image-aspect-ratio')).toBe('900 / 1600');
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

  it('reuses a hydrated inline HTML frame across streaming markdown repaints', () => {
    const context = loadConversationRenderer();
    const src = 'chat-media://local/Users/test/poster.html';
    const existingHost = {
      dataset: { htmlEmbedHydrated: '1' },
      getAttribute(name: string) { return name === 'data-html-src' ? src : ''; },
    };
    let replacement: unknown = null;
    const freshHost = {
      getAttribute(name: string) { return name === 'data-html-src' ? src : ''; },
      replaceWith(node: unknown) { replacement = node; },
    };
    const freshRoot = {
      querySelectorAll(selector: string) {
        if (selector === '.chat-md-html-embed') return [freshHost];
        return [];
      },
    };
    const stable = new Map([[context._streamingStableMediaKey('html', src), [existingHost]]]);

    context._streamingRestoreStableMedia(freshRoot, stable);

    expect(replacement).toBe(existingHost);
    expect(existingHost.dataset.htmlEmbedHydrated).toBe('1');
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

  it('hydrates inline HTML outputs immediately after a streaming paint', () => {
    const context = loadConversationRenderer();
    const hydrate = vi.fn();
    context._hydrateMarkdownHtmlEmbeds = hydrate;
    context.renderMarkdownFull = () => '<span data-chat-md-html-embed="1"></span>';
    const finalEl = { innerHTML: '', isConnected: true };
    const msg = { dataset: {}, parentElement: null };

    context._paintStreamingFinalMarkdown(msg, finalEl, '![poster](preview.html)');

    expect(hydrate).toHaveBeenCalledOnce();
    expect(hydrate).toHaveBeenCalledWith(finalEl);
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
  it('distinguishes file metadata lookup from file content reading', () => {
    const context = loadConversationRenderer();
    const path = '/Users/test/private/Orkas PPT.pdf';

    expect([
      context._formatEventLine({
        stream: 'tool',
        data: { phase: 'start', name: 'stat_file', arguments: { path } },
      }),
      context._formatEventLine({
        stream: 'tool',
        data: { phase: 'end', name: 'stat_file', arguments: { path } },
      }),
      context._formatEventLine({
        stream: 'tool',
        data: { phase: 'start', name: 'read_file', arguments: { path } },
      }),
      context._formatEventLine({
        stream: 'tool',
        data: { phase: 'end', name: 'read_file', arguments: { path } },
      }),
    ]).toEqual([
      'Started · Get file info · Orkas PPT.pdf',
      'Get file info · Orkas PPT.pdf · Done',
      'Started · Read file · Orkas PPT.pdf',
      'Read file · Orkas PPT.pdf · Done',
    ]);
  });

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

    expect(line).toBe('Started · View agent · 学习路径设计师');
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

    expect(line).toBe('Started · View agent · 学习路径设计师');
  });

  it('simplifies hidden system skill paths in legacy start events', () => {
    const context = loadConversationRenderer();
    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'read_file',
        arguments: {
          path: '/Users/user/.orkas/data/u1/local/system/skills/agent-creator/SKILL.md',
        },
      },
    });

    expect(line).toBe('Started · View skill · agent-creator');
    expect(line).not.toContain('/Users/user/.orkas');
  });

  it('uses system skill metadata instead of a persisted-output marker on completion', () => {
    const context = loadConversationRenderer();
    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end',
        name: 'read_file',
        skill_id: 'agent-creator',
        skill_name: 'agent-creator',
        skill_system: 'system',
        skill_file: 'SKILL.md',
        result_preview: '<persisted-output ref="read_file.deadbeef" tool="read_file" size="41420">',
      },
    });

    expect(line).toBe('View skill · agent-creator · Done');
    expect(line).not.toContain('persisted-output');
  });

  it('simplifies platform agent-private skill paths in legacy events', () => {
    const context = loadConversationRenderer();
    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'read_file',
        arguments: {
          path: '/Users/user/.orkas/data/u1/local/marketplace/agents/79df9cc89f5f/skills/stage-plan/SKILL.md',
        },
      },
    });

    expect(line).toBe('Started · View skill · stage-plan');
    expect(line).not.toContain('79df9cc89f5f/skills');
  });

  it('keeps Skill and Agent semantics for delete-file actions', () => {
    const context = loadConversationRenderer();
    context._agentsCache = [{ agent_id: '4430ca181349', name: 'Data Analyst' }];

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start', name: 'delete_file',
        arguments: {
          path: '/Users/test/.orkas/data/u1/local/system/skills/Product Design/SKILL.md',
        },
      },
    })).toBe('Started · Delete skill · Product Design');
    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start', name: 'delete_file',
        arguments: {
          path: '/Users/test/.orkas/data/u1/local/marketplace/agents/4430ca181349/agent.json',
        },
      },
    })).toBe('Started · Delete agent · Data Analyst');
  });

  it('keeps project-relative file paths but reduces absolute paths to a filename', () => {
    const context = loadConversationRenderer();

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'use',
        tool: 'Read',
        input: { file_path: 'src/app.ts' },
      },
    })).toBe('Read file · src/app.ts');
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'use',
        tool: 'Read',
        input: { file_path: '/Users/test/private/project/src/app.ts' },
      },
    })).toBe('Read file · app.ts');
  });

  it('shows changed filenames from existing Codex file-change events and apply_patch inputs', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();
    const cliFileChange = {
      stream: 'cli',
      data: {
        type: 'file-change',
        paths: ['src/app.ts', '/Users/test/private/project/src/theme.css'],
      },
    };

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'use',
        tool: 'patch_apply',
        callId: 'patch-1',
      },
    }, displayContext)).toBeNull();
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'result',
        tool: 'patch_apply',
        callId: 'patch-1',
      },
    }, displayContext)).toBeNull();
    const cliFileChangeLine = context._formatEventLine(cliFileChange, displayContext);
    expect(cliFileChangeLine).toBe('Edit file · src/app.ts, theme.css · Done');
    expect(context._eventProcessKind(cliFileChange, cliFileChangeLine)).toBe('patch');
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'file-change',
        paths: ['src/app.ts', '/Users/test/private/project/src/theme.css'],
      },
    }, displayContext)).toBeNull();
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'file-change',
        changes: [{ path: 'src/new-file.ts', kind: 'add' }],
      },
    }, displayContext)).toBe('Edit file · src/new-file.ts · Done');

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'apply_patch',
        arguments: {
          patch: [
            '*** Begin Patch',
            '*** Update File: src/settings.ts',
            '@@',
            '-old',
            '+new',
            '*** End Patch',
          ].join('\n'),
        },
      },
    })).toBe('Started · Edit file · src/settings.ts');

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'apply_patch',
        arguments: {
          patch: [
            '*** Begin Patch',
            '*** Update File: src/old-name.ts',
            '*** Move to: src/new-name.ts',
            '*** End Patch',
          ].join('\n'),
        },
      },
    })).toBe('Started · Edit file · src/old-name.ts, src/new-name.ts');
  });

  it('renders cumulative Codex file changes once in the live process rail', () => {
    const context = loadConversationRenderer();
    const rows: Array<{ line: string; kind: string }> = [];
    context._streamingAppendProgress = (_msg: unknown, line: string, kind: string) => {
      rows.push({ line, kind });
    };
    const msg = {};

    context._renderAgentEvent(msg, {
      stream: 'cli',
      data: { type: 'file-change', paths: ['src/app.ts'] },
    });
    context._renderAgentEvent(msg, {
      stream: 'cli',
      data: { type: 'file-change', paths: ['src/app.ts', 'src/theme.css'] },
    });

    expect(rows).toEqual([
      { line: 'Edit file · src/app.ts · Done', kind: 'patch' },
      { line: 'Edit file · src/theme.css · Done', kind: 'patch' },
    ]);
  });

  it.each([
    ['zh', '查看技能 · Product Design'],
    ['en', 'View skill · Product Design'],
    ['ja', 'スキルを確認 · Product Design'],
    ['pt', 'Ver habilidade · Product Design'],
  ])('localizes the action in %s without translating the Skill display name', (language, expected) => {
    const context = loadConversationRenderer();
    const locale = JSON.parse(fs.readFileSync(
      path.join(__dirname, `../../src/renderer/locales/${language}.json`),
      'utf8',
    ));
    context.t = (key: string, params: Record<string, unknown> = {}) => {
      let value = String(locale[key] || key);
      for (const [name, replacement] of Object.entries(params)) {
        value = value.replaceAll(`{${name}}`, String(replacement ?? ''));
      }
      return value;
    };
    context._skillsCache = [{ id: 'product-design', name: 'Product Design' }];

    const line = context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'use',
        tool: 'Read',
        callId: 'skill-read',
        input: {
          file_path: '/Users/test/.orkas/data/u1/cloud/skills/product-design/SKILL.md',
        },
      },
    }, context._createProcessDisplayContext());

    expect(line).toBe(expected);
  });
});

describe('conversation execution plan presentation', () => {
  it('keeps a plan action visible when an adapter omits the plan details', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        id: 'plan-without-details',
        name: 'manage_execution_plan',
        arguments: { action: 'update' },
      },
    }, displayContext)).toBeNull();
    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end',
        id: 'plan-without-details',
        name: 'manage_execution_plan',
        output: '{"ok":true}',
      },
    }, displayContext)).toBe('Update plan');
    expect(context._formatEventLine({
      stream: 'plan',
      data: { phase: 'progress' },
    }, displayContext)).toBe('Update plan');
    expect(context._formatEventLine({
      stream: 'cli',
      data: { type: 'status', status: 'plan-updated' },
    }, displayContext)).toBe('Update plan');
  });

  it('adds the concrete plan content to the existing process action', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();
    const start = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        id: 'plan-visible',
        name: 'manage_execution_plan',
        arguments: {
          action: 'update',
          plan: [
            { step: 'Inspect the existing process UI', status: 'completed' },
            { step: 'Show the plan content on the action', status: 'in_progress' },
          ],
        },
      },
    }, displayContext);
    const result = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end',
        id: 'plan-visible',
        name: 'manage_execution_plan',
        output: '{"ok":true}',
      },
    }, displayContext);

    expect(start).toBe([
      'Create plan · Inspect the existing process UI',
      'Create plan · Show the plan content on the action',
    ].join('\n'));
    expect(result).toBeNull();
  });

  it('reads plan content from the core input field used by alternate event adapters', () => {
    const context = loadConversationRenderer();
    const event = {
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'update_plan',
        input: {
          plan: [
            { step: 'Inspect the existing process UI', status: 'completed' },
            { step: 'Show the plan content on the action', status: 'in_progress' },
          ],
        },
      },
    };

    expect(context._formatEventLine(event, context._createProcessDisplayContext())).toBe([
      'Create plan · Inspect the existing process UI',
      'Create plan · Show the plan content on the action',
    ].join('\n'));
    expect(context._isProcessPlanEvent(event)).toBe(true);
  });

  it('uses update plan only when an existing plan structure changes', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'manage_execution_plan',
        arguments: {
          action: 'update',
          plan: [{ step: 'Inspect the existing process UI', status: 'in_progress' }],
        },
      },
    }, displayContext);

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'manage_execution_plan',
        arguments: {
          action: 'update',
          plan: [
            { step: 'Inspect the existing process UI', status: 'completed' },
            { step: 'Verify the result', status: 'in_progress' },
          ],
        },
      },
    }, displayContext)).toBe([
      'Update plan · Inspect the existing process UI',
      'Update plan · Verify the result',
    ].join('\n'));
  });

  it('shows the concrete plan when only the successful result event is available', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();
    const result = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end',
        id: 'plan-result-only',
        name: 'manage_execution_plan',
        output: JSON.stringify({
          ok: true,
          action: 'update',
          steps: [
            { id: 1, step: 'Inspect the existing process UI', status: 'completed' },
            { id: 2, step: 'Show the plan content on the action', status: 'in_progress' },
          ],
        }),
      },
    }, displayContext);

    expect(result).toBe([
      'Create plan · Inspect the existing process UI',
      'Create plan · Show the plan content on the action',
    ].join('\n'));
  });

  it('recognizes a CLI tool_result containing a plan as plan content', () => {
    const context = loadConversationRenderer();
    const event = {
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'result',
        tool: 'tool_result',
        output: JSON.stringify({
          ok: true,
          action: 'update',
          steps: [
            { id: 1, step: 'Inspect the existing process UI', status: 'completed' },
            { id: 2, step: 'Show the plan content on the action', status: 'in_progress' },
          ],
        }),
      },
    };
    const result = context._formatEventLine(event, context._createProcessDisplayContext());

    expect(result).toBe([
      'Create plan · Inspect the existing process UI',
      'Create plan · Show the plan content on the action',
    ].join('\n'));
    expect(context._eventProcessKind(event, result)).toBe('plan');
  });

  it('shows the real step text for a result-only status update', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end',
        name: 'manage_execution_plan',
        output: JSON.stringify({
          ok: true,
          action: 'set_status',
          step_id: 2,
          steps: [
            { id: 1, step: 'Inspect the existing process UI', status: 'completed' },
            { id: 2, step: 'Show the plan content on the action', status: 'completed' },
          ],
        }),
      },
    }, displayContext)).toBe('Execute plan · Show the plan content on the action');
  });

  it('restores plan content from result_preview when full output is absent', () => {
    const context = loadConversationRenderer();

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end',
        name: 'manage_execution_plan',
        result_preview: JSON.stringify({
          ok: true,
          action: 'set_status',
          step_id: 2,
          steps: [
            { id: 1, step: 'Inspect the existing process UI', status: 'completed' },
            { id: 2, step: 'Show the plan content on the action', status: 'completed' },
          ],
        }),
      },
    }, context._createProcessDisplayContext()))
      .toBe('Execute plan · Show the plan content on the action');
  });

  it('renders a result-only plan through normal separate process rows', () => {
    const context = loadConversationRenderer();
    const lines: Array<{ text: string; kind: string }> = [];
    context._streamingAppendProgress = (_msg: unknown, text: string, kind: string) => {
      lines.push({ text, kind });
    };
    context._streamingAppendToolResultRow = () => {
      throw new Error('plan results must use normal process rows');
    };

    context._renderAgentEvent({ querySelector: () => null }, {
      stream: 'tool',
      data: {
        phase: 'end',
        name: 'manage_execution_plan',
        output: JSON.stringify({
          ok: true,
          action: 'update',
          steps: [
            { id: 1, step: 'Inspect the existing process UI', status: 'completed' },
            { id: 2, step: 'Show the plan content on the action', status: 'in_progress' },
          ],
        }),
      },
    });

    expect(lines).toEqual([{
      text: [
        'Create plan · Inspect the existing process UI',
        'Create plan · Show the plan content on the action',
      ].join('\n'),
      kind: 'plan',
    }]);
  });

  it('uses the step content instead of exposing an internal step number', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();
    context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        id: 'plan-map',
        name: 'manage_execution_plan',
        arguments: {
          action: 'update',
          plan: [
            { step: 'Inspect the existing process UI', status: 'completed' },
            { step: 'Show the plan content on the action', status: 'in_progress' },
          ],
        },
      },
    }, displayContext);
    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        name: 'manage_execution_plan',
        arguments: { action: 'set_status', step_id: 2, status: 'completed' },
      },
    }, displayContext)).toBe('Execute plan · Show the plan content on the action');
  });

  it('shows Codex plan contents as one normal live process row', () => {
    const context = loadConversationRenderer();
    const lines: string[] = [];
    context._streamingAppendProgress = (_msg: unknown, line: string) => lines.push(line);
    const msg: any = {};

    context._renderAgentEvent(msg, {
      stream: 'cli',
      data: {
        type: 'status',
        status: 'plan-updated',
        explanation: 'Expose the active work',
        steps: [
          { step: 'Find the process renderer', status: 'completed' },
          { step: 'Show readable plan details', status: 'in_progress' },
        ],
      },
    });

    expect(lines).toEqual([[
      'Create plan · Find the process renderer',
      'Create plan · Show readable plan details',
    ].join('\n')]);
  });
});

describe('conversation process metadata formatting', () => {
  const orkasBridgeCases: Array<[string, Record<string, unknown>, string]> = [
    ['orkas_list_skills', {}, 'View skill'],
    ['orkas_read_skill', { id: 'pdf' }, 'View skill · pdf'],
    ['orkas_run_skill', { skill: 'pdf' }, 'Use skill · pdf'],
    ['orkas_list_connector_tools', {}, 'View connector'],
    [
      'orkas_call_connector_tool',
      { connector_id: 'Notion', tool_name: 'search', args: { query: 'launch plan' } },
      'Use connector · Notion · search · launch plan',
    ],
    ['orkas_kb_list', {}, 'View reference'],
    ['orkas_kb_search', { query: 'launch plan' }, 'Search references · launch plan'],
    ['orkas_kb_read', { path: 'plans/launch.md' }, 'View reference · plans/launch.md'],
    ['chat_search', { query: 'release checklist', scope: 'current' }, 'Search conversation · release checklist'],
    ['chat_read', { scope: 'current', limit: 10 }, 'View conversation'],
    ['orkas_handoff_to_commander', { reason: 'needs orchestration' }, 'Hand off to Commander'],
  ];
  const orkasBridgeAliasCases = orkasBridgeCases.flatMap(([tool, input, expected]) => [
    [tool, input, expected],
    [`orkas.${tool}`, input, expected],
    [`mcp__orkas__${tool}`, input, expected],
  ] as Array<[string, Record<string, unknown>, string]>);

  it('keeps the process-presentation matrix aligned with every registered Orkas bridge tool', () => {
    const bridgeSource = fs.readFileSync(
      path.join(__dirname, '../../bin/orkas-bridge.cjs'),
      'utf8',
    );
    const registeredTools = [...bridgeSource.matchAll(/server\.tool\(\s*'([^']+)'/g)]
      .map((match) => match[1])
      .sort();
    const presentedTools = orkasBridgeCases.map(([tool]) => tool).sort();

    expect(registeredTools).toEqual(presentedTools);
  });

  it('keeps the file target across core start, progress, and failed result events', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start', id: 'edit-1', name: 'edit_file',
        arguments: { path: 'src/account.ts' },
      },
    }, displayContext)).toBe('Started · Edit file · src/account.ts');
    expect(context._formatEventLine({
      stream: 'tool',
      data: { phase: 'progress', id: 'edit-1', name: 'edit_file' },
    }, displayContext)).toBe('Started · Edit file · src/account.ts');
    expect(context._formatEventLine({
      stream: 'tool',
      data: { phase: 'end', id: 'edit-1', name: 'edit_file', is_error: true },
    }, displayContext)).toBe('Edit file · src/account.ts · Failed');
  });

  it('keeps the CLI target across tool use, progress, and result events', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'use', tool: 'NotebookEdit', callId: 'notebook-1',
        input: { notebook_path: 'analysis/model.ipynb' },
      },
    }, displayContext)).toBe('Edit file · analysis/model.ipynb');
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'status', status: 'tool-progress', callId: 'notebook-1', elapsedSeconds: 2,
      },
    }, displayContext)).toBe('Edit file · analysis/model.ipynb · 2s');
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'result', tool: 'tool_result', callId: 'notebook-1',
        output: 'updated',
      },
    }, displayContext)).toBe('Edit file · analysis/model.ipynb · Done · 2s');
  });

  it('uses the same target correlation in the live CLI process rail', () => {
    const context = loadConversationRenderer();
    const lines: string[] = [];
    context._streamingAppendProgress = (_msg: unknown, line: string) => lines.push(line);
    const msg = {};

    context._renderAgentEvent(msg, {
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'use', tool: 'Read', callId: 'read-live',
        input: { file_path: 'src/live.ts' },
      },
    });
    context._renderAgentEvent(msg, {
      stream: 'cli',
      data: {
        type: 'status', status: 'tool-progress', callId: 'read-live', elapsedSeconds: 1,
      },
    });

    expect(lines).toEqual([
      'Read file · src/live.ts',
      'Read file · src/live.ts · 1s',
    ]);
  });

  it.each(orkasBridgeAliasCases)(
    'classifies Orkas bridge tool %s by its business action across use and result events',
    (tool, input, expected) => {
      const context = loadConversationRenderer();
      const displayContext = context._createProcessDisplayContext();
      const callId = `bridge-${tool}`;

      expect(context._formatEventLine({
        stream: 'cli',
        data: { type: 'tool-event', phase: 'use', tool, callId, input },
      }, displayContext)).toBe(expected);
      expect(context._formatEventLine({
        stream: 'cli',
        data: { type: 'tool-event', phase: 'result', tool, callId, output: 'ok' },
      }, displayContext)).toBe(`${expected} · Done`);
    },
  );

  it.each([
    'orkas.future_internal_tool',
    'mcp__orkas__future_internal_tool',
  ])('does not mislabel future Orkas bridge tool %s as a connector', (tool) => {
    const context = loadConversationRenderer();
    expect(context._formatEventLine({
      stream: 'cli',
      data: { type: 'tool-event', phase: 'use', tool, input: {} },
    })).toBe('Run action · future_internal_tool');
  });

  it.each([
    ['MultiEdit', { file_path: 'src/app.ts' }, 'Edit file · src/app.ts'],
    ['append_file', { path: 'notes/progress.md' }, 'Edit file · notes/progress.md'],
    ['TodoWrite', { todos: [] }, null],
    ['Task', { subagent_type: 'Explore' }, 'Call agent · Explore'],
    ['WebFetch', { url: 'https://example.com/docs' }, 'View webpage · https://example.com/docs'],
    ['process_start', { command: 'npm test' }, 'Run command · npm test'],
    ['terminal', { command: 'git status' }, 'Run command · git status'],
    ['create_docx', { path: 'reports/summary.docx' }, 'Create file · reports/summary.docx'],
    ['office_check', { path: 'reports/summary.docx' }, 'Check file · reports/summary.docx'],
    ['office_render', { path: 'reports/summary.docx' }, 'Render file · reports/summary.docx'],
    ['pdf_render', { path: 'reports/summary.pdf' }, 'View file · reports/summary.pdf'],
    ['generate_image', { output_path: 'images/cover.png' }, 'Generate image · images/cover.png'],
    ['generate_speech', { output_path: 'audio/voice.mp3' }, 'Generate audio · audio/voice.mp3'],
    ['call_connector_tool', { connector_id: 'Notion' }, 'Use connector · Notion'],
    ['add_custom_connector', { display_name: 'Internal Docs' }, 'Add connector · Internal Docs'],
    ['mcp__Product_Design__review', {}, 'Use connector · Product_Design · review'],
    [
      'browser.navigate',
      { url: 'https://example.com/docs/getting-started' },
      'Use connector · browser · navigate · https://example.com/docs/getting-started',
    ],
    ['dispatch_to', { to: 'Data Analyst' }, 'Call agent · Data Analyst'],
    ['custom_export', { outputPath: 'exports/result.bin' }, 'Run action · custom_export · exports/result.bin'],
  ])('formats %s with a concise action and business target', (tool, input, expected) => {
    const context = loadConversationRenderer();
    expect(context._formatEventLine({
      stream: 'cli',
      data: { type: 'tool-event', phase: 'use', tool, input },
    })).toBe(expected);
  });

  it('labels directory inspection without exposing an internal workspace slug', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start', id: 'root-list', name: 'list_files',
        resource_scope: 'current_workspace',
        arguments: { path: '/tmp/userWorkSpace/chat-2026-08-08-1' },
      },
    }, displayContext)).toBe(
      'Started · View folder · Current task workspace',
    );
    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end', id: 'root-list', name: 'list_files', duration_ms: 8,
      },
    }, displayContext)).toBe('View folder · Current task workspace · Done · 8ms');

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start', id: 'child-list', name: 'list_files',
        arguments: { path: '/tmp/userWorkSpace/chat-2026-08-08-1/evidence' },
      },
    }, context._createProcessDisplayContext())).toBe('Started · View folder · evidence');
  });

  it.each([
    ['zh', '开始查看目录 · 当前任务工作区'],
    ['en', 'Started · View folder · Current task workspace'],
    ['ja', '開始 · フォルダを確認 · 現在のタスクのワークスペース'],
    ['pt', 'Iniciado · Ver pasta · Espaço de trabalho da tarefa atual'],
  ])('localizes the current task workspace directory in %s', (language, expected) => {
    const context = loadConversationRenderer();
    const locale = JSON.parse(fs.readFileSync(
      path.join(__dirname, `../../src/renderer/locales/${language}.json`),
      'utf8',
    ));
    context.t = (key: string, params: Record<string, unknown> = {}) => {
      let value = String(locale[key] || key);
      for (const [name, replacement] of Object.entries(params)) {
        value = value.replaceAll(`{${name}}`, String(replacement ?? ''));
      }
      return value;
    };

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start', id: 'root-list', name: 'list_files',
        resource_scope: 'current_workspace',
        arguments: { path: '/tmp/userWorkSpace/chat-2026-08-08-1' },
      },
    }, context._createProcessDisplayContext())).toBe(expected);
  });

  it('shows the concrete webpage URL while redacting credential carriers', () => {
    const context = loadConversationRenderer();

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'use', tool: 'WebFetch',
        input: {
          url: 'https://alice:private@example.com/org/repo/issues?tab=open&access_token=secret#latest',
        },
      },
    })).toBe(
      'View webpage · https://***@example.com/org/repo/issues?tab=open&access_token=***#latest',
    );
  });

  it('keeps concrete Skill script, reference directory, and file-search scope', () => {
    const context = loadConversationRenderer();

    const cases = [
      [
        'orkas_run_skill',
        { skill: 'pdf', script: 'scripts/render_pdf.py' },
        'Use skill · pdf · scripts/render_pdf.py',
      ],
      [
        'orkas_kb_list',
        { dir: 'launch/2026' },
        'View reference · launch/2026',
      ],
      [
        'search_files',
        { query: 'processTool', path: 'src/renderer' },
        'Search files · processTool · src/renderer',
      ],
    ];

    for (const [tool, input, expected] of cases) {
      expect(context._formatEventLine({
        stream: 'cli',
        data: { type: 'tool-event', phase: 'use', tool, input },
      })).toBe(expected);
    }
  });

  it('updates one process row across a tool call lifecycle', () => {
    const context = loadConversationRenderer();
    const body: any = {
      children: [],
      appendChild(node: any) { this.children.push(node); },
    };
    context.document.createElement = () => ({ dataset: {}, className: '', innerHTML: '' });

    context._appendProcessTextLines(
      body,
      'View webpage · https://github.com/Orkas-AI/Orkas/issues',
      'tool',
      'WebFetch',
      'cli:web-1',
    );
    context._appendProcessTextLines(
      body,
      'View webpage · https://github.com/Orkas-AI/Orkas/issues · 2s',
      'tool',
      '',
      'cli:web-1',
    );
    context._appendProcessTextLines(
      body,
      'View webpage · https://github.com/Orkas-AI/Orkas/issues · Done',
      'tool',
      'tool_result',
      'cli:web-1',
      true,
    );
    context._appendProcessTextLines(
      body,
      'View webpage · https://github.com/Orkas-AI/Orkas/issues · 3s',
      'tool',
      '',
      'cli:web-1',
    );

    expect(body.children).toHaveLength(1);
    expect(body.children[0]).toMatchObject({
      className: 'stream-process-line kind-tool',
      dataset: {
        processCallId: 'cli:web-1',
        processTerminal: '1',
        processText: 'View webpage · https://github.com/Orkas-AI/Orkas/issues · Done',
        eventName: 'WebFetch',
      },
    });
  });

  it('keeps interleaved and replayed live group tool completions on their original rows', () => {
    const context = loadConversationRenderer();
    const processRows: any[] = [];
    const body: any = {
      children: processRows,
      scrollHeight: 0,
      scrollTop: 0,
      clientHeight: 0,
      appendChild(node: any) {
        processRows.push(node);
        this.scrollHeight = processRows.length;
      },
      addEventListener() {},
    };
    const processContainer = { style: { display: 'none' } };
    const msg: any = {
      dataset: {},
      isConnected: true,
      parentElement: null,
      querySelector(selector: string) {
        if (selector === '[data-role="process-container"]') return processContainer;
        if (selector === '[data-role="process"]') return body;
        return null;
      },
      querySelectorAll(selector: string) {
        return selector === '[data-role="process"] .stream-process-line'
          ? processRows
          : [];
      },
    };
    context.document.createElement = () => ({
      dataset: {},
      className: '',
      innerHTML: '',
      title: '',
    });
    context.currentCid = 'c1';
    context.groupBusyConvs.set('c1', true);
    context.__liveMsg = msg;
    vm.runInContext(`
      _ensureActorPlaceholder = function() { return __liveMsg; };
    `, context);

    const emitToolEvent = (data: Record<string, unknown>) => {
      context._handleGroupBusEvent('c1', msg, {
        type: 'process',
        actor: 'researcher',
        turn_id: 'turn-1',
        seg: 0,
        data: { type: 'event', event: { stream: 'tool', data } },
      });
    };

    emitToolEvent({ phase: 'start', id: 'write-1', name: 'write_file' });
    emitToolEvent({ phase: 'start', id: 'write-2', name: 'write_file' });
    emitToolEvent({
      phase: 'progress', id: 'write-1', name: 'write_file',
      arguments: { path: 'first.html', content: '<main>first</main>' },
    });
    emitToolEvent({
      phase: 'progress', id: 'write-2', name: 'write_file',
      arguments: { path: 'second.html', content: '<main>second</main>' },
    });
    // Parallel tools may complete in a different order from their starts.
    emitToolEvent({
      phase: 'end', id: 'write-2', name: 'write_file', duration_ms: 7,
    });
    emitToolEvent({
      phase: 'end', id: 'write-1', name: 'write_file', duration_ms: 8,
    });
    // Reconnect/observer replay is at-least-once. Replaying terminal events
    // must neither add a row nor erase the target and duration already shown.
    emitToolEvent({
      phase: 'end', id: 'write-2', name: 'write_file', duration_ms: 7,
    });
    // A stale non-terminal update delivered after completion must not regress
    // or retarget the terminal row.
    emitToolEvent({
      phase: 'progress', id: 'write-2', name: 'write_file',
      arguments: { path: 'wrong.html', content: 'late' },
    });

    expect(processRows.map((row) => row.dataset.processText)).toEqual([
      'Edit file · first.html · Done · 8ms',
      'Edit file · second.html · Done · 7ms',
    ]);
    expect(processRows.map((row) => row.dataset.processCallId)).toEqual([
      'tool:write-1',
      'tool:write-2',
    ]);
  });

  it('restores replayed tool completions with the same informative rows as live rendering', () => {
    const context = loadConversationRenderer();
    const processRows: any[] = [];
    const body: any = {
      children: processRows,
      appendChild(node: any) { processRows.push(node); },
      get childElementCount() { return processRows.length; },
    };
    const runtime = { textContent: '', hidden: true };
    const details: any = {
      className: '',
      dataset: {},
      classList: { add() {} },
      matches: (selector: string) => selector === '.stream-process',
      querySelector(selector: string) {
        if (selector === '.stream-process-body') return body;
        if (selector === '.stream-process-runtime') return runtime;
        return null;
      },
      set innerHTML(_value: string) {},
    };
    const bubble: any = {
      firstChild: null,
      inserted: null,
      insertBefore(node: any) { this.inserted = node; },
    };
    const msgDiv = {
      querySelector: (selector: string) => selector === '.chat-bubble' ? bubble : null,
    };
    context.document.createElement = (tag: string) => tag === 'details'
      ? details
      : { dataset: {}, className: '', innerHTML: '' };

    const process = [
      {
        phase: 'start', id: 'stat-1', name: 'stat_file',
        arguments: { path: 'chat-2026-08-08-1' },
      },
      {
        phase: 'start', id: 'read-1', name: 'read_file',
        arguments: { path: '@skill/deep-research' },
      },
      { phase: 'end', id: 'read-1', name: 'read_file', duration_ms: 7 },
      { phase: 'end', id: 'stat-1', name: 'stat_file', duration_ms: 8 },
      { phase: 'end', id: 'read-1', name: 'read_file', duration_ms: 7 },
      { phase: 'end', id: 'stat-1', name: 'stat_file', duration_ms: 8 },
    ].map((data) => ({
      type: 'event',
      event: { stream: 'tool', data },
    }));

    context._renderPersistedProcess(msgDiv, process);

    expect(bubble.inserted).toBe(details);
    expect(processRows.map((row) => row.dataset.processText)).toEqual([
      'Get file info · chat-2026-08-08-1 · Done · 8ms',
      'View skill · deep-research · Done · 7ms',
    ]);
  });

  it('does not append a fallback duplicate after a post-render scroll failure', () => {
    const context = loadConversationRenderer();
    const processRows: any[] = [];
    const body: any = {
      children: processRows,
      scrollHeight: 0,
      clientHeight: 0,
      appendChild(node: any) {
        processRows.push(node);
        this.scrollHeight = processRows.length;
      },
      addEventListener() {},
    };
    Object.defineProperty(body, 'scrollTop', {
      get: () => 0,
      set: () => { throw new Error('simulated scroll failure after append'); },
    });
    const processContainer = { style: { display: 'none' } };
    const msg: any = {
      dataset: {},
      isConnected: true,
      parentElement: null,
      querySelector(selector: string) {
        if (selector === '[data-role="process-container"]') return processContainer;
        if (selector === '[data-role="process"]') return body;
        return null;
      },
      querySelectorAll(selector: string) {
        return selector === '[data-role="process"] .stream-process-line'
          ? processRows
          : [];
      },
    };
    context.document.createElement = () => ({
      dataset: {},
      className: '',
      innerHTML: '',
      title: '',
    });
    context.currentCid = 'c1';
    context.groupBusyConvs.set('c1', true);
    context.__liveMsg = msg;
    vm.runInContext(`
      _ensureActorPlaceholder = function() { return __liveMsg; };
    `, context);

    context._handleGroupBusEvent('c1', msg, {
      type: 'process',
      actor: 'researcher',
      turn_id: 'turn-1',
      seg: 0,
      data: {
        type: 'event',
        event: {
          stream: 'tool',
          data: {
            phase: 'start', id: 'read-1', name: 'read_file',
            arguments: { path: 'src/process.ts' },
          },
        },
      },
    });

    expect(processRows.map((row) => row.dataset.processText)).toEqual([
      'Started · Read file · src/process.ts',
    ]);
    expect(processRows[0].dataset.processCallId).toBe('tool:read-1');
  });

  it('correlates CLI start, progress, and result events to the same visible row', () => {
    const context = loadConversationRenderer();
    const events = [
      {
        stream: 'cli',
        data: { type: 'tool-event', phase: 'use', tool: 'WebFetch', callId: 'web-1' },
      },
      {
        stream: 'cli',
        data: { type: 'status', status: 'tool-progress', callId: 'web-1' },
      },
      {
        stream: 'cli',
        data: { type: 'tool-event', phase: 'result', tool: 'tool_result', callId: 'web-1' },
      },
    ];

    expect(events.map((event) => context._processToolLifecycle(event)?.key))
      .toEqual(['cli:web-1', 'cli:web-1', 'cli:web-1']);
  });

  it('refuses to correlate lifecycle rows when a call id is absent', () => {
    const context = loadConversationRenderer();
    expect(context._processToolLifecycle({
      stream: 'tool',
      data: { phase: 'start', name: 'write_file' },
    })).toBeNull();
    expect(context._processToolLifecycle({
      stream: 'tool',
      data: { phase: 'end', name: 'write_file' },
    })).toBeNull();
  });

  it('exposes safe generic operation details without requiring a tool-specific case', () => {
    const context = loadConversationRenderer();
    const line = context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'use', tool: 'custom_pipeline',
        input: {
          operation: 'compile',
          project_dir: 'overconstraint-carousel/01-cover',
          format: 'png',
          quality: 90,
          access_token: 'super-secret',
          prompt: 'private prompt',
        },
      },
    });

    expect(line).toBe(
      'Run action · custom_pipeline · compile · overconstraint-carousel/01-cover · format=png · quality=90',
    );
    expect(line).not.toContain('super-secret');
    expect(line).not.toContain('private prompt');
  });

  it('keeps generic tool details across start/end rows and exposes a safe failure reason', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();
    const expected = 'Run action · image_studio · project.inspect · overconstraint-carousel/01-cover';

    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start', id: 'inspect-cover', name: 'image_studio',
        arguments: {
          op: 'project.inspect',
          project_dir: 'overconstraint-carousel/01-cover',
          access_token: 'super-secret',
        },
      },
    }, displayContext)).toBe(`Started · ${expected}`);

    const resultPreview = JSON.stringify({
      ok: false,
      inspection: {
        blockers: [{
          code: 'E_MANIFEST_REGION_BOUNDS',
          message: 'visual_plan.regions[0].bounds must be normalized and stay inside the canvas.',
        }],
      },
    });
    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end', id: 'inspect-cover', name: 'image_studio', isError: true,
        result_preview: resultPreview,
      },
    }, displayContext)).toBe(
      `${expected} · Failed · E_MANIFEST_REGION_BOUNDS: visual_plan.regions[0].bounds must be normalized and stay inside the canvas.`,
    );
  });

  it('prefers localized structured VideoStudio timing failures over raw protocol prose', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();
    context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start', id: 'narration-fit', name: 'video_studio',
        arguments: {
          op: 'composition.materialize_narration',
          composition_dir: 'project/composition',
        },
      },
    }, displayContext);
    const line = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end', id: 'narration-fit', name: 'video_studio', isError: true,
        result_preview: JSON.stringify({
          ok: false,
          errorCode: 'E_NARRATION_TIMING_USER_DECISION_REQUIRED',
          message: 'This internal protocol prose should stay out of the compact row.',
          measured_duration_sec: 52,
          min_duration_sec: 40,
          max_duration_sec: 50,
        }),
      },
    }, displayContext);

    expect(line).toContain('Narration 52s still outside 40-50s; decide next step');
    expect(line).not.toContain('internal protocol prose');
  });

  it('keeps a safe command summary across use, progress, and result rows', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'use', tool: 'exec_command', callId: 'cmd-1',
        input: { command: 'git add OpenSource/ORKAS_PR_TRACKING.md' },
      },
    }, displayContext)).toBe('Run command · git add OpenSource/ORKAS_PR_TRACKING.md');
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'status', status: 'tool-progress', callId: 'cmd-1', elapsedSeconds: 2,
      },
    }, displayContext)).toBe('Run command · git add OpenSource/ORKAS_PR_TRACKING.md · 2s');
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'result', tool: 'tool_result', callId: 'cmd-1',
        output: 'staged',
      },
    }, displayContext)).toBe('Run command · git add OpenSource/ORKAS_PR_TRACKING.md · Done · 2s');
  });

  it('retains the latest elapsed time on failed CLI tool results', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'use', tool: 'exec_command', callId: 'cmd-failed',
        input: { command: 'npm run verify' },
      },
    }, displayContext);
    context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'status', status: 'tool-progress', callId: 'cmd-failed', elapsedSeconds: 3,
      },
    }, displayContext);

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'result', tool: 'tool_result', callId: 'cmd-failed',
        isError: true, error: 'command exited with code 1',
      },
    }, displayContext)).toBe(
      'Run command · npm run verify · Failed · 3s · command exited with code 1',
    );
  });

  it('prefers an exact result duration over the last progress estimate', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'use', tool: 'web_fetch', callId: 'web-duration',
        input: { url: 'https://example.com/docs/timing' },
      },
    }, displayContext);
    context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'status', status: 'tool-progress', callId: 'web-duration', elapsedSeconds: 9,
      },
    }, displayContext);

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'result', tool: 'tool_result', callId: 'web-duration',
        durationMs: 1_250, output: 'ok',
      },
    }, displayContext)).toBe(
      'View webpage · https://example.com/docs/timing · Done · 1s',
    );
  });

  it('redacts command secrets, absolute paths, and multiline script bodies', () => {
    const context = loadConversationRenderer();
    const line = context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'use', tool: 'Bash',
        input: {
          command: 'OPENAI_API_KEY=super-secret AWS_SECRET_ACCESS_KEY=another-secret curl -H "Authorization: Bearer sk-proj-abcdefghijklmnop" /Users/test/Private/report.md <<\'EOF\'\nprivate body',
        },
      },
    });

    expect(line).toBe('Run command · OPENAI_API_KEY=*** AWS_SECRET_ACCESS_KEY=*** curl -H "Authorization: ***" report.md <<\'EOF\'');
    expect(line).not.toContain('super-secret');
    expect(line).not.toContain('another-secret');
    expect(line).not.toContain('/Users/alice');
    expect(line).not.toContain('private body');
  });

  it('shows the normalized CLI executable without process arguments', () => {
    const context = loadConversationRenderer();
    expect(context._formatEventLine({
      stream: 'cli',
      data: { type: 'process-info', cmd: 'codex', argCount: 7 },
    })).toBe('Start agent · codex');
  });

  it('shows a bounded redacted failure summary for a failed command', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'use', tool: 'exec_command', callId: 'cmd-failed',
        input: { command: 'npm test' },
      },
    }, displayContext);
    const line = context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'result', tool: 'tool_result', callId: 'cmd-failed',
        is_error: true,
        error: 'Could not open /Users/test/Private/test.log with GITHUB_TOKEN=private-token',
      },
    }, displayContext);

    expect(line).toBe('Run command · npm test · Failed · Could not open test.log with GITHUB_TOKEN=***');
    expect(line).not.toContain('/Users/alice');
    expect(line).not.toContain('private-token');
  });

  it('uses a localized web-search action and keeps the query across start/result rows', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    const start = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start',
        id: 'search-1',
        name: 'web_search',
        arguments: { query: 'pricing' },
      },
    }, displayContext);
    const result = context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end',
        id: 'search-1',
        name: 'web_search',
        display_name: 'External Search',
        result_preview: 'Search results for: "pricing" (via External Search) 1. Official pricing',
      },
    }, displayContext);

    expect(start).toBe('Started · Search the web · pricing');
    expect(result).toBe('Search the web · pricing · Done');
    expect(result).not.toContain('Search results');
  });

  it('correlates Claude tool_result with its original business object without persisting display fields', () => {
    const context = loadConversationRenderer();
    context._skillsCache = [{ id: 'writing-plans', name: 'Writing Plans' }];
    const displayContext = context._createProcessDisplayContext();

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'use',
        tool: 'Read',
        callId: 'read-1',
        input: {
          file_path: '/Users/test/.orkas/data/u1/cloud/skills/writing-plans/SKILL.md',
        },
      },
    }, displayContext)).toBe('View skill · Writing Plans');

    const resultEvent = {
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'result',
        tool: 'tool_result',
        callId: 'read-1',
        output: '# Writing Plans\nprivate body',
      },
    };
    expect(context._formatEventLine(resultEvent, displayContext))
      .toBe('View skill · Writing Plans · Done');
    expect(resultEvent.data).not.toHaveProperty('objectType');
    expect(resultEvent.data).not.toHaveProperty('objectName');
  });

  it('keeps raw multiline tool output out of the concise CLI process row', () => {
    const context = loadConversationRenderer();

    expect(Array.from(context._processTextLines('first line\r\nsecond line\n\nthird line')))
      .toEqual(['first line', 'second line', 'third line']);
    const line = context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'result',
        tool: 'exec_command',
        output: 'tests: 3 passed\ncoverage: 91%',
      },
    });
    expect(line).toBe('Run command · Done');
    expect(line).not.toContain('tests: 3 passed');
  });

  it('never mistakes a spilled result archive for the tool business target', () => {
    const context = loadConversationRenderer();
    const line = context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'tool-event', phase: 'result', tool: 'tool_result',
        outputPath: '/Users/test/private/events/tool-results/result.txt',
      },
    });

    expect(line).toBe('Run action · Done');
    expect(line).not.toContain('result.txt');
  });

  it('keeps a short hidden CLI result available through the existing expansion row', () => {
    const context = loadConversationRenderer();
    let captured: any[] | null = null;
    context._streamingAppendToolResultRow = (...args: any[]) => { captured = args; };
    context._streamingAppendProgress = () => {
      throw new Error('a recorded result body must use the expandable row');
    };
    const msg: any = { querySelector: () => null };

    context._renderAgentEvent(msg, {
      stream: 'cli',
      data: {
        type: 'tool-event',
        phase: 'result',
        tool: 'exec_command',
        output: 'ok',
      },
    });

    expect(captured?.[1]).toBe('Run command · Done');
    expect(captured?.[3]).toBe('ok');
  });

  it('renders multiline process output as distinct DOM rows with aligned continuations', () => {
    const context = loadConversationRenderer();
    const children: any[] = [];
    context.document.createElement = () => ({
      className: '',
      dataset: {},
      innerHTML: '',
    });
    const body = {
      appendChild(node: any) {
        children.push(node);
      },
    };

    const count = context._appendProcessTextLines(
      body,
      'tests: 3 passed\n● coverage: 91%\nfinished',
      'tool',
      'exec_command',
    );

    expect(count).toBe(3);
    expect(children.map(child => child.dataset.processText)).toEqual([
      'tests: 3 passed',
      '● coverage: 91%',
      'finished',
    ]);
    expect(children[0].className).toBe('stream-process-line kind-tool');
    expect(children[1].className).toContain('is-continuation');
    expect(children[2].className).toContain('is-continuation');
    expect(children.every(child => child.dataset.eventName === 'exec_command')).toBe(true);
    expect(children[0].innerHTML).toContain('stream-process-icon');
    expect(children[1].innerHTML).not.toContain('stream-process-icon');
  });

  it('renders each plan step as a separate normal process row', () => {
    const context = loadConversationRenderer();
    const children: any[] = [];
    context.document.createElement = () => ({ className: '', dataset: {}, innerHTML: '' });
    const body = { appendChild: (node: any) => children.push(node) };

    context._appendProcessTextLines(
      body,
      [
        'Update plan · Inspect the existing process UI',
        'Update plan · Show the plan content',
        'Update plan · Verify the result',
      ].join('\n'),
      'plan',
      'update_plan',
    );

    expect(children).toHaveLength(3);
    expect(children.every(child => child.className === 'stream-process-line kind-plan')).toBe(true);
    expect(children.every(child => child.innerHTML.includes('stream-process-icon'))).toBe(true);
    expect(children.map(child => child.dataset.processText)).toEqual([
      'Update plan · Inspect the existing process UI',
      'Update plan · Show the plan content',
      'Update plan · Verify the result',
    ]);
  });

  it('fixes main-task AI replies at the existing 80% message cap', () => {
    const style = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
    const message = onlyCssDeclarations(style, '.chat-history > .chat-message.assistant');
    const bubble = onlyCssDeclarations(style, '.chat-history > .chat-message.assistant > .chat-bubble');

    expect(message).toMatchObject({ width: '80%', 'max-width': '80%' });
    expect(bubble).toMatchObject({ width: '100%', 'box-sizing': 'border-box' });
  });

  it('leaves user messages content-sized up to the shared 80% cap', () => {
    const style = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
    const genericMessage = onlyCssDeclarations(style, '.chat-message');
    const genericBubble = onlyCssDeclarations(style, '.chat-bubble');
    const userMessage = onlyCssDeclarations(style, '.chat-message.user');
    const userBubble = onlyCssDeclarations(style, '.chat-message.user .chat-bubble');

    expect(genericMessage['max-width']).toBe('80%');
    expect(genericMessage).not.toHaveProperty('width');
    expect(genericBubble).not.toHaveProperty('width');
    expect(userMessage).not.toHaveProperty('width');
    expect(userBubble).not.toHaveProperty('width');
    expect(cssDeclarationsForSelector(style, '.chat-history > .chat-message')).toEqual([]);
    expect(cssDeclarationsForSelector(style, '.chat-history > .chat-message.user')).toEqual([]);
    expect(cssDeclarationsForSelector(style, '.chat-history > .chat-message.user > .chat-bubble')).toEqual([]);
  });

  it('keeps the process viewport vertical-only', () => {
    const style = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
    const body = onlyCssDeclarations(style, '.stream-process-body');

    expect(body).toMatchObject({
      'max-height': '300px',
      'overflow-x': 'hidden',
      'overflow-y': 'auto',
    });
    expect(body).not.toHaveProperty('overflow');
  });

  it.each([
    ['ordinary process rows', '.stream-process-text'],
    ['multiline continuation rows', '.stream-process-line.is-continuation .stream-process-text'],
  ])('wraps %s within the process viewport', (_label, selector) => {
    const style = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
    const declarations = onlyCssDeclarations(style, selector);

    expect(declarations['white-space']).toBe('pre-wrap');
    expect(declarations['overflow-wrap']).toBe('anywhere');
    expect(declarations['white-space']).not.toBe('nowrap');
  });

  it('wraps expanded full output while retaining vertical overflow', () => {
    const style = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
    const fullOutput = onlyCssDeclarations(style, '.stream-process-line-full');

    expect(fullOutput).toMatchObject({
      'white-space': 'pre-wrap',
      'word-break': 'break-all',
      'max-height': '320px',
      'overflow-x': 'hidden',
      'overflow-y': 'auto',
    });
    expect(fullOutput).not.toHaveProperty('overflow');
  });

  it('keeps the process caret visible and fixed-width for runtime-only summaries', () => {
    const style = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');

    expect(style).toMatch(/\.stream-process-caret\s*\{[^}]*flex:\s*0 0 16px;/s);
    expect(style).not.toMatch(
      /\.stream-process\.runtime-only \.stream-process-caret\s*\{[^}]*(?:display:\s*none|visibility:\s*hidden|opacity:\s*0)/s,
    );
  });

  it('formats retry, background, and tool-progress protocol statuses', () => {
    const context = loadConversationRenderer();

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'status',
        status: 'retrying',
        attempt: 2,
        maxRetries: 4,
        retryDelayMs: 2_000,
        error: 'network unavailable',
      },
    })).toBe('Retrying (attempt 2)/4 · retrying in 2s · network unavailable');
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'status',
        status: 'background-running',
        message: 'indexing files',
      },
    })).toBe('Background task · indexing files');
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'status',
        status: 'tool-progress',
        tool: 'Bash',
        elapsedSeconds: 3,
      },
    })).toBe('Run command · 3s');
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'status',
        status: 'failed',
        error: 'Command failed at /Users/test/Private/build.log with API_KEY=private-token',
      },
    })).toBe('Failed · Command failed at build.log with API_KEY=***');
    expect(context._eventProcessKind({
      stream: 'cli',
      data: { type: 'status', status: 'retrying' },
    }, '')).toBe('warn');
    expect(context._eventProcessKind({
      stream: 'cli',
      data: { type: 'status', status: 'background-failed' },
    }, '')).toBe('err');
    expect(context._formatEventLine({
      stream: 'cli',
      data: { type: 'thinking', chars: 0 },
    })).toBe('Thinking');
    expect(context._formatEventLine({
      stream: 'cli',
      data: { type: 'thinking', chars: 32, summary: 'Reviewing the event parser' },
    })).toBe('Thinking · Reviewing the event parser');
    expect(context._eventProcessKind({
      stream: 'cli',
      data: { type: 'thinking', chars: 0 },
    }, '')).toBe('think');
  });

  it('keeps safe duration and error details without exposing credentials or absolute paths', () => {
    const context = loadConversationRenderer();
    const displayContext = context._createProcessDisplayContext();

    context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'start', id: 'edit-duration', name: 'edit_file',
        arguments: { path: 'src/process.ts' },
      },
    }, displayContext);
    expect(context._formatEventLine({
      stream: 'tool',
      data: {
        phase: 'end', id: 'edit-duration', name: 'edit_file',
        duration_ms: 37,
        end_to_end_duration_ms: 1_640,
      },
    }, displayContext)).toBe('Edit file · src/process.ts · Done · 2s');

    expect(context._formatEventLine({
      stream: 'lifecycle',
      data: {
        phase: 'error',
        error: 'Failed at /Users/test/Private/run.log with API_KEY=private-token',
      },
    })).toBe('Thinking failed · Failed at run.log with API_KEY=***');

    expect(context._formatEventLine({
      stream: 'approval',
      data: {
        prompt: 'Run /Users/test/Private/deploy.sh with ACCESS_TOKEN=private-token?',
      },
    })).toBe('Awaiting confirmation: Run deploy.sh with ACCESS_TOKEN=***');
  });

  it('retains safe details for waiting, rate-limit, timeout, and compaction statuses', () => {
    const context = loadConversationRenderer();

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'status', status: 'waiting-input',
        message: 'Choose config at /Users/test/Private/settings.json',
      },
    })).toBe('Awaiting input · Choose config at settings.json');
    expect(context._formatEventLine({
      stream: 'cli',
      data: { type: 'status', status: 'rate-limit', retryAfterMs: 12_000 },
    })).toBe('Wait for service · retrying in 12s');
    expect(context._formatEventLine({
      stream: 'cli',
      data: { type: 'status', status: 'timeout', timeoutMs: 30_000 },
    })).toBe('Response timed out · 30s');
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'status', status: 'compacted',
        tokens_before: 12_000, tokens_after: 2_500,
      },
    })).toBe('Conversation organized · 12000 → 2500 tokens');
  });

  it.each([
    [
      'core runtime retry',
      { stream: 'runtime', data: { phase: 'retrying', attempt: 2 } },
      'warn',
    ],
    [
      'CLI retry',
      { stream: 'cli', data: { type: 'status', status: 'retrying', attempt: 2 } },
      'warn',
    ],
    [
      'CLI process metadata',
      { stream: 'cli', data: { type: 'process-info', cmd: 'codex' } },
      'bound',
    ],
    [
      'CLI thinking',
      { stream: 'cli', data: { type: 'thinking', summary: 'Inspecting files' } },
      'think',
    ],
    [
      'CLI tool call',
      { stream: 'cli', data: { type: 'tool-event', tool: 'exec_command', phase: 'use' } },
      'tool',
    ],
    [
      'CLI tool progress',
      { stream: 'cli', data: { type: 'status', status: 'tool-progress', tool: 'exec_command' } },
      'tool',
    ],
    [
      'CLI running milestone',
      { stream: 'cli', data: { type: 'status', status: 'running' } },
      'bound',
    ],
    [
      'CLI failure',
      { stream: 'cli', data: { type: 'status', status: 'failed' } },
      'err',
    ],
    [
      'CLI stderr',
      { stream: 'cli', data: { type: 'stderr-line', line: 'temporary warning' } },
      'warn',
    ],
    [
      'CLI info log',
      { stream: 'cli', data: { type: 'log', level: 'info', message: 'connected' } },
      'meta',
    ],
    [
      'CLI warning log',
      { stream: 'cli', data: { type: 'log', level: 'warn', message: 'slow response' } },
      'warn',
    ],
    [
      'CLI error log',
      { stream: 'cli', data: { type: 'log', level: 'error', message: 'connection failed' } },
      'err',
    ],
    [
      'CLI raw diagnostic',
      { stream: 'cli', data: { type: 'raw-line', line: 'connection recovered' } },
      'meta',
    ],
    [
      'CLI denied permission',
      { stream: 'cli', data: { type: 'permission-request', autoDecided: 'deny' } },
      'info',
    ],
    [
      'CLI idle warning',
      { stream: 'cli', data: { type: 'idle', stalledMs: 30_000 } },
      'warn',
    ],
    [
      'provider fallback',
      { stream: 'provider', data: { phase: 'fallback', reason: 'auth' } },
      'warn',
    ],
    [
      'native patch',
      { stream: 'patch', data: { path: 'src/app.ts' } },
      'patch',
    ],
    [
      'CLI file change',
      { stream: 'cli', data: { type: 'file-change', paths: ['src/app.ts'] } },
      'patch',
    ],
    [
      'skipped attachment',
      { stream: 'attachment', data: { phase: 'skipped', items: [{ name: 'large.zip' }] } },
      'err',
    ],
  ])('assigns %s an explicit semantic process style', (_label, event, expectedKind) => {
    const context = loadConversationRenderer();

    expect(context._eventProcessKind(event, 'localized process text')).toBe(expectedKind);
  });

  it.each([
    [
      { status: 'plan-updated', steps: [{ step: 'inspect' }, { step: 'test' }] },
      'Create plan · inspect\nCreate plan · test',
    ],
    [{ status: 'compacting' }, 'Organize conversation'],
    [{ status: 'compacted' }, 'Conversation organized'],
    [{ status: 'waiting-approval' }, 'Awaiting confirmation'],
    [{ status: 'waiting-input' }, 'Awaiting input'],
    [
      { status: 'model-rerouted', fromModel: 'gpt-old', toModel: 'gpt-new' },
      'Switch model · gpt-old → gpt-new',
    ],
    [{ status: 'authenticating' }, 'Verify identity'],
    [{ status: 'rate-limit' }, 'Wait for service'],
    [{ status: 'background-completed', message: 'index ready' }, 'Background task · index ready · Done'],
    [{ status: 'background-failed', message: '/tmp/index failed: EIO' }, 'Background task · Failed · index failed: EIO'],
    [{ status: 'background-running', taskType: 'Explore', message: '/tmp/private' }, 'Background task · Explore'],
    [{ status: 'background-stopped' }, 'Background task · Stopped'],
  ])('formats CLI status payload %j', (data, expected) => {
    const context = loadConversationRenderer();
    expect(context._formatEventLine({
      stream: 'cli',
      data: { type: 'status', ...data },
    })).toBe(expected);
  });

  it('mirrors CLI retry and background status into the always-visible activity row', () => {
    const context = loadConversationRenderer();
    const activityText = { textContent: '' };
    const activityRow = {
      style: { display: 'none' },
      querySelector: (selector: string) => (
        selector === '[data-role="activity-text"]' ? activityText : null
      ),
    };
    const runtimeText = { textContent: '', hidden: true };
    const processContainer = {
      dataset: {},
      style: { display: 'none' },
      matches: (selector: string) => selector === '.stream-process',
      querySelector: (selector: string) => (
        selector === '.stream-process-runtime' ? runtimeText : null
      ),
    };
    const msg: any = {
      dataset: {},
      isConnected: true,
      querySelector(selector: string) {
        if (selector === '[data-role="activity"]') return activityRow;
        if (selector === '[data-role="process-container"]' || selector === '.stream-process') {
          return processContainer;
        }
        return null;
      },
    };

    context._streamingUpdateActivityFromEvent(msg, {
      stream: 'cli',
      data: { type: 'status', status: 'retrying', attempt: 3 },
    });
    expect(activityText.textContent).toBe('Retrying (attempt 3)');

    context._streamingUpdateActivityFromEvent(msg, {
      stream: 'cli',
      data: { type: 'status', status: 'background-running', message: 'indexing files' },
    });
    expect(activityText.textContent).toBe('Background task · indexing files');

    context._streamingUpdateActivityFromEvent(msg, {
      stream: 'cli',
      data: {
        type: 'thinking',
        chars: 32,
        summary: 'Reviewing the event parser',
        heartbeat: true,
      },
    });
    expect(activityText.textContent).toBe('Thinking · Reviewing the event parser');
    context._streamingStopActivity(msg);
  });

  it('uses Codex heartbeats for activity without appending duplicate process rows', () => {
    const context = loadConversationRenderer();
    const msg = {
      querySelector() {
        throw new Error('heartbeat should not touch the process DOM');
      },
    };

    expect(() => context._renderAgentEvent(msg, {
      stream: 'cli',
      data: { type: 'thinking', chars: 0, heartbeat: true },
    })).not.toThrow();
    expect(() => context._renderAgentEvent(msg, {
      stream: 'cli',
      data: { type: 'status', status: 'tool-progress', heartbeat: true },
    })).not.toThrow();
  });

  it('buffers bounded process milestones while a conversation is off-view', () => {
    const context = loadConversationRenderer();
    const processEvent = {
      type: 'event',
      event: {
        stream: 'group',
        data: {
          type: 'process',
          data: {
            type: 'event',
            event: { stream: 'cli', data: { type: 'thinking', chars: 0 } },
          },
        },
      },
    };
    const deltaEvent = {
      type: 'event',
      event: {
        stream: 'group',
        data: { type: 'process', data: { type: 'delta', text: 'token' } },
      },
    };

    expect(context._bufferOffViewGroupProcessEvent('cid-off-view', processEvent)).toBe(true);
    expect(context._bufferOffViewGroupProcessEvent('cid-off-view', deltaEvent)).toBe(false);
    expect(context._bufferOffViewGroupProcessEvent('cid-off-view', {
      type: 'event',
      event: {
        stream: 'group',
        data: {
          type: 'process',
          data: {
            type: 'event',
            event: {
              stream: 'cli',
              data: { type: 'thinking', chars: 0, heartbeat: true },
            },
          },
        },
      },
    })).toBe(false);
    expect(context._takeOffViewGroupProcessEvents('cid-off-view')).toEqual([processEvent]);
    expect(context._takeOffViewGroupProcessEvents('cid-off-view')).toEqual([]);
  });

  it('caps off-view process replay at the newest 300 milestones and clears terminal buffers', () => {
    const context = loadConversationRenderer();
    const processEvent = (index: number) => ({
      type: 'event',
      event: {
        stream: 'group',
        data: {
          type: 'process',
          data: {
            type: 'event',
            event: {
              stream: 'cli',
              data: { type: 'log', level: 'info', message: `milestone-${index}` },
            },
          },
        },
      },
    });

    for (let index = 0; index < 305; index += 1) {
      expect(context._bufferOffViewGroupProcessEvent('cid-bounded', processEvent(index))).toBe(true);
    }
    const buffered = context._takeOffViewGroupProcessEvents('cid-bounded');
    expect(buffered).toHaveLength(300);
    expect(buffered[0].event.data.data.event.data.message).toBe('milestone-5');
    expect(buffered[299].event.data.data.event.data.message).toBe('milestone-304');

    context._bufferOffViewGroupProcessEvent('cid-terminal', processEvent(999));
    context._clearOffViewGroupProcessEvents('cid-terminal');
    expect(context._takeOffViewGroupProcessEvents('cid-terminal')).toEqual([]);
  });

  it('clears the conversation busy state from a terminal state snapshot', () => {
    const context = loadConversationRenderer();
    context.currentCid = 'cli-cid';
    context.groupBusyConvs.set('cli-cid', true);

    context._handleGroupBusEvent('cli-cid', null, {
      type: 'state_changed',
      state: { status: 'idle', in_flight: [], active_recipient: '' },
      active_turns: [],
    });

    expect(context.groupBusyConvs.has('cli-cid')).toBe(false);
  });

  it('hides CLI protocol noise and localizes a known actionable diagnostic', () => {
    const context = loadConversationRenderer();

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'log',
        level: 'info',
        source: 'codex',
        message: 'item<path>: {"threadId":"t1","turnId":"r1","itemId":"exec-1","delta":"."}',
      },
    })).toBeNull();
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'log',
        level: 'debug',
        source: 'codex',
        message: 'account/rateLimits/updated: {}',
      },
    })).toBeNull();
    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'log',
        level: 'info',
        source: 'codex',
        message: 'connection recovered',
      },
    })).toBe('Connection restored');

    expect(context._formatEventLine({
      stream: 'cli',
      data: {
        type: 'stderr-line',
        line: 'rpc response id=42 payload={"status":"busy"}',
      },
    })).toBeNull();

    expect(context._formatEventLine({
      stream: 'error',
      data: { message: 'rpc failed at /Users/test/private/file.ts' },
    })).toBe('Error: rpc failed at file.ts');
  });

  it('formats every semantic context phase through localized renderer copy', () => {
    const context = loadConversationRenderer();
    const phases = [
      ['history_summary_start', 'Organize conversation history'],
      ['history_summary_done', 'Conversation history organized'],
      ['history_summary_failed', 'Could not organize conversation history'],
      ['active_process_compaction_start', 'Organize current task progress'],
      ['active_process_compaction_done', 'Current task progress organized'],
      ['active_process_compaction_failed', 'Could not organize current task progress'],
    ];

    for (const [phase, expected] of phases) {
      expect(context._formatEventLine({
        stream: 'context',
        data: { phase, message: '不应显示的底层文案' },
      })).toBe(expected);
    }
  });

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
    const segmentedRuntime = context._formatEventLine({
      stream: 'runtime',
      data: {
        duration_ms: 180_000,
        bubble_duration_ms: 12_000,
        provider_ms: 80_000,
        tool_ms: 100_000,
      },
    });
    const tool = context._formatEventLine({
      stream: 'tool',
      data: { phase: 'end', name: 'manage_execution_plan', duration_ms: 17 },
    });

    expect(compaction).toBe('Conversation organized · 20000 → 3000 tokens');
    expect(runtime).toBe('Total time 1m 5s');
    expect(runtimeWithBreakdown).toBe('Total time 1m 5s');
    expect(segmentedRuntime).toBe('Total time 12s');
    expect(tool).toBe('Update plan');
    expect(context._processSummaryRuntimeFromItems([
      { type: 'progress', text: 'Context compressed', event: { stream: 'compaction', data: {} } },
      { type: 'progress', text: 'Total time 1m 5s', event: { stream: 'runtime', data: { duration_ms: 65_000 } } },
    ])).toBe('1m 5s');
    expect(context._processSummaryRuntimeFromItems([
      { type: 'event', event: { stream: 'runtime', data: { durationMs: 1_234 } } },
    ])).toBe('1s');
    expect(context._processSummaryRuntimeFromItems([
      {
        type: 'event',
        event: {
          stream: 'runtime',
          data: { duration_ms: 180_000, bubble_duration_ms: 12_000 },
        },
      },
    ])).toBe('12s');
    expect(context._processSummaryRuntimeFromItems([
      { type: 'progress', text: 'Context compressed', event: { stream: 'compaction', data: {} } },
    ])).toBe('');
    expect(context._eventProcessKind({ stream: 'context', data: {} }, 'Context prepared')).toBe('context');
    expect(context._eventProcessKind({ stream: 'compaction', data: {} }, compaction)).toBe('context');
    expect(context._eventProcessKind({ stream: 'runtime', data: {} }, runtime)).toBe('bound');
  });

  it('keeps duration events out of persisted process rows while retaining retry progress', () => {
    const context = loadConversationRenderer();
    const segmentRuntime = {
      type: 'event',
      event: {
        stream: 'runtime',
        data: { phase: 'segment_end', duration_ms: 20, bubble_duration_ms: 0 },
      },
    };
    const retry = {
      type: 'progress',
      text: 'Retrying',
      event: { stream: 'runtime', data: { phase: 'retrying', attempt: 2 } },
    };
    const tool = {
      type: 'event',
      event: { stream: 'tool', data: { phase: 'end', name: 'read_file', duration_ms: 6 } },
    };
    const finalRuntime = {
      type: 'event',
      event: { stream: 'runtime', data: { phase: 'end', duration_ms: 40_000 } },
    };

    const displayed = context._processItemsForDisplay([
      segmentRuntime,
      tool,
      retry,
      finalRuntime,
    ]);

    expect(displayed).toHaveLength(2);
    expect(displayed[0]).toEqual(tool);
    expect(displayed[1]).toEqual(retry);
    expect(displayed.filter((item: any) => (
      item.event?.stream === 'runtime'
      && item.event?.data?.duration_ms != null
    ))).toHaveLength(0);
    expect(context._processSummaryRuntimeFromItems([
      segmentRuntime,
      tool,
      retry,
      finalRuntime,
    ])).toBe('40s');
    expect(context._formatEventLine(retry.event)).toBeNull();
  });

  it('updates only the summary clock and freezes the final value', () => {
    const context = loadConversationRenderer();
    const summary = { textContent: '', hidden: true };
    const container = {
      style: { display: 'none' },
      dataset: {} as Record<string, string>,
      querySelector: (selector: string) => (
        selector === '.stream-process-runtime' ? summary : null
      ),
    };
    const msg: any = {
      dataset: {},
      querySelector(selector: string) {
        if (selector === '[data-role="process-container"]') return container;
        if (selector === '.stream-process') return container;
        return null;
      },
    };

    context._updateStreamingRuntimeSummary(msg, {
      stream: 'runtime',
      data: { phase: 'segment_end', duration_ms: 5, bubble_duration_ms: 0 },
    });
    context._updateStreamingRuntimeSummary(msg, null, 40_000);

    expect(summary.textContent).toBe('40s');
    expect(container.dataset.runtimeDurationMs).toBe('40000');

    context._updateStreamingRuntimeSummary(msg, {
      stream: 'runtime',
      data: { phase: 'end', duration_ms: 42_000 },
    });
    context._updateStreamingRuntimeSummary(msg, null, 50_000);

    expect(summary.textContent).toBe('42s');
    expect(container.dataset.runtimeDurationMs).toBe('42000');
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

  it('keeps a queued edit Agent transient and restores the displaced draft recipient', () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      setChatRecipient("conversation", { kind: "agent", id: "draft-agent", name: "Draft Agent" });
      _setQueueEditRecipient("c1", { kind: "agent", id: "queued-agent", name: "Queued Agent" });
    `, context);

    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ kind: 'agent', id: 'queued-agent', name: 'Queued Agent' });

    context.setChatRecipient(
      'conversation',
      { kind: 'agent', id: 'revised-agent', name: 'Revised Agent' },
    );
    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ kind: 'agent', id: 'revised-agent', name: 'Revised Agent' });

    vm.runInContext('_clearQueueEditRecipient("c1")', context);
    expect(context.getChatRecipient('conversation'))
      .toMatchObject({ kind: 'agent', id: 'draft-agent', name: 'Draft Agent' });
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

  it('keeps the commander floor-reset marker in transport but hides it in the user bubble', () => {
    const context = loadConversationRenderer();
    vm.runInContext(`
      currentCid = "c1";
      _serverFloorByCid.set("c1", "a1");
      setChatRecipient("conversation", { kind: "commander" });
      __snap = _takeRecipientSnapshotForSend("conversation");
    `, context);

    const outbound = context.applyRecipientPrefix(
      '你看下怎么处理',
      'conversation',
      { recipientSnapshot: context.__snap },
    );

    expect(outbound).toBe('@commander 你看下怎么处理');
    expect(context._stripCommanderRoutingMentionsForDisplay(outbound))
      .toBe('你看下怎么处理');
  });

  it('normalizes commander routing markers on replay without hiding agent mentions', () => {
    const context = loadConversationRenderer();

    expect(context._stripCommanderRoutingMentionsForDisplay('@指挥官\n> 引用内容'))
      .toBe('> 引用内容');
    expect(context._stripCommanderRoutingMentionsForDisplay('请让 @commander 看一下'))
      .toBe('请让 看一下');
    expect(context._stripCommanderRoutingMentionsForDisplay('@FamilyTutor 继续'))
      .toBe('@FamilyTutor 继续');
  });

  it('queues completed attachments and clears them from the composer', async () => {
    const context = loadConversationRenderer();
    const input = { value: 'review this', dispatchEvent() {} };
    const queued: any[] = [];
    const cleared: string[] = [];
    context.performance = { now: () => 10 };
    context.currentCid = 'c1';
    context.messageQueues = new Map();
    context.document.getElementById = (id: string) => (id === 'chat-input' ? input : null);
    context.ensureModelConfigured = () => true;
    context.enqueueMessage = (...args: any[]) => queued.push(args);
    context._chatAttachClear = (cid: string) => cleared.push(cid);
    context._clearDraft = () => {};
    context.autoGrow = () => {};
    vm.runInContext(`
      _chatAttachments.set("c1", [
        { name: "brief.pdf", status: "ready" },
        { name: "chart.png", status: "ready" },
      ]);
      pendingConvs.set("c1", { loadingEl: null, aborted: false });
    `, context);

    await context.handleChatSubmit();

    expect(queued).toHaveLength(1);
    expect(queued[0][0]).toBe('c1');
    expect(queued[0][1]).toBe('review this');
    expect(queued[0][3].extra.attachments).toEqual(['brief.pdf', 'chart.png']);
    expect(queued[0][3].attachmentItems).toEqual([
      { name: 'brief.pdf', status: 'ready' },
      { name: 'chart.png', status: 'ready' },
    ]);
    expect(cleared).toEqual(['c1']);
    expect(input.value).toBe('');
  });

  it('commits an active queued-message edit before any normal send preflight', async () => {
    const context = loadConversationRenderer();
    const input = { value: 'revised queued request', dispatchEvent() {} };
    const commits: any[] = [];
    context.currentCid = 'c1';
    context.document.getElementById = (id: string) => (id === 'chat-input' ? input : null);
    context._isQueueItemEditing = (cid: string) => cid === 'c1';
    context._commitQueueItemEdit = (...args: any[]) => {
      commits.push(args);
      return true;
    };
    context.ensureModelConfigured = () => {
      throw new Error('normal send preflight must stay blocked during queue editing');
    };

    await context.handleChatSubmit();

    expect(commits).toEqual([['c1', 'revised queued request']]);
  });

  it('keeps a queued-message edit locked while a restored attachment is uploading', async () => {
    const context = loadConversationRenderer();
    const input = { value: 'revised queued request', dispatchEvent() {} };
    let commitCount = 0;
    const alerts: string[] = [];
    context.currentCid = 'c1';
    context.document.getElementById = (id: string) => (id === 'chat-input' ? input : null);
    context._isQueueItemEditing = (cid: string) => cid === 'c1';
    context._commitQueueItemEdit = () => { commitCount += 1; };
    context.uiAlert = async (message: string) => { alerts.push(message); };
    context.t = (key: string) => key;
    vm.runInContext(`
      _chatAttachments.set("c1", [
        { name: "still-uploading.pdf", status: "uploading" },
      ]);
    `, context);

    await context.handleChatSubmit();

    expect(commitCount).toBe(0);
    expect(alerts).toEqual(['chat.attach_still_uploading']);
    expect(input.value).toBe('revised queued request');
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
      sendInConversation = (_cid, content) => { __sent.push(content); };
      setChatRecipient("conversation", { kind: "agent", id: "a1", name: "FamilyTutor" });
      enqueueMessage("c1", "还有吗？", null, {
        recipient: _takeRecipientSnapshotForSend("conversation"),
      });
      setChatRecipient("conversation", { kind: "agent", id: "a2", name: "OtherTutor" });
      _dispatchNextQueued("c1");
    `, context);

    expect(context.__sent).toEqual(['@FamilyTutor 还有吗？']);
  });

  it('keeps a queued message until its controller reports that sending started', async () => {
    const context = loadConversationRenderer();
    context.messageQueues = new Map();
    context._QUEUE_KEY = (cid: string) => `queue_${cid}`;
    context._DRAFT_KEY = (cid: string) => `draft_${cid}`;
    const queueSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/queue-draft.js'), 'utf8');
    vm.runInContext(queueSource, context);
    vm.runInContext(`
      currentCid = "c1";
      enqueueMessage("c1", "稍后执行", null);
      sendInConversation = async () => ({ started: false, reason: "model_not_configured" });
      _dispatchNextQueued("c1");
    `, context);
    await Promise.resolve();

    expect(context.messageQueues.get('c1')).toHaveLength(1);

    vm.runInContext(`
      sendInConversation = async (_cid, _content, _extra, options) => {
        options.onStarted();
        return { started: true, aborted: false, errored: false };
      };
      _dispatchNextQueued("c1");
    `, context);
    await Promise.resolve();

    expect(context.messageQueues.get('c1')).toHaveLength(0);
  });
});

function setupConversationStatusController(context: any, cid = 'c1') {
  let hooks: any = null;
  const cleanups: string[] = [];
  context.createChatController = (config: any) => {
    hooks = config.hooks;
    return { abort() {} };
  };
  context._finishStreamingMsg = (finishedCid: string) => cleanups.push(finishedCid);
  context._updateConvSendUI = () => {};
  context._updateConvSidebarBadge = () => {};
  context.startPolling = () => {};
  context._startRuntimeActorRecovery = () => {};
  context._observeConversationRunFromPlanAction = () => {};

  const ctrl = context._makeConvChatController(cid);
  context.__ctrl = ctrl;
  context.__cid = cid;
  vm.runInContext('_convChatCtrls.set(__cid, __ctrl)', context);
  const msg = { dataset: {} };
  hooks.onAssistantStart(msg, cid);
  return { hooks, msg, cleanups };
}

describe('conversation controller settlement', () => {
  it('shows distinct save and delete actions only while a queued item owns the composer', () => {
    const context = loadConversationRenderer();
    const classes = new Set<string>();
    const sendButton = {
      disabled: false,
      title: '',
      classList: {
        contains: (name: string) => classes.has(name),
        add: (name: string) => classes.add(name),
        remove: (name: string) => classes.delete(name),
        toggle: (name: string, enabled: boolean) => {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
      },
    };
    const deleteAttributes = new Map<string, string>();
    const deleteButton = {
      hidden: true,
      title: '',
      setAttribute: (name: string, value: string) => deleteAttributes.set(name, value),
    };
    const input = { disabled: false, placeholder: '', focus() {} };
    context.currentCid = 'c1';
    context.convAgentEnabledByCid = new Map();
    context._isQueueItemEditing = () => true;
    context.document.getElementById = (id: string) => ({
      'chat-send-btn': sendButton,
      'chat-queue-edit-delete-btn': deleteButton,
      'chat-input': input,
    }[id] || null);

    context._updateConvSendUI('c1');

    expect(classes.has('queue-editing')).toBe(true);
    expect(classes.has('streaming')).toBe(false);
    expect(sendButton.title).toBe('chat.queue_save');
    expect(deleteButton.hidden).toBe(false);
    expect(deleteButton.title).toBe('chat.queue_delete_editing');
    expect(deleteAttributes.get('aria-label')).toBe('chat.queue_delete_editing');

    context._isQueueItemEditing = () => false;
    context._updateConvSendUI('c1');

    expect(classes.has('queue-editing')).toBe(false);
    expect(sendButton.title).toBe('chat.send_title');
    expect(deleteButton.hidden).toBe(true);
  });

  it('does not steal focus from an open global search when chat state settles', () => {
    const context = loadConversationRenderer();
    let focusCalls = 0;
    const sendButton = {
      disabled: false,
      title: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    };
    const input = { disabled: false, placeholder: '', focus() { focusCalls += 1; } };
    const searchInput = { id: 'global-search-input' };
    context.currentCid = 'c1';
    context.convAgentEnabledByCid = new Map();
    context._isQueueItemEditing = () => false;
    context.document.activeElement = searchInput;
    context.document.getElementById = (id: string) => ({
      'chat-send-btn': sendButton,
      'chat-queue-edit-delete-btn': { hidden: true, setAttribute() {} },
      'chat-input': input,
    }[id] || null);

    context._updateConvSendUI('c1');

    expect(focusCalls).toBe(0);
    context.document.activeElement = null;
    context._updateConvSendUI('c1');
    expect(focusCalls).toBe(1);
  });

  it('renders background queue sends off-screen without changing the visible controller target', () => {
    const context = loadConversationRenderer();
    const detachedHistory = { dataset: {} };
    const configs: any[] = [];
    context.document.createElement = () => detachedHistory;
    context.createChatController = (config: any) => {
      configs.push(config);
      return { abort() {} };
    };

    context._makeConvChatController('background-cid', { background: true });
    context._makeConvChatController('visible-cid');

    expect(configs[0]).toMatchObject({
      historyEl: detachedHistory,
      inputEl: null,
      sendBtnEl: null,
    });
    expect(configs[1]).toMatchObject({
      historyEl: 'chat-history',
      inputEl: 'chat-input',
      sendBtnEl: 'chat-send-btn',
    });
  });

  it('restores and commits an edit-chat queue item through its composer', () => {
    const context = loadConversationRenderer();
    const stored = new Map<string, string>([
      ['queue_agent:a1', JSON.stringify([
        { id: 'q1', content: 'first' },
        {
          id: 'q2',
          content: 'second',
          composer_edit: {
            previous_input: 'separate edit-chat draft',
            draft_content: 'second, in progress',
          },
        },
      ])],
    ]);
    const makeTarget = (initial: Record<string, any> = {}) => {
      const listeners: Record<string, Function[]> = {};
      const classes = new Set<string>();
      return {
        dataset: {},
        classList: {
          contains: (name: string) => classes.has(name),
          remove: (name: string) => classes.delete(name),
          add: (name: string) => classes.add(name),
          toggle: (name: string, on: boolean) => {
            if (on) classes.add(name);
            else classes.delete(name);
          },
        },
        addEventListener: (type: string, fn: Function) => {
          (listeners[type] ||= []).push(fn);
        },
        dispatch: (type: string, event: any = {}) => {
          for (const fn of listeners[type] || []) fn({ preventDefault() {}, ...event });
        },
        focus() {},
        setSelectionRange() {},
        ...initial,
      };
    };
    const input = makeTarget({ value: '', placeholder: 'Describe changes' });
    const sendButton = makeTarget({ title: '', disabled: false });
    context.localStorage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    };
    context.document.getElementById = (id: string) => ({
      'agent-input': input,
      'agent-send': sendButton,
    }[id] || null);
    context.autoGrow = () => {};
    // Keep the unlocked queue parked so the assertion can observe its final
    // durable order without starting a model request.
    context.ensureModelConfigured = () => false;

    context.createChatController({
      historyEl: { dataset: {} },
      inputEl: 'agent-input',
      sendBtnEl: 'agent-send',
      getCurrentId: () => 'a1',
      streamEndpoint: () => '/stream',
      features: { bindInput: true, scrollPin: false, queue: true },
      queue: {
        keyPrefix: 'agent',
        panelId: 'missing-panel',
        listId: 'missing-list',
        countId: 'missing-count',
      },
    });

    expect(input.value).toBe('second, in progress');
    expect(sendButton.title).toBe('chat.queue_save');

    input.value = 'second, revised';
    input.dispatch('input');
    sendButton.dispatch('click');

    expect(input.value).toBe('separate edit-chat draft');
    expect(JSON.parse(stored.get('queue_agent:a1')!)).toEqual([
      { id: 'q1', content: 'first' },
      { id: 'q2', content: 'second, revised' },
    ]);
  });

  it('retries a failed edit reply through its owning controller with the original request metadata', async () => {
    const context = loadConversationRenderer();
    const historyEl: any = { innerHTML: '', dataset: {} };
    const capturedRequests: Array<{ url: string; body: any }> = [];
    let retryHandler: Function | null = null;
    context.TextDecoder = TextDecoder;
    context.AbortController = AbortController;
    context.performance = performance;
    context.ensureModelConfigured = () => true;
    context.nowIsoLocal = () => '2026-08-08T14:30:00';
    context._scrollToBottomNoAnim = () => {};
    context._createStreamingAssistantMessage = () => ({ dataset: {} });
    context._handleStreamEvent = () => {};
    context._makeStreamPaintYield = () => () => null;
    context.appendChatMessage = (_message: any, _autoScroll: boolean, opts: any) => {
      retryHandler ||= opts.failedRetryHandler;
      return { dataset: {} };
    };
    context.apiFetch = async (url: string, options: any = {}) => {
      if (!options.method) {
        return {
          json: async () => ({
            ok: true,
            history: [
              { role: 'user', content: 'Refine this skill' },
              { role: 'assistant', content: 'Model response failed: aborted' },
            ],
          }),
        };
      }
      capturedRequests.push({ url, body: JSON.parse(options.body) });
      return {
        ok: true,
        body: { getReader: () => ({ read: async () => ({ done: true }) }) },
      };
    };

    const controller = context.createChatController({
      historyEl,
      getCurrentId: () => 'skill-a1',
      historyEndpoint: () => '/skill/history',
      streamEndpoint: () => '/skill/send',
      telemetrySurface: 'skill_edit',
      features: { bindInput: false, scrollPin: false, queue: true, messageActions: 'errors-only' },
      queue: { keyPrefix: 'skill' },
    });
    await controller.loadHistory();

    const userMessage = {
      dataset: {
        retryContent: 'Refine this skill',
        retryAttachments: '["brief.md"]',
        retryAttachmentCid: 'skill-edit-skill-a1',
        retryModelText: 'Use the imported source and refine this skill',
      },
      classList: { contains: (name: string) => name === 'chat-message' || name === 'user' },
      previousElementSibling: null,
      querySelector: () => null,
    };
    const failedMessage = { previousElementSibling: userMessage };
    expect(retryHandler).toBeTypeOf('function');
    await retryHandler!(failedMessage, null);

    expect(capturedRequests).toHaveLength(1);
    expect(capturedRequests[0]).toEqual({
      url: '/skill/send',
      body: expect.objectContaining({
        content: 'Refine this skill',
        attachments: ['brief.md'],
        attachment_cid: 'skill-edit-skill-a1',
        model_text: 'Use the imported source and refine this skill',
      }),
    });
    expect(context.currentCid).toBe('');
  });

  it('settles an aborted send only from onDone and reuses the owning controller', () => {
    const context = loadConversationRenderer();
    const cleanups: string[] = [];
    let hooks: any = null;
    context.createChatController = (config: any) => {
      hooks = config.hooks;
      return { abort() {} };
    };
    context._taskTurnFinish = () => {};
    context._finishStreamingMsg = (cid: string) => cleanups.push(cid);
    context._scheduleHistoryReconcileAfterStream = () => {};
    context._updateConvSendUI = () => {};
    context._updateConvSidebarBadge = () => {};
    context.startPolling = () => {};
    context._startRuntimeActorRecovery = () => {};
    // Sending now attaches the bus observer (the turn's only event source);
    // this case is about controller settlement, so stub it like the other
    // onAssistantStart side effects above.
    context._observeConversationRunFromPlanAction = () => {};

    const ctrl = context._makeConvChatController('c1');
    context.__ctrl = ctrl;
    vm.runInContext('_convChatCtrls.set("c1", __ctrl)', context);
    const msg = { dataset: {} };
    hooks.onAssistantStart(msg, 'c1');

    expect(context.pendingConvs.get('c1').controller).toBe(ctrl);
    hooks.onAbort(msg, 'c1');
    expect(cleanups).toHaveLength(0);

    hooks.onDone(msg, 'c1', { started: true, aborted: true, errored: false });
    expect(cleanups).toEqual(['c1']);

    hooks.onDone(msg, 'c1', { started: true, aborted: true, errored: false });
    expect(cleanups).toEqual(['c1']);
  });

  it('keeps a successful turn successful when the lifecycle stream errors afterward', () => {
    const context = loadConversationRenderer();
    const { hooks, msg, cleanups } = setupConversationStatusController(context);

    // Canonical reply lands first. The controller then observes a host-stream
    // teardown error: this is the production order that previously produced a
    // false red Failed label beside a fully successful response.
    context._handleGroupBusEvent('c1', msg, {
      type: 'message',
      turn_end: true,
      turn_id: 'turn-1',
      msg: {
        from: 'commander',
        text: 'Review complete; all checks passed.',
        ts: '2026-08-08T12:00:00.000Z',
      },
    });
    hooks.onDone(msg, 'c1', { started: true, aborted: false, errored: true });

    expect(cleanups).toEqual(['c1']);
    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe('idle');
  });

  it('still marks a transport-only failure when no reply or task terminal settled the turn', () => {
    const context = loadConversationRenderer();
    const { hooks, msg } = setupConversationStatusController(context);
    hooks.onDone(msg, 'c1', { started: true, aborted: false, errored: true });

    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe('failed');
  });

  it('does not treat reopened pending history as success when its transport later fails', () => {
    const context = loadConversationRenderer();
    const { hooks, msg } = setupConversationStatusController(context);
    context._syncFailedFromHistory('c1', [
      { from: 'commander', text: 'Prior completed turn.' },
      { from: 'user', text: 'Current turn still awaiting a reply.' },
    ]);
    expect(context._convRowStatus({ conversation_id: 'c1', status: 'failed' })).toBe('idle');

    hooks.onDone(msg, 'c1', { started: true, aborted: false, errored: true });

    expect(context._convRowStatus({ conversation_id: 'c1' })).toBe('failed');
  });

  it('classifies a server abort as aborted instead of model output failure', async () => {
    const context = loadConversationRenderer();
    context.TextDecoder = TextDecoder;
    context.AbortController = AbortController;
    context.performance = performance;
    context.ensureModelConfigured = () => true;
    context.nowIsoLocal = () => '2026-07-17T00:00:00';
    context._createStreamingAssistantMessage = () => ({ dataset: {} });
    context._handleStreamEvent = () => {};
    context._makeStreamPaintYield = () => () => null;
    const encoded = new TextEncoder().encode(`data: ${JSON.stringify({
      type: 'error',
      aborted: true,
      text: 'stopped',
    })}\n\n`);
    let readCount = 0;
    context.apiFetch = async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => (readCount++ === 0
            ? { done: false, value: encoded }
            : { done: true, value: undefined }),
        }),
      },
    });
    let aborts = 0;
    let errors = 0;
    let doneResult: any = null;
    const controller = context.createChatController({
      historyEl: { dataset: {} },
      getCurrentId: () => 'c1',
      streamEndpoint: () => '/stream',
      features: { bindInput: false, scrollPin: false },
      hooks: {
        appendHistoryMessage: () => ({ dataset: {} }),
        onAbort: () => { aborts += 1; },
        onError: () => { errors += 1; },
        onDone: (_msg: any, _cid: string, result: any) => { doneResult = result; },
      },
    });

    const result = await controller.send('hello');

    expect(aborts).toBe(1);
    expect(errors).toBe(0);
    expect(result).toMatchObject({ started: true, aborted: true, errored: false });
    expect(doneResult).toMatchObject({ started: true, aborted: true, errored: false });
  });

  it('renders a server abort as stopped instead of a model error', () => {
    const context = loadConversationRenderer();
    let stopped = 0;
    let errors = 0;
    context._streamingMarkAborted = () => { stopped += 1; };
    context._streamingSetError = () => { errors += 1; };

    context._handleStreamEvent('c1', {}, { type: 'error', aborted: true, text: 'stopped' });

    expect(stopped).toBe(1);
    expect(errors).toBe(0);
  });

  it.each([
    [{ started: true, aborted: false, errored: false }, 'success'],
    [{ started: true, aborted: false, errored: true }, 'failure'],
    [{ started: true, aborted: true, errored: false }, 'cancelled'],
  ])('returns the terminal chat result from controller state %#', async (terminal, expected) => {
    const context = loadConversationRenderer();
    context.performance = performance;
    context._taskTurnStart = () => {};
    context._makeConvChatController = (_cid: string, options: any) => ({
      abort() {},
      async send() {
        options.onStarted();
        options.onDone(terminal);
        return terminal;
      },
    });

    const result = await context.sendInConversation('c1', 'hello', undefined, {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      entry_point: 'quick_start',
      resource_id: 'creation',
      agent_id: '173d4235a431',
      recipient_type: 'agent',
      position: 6,
      source: 'pc_default',
    });

    expect(result.result).toBe(expected);
  });

  it('returns failure for a controller preflight rejection', async () => {
    const context = loadConversationRenderer();
    context.performance = performance;
    context._makeConvChatController = () => ({
      abort() {},
      async send() {
        return { started: false, aborted: false, errored: false, reason: 'model_not_configured' };
      },
    });

    const result = await context.sendInConversation('c1', 'hello');

    expect(result.result).toBe('failure');
  });
});

describe('chat attachment picker targeting', () => {
  it('keeps project composer uploads separate from ordinary conversations', () => {
    const context = loadConversationRenderer();

    expect(context._chatAttachTargetOf('projchat-p1')).toBe('project');
    expect(context._chatAttachTargetOf('c1')).toBe('conversation');
  });

});

describe('new chat quick-start scenarios', () => {
  it('uses the account name in the centered prompt and falls back to Friend without one', () => {
    const context = loadConversationRenderer();
    const greeting = { textContent: '' };
    context.t = (key: string, params: any = {}) => ({
      'new_chat.title': `${params.name}, what do you want to accomplish?`,
      'common.user_fallback': 'Friend',
    }[key] || key);
    context.document.getElementById = (id: string) => (
      id === 'new-chat-greeting' ? greeting : null
    );

    context._updateEmptyStateAccount({ userInfo: { nickname: 'Avery' } });
    expect(greeting.textContent).toBe('Avery, what do you want to accomplish?');

    context._updateEmptyStateAccount({ userInfo: { email: 'avery@example.com' } });
    expect(greeting.textContent).toBe('Friend, what do you want to accomplish?');
  });

  it('renders all nine quick-start cards when the new-chat view is entered', () => {
    const context = loadConversationRenderer();
    const heading = { textContent: '' };
    const recipientName = {
      textContent: '',
      setAttribute() {},
      removeAttribute() {},
    };
    const input = {
      value: '',
      dataset: {},
      addEventListener() {},
    };
    const grid = {
      children: [],
      innerHTML: '',
    };
    const row = {
      querySelectorAll: () => [],
    };
    context.document.getElementById = (id: string) => ({
      'new-chat-greeting': heading,
      'new-chat-recipient-name': recipientName,
      'new-chat-input': input,
      'new-chat-scenario-grid': grid,
      'new-chat-scenarios': row,
    } as Record<string, unknown>)[id] || null;

    context.onEnterNewChatView();

    expect(heading.textContent).toBe('Friend, what do you want to accomplish?');
    expect([...grid.innerHTML.matchAll(/data-scenario="([^"]+)"/g)].map((match) => match[1])).toEqual([
      'data',
      'office',
      'ppt',
      'creation',
      'image',
      'video',
      'ui_design',
      'rnd',
      'seo_geo',
    ]);
  });

  it('falls back to commander without toast when the scenario agent is missing', async () => {
    const context = loadConversationRenderer();
    const toasts: any[] = [];
    const clicks: any[] = [];
    const events: any[] = [];
    const classChanges: string[] = [];
    let clickHandler: Function | null = null;
    const input = {
      value: '',
      focused: false,
      selection: [0, 0],
      dataset: {},
      focus() { this.focused = true; },
      setSelectionRange(start: number, end: number) { this.selection = [start, end]; },
      dispatchEvent() {},
    };
    const chip = {
      dataset: { scenario: 'ui_design' },
      classList: {
        add(name: string) { classChanges.push(`add:${name}`); },
        remove(name: string) { classChanges.push(`remove:${name}`); },
      },
      addEventListener(type: string, fn: Function) {
        if (type === 'click') clickHandler = fn;
      },
    };
    const row = {
      dataset: {},
      querySelectorAll: () => [chip],
    };

    context._agentsCache = [];
    context.Monitor = {
      click: (name: string, payload: any) => clicks.push({ name, payload }),
      event: (name: string, payload: any) => events.push({ name, payload }),
    };
    context.window.Monitor = true;
    context.loadAgents = async () => [];
    context._setQuickStartItems([{ id: 'ui_design', agent_id: 'missing-ui-agent' }]);
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
    expect(input.value).toContain('a personal finance app');
    expect(input.focused).toBe(true);
    expect(input.value.slice(input.selection[0], input.selection[1])).toBe('a personal finance app');
    expect(classChanges).toEqual([]);
    expect(toasts).toHaveLength(0);
    expect(clicks).toEqual([]);
    expect(events).toEqual([]);
    expect(input.dataset).toMatchObject({
      commanderEntryPoint: 'quick_start',
      commanderResourceId: 'ui_design',
      commanderRecipientType: 'commander',
    });
    expect(input.dataset.commanderQuickStartPlaceholder).toBeUndefined();
  });

  it('binds article writing to the dedicated default-installed ContentWriter', async () => {
    const context = loadConversationRenderer();
    const events: any[] = [];
    let clickHandler: Function | null = null;
    const input = {
      value: '',
      dataset: {},
      focus() {},
      setSelectionRange() {},
      dispatchEvent() {},
    };
    const card = {
      dataset: { scenario: 'creation' },
      addEventListener(type: string, fn: Function) {
        if (type === 'click') clickHandler = fn;
      },
    };
    const row = {
      querySelectorAll: () => [card],
    };

    context._agentsCache = [{
      agent_id: '173d4235a431',
      name: 'ContentWriter',
      enabled: true,
    }];
    context.Monitor = {
      click() {},
      event: (name: string, payload: any) => events.push({ name, payload }),
    };
    context.window.Monitor = true;
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
    await clickHandler!();

    expect(context.getChatRecipient('new-chat')).toMatchObject({
      kind: 'agent',
      id: '173d4235a431',
      name: 'ContentWriter',
    });
    expect(input.value).toContain('Write');
    expect(events).toEqual([]);
  });

  it('binds software development to the default-installed ProductDeveloper', async () => {
    const context = loadConversationRenderer();
    const events: any[] = [];
    let clickHandler: Function | null = null;
    const input = {
      value: '',
      dataset: {},
      focus() {},
      setSelectionRange() {},
      dispatchEvent() {},
    };
    const card = {
      dataset: { scenario: 'rnd' },
      addEventListener(type: string, fn: Function) {
        if (type === 'click') clickHandler = fn;
      },
    };
    const row = {
      querySelectorAll: () => [card],
    };

    context._agentsCache = [{
      agent_id: 'a316881746f9',
      name: 'ProductDeveloper',
      enabled: true,
    }];
    context.Monitor = {
      click() {},
      event: (name: string, payload: any) => events.push({ name, payload }),
    };
    context.window.Monitor = true;
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
    await clickHandler!();

    expect(context.getChatRecipient('new-chat')).toMatchObject({
      kind: 'agent',
      id: 'a316881746f9',
      name: 'ProductDeveloper',
    });
    expect(input.value).toContain('Build');
    expect(events).toEqual([]);
  });
});
