// ─── Boot ─────────────────────────────────────────────────────────────────
// No auth gate in Electron; jump straight to bootApp on DOMContentLoaded.
const _bootLog = createLogger('boot');
async function initAuth() { bootApp(); }

async function bootApp() {
  _bootLog.info('app boot');
  _migrateLegacyLocalStorageKeys();
  await initI18n();
  await initUser();
  await initUserWorkspace();
  // Avatar catalog must be ready before loadAgents (which triggers card rendering).
  await initAvatarCatalog();
  await refreshModelGuard();
  await loadProjects();
  await loadConversations();
  await loadAgents();
  // Warm the commander avatar cache so the first chat render doesn't fall
  // back to the default for a frame.
  if (typeof _ensureCommanderAvatarLoaded === 'function') _ensureCommanderAvatarLoaded();
  _stampSettingsVersion();
  _restoreLastView();
}

async function _stampSettingsVersion() {
  const el = document.getElementById('settings-version');
  if (!el || !window.orkas || typeof window.orkas.appVersion !== 'function') return;
  try {
    const v = await window.orkas.appVersion();
    if (v) el.textContent = 'v' + v;
  } catch (_) { /* ignore — non-critical */ }
}

// Dev-mode editing of built-in skills / agents is stripped from the
// open-source build (the underlying `isDevEnv()` / built-in dual-write IPC
// stack lives in the in-app debug panel that's only present in PC).
// Renderer modules still branch on `isDevMode()` for those entry points,
// so we stub it to false here.
function isDevMode() { return false; }

// One-shot rename of legacy brand-prefixed localStorage keys
// (`orkas_*` / `orkas.*`) to the unprefixed form. After stamping,
// subsequent boots are no-ops. Placed at the very start of boot so no
// other module reads a stale key first.
function _migrateLegacyLocalStorageKeys() {
  try {
    if (localStorage.getItem('_ls_brand_migration_v1')) return;
    const fixedMap = {
      'orkas_last_view':           'last_view',
      'orkas_search_history':      'search_history',
      'orkas.chat.recipientByCid': 'chat.recipientByCid',
      'orkas.kb-picker.last-dir':  'kb-picker.last-dir',
    };
    for (const [oldK, newK] of Object.entries(fixedMap)) {
      const v = localStorage.getItem(oldK);
      if (v != null && localStorage.getItem(newK) == null) {
        localStorage.setItem(newK, v);
      }
      localStorage.removeItem(oldK);
    }
    const toRename = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('orkas_queue_') || k.startsWith('orkas_draft_'))) {
        toRename.push(k);
      }
    }
    for (const k of toRename) {
      const newK = k.replace(/^orkas_/, '');
      const v = localStorage.getItem(k);
      if (v != null && localStorage.getItem(newK) == null) {
        localStorage.setItem(newK, v);
      }
      localStorage.removeItem(k);
    }
    localStorage.setItem('_ls_brand_migration_v1', '1');
  } catch (_) {
    /* localStorage unavailable / quota — skip; no-op next boot */
  }
}

// Persist the current view across reloads (localStorage keyed by user).
const _LAST_VIEW_KEY = 'last_view';

function _saveLastView(view, cid) {
  try {
    localStorage.setItem(_LAST_VIEW_KEY, JSON.stringify({ view, cid: cid || null }));
  } catch (_) {}
}

function _restoreLastView() {
  let saved = null;
  try {
    const raw = localStorage.getItem(_LAST_VIEW_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch (_) {}

  const view = saved?.view;
  const cid = saved?.cid;

  if (view === 'conversation' && cid && conversations.some(c => c.conversation_id === cid)) {
    setView('conversation', cid);
    return;
  }
  if (view === 'agents' || view === 'skills' || view === 'contexts' || view === 'new-chat') {
    setView(view);
    return;
  }
  setView('new-chat');
}

async function initUser() {
  try {
    const res = await apiFetch('/api/user/init');
    const data = await res.json();
    if (data.ok && data.user_id) {
      currentUserId = data.user_id;
      _bootLog.info('user init', { user_id: currentUserId });
    }
  } catch (e) {
    _bootLog.error('init user failed', { error: (e && e.message) || String(e) });
  }
}

// ─── View routing ───

function setView(view, cid, opts = {}) {
  if (currentView !== view || (view === 'conversation' && currentCid !== cid)) {
    _bootLog.info('view change', { view, cid: cid || undefined });
  }
  currentView = view;
  _saveLastView(view, cid);
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  const panelId = view === 'new-chat' ? 'panel-new-chat'
                : view === 'agents' ? 'panel-agents'
                : view === 'skills' ? 'panel-skills'
                : view === 'contexts' ? 'panel-contexts'
                : view === 'settings' ? 'panel-settings'
                : 'panel-conversation';
  document.getElementById(panelId).classList.add('active');

  document.getElementById('new-chat-btn').classList.toggle('active', view === 'new-chat');
  document.getElementById('agents-btn').classList.toggle('active', view === 'agents');
  document.getElementById('skills-btn').classList.toggle('active', view === 'skills');
  document.getElementById('contexts-btn')?.classList.toggle('active', view === 'contexts');
  document.getElementById('settings-btn')?.classList.toggle('active', view === 'settings');
  document.querySelectorAll('.conv-item').forEach(it => {
    it.classList.toggle('active', view === 'conversation' && it.dataset.cid === cid);
  });

  if (view === 'conversation' && cid) {
    currentCid = cid;
    if (typeof onEnterConversationView === 'function') onEnterConversationView();
    // If this conversation has an in-flight stream and its bubble is still
    // attached to #chat-history (sidebar tab toggle didn't wipe it), skip
    // the reload — wiping would orphan the bubble while the active stream
    // closure keeps writing into the detached node, leaving the "thinking…" indicator stuck.
    const pendingState = pendingConvs.get(cid);
    const streamBubbleAlive = !!pendingState?.loadingEl?.isConnected;

    if (opts.skipLoad) {
      // Fresh conversation — caller will drive appends. Clear any stale content.
      const container = document.getElementById('chat-history');
      container.innerHTML = '';
    } else if (!streamBubbleAlive) {
      loadConversationHistory(cid);
    }
    // If this conversation is still pending a response, re-attach loading indicator
    if (isConvPending(cid) && !opts.skipLoad && !streamBubbleAlive) {
      const state = pendingConvs.get(cid);
      // Will be (re)appended after history loads — handled in loadConversationHistory
      state.needsIndicator = true;
    }
    // Restore input draft + queue panel for this conversation
    if (!opts.skipLoad) _restoreDraft(cid);
    renderMessageQueue(cid);
    // Attachment chips: bind the "+" button once, redraw chip area for the
    // current cid, and resync with the server in case the previous visit
    // left files on disk without their dataUrl.
    if (typeof _initChatAttachInput === 'function') _initChatAttachInput();
    if (typeof _chatAttachRenderChips === 'function') _chatAttachRenderChips();
    if (!opts.skipLoad && typeof _chatAttachRefreshFromServer === 'function') {
      _chatAttachRefreshFromServer(cid);
    }
    // If we returned to a conversation with queued items and nothing is
    // streaming, kick off the next one automatically.
    if (!isConvPending(cid) && (messageQueues.get(cid) || []).length) {
      _dispatchNextQueued(cid);
    }
    _updateConvSendUI(cid);
    setTimeout(() => document.getElementById('chat-input')?.focus(), 50);
  } else if (view === 'new-chat') {
    // Leaving conversation view: hide any queue panel remnants.
    renderMessageQueue(null);
    currentCid = null;
    // Reset the new-chat ephemeral recipient back to commander every time
    // the landing page is entered — the user explicitly asked for a clean
    // slate here, so prior in-session picks don't leak forward.
    if (typeof onEnterNewChatView === 'function') onEnterNewChatView();
    // Draft attachment chips (commander tab's pool under `main_chat/`): re-paint from
    // the in-memory Map immediately, and re-sync with disk in case a prior
    // session left files on disk without a dataUrl.
    if (typeof _chatAttachRenderChips === 'function') _chatAttachRenderChips(DRAFT_CID);
    if (typeof _chatAttachRefreshFromServer === 'function') _chatAttachRefreshFromServer(DRAFT_CID);
    setTimeout(() => document.getElementById('new-chat-input')?.focus(), 50);
  } else if (view === 'agents') {
    currentCid = null;
    loadAgents();
  } else if (view === 'skills') {
    currentCid = null;
    loadSkills();
  } else if (view === 'contexts') {
    currentCid = null;
    loadContexts();
  } else if (view === 'settings') {
    currentCid = null;
    loadSettings();
  } else {
    currentCid = null;
  }
}

