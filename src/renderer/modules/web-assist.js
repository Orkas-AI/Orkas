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
  let downloadPromptEl = null;
  let activeDownloadPrompt = null;
  let downloadRevealKey = '';
  const dismissedDownloadRequests = new Set();
  let resizeObserver = null;
  let layoutFrame = 0;
  let nativeVisible = false;
  let nativeTabId = '';
  let pagePreview = null;
  let pagePreviewTabId = '';
  let pagePreviewRequest = 0;
  let panelOpen = false;
  let panelTab = 'files';
  let activeView = typeof currentView === 'string' ? currentView : '';
  let activeCid = typeof currentCid === 'string' ? currentCid : '';
  let contextEpoch = 0;
  let activityRequest = 0;
  let activityRefresh = null;
  let currentState = null;
  let activationInFlight = '';
  let renderedTabId = '';
  let addressDirty = false;
  const activeTabByCid = new Map();
  const defaultTabRequests = new Map();
  // Reveal once per task turn. Subsequent operations must not undo the user's
  // decision to close Task Details or inspect Files/Attachments instead.
  const revealedTasks = new Set();

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
    tabsEl.replaceChildren();
    const selected = selectedTab();
    for (const tab of tabsForConversation()) {
      const item = document.createElement('div');
      item.className = 'web-assist-tab';
      item.classList.toggle('is-active', tab.tab_id === selected?.tab_id);
      item.classList.toggle('is-loading', tab.loading === true);
      item.classList.toggle('is-suspended', tab.suspended === true);
      item.dataset.tabId = tab.tab_id;
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', tab.tab_id === selected?.tab_id ? 'true' : 'false');
      item.tabIndex = tab.tab_id === selected?.tab_id ? 0 : -1;

      const title = document.createElement('span');
      title.className = 'web-assist-tab-title';
      title.textContent = tabTitle(tab);
      title.title = tab.suspended ? `${title.textContent} — ${label('web_assist.suspended', 'Inactive — reloads when opened')}` : title.textContent;
      item.appendChild(title);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'web-assist-tab-close';
      close.dataset.closeTab = tab.tab_id;
      close.innerHTML = icon('x', 'web-assist-tab-close-icon');
      setButtonCopy(close, 'web_assist.close_tab', 'Close tab');
      item.appendChild(close);
      tabsEl.appendChild(item);
    }
  }

  function stateErrorText(code) {
    if (code === 'page_load_failed') return label('web_assist.page_load_failed', 'Page could not be loaded');
    if (code === 'page_unresponsive') return label('web_assist.page_unresponsive', 'Page is not responding');
    if (code === 'download_blocked') return label('web_assist.download_blocked', 'Downloads are not available here');
    return '';
  }

  function assistantStatusText(tab) {
    if (!tab?.assistant_controlled) return '';
    if (tab.assistant_action === 'observing') return label('web_assist.assistant_observing', 'An AI agent is reading this page…');
    if (tab.assistant_action === 'acting') return label('web_assist.assistant_acting', 'An AI agent is operating this page…');
    if (tab.assistant_action === 'waiting') return label('web_assist.assistant_waiting', 'An AI agent is waiting for this page…');
    return label('web_assist.assistant_ready', 'An AI agent can assist on this page');
  }

  function rememberMainActiveTab(state) {
    const tabs = Array.isArray(state?.tabs) ? state.tabs : [];
    const active = tabs.find((tab) => tab?.tab_id === state?.active_tab_id);
    if (active?.conversation_id) activeTabByCid.set(active.conversation_id, active.tab_id);
  }

  function renderState(state) {
    if (state && typeof state === 'object') currentState = state;
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
    renderDownloadPrompt();
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
        <button type="button" class="btn btn-ghost btn-sm web-assist-activity-btn" data-act="activity"
                aria-expanded="false" aria-controls="web-assist-activity">${icon('clock')}<span></span></button>
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
        <button type="button" class="web-assist-icon-btn web-assist-external-btn" data-act="external">${icon('external')}</button>
      </div>
      <div class="web-assist-info">
        <div class="web-assist-status" role="status" aria-live="polite"></div>
      </div>
      <div class="web-assist-page">
      <section class="web-assist-download-prompt" hidden role="dialog" aria-modal="false" aria-labelledby="web-assist-download-title">
        <strong id="web-assist-download-title"></strong>
        <div class="web-assist-download-origin"></div>
        <div class="web-assist-download-filename"></div>
        <p class="web-assist-download-description"></p>
        <p class="web-assist-download-error" role="status" hidden></p>
        <div class="web-assist-download-prompt-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-act="deny-download"></button>
          <button type="button" class="btn btn-primary btn-sm" data-act="allow-download"></button>
        </div>
      </section>
      <section id="web-assist-activity" class="web-assist-activity-popover" hidden aria-labelledby="web-assist-activity-title">
        <div class="web-assist-activity-header">
          <strong id="web-assist-activity-title"></strong>
          <button type="button" class="web-assist-icon-btn" data-act="close-activity">${icon('x')}</button>
        </div>
        <ol class="web-assist-trail-list"></ol>
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
    downloadPromptEl = shell.querySelector('.web-assist-download-prompt');
    downloadPromptEl.querySelector('[data-act="deny-download"]').addEventListener('click', dismissDownloadPrompt);
    downloadPromptEl.querySelector('[data-act="allow-download"]').addEventListener('click', allowDownloadPrompt);
    activityBtn.addEventListener('click', () => setActivityOpen(activityEl.hidden));
    shell.querySelector('[data-act="close-activity"]').addEventListener('click', () => setActivityOpen(false, true));
    document.addEventListener('pointerdown', (event) => {
      if (!activityEl.hidden && !activityEl.contains(event.target) && !activityBtn.contains(event.target)) setActivityOpen(false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229 || event.key !== 'Escape' || activityEl.hidden) return;
      event.preventDefault();
      setActivityOpen(false, true);
    });

    shell.querySelector('[data-act="add"]').addEventListener('click', addTab);
    backBtn.addEventListener('click', () => navigate('back'));
    forwardBtn.addEventListener('click', () => navigate('forward'));
    reloadBtn.addEventListener('click', () => navigate('reload'));
    externalBtn.addEventListener('click', openExternal);
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
    window.addEventListener('i18n-change', refreshCopy);
    if (typeof ResizeObserver === 'function') {
      resizeObserver = new ResizeObserver(scheduleLayout);
      resizeObserver.observe(panel);
      resizeObserver.observe(host);
    }
    if (typeof MutationObserver === 'function') {
      new MutationObserver(syncVisibility).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden', 'class', 'style'],
      });
    }
    refreshCopy();
    renderState(currentState);
    return shell;
  }

  function refreshCopy() {
    if (!shell) return;
    setButtonCopy(backBtn, 'web_assist.back', 'Back');
    setButtonCopy(forwardBtn, 'web_assist.forward', 'Forward');
    setButtonCopy(reloadBtn, 'web_assist.reload', 'Reload');
    setButtonCopy(externalBtn, 'web_assist.open_external', 'Open in default browser');
    setButtonCopy(shell.querySelector('[data-act="add"]'), 'web_assist.add_tab', 'New tab');
    addressInput.placeholder = label('web_assist.address_placeholder', 'Search Bing or enter a URL');
    addressInput.setAttribute('aria-label', addressInput.placeholder);
    shell.querySelector('.web-assist-empty-title').textContent = label('web_assist.empty_title', 'Browse in this task');
    shell.querySelector('.web-assist-empty-hint').textContent = label('web_assist.empty_hint', 'Search Bing or enter a URL above.');
    downloadPromptEl.querySelector('#web-assist-download-title').textContent = label('web_assist.download_prompt_title', 'Allow downloads from this site?');
    downloadPromptEl.querySelector('.web-assist-download-description').textContent = label('web_assist.download_prompt_description', 'Files will be saved to this task’s attachments. After allowing, return to the page and retry the download.');
    downloadPromptEl.querySelector('[data-act="deny-download"]').textContent = label('web_assist.download_not_now', 'Not now');
    downloadPromptEl.querySelector('[data-act="allow-download"]').textContent = label('web_assist.download_allow', 'Allow this site');
    activityBtn.querySelector('span').textContent = label('web_assist.activity', 'Activity');
    shell.querySelector('#web-assist-activity-title').textContent = label('web_assist.activity', 'Activity');
    setButtonCopy(shell.querySelector('[data-act="close-activity"]'), 'web_assist.activity_close', 'Close activity');
    if (!activityEl.hidden) renderActivity();
    renderState(currentState);
  }

  // Requests are delivered with trusted renderer state, so background tasks
  // retain their own prompt without polling ledgers on every page update.
  function renderDownloadPrompt() {
    if (!downloadPromptEl) return;
    const live = new Set((currentState?.tabs || []).map(tab => tab.download_request?.id).filter(Boolean));
    for (const id of dismissedDownloadRequests) if (!live.has(id)) dismissedDownloadRequests.delete(id);
    const pending = activeView === 'conversation'
      ? tabsForConversation().find(item => item.download_request && !dismissedDownloadRequests.has(item.download_request.id))?.download_request : null;
    if (pending) {
      const revealKey = `${contextEpoch}:${pending.id}`;
      if (downloadRevealKey !== revealKey) {
        downloadRevealKey = revealKey;
        if (!(panelOpen && panelTab === 'browser') && !window.ConversationInfo?.openAndSetTab('browser', activeCid)) downloadRevealKey = '';
      }
    }
    const request = panelOpen && panelTab === 'browser' ? pending : null;
    downloadPromptEl.hidden = !request;
    if (activityBtn) activityBtn.disabled = !!request;
    if (!request) { activeDownloadPrompt = null; return; }
    if (activeDownloadPrompt?.id === request.id && activeDownloadPrompt.epoch === contextEpoch) return;
    activeDownloadPrompt = { ...request, cid: activeCid, epoch: contextEpoch };
    downloadPromptEl.querySelector('.web-assist-download-origin').textContent = request.origin;
    downloadPromptEl.querySelector('.web-assist-download-filename').textContent = request.filename;
    downloadPromptEl.querySelector('.web-assist-download-error').hidden = true;
    downloadPromptEl.querySelectorAll('button').forEach(button => { button.disabled = false; });
    setActivityOpen(false);
  }

  function dismissDownloadPrompt() {
    if (!activeDownloadPrompt) return;
    dismissedDownloadRequests.add(activeDownloadPrompt.id);
    renderDownloadPrompt();
    syncVisibility();
  }

  async function allowDownloadPrompt() {
    const request = activeDownloadPrompt;
    const button = downloadPromptEl.querySelector('[data-act="allow-download"]');
    if (!request || button.disabled || downloadPromptEl.hidden) return;
    downloadPromptEl.querySelectorAll('button').forEach(item => { item.disabled = true; });
    const isCurrent = () => activeDownloadPrompt?.id === request.id && contextEpoch === request.epoch && activeCid === request.cid;
    try {
      const result = await window.orkas.invoke('webAssist.allowDownloadOrigin', { conversation_id: request.cid, origin: request.origin });
      if (!isCurrent()) return;
      if (!result?.ok) throw new Error('download permission failed');
      dismissedDownloadRequests.add(request.id);
      renderDownloadPrompt();
      syncVisibility();
    } catch (_) {
      if (!isCurrent()) return;
      const error = downloadPromptEl.querySelector('.web-assist-download-error');
      error.textContent = label('web_assist.download_permission_failed', 'Could not allow this site. Try again.');
      error.hidden = false;
    } finally {
      if (isCurrent()) downloadPromptEl.querySelectorAll('button').forEach(item => { item.disabled = false; });
    }
  }

  function setActivityOpen(open, restoreFocus = false) {
    if (!activityEl) return;
    activityEl.hidden = !open;
    activityBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      renderActivity();
      activityEl.querySelector('[data-act="close-activity"]').focus();
    } else {
      activityRequest += 1;
      activityRefresh = null;
      if (restoreFocus) activityBtn.focus();
    }
    syncVisibility();
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
    const allowed = Array.isArray(downloads?.allowed_origins) ? downloads.allowed_origins : [];
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
    const reasonCopy = {
      needs_origin_grant: () => label('web_assist.download_needs_grant', 'needs permission'),
      blocked_type: () => label('web_assist.download_blocked_type', 'file type not allowed'),
      task_budget: () => label('web_assist.download_budget', 'task download limit reached'),
    };
    for (const entry of entries) {
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
          : (reasonCopy[entry.reason] || (() => label('web_assist.download_failed', 'failed')))();
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
      if (download && entry.state === 'refused' && entry.reason === 'needs_origin_grant' && !allowed.includes(entry.origin)) {
        const allow = document.createElement('button');
        allow.type = 'button';
        allow.className = 'web-assist-download-allow';
        allow.textContent = label('web_assist.download_allow', 'Allow this site');
        allow.title = entry.origin;
        allow.addEventListener('click', async () => {
          if (epoch !== contextEpoch || cid !== activeCid || activeView !== 'conversation' || activityEl.hidden || request !== activityRequest) return;
          allow.disabled = true;
          try {
            await window.orkas.invoke('webAssist.allowDownloadOrigin', { conversation_id: cid, origin: entry.origin });
          } catch (_) { /* The unchanged row allows retry when the record is reopened. */ }
          if (epoch === contextEpoch) renderActivity();
        });
        row.appendChild(allow);
      }
      activityListEl.appendChild(row);
    }
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

  function modalIsOpen() {
    const browserRect = host?.getBoundingClientRect();
    if (!browserRect || browserRect.width <= 0 || browserRect.height <= 0) return false;
    return Array.from(document.querySelectorAll('.panel.resource-detail-overlay, .modal-overlay, [aria-modal="true"], .chat-file-viewer.is-open, .web-assist-activity-popover, .web-assist-download-prompt'))
      .some((overlay) => !overlay.hidden && Array.from(overlay.getClientRects()).some((rect) => (
        rect.width > 0 && rect.height > 0
        && rect.left < browserRect.right && rect.right > browserRect.left
        && rect.top < browserRect.bottom && rect.bottom > browserRect.top
      )));
  }

  function clearPagePreview() {
    pagePreviewRequest += 1;
    pagePreview?.remove();
    pagePreview = null;
    pagePreviewTabId = '';
  }

  async function hideNativeView(previewTabId) {
    // Native views paint above DOM overlays. Keep their last frame behind the
    // controls while hidden, then discard it once the live view is restored.
    clearPagePreview();
    const request = pagePreviewRequest;
    const epoch = contextEpoch;
    pagePreviewTabId = previewTabId || '';
    const current = () => request === pagePreviewRequest && epoch === contextEpoch && !nativeVisible;
    try {
      if (previewTabId) {
        const result = await window.orkas.invoke('webAssist.capturePreview', { tabId: previewTabId });
        if (!current()) return;
        if (result?.preview) {
          const image = new Image();
          image.className = 'web-assist-page-preview';
          image.alt = '';
          image.setAttribute('aria-hidden', 'true');
          image.src = result.preview;
          await image.decode();
          if (!current()) return;
          pagePreview = image;
          host.appendChild(image);
        }
      }
    } catch {
      log.warn('browser preview unavailable');
    }
    // Closing or switching tasks during capture must not hide the new page.
    if (!current()) return;
    try { await window.orkas.invoke('webAssist.layout', { visible: false }); }
    catch { log.warn('native view hide failed'); }
  }

  function syncVisibility() {
    if (!shell) return;
    const tab = selectedTab();
    const shown = panelOpen && panelTab === 'browser' && activeView === 'conversation' && !!activeCid;
    if (shown && tab?.suspended && !tab.error_code) ensureMainActiveTab();
    if (shell.hidden !== !shown) shell.hidden = !shown;
    if (pagePreviewTabId && (!shown || pagePreviewTabId !== tab?.tab_id)) clearPagePreview();
    const localOverlay = (activityEl && !activityEl.hidden) || (downloadPromptEl && !downloadPromptEl.hidden);
    const ready = shown
      && !tab?.suspended
      && !!tab?.display_url
      && currentState?.active_tab_id === tab.tab_id;
    const next = ready && !modalIsOpen();
    const nextTabId = ready && (next || localOverlay) ? tab.tab_id : '';
    if (nativeVisible === next && nativeTabId === nextTabId) return;
    pagePreviewRequest += 1;
    nativeVisible = next;
    nativeTabId = nextTabId;
    if (next) scheduleLayout();
    else if (currentState?.open) {
      void hideNativeView(ready && localOverlay ? tab.tab_id : '');
    }
  }

  function scheduleLayout() {
    if (!nativeVisible || !host || host.hidden || layoutFrame) return;
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = 0;
      if (!nativeVisible || !host || host.hidden) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) return;
      const request = pagePreviewRequest;
      window.orkas.invoke('webAssist.layout', {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }).then((result) => {
        if (request !== pagePreviewRequest || !nativeVisible) return;
        if (result?.ok) clearPagePreview();
        if (result?.ok && result.state) renderState(result.state);
      }).catch((error) => {
        log.warn('native view layout failed', { error: (error && error.message) || String(error) });
      });
    });
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
    if (!tabsForConversation().some(tab => tab.assistant_controlled)) return;
    if (window.ConversationInfo?.openAndSetTab('browser', activeCid)) revealedTasks.add(activeCid);
  }

  function showFromMain(state) {
    ensureShell();
    currentState = state;
    rememberMainActiveTab(state);
    const ownerCid = String(state?.conversation_id || '');
    renderState(state);
    if (activeView === 'conversation' && activeCid === ownerCid && !revealedTasks.has(ownerCid)) {
      if (window.ConversationInfo?.openAndSetTab('browser', ownerCid)) revealedTasks.add(ownerCid);
    }
  }

  function beginTaskTurn(cid) {
    revealedTasks.delete(cid);
  }

  function updateContext(view, cid) {
    const nextView = view || '';
    const nextCid = cid || '';
    if (activeView === nextView && activeCid === nextCid) return;
    activeView = nextView;
    activeCid = nextCid;
    contextEpoch += 1;
    clearPagePreview();
    setActivityOpen(false);
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
    if (!panelOpen || panelTab !== 'browser') setActivityOpen(false);
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
    if (state?.assistant_action) {
      showFromMain(state);
      return;
    }
    rememberMainActiveTab(state);
    renderState(state);
  });
  window.orkas.onPushEvent('web-assist:show', (state) => showFromMain(state));
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
