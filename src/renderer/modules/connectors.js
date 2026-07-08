// Connectors panel — curated OAuth-only catalog of MCP-based integrations.
//
// Layout: a single scrollable grid view with two stacked sections — connected on top,
// available below. No tab switching; same shape as the Skills panel's
// Custom / Built-in split. Both groups hide themselves when empty.
//
// Click model: only the action buttons on a card are clickable. Clicking elsewhere on a card
// does nothing — users routinely hovered over cards to read descriptions and the old whole-card
// click handler was firing OAuth flows by accident. Buttons stop propagation as a defence in
// depth.
//
// OAuth flow UX: clicking Connect just opens the system browser and returns control to the
// renderer's _runConnect Promise (which the main process resolves once the deep-link callback
// completes). **The card itself does NOT change state during the flow** — no authorizing badge, no
// disabled button. The user can click Connect again at any time; server-side startOAuth
// supersedes any prior pending flow, and the renderer surfaces only real errors (the
// "superseded" message is swallowed since it's caused by the user's own re-click).

const _connectorsLog = createLogger('connectors');
const _CONNECTORS_RENDER_CACHE_VERSION = 2;
const _CONNECTORS_RENDER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let _connectorsLegacyCachePurged = false;

function _connectorsTrackClick(action, data) {
}

function _connectorsTrackEvent(action, data) {
}

function _connectorsTrackError(action, data) {
}

function _connectorTrackPayload(entry, instance) {
  const e = entry || {};
  const inst = instance || {};
  return {
    connector_id: String(e.id || inst.id || ''),
    origin: inst.origin === 'custom' || e._custom ? 'custom' : 'catalog',
    is_bundle: !!(Array.isArray(e.bundle_member_ids) && e.bundle_member_ids.length),
  };
}

function _connectorTrackErrorType(err) {
  const msg = String((err && (err.message || err.error)) || err || '').toLowerCase();
  if (/timeout|timed out/.test(msg)) return 'timeout';
  if (/network|fetch failed|econnreset|econnrefused|eai_again|enotfound/.test(msg)) return 'network';
  if (/cancelled|canceled|superseded/.test(msg)) return 'cancelled';
  if (/auth|grant|scope|oauth/.test(msg)) return 'auth';
  return 'exception';
}

let _connectorsState = {
  catalog: [],
  instances: [],
  loading: false,
  /** Per-card connecting flag. Set when `_runConnect` is in flight (browser-open → deep-link
   *  return → /oauth/exchange → MCP connect → list_tools). Visible only post-return when the
   *  user comes back to PC and the IPC is still running through exchange + MCP setup — without
   *  this they'd see a static Connect button with no indication anything is happening. Button
   *  stays clickable; re-click supersedes the prior flow (see comment in `_runConnect`). */
  connecting: new Set(),
};
let _connectorsLoadSeq = 0;

function _connectorsRenderCacheKey() {
  const uid = (typeof currentUserId === 'string' && currentUserId)
    ? currentUserId
    : ((typeof globalThis.currentUserId === 'string' && globalThis.currentUserId) ? globalThis.currentUserId : 'local');
  return `orkas.connectors.renderCache.v${_CONNECTORS_RENDER_CACHE_VERSION}.${uid}`;
}

function _purgeLegacyConnectorsRenderCaches() {
  if (_connectorsLegacyCachePurged) return;
  _connectorsLegacyCachePurged = true;
  try {
    const prefix = 'orkas.connectors.renderCache.v';
    const currentPrefix = `orkas.connectors.renderCache.v${_CONNECTORS_RENDER_CACHE_VERSION}.`;
    const doomed = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && key.startsWith(prefix) && !key.startsWith(currentPrefix)) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch (_) { /* localStorage unavailable / quota — skip */ }
}

function _sanitizeConnectorArray(value, options = {}) {
  const arr = Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : [];
  if (!options.dropErrored) return arr;
  return arr.filter((item) => !(item.status && item.status.kind === 'error'));
}

function _hydrateConnectorsRenderCache() {
  if (_connectorsState.catalog.length || _connectorsState.instances.length) return false;
  try {
    const raw = localStorage.getItem(_connectorsRenderCacheKey());
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== _CONNECTORS_RENDER_CACHE_VERSION) return false;
    if (Date.now() - Number(parsed.updated_at || 0) > _CONNECTORS_RENDER_CACHE_TTL_MS) return false;
    const catalog = _sanitizeConnectorArray(parsed.catalog);
    const instances = _sanitizeConnectorArray(parsed.instances, { dropErrored: true });
    if (!catalog.length && !instances.length) return false;
    _connectorsState.catalog = catalog;
    _connectorsState.instances = instances;
    return true;
  } catch (_) {
    return false;
  }
}

function _persistConnectorsRenderCache() {
  if (!_connectorsState.catalog.length && !_connectorsState.instances.length) return;
  try {
    localStorage.setItem(_connectorsRenderCacheKey(), JSON.stringify({
      version: _CONNECTORS_RENDER_CACHE_VERSION,
      updated_at: Date.now(),
      catalog: _connectorsState.catalog,
      instances: _sanitizeConnectorArray(_connectorsState.instances, { dropErrored: true }),
    }));
  } catch (_) { /* localStorage unavailable / quota — skip */ }
}

async function loadConnectors() {
  const seq = ++_connectorsLoadSeq;
  _purgeLegacyConnectorsRenderCaches();
  _hydrateConnectorsRenderCache();
  _connectorsState.loading = true;
  _renderConnectorsGrid();
  try {
    const [catRes, listRes] = await Promise.all([
      window.orkas.invoke('connectors.catalog', {}).catch((err) => ({ ok: false, error: err })),
      window.orkas.invoke('connectors.list', {}).catch((err) => ({ ok: false, error: err })),
    ]);
    if (seq !== _connectorsLoadSeq) return;
    if (catRes && catRes.ok && Array.isArray(catRes.catalog)) {
      _connectorsState.catalog = catRes.catalog;
    } else {
      _connectorsLog.warn('catalog failed', { error: catRes && (catRes.error && catRes.error.message || catRes.error) });
    }
    if (listRes && listRes.ok && Array.isArray(listRes.instances)) {
      _connectorsState.instances = listRes.instances;
    } else {
      _connectorsLog.warn('list failed', { error: listRes && (listRes.error && listRes.error.message || listRes.error) });
    }
    _persistConnectorsRenderCache();
  } catch (err) {
    _connectorsLog.warn('list failed', { error: err && err.message });
  } finally {
    if (seq === _connectorsLoadSeq) {
      _connectorsState.loading = false;
      _renderConnectorsGrid();
    }
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
  // For enabled: bundle is "enabled" iff every member is enabled (any disabled → show Enable).
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

// True iff this connector id is currently live for the LLM (connected + not user-disabled).
// Mirrors the main-side `resolveVisibleConnectors` filter so a queue-draft drained after the
// user disconnects / disables the connector can detect the dangling reference and degrade the
// message to plain text instead of injecting a `use <connector>` prefix the bus can't honor.
function isConnectorLive(id) {
  const inst = _instanceById(id);
  return !!(inst && inst.status && inst.status.kind === 'connected' && inst.enabled !== false);
}

function _isReconnectableError(entry, instance) {
  return !!(
    entry
    && entry.transport_template
    && instance
    && instance.status
    && instance.status.kind === 'error'
  );
}

function _isConnectorVisibleDisabled(entry) {
  return !!(entry && entry.availability === 'visible_disabled');
}

function _showConnectorUnsupportedToast() {
  const message = t('connectors.toast.unsupported');
  if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
  else uiAlert(message);
}

function _connectorErrorFallback(kind) {
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  const zh = String(lang).startsWith('zh');
  const ja = String(lang).startsWith('ja');
  if (kind === 'network') {
    if (zh) return '暂时无法连接，请稍后重试';
    if (ja) return '一時的に接続できません。しばらくしてから再試行してください';
    return 'Temporarily unable to connect. Please try again later.';
  }
  if (kind === 'reconnect') {
    if (zh) return '授权已失效，请重新连接';
    if (ja) return '認証の有効期限が切れました。再接続してください';
    return 'Authorization expired. Please reconnect.';
  }
  return '';
}

function _formatConnectorStatusError(message) {
  const msg = String(message || '');
  if (/fetch failed|network|timeout|timed out|econnreset|econnrefused|eai_again|enotfound|socket|connection (closed|reset|dropped)|terminated/i.test(msg)) {
    return _connectorErrorFallback('network');
  }
  if (/invalid_grant|connector_reconnect_required|reconnect required|grant not found/i.test(msg)) {
    return _connectorErrorFallback('reconnect');
  }
  return msg;
}

function listUsableConnectorsForPicker() {
  const catalogById = new Map((_connectorsState.catalog || []).map((entry) => [entry.id, entry]));
  const lang = (typeof getLang === 'function') ? getLang() : 'en';
  return (_connectorsState.instances || [])
    .filter((inst) => inst && inst.status && inst.status.kind === 'connected' && inst.enabled !== false)
    .map((inst) => {
      const entry = catalogById.get(inst.id) || _entryFromInstance(inst);
      const account = inst.oauth_grant && inst.oauth_grant.account_label ? inst.oauth_grant.account_label : '';
      return {
        id: inst.id,
        name: inst.display_name || entry.display_name || inst.id,
        description: pickDesc(entry, lang),
        account,
      };
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base', numeric: true }));
}

// Brand color hex per PC/docs/design/README §Surface E. Used as background
// for the 32×32 letter square in `_renderCatalogCard` when no `icon_svg` is
// shipped. Lookup is by `entry.id` (catalog id, stable across releases) with
// a graphite fallback for unknown ids.
const _CONNECTOR_BRAND_TINT = {
  github: '#16181d',
  notion: '#000000',
  gmail: '#ea4335',
  linear: '#5e6ad2',
  slack: '#4a154b',
  gcal: '#4285f4',
  'google-calendar': '#4285f4',
  jira: '#0052cc',
  figma: '#0acf83',
  drive: '#4285f4',
  'google-drive': '#4285f4',
  'google-workspace': '#4285f4',
};

function _renderConnectorsGrid() {
  const gridView = document.getElementById('connectors-grid-view');
  if (!gridView) return;
  gridView.style.display = '';

  // Idempotent header-button wiring — the panel HTML is static, so bind once.
  const addBtn = document.getElementById('connectors-add-custom-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', () => {
      _connectorsTrackClick('connector_custom_open', {});
      _openAddCustomDialog();
    });
  }

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
  // Custom MCP instances have no catalog entry — render them from the
  // instance itself (derived entry carries the `_custom` marker so the card
  // renderer swaps OAuth actions for remove-only handling).
  for (const inst of _connectorsState.instances) {
    if (!inst || inst.origin !== 'custom') continue;
    const item = { entry: _entryFromInstance(inst), instance: inst };
    if (inst.status && inst.status.kind === 'connected') connectedItems.push(item);
    else availableItems.push(item);
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

  // Surface E per-group count chips.
  const connCountEl = document.getElementById('connectors-group-connected-count');
  if (connCountEl) connCountEl.textContent = connectedItems.length > 0 ? String(connectedItems.length) : '';
  const availCountEl = document.getElementById('connectors-group-available-count');
  if (availCountEl) availCountEl.textContent = availableItems.length > 0 ? String(availableItems.length) : '';
}

function _renderCatalogCard(entry, instance) {
  const e = entry || _entryFromInstance(instance);
  const isOAuthPending = !!(e && e.unavailable_reason === 'oauth_pending');
  const isVisibleDisabled = _isConnectorVisibleDisabled(e);
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

  // Brand-color square per design (Surface E) — applied ONLY to the
  // fallback letter glyph (no icon_svg shipped). When a real icon_svg is
  // present, the SVG carries its own brand colors and a dark tint behind
  // it can swallow monochrome marks (GitHub `fill:#181717` on `#16181d`,
  // Notion `fill:#000` on `#000`, etc.) — the SVG sits on the card's own
  // surface instead.
  const brandTint = _CONNECTOR_BRAND_TINT[e.id] || '#16181d';
  const iconHtml = e.icon_svg
    ? `<div class="connector-card-icon is-svg">${e.icon_svg}</div>`
    : `<div class="connector-card-icon is-fallback" style="background:${brandTint}">${escapeHtml((e.display_name || '?').slice(0, 1).toUpperCase())}</div>`;
  // Custom cards have no authored description — show the server summary
  // (url / command) so the user can tell their entries apart.
  const desc = e._custom
    ? _customTransportSummary(instance)
    : pickDesc(e, (typeof getLang === 'function') ? getLang() : 'en');

  const accountLabel = (instance && instance.oauth_grant && instance.oauth_grant.account_label) || '';
  const errorMsg = errored && instance && instance.status && instance.status.message;

  // The ⋯ menu lives on connected cards only — it hosts the destructive disconnect action so it stays
  // one click away from accidental triggers. Un-connected / errored cards still surface the
  // disconnect action as a bottom-row button (they need it visible to recover; the disable toggle
  // doesn't apply when there's nothing to disable).
  const menuHtml = connected
    ? `<button class="connector-card-menu-btn" data-act="menu" aria-label="${escapeHtml(t('common.more'))}" aria-expanded="false">⋯</button>`
    : '';

  // Bottom-row action:
  //   - connecting (this card is in `_connectorsState.connecting`): show spinner — overrides
  //     every other state. Without this, a bundle finishes its 5-member install in ~0.7s
  //     of stdio MCP handshakes; the card flips from "available" to "connected" section
  //     before `_runConnect`'s `finally` clears the connecting flag, and the user sees
  //     the spinner vanish "the moment they return from the browser" even though the
  //     IPC chain (loadConnectors + grid re-render) is still finishing.
  //   - connected: use in the Commander composer; enable / disable lives in the ⋯ menu
  //   - errored:   disconnect (recover from a stuck error state)
  //   - oauth_pending: disabled unavailable button
  //   - default (uninstalled): connect (start OAuth)
  let action = '';
  const isConnecting = _connectorsState.connecting && _connectorsState.connecting.has(e.id);
  if (isConnecting) {
    action = `<button class="btn btn-sm btn-primary is-loading" data-act="connect"><span class="btn-spinner"></span>${escapeHtml(t('connectors.action.connecting'))}</button>`;
  } else if (isOAuthPending) {
    action = `<button class="btn btn-sm" disabled>${escapeHtml(t('connectors.action.unavailable'))}</button>`;
  } else if (isVisibleDisabled) {
    action = `<button class="btn btn-sm btn-primary" data-act="unsupported-connect">${escapeHtml(t('connectors.action.connect'))}</button>`;
  } else if (connected) {
    const useTitle = escapeHtml(formatChatUseLabel({ kind: 'connector', id: e.id, name: e.display_name || e.id }));
    action = `<button class="agent-card-use connector-card-use" data-act="use-connector" title="${useTitle}" aria-label="${useTitle}" ${enabledFlag ? '' : 'disabled aria-disabled="true" tabindex="-1"'}>${escapeHtml(t('common.use'))}</button>`;
  } else if (e._custom) {
    // Custom server, not connected: retry probes the stored transport
    // (`connectors.refresh`), never OAuth. Disconnect stays available so a
    // dead entry can be removed.
    action = `
      <button class="btn btn-sm btn-primary" data-act="retry-custom">${escapeHtml(t('connectors.action.retry'))}</button>
      <button class="btn btn-sm btn-danger" data-act="disconnect">${escapeHtml(t('connectors.action.disconnect'))}</button>`;
  } else if (_isReconnectableError(e, instance)) {
    action = `<button class="btn btn-sm btn-primary" data-act="connect">${escapeHtml(t('connectors.action.connect'))}</button>`;
  } else if (errored) {
    action = `<button class="btn btn-sm btn-danger" data-act="disconnect">${escapeHtml(t('connectors.action.disconnect'))}</button>`;
  } else {
    action = `<button class="btn btn-sm btn-primary" data-act="connect">${escapeHtml(t('connectors.action.connect'))}</button>`;
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
    const el = card.querySelector('.connector-card-error');
    const text = `${t('connectors.status.error')}: ${_formatConnectorStatusError(errorMsg)}`;
    el.textContent = text;
    el.title = text;
  } else if (accountLabel) {
    const el = card.querySelector('.connector-card-account');
    el.textContent = accountLabel;
    el.title = accountLabel;
  }

  card.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const act = btn.dataset.act;
      if (act === 'connect') _runConnect(e);
      else if (act === 'unsupported-connect') _showConnectorUnsupportedToast();
      else if (act === 'disconnect') _quickDisconnect(e, instance);
      else if (act === 'menu') _openCardMenu(btn, e, instance);
      else if (act === 'use-connector' && enabledFlag) _useConnector(e, instance);
      else if (act === 'retry-custom') _retryCustomConnect(e);
    });
  });
  return card;
}

// Tiny absolute-positioned popover anchored under the ⋯ button — one disconnect item for now.
// Closes on outside click / Esc / window scroll. Keeping it inline so we don't pull in a generic
// menu primitive for one use site; if a second connector-card menu item ever lands, refactor.
function _clearConnectorCardMenuState() {
  document.querySelectorAll('.connector-card.is-menu-open').forEach((card) => card.classList.remove('is-menu-open'));
  document.querySelectorAll('.connector-card-menu-btn[aria-expanded="true"]').forEach((btn) => {
    btn.setAttribute('aria-expanded', 'false');
  });
}

function _openCardMenu(anchorBtn, entry, instance) {
  const card = anchorBtn.closest('.connector-card');
  const openCard = document.querySelector('.connector-card.is-menu-open');
  const existing = document.querySelector('.connector-card-menu-popover');
  if (existing) {
    existing.remove();
    _clearConnectorCardMenuState();
    if (openCard === card) return;
  }
  if (card) card.classList.add('is-menu-open');
  anchorBtn.setAttribute('aria-expanded', 'true');
  const rect = anchorBtn.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'connector-card-menu-popover';
  pop.style.top = '-9999px';
  pop.style.left = '-9999px';
  const enabledFlag = instance && Object.prototype.hasOwnProperty.call(instance, 'enabled')
    ? !!instance.enabled
    : true;
  const toggleLabel = enabledFlag ? t('component.disable') : t('component.enable');
  pop.innerHTML = `
    <div class="connector-card-menu-item" data-act="toggle-enabled">${escapeHtml(toggleLabel)}</div>
    <div class="connector-card-menu-item is-danger" data-act="disconnect">${escapeHtml(t('connectors.action.disconnect'))}</div>
  `;
  document.body.appendChild(pop);
  const popRect = pop.getBoundingClientRect();
  const margin = 8;
  let left = rect.right - popRect.width;
  let top = rect.bottom + 6;
  if (left < margin) left = margin;
  if (left + popRect.width > window.innerWidth - margin) left = window.innerWidth - popRect.width - margin;
  if (top + popRect.height > window.innerHeight - margin) top = rect.top - popRect.height - 6;
  if (top < margin) top = margin;
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;

  const close = () => {
    pop.remove();
    _clearConnectorCardMenuState();
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', close, true);
  };
  const onOutside = (ev) => { if (!pop.contains(ev.target) && ev.target !== anchorBtn) close(); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', close, true);

  pop.querySelectorAll('[data-act]').forEach((item) => {
    item.addEventListener('click', () => {
      close();
      const act = item.dataset.act;
      if (act === 'disconnect') _quickDisconnect(entry, instance);
      else if (act === 'toggle-enabled') _toggleConnectorEnabled(entry, instance, !enabledFlag);
    });
  });
}

function _useConnector(entry, instance) {
  if (!instance || !instance.status || instance.status.kind !== 'connected' || instance.enabled === false) return;
  const id = String((instance && instance.id) || (entry && entry.id) || '').trim();
  const name = String((instance && instance.display_name) || (entry && entry.display_name) || id).trim();
  if (!id && !name) return;
  _connectorsTrackClick('connector_use', { ..._connectorTrackPayload(entry, instance), connector_id: id || name });
  setView('new-chat');
  if (typeof setChatRecipient === 'function') {
    setChatRecipient('new-chat', { kind: 'commander' });
  }
  setChatConnector('new-chat', id || name, name || id);
  setTimeout(() => document.getElementById('new-chat-input')?.focus(), 50);
}

async function _toggleConnectorEnabled(entry, instance, nextEnabled) {
  // Bundle entry: fan out the toggle to every member id; bundle itself isn't an instance.
  const ids = Array.isArray(entry.bundle_member_ids) && entry.bundle_member_ids.length
    ? entry.bundle_member_ids.slice()
    : [(instance && instance.id) || entry.id];
  const payload = {
    ..._connectorTrackPayload(entry, instance),
    enabled: !!nextEnabled,
    instance_count: ids.length,
  };
  const startedAt = performance.now();
  _connectorsTrackClick('connector_enable_toggle', payload);
  try {
    for (const id of ids) {
      const res = await window.orkas.invoke('connectors.set_enabled', { id, enabled: nextEnabled });
      if (!res || !res.ok) {
        _connectorsTrackEvent('connector_enable_result', {
          ...payload,
          result: 'failure',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        uiAlert((res && res.error) || t('component.toggle_failed'));
        return;
      }
    }
    _connectorsTrackEvent('connector_enable_result', {
      ...payload,
      result: 'success',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    await loadConnectors();
  } catch (err) {
    _connectorsTrackEvent('connector_enable_result', {
      ...payload,
      result: 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _connectorsTrackError('connector_enable', {
      ...payload,
      error_type: _connectorTrackErrorType(err),
    });
    uiAlert((err && err.message) || t('component.toggle_failed'));
  }
}

function _entryFromInstance(instance) {
  return {
    id: instance.id,
    display_name: instance.display_name || instance.id,
    description_zh: '',
    description_en: '',
    _custom: instance.origin === 'custom',
  };
}

// One-line server summary for a custom card. Main strips transport secrets and
// sends only a display summary.
function _customTransportSummary(instance) {
  const tr = instance && instance.transport;
  if (!tr) return '';
  if (tr.kind === 'streamable-http' || tr.kind === 'stdio') return tr.summary || '';
  return '';
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
  const payload = {
    ..._connectorTrackPayload(entry, instance),
    instance_count: ids.length,
  };
  const startedAt = performance.now();
  _connectorsTrackClick('connector_disconnect', payload);
  try {
    for (const id of ids) {
      const res = await window.orkas.invoke('connectors.remove', { id });
      if (!res || (!res.ok && !/not found/i.test(res.error || ''))) {
        _connectorsTrackEvent('connector_disconnect_result', {
          ...payload,
          result: 'failure',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        uiAlert((res && res.error) || t('connectors.errors.remove_failed'));
        return;
      }
    }
    _connectorsTrackEvent('connector_disconnect_result', {
      ...payload,
      result: 'success',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    await loadConnectors();
  } catch (err) {
    _connectorsTrackEvent('connector_disconnect_result', {
      ...payload,
      result: 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _connectorsTrackError('connector_disconnect', {
      ...payload,
      error_type: _connectorTrackErrorType(err),
    });
    uiAlert((err && err.message) || t('connectors.errors.remove_failed'));
  }
}

async function _runConnect(entry) {
  if (_isConnectorVisibleDisabled(entry)) {
    _showConnectorUnsupportedToast();
    return;
  }
  const payload = _connectorTrackPayload(entry, null);
  const startedAt = performance.now();
  _connectorsTrackClick('connector_connect', payload);
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
      _connectorsTrackEvent('connector_connect_result', {
        ...payload,
        result: 'success',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      // Refresh state + re-render the grid. The new instance shows up in the connected group.
      await loadConnectors();
    } else if (res && !res.ok) {
      const msg = (res.error || '').toLowerCase();
      const softCancel = msg.includes('superseded') || msg.includes('cancelled');
      _connectorsTrackEvent('connector_connect_result', {
        ...payload,
        result: softCancel ? 'cancelled' : 'failure',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      if (!msg.includes('superseded') && !msg.includes('cancelled')) {
        uiAlert(_formatConnectError(res));
      }
      await loadConnectors();
    }
  } catch (err) {
    const msg = ((err && err.message) || '').toLowerCase();
    const softCancel = msg.includes('superseded') || msg.includes('cancelled');
    _connectorsTrackEvent('connector_connect_result', {
      ...payload,
      result: softCancel ? 'cancelled' : 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    if (!softCancel) {
      _connectorsTrackError('connector_connect', {
        ...payload,
        error_type: _connectorTrackErrorType(err),
      });
    }
    if (!msg.includes('superseded') && !msg.includes('cancelled')) {
      uiAlert(_formatConnectError(err));
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

async function _retryCustomConnect(entry) {
  const payload = _connectorTrackPayload(entry, null);
  const startedAt = performance.now();
  _connectorsTrackClick('connector_custom_retry', payload);
  _connectorsState.connecting.add(entry.id);
  _renderConnectorsGrid();
  try {
    const res = await window.orkas.invoke('connectors.refresh', { id: entry.id });
    if (res && !res.ok) {
      _connectorsTrackEvent('connector_custom_retry_result', {
        ...payload,
        result: 'failure',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      uiAlert(_formatConnectorStatusError(res.error || ''));
    } else {
      _connectorsTrackEvent('connector_custom_retry_result', {
        ...payload,
        result: 'success',
        duration_ms: Math.round(performance.now() - startedAt),
      });
    }
  } catch (err) {
    _connectorsTrackEvent('connector_custom_retry_result', {
      ...payload,
      result: 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _connectorsTrackError('connector_custom_retry', {
      ...payload,
      error_type: _connectorTrackErrorType(err),
    });
    uiAlert(_formatConnectorStatusError((err && err.message) || ''));
  } finally {
    _connectorsState.connecting.delete(entry.id);
    await loadConnectors();
  }
}

// "KEY: value" per line → object. Returns null on a malformed line so the
// dialog can refuse submission instead of silently dropping the line.
function _parseHeaderLines(text) {
  const out = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) return null;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

// "KEY=value" per line → object. Same null-on-malformed contract.
function _parseEnvLines(text) {
  const out = {};
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) return null;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

// Add-custom-MCP-server dialog. The form IS the consent surface (plan §C3):
// for stdio the user types the exact command that will run on their machine,
// and the warning line states that plainly. Submission funnels into the
// single validated IPC route `connectors.add_custom`.
function _openAddCustomDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay ui-dialog-overlay open';
  overlay.innerHTML = `
    <div class="modal ui-dialog connector-custom-dialog" role="dialog" aria-modal="true">
      <div class="ui-dialog-title">${escapeHtml(t('connectors.custom.title'))}</div>
      <div class="form-row">
        <label>${escapeHtml(t('connectors.custom.name_label'))}</label>
        <input type="text" data-f="name" maxlength="64" />
      </div>
      <div class="form-row">
        <label>${escapeHtml(t('connectors.custom.kind_label'))}</label>
        <select data-f="kind">
          <option value="streamable-http">${escapeHtml(t('connectors.custom.kind_http'))}</option>
          <option value="stdio">${escapeHtml(t('connectors.custom.kind_stdio'))}</option>
        </select>
      </div>
      <div data-sec="http">
        <div class="form-row">
          <label>${escapeHtml(t('connectors.custom.url_label'))}</label>
          <input type="text" data-f="url" placeholder="https://example.com/mcp" />
        </div>
        <div class="form-row">
          <label>${escapeHtml(t('connectors.custom.headers_label'))}</label>
          <textarea data-f="headers" rows="2" placeholder="Authorization: Bearer ..."></textarea>
        </div>
      </div>
      <div data-sec="stdio" style="display:none">
        <div class="form-row">
          <label>${escapeHtml(t('connectors.custom.command_label'))}</label>
          <input type="text" data-f="command" placeholder="npx" />
        </div>
        <div class="form-row">
          <label>${escapeHtml(t('connectors.custom.args_label'))}</label>
          <textarea data-f="args" rows="2" placeholder="-y&#10;@scope/mcp-server"></textarea>
        </div>
        <div class="form-row">
          <label>${escapeHtml(t('connectors.custom.env_label'))}</label>
          <textarea data-f="env" rows="2" placeholder="API_KEY=..."></textarea>
        </div>
        <div class="muted connector-custom-warning">${escapeHtml(t('connectors.custom.stdio_warning'))}</div>
      </div>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">${escapeHtml(t('common.cancel'))}</button>
        <button class="btn btn-primary" data-act="ok">${escapeHtml(t('connectors.custom.submit'))}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const f = (name) => overlay.querySelector(`[data-f="${name}"]`);
  const secHttp = overlay.querySelector('[data-sec="http"]');
  const secStdio = overlay.querySelector('[data-sec="stdio"]');
  f('kind').addEventListener('change', () => {
    const stdio = f('kind').value === 'stdio';
    secHttp.style.display = stdio ? 'none' : '';
    secStdio.style.display = stdio ? '' : 'none';
  });

  const close = () => { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
  const onKey = (ev) => {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (ev.key === 'Escape') close();
  };
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', close);

  const okBtn = overlay.querySelector('[data-act="ok"]');
  okBtn.addEventListener('click', async () => {
    const kind = f('kind').value;
    let transport;
    if (kind === 'stdio') {
      const env = _parseEnvLines(f('env').value);
      if (env === null) { uiAlert(t('connectors.custom.bad_env')); return; }
      transport = {
        kind: 'stdio',
        command: f('command').value.trim(),
        args: f('args').value.split('\n').map((s) => s.trim()).filter(Boolean),
        env,
      };
    } else {
      const headers = _parseHeaderLines(f('headers').value);
      if (headers === null) { uiAlert(t('connectors.custom.bad_headers')); return; }
      transport = { kind: 'streamable-http', url: f('url').value.trim(), headers };
    }
    okBtn.disabled = true;
    okBtn.textContent = t('connectors.action.connecting');
    const payload = { transport_kind: kind };
    const startedAt = performance.now();
    _connectorsTrackClick('connector_custom_add', payload);
    try {
      const res = await window.orkas.invoke('connectors.add_custom', {
        display_name: f('name').value.trim(),
        transport,
      });
      if (res && res.ok && res.instance) {
        _connectorsTrackEvent('connector_custom_add_result', {
          ...payload,
          result: 'success',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        close();
        const st = res.instance.status || {};
        if (st.kind === 'connected') {
          if (typeof uiToast === 'function') uiToast(t('connectors.custom.added'), { variant: 'success' });
        } else if (st.kind === 'error') {
          uiAlert(`${t('connectors.status.error')}: ${_formatConnectorStatusError(st.message)}`);
        }
        await loadConnectors();
      } else {
        _connectorsTrackEvent('connector_custom_add_result', {
          ...payload,
          result: 'failure',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        uiAlert((res && res.error) || t('connectors.errors.connect_failed'));
      }
    } catch (err) {
      _connectorsTrackEvent('connector_custom_add_result', {
        ...payload,
        result: 'failure',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      _connectorsTrackError('connector_custom_add', {
        ...payload,
        error_type: _connectorTrackErrorType(err),
      });
      uiAlert((err && err.message) || t('connectors.errors.connect_failed'));
    } finally {
      okBtn.disabled = false;
      okBtn.textContent = t('connectors.custom.submit');
    }
  });
  setTimeout(() => f('name').focus(), 0);
}

function _formatConnectError(errLike) {
  const code = errLike && errLike.code;
  const msg = (errLike && (errLike.error || errLike.message)) || '';
  if (code === 'connector_unsupported' || /connector_unsupported/i.test(String(msg))) {
    return t('connectors.toast.unsupported');
  }
  if (code === 'missing_required_scopes' || /missing_required_scopes|missing required scopes/i.test(String(msg))) {
    return t('connectors.errors.missing_required_scopes');
  }
  if (/fetch failed|network|timeout|timed out|econnreset|econnrefused|eai_again|enotfound/i.test(String(msg))) {
    return _connectorErrorFallback('network');
  }
  return msg || t('connectors.errors.connect_failed');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;',
  })[c]);
}

window.addEventListener('i18n-change', () => {
  if (currentView === 'connectors') _renderConnectorsGrid();
});

// Refresh the grid when a connector or client-config push arrives. Right now the
// only consumer is the connectors panel itself, but registering at module load lets future
// background events (token expiry notifications etc.) refresh the panel automatically.
if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
  try {
    window.orkas.onPushEvent('connectors:changed', () => {
      if (currentView === 'connectors') loadConnectors();
    });
    window.orkas.onPushEvent('client-config:changed', () => {
      if (currentView === 'connectors') loadConnectors();
    });
    // Commander-driven custom MCP install: the agent calls add_custom_connector,
    // main pushes the confirm request, the user must approve here before it
    // installs (the stdio command / http url is shown verbatim — the consent
    // surface). Queue FIFO so concurrent installs don't stack dialogs.
    window.orkas.onPushEvent('connectors:install-confirm', (info) => {
      if (!info || typeof info.request_id !== 'string') return;
      _connectorInstallQueue.push(info);
      _drainConnectorInstallQueue();
    });
  } catch (_err) { /* event not supported; harmless */ }
}

const _connectorInstallQueue = [];
let _connectorInstallDialogOpen = false;

async function _drainConnectorInstallQueue() {
  if (_connectorInstallDialogOpen) return;
  _connectorInstallDialogOpen = true;
  try {
    while (_connectorInstallQueue.length) {
      const info = _connectorInstallQueue.shift();
      const warn = info.kind === 'stdio' ? `\n\n${t('connectors.install_confirm.stdio_warning')}` : '';
      const ok = await uiConfirm({
        message: `${t('connectors.install_confirm.message', { name: info.display_name })}\n\n${info.summary}${warn}`,
        okLabel: t('connectors.install_confirm.approve'),
        cancelLabel: t('connectors.install_confirm.decline'),
      });
      try {
        _connectorsTrackClick('connector_install_confirm_response', {
          approved: !!ok,
          transport_kind: info.kind || '',
        });
        await window.orkas.invoke('connectors.install_confirm_response', {
          request_id: info.request_id,
          approved: !!ok,
        });
        if (ok && currentView === 'connectors') loadConnectors();
      } catch (err) {
        _connectorsLog.warn('install confirm response failed', { error: err && err.message });
      }
    }
  } finally {
    _connectorInstallDialogOpen = false;
  }
}
