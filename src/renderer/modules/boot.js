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
const _SIDEBAR_NAV_BOOT_WARM_MS = 3500;
let _sidebarVersionBaseLabel = '';
let _sidebarNavWarmUntil = 0;
let _bootUserNavigated = false;
let _bootRestoreComplete = false;
const _sidebarNavTimers = new Map();
const _sidebarNavTokens = new Map();

// One coarse timestamp per second is enough for background admission. No
// event details leave the renderer; main only learns that interaction happened.
let _lastBootActivityReportAt = 0;
function _reportBootUserActivity() {
  const now = Date.now();
  if (now - _lastBootActivityReportAt < 1000) return;
  _lastBootActivityReportAt = now;
  try { window.orkas?.reportUserActivity?.(); } catch (_) {}
}

function _markBootUserNavigation() {
  if (!_bootRestoreComplete) _bootUserNavigated = true;
}

function _markBootReady() {
  document.documentElement.dataset.orkasBootReady = 'true';
  window.dispatchEvent(new Event('orkas:boot-ready'));
}

for (const eventName of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(eventName, _reportBootUserActivity, { capture: true, passive: true });
}

function _deferSidebarNavWork(key, fn, delayMs = 0) {
  const token = (_sidebarNavTokens.get(key) || 0) + 1;
  _sidebarNavTokens.set(key, token);
  const prev = _sidebarNavTimers.get(key);
  if (prev) clearTimeout(prev);

  const arm = () => {
    if (_sidebarNavTokens.get(key) !== token) return;
    const timer = setTimeout(() => {
      if (_sidebarNavTokens.get(key) !== token) return;
      _sidebarNavTimers.delete(key);
      _sidebarNavTokens.delete(key);
      try {
        fn();
      } catch (err) {
        _bootLog.warn('sidebar nav work failed', {
          key,
          error: (err && err.message) || String(err),
        });
      }
    }, Math.max(0, delayMs || 0));
    _sidebarNavTimers.set(key, timer);
  };

  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(arm);
  else arm();
}

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
  let _bootFailureStage = 'init_i18n';
  try {
    _sidebarNavWarmUntil = Math.max(_sidebarNavWarmUntil, _bootT0 + _SIDEBAR_NAV_BOOT_WARM_MS);
    _migrateLegacyLocalStorageKeys();
    // i18n must be ready before any other UI module renders labels.
    await _bootStage('initI18n', initI18n);

    // Stage A contains independent first-paint prerequisites.
    _bootFailureStage = 'stage_a';
    await _bootStage('stageA', () => Promise.all([
      _stampSettingsVersion(),
      (async () => { await initUser(); await initUserWorkspace(); })(),
      initAvatarCatalog(),
      loadProjects(),
    ]));

    // Stage B loads the sidebar and lightweight actor-label cache.
    _bootFailureStage = 'stage_b';
    await _bootStage('stageB', () => Promise.all([
      loadConversations({ startup: true }),
      loadAgents(false, { summary: true }),
    ]));

    _bootFailureStage = 'restore_view';
    _restoreLastView();
    if (typeof _consumePendingTaskNotificationConversation === 'function') {
      _consumePendingTaskNotificationConversation();
    }
    _markBootReady();
    if (typeof _ensureCommanderAvatarLoaded === 'function') _ensureCommanderAvatarLoaded();
    if (typeof startDeleteFileConfirmSubscription === 'function') {
      startDeleteFileConfirmSubscription();
    }

    const _bootTotalMs = Math.round(performance.now() - _bootT0);
    if (_bootTotalMs > _BOOT_TOTAL_WARN_MS) {
      _bootLog.warn(`boot total slow: ${_bootTotalMs}ms (threshold ${_BOOT_TOTAL_WARN_MS}ms) — likely a new serial await landed in bootApp; see boot stage timings above`);
    } else {
      _bootLog.info(`boot total: ${_bootTotalMs}ms`);
    }
    _sidebarNavWarmUntil = Math.max(
      _sidebarNavWarmUntil,
      performance.now() + _SIDEBAR_NAV_BOOT_WARM_MS,
    );

    // Deferred warmup does not block the first interactive frame.
    setTimeout(() => {
      try { refreshModelGuard(); } catch (_) { /* non-fatal */ }
      if (typeof startAutoEventsSubscription === 'function') {
        startAutoEventsSubscription();
      }
    }, 2500);
    return true;
  } catch (err) {
    _bootLog.error('app boot failed', {
      stage: _bootFailureStage,
      error: (err && err.message) || String(err),
    });
    return false;
  }
}

async function _stampSettingsVersion() {
  _bindSidebarVersionUpdate();
  if (!window.orkas || typeof window.orkas.env !== 'function') return;
  try {
    const env = await window.orkas.env();
    if (env && env.version) {
      _setRendererVersionLabel(env.version);
    }
    // The open build has no runtime development mode; source and packaged builds
    // expose the same renderer capabilities.
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

function _loadViewFeature(feature, view, run) {
  const loader = typeof loadRendererFeature === 'function'
    ? loadRendererFeature
    : window.loadRendererFeature;
  if (typeof loader !== 'function') {
    run();
    return;
  }
  _clearLazyFeatureError(view);
  Promise.resolve(loader(feature))
    .then(() => {
      _clearLazyFeatureError(view);
      if (currentView === view) run();
    })
    .catch((err) => {
      _bootLog.warn('lazy renderer feature load failed', {
        feature,
        error: (err && err.message) || String(err),
      });
      _showLazyFeatureError(feature, view, err, run);
    });
}

function _lazyFeaturePanel(view) {
  const panelId = view === 'memory' ? 'panel-memory'
    : view === 'skills' ? 'panel-skills'
    : view === 'contexts' ? 'panel-contexts'
    : view === 'apps' ? 'panel-apps'
    : view === 'settings' ? 'panel-settings'
    : view === 'project' ? 'panel-project'
    : view === 'auto' ? 'panel-auto'
    : view === 'marketplace' ? 'panel-marketplace'
    : view === 'devtools' ? 'panel-devtools'
    : null;
  return panelId ? document.getElementById(panelId) : null;
}

function _clearLazyFeatureError(view) {
  _lazyFeaturePanel(view)?.querySelector(':scope > .lazy-feature-error')?.remove();
}

function _showLazyFeatureError(feature, view, err, run) {
  const panel = _lazyFeaturePanel(view);
  if (!panel) return;
  _clearLazyFeatureError(view);
  const banner = document.createElement('div');
  banner.className = 'lazy-feature-error';
  banner.dataset.feature = feature;
  const reason = (err && err.message) || String(err || '');
  banner.innerHTML = `<span>${escapeHtml(t('chat.load_failed', { msg: reason }))}</span>
    <button type="button" class="btn btn-sm">${escapeHtml(t('chat.retry_btn'))}</button>`;
  banner.querySelector('button')?.addEventListener('click', () => {
    _clearLazyFeatureError(view);
    if (currentView === view) _loadViewFeature(feature, view, run);
  });
  panel.prepend(banner);
}

function _restoreLastView() {
  // The static shell is interactive while Stage A/B are still running. If
  // the user already chose a destination, that explicit navigation wins
  // over startup restoration.
  if (_bootUserNavigated) {
    _bootRestoreComplete = true;
    return;
  }
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
    _bootRestoreComplete = true;
    return;
  }
  setView('new-chat', null, { forceEnter: true, entryPoint: 'startup' });
  _bootRestoreComplete = true;
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
  // A resource detail opened from another page is only a transient overlay.
  // Any explicit sidebar/programmatic navigation dismisses it first, so a
  // later visit to AI Team or Skills always starts from its list.
  if (typeof _resetAgentsDetailForNavigation === 'function') {
    _resetAgentsDetailForNavigation();
  }
  if (typeof _resetSkillsDetailForNavigation === 'function') {
    _resetSkillsDetailForNavigation();
  }
  if (opts.forceEnter || currentView !== view || (view === 'conversation' && currentCid !== cid)) {
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

  // Memory lives in the Settings feature bundle. Reached only from Settings,
  // so loading it here keeps its 32 KB parser/evaluator cost off chat first paint.
  if (view === 'memory') {
    _loadViewFeature('settings', 'memory', () => {
      if (typeof renderMemoryPage === 'function') renderMemoryPage();
    });
  }
  if (view === 'conversation' && cid) {
    currentCid = cid;
    // Opening the task is the read boundary for its completed reply. This also
    // runs when the already-selected row is clicked again.
    if (typeof _markConversationRead === 'function') _markConversationRead(cid);
    // Bind the video review drawer to the conversation being shown, here rather
    // than inside loadConversationHistory. Only one of the three branches below
    // loads history: a freshly created conversation takes `skipLoad`, so the
    // drawer never re-bound and stayed pointed at the previous conversation —
    // and because notifyTurnEnd drops events whose cid is not the bound one, it
    // then ignored every update the new conversation produced and never
    // recovered.
    try { window.VideoReviewPanel?.probe?.(cid); } catch (_) { /* optional surface */ }
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
      loadConversationHistory(cid, opts.historyTarget ? { searchTarget: opts.historyTarget } : undefined);
    } else if (opts.historyTarget && typeof _revealConversationHistorySearchTarget === 'function') {
      _revealConversationHistorySearchTarget(cid, opts.historyTarget);
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
    setTimeout(() => focusChatComposerIfIdle('chat-input'), 50);
  } else if (view === 'new-chat') {
    // Leaving conversation view: hide any queue panel remnants.
    renderMessageQueue(null);
    currentCid = null;
    // Reset the new-chat ephemeral recipient back to commander every time
    // the landing page is entered — the user explicitly asked for a clean
    // slate here, so prior in-session picks don't leak forward.
    if (typeof onEnterNewChatView === 'function') onEnterNewChatView();
    // Draft attachment chips (commander tab's local `main_chat/` pool): re-paint
    // from the in-memory Map immediately, and re-sync with disk in case a prior
    // session left files on disk without a dataUrl.
    if (typeof _chatAttachRenderChips === 'function') _chatAttachRenderChips(DRAFT_CID);
    if (typeof _chatAttachRefreshFromServer === 'function') _chatAttachRefreshFromServer(DRAFT_CID);
    if (typeof _renderQuotePreview === 'function') _renderQuotePreview(DRAFT_CID);
    setTimeout(() => document.getElementById('new-chat-input')?.focus(), 50);
  } else if (view === 'agents') {
    currentCid = null;
    _loadViewFeature('agents', 'agents', () => {
      if (typeof _agentsCache !== 'undefined' && _agentsCache && !_agentsCacheIsSummary) renderAgentsList(_agentsCache);
      // Boot owns a summary-only list. Upgrade it once when the grid first needs
      // descriptions/counts; subsequent visits reuse the full renderer cache.
      const needsFullListing = !(typeof _agentsCache !== 'undefined' && _agentsCache && !_agentsCacheIsSummary);
      if (needsFullListing) {
        _deferSidebarNavWork('agents-tab-refresh', () => {
          if (currentView !== 'agents') return;
          Promise.resolve(loadAgents(false))
            .then(() => {
              if (currentView === 'agents' && typeof refreshSelectedAgentDetail === 'function') {
                return refreshSelectedAgentDetail();
              }
              return null;
            })
            .catch((e) => _bootLog.warn('agents refresh on tab entry failed', { error: (e && e.message) || String(e) }));
        }, 0);
      }
    });
  } else if (view === 'skills') {
    currentCid = null;
    _deferSidebarNavWork('skills-tab-refresh', () => {
      _loadViewFeature('skills', 'skills', () => {
        if (typeof _skillsCache !== 'undefined' && _skillsCache) renderSkillsList(_skillsCache);
        const forceRefresh = !!(typeof _skillsCache !== 'undefined' && _skillsCache);
        Promise.resolve(loadSkills(forceRefresh))
          .then(() => {
            if (currentView === 'skills' && typeof refreshSelectedSkillDetail === 'function') {
              return refreshSelectedSkillDetail();
            }
            return null;
          })
          .catch((e) => _bootLog.warn('skills refresh on tab entry failed', { error: (e && e.message) || String(e) }));
      });
    });
  } else if (view === 'connectors') {
    currentCid = null;
    if (typeof loadConnectors === 'function') {
      _deferSidebarNavWork('connectors-tab-load', () => {
        if (currentView !== 'connectors') return;
        Promise.resolve(loadConnectors())
          .then(() => {
            if (currentView === 'connectors' && typeof verifyConnectors === 'function') return verifyConnectors();
            return undefined;
          })
          .catch((e) => _bootLog.warn('connectors tab load failed', { error: (e && e.message) || String(e) }));
      });
    }
  } else if (view === 'contexts') {
    currentCid = null;
    _deferSidebarNavWork('contexts-tab-load', () => {
      _loadViewFeature('contexts', 'contexts', () => {
        if (typeof loadContexts === 'function') loadContexts();
      });
    });
  } else if (view === 'auto') {
    currentCid = null;
    // Force-refresh on every tab visit: a scheduled fire or remote sync pull
    // may have updated the list while the user was elsewhere.
    _deferSidebarNavWork('auto-tab-load', () => {
      _loadViewFeature('auto', 'auto', () => {
        if (typeof loadAutoList === 'function') loadAutoList(true);
      });
    });
  } else if (view === 'apps') {
    currentCid = null;
    // Force-refresh on every visit (same rationale as agents/skills): a
    // "保存" can land while the user is on another tab — the tab is the
    // recovery path, so it should always show ground truth. Cheap (one IPC
    // + dir scan).
    _deferSidebarNavWork('apps-tab-load', () => {
      _loadViewFeature('apps', 'apps', () => {
        if (typeof loadSavedApps === 'function') loadSavedApps(true);
      });
    });
  } else if (view === 'settings') {
    currentCid = null;
    _deferSidebarNavWork('settings-tab-load', () => {
      _loadViewFeature('settings', 'settings', () => {
        if (typeof loadSettings === 'function') {
          Promise.resolve(loadSettings())
            .catch((e) => _bootLog.warn('settings page load failed', { error: (e && e.message) || String(e) }));
        }
      });
    });
  } else if (view === 'project') {
    // `cid` arg is repurposed as `pid` for this view (single second-arg
    // slot kept; the function only inspects it for 'conversation' above).
    currentCid = null;
    if (typeof primeProjectDetailShell === 'function') primeProjectDetailShell(cid || '');
    _deferSidebarNavWork('project-tab-load', () => {
      _loadViewFeature('project', 'project', () => {
        if (typeof loadProjectDetail === 'function') loadProjectDetail(cid || '');
      });
    });
  } else {
    currentCid = null;
  }
  if (typeof renderProjectsSection === 'function') renderProjectsSection();
}
