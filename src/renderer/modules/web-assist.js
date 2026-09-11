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
  let resizeObserver = null;
  let layoutFrame = 0;
  let nativeVisible = false;
  let nativeTabId = '';
  let panelOpen = false;
  let panelTab = 'files';
  let activeView = typeof currentView === 'string' ? currentView : '';
  let activeCid = typeof currentCid === 'string' ? currentCid : '';
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
      <div class="web-assist-status" role="status" aria-live="polite"></div>
      <div class="web-assist-empty">
        <span class="web-assist-empty-icon">${icon('globe')}</span>
        <span class="web-assist-empty-title"></span>
        <span class="web-assist-empty-hint"></span>
      </div>
      <div class="web-assist-native-host"></div>`;
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
    renderState(currentState);
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
    return Array.from(document.querySelectorAll('.panel.resource-detail-overlay, .modal-overlay, [aria-modal="true"], .chat-file-viewer.is-open'))
      .some((overlay) => !overlay.hidden && Array.from(overlay.getClientRects()).some((rect) => (
        rect.width > 0 && rect.height > 0
        && rect.left < browserRect.right && rect.right > browserRect.left
        && rect.top < browserRect.bottom && rect.bottom > browserRect.top
      )));
  }

  function syncVisibility() {
    if (!shell) return;
    const tab = selectedTab();
    const shown = panelOpen && panelTab === 'browser' && activeView === 'conversation' && !!activeCid;
    if (shown && tab?.suspended && !tab.error_code) ensureMainActiveTab();
    if (shell.hidden !== !shown) shell.hidden = !shown;
    const next = shown
      && !tab?.suspended
      && !!tab?.display_url
      && currentState?.active_tab_id === tab.tab_id
      && !modalIsOpen();
    const nextTabId = next ? tab.tab_id : '';
    if (nativeVisible === next && nativeTabId === nextTabId) return;
    nativeVisible = next;
    nativeTabId = nextTabId;
    if (next) scheduleLayout();
    else if (currentState?.open) {
      window.orkas.invoke('webAssist.layout', { visible: false }).catch(() => {
        log.warn('native view hide failed');
      });
    }
  }

  function scheduleLayout() {
    if (!nativeVisible || !host || host.hidden || layoutFrame) return;
    layoutFrame = window.requestAnimationFrame(() => {
      layoutFrame = 0;
      if (!nativeVisible || !host || host.hidden) return;
      const rect = host.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) return;
      window.orkas.invoke('webAssist.layout', {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      }).then((result) => {
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
    if (!url || !activeCid) return false;
    ensureShell();
    try {
      const result = await window.orkas.invoke('webAssist.open', {
        url,
        label: input.label,
        conversationId: activeCid,
      });
      if (!result?.ok) throw new Error(result?.error || 'open failed');
      if (result.state?.active_tab_id) activeTabByCid.set(activeCid, result.state.active_tab_id);
      renderState(result.state);
      revealedTasks.add(activeCid);
      window.ConversationInfo?.openAndSetTab('browser');
      return true;
    } catch (error) {
      if (typeof uiToast === 'function') uiToast(label('web_assist.open_failed', 'Web Assist could not open this page.'), { variant: 'warning' });
      log.warn('open failed', { error: (error && error.message) || String(error) });
      return false;
    }
  }

  function showFromMain(state) {
    ensureShell();
    currentState = state;
    rememberMainActiveTab(state);
    const ownerCid = String(state?.conversation_id || '');
    renderState(state);
    if (activeView === 'conversation' && activeCid === ownerCid && !revealedTasks.has(ownerCid)) {
      revealedTasks.add(ownerCid);
      window.ConversationInfo?.openAndSetTab('browser');
    }
  }

  function beginTaskTurn(cid) {
    revealedTasks.delete(cid);
  }

  function setContext(view, cid) {
    activeView = view || '';
    activeCid = cid || '';
    window.orkas.invoke('webAssist.setContext', {
      conversationId: activeView === 'conversation' ? activeCid : '',
    }).catch(() => {});
    if (activeView === 'conversation') {
      window.orkas.invoke('webAssist.state', {}).then((result) => {
        if (result?.state) renderState(result.state);
        ensureDefaultTab();
      }).catch(() => {});
    }
    renderState(currentState);
  }

  function setPanelState(open, tab, cid) {
    panelOpen = !!open;
    panelTab = tab || 'files';
    if (cid) activeCid = cid;
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

  window.orkas.onPushEvent('web-assist:state', (state) => {
    if (state?.assistant_action) {
      showFromMain(state);
      return;
    }
    rememberMainActiveTab(state);
    renderState(state);
  });
  window.orkas.onPushEvent('web-assist:show', (state) => showFromMain(state));
  window.orkas.onPushEvent('web-assist:failure', (payload) => {
    // Main owns classification, privacy projection and the shared rate budget.
    try { window.Monitor?.error('browser', payload); } catch { /* telemetry is best effort */ }
  });
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
