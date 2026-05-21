// ─── Marketplace overlay ───
// Browse + install official agents / skills from the Orkas Server. Entered via the "More"
// button on the agents / skills tabs (#agents-more-btn / #skills-more-btn — wired in state.js).
// Per-card 安装 button materializes the item into the local `data/builtin/{agents,skills}/`
// tree with a `_marketplace.json` sentinel so the startup hash-sync leaves it alone.
//
// Dev-only upload (`openMarketplaceUpload`) is exposed for agents.js / skills.js to wire into
// their per-row ⋯ menus on custom items. Visibility of that menu item is gated by
// `app.isDevEnv` (main returns the runtime flag); the upload IPC handler in `dev_handlers.ts`
// also enforces the gate as deep defense.

let _mpOverlay = null;
let _mpState = null;

const MP_PAGE_SIZE = 100;

function isMarketplaceOpen() { return !!_mpOverlay; }

async function openMarketplace(initialTab = 'agent') {
  if (_mpOverlay) {
    _mpState.tab = initialTab;
    _mpRender();
    return;
  }
  _mpState = {
    tab: initialTab === 'skill' ? 'skill' : 'agent',
    category: '',
    q: '',
    agents: [],
    skills: [],
    categories: [],
    installedAgentIds: new Set(),
    installedSkillIds: new Set(),
    loading: true,
    installing: new Set(),  // ids currently being installed (button shows spinner state)
    error: '',
  };
  _mpOverlay = _mpBuildOverlay();
  document.body.appendChild(_mpOverlay);
  window.addEventListener('i18n-change', _mpOnI18n);
  await _mpLoadAll();
  _mpRender();
}

function closeMarketplace() {
  if (!_mpOverlay) return;
  window.removeEventListener('i18n-change', _mpOnI18n);
  _mpOverlay.remove();
  _mpOverlay = null;
  _mpState = null;
}

function _mpOnI18n() { if (_mpOverlay) _mpRender(); }

function _mpBuildOverlay() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay marketplace-overlay open';
  overlay.innerHTML = `
    <div class="modal marketplace-modal" role="dialog" aria-modal="true">
      <div class="marketplace-header">
        <div class="marketplace-tabs">
          <button type="button" class="marketplace-tab" data-mp-tab="agent"></button>
          <button type="button" class="marketplace-tab" data-mp-tab="skill"></button>
        </div>
        <input type="text" class="marketplace-search" data-mp-search />
        <button type="button" class="btn btn-sm marketplace-close" data-mp-close></button>
      </div>
      <div class="marketplace-categories" data-mp-categories></div>
      <div class="marketplace-body" data-mp-body></div>
    </div>
  `;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMarketplace(); });
  overlay.querySelector('[data-mp-close]').addEventListener('click', closeMarketplace);
  overlay.querySelectorAll('[data-mp-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _mpState.tab = btn.dataset.mpTab;
      _mpState.category = '';
      _mpRender();
    });
  });
  const search = overlay.querySelector('[data-mp-search]');
  search.addEventListener('keydown', (e) => {
    // IME guard (CLAUDE.md §8) — Enter while composing must commit the candidate, not search.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') {
      _mpState.q = search.value.trim();
      _mpLoadListings().then(_mpRender);
    } else if (e.key === 'Escape') {
      closeMarketplace();
    }
  });
  // Esc anywhere closes.
  document.addEventListener('keydown', _mpKey, true);
  return overlay;
}

function _mpKey(e) {
  if (e.key === 'Escape' && _mpOverlay && !e.defaultPrevented) {
    // Don't swallow Esc when focus is in an IME composition.
    if (e.isComposing || e.keyCode === 229) return;
    closeMarketplace();
  }
}

async function _mpLoadAll() {
  _mpState.loading = true;
  _mpState.error = '';
  try {
    const [cats, instAgents, instSkills] = await Promise.all([
      window.orkas.invoke('marketplace.categories', {}),
      window.orkas.invoke('agents.list'),
      window.orkas.invoke('skills.list'),
    ]);
    _mpState.categories = (cats && cats.list) || [];
    _mpState.installedAgentIds = new Set(((instAgents && instAgents.agents) || []).map((a) => a.agent_id));
    _mpState.installedSkillIds = new Set(((instSkills && instSkills.skills) || []).map((s) => s.id));
    await _mpLoadListings();
  } catch (err) {
    _mpState.error = (err && err.message) || String(err);
  } finally {
    _mpState.loading = false;
  }
}

async function _mpLoadListings() {
  try {
    const [agents, skills] = await Promise.all([
      window.orkas.invoke('marketplace.listAgents', {
        category: _mpState.category || null,
        q: _mpState.q || null,
        page: 1,
        size: MP_PAGE_SIZE,
      }),
      window.orkas.invoke('marketplace.listSkills', {
        category: _mpState.category || null,
        q: _mpState.q || null,
        page: 1,
        size: MP_PAGE_SIZE,
      }),
    ]);
    _mpState.agents = (agents && agents.list) || [];
    _mpState.skills = (skills && skills.list) || [];
  } catch (err) {
    _mpState.error = (err && err.message) || String(err);
  }
}

function _mpRender() {
  if (!_mpOverlay || !_mpState) return;
  const lang = getLang();

  // Tab labels
  for (const btn of _mpOverlay.querySelectorAll('[data-mp-tab]')) {
    btn.textContent = btn.dataset.mpTab === 'agent' ? t('marketplace.tab_agent') : t('marketplace.tab_skill');
    btn.classList.toggle('is-active', btn.dataset.mpTab === _mpState.tab);
  }
  _mpOverlay.querySelector('[data-mp-search]').setAttribute('placeholder', t('marketplace.search_ph'));
  _mpOverlay.querySelector('[data-mp-close]').textContent = t('marketplace.close');

  // Category chips — filter to those relevant for the active tab.
  const cats = _mpState.categories.filter((c) =>
    c.kind === 'both' || c.kind === _mpState.tab,
  );
  const chips = [
    `<button type="button" class="marketplace-chip${_mpState.category === '' ? ' is-active' : ''}" data-mp-cat="">${escapeHtml(t('marketplace.all'))}</button>`,
    ...cats.map((c) => {
      const label = lang === 'zh' ? (c.name_zh || c.name_en || c.code) : (c.name_en || c.name_zh || c.code);
      const active = _mpState.category === c.code ? ' is-active' : '';
      return `<button type="button" class="marketplace-chip${active}" data-mp-cat="${escapeHtml(c.code)}">${escapeHtml(label)}</button>`;
    }),
  ].join('');
  const catsEl = _mpOverlay.querySelector('[data-mp-categories]');
  catsEl.innerHTML = chips;
  catsEl.querySelectorAll('[data-mp-cat]').forEach((btn) => {
    btn.addEventListener('click', () => {
      _mpState.category = btn.dataset.mpCat || '';
      _mpLoadListings().then(_mpRender);
    });
  });

  // Body
  const body = _mpOverlay.querySelector('[data-mp-body]');
  if (_mpState.loading) {
    body.innerHTML = `<div class="empty">${escapeHtml(t('common.loading') === 'common.loading' ? '…' : t('common.loading'))}</div>`;
    return;
  }
  if (_mpState.error) {
    body.innerHTML = `<div class="empty">${escapeHtml(t('marketplace.load_failed'))}: ${escapeHtml(_mpState.error)}</div>`;
    return;
  }

  const items = (_mpState.tab === 'agent' ? _mpState.agents : _mpState.skills).slice();
  items.sort((a, b) => (a.name || a.id || '').localeCompare(b.name || b.id || '', undefined, { sensitivity: 'base', numeric: true }));
  if (items.length === 0) {
    body.innerHTML = `<div class="empty">${escapeHtml(t('marketplace.empty'))}</div>`;
    return;
  }

  body.innerHTML = `<div class="marketplace-grid">${items.map((it) => _mpCardHtml(it, lang)).join('')}</div>`;
  body.querySelectorAll('[data-mp-install]').forEach((btn) => {
    btn.addEventListener('click', () => _mpInstall(btn.dataset.mpInstall, btn.dataset.mpId));
  });
}

function _mpCardHtml(item, lang) {
  const kind = _mpState.tab;
  const installed = (kind === 'agent' ? _mpState.installedAgentIds : _mpState.installedSkillIds).has(item.id);
  const installing = _mpState.installing.has(`${kind}:${item.id}`);
  const desc = pickDesc(item, lang) || '';
  const catLabel = _mpCategoryLabel(item.category, lang);
  const versionLabel = t('marketplace.version').replace('{version}', String(item.version || ''));
  const avatar = kind === 'agent'
    ? renderAvatarHtml(item.icon, item.color, { size: 32, seed: item.id, extraClass: 'marketplace-card-avatar' })
    : '';
  let btnClass = 'btn btn-sm btn-primary';
  let btnLabel = t('marketplace.install');
  let btnAttrs = `data-mp-install="${escapeHtml(kind)}" data-mp-id="${escapeHtml(item.id)}"`;
  if (installed) { btnClass = 'btn btn-sm is-disabled'; btnLabel = t('marketplace.installed'); btnAttrs = 'disabled'; }
  else if (installing) { btnClass = 'btn btn-sm is-disabled'; btnLabel = t('marketplace.installing'); btnAttrs = 'disabled'; }
  return `
    <div class="marketplace-card" data-id="${escapeHtml(item.id)}">
      <div class="marketplace-card-header">
        ${avatar}
        <span class="marketplace-card-name">${escapeHtml(item.name || item.id)}</span>
      </div>
      <div class="marketplace-card-desc">${escapeHtml(desc)}</div>
      <div class="marketplace-card-meta">
        <span class="marketplace-card-chip">${escapeHtml(catLabel)}</span>
        <span class="marketplace-card-chip muted">${escapeHtml(versionLabel)}</span>
      </div>
      <div class="marketplace-card-actions">
        <button type="button" class="${btnClass}" ${btnAttrs}>${escapeHtml(btnLabel)}</button>
      </div>
    </div>
  `;
}

function _mpCategoryLabel(code, lang) {
  const c = _mpState.categories.find((x) => x.code === code);
  if (!c) return code || '';
  return lang === 'zh' ? (c.name_zh || c.name_en || code) : (c.name_en || c.name_zh || code);
}

async function _mpInstall(kind, id) {
  const key = `${kind}:${id}`;
  if (_mpState.installing.has(key)) return;
  _mpState.installing.add(key);
  _mpRender();
  try {
    const channel = kind === 'agent' ? 'marketplace.installAgent' : 'marketplace.installSkill';
    const r = await window.orkas.invoke(channel, { id });
    if (!r || r.ok === false) throw new Error((r && r.error) || 'install failed');
    if (kind === 'agent') _mpState.installedAgentIds.add(id);
    else _mpState.installedSkillIds.add(id);
    // Refresh the underlying agents / skills tab so the installed item appears under Built-in.
    if (typeof loadAgents === 'function' && kind === 'agent') await loadAgents(true);
    if (typeof loadSkills === 'function' && kind === 'skill') await loadSkills(true);
    uiAlert(t('marketplace.install_ok'));
  } catch (err) {
    const msg = (err && err.message) || String(err);
    uiAlert(t('marketplace.install_failed').replace('{reason}', msg));
  } finally {
    _mpState.installing.delete(key);
    _mpRender();
  }
}

// ─── Upload dialog (dev only) ─────────────────────────────────────────────
// Callable from agents.js / skills.js per-row menus. Caller passes the custom item's id +
// kind ('agent' | 'skill'); we show a small dialog (category + version) and POST to the dev
// upload endpoint. Visibility of the menu item that calls us is gated by app.isDevEnv in
// agents.js / skills.js; this function ALSO refuses if isDevEnv is false (deep defense).
async function openMarketplaceUpload(kind, id) {
  if (!isDevMode()) { uiAlert(t('marketplace.err_not_dev')); return; }
  if (kind !== 'agent' && kind !== 'skill') return;

  // Need the categories list for the dropdown.
  let categories = [];
  try {
    const r = await window.orkas.invoke('marketplace.categories', {});
    categories = ((r && r.list) || []).filter((c) => c.kind === 'both' || c.kind === kind);
  } catch (err) {
    uiAlert(t('marketplace.load_failed') + ': ' + ((err && err.message) || err));
    return;
  }
  if (categories.length === 0) { uiAlert(t('marketplace.load_failed')); return; }

  const lang = getLang();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay ui-dialog-overlay open';
  overlay.innerHTML = `
    <div class="modal ui-dialog" role="dialog" aria-modal="true">
      <div class="ui-dialog-title">${escapeHtml(t('marketplace.upload_title'))}</div>
      <div class="ui-dialog-form">
        <label class="ui-dialog-label">${escapeHtml(t('marketplace.upload_category'))}</label>
        <div data-mp-upload-category></div>
        <label class="ui-dialog-label">${escapeHtml(t('marketplace.upload_version'))}</label>
        <input type="text" class="ui-dialog-input" data-mp-upload-version value="1.0.0" />
      </div>
      <div class="modal-actions">
        <button class="btn" data-act="cancel">${escapeHtml(t('common.cancel') !== 'common.cancel' ? t('common.cancel') : 'Cancel')}</button>
        <button class="btn btn-primary" data-act="ok">${escapeHtml(t('marketplace.upload_submit'))}</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const catEl = overlay.querySelector('[data-mp-upload-category]');
  const select = _aiSelectMount(catEl, {
    options: categories.map((c) => ({
      value: c.code,
      label: lang === 'zh' ? (c.name_zh || c.name_en || c.code) : (c.name_en || c.name_zh || c.code),
    })),
    value: categories[0].code,
    onChange: () => {},
  });
  const versionEl = overlay.querySelector('[data-mp-upload-version]');
  versionEl.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') finish(false);
  });

  const finish = (val) => { overlay.remove(); resolve(val); };
  let resolve;
  const decision = new Promise((r) => { resolve = r; });
  overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
  overlay.querySelector('[data-act="ok"]').addEventListener('click', () => finish(true));
  overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });

  const ok = await decision;
  if (!ok) return;

  const category = catEl.dataset.value || categories[0].code;
  const version = (versionEl.value || '').trim() || '1.0.0';
  try {
    const channel = kind === 'agent' ? 'marketplace.uploadAgent' : 'marketplace.uploadSkill';
    const payload = kind === 'agent' ? { agent_id: id, category, version } : { id, category, version };
    const r = await window.orkas.invoke(channel, payload);
    if (!r || r.ok === false) throw new Error((r && r.error) || 'upload failed');
    uiAlert(t('marketplace.upload_ok'));
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (msg === 'E_NOT_DEV') uiAlert(t('marketplace.err_not_dev'));
    else if (/50001|50002|未登录|登录态失效/.test(msg)) uiAlert(t('marketplace.err_no_permission'));
    else uiAlert(t('marketplace.upload_failed').replace('{reason}', msg));
  }
}
