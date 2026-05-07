/* Orkas Frontend */

let currentUserId = '';
let accessPassword = '';

// current view: 'new-chat' | 'conversation' | 'agents'
let currentView = 'new-chat';
let currentCid = null;
let conversations = [];

// Per-conversation pending state
// key: cid, value: { loadingEl: HTMLElement | null, needsIndicator: bool,
//                    controller: AbortController | null, aborted: bool }
const pendingConvs = new Map();

function isConvPending(cid) { return pendingConvs.has(cid); }

// Per-conversation queued messages (sent sequentially, one at a time).
// key: cid, value: Array<{ id, content, skill }>
const messageQueues = new Map();
const _QUEUE_KEY = (cid) => `queue_${cid}`;
const _DRAFT_KEY = (cid) => `draft_${cid}`;

// Polling: detect assistant responses even after page refresh / reconnect
const pollTimers = new Map();    // cid → setInterval id
const pollMsgCounts = new Map(); // cid → last known message count

// Per-conversation cached enabled state of the bound agent. Backend stamps
// `agent_enabled` on the conversation payload at history-load time; this
// map mirrors it for UI guards (input disable + banner). Refreshed on each
// `loadConversationHistory` call. True for conversations with no agent_id.
const convAgentEnabledByCid = new Map();

function startPolling(cid) {
  if (pollTimers.has(cid)) return;
  const timer = setInterval(async () => {
    if (!pollTimers.has(cid)) return;
    try {
      const res = await apiFetch(`/api/conversations/${cid}/history?limit=500`);
      const data = await res.json();
      if (!data.ok || !data.history) return;
      const msgs = data.history;
      const last = msgs[msgs.length - 1];
      const known = pollMsgCounts.get(cid) || 0;

      if (msgs.length > known && last?.role === 'assistant') {
        // New assistant message arrived
        pollMsgCounts.set(cid, msgs.length);
        stopPolling(cid);
        _onPolledResponse(cid, last.content);
        return;
      }

      // If server is no longer processing but last message is still user → request was lost
      if (last?.role === 'user' && data.conversation?.processing === false) {
        stopPolling(cid);
        _onPolledResponse(cid, t('chat.reply_interrupted'), true);
        return;
      }

      // Server crashed mid-request: processing=true but stuck longer than the
      // model idle watchdog (10 min) + a small buffer. Shorter thresholds would
      // trip on genuine long agent runs.
      const since = data.conversation?.processing_since;
      if (last?.role === 'user' && data.conversation?.processing === true && since) {
        const elapsedSec = (Date.now() - new Date(since).getTime()) / 1000;
        if (elapsedSec > 720) {
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

function _onPolledResponse(cid, content, isError = false) {
  const state = pendingConvs.get(cid);
  pendingConvs.delete(cid);
  _updateConvSidebarBadge(cid, false);

  const el = state?.loadingEl;
  // Drop the standalone loading bubble (if any) and re-load history. Going
  // through `loadConversationHistory` instead of swapping innerHTML inline
  // matters for messages that carry sidecar fields the poll handler doesn't
  // see — process trail, produced files, form widget, plan announcement,
  // created-agent chip. The historical "patch the bubble's content
  // directly" path lost all of those because polling only had access to
  // `last.content` (a string), so an aborted commander turn that was
  // recovered by polling rendered as bare "（已中断）" without the process
  // info that the user already watched stream in.
  if (el && el.isConnected) {
    const finalEl = el.querySelector('[data-role="final"]');
    const alreadyFinalized = finalEl
      && finalEl.style.display !== 'none'
      && (finalEl.textContent || '').trim().length > 0;
    if (alreadyFinalized) {
      // Stream already finalized this bubble in place — leave it alone.
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
  // Sidebar nav
  document.getElementById('new-chat-btn').addEventListener('click', () => setView('new-chat'));
  document.getElementById('agents-btn').addEventListener('click', () => setView('agents'));
  document.getElementById('skills-btn').addEventListener('click', () => setView('skills'));
  document.getElementById('contexts-btn').addEventListener('click', () => setView('contexts'));
  document.getElementById('settings-btn')?.addEventListener('click', () => setView('settings'));

  // Global search trigger + Cmd+K
  _bindGlobalSearch();

  // New-chat landing input
  const newInput = document.getElementById('new-chat-input');
  const newBtn = document.getElementById('new-chat-send-btn');
  newBtn.addEventListener('click', handleNewChatSubmit);
  newInput.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter newline; Ctrl/Cmd+Enter also sends (kept for
    // muscle memory). Skip while IME is composing — Chinese pinyin commit
    // also fires Enter and would otherwise send a half-typed message.
    // keyCode 229 catches older Electron / Safari builds (CLAUDE.md §8).
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
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
      abortConvStream(currentCid);
    } else {
      handleChatSubmit();
    }
  });
  chatInput.addEventListener('keydown', (e) => {
    // Enter sends; Shift+Enter newline; Ctrl/Cmd+Enter also sends. Skip IME
    // (CLAUDE.md §8 — keyCode 229 belt-and-suspenders for older builds).
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
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
  // 创建智能体 inline 入口在 conversation.js 内动态创建并自带 click 绑定。

  // Agents (grid + detail)
  // 完成 button (only visible while editing) — exits edit mode.
  document.getElementById('create-agent-btn')?.addEventListener('click', () => openAgentModal());
  document.getElementById('agents-back-btn')?.addEventListener('click', () => _showAgentsGridView());
  document.getElementById('agent-use-btn')?.addEventListener('click', () => {
    if (_selectedAgent) useAgent(_selectedAgent.id);
  });
  document.getElementById('agent-edit-btn')?.addEventListener('click', toggleAgentEditMode);
  document.getElementById('agent-delete-btn')?.addEventListener('click', deleteSelectedAgent);
  document.getElementById('agent-promote-btn')?.addEventListener('click', () => {
    if (_selectedAgent?.source === 'custom') promoteCustomAgent(_selectedAgent.id);
  });
  document.getElementById('agent-chat-clear-btn')?.addEventListener('click', clearAgentChat);
  // Agent inline chat: only bind auto-grow here. Send/abort/Cmd+Enter are
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

  // Skill buttons
  document.getElementById('create-skill-btn')?.addEventListener('click', () => openSkillModal());
  document.getElementById('skill-use-btn')?.addEventListener('click', () => {
    if (_selectedSkill) useSkill(_selectedSkill.id, _selectedSkill.name);
  });
  document.getElementById('skill-edit-btn')?.addEventListener('click', toggleSkillEditMode);
  document.getElementById('skill-delete-btn')?.addEventListener('click', deleteSelectedSkill);
  document.getElementById('skill-promote-btn')?.addEventListener('click', () => {
    if (_selectedSkill?.source === 'custom') promoteCustomSkill(_selectedSkill.id);
  });
  document.getElementById('skills-detail-name')?.addEventListener('click', _handleSkillNameClick);
  document.getElementById('skill-chat-clear-btn')?.addEventListener('click', clearSkillChat);

  // Detail-view chrome: 「← 返回技能库」 + 折叠区开关 + Esc 返回 + 外点关 ⋯ 菜单
  document.getElementById('skills-back-btn')?.addEventListener('click', () => _showSkillsGridView());
  document.getElementById('skills-source-toggle')?.addEventListener('click', () => _toggleSkillsSource());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const skillsPanel = document.getElementById('panel-skills');
    if (!skillsPanel || !skillsPanel.classList.contains('active')) return;
    const detail = document.getElementById('skills-detail-view');
    if (detail && detail.style.display !== 'none') {
      _showSkillsGridView();
      e.preventDefault();
    }
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('skill-row-menu');
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(e.target)) return;
    if (e.target.closest('[data-skill-more]')) return;
    _closeSkillRowMenu();
  });
  window.addEventListener('scroll', _closeSkillRowMenu, true);
  window.addEventListener('resize', _closeSkillRowMenu);
  window.addEventListener('i18n-change', () => {
    _closeSkillRowMenu();
    if (_skillsCache) renderSkillsGrid(_skillsCache);
  });

  // Inline skill chat — input auto-grow only here; send/Cmd+Enter are wired
  // lazily by createChatController when edit mode first opens (avoids double-
  // binding and keeps the skill controller as the single source of truth).
  const skillChatInput = document.getElementById('skills-chat-input');
  skillChatInput?.addEventListener('input', () => autoGrow(skillChatInput, 120));

  bindSkillPicker();

  // Knowledge base (two-region: per-user staging + shared organized)
  document.getElementById('ctx-tmp-new-btn')?.addEventListener('click', createNewCtxTmpDraft);
  document.getElementById('ctx-tmp-upload-btn')?.addEventListener('click', () => {
    document.getElementById('ctx-tmp-file-input')?.click();
  });
  document.getElementById('ctx-tmp-file-input')?.addEventListener('change', (e) => {
    handleCtxTmpUpload(e.target.files);
    e.target.value = '';
  });
  document.getElementById('ctx-tmp-new-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveCtxTmpNew(); }
  });
}

function autoGrow(el, maxPx) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, maxPx) + 'px';
}

