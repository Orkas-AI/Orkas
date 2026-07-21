/* Orkas Frontend */

let currentUserId = '';
let accessPassword = '';

// current view: 'new-chat' | 'conversation' | 'agents'
let currentView = 'new-chat';
let currentCid = null;
let conversations = [];
let _pendingTaskNotificationNavigation = null;

// Per-conversation pending state
// key: cid, value: { loadingEl: HTMLElement | null, needsIndicator: bool,
//                    controller: AbortController | null, aborted: bool }
const pendingConvs = new Map();
// Group-chat runtime state is emitted independently from the request
// controller. Keep it in the same pending predicate so delegated agents keep
// the send button in "replying/stop" mode until the whole turn is quiescent.
const groupBusyConvs = new Map();

function isGroupConversationBusy(cid) { return groupBusyConvs.has(cid); }

function setGroupConversationBusy(cid, busy) {
  if (!cid) return;
  if (busy) groupBusyConvs.set(cid, true);
  else groupBusyConvs.delete(cid);
}

function isConvPending(cid) {
  return pendingConvs.has(cid) || isGroupConversationBusy(cid);
}

function _isPlainComposerEnter(e) {
  return e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey;
}

function _insertComposerNewline(el) {
  if (!el || typeof el.value !== 'string') return;
  const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
  const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
  if (typeof el.setRangeText === 'function') {
    el.setRangeText('\n', start, end, 'end');
  } else {
    el.value = `${el.value.slice(0, start)}\n${el.value.slice(end)}`;
    el.selectionStart = el.selectionEnd = start + 1;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

function _handleModifiedComposerEnter(e) {
  if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey)) return false;
  e.preventDefault();
  _insertComposerNewline(e.currentTarget);
  return true;
}

function _normalizeTaskNotificationNavigation(payload) {
  const conversationId = typeof payload?.conversation_id === 'string'
    ? payload.conversation_id.trim()
    : '';
  const terminalStatus = typeof payload?.terminal_status === 'string'
    ? payload.terminal_status
    : '';
  if (!conversationId || !/^[A-Za-z0-9_-]+$/.test(conversationId)) return null;
  if (!['completed', 'failed', 'waiting_input'].includes(terminalStatus)) return null;
  return { conversationId, terminalStatus };
}

function _openTaskNotificationConversation(payload) {
  const target = _normalizeTaskNotificationNavigation(payload);
  if (!target) return false;
  if (!currentUserId) {
    _pendingTaskNotificationNavigation = {
      conversation_id: target.conversationId,
      terminal_status: target.terminalStatus,
    };
    return false;
  }
  _pendingTaskNotificationNavigation = null;
  setView('conversation', target.conversationId, { entryPoint: 'task_notification' });
  return true;
}

function _consumePendingTaskNotificationConversation() {
  if (!_pendingTaskNotificationNavigation) return false;
  return _openTaskNotificationConversation(_pendingTaskNotificationNavigation);
}

// Keep sidebar navigation independent from private analytics. The commercial
// build decorates this boundary with click tracking; the open build still
// needs the routing wrapper because every sidebar handler calls it.
function _setViewFromSidebar(targetView) {
  setView(targetView);
}

// Public agent creation has no analytics dependency, but its click handler
// intentionally keeps the same hook as the commercial build.
function _trackAgentCreateOpen() {}

// Per-conversation queued messages (sent sequentially, one at a time).
// key: cid, value: Array<{ id, content, skill }>
const messageQueues = new Map();
const _QUEUE_KEY = (cid) => `queue_${cid}`;
const _DRAFT_KEY = (cid) => `draft_${cid}`;

// Polling: detect assistant responses even after page refresh / reconnect
const pollTimers = new Map();    // cid → setInterval id
const pollMsgCounts = new Map(); // cid → last known visible message identity

// Per-conversation cached enabled state of the bound agent. Backend stamps
// `agent_enabled` on the conversation payload at history-load time; this
// map mirrors it for UI guards (input disable + banner). Refreshed on each
// `loadConversationHistory` call. True for conversations with no agent_id.
const convAgentEnabledByCid = new Map();

// Backend `/api/conversations/<cid>/history` returns raw GroupMessage
// records (`{id, ts, from, to, text, ...}`) — NOT the legacy
// `{role, content, time}` shape. `loadConversationHistory` translates via
// `_groupMsgToLegacy`; the polling rescue path forgot to. Polling now
// looks at `from` directly: anything not `'user'` is an assistant-side
// reply (commander or any agent), and `from === 'user'` is a user
// message. Without this, polling never recognised the agent's reply, so
// the "thinking…" loadingEl created for mid-turn opens stayed pinned
// forever (visible as a stuck `智能体 思考中…` bubble below the actual
// reply — the symptom that surfaced once scheduled-task fires made the
// "open conv mid-turn without a local ctrl" path common).
function _isPolledAssistantMsg(m) { return !!(m && m.from && m.from !== 'user'); }
function _isPolledUserMsg(m) { return !!(m && m.from === 'user'); }
function _polledMessageKey(m) {
  if (!m) return '';
  return String(m.id || `${m.from || ''}\u0000${m.ts || ''}\u0000${m.text || ''}`);
}

function startPolling(cid) {
  if (pollTimers.has(cid)) return;
  const timer = setInterval(async () => {
    // Timer identity, rather than mere map membership, is the cancellation
    // token. `clearInterval` prevents future callbacks but cannot cancel a
    // history request that an earlier tick already started; the cid may also
    // be stopped and re-started while that request is in flight.
    if (pollTimers.get(cid) !== timer) return;
    try {
      const historyUrl = typeof _historyRequestUrl === 'function'
        ? _historyRequestUrl(cid)
        : `/api/conversations/${cid}/history?limit=10`;
      const res = await apiFetch(historyUrl);
      const data = await res.json();
      // The live stream may have completed while either await above was in
      // flight. Never let that stale poll fall through to _onPolledResponse:
      // it would reload the whole transcript after the final bubble was
      // already painted, causing a visible "Loading…" flash on every reply.
      if (pollTimers.get(cid) !== timer) return;
      if (!data.ok || !data.history) return;
      // Same visibility filter as loadConversationHistory (drops `dispatch`
      // records AND redundant routing-only commander tails) so the polled
      // count matches what's actually rendered — a mismatch makes polling
      // think a "new" message arrived and reload on a loop.
      const msgs = data.history.filter((m) => (
        typeof _isVisibleGroupHistoryRecord === 'function'
          ? _isVisibleGroupHistoryRecord(m)
          : !(m && m.dispatch)
      ));
      const last = msgs[msgs.length - 1];
      const known = pollMsgCounts.get(cid) || '';
      const lastKey = _polledMessageKey(last);
      const hasServerRuntime = !!data.conversation
        && Object.prototype.hasOwnProperty.call(data.conversation, 'processing');
      const runtimeBusy = hasServerRuntime
        ? data.conversation.processing === true
        : isGroupConversationBusy(cid);

      if (lastKey && lastKey !== known && _isPolledAssistantMsg(last)) {
        // New visible assistant message arrived. While the commander is
        // still orchestrating, this may be a mid-turn reply while other
        // actors are still running; reloading history then detaches live
        // placeholders and makes bubbles flash. Treat polling as rescue only
        // once runtime is idle; the live stream owns in-flight DOM updates.
        if (runtimeBusy) {
          const recovered = await window.ConversationRuntime?.recoverPolledMessages?.(cid, msgs);
          if (pollTimers.get(cid) !== timer) return;
          if (recovered) pollMsgCounts.set(cid, lastKey);
          return;
        }
        pollMsgCounts.set(cid, lastKey);
        stopPolling(cid);
        _onPolledResponse(cid, last);
        return;
      }

      // Local busy state can outlive the IPC stream if the renderer missed the
      // terminal state_changed event. Once main says runtime is idle, use the
      // persisted last assistant message to settle any leftover placeholder.
      if (!runtimeBusy && isConvPending(cid) && _isPolledAssistantMsg(last)) {
        pollMsgCounts.set(cid, lastKey);
        stopPolling(cid);
        _onPolledResponse(cid, last);
        return;
      }

      // If server is no longer processing but last message is still user → request was lost
      if (_isPolledUserMsg(last) && data.conversation?.processing === false) {
        stopPolling(cid);
        _onPolledResponse(cid, t('chat.reply_interrupted'), true);
        return;
      }

      // Server crashed mid-request: processing=true but stuck longer than the
      // model idle watchdog (30 min) + a small buffer. Shorter thresholds would
      // trip on genuine long agent runs.
      const since = data.conversation?.processing_since;
      if (_isPolledUserMsg(last) && data.conversation?.processing === true && since) {
        const elapsedSec = (Date.now() - new Date(since).getTime()) / 1000;
        if (elapsedSec > 2100) {
          stopPolling(cid);
          _onPolledResponse(cid, t('chat.reply_timeout'), true);
        }
      }
    } catch (_) {}
  }, 3000);
  pollTimers.set(cid, timer);
}

function stopPolling(cid) {
  const t = pollTimers.get(cid);
  if (t) { clearInterval(t); pollTimers.delete(cid); }
}

function _onPolledResponse(cid, contentOrMessage, isError = false) {
  const polledMessage = contentOrMessage && typeof contentOrMessage === 'object'
    ? contentOrMessage
    : null;
  const content = polledMessage ? (polledMessage.text || '') : contentOrMessage;
  const state = pendingConvs.get(cid);
  pendingConvs.delete(cid);
  setGroupConversationBusy(cid, false);
  _updateConvSidebarBadge(cid, false);

  const el = state?.loadingEl;
  // Drop the standalone loading bubble (if any) and re-load history. Going
  // through `loadConversationHistory` instead of swapping innerHTML inline
  // matters for messages that carry sidecar fields the poll handler doesn't
  // see — process trail, produced files, form widget, plan announcement,
  // created-agent chip. The historical "patch the bubble's content
  // directly" path lost all of those because polling only had access to
  // `last.content` (a string), so an aborted commander turn that was
  // recovered by polling rendered as bare "(stopped)" without the process
  // info that the user already watched stream in.
  if (el && el.isConnected) {
    const finalEl = el.querySelector('[data-role="final"]');
    const alreadyFinalized = finalEl
      && finalEl.style.display !== 'none'
      && (finalEl.textContent || '').trim().length > 0;
    if (alreadyFinalized) {
      // Stream already finalized this bubble in place. Leave it alone only
      // when polling is reporting the same persisted message. If polling saw a
      // later assistant record (common for plan-generated user forms emitted
      // right after the commander's plan card), reload history so sidecar
      // fields like `form` are mounted instead of silently disappearing.
      const finalizedId = el.dataset.msgId || '';
      const polledId = polledMessage?.id || '';
      const sidecarMissing = !!polledMessage && (
        (polledMessage.form && !el.querySelector('.chat-input-form'))
        || (Array.isArray(polledMessage.produced) && polledMessage.produced.length && !el.querySelector('.chat-msg-produced'))
        || (polledMessage.plan_announcement && !el.querySelector('.chat-plan-announce'))
      );
      if (polledId && (finalizedId !== polledId || sidecarMissing)) {
        if (cid === currentCid) {
          loadConversationHistory(cid);
          _updateConvSendUI(cid);
        }
        return;
      }
      if (cid === currentCid) _updateConvSendUI(cid);
      return;
    }
    if (isError) {
      // Polling reports interrupt / timeout — render the inline error and
      // bail. No persisted message to fetch back, so a full reload would
      // just remove the bubble we just told the user "request lost".
      el.querySelector('.chat-bubble').innerHTML =
        `<span style="color:var(--danger)">${escapeHtml(content)}</span>`;
      const metaTime = el.querySelector('.chat-meta-time');
      if (metaTime) metaTime.textContent = formatTime(new Date().toISOString());
      el.scrollIntoView({ behavior: 'smooth', block: 'end' });
      if (cid === currentCid) _updateConvSendUI(cid);
      return;
    }
    el.remove();
  }
  if (cid === currentCid) {
    loadConversationHistory(cid);
    _updateConvSendUI(cid);
  }
}

// ─── Init ───

document.addEventListener('DOMContentLoaded', () => {
  // Tag the shell for platform-specific CSS (traffic-light inset on macOS).
  if (/Mac|iPhone|iPod|iPad/i.test(navigator.userAgent)) {
    document.documentElement.classList.add('is-mac');
  }
  bindStaticHandlers();
  initAuth();
});

function bindStaticHandlers() {
  window.orkas.onPushEvent('conversations:open-from-notification', (payload) => {
    _openTaskNotificationConversation(payload);
  });

  // Sidebar nav
  document.getElementById('new-chat-btn').addEventListener('click', () => _setViewFromSidebar('new-chat'));
  document.getElementById('auto-btn')?.addEventListener('click', () => _setViewFromSidebar('auto'));
  document.getElementById('agents-btn').addEventListener('click', () => _setViewFromSidebar('agents'));
  document.getElementById('skills-btn').addEventListener('click', () => _setViewFromSidebar('skills'));
  document.getElementById('connectors-btn')?.addEventListener('click', () => _setViewFromSidebar('connectors'));
  document.getElementById('apps-btn')?.addEventListener('click', () => _setViewFromSidebar('apps'));
  document.getElementById('contexts-btn').addEventListener('click', () => _setViewFromSidebar('contexts'));
  document.getElementById('settings-btn')?.addEventListener('click', () => _setViewFromSidebar('settings'));

  // Global search trigger + Cmd+K
  _bindGlobalSearch();

  // New-chat landing input
  const newInput = document.getElementById('new-chat-input');
  const newBtn = document.getElementById('new-chat-send-btn');
  newBtn.addEventListener('click', handleNewChatSubmit);
  newInput.addEventListener('keydown', (e) => {
    // Plain Enter sends; Shift/Cmd/Ctrl+Enter inserts a newline. Skip while
    // IME is composing — Chinese pinyin commit also fires Enter and would
    // otherwise send a half-typed message.
    // keyCode 229 catches older Electron / Safari builds (CLAUDE.md §8).
    if (e.isComposing || e.keyCode === 229) return;
    if (_handleModifiedComposerEnter(e)) return;
    if (_isPlainComposerEnter(e)) {
      e.preventDefault();
      handleNewChatSubmit();
    }
  });
  newInput.addEventListener('input', () => autoGrow(newInput, 260));
  if (typeof _initNewChatAttachInput === 'function') _initNewChatAttachInput();

  // Conversation detail input
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('chat-send-btn');
  chatSendBtn.addEventListener('click', () => {
    // While a reply is streaming, the button is a stop icon — click aborts
    // the in-flight reply. Queued messages (if any) stay put and will drain
    // one-by-one after the abort completes. To add to the queue, use Enter.
    if (currentCid && isConvPending(currentCid)) {
      abortConvStream(currentCid, { userInitiated: true });
    } else {
      handleChatSubmit();
    }
  });
  chatInput.addEventListener('keydown', (e) => {
    // Plain Enter sends; Shift/Cmd/Ctrl+Enter inserts a newline. Skip IME
    // (CLAUDE.md §8 — keyCode 229 belt-and-suspenders for older builds).
    if (e.isComposing || e.keyCode === 229) return;
    if (_handleModifiedComposerEnter(e)) return;
    if (_isPlainComposerEnter(e)) {
      e.preventDefault();
      handleChatSubmit();
    }
  });
  chatInput.addEventListener('input', () => {
    autoGrow(chatInput, 200);
    _saveDraft(currentCid);
  });

  // Quick-create-agent button (conversation toolbar). Pushes a canned
  // request through handleChatSubmit so it honors queue / pending /
  // attachments state — we don't bypass the send pipeline.
  // The "Create agent" inline entry is dynamically created inside
  // conversation.js and binds its own click handler.

  // Agents (grid + detail)
  // "Done" button (only visible while editing) — exits edit mode.
  document.getElementById('new-chat-external-agent-btn')?.addEventListener('click', () => {
    setView('agents', null, { entryPoint: 'new_chat_external_agent' });
    openAgentModal({ initialTab: 'external' });
  });
  document.getElementById('create-agent-btn')?.addEventListener('click', () => {
    _trackAgentCreateOpen('agents_create_button');
    openAgentModal();
  });
  document.getElementById('agents-more-btn')?.addEventListener('click', () => {
    const load = typeof loadRendererFeature === 'function' ? loadRendererFeature : window.loadRendererFeature;
    if (typeof load !== 'function') return;
    load('marketplace').then(() => openMarketplace('agent')).catch(() => {});
  });
  document.getElementById('agents-back-btn')?.addEventListener('click', () => _showAgentsGridView());
  document.getElementById('agent-use-btn')?.addEventListener('click', () => {
    if (_selectedAgent && !_agentsCache?.some((a) => a.agent_id === _selectedAgent.id && a.enabled === false)) {
      useAgent(_selectedAgent.id);
    }
  });
  document.getElementById('agent-edit-btn')?.addEventListener('click', toggleAgentEditMode);
  document.getElementById('agent-delete-btn')?.addEventListener('click', deleteSelectedAgent);
  document.getElementById('agent-upload-marketplace-btn')?.addEventListener('click', () => {
    // Upload is allowed for both custom AND builtin (dev mode) — same
    // marketplace publishing flow per CLAUDE.md §11. The row-menu handler
    // (agents.js) already does this; the detail-page handler had a stale
    // `source === 'custom'` guard that silently swallowed clicks on builtin
    // detail pages.
    if (_selectedAgent && typeof _isAgentProfileMock === 'function' && _isAgentProfileMock(_selectedAgent.id)) return;
    if (_selectedAgent && typeof openMarketplaceUpload === 'function') {
      openMarketplaceUpload('agent', _selectedAgent.id, _selectedAgent.source);
    }
  });
  document.getElementById('agent-chat-clear-btn')?.addEventListener('click', clearAgentChat);
  // Agent inline chat: only bind auto-grow here. Send/abort/plain Enter are
  // wired lazily by createChatController in _ensureAgentChatController.
  const agentChatInput = document.getElementById('agents-chat-input');
  agentChatInput?.addEventListener('input', () => autoGrow(agentChatInput, 120));
  bindAgentPickers();
  // Esc returns to grid when detail view is open
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const agentsPanel = document.getElementById('panel-agents');
    if (!agentsPanel || !agentsPanel.classList.contains('active')) return;
    const detail = document.getElementById('agents-detail-view');
    if (detail && detail.style.display !== 'none') {
      _showAgentsGridView();
      e.preventDefault();
    }
  });
  window.addEventListener('i18n-change', () => {
    if (_agentsCache) renderAgentsGrid(_agentsCache);
  });

}

function autoGrow(el, maxPx) {
  if (typeof syncChatRichComposerHeight === 'function' && syncChatRichComposerHeight(el, maxPx)) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, maxPx) + 'px';
}
