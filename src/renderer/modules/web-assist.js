// Trusted browser chrome for the task-details Browser tab. Remote pages are
// native WebContentsViews owned by main; this renderer owns only controls and
// the rectangle where the active page is placed.
(function () {
  const log = typeof createLogger === 'function'
    ? createLogger('web-assist')
    : { warn() {} };

  let shell = null;
  let host = null;
  let tabsEl = null;
  let emptyEl = null;
  let addressInput = null;
  let statusEl = null;
  let backBtn = null;
  let forwardBtn = null;
  let reloadBtn = null;
  let externalBtn = null;
  let activityEl = null;
  let activityListEl = null;
  let activityBtn = null;
  let expandBtn = null;
  let expanded = false;
  const expandedInerted = new Set();
  let permissionPromptEl = null;
  let activePermissionPrompt = null;
  let resizeObserver = null;
  let layoutFrame = 0;
  let nativeVisible = false;
  let nativeTabId = '';
  let layoutRevision = 0;
  let overlaySubscription = null;
  let panelOpen = false;
  let panelTab = 'files';
  let activeView = typeof currentView === 'string' ? currentView : '';
  let activeCid = typeof currentCid === 'string' ? currentCid : '';
  let contextEpoch = 0;
  let activityRequest = 0;
  let activityRefresh = null;
  let activityMeasureFrame = 0;
  let activityMeasuredWidth = 0;
  let currentState = null;
  let activationInFlight = '';
  let renderedTabId = '';
  let addressDirty = false;
  const activeTabByCid = new Map();
  const defaultTabRequests = new Map();
  // Reveal once per task turn. Subsequent operations must not undo the user's
  // decision to close Task Details or inspect Files/Attachments instead.
  const revealedTasks = new Set();
  // Only actual browser work in this turn permits a reveal on task return.
  // A retained control binding describes page authority, not current activity.
  const browserActivityTasks = new Set();

  function label(key, fallback) {
    try {
      const value = t(key);
      return value === key ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  function icon(name, cls = 'ui-icon') {
    return typeof window.uiIconHtml === 'function' ? window.uiIconHtml(name, cls) : '';
  }

  function setButtonCopy(button, key, fallback) {
    if (!button) return;
    const value = label(key, fallback);
    button.title = value;
    button.setAttribute('aria-label', value);
  }

  function tabsForConversation() {
    const tabs = Array.isArray(currentState?.tabs) ? currentState.tabs : [];
    return tabs.filter((tab) => tab && tab.conversation_id === activeCid);
  }

  function selectedTab() {
    const tabs = tabsForConversation();
    if (!tabs.length) return null;
    const remembered = activeTabByCid.get(activeCid);
    const selected = tabs.find((tab) => tab.tab_id === remembered)
      || tabs.find((tab) => tab.tab_id === currentState?.active_tab_id)
      || tabs[0];
    activeTabByCid.set(activeCid, selected.tab_id);
    return selected;
  }

  function refreshBrowserCount() {
    const count = tabsForConversation().length;
    const countEl = document.getElementById('conversation-info-tab-count-browser');
    if (countEl) countEl.textContent = count ? String(count) : '';
  }

  function tabTitle(tab) {
    return String(tab.page_title || tab.label || tab.display_url || label('web_assist.new_tab', 'New tab'));
  }

  function renderTabs() {
    if (!tabsEl) return;
    // Keep live nodes during status updates: clearing the strip can reset its
    // scroll position and detach the focused or currently pressed tab.
    const items = new Map(Array.from(tabsEl.children, (item) => [item.dataset.tabId, item]));
    const tabs = tabsForConversation();
    const liveIds = new Set(tabs.map((tab) => tab.tab_id));
    for (const [id, item] of items) if (!liveIds.has(id)) item.remove();
    const selected = selectedTab();
    let next = tabsEl.firstElementChild;
    for (const tab of tabs) {
      let item = items.get(tab.tab_id);
      if (!item) {
        item = document.createElement('div');
        item.className = 'web-assist-tab';
        item.dataset.tabId = tab.tab_id;
        item.setAttribute('role', 'tab');

        const title = document.createElement('span');
        title.className = 'web-assist-tab-title';
        item.appendChild(title);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'web-assist-tab-close';
        close.dataset.closeTab = tab.tab_id;
        close.innerHTML = icon('x', 'web-assist-tab-close-icon');
        item.appendChild(close);
      }
      item.classList.toggle('is-active', tab.tab_id === selected?.tab_id);
      item.classList.toggle('is-loading', tab.loading === true);
      item.classList.toggle('is-suspended', tab.suspended === true);
      item.classList.toggle('has-permission-request', !!tab.permission_request);
      item.setAttribute('aria-selected', tab.tab_id === selected?.tab_id ? 'true' : 'false');
      item.tabIndex = tab.tab_id === selected?.tab_id ? 0 : -1;

      const title = item.querySelector('.web-assist-tab-title');
      const text = tabTitle(tab);
      if (title.textContent !== text) title.textContent = text;
      title.title = tab.suspended ? `${title.textContent} — ${label('web_assist.suspended', 'Inactive — reloads when opened')}` : title.textContent;
      setButtonCopy(item.querySelector('.web-assist-tab-close'), 'web_assist.close_tab', 'Close tab');
      if (item !== next) tabsEl.insertBefore(item, next);
      next = item.nextElementSibling;
    }
  }

  function stateErrorText(code) {
    if (code === 'page_load_failed') return label('web_assist.page_load_failed', 'Page could not be loaded');
    if (code === 'page_unresponsive') return label('web_assist.page_unresponsive', 'Page is not responding');
    if (code === 'download_blocked') return label('web_assist.download_blocked', 'Downloads are not available here');
    return '';
  }

  function assistantStatusText(tab) {
    if (tab?.user_controlled) return label('web_assist.user_controlled', 'You are using this page; AI will resume after you stop');
    if (!tab?.assistant_controlled) return '';
    if (tab.assistant_action === 'observing') return label('web_assist.assistant_observing', 'AI is reading this page…');
    if (tab.assistant_action === 'acting') return label('web_assist.assistant_acting', 'AI is operating this page…');
    if (tab.assistant_action === 'waiting') return label('web_assist.assistant_waiting', 'AI is waiting for the page to change…');
    return label('web_assist.assistant_ready', 'AI can operate this page');
  }

  function rememberMainActiveTab(state) {
    const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
    const active = tabs.find((tab) => tab?.tab_id === state?.active_tab_id);
    if (active?.conversation_id) activeTabByCid.set(active.conversation_id, active.tab_id);
  }

  function renderState(state) {
    if (state && typeof state === 'object') currentState = state;
    window.OverlayManager.setBrowserOpen(currentState?.open === true, currentState?.overlay_epoch);
    if (!shell) return;
    renderTabs();
    refreshBrowserCount();
    const tab = selectedTab();
    const hasPage = !!tab?.display_url;
    const changedTab = renderedTabId !== (tab?.tab_id || '');
    renderedTabId = tab?.tab_id || '';
    shell.classList.toggle('has-page', hasPage);
    shell.classList.toggle('is-loading', tab?.loading === true);
    emptyEl.hidden = hasPage || tab?.loading === true;
    host.hidden = !hasPage;
    backBtn.disabled = !tab?.can_go_back;
    forwardBtn.disabled = !tab?.can_go_forward;
    reloadBtn.disabled = !tab?.display_url;
    externalBtn.disabled = !tab?.display_url || tab.display_url === 'about:blank';
    if (changedTab) addressDirty = false;
    if (addressInput && !addressDirty) {
      addressInput.value = String(tab?.address_url ?? tab?.display_url ?? '');
    }
    statusEl.textContent = stateErrorText(tab?.error_code)
      || (tab?.suspended ? label('web_assist.suspended', 'Inactive — reloads when opened') : '')
      || (tab?.loading ? label('web_assist.loading', 'Loading…') : '')
      || assistantStatusText(tab);
    const handback = shell.querySelector('[data-act="handback"]');
    if (handback) { handback.hidden = !tab?.user_controlled; handback.textContent = label('web_assist.handback', 'Let AI continue'); }
    renderPermissionPrompt();
    ensureMainActiveTab();
    syncVisibility();
  }

  function ensureShell() {
    if (shell && document.body.contains(shell)) return shell;
    const panel = document.getElementById('conversation-info-panel');
    if (!panel) throw new Error('task details are unavailable');
    shell = document.createElement('section');
    shell.className = 'web-assist-shell';
    shell.hidden = true;
    shell.setAttribute('aria-label', label('web_assist.title', 'Browser'));
    shell.innerHTML = `
      <div class="web-assist-tabbar">
        <div class="web-assist-tabs" role="tablist"></div>
        <button type="button" class="web-assist-add-tab" data-act="add">${icon('plus')}</button>
        <button type="button" class="web-assist-activity-btn" data-act="activity"
                aria-expanded="false" aria-controls="web-assist-activity">${icon('clock')}<span></span></button>
        <button type="button" class="web-assist-expand-btn" data-act="expand"
                aria-pressed="false">${icon('maximize')}<span></span></button>
      </div>
      <div class="web-assist-toolbar">
        <div class="web-assist-navigation" role="group">
          <button type="button" class="web-assist-icon-btn" data-act="back">${icon('chevron-left')}</button>
          <button type="button" class="web-assist-icon-btn" data-act="forward">${icon('chevron-right')}</button>
          <button type="button" class="web-assist-icon-btn" data-act="reload">${icon('refresh')}</button>
        </div>
        <form class="web-assist-address-form">
          <input class="web-assist-address-input" type="text" inputmode="search" autocomplete="off"
                 spellcheck="false">
        </form>
        <button type="button" class="web-assist-icon-btn" data-act="permissions">${icon('settings')}</button>
        <button type="button" class="web-assist-icon-btn web-assist-external-btn" data-act="external">${icon('external')}</button>
      </div>
      <div class="web-assist-info">
        <button type="button" class="btn btn-ghost btn-sm" data-act="handback" hidden></button>
        <div class="web-assist-status" role="status" aria-live="polite"></div>
      </div>
      <section id="web-assist-activity" class="web-assist-activity-popover" hidden aria-labelledby="web-assist-activity-title">
        <div class="web-assist-activity-header">
          <strong id="web-assist-activity-title"></strong>
          <button type="button" class="web-assist-icon-btn" data-act="close-activity">${icon('x')}</button>
        </div>
        <ol class="web-assist-trail-list"></ol>
      </section>
      <div class="web-assist-page">
      <section class="web-assist-permission-prompt" hidden role="dialog" aria-modal="false" aria-labelledby="web-assist-permission-title">
        <strong id="web-assist-permission-title"></strong>
        <p class="web-assist-permission-message"></p>
        <p class="web-assist-permission-error" role="status" hidden></p>
        <div class="web-assist-download-prompt-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="deny-permission"></button>
          <button type="button" class="btn btn-primary btn-sm" data-act="allow-permission"></button>
        </div>
      </section>
      <div class="web-assist-empty">
        <span class="web-assist-empty-icon">${icon('globe')}</span>
        <span class="web-assist-empty-title"></span>
        <span class="web-assist-empty-hint"></span>
      </div>
      <div class="web-assist-native-host"></div>
      </div>`;
    panel.appendChild(shell);

    host = shell.querySelector('.web-assist-native-host');
    tabsEl = shell.querySelector('.web-assist-tabs');
    emptyEl = shell.querySelector('.web-assist-empty');
    addressInput = shell.querySelector('.web-assist-address-input');
    statusEl = shell.querySelector('.web-assist-status');
    backBtn = shell.querySelector('[data-act="back"]');
    forwardBtn = shell.querySelector('[data-act="forward"]');
    reloadBtn = shell.querySelector('[data-act="reload"]');
    externalBtn = shell.querySelector('[data-act="external"]');
    activityEl = shell.querySelector('.web-assist-activity-popover');
    activityListEl = shell.querySelector('.web-assist-trail-list');
    activityBtn = shell.querySelector('[data-act="activity"]');
    expandBtn = shell.querySelector('[data-act="expand"]');
    permissionPromptEl = shell.querySelector('.web-assist-permission-prompt');
    permissionPromptEl.querySelector('[data-act="deny-permission"]').addEventListener('click', () => answerPermissionPrompt(false));
    permissionPromptEl.querySelector('[data-act="allow-permission"]').addEventListener('click', () => answerPermissionPrompt(true));
    activityBtn.addEventListener('click', () => setActivityOpen(activityEl.hidden));
    expandBtn.addEventListener('click', () => setExpanded(!expanded));
    shell.querySelector('[data-act="close-activity"]').addEventListener('click', () => setActivityOpen(false, true));
    document.addEventListener('pointerdown', (event) => {
      if (!activityEl.hidden && !activityEl.contains(event.target) && !activityBtn.contains(event.target)) setActivityOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229 || event.key !== 'Escape') return;
      // An earlier floating-layer listener may already have removed its root.
      // Its Escape must not also dismiss browser controls or leave full screen.
      if (event.defaultPrevented) return;
      const layer = window.OverlayManager.layerForEvent(event);
      if (layer && layer !== permissionPromptEl && layer !== activityEl) return;
      if (!permissionPromptEl.hidden && shell.contains(event.target) && !dialogIsOpen()) {
        event.preventDefault();
        void answerPermissionPrompt(false);
        return;
      }
      if (!activityEl.hidden) {
        event.preventDefault();
        setActivityOpen(false, true);
        return;
      }
      // A dialog above the page owns Escape until it is dismissed, including
      // while the browser has no page and therefore no rectangle to occlude.
      if (!expanded || modalIsOpen() || dialogIsOpen()) return;
      event.preventDefault();
      setExpanded(false, true);
    });

    shell.querySelector('[data-act="add"]').addEventListener('click', addTab);
    shell.querySelector('[data-act="handback"]').addEventListener('click', async () => {
      const tab = selectedTab(); if (!tab) return;
      try { await window.orkas.invoke('webAssist.handback', { tabId: tab.tab_id }); }
      catch { log.warn('browser handback failed'); }
    });
    backBtn.addEventListener('click', () => navigate('back'));
    forwardBtn.addEventListener('click', () => navigate('forward'));
    reloadBtn.addEventListener('click', () => navigate('reload'));
    externalBtn.addEventListener('click', openExternal);
    shell.querySelector('[data-act="permissions"]').addEventListener('click', async () => {
      const tab = selectedTab(); if (!tab) return;
      try { await window.orkas.invoke('webAssist.resetPermissions', { tabId: tab.tab_id }); }
      catch { log.warn('browser permission reset failed'); }
    });
    shell.querySelector('.web-assist-address-form').addEventListener('submit', navigateToAddress);
    addressInput.addEventListener('input', () => { addressDirty = true; });
    const resetAddressDraft = () => {
      addressDirty = false;
      const tab = selectedTab();
      // Do not rebuild the tab strip on blur: it can remove the clicked tab
      // between pointerdown and click, swallowing activation or close.
      addressInput.value = String(tab?.address_url ?? tab?.display_url ?? '');
    };
    addressInput.addEventListener('blur', resetAddressDraft);
    addressInput.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229 || event.key !== 'Escape') return;
      event.preventDefault();
      resetAddressDraft();
    });
    tabsEl.addEventListener('click', (event) => {
      const close = event.target.closest('[data-close-tab]');
      if (close) {
        event.stopPropagation();
        closeTab(close.dataset.closeTab);
        return;
      }
      const tab = event.target.closest('.web-assist-tab[data-tab-id]');
      if (tab) activateTab(tab.dataset.tabId);
    });
    tabsEl.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      // Native buttons own Enter/Space; tab activation must not cancel close.
      if (event.target.closest('[data-close-tab]')) return;
      const tab = event.target.closest('.web-assist-tab[data-tab-id]');
      if (!tab || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      activateTab(tab.dataset.tabId);
    });
    window.addEventListener('resize', scheduleLayout);
    window.addEventListener('resize', scheduleActivityMeasurement);
    window.addEventListener('i18n-change', refreshCopy);
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(() => {
        scheduleLayout();
        scheduleActivityMeasurement();
      });
      resizeObserver.observe(panel);
      resizeObserver.observe(host);
      resizeObserver.observe(activityBtn);
      resizeObserver.observe(activityListEl);
    }
    overlaySubscription?.();
    overlaySubscription = window.OverlayManager.subscribe(() => {
      syncVisibility();
      revealCurrentTask();
    });
    refreshCopy();
    renderState(currentState);
    return shell;
  }

  function refreshCopy(event) {
    if (!shell) return;
    setButtonCopy(backBtn, 'web_assist.back', 'Back');
    setButtonCopy(forwardBtn, 'web_assist.forward', 'Forward');
    setButtonCopy(reloadBtn, 'web_assist.reload', 'Reload');
    setButtonCopy(externalBtn, 'web_assist.open_external', 'Open in default browser');
    shell.querySelector('[data-act="handback"]').textContent = label('web_assist.handback', 'Let AI continue');
    setButtonCopy(shell.querySelector('[data-act="permissions"]'), 'web_assist.permissions', 'Reset site permissions');
    setButtonCopy(shell.querySelector('[data-act="add"]'), 'web_assist.add_tab', 'New tab');
    addressInput.placeholder = label('web_assist.address_placeholder', 'Search Bing or enter a URL');
    addressInput.setAttribute('aria-label', addressInput.placeholder);
    shell.querySelector('.web-assist-empty-title').textContent = label('web_assist.empty_title', 'Browse in this task');
    shell.querySelector('.web-assist-empty-hint').textContent = label('web_assist.empty_hint', 'Search Bing or enter a URL above.');
    permissionPromptEl.querySelector('#web-assist-permission-title').textContent = label('web_assist.permission_title', 'Website permission');
    permissionPromptEl.querySelector('[data-act="deny-permission"]').textContent = label('web_assist.permission_deny', 'Deny');
    permissionPromptEl.querySelector('[data-act="allow-permission"]').textContent = label('web_assist.permission_allow', 'Allow');
    activityBtn.querySelector('span').textContent = label('web_assist.activity', 'Activity');
    shell.querySelector('#web-assist-activity-title').textContent = label('web_assist.activity', 'Activity');
    setButtonCopy(shell.querySelector('[data-act="close-activity"]'), 'web_assist.activity_close', 'Close activity');
    refreshExpandCopy();
    if (!activityEl.hidden) renderActivity();
    renderState(currentState);
    if (event?.type === 'i18n-change' && activePermissionPrompt) {
      const epoch = contextEpoch;
      window.orkas.invoke('webAssist.state', {}).then(result => {
        if (epoch === contextEpoch && result?.state) renderState(result.state);
      }).catch(() => { log.warn('browser permission translation refresh failed'); });
    }
  }

  // Requests are delivered with trusted renderer state, so background tasks
  // retain their own prompt without polling ledgers on every page update.
  function renderPermissionPrompt() {
    if (!permissionPromptEl) return;
    const tab = selectedTab();
    const request = activeView === 'conversation' && panelOpen && panelTab === 'browser'
      && currentState?.active_tab_id === tab?.tab_id ? tab?.permission_request : null;
    permissionPromptEl.hidden = !request;
    if (activityBtn) activityBtn.disabled = !!request;
    if (!request) { activePermissionPrompt = null; return; }
    permissionPromptEl.querySelector('.web-assist-permission-message').textContent = request.message;
    if (activePermissionPrompt?.id === request.id && activePermissionPrompt.epoch === contextEpoch) return;
    activePermissionPrompt = { ...request, tabId: tab.tab_id, epoch: contextEpoch };
    permissionPromptEl.querySelector('.web-assist-permission-error').hidden = true;
    permissionPromptEl.querySelectorAll('button').forEach(button => { button.disabled = false; });
    setActivityOpen(false);
    // Denial owns the default keyboard focus, and no background tab opens UI.
    permissionPromptEl.querySelector('[data-act="deny-permission"]').focus();
  }

  async function answerPermissionPrompt(allowed) {
    const request = activePermissionPrompt;
    if (!request || permissionPromptEl.hidden
      || permissionPromptEl.querySelector('[data-act="deny-permission"]').disabled) return;
    const isCurrent = () => activePermissionPrompt?.id === request.id && contextEpoch === request.epoch
      && selectedTab()?.tab_id === request.tabId && selectedTab()?.permission_request?.id === request.id;
    if (!isCurrent()) return;
    permissionPromptEl.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const result = await window.orkas.invoke('webAssist.permissionResponse', {
        tabId: request.tabId, requestId: request.id, allowed,
      });
      if (!isCurrent()) return;
      if (!result?.handled) throw new Error('permission response failed');
      delete selectedTab().permission_request;
      renderState(currentState);
    } catch (_) {
      if (!isCurrent()) return;
      const error = permissionPromptEl.querySelector('.web-assist-permission-error');
      error.textContent = label('web_assist.permission_failed', 'Could not save your choice. Try again.');
      error.hidden = false;
    } finally {
      if (isCurrent()) permissionPromptEl.querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
  }

  function setActivityOpen(open, restoreFocus = false) {
    if (!activityEl) return;
    activityEl.hidden = !open;
    activityBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      positionActivity();
      renderActivity();
      activityEl.querySelector('[data-act="close-activity"]').focus();
    } else {
      activityRequest += 1;
      activityRefresh = null;
      if (restoreFocus) activityBtn.focus();
    }
    syncVisibility();
  }

  function positionActivity() {
    if (!activityEl || activityEl.hidden) return;
    // Anchor in browser-chrome coordinates, including when the drawer moves
    // or fills the window. The page has a different origin below the toolbar.
    const bounds = shell.getBoundingClientRect();
    const anchor = activityBtn.getBoundingClientRect();
    const top = anchor.bottom - bounds.top + 4;
    const right = Math.max(8, Math.min(bounds.right - anchor.right,
      shell.clientWidth - activityEl.offsetWidth - 8));
    activityEl.style.top = `${top}px`;
    activityEl.style.right = `${right}px`;
    activityEl.style.maxHeight = `${Math.max(0, shell.clientHeight - top - 8)}px`;
  }

  function scheduleActivityMeasurement() {
    if (!activityEl || activityEl.hidden || activityMeasureFrame) return;
    activityMeasureFrame = window.requestAnimationFrame(() => {
      activityMeasureFrame = 0;
      positionActivity();
      if (activityListEl.clientWidth !== activityMeasuredWidth) measureActivityGroups();
    });
  }

  function measureActivityGroups() {
    if (!activityListEl || activityEl.hidden) return;
    const groups = Array.from(activityListEl.querySelectorAll('.web-assist-trail-group'));
    // Measure natural heights once per render/width change, before allowing
    // Chromium to skip offscreen contents. Guessed heights move the scrollbar
    // when long URLs or download controls enter the viewport. Batch writes and
    // reads so this does not force a separate layout for every group.
    groups.forEach(group => group.classList.remove('is-contained'));
    const heights = groups.map(group => group.getBoundingClientRect().height);
    groups.forEach((group, index) => {
      group.style.setProperty('--activity-group-height', `${heights[index]}px`);
      group.classList.add('is-contained');
    });
    activityMeasuredWidth = activityListEl.clientWidth;
  }

  // Collapse bursts into one read and at most one trailing read per in-flight
  // update. Closed panels do no work; reopening always reads the latest ledger.
  function refreshActivity(event) {
    if (activeView !== 'conversation' || event?.conversation_id !== activeCid || !activityEl || activityEl.hidden) return;
    if (activityRefresh) {
      activityRefresh.dirty = true;
      return activityRefresh.promise;
    }
    const job = { dirty: true, epoch: contextEpoch };
    activityRefresh = job;
    job.promise = Promise.resolve().then(async () => {
      while (activityRefresh === job && job.epoch === contextEpoch && !activityEl.hidden && job.dirty) {
        job.dirty = false;
        await renderActivity(true);
      }
    }).finally(() => {
      if (activityRefresh === job) activityRefresh = null;
    });
    return job.promise;
  }

  // Read the bounded task ledgers on demand. A late response or detached grant
  // button must never affect another task, including after returning to this one.
  async function renderActivity(preserve = false) {
    if (!activityEl || activityEl.hidden || !activityListEl) return;
    const cid = activeView === 'conversation' ? activeCid : '';
    const epoch = contextEpoch;
    const request = ++activityRequest;
    if (!preserve || !activityListEl.children.length) {
      activityListEl.textContent = '';
      const loading = document.createElement('li');
      loading.className = 'web-assist-trail-empty';
      loading.textContent = label('web_assist.loading', 'Loading…');
      activityListEl.appendChild(loading);
    }
    const results = cid ? await Promise.allSettled([
      window.orkas.invoke('webAssist.navigations', { conversation_id: cid }),
      window.orkas.invoke('webAssist.downloads', { conversation_id: cid }),
    ]) : [];
    if (epoch !== contextEpoch || request !== activityRequest || activityEl.hidden) return;
    const scrollTop = preserve ? activityListEl.scrollTop : 0;
    activityListEl.textContent = '';
    const navigation = results[0]?.status === 'fulfilled' ? results[0].value : null;
    const downloads = results[1]?.status === 'fulfilled' ? results[1].value : null;
    const entries = [
      ...(navigation?.navigations || []).map(entry => ({ ...entry, kind: 'navigation' })),
      ...(downloads?.downloads || []).map(entry => ({ ...entry, kind: 'download' })),
    ].sort((a, b) => b.at - a.at);
    if (results.some(result => result.status === 'rejected' || result.value?.ok === false)) {
      const error = document.createElement('li');
      error.className = 'web-assist-trail-empty';
      error.textContent = label('web_assist.activity_failed', 'Some activity could not be loaded. Close and reopen to retry.');
      activityListEl.appendChild(error);
    } else if (!entries.length) {
      const empty = document.createElement('li');
      empty.className = 'web-assist-trail-empty';
      empty.textContent = label('web_assist.activity_empty', 'No visits or downloads in this task yet.');
      activityListEl.appendChild(empty);
    }
    let rowContainer = activityListEl;
    for (const [index, entry] of entries.entries()) {
      // Contain small batches rather than individual rows: scrolling then
      // skips most paint work without relaying out hundreds of auto containers.
      // Keep every record and its controls in the DOM for find and keyboard use.
      if (entries.length > 40 && index % 20 === 0) {
        rowContainer = document.createElement('div');
        rowContainer.className = 'web-assist-trail-group';
        rowContainer.setAttribute('role', 'presentation');
        activityListEl.appendChild(rowContainer);
      }
      const download = entry.kind === 'download';
      const row = document.createElement('li');
      row.className = 'web-assist-trail-row';
      const marker = document.createElement('span');
      marker.className = 'web-assist-activity-marker';
      marker.innerHTML = icon(download ? 'download' : 'globe');
      marker.title = download ? label('web_assist.activity_download', 'Download') : label('web_assist.activity_visit', 'Visit');
      const when = document.createElement('time');
      when.className = 'web-assist-trail-time';
      when.dateTime = new Date(entry.at).toISOString();
      when.textContent = new Date(entry.at).toLocaleString();
      const what = document.createElement('span');
      what.className = 'web-assist-trail-url';
      // Page-controlled text must never become markup.
      what.textContent = download ? entry.filename : entry.url;
      what.title = download ? `${entry.filename} — ${entry.origin}` : entry.url;
      row.append(marker, when, what);
      if (download) {
        const state = document.createElement('span');
        state.className = 'web-assist-activity-badge';
        state.textContent = entry.state === 'downloading' ? label('web_assist.loading', 'Loading…') : entry.state === 'saved'
          ? label('web_assist.download_saved', 'saved to attachments')
          : label('web_assist.download_failed', 'failed');
        row.appendChild(state);
      }
      if (download && entry.state === 'saved') {
        const actions = document.createElement('div');
        actions.className = 'web-assist-download-actions';
        const buttons = [];
        let busy = false;
        const isCurrent = () => epoch === contextEpoch && cid === activeCid && activeView === 'conversation'
          && !activityEl.hidden && request === activityRequest;
        for (const action of ['view', 'reveal']) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'btn btn-ghost btn-sm';
          button.dataset.downloadAction = action;
          button.textContent = action === 'view'
            ? label('chat.process.action_view_file', 'View file')
            : label('chat.preview_reveal_title', 'Open in folder');
          button.addEventListener('click', async () => {
            if (busy || !isCurrent()) return;
            busy = true;
            buttons.forEach(item => { item.disabled = true; });
            try {
              // Resolve through the task attachment boundary; page filenames
              // must never be interpreted as arbitrary local paths.
              const file = await window.orkas.invoke('attachments.absPath', { cid, name: entry.filename });
              if (!isCurrent()) return;
              if (!file?.ok || !file.path) {
                uiToast(label('web_assist.download_unavailable', 'File unavailable. Check that the download finished and the file has not been moved or deleted.'), { variant: 'warning' });
                return;
              }
              if (action === 'view') await openChatFileViewer(file.path, entry.filename, { cid });
              else {
                const result = await window.orkas.invoke('workspace.revealPath', { path: file.path, cid });
                if (!result?.ok) throw new Error('reveal failed');
              }
            } catch (_) {
              if (isCurrent()) uiToast(label(action === 'reveal' ? 'contexts.reveal_failed' : 'web_assist.download_unavailable',
                'Could not open the file or its folder. Try again.'), { variant: 'warning' });
            } finally {
              busy = false;
              buttons.forEach(item => { item.disabled = false; });
            }
          });
          buttons.push(button);
          actions.appendChild(button);
        }
        row.appendChild(actions);
      }
      rowContainer.appendChild(row);
    }
    measureActivityGroups();
    activityListEl.scrollTop = scrollTop;
  }

  function ensureMainActiveTab(retry = false) {
    const tab = selectedTab();
    if (tab?.suspended && tab.error_code && !retry) return;
    if (!tab || (currentState?.active_tab_id === tab.tab_id && !tab.suspended) || activationInFlight === tab.tab_id) return;
    if (!(panelOpen && panelTab === 'browser' && activeView === 'conversation')) return;
    if (modalIsOpen()) return;
    activationInFlight = tab.tab_id;
    window.orkas.invoke('webAssist.activateTab', { tabId: tab.tab_id }).then((result) => {
      if (result?.ok && result.state) renderState(result.state);
    }).catch((error) => {
      log.warn('tab activation failed', { error: (error && error.message) || String(error) });
    }).finally(() => {
      activationInFlight = '';
      syncVisibility();
    });
  }

  function dialogIsOpen() {
    return window.OverlayManager.hasModalLayers();
  }

  function modalIsOpen() {
    return window.OverlayManager.hasOpenLayers();
  }

  async function hideNativeView() {
    try {
      await window.orkas.invoke('webAssist.layout', {
        visible: false, overlayRevision: window.OverlayManager.version(), overlayEpoch: window.OverlayManager.epoch(),
      });
    } catch { log.warn('native view hide failed'); }
  }

  function syncVisibility() {
    if (!shell) return;
    const tab = selectedTab();
    const shown = panelOpen && panelTab === 'browser' && activeView === 'conversation' && !!activeCid;
    if (shown && tab?.suspended && !tab.error_code) ensureMainActiveTab();
    if (shell.hidden !== !shown) shell.hidden = !shown;
    const ready = shown && !tab?.suspended && !!tab?.display_url
      && currentState?.active_tab_id === tab.tab_id;
    const next = ready && !modalIsOpen();
    const nextTabId = ready ? tab.tab_id : '';
    if (nativeVisible === next && nativeTabId === nextTabId) return;
    layoutRevision += 1;
    nativeVisible = next;
    nativeTabId = nextTabId;
    if (next) scheduleLayout();
    // Occlusion is presentation only. Main retains the page's logical
    // selection, activity and viewport while its pixels are suppressed.
    else if (!ready && currentState?.open) void hideNativeView();
  }

  function scheduleLayout() {
    if (!nativeVisible || !host || host.hidden || layoutFrame) return;
    layoutFrame = window.requestAnimationFrame(async () => {
      layoutFrame = 0;
      const request = layoutRevision;
      if (!await window.OverlayManager.settled() || request !== layoutRevision
        || !nativeVisible || !host || host.hidden) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) return;
      window.orkas.invoke('webAssist.layout', {
        x: Math.round(rect.left), y: Math.round(rect.top),
        width: Math.round(rect.width), height: Math.round(rect.height),
        overlayRevision: window.OverlayManager.version(), overlayEpoch: window.OverlayManager.epoch(),
      }).then((result) => {
        if (request !== layoutRevision || !nativeVisible) return;
        if (result?.ok && result.state) renderState(result.state);
      }).catch(() => { log.warn('native view layout failed'); });
    });
  }

  // In-app full screen. The browser fills the window while the task keeps its
  // live page, tabs and session; the stored panel width is left untouched so
  // returning restores the width the user chose.
  function refreshExpandCopy() {
    if (!expandBtn) return;
    const key = expanded ? 'web_assist.exit_full_screen' : 'web_assist.full_screen';
    const text = label(key, expanded ? 'Exit full screen' : 'Full screen');
    // Markup comes from the trusted icon set, never from page-controlled text.
    expandBtn.innerHTML = `${icon(expanded ? 'minimize' : 'maximize')}<span></span>`;
    expandBtn.querySelector('span').textContent = text;
    expandBtn.title = text;
    expandBtn.setAttribute('aria-pressed', String(expanded));
  }

  function setExpandedBackgroundInert(panel, next) {
    if (!next) {
      for (const element of expandedInerted) element.inert = false;
      expandedInerted.clear();
      return;
    }
    const app = panel?.closest('.app-container');
    if (!app) return;
    // Leave body-level dialogs outside the app available while the browser
    // covers the sidebar, composer and other app panels.
    for (let current = panel; current !== app; current = current.parentElement) {
      for (const sibling of current.parentElement.children) {
        if (sibling === current || sibling.inert) continue;
        sibling.inert = true;
        expandedInerted.add(sibling);
      }
    }
  }

  function setExpanded(next, restoreFocus = false) {
    const panel = document.getElementById('conversation-info-panel');
    const wanted = !!panel && !!next && panelOpen && panelTab === 'browser' && activeView === 'conversation';
    if (expanded !== wanted) {
      expanded = wanted;
      panel?.classList.toggle('is-web-assist-expanded', expanded);
      setExpandedBackgroundInert(panel, expanded);
      if (restoreFocus) expandBtn?.focus();
      // The native page is placed by rectangle, so it has to follow the new
      // host bounds even though visibility itself did not change.
      syncVisibility();
      scheduleLayout();
    }
    refreshExpandCopy();
  }

  function ensureDefaultTab() {
    if (!panelOpen || panelTab !== 'browser' || activeView !== 'conversation' || !activeCid) return Promise.resolve(false);
    if (defaultTabRequests.has(activeCid)) return defaultTabRequests.get(activeCid);
    if (tabsForConversation().length) return Promise.resolve(true);
    const cid = activeCid;
    const request = window.orkas.invoke('webAssist.addTab', { conversationId: cid, ifEmpty: true }).then((result) => {
      if (!result?.ok) throw new Error(result?.error || 'add failed');
      // A delayed response belongs to its original task, not the current one.
      if (activeCid === cid && activeView === 'conversation') renderState(result.state);
      return true;
    }).catch(() => {
      if (activeCid === cid && panelOpen && panelTab === 'browser' && typeof uiToast === 'function') {
        uiToast(label('web_assist.add_tab_failed', 'Could not add a browser tab.'), { variant: 'warning' });
      }
      log.warn('default tab creation failed');
      return false;
    }).finally(() => defaultTabRequests.delete(cid));
    defaultTabRequests.set(cid, request);
    return request;
  }

  async function addTab() {
    if (!activeCid) return false;
    const cid = activeCid;
    if (defaultTabRequests.has(cid)) await defaultTabRequests.get(cid);
    if (activeCid !== cid) return false;
    try {
      const result = await window.orkas.invoke('webAssist.addTab', { conversationId: cid });
      if (!result?.ok) throw new Error(result?.error || 'add failed');
      if (result.state?.active_tab_id) activeTabByCid.set(cid, result.state.active_tab_id);
      if (activeCid !== cid) return true;
      renderState(result.state);
      window.requestAnimationFrame(() => addressInput?.focus());
      return true;
    } catch (error) {
      if (typeof uiToast === 'function') uiToast(label('web_assist.add_tab_failed', 'Could not add a browser tab.'), { variant: 'warning' });
      log.warn('add tab failed', { error: (error && error.message) || String(error) });
      return false;
    }
  }

  async function activateTab(tabId) {
    if (!tabId) return;
    activeTabByCid.set(activeCid, tabId);
    renderState(currentState);
    ensureMainActiveTab(true);
  }

  async function closeTab(tabId) {
    if (!tabId) return;
    try {
      const result = await window.orkas.invoke('webAssist.closeTab', { tabId });
      if (!result?.ok) throw new Error(result?.error || 'close failed');
      if (activeTabByCid.get(activeCid) === tabId) activeTabByCid.delete(activeCid);
      renderState(result.state);
      await ensureDefaultTab();
    } catch (error) {
      if (typeof uiToast === 'function') uiToast(label('web_assist.close_failed', 'Could not close this browser tab.'), { variant: 'warning' });
      log.warn('close tab failed', { error: (error && error.message) || String(error) });
    }
  }

  async function navigateToAddress(event) {
    event.preventDefault();
    const cid = activeCid;
    const url = String(addressInput?.value || '').trim();
    if (!url) return;
    let tab = selectedTab();
    if (!tab && !await ensureDefaultTab()) return;
    if (activeCid !== cid) return;
    tab = selectedTab();
    if (!tab) return;
    try {
      addressDirty = false;
      const result = await window.orkas.invoke('webAssist.navigateTo', { tabId: tab.tab_id, url });
      if (!result?.ok) throw new Error(result?.error || 'navigation failed');
      renderState(result.state);
    } catch (error) {
      if (typeof uiToast === 'function') uiToast(label('web_assist.invalid_url', 'Enter a web address or search terms.'), { variant: 'warning' });
      log.warn('address navigation failed', { error: (error && error.message) || String(error) });
    }
  }

  async function navigate(action) {
    try {
      const result = await window.orkas.invoke('webAssist.navigate', { action });
      if (result?.ok && result.state) renderState(result.state);
    } catch (error) {
      log.warn('navigation failed', { action, error: (error && error.message) || String(error) });
    }
  }

  async function openExternal() {
    try {
      const result = await window.orkas.invoke('webAssist.openExternal', {});
      if (!result?.ok) throw new Error(result?.error || 'open failed');
    } catch (error) {
      if (typeof uiToast === 'function') uiToast(label('web_assist.open_external_failed', 'Could not open this page in the default browser.'), { variant: 'warning' });
      log.warn('default browser open failed', { error: (error && error.message) || String(error) });
    }
  }

  async function close() {
    try {
      const result = await window.orkas.invoke('webAssist.close', {});
      if (!result?.ok) throw new Error(result?.error || 'close failed');
      renderState({ open: false, tabs: [] });
      return true;
    } catch (error) {
      log.warn('browser close failed', { error: (error && error.message) || String(error) });
      return false;
    }
  }

  async function openForModel(options) {
    const input = options && typeof options === 'object' ? options : {};
    const url = String(input.url || '').trim();
    if (!url || !activeCid || activeView !== 'conversation') return false;
    const cid = activeCid;
    const epoch = contextEpoch;
    ensureShell();
    try {
      const result = await window.orkas.invoke('webAssist.open', {
        url,
        label: input.label,
        conversationId: cid,
      });
      if (!result?.ok) throw new Error(result?.error || 'open failed');
      if (result.state?.active_tab_id) activeTabByCid.set(cid, result.state.active_tab_id);
      if (epoch !== contextEpoch) return true;
      renderState(result.state);
      if (window.ConversationInfo?.openAndSetTab('browser', cid)) revealedTasks.add(cid);
      return true;
    } catch (error) {
      if (epoch === contextEpoch && typeof uiToast === 'function') uiToast(label('web_assist.open_failed', 'Web Assist could not open this page.'), { variant: 'warning' });
      log.warn('open failed', { error: (error && error.message) || String(error) });
      return false;
    }
  }

  function revealCurrentTask() {
    if (activeView !== 'conversation' || !activeCid || revealedTasks.has(activeCid)) return;
    if (!browserActivityTasks.has(activeCid)) return;
    if (!tabsForConversation().some(tab => tab.assistant_controlled)) return;
    if (panelOpen && panelTab === 'browser') { revealedTasks.add(activeCid); return; }
    if (window.OverlayManager.hasOpenLayers()) return;
    if (window.ConversationInfo?.openAndSetTab('browser', activeCid)) revealedTasks.add(activeCid);
  }

  function showFromMain(state, activityCid) {
    const ownerCid = String(activityCid || (state?.assistant_action ? state.conversation_id : '') || '');
    if (ownerCid) browserActivityTasks.add(ownerCid);
    // Background opens/reads carry only their task ID. They must not rebuild
    // browser chrome or replace the foreground task's live selection.
    if (Array.isArray(state?.tabs)) {
      ensureShell();
      currentState = state;
      rememberMainActiveTab(state);
      for (const tab of state.tabs) {
        if (tab?.assistant_action && tab.conversation_id) browserActivityTasks.add(tab.conversation_id);
      }
      renderState(state);
    }
    revealCurrentTask();
  }

  function beginTaskTurn(cid) {
    revealedTasks.delete(cid);
    browserActivityTasks.delete(cid);
  }

  function updateContext(view, cid) {
    const nextView = view || '';
    const nextCid = cid || '';
    if (activeView === nextView && activeCid === nextCid) return;
    activeView = nextView;
    activeCid = nextCid;
    contextEpoch += 1;
    layoutRevision += 1;
    setActivityOpen(false);
    setExpanded(false);
    if (activityListEl) activityListEl.textContent = '';
  }

  function setContext(view, cid) {
    updateContext(view, cid);
    const epoch = contextEpoch;
    window.orkas.invoke('webAssist.setContext', {
      conversationId: activeView === 'conversation' ? activeCid : '',
    }).catch(() => { log.warn('context update failed'); });
    if (activeView === 'conversation') {
      window.orkas.invoke('webAssist.state', {}).then((result) => {
        if (epoch !== contextEpoch) return;
        if (result?.state) {
          renderState(result.state);
          revealCurrentTask();
        }
        ensureDefaultTab();
      }).catch(() => { log.warn('state reload failed'); });
    }
    renderState(currentState);
  }

  function setPanelState(open, tab, cid) {
    panelOpen = !!open;
    panelTab = tab || 'files';
    if (!panelOpen || panelTab !== 'browser') {
      setActivityOpen(false);
      setExpanded(false);
    }
    if (cid) updateContext(activeView, cid);
    ensureShell();
    renderState(currentState);
    ensureDefaultTab();
  }

  function setResizing() {
    syncVisibility();
    scheduleLayout();
  }

  function isOpen() {
    return tabsForConversation().length > 0;
  }

  window.orkas.onPushEvent('web-assist:activity', refreshActivity);
  window.orkas.onPushEvent('web-assist:state', (state) => {
    if (state?.assistant_action || state?.tabs?.some(tab => tab?.assistant_action)) {
      showFromMain(state);
    } else {
      rememberMainActiveTab(state);
      renderState(state);
    }
    const closedCid = state?.model_closed_conversation_id;
    if (closedCid && Array.isArray(state.tabs)
        && !state.tabs.some(tab => tab?.conversation_id === closedCid)) {
      // Automatic dismissal is not a manual opt-out from subsequent browsing.
      browserActivityTasks.delete(closedCid);
      if (window.ConversationInfo?.closeBrowserForTask(closedCid)) revealedTasks.delete(closedCid);
    }
  });
  window.orkas.onPushEvent('web-assist:show', (state) => showFromMain(state,
    String(state?.browser_activity_conversation_id || state?.conversation_id || '')));
  window.WebAssist = {
    openForModel,
    close,
    isOpen,
    setContext,
    setPanelState,
    setResizing,
    beginTaskTurn,
  };
})();
