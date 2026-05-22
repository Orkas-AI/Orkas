// Connectors panel — curated OAuth-only catalog of MCP-based integrations.
//
// Layout: a single scrollable grid view with two stacked sections — "已连接" (Connected) on top,
// "可用" (Available) below. No tab switching; same shape as the Skills panel's
// Custom / Built-in split. Both groups hide themselves when empty.
//
// Click model: only the action buttons on a card are clickable. Clicking elsewhere on a card
// does nothing — users routinely hovered over cards to read descriptions and the old whole-card
// click handler was firing OAuth flows by accident. Buttons stop propagation as a defence in
// depth.
//
// OAuth flow UX: clicking "连接" just opens the system browser and returns control to the
// renderer's _runConnect Promise (which the main process resolves once the deep-link callback
// completes). **The card itself does NOT change state during the flow** — no "授权中" badge, no
// disabled button. The user can click "连接" again at any time; server-side startOAuth
// supersedes any prior pending flow, and the renderer surfaces only real errors (the
// "superseded" message is swallowed since it's caused by the user's own re-click).

const _connectorsLog = createLogger('connectors');

let _connectorsState = {
  catalog: [],
  instances: [],
  loading: false,
  /** Per-card connecting flag. Set when `_runConnect` is in flight (browser-open → deep-link
   *  return → /oauth/exchange → MCP connect → list_tools). Visible only post-return when the
   *  user comes back to PC and the IPC is still running through exchange + MCP setup — without
   *  this they'd see a static "连接" button with no indication anything is happening. Button
   *  stays clickable; re-click supersedes the prior flow (see comment in `_runConnect`). */
  connecting: new Set(),
};

async function loadConnectors() {
  _connectorsState.loading = true;
  _renderConnectorsGrid();
  try {
    const [catRes, listRes] = await Promise.all([
      window.orkas.invoke('connectors.catalog', {}),
      window.orkas.invoke('connectors.list', {}),
    ]);
    _connectorsState.catalog = (catRes && catRes.ok && Array.isArray(catRes.catalog)) ? catRes.catalog : [];
    _connectorsState.instances = (listRes && listRes.ok && Array.isArray(listRes.instances)) ? listRes.instances : [];
  } catch (err) {
    _connectorsLog.warn('list failed', { error: err && err.message });
  } finally {
    _connectorsState.loading = false;
    _renderConnectorsGrid();
  }
}

function _instanceById(id) {
  return _connectorsState.instances.find((i) => i.id === id) || null;
}

// Build a synthetic ConnectorInstance for a bundle entry. Bundle entries have no real instance
// (manager.connectViaOAuth provisions the N members instead) — but the renderer treats the
// bundle as a single card, so we derive an instance-shaped object: status=connected iff all
// members connected; account_label / enabled taken from the first member that has them.
function _deriveBundleInstance(entry) {
  const members = (entry.bundle_member_ids || []).map((id) => _instanceById(id)).filter(Boolean);
  if (!members.length) return null;  // no member installed yet → bundle shows as "available"
  const allConnected = members.length === entry.bundle_member_ids.length
    && members.every((m) => m.status && m.status.kind === 'connected');
  const anyErrored = members.find((m) => m.status && m.status.kind === 'error');
  const accountLabel = members.map((m) => m.oauth_grant && m.oauth_grant.account_label).find(Boolean) || '';
  // For enabled: bundle is "enabled" iff every member is enabled (any disabled → show "停用-able").
  const allEnabled = members.every((m) => m.enabled !== false);
  return {
    id: entry.id,
    display_name: entry.display_name,
    status: allConnected
      ? { kind: 'connected', since: 0 }
      : (anyErrored ? { kind: 'error', message: anyErrored.status.message, at: 0 } : { kind: 'connecting' }),
    oauth_grant: accountLabel ? { account_label: accountLabel } : undefined,
    enabled: allEnabled,
    // Bundle marker so the click handlers fan out to all members.
    _bundle_member_ids: entry.bundle_member_ids,
  };
}

function _renderConnectorsGrid() {
  const gridView = document.getElementById('connectors-grid-view');
  if (!gridView) return;
  gridView.style.display = '';

  const groupConn = document.getElementById('connectors-group-connected');
  const groupAvail = document.getElementById('connectors-group-available');
  const gridConn = document.getElementById('connectors-grid-connected');
  const gridAvail = document.getElementById('connectors-grid-available');
  const empty = document.getElementById('connectors-empty');

  // Bundle handling — entries with `bundle_member_ids` are UI groupings. Members are hidden
  // (they don't show as separate cards) so the user sees one card per logical product.
  const bundleMemberIds = new Set();
  for (const entry of _connectorsState.catalog) {
    if (Array.isArray(entry.bundle_member_ids)) {
      for (const m of entry.bundle_member_ids) bundleMemberIds.add(m);
    }
  }

  // Partition catalog rows by whether there's a corresponding connected instance.
  const connectedItems = [];
  const availableItems = [];
  for (const entry of _connectorsState.catalog) {
    if (bundleMemberIds.has(entry.id)) continue;  // hide bundle members
    let inst = _instanceById(entry.id);
    // For bundle entries: derive a synthetic "connected" instance when ALL members are
    // connected. The synthetic instance shape mirrors a real one so `_renderCatalogCard`
    // doesn't care it's a bundle.
    if (Array.isArray(entry.bundle_member_ids)) {
      inst = _deriveBundleInstance(entry);
    }
    if (inst && inst.status && inst.status.kind === 'connected') {
      connectedItems.push({ entry, instance: inst });
    } else {
      availableItems.push({ entry, instance: inst });
    }
  }
  // A→Z within each group (CLAUDE.md §8 inventory ordering).
  const cmp = (a, b) => (a.entry.display_name || '').localeCompare(b.entry.display_name || '', undefined, { sensitivity: 'base', numeric: true });
  connectedItems.sort(cmp);
  availableItems.sort(cmp);

  // Render each group.
  gridConn.innerHTML = '';
  for (const it of connectedItems) gridConn.appendChild(_renderCatalogCard(it.entry, it.instance));
  groupConn.style.display = connectedItems.length ? '' : 'none';

  gridAvail.innerHTML = '';
  for (const it of availableItems) gridAvail.appendChild(_renderCatalogCard(it.entry, it.instance));
  groupAvail.style.display = availableItems.length ? '' : 'none';

  if (_connectorsState.loading && !_connectorsState.catalog.length) {
    empty.style.display = '';
    empty.textContent = t('common.loading');
  } else if (!connectedItems.length && !availableItems.length) {
    empty.style.display = '';
    empty.textContent = t('connectors.empty');
  } else {
    empty.style.display = 'none';
  }
}

function _renderCatalogCard(entry, instance) {
  const e = entry || _entryFromInstance(instance);
  const isOAuthPending = !!(e && e.unavailable_reason === 'oauth_pending');
  const connected = !!(instance && instance.status && instance.status.kind === 'connected');
  const errored = !!(instance && instance.status && instance.status.kind === 'error');
  // `enabled` is per-user soft state attached by `connectors.list` IPC. Only meaningful for
  // connected cards (un-connected ones have nothing to disable). Default true when missing.
  const enabledFlag = instance && Object.prototype.hasOwnProperty.call(instance, 'enabled')
    ? !!instance.enabled
    : true;

  const card = document.createElement('div');
  card.className = `connector-card${connected && !enabledFlag ? ' is-disabled' : ''}`;
  card.dataset.id = e.id;

  const iconHtml = e.icon_svg
    ? `<div class="connector-card-icon is-svg">${e.icon_svg}</div>`
    : `<div class="connector-card-icon is-fallback">${escapeHtml((e.display_name || '?').slice(0, 2).toUpperCase())}</div>`;
  const desc = (getLang && getLang() === 'zh' ? e.description_zh : e.description_en) || e.description_en || e.description_zh || '';

  const accountLabel = (instance && instance.oauth_grant && instance.oauth_grant.account_label) || '';
  const errorMsg = errored && instance && instance.status && instance.status.message;

  // ⋯ menu lives on connected cards only — it hosts the destructive "断开" action so it stays
  // one click away from accidental triggers. Un-connected / errored cards still surface the
  // disconnect action as a bottom-row button (they need it visible to recover; the "停用" toggle
  // doesn't apply when there's nothing to disable).
  const menuHtml = connected
    ? `<button class="connector-card-menu-btn" data-act="menu" aria-label="${escapeHtml(t('common.more') || '⋯')}">⋯</button>`
    : '';

  // Bottom-row action:
  //   - connected: 启用 / 停用 toggle (per-user soft switch — hides instance from LLM)
  //   - errored:   断开 (recover from a stuck error state)
  //   - oauth_pending: disabled "敬请期待"
  //   - default (uninstalled): 连接 (start OAuth)
  let action = '';
  if (isOAuthPending) {
    action = `<button class="btn btn-sm" disabled>${escapeHtml(t('connectors.action.unavailable'))}</button>`;
  } else if (connected) {
    const label = enabledFlag ? t('component.disable') : t('component.enable');
    const cls = enabledFlag ? 'btn btn-sm' : 'btn btn-sm btn-primary';
    action = `<button class="${cls}" data-act="toggle-enabled">${escapeHtml(label)}</button>`;
  } else if (errored) {
    action = `<button class="btn btn-sm btn-danger" data-act="disconnect">${escapeHtml(t('connectors.action.disconnect'))}</button>`;
  } else {
    // Spinner while `_runConnect` is in flight. Button stays clickable (re-click supersedes).
    const isConnecting = _connectorsState.connecting && _connectorsState.connecting.has(e.id);
    const label = isConnecting ? t('connectors.action.connecting') : t('connectors.action.connect');
    const spinner = isConnecting ? '<span class="btn-spinner"></span>' : '';
    action = `<button class="btn btn-sm btn-primary${isConnecting ? ' is-loading' : ''}" data-act="connect">${spinner}${escapeHtml(label)}</button>`;
  }

  let secondaryHtml = '';
  if (errorMsg) {
    secondaryHtml = '<div class="connector-card-error"></div>';
  } else if (accountLabel) {
    secondaryHtml = '<div class="connector-card-account muted"></div>';
  }

  card.innerHTML = `
    <div class="connector-card-top">
      ${iconHtml}
      <div class="connector-card-headline">
        <div class="connector-card-name"></div>
        ${secondaryHtml}
      </div>
      ${menuHtml}
    </div>
    <div class="connector-card-desc muted"></div>
    <div class="connector-card-foot">${action}</div>
  `;
  card.querySelector('.connector-card-name').textContent = e.display_name;
  card.querySelector('.connector-card-desc').textContent = desc;
  if (errorMsg) {
    card.querySelector('.connector-card-error').textContent = `${t('connectors.status.error')}: ${errorMsg}`;
  } else if (accountLabel) {
    card.querySelector('.connector-card-account').textContent = accountLabel;
  }

  card.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'connect') _runConnect(e);
      else if (act === 'disconnect') _quickDisconnect(e, instance);
      else if (act === 'menu') _openCardMenu(btn, e, instance);
      else if (act === 'toggle-enabled') _toggleConnectorEnabled(e, instance, !enabledFlag);
    });
  });
  return card;
}

// Tiny absolute-positioned popover anchored under the ⋯ button — one item for now ("断开").
// Closes on outside click / Esc / window scroll. Keeping it inline so we don't pull in a generic
// menu primitive for one use site; if a second connector-card menu item ever lands, refactor.
function _openCardMenu(anchorBtn, entry, instance) {
  const existing = document.querySelector('.connector-card-menu-popover');
  if (existing) { existing.remove(); return; }
  const rect = anchorBtn.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'connector-card-menu-popover';
  pop.style.top = `${Math.round(rect.bottom + 4)}px`;
  pop.style.left = `${Math.round(rect.right - 120)}px`;
  pop.innerHTML = `<div class="connector-card-menu-item is-danger" data-act="disconnect">${escapeHtml(t('connectors.action.disconnect'))}</div>`;
  document.body.appendChild(pop);

  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', close, true);
  };
  const onOutside = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchorBtn) close(); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', close, true);

  pop.querySelector('[data-act="disconnect"]').addEventListener('click', () => {
    close();
    _quickDisconnect(entry, instance);
  });
}

async function _toggleConnectorEnabled(entry, instance, nextEnabled) {
  // Bundle entry: fan out the toggle to every member id; bundle itself isn't an instance.
  const ids = Array.isArray(entry.bundle_member_ids) && entry.bundle_member_ids.length
    ? entry.bundle_member_ids.slice()
    : [(instance && instance.id) || entry.id];
  try {
    for (const id of ids) {
      const res = await window.orkas.invoke('connectors.set_enabled', { id, enabled: nextEnabled });
      if (!res || !res.ok) {
        uiAlert((res && res.error) || t('component.toggle_failed'));
        return;
      }
    }
    await loadConnectors();
  } catch (err) {
    uiAlert((err && err.message) || t('component.toggle_failed'));
  }
}

function _entryFromInstance(instance) {
  return {
    id: instance.id,
    display_name: instance.display_name || instance.id,
    description_zh: '',
    description_en: '',
  };
}

async function _quickDisconnect(entry, instance) {
  const name = (instance && instance.display_name) || entry.display_name || entry.id;
  const ok = await uiConfirmDanger({
    title: t('connectors.confirm_disconnect_title', { name }),
    message: t('connectors.confirm_disconnect_msg'),
    dangerLabel: t('connectors.action.disconnect'),
  });
  if (!ok) return;
  // Bundle entry: disconnect every member instance. Members not yet installed are skipped (the
  // IPC just returns ok:false / removed:false which we treat as no-op).
  const ids = Array.isArray(entry.bundle_member_ids) && entry.bundle_member_ids.length
    ? entry.bundle_member_ids.slice()
    : [(instance && instance.id) || entry.id];
  try {
    for (const id of ids) {
      const res = await window.orkas.invoke('connectors.remove', { id });
      if (!res || (!res.ok && !/not found/i.test(res.error || ''))) {
        uiAlert((res && res.error) || t('connectors.errors.remove_failed'));
        return;
      }
    }
    await loadConnectors();
  } catch (err) {
    uiAlert((err && err.message) || t('connectors.errors.remove_failed'));
  }
}

async function _runConnect(entry) {
  // Mark "connecting" so the card's foot button shows a spinner. The button stays clickable —
  // re-clicks supersede the prior pending flow on the main side (oauth.ts::startOAuth calls
  // _cancelPending before installing a new listener), and the prior _runConnect's await
  // rejects with "superseded ..." which we silently drop. The spinner is mainly for the
  // post-deep-link-return phase (exchange / MCP connect / list_tools — multiple network
  // roundtrips that look frozen if we render nothing). During the browser-open phase the user
  // isn't looking at the PC anyway.
  _connectorsState.connecting.add(entry.id);
  _renderConnectorsGrid();
  try {
    const res = await window.orkas.invoke('connectors.start_oauth', { catalog_id: entry.id });
    if (res && res.ok && res.instance) {
      // Refresh state + re-render the grid. The new instance shows up in the "已连接" group.
      await loadConnectors();
    } else if (res && !res.ok) {
      const msg = (res.error || '').toLowerCase();
      if (!msg.includes('superseded') && !msg.includes('cancelled')) {
        uiAlert(res.error || t('connectors.errors.connect_failed'));
      }
      await loadConnectors();
    }
  } catch (err) {
    const msg = ((err && err.message) || '').toLowerCase();
    if (!msg.includes('superseded') && !msg.includes('cancelled')) {
      uiAlert((err && err.message) || t('connectors.errors.connect_failed'));
    }
    await loadConnectors();
  } finally {
    _connectorsState.connecting.delete(entry.id);
    // `loadConnectors` already re-renders, but it's inside the try/catch and may have skipped
    // (e.g. on `superseded` we don't always reload). Belt-and-suspenders: ensure the spinner
    // clears even when the connect flow exits without a reload.
    _renderConnectorsGrid();
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  })[c]);
}

window.addEventListener('i18n-change', () => {
  if (currentView === 'connectors') _renderConnectorsGrid();
});

// only consumer is the connectors panel itself, but registering at module load lets future
// background events (token expiry notifications etc.) refresh the panel automatically.
if (window.orkas && typeof window.orkas.on === 'function') {
  try {
    window.orkas.on('connectors:changed', () => {
      if (currentView === 'connectors') loadConnectors();
    });
  } catch (_err) { /* event not supported; harmless */ }
}
