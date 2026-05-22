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

function _renderConnectorsGrid() {
  const gridView = document.getElementById('connectors-grid-view');
  if (!gridView) return;
  gridView.style.display = '';

  const groupConn = document.getElementById('connectors-group-connected');
  const groupAvail = document.getElementById('connectors-group-available');
  const gridConn = document.getElementById('connectors-grid-connected');
  const gridAvail = document.getElementById('connectors-grid-available');
  const empty = document.getElementById('connectors-empty');

  // Partition catalog rows by whether there's a corresponding connected instance.
  const connectedItems = [];
  const availableItems = [];
  for (const entry of _connectorsState.catalog) {
    const inst = _instanceById(entry.id);
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

  const card = document.createElement('div');
  card.className = 'connector-card';
  card.dataset.id = e.id;

  // Brand SVG when available (white card, logo in native colors). The orphan-instance fallback
  // path (catalog entry got removed but instance config still exists locally) renders the first
  // two chars of the display_name on a neutral gray square.
  const iconHtml = e.icon_svg
    ? `<div class="connector-card-icon is-svg">${e.icon_svg}</div>`
    : `<div class="connector-card-icon is-fallback">${escapeHtml((e.display_name || '?').slice(0, 2).toUpperCase())}</div>`;
  const desc = (getLang && getLang() === 'zh' ? e.description_zh : e.description_en) || e.description_en || e.description_zh || '';

  // Account label (e.g. "wyt@github.com") shows under the connector name when the OAuth grant
  // includes one — replaces the now-gone detail page as the only "which account is connected"
  // surface. Errored instances show the error msg in the same slot.
  const accountLabel = (instance && instance.oauth_grant && instance.oauth_grant.account_label) || '';
  const errorMsg = errored && instance && instance.status && instance.status.message;

  // No status badge next to the name — the foot button label + the error
  // secondary line already convey state; the badge was visual duplication.
  let action = '';
  if (isOAuthPending) {
    action = `<button class="btn btn-sm" disabled>${escapeHtml(t('connectors.action.unavailable'))}</button>`;
  } else if (connected) {
    action = `<button class="btn btn-sm btn-danger" data-act="disconnect">${escapeHtml(t('connectors.action.disconnect'))}</button>`;
  } else if (errored) {
    action = `<button class="btn btn-sm btn-danger" data-act="disconnect">${escapeHtml(t('connectors.action.disconnect'))}</button>`;
  } else {
    action = `<button class="btn btn-sm btn-primary" data-act="connect">${escapeHtml(t('connectors.action.connect'))}</button>`;
  }

  // Secondary line: account label when connected, error msg when errored, none otherwise.
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
    });
  });
  return card;
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
  const id = (instance && instance.id) || entry.id;
  const name = (instance && instance.display_name) || entry.display_name || id;
  const ok = await uiConfirmDanger({
    title: t('connectors.confirm_disconnect_title', { name }),
    message: t('connectors.confirm_disconnect_msg'),
    dangerLabel: t('connectors.action.disconnect'),
  });
  if (!ok) return;
  try {
    const res = await window.orkas.invoke('connectors.remove', { id });
    if (!res || !res.ok) {
      uiAlert((res && res.error) || t('connectors.errors.remove_failed'));
      return;
    }
    await loadConnectors();
  } catch (err) {
    uiAlert((err && err.message) || t('connectors.errors.remove_failed'));
  }
}

async function _runConnect(entry) {
  // No UI state mutation here — the card stays as-is. Re-clicks supersede the prior pending
  // flow on the main side (oauth.ts::startOAuth calls _cancelPending before installing a new
  // listener), and the prior _runConnect's await rejects with "superseded ..." which we
  // silently drop.
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
