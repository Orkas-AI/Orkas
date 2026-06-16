// ─── Boot ─────────────────────────────────────────────────────────────────
const _bootLog = createLogger('boot');
async function initAuth() {
  bootApp();
}

// ─── Boot performance guardrails ────────────────────────────────────────────
//
// `bootApp` is the critical path from window open → "user sees last
// conversation". Three structural rules + a runtime check keep it honest:
//
//   R1. THREE STAGES ONLY. Do not add a fourth serial `await` between
//       `initI18n` and `_restoreLastView`. Any new boot-time work MUST
//       land in Stage A (independent prep), Stage B (chat first-paint
//       prereqs), or the deferred Stage C tail (non-critical warmup).
//   R2. STAGE A / STAGE B ITEMS MUST BE FIRE-AND-RETURN. No new module
//       inside the Promise.all may emit a fire-and-forget `await` inside
//       another `await` of the same Promise.all — that defeats parallelism.
//   R3. NON-CRITICAL WORK GOES IN STAGE C. If a task does not contribute
//       to the user seeing the last conversation (subscriptions, tab-only
//       data, banners, warmup caches), defer it.
//
// `_bootStage` wraps each stage with a timer; a stage exceeding
// `_BOOT_STAGE_WARN_MS` or a total boot exceeding `_BOOT_TOTAL_WARN_MS`
// emits `log.warn` with the breakdown. That single warn line is the
// regression alarm — any future commit that re-introduces a serial await
// will show up in the next boot's log.
const _BOOT_STAGE_WARN_MS = 1500;
const _BOOT_TOTAL_WARN_MS = 3000;
let _sidebarVersionBaseLabel = '';

async function _bootStage(name, fn) {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = Math.round(performance.now() - t0);
    if (ms > _BOOT_STAGE_WARN_MS) {
      _bootLog.warn(`boot stage slow: ${name} ${ms}ms (threshold ${_BOOT_STAGE_WARN_MS}ms)`);
    } else {
      _bootLog.info(`boot stage: ${name} ${ms}ms`);
    }
  }
}

async function bootApp() {
  _bootLog.info('app boot');
  const _bootT0 = performance.now();
  _migrateLegacyLocalStorageKeys();
  // i18n must be ready before any other UI module renders labels.
  await _bootStage('initI18n', initI18n);

  // ── Stage A (parallel, no inter-dependencies) ──────────────────────
  // All four are independent IPC calls. Three downstream constraints,
  // all honored by staging:
  //   - `_stampSettingsVersion` stamps body.is-dev BEFORE Stage B's
  //     `loadAgents` / later `loadSkills` read `false`.
  //   - `initAvatarCatalog` must finish BEFORE `loadAgents` so cards
  //     render with their icon SVGs instead of a fallback frame.
  //   - `initUser` → `initUserWorkspace` stays sequential (workspace
  //     paths key off the activated uid).
  // `refreshModelGuard` is the no-model banner — non-critical, deferred
  // to Stage C with the other warmup-only work.
  await _bootStage('stageA', () => Promise.all([
    _stampSettingsVersion(),
    (async () => { await initUser(); await initUserWorkspace(); })(),
    initAvatarCatalog(),
    loadProjects(),
  ]));

  // ── Stage B (parallel, depends on Stage A) ─────────────────────────
  // Both feed the first chat view: the sidebar list (loadConversations)
  // and the @-mention / actor-label cache `_agentsCache` that
  // `loadConversationHistory` → `_groupActorLabel` reads.
  await _bootStage('stageB', () => Promise.all([
    loadConversations(),
    loadAgents(),
  ]));

  // User now sees the last conversation. _ensureCommanderAvatarLoaded is
  // fire-and-forget but kicked off NOW (not in Stage C) so the first
  // chat render finds the commander avatar warm; one cheap IPC, worth
  // it to avoid a default-avatar flash on the first frame.
  _restoreLastView();
  if (typeof _ensureCommanderAvatarLoaded === 'function') _ensureCommanderAvatarLoaded();
  // Inline `delete_file` confirm-card subscription is attached here (NOT in
  // Stage C) so a tool call fired within the first 2.5 s of boot still has
  // a receiver. The listener is cheap (one IPC subscribe); deferring it
  // would risk the main-side `delete_file` tool sitting on a 5-minute
  // timeout because no renderer was listening yet.
  if (typeof startDeleteFileConfirmSubscription === 'function') {
    startDeleteFileConfirmSubscription();
  }

  const _bootTotalMs = Math.round(performance.now() - _bootT0);
  if (_bootTotalMs > _BOOT_TOTAL_WARN_MS) {
    _bootLog.warn(`boot total slow: ${_bootTotalMs}ms (threshold ${_BOOT_TOTAL_WARN_MS}ms) — likely a new serial await landed in bootApp; see boot stage timings above`);
  } else {
    _bootLog.info(`boot total: ${_bootTotalMs}ms`);
  }

  // ── Stage C (deferred ~2.5 s, no impact on first paint) ────────────
  // These do not block first-frame interactivity:
  //   - loadSkills: only the skills tab uses it; first chat render does not.
  //   - refreshModelGuard: no-model banner can appear a tick later.
  //   - subscriptions: passive event sinks, not on the critical path.
  setTimeout(() => {
    try { loadSkills(); } catch (_) { /* non-fatal */ }
    try { refreshModelGuard(); } catch (_) { /* non-fatal */ }
    if (typeof startAutoEventsSubscription === 'function') {
      startAutoEventsSubscription();
    }
  }, 2500);
}

async function _stampSettingsVersion() {
  _bindSidebarVersionUpdate();
  if (!window.orkas || typeof window.orkas.env !== 'function') return;
  try {
    const env = await window.orkas.env();
    if (env && env.version) {
      _setRendererVersionLabel(env.version);
    }
    // Stamp body so renderer modules can branch on dev mode synchronously
    // via `document.body.classList.contains('is-dev')`. Used by skills /
    // agents grids to expose builtin ⋯ menu (edit / delete) and the
    // "promote to builtin" item on custom cards.
    if (env && env.isDev) document.body.classList.add('is-dev');
  } catch (_) { /* ignore — non-critical */ }
}

function _formatRendererVersionLabel(version) {
  const raw = String(version || '').trim();
  if (!raw) return '';
  return raw.toLowerCase().startsWith('v') ? raw : `v${raw}`;
}

function _setRendererVersionLabel(version) {
  const label = _formatRendererVersionLabel(version);
  if (!label) return;
  _sidebarVersionBaseLabel = label;
  _renderSidebarVersionUpdate();
}

function _renderSidebarVersionUpdate() {
  const el = document.getElementById('sidebar-version');
  if (!el) return;
  el.textContent = _sidebarVersionBaseLabel || '';
  el.title = _sidebarVersionBaseLabel ? t('sidebar.version_title', { version: _sidebarVersionBaseLabel }) : '';
  el.setAttribute('aria-label', el.title || el.textContent || 'Version');
  el.disabled = true;
  el.classList.remove('is-actionable', 'is-progress');
}

function _bindSidebarVersionUpdate() {}

// One-shot rename of legacy brand-prefixed localStorage keys
// (`orkas_*` / `orkas.*`). Rationale lives in
// plans/decouple-session-id-from-brand.md: avoid breaking another wave
// of user view state / drafts the next time the brand is renamed. After
// stamping, subsequent boots are no-ops. Placed at the very start of
// boot so no other module reads a stale key first.
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
  // Restart policy: only `conversation` view is remembered across launches.
  // Every other tab (agents / skills / contexts / connectors / apps / settings
  // / project detail / marketplace / devtools) intentionally falls back to
  // the commander (new-chat) — the user always lands on a known starting
  // point and doesn't accidentally resume a settings / inventory tab they
  // wandered into before quitting.
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
  setView('new-chat');
}

async function initUser() {
  try {
    const res = await apiFetch('/api/user/init');
    const data = await res.json();
    if (data.ok && data.user_id) {
      currentUserId = data.user_id;
      _bootLog.info('user init', { user_id: currentUserId });
      // Bind the telemetry identity as soon as we have a user_id;
      // Monitor handles dedupe + queueing internally, so no need to
      // check whether umami has finished initializing.
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
                : view === 'auto' ? 'panel-auto'
                : view === 'agents' ? 'panel-agents'
                : view === 'skills' ? 'panel-skills'
                : view === 'connectors' ? 'panel-connectors'
                : view === 'contexts' ? 'panel-contexts'
                : view === 'apps' ? 'panel-apps'
                : view === 'settings' ? 'panel-settings'
                : view === 'memory' ? 'panel-memory'
                : view === 'devtools' ? 'panel-devtools'
                : view === 'project' ? 'panel-project'
                : view === 'marketplace' ? 'panel-marketplace'
                : 'panel-conversation';
  document.getElementById(panelId).classList.add('active');

  document.getElementById('new-chat-btn').classList.toggle('active', view === 'new-chat');
  document.getElementById('auto-btn')?.classList.toggle('active', view === 'auto');
  document.getElementById('agents-btn').classList.toggle('active', view === 'agents');
  document.getElementById('skills-btn').classList.toggle('active', view === 'skills');
  document.getElementById('connectors-btn')?.classList.toggle('active', view === 'connectors');
  document.getElementById('contexts-btn')?.classList.toggle('active', view === 'contexts');
  document.getElementById('apps-btn')?.classList.toggle('active', view === 'apps');
  document.getElementById('settings-btn')?.classList.toggle('active', view === 'settings');
  document.getElementById('devtools-btn')?.classList.toggle('active', view === 'devtools');
  document.querySelectorAll('.conv-item').forEach(it => {
    it.classList.toggle('active', view === 'conversation' && it.dataset.cid === cid);
  });

  // Memory detail page renders on every entry (incl. boot last-view restore),
  // since memory.js owns the whole panel body. Reached only from Settings.
  if (view === 'memory' && typeof renderMemoryPage === 'function') renderMemoryPage();

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
      if (typeof _replayBufferedGroupEvents === 'function') _replayBufferedGroupEvents(cid);
    } else if (!streamBubbleAlive) {
      loadConversationHistory(cid);
    }
    // If this conversation is still pending a response, re-attach loading indicator
    if (isConvPending(cid) && !opts.skipLoad && !streamBubbleAlive) {
      const state = pendingConvs.get(cid);
      // Will be (re)appended after history loads — handled in loadConversationHistory
      if (state) state.needsIndicator = true;
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
    // Force-refresh on every tab visit. The mid-stream chip handler in
    // `conversation.js::_mountCreatedAgentChip` already calls `loadAgents(true)`
    // when an agent is created via commander, but that only fires while the
    // user is on the conversation view. If the user navigates to the agents
    // tab between or during creation streams, the chip path may not run /
    // may have raced, leaving `_agentsCache` stale and the tab missing the
    // newly-created agents. Cheap (one IPC + dir scan), and the tab is the
    // user's recovery path when something looks off — making it always show
    // ground truth.
    Promise.resolve(loadAgents(true))
      .then(() => {
        if (currentView === 'agents' && typeof refreshSelectedAgentDetail === 'function') {
          return refreshSelectedAgentDetail();
        }
        return null;
      })
      .catch((e) => _bootLog.warn('agents refresh on tab entry failed', { error: (e && e.message) || String(e) }));
  } else if (view === 'skills') {
    currentCid = null;
    // Same reasoning as the agents branch above.
    Promise.resolve(loadSkills(true))
      .then(() => {
        if (currentView === 'skills' && typeof refreshSelectedSkillDetail === 'function') {
          return refreshSelectedSkillDetail();
        }
        return null;
      })
      .catch((e) => _bootLog.warn('skills refresh on tab entry failed', { error: (e && e.message) || String(e) }));
  } else if (view === 'connectors') {
    currentCid = null;
    // Status flips during a session (server health, token expiry); always re-fetch on entry.
    if (typeof loadConnectors === 'function') loadConnectors();
  } else if (view === 'contexts') {
    currentCid = null;
    loadContexts();
  } else if (view === 'auto') {
    currentCid = null;
    // Force-refresh on every tab visit: a scheduled fire or remote sync pull
    // may have updated the list while the user was elsewhere.
    if (typeof loadAutoList === 'function') loadAutoList(true);
  } else if (view === 'apps') {
    currentCid = null;
    // Force-refresh on every visit (same rationale as agents/skills): a
    // "保存" can land while the user is on another tab — the tab is the
    // recovery path, so it should always show ground truth. Cheap (one IPC
    // + dir scan).
    if (typeof loadSavedApps === 'function') loadSavedApps(true);
  } else if (view === 'settings') {
    currentCid = null;
    if (typeof loadSettings === 'function') {
      Promise.resolve(loadSettings())
        .catch((e) => _bootLog.warn('settings refresh on tab entry failed', { error: (e && e.message) || String(e) }));
    }
  } else if (view === 'project') {
    // `cid` arg is repurposed as `pid` for this view (single second-arg
    // slot kept; the function only inspects it for 'conversation' above).
    currentCid = null;
    if (typeof loadProjectDetail === 'function') loadProjectDetail(cid || '');
  } else {
    currentCid = null;
  }
  if (typeof renderProjectsSection === 'function') renderProjectsSection();
}
