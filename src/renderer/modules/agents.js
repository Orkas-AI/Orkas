const _agentsLog = createLogger('agents');
// ─── Agents (three-column: list / detail / inline edit chat) ───

let _agentsCache = null;
let _selectedAgent = null; // { id, name, source }
let _agentEditing = false;
let _agentFieldSaveTimer = null;

function _agentUiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className);
  }
  return '';
}

// Mirror of `agents.ts::RESERVED_AGENT_NAMES` so the renderer can fail fast
// without a round-trip. Server is still authoritative — this is just UX.
const _RESERVED_AGENT_NAMES = new Set(['指挥官', '总指挥', 'コマンダー', '司令官', 'commander']);
/** Look up the localized "External · <Brand>" label for an agent runtime
 *  type. The external badge (formerly "CLI · X") is the single
 *  user-facing tag for cli-runtime agents — name surfaces consistently
 *  in cards, detail page, and edit form. */
function _cliBadgeLabel(type) {
  const key = 'agent.external_badge.' + type;
  const v = t(key);
  if (!v || v === key) {
    const externalWord = t('agent.external_word');
    const word = (externalWord && externalWord !== 'agent.external_word') ? externalWord : 'External';
    return word + ' · ' + type;
  }
  return v;
}

function _isReservedAgentName(name) {
  const key = String(name || '').replace(/\s+/g, '').toLowerCase();
  return _RESERVED_AGENT_NAMES.has(key);
}

function _agentSource(source) {
  return (typeof normalizeCatalogSource === 'function')
    ? normalizeCatalogSource(source)
    : String(source || '');
}

function _isAgentPlatformSource(source) {
  return (typeof isMarketplaceCatalogSource === 'function')
    ? isMarketplaceCatalogSource(source)
    : _agentSource(source) === 'marketplace';
}

/** Version + category chips for a marketplace-installed agent. Mirrors the
 *  marketplace card footer so users see the same metadata in the agents grid.
 *  `_mpCategoriesCache` is a module-level variable in `marketplace.js` (flat top-level
 *  scope per CLAUDE.md §8). */
function _agentPlatformChipsHtml(a) {
  const lang = getLang();
  const parts = [];
  if (a.version) {
    const versionLabel = t('marketplace.version').replace('{version}', String(a.version));
    parts.push(`<span class="agent-card-chip is-version">${escapeHtml(versionLabel)}</span>`);
  }
  if (a.category) {
    const catLabel = _resolveCategoryLabel(a.category, lang);
    parts.push(`<span class="agent-card-chip">${escapeHtml(catLabel)}</span>`);
  }
  const reviewStatus = a.status || a.state;
  if (reviewStatus && typeof _mpReviewStatusLabel === 'function') {
    parts.push(`<span class="agent-card-chip is-status">${escapeHtml(_mpReviewStatusLabel(reviewStatus))}</span>`);
  }
  return parts.join('');
}

/** Shared category-code → localized label. Unknown codes stay hidden behind a user-facing
 *  fallback while marketplace.js schedules a throttled registry refresh. */
function _resolveCategoryLabel(code, lang) {
  if (!code) return '';
  if (typeof _mpMaybeRefreshCategoriesForCodes === 'function') {
    _mpMaybeRefreshCategoriesForCodes([code]);
  }
  const canonical = typeof _mpCanonicalCategoryCode === 'function' ? _mpCanonicalCategoryCode(code) : String(code || '').trim();
  const list = (typeof _mpCategoriesCache !== 'undefined' && _mpCategoriesCache) || [];
  const c = list.find((x) => {
    const xCode = typeof _mpCanonicalCategoryCode === 'function' ? _mpCanonicalCategoryCode(x && x.code) : String(x && x.code || '').trim();
    return xCode === canonical;
  });
  if (!c) return typeof _mpUnknownCategoryLabel === 'function' ? _mpUnknownCategoryLabel() : 'Unknown';
  return pickLocalizedName(c, lang) || code;
}

async function _detailCategoryOptions() {
  let list = [];
  try {
    if (typeof _mpCategoriesCache !== 'undefined' && Array.isArray(_mpCategoriesCache) && _mpCategoriesCache.length) {
      list = _mpCategoriesCache;
    }
  } catch (_) { /* ignore */ }
  if (!list.length && window.orkas && typeof window.orkas.invoke === 'function') {
    try {
      const r = await window.orkas.invoke('marketplace.categories', { local_only: true });
      if (Array.isArray(r && r.list)) list = r.list;
    } catch (_) { /* fallback below */ }
  }
  const lang = (typeof getLang === 'function') ? getLang() : 'zh';
  const seen = new Set();
  const options = [];
  for (const c of list) {
    const code = String(c && c.code || '').trim();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    options.push({ value: code, label: pickLocalizedName(c, lang) || code });
  }
  if (!seen.has('general')) options.unshift({ value: 'general', label: _resolveCategoryLabel('general', lang) || 'General' });
  return options;
}

async function _mountDetailCategorySelect(slot, {
  value,
  onChange,
}) {
  if (!slot) return null;
  slot.innerHTML = '';
  const options = await _detailCategoryOptions();
  const current = String(value || 'general').trim() || 'general';
  const api = _aiSelectMount(slot, {
    options,
    value: options.some((o) => o.value === current) ? current : 'general',
    onChange,
  });
  return api;
}


// Mirror of `agents.ts::NAME_TOKEN_RE` so the form rejects junk before
// the round-trip. Charset must round-trip through the bus's @-mention
// regex; see backend for the full reasoning. UIs may still surface
// server errors (E_AGENT_NAME_INVALID / E_AGENT_NAME_TOO_LONG) when
// the LLM-driven path produces a bad name.
const _NAME_TOKEN_RE = /^[A-Za-z0-9_一-鿿-]+$/;
function _isValidAgentNameCharset(name) {
  const v = String(name || '');
  const trimmed = v.trim();
  if (!trimmed) return true;
  if (v !== trimmed) return false;
  if (typeof window.nameDisplayWidth === 'function' && window.nameDisplayWidth(trimmed) > window.NAME_DISPLAY_MAX_UNITS) return false;
  return _NAME_TOKEN_RE.test(trimmed);
}

async function loadAgents(forceRefresh) {
  if (_agentsCache && !forceRefresh) { renderAgentsList(_agentsCache); return; }
  try {
    const res = await apiFetch(forceRefresh ? '/api/agents/list?force=1' : '/api/agents/list');
    const data = await res.json();
    if (data.ok) {
      // Sort once on cache fill so picker + grid share the order.
      // Order: custom group first, then within each group sort by a key
      // built from "Chinese chars → pinyin first letter, Latin / digits
      // / punctuation pass through unchanged" and compare as a plain
      // string. Electron ships small ICU; Intl.Collator does not
      // recognize zh pinyin tailoring (neither co-pinyin nor
      // zh-Hans-CN works), so Chinese ends up clumped together and
      // Latin clumped together. We use vendor/pinyin-firstletter's
      // table to map e.g. '悲观' → 'bg' / 'Claude' → 'claude' /
      // 'Orkas' → 'orkas' before comparing, yielding the user-expected
      // mixed-script ordering ('agent < 悲(b) < 本(b) < claude < 乐(l)
      // < orkas < 全(q)'). Without this, the backend's listAgents
      // internal sort (by agent_id, a 12-char nanoid) feels random to
      // users. The override here fixes that.
      _agentsCache = (data.agents || []).map((a) => ({
        ...a,
        source: _agentSource(a.source),
      })).sort((a, b) => {
        if (a.source !== b.source) return a.source === 'custom' ? -1 : 1;
        const ka = pinyinSortKey(a.name || a.agent_id || '');
        const kb = pinyinSortKey(b.name || b.agent_id || '');
        return ka < kb ? -1 : ka > kb ? 1 : 0;
      });
      renderAgentsList(_agentsCache);
      // Sidebar conv-row badges read agent icon+color from `_agentsCache`
      // (via `_renderConvAgentStackHtml`). Boot order is loadConversations
      // → loadAgents, so the first sidebar render lands before the cache
      // is populated and the badges fall back to seed-derived avatars —
      // re-render once the cache exists so they pick up the authored
      // icon. Projects section subscribes to the same render call.
      if (typeof renderConversationList === 'function') renderConversationList();
      if (typeof renderProjectsSection === 'function') renderProjectsSection();
      // Backfill avatars to disk when older specs lack them — derive
      // from the seed for cross-device consistency (the same agent_id
      // produces the same icon/color combination on every machine, so
      // cloud sync won't see two ends writing different values and
      // colliding). Entries that already have icon + color are
      // skipped, so repeated loadAgents calls don't re-write.
      // Asynchronous so it doesn't block rendering — the render layer
      // also seeds an avatar fallback whose value matches what we
      // backfill, so the user sees no visual change.
      _backfillMissingAvatars(_agentsCache).catch((e) => {
        _agentsLog.warn('avatar backfill failed', e);
      });
    }
  } catch (e) {
    _agentsLog.error('load agents failed', e);
  }
}

async function _backfillMissingAvatars(agents) {
  const missing = (agents || []).filter(
    (a) => a.source === 'custom' && (!a.icon || !a.color),
  );
  if (!missing.length) return;
  for (const a of missing) {
    const seedAvatar = avatarFromSeed(a.agent_id);
    const updates = {};
    if (!a.icon) updates.icon = seedAvatar.icon;
    if (!a.color) updates.color = seedAvatar.color;
    try {
      const res = await window.orkas.invoke('agents.update', {
        agent_id: a.agent_id, updates,
      });
      if (res?.ok && res.agent) {
        a.icon = res.agent.icon;
        a.color = res.agent.color;
      }
    } catch (e) {
      // Failure here doesn't matter — the render layer's seed-based
      // fallback still produces the same combination, and the next
      // loadAgents call will retry.
      _agentsLog.warn(`backfill ${a.agent_id} failed`, e);
    }
  }
  _agentsLog.info(`avatar backfill: ${missing.length} agent(s)`);
}

function renderAgentsList(agents) { renderAgentsGrid(agents); }

// Active category-chip selection for the Agents page. Empty string = "All";
// matches `_mpState.category` semantics in marketplace.js. Persists across
// re-renders within a session; defaults to All on each load.
let _agentsActiveCategory = '';

function renderAgentsGrid(agents) {
  const emptyEl = document.getElementById('agents-empty');
  const chipsHost = document.getElementById('agents-categories');
  const gridEl = document.getElementById('agents-grid');
  if (!gridEl) return;

  if (!agents.length) {
    if (chipsHost) chipsHost.innerHTML = '';
    gridEl.classList.remove('is-sectioned');
    gridEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  const useTitle = escapeHtml(t('agents.use_tooltip'));
  const moreTitle = escapeHtml(t('agents.more_actions'));
  const lang = getLang();
  const customChipLabel = t('agents.custom_group');
  const marketplaceGroupLabel = (() => {
    const raw = t('agents.builtin_group');
    return (raw && raw !== 'agents.builtin_group') ? raw : t('agents.source_marketplace');
  })();
  const allLabel = (() => {
    const raw = t('marketplace.all');
    return (raw && raw !== 'marketplace.all') ? raw : 'All';
  })();

  // Build the chip strip from the marketplace category cache + one fallback
  // "Unknown" chip for both missing categories and non-registry category codes.
  // If the active selection no longer matches any agent (rare — agent moved
  // between categories mid-session), fall back to All so the body isn't empty.
  const canonicalCategoryCode = (code) => {
    return typeof _mpCanonicalCategoryCode === 'function'
      ? _mpCanonicalCategoryCode(code)
      : String(code || '').trim();
  };
  const codesPresent = new Set(agents.map((a) => canonicalCategoryCode(a && a.category)));
  const cats = (typeof _mpCategoriesCache !== 'undefined' && _mpCategoriesCache) || [];
  const chipCodes = [];
  const chipCodeSeen = new Set();
  for (const c of cats) {
    const code = canonicalCategoryCode(c && c.code);
    if (!code || !codesPresent.has(code) || chipCodeSeen.has(code)) continue;
    chipCodes.push({ code, label: pickLocalizedName(c, lang) || code });
    chipCodeSeen.add(code);
  }
  const knownCodes = new Set(cats.map((c) => canonicalCategoryCode(c && c.code)).filter(Boolean));
  const unknownCodes = [...codesPresent].filter((c) => c && !knownCodes.has(c)).sort();
  if (unknownCodes.length && typeof _mpMaybeRefreshCategoriesForCodes === 'function') {
    _mpMaybeRefreshCategoriesForCodes(unknownCodes);
  }
  const hasUnknownCategory = codesPresent.has('') || unknownCodes.length > 0;
  if (hasUnknownCategory) {
    chipCodes.push({
      code: '__unknown__',
      label: typeof _mpUnknownCategoryLabel === 'function' ? _mpUnknownCategoryLabel() : 'Unknown',
    });
  }
  if (_agentsActiveCategory === '__uncategorized__') _agentsActiveCategory = '__unknown__';
  if (_agentsActiveCategory && _agentsActiveCategory !== '__unknown__'
      && !chipCodes.some((c) => c.code === _agentsActiveCategory)) {
    _agentsActiveCategory = '';
  }
  if (_agentsActiveCategory === '__unknown__' && !hasUnknownCategory) {
    _agentsActiveCategory = '';
  }

  if (chipsHost) {
    const allActive = _agentsActiveCategory === '' ? ' is-active' : '';
    const chipsHtml = [
      `<button type="button" class="marketplace-chip${allActive}" data-agents-cat="">${escapeHtml(allLabel)}</button>`,
      ...chipCodes.map((c) => {
        const active = _agentsActiveCategory === c.code ? ' is-active' : '';
        return `<button type="button" class="marketplace-chip${active}" data-agents-cat="${escapeHtml(c.code)}">${escapeHtml(c.label)}</button>`;
      }),
    ].join('');
    chipsHost.innerHTML = chipsHtml;
    chipsHost.querySelectorAll('[data-agents-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        _agentsActiveCategory = btn.dataset.agentsCat || '';
        // Only the user re-renders here — backend cache (`_agentsCache`) is
        // unchanged, so we pass it back through the same code path.
        if (_agentsCache) renderAgentsGrid(_agentsCache);
      });
    });
  }

  const filtered = agents.filter((a) => {
    if (_agentsActiveCategory === '') return true;
    if (_agentsActiveCategory === '__unknown__') {
      const code = canonicalCategoryCode(a && a.category);
      return !code || !knownCodes.has(code);
    }
    return canonicalCategoryCode(a && a.category) === _agentsActiveCategory;
  });

  const cardHtml = (a) => {
    const enabled = a.enabled !== false;
    const desc = pickDesc(a, lang).trim();
    const descClass = desc ? 'agent-card-desc' : 'agent-card-desc is-empty';
    const descText = desc || t('agents.placeholder_unset');
    const moreBtn = `<button type="button" class="agent-card-more" data-agent-more title="${moreTitle}" aria-label="${moreTitle}">⋯</button>`;
    const avatarHtml = renderAvatarHtml(a.icon, a.color, { size: 32, seed: a.agent_id, extraClass: 'agent-card-avatar' });
    // CLI brand chip on the bottom row, shared with the play button.
    const cliChip = (a.runtime && a.runtime.kind === 'cli')
      ? `<span class="agent-card-chip is-cli is-cli-${escapeHtml(a.runtime.cli)}">${escapeHtml(_cliBadgeLabel(a.runtime.cli))}</span>`
      : '';
    // Source provenance chips on the bottom row:
    //  - custom → single "Custom" chip (the source-grouping moved out of
    //    the page chrome; the chip is now the only signal of provenance).
    //  - marketplace → version + category chips via _agentPlatformChipsHtml.
    let provenanceChips = '';
    if (a.source === 'custom') {
      provenanceChips = `<span class="agent-card-chip is-custom">${escapeHtml(customChipLabel)}</span>`;
    } else if (_isAgentPlatformSource(a.source)) {
      provenanceChips = _agentPlatformChipsHtml(a);
    }
    return `
      <div class="agent-card${enabled ? '' : ' is-disabled'}" data-id="${escapeHtml(a.agent_id)}" data-source="${escapeHtml(a.source || '')}">
        <div class="agent-card-header">
          ${avatarHtml}
          <span class="agent-card-name">${escapeHtml(a.name || t('agents.unnamed'))}</span>
          ${moreBtn}
        </div>
        <div class="${descClass}">${escapeHtml(descText)}</div>
        <div class="agent-card-actions">
          ${cliChip}${provenanceChips}
          <button type="button" class="agent-card-use" data-agent-use title="${useTitle}" aria-label="${useTitle}" ${enabled ? '' : 'disabled aria-disabled="true" tabindex="-1"'}>
            ${_agentUiIconHtml('play-triangle', 'icon-play')}
          </button>
        </div>
      </div>
    `;
  };

  const groups = { custom: [], marketplace: [] };
  for (const a of filtered) {
    const source = _agentSource(a?.source);
    if (source === 'marketplace') groups.marketplace.push(a);
    else groups.custom.push(a);
  }
  const sectionHtml = (label, list) => {
    if (!list.length) return '';
    return `
      <section class="agents-source-section">
        <div class="agents-source-section-head">
          <span>${escapeHtml(label)}</span>
          <span class="agents-source-section-count">${list.length}</span>
        </div>
        <div class="agents-source-section-grid">
          ${list.map(cardHtml).join('')}
        </div>
      </section>
    `;
  };
  gridEl.classList.add('is-sectioned');
  gridEl.innerHTML = sectionHtml(customChipLabel, groups.custom)
    + sectionHtml(marketplaceGroupLabel, groups.marketplace);

  for (const card of gridEl.querySelectorAll('.agent-card')) {
    const id = card.dataset.id;
    const source = card.dataset.source;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-agent-use]')) {
        e.stopPropagation();
        if (!card.classList.contains('is-disabled')) useAgent(id);
        return;
      }
      if (e.target.closest('[data-agent-more]')) {
        e.stopPropagation();
        _toggleAgentRowMenu(e.target.closest('[data-agent-more]'), id, source);
        return;
      }
      _showAgentsDetailView(id);
    });
  }
}

/** Flip an agent's enabled override (used by both the ⋯ menu's toggle item
 *  and the detail-page enable/disable button). On failure, alerts; on
 *  success, refreshes the grid + detail page. */
async function _flipAgentEnabled(agentId, nextEnabled) {
  try {
    const res = await window.orkas.invoke('agents.setEnabled', { agent_id: agentId, enabled: nextEnabled });
    if (!res || !res.ok) {
      await uiAlert(t('component.toggle_failed'));
      return false;
    }
    const cached = _agentsCache?.find((a) => a.agent_id === agentId);
    if (cached) cached.enabled = nextEnabled;
    await loadAgents(true);
    if (_selectedAgent?.id === agentId) {
      _renderAgentEnabledButton({ id: agentId, enabled: nextEnabled });
    }
    return true;
  } catch (err) {
    await uiAlert(t('component.toggle_failed'));
    return false;
  }
}

// ─── View switching: grid ↔ detail ─────────────────────────────────────

function _showAgentsGridView() {
  const grid = document.getElementById('agents-grid-view');
  const detail = document.getElementById('agents-detail-view');
  if (_agentEditing) {
    // Defer to async cleanup so any pending field save flushes.
    _exitAgentEditMode().catch(() => {});
  }
  if (grid) grid.style.display = 'flex';
  if (detail) detail.style.display = 'none';
  _selectedAgent = null;
  _closeAgentRowMenu();
  const detailContent = document.getElementById('agents-detail-content');
  if (detailContent) detailContent.style.display = 'none';
}

async function _showAgentsDetailView(agentId) {
  const grid = document.getElementById('agents-grid-view');
  const detail = document.getElementById('agents-detail-view');
  if (grid) grid.style.display = 'none';
  if (detail) detail.style.display = 'flex';
  await loadAgents(true);
  await selectAgent(agentId);
}

async function refreshSelectedAgentDetail() {
  if (_agentEditing || !_selectedAgent?.id) return;
  const detail = document.getElementById('agents-detail-view');
  if (!detail || detail.style.display === 'none') return;
  await selectAgent(_selectedAgent.id);
}

// ─── Per-row "⋯" menu (edit / delete) ─────────────────────────────────────

function _positionRowMenu(menuEl, anchorEl) {
  menuEl.style.display = 'block';
  menuEl.style.left = '-9999px';
  menuEl.style.top = '-9999px';
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  // Right-align to the anchor by default; clamp to viewport.
  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  // Below if there's room, otherwise above.
  const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
}

function _closeAgentRowMenu() {
  const menu = document.getElementById('agent-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.agentId;
    delete menu.dataset.anchorTs;
  }
  // Drop the "keep ⋯ visible" sticky class from whichever row had the open menu.
  for (const el of document.querySelectorAll('.agent-item.is-menu-open')) {
    el.classList.remove('is-menu-open');
  }
}

function _toggleAgentRowMenu(anchorBtn, agentId, source = '') {
  const menu = document.getElementById('agent-row-menu');
  if (!menu) return;
  // Toggle off if already open for this same anchor.
  if (menu.style.display !== 'none' && menu.dataset.agentId === agentId) {
    _closeAgentRowMenu();
    return;
  }
  // Reset any prior sticky row before marking the new one.
  for (const el of document.querySelectorAll('.agent-card.is-menu-open')) {
    el.classList.remove('is-menu-open');
  }
  anchorBtn.closest('.agent-card')?.classList.add('is-menu-open');
  menu.dataset.agentId = agentId;
  menu.dataset.agentSource = source || '';
  // Re-render menu items per-open: builtin gets only enable/disable, custom
  // gets edit / delete / enable-disable. Per-row state (enabled?) drives the
  // toggle item label. Done as innerHTML rebuild because there are only
  // ~3 items max and binding cost is negligible.
  _renderAgentRowMenuItems(menu, agentId, source);
  _positionRowMenu(menu, anchorBtn);
  if (!menu.dataset.bound) {
    menu.dataset.bound = '1';
    document.addEventListener('click', (e) => {
      if (menu.style.display === 'none') return;
      if (menu.contains(e.target)) return;
      if (e.target.closest('.agent-card-more')) return;
      _closeAgentRowMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && menu.style.display !== 'none') _closeAgentRowMenu();
    });
    window.addEventListener('scroll', _closeAgentRowMenu, true);
    window.addEventListener('resize', _closeAgentRowMenu);
    window.addEventListener('i18n-change', _closeAgentRowMenu);
  }
}

// Re-render the agent grid + currently selected detail page when the UI
// language changes — descriptions are bilingual now, and `pickDesc`
// returns a different string after the locale flip. Detail re-render goes
// through `selectAgent` so it re-fetches the full agent (the cached
// `_selectedAgent` only holds id/name/source).
window.addEventListener('i18n-change', () => {
  if (_agentsCache) renderAgentsGrid(_agentsCache);
  if (_selectedAgent?.id) {
    selectAgent(_selectedAgent.id).catch(() => { /* ignore */ });
  }
});

async function refreshAgentsAfterMarketplaceReconcile() {
  await loadAgents(true);
  if (_agentEditing) return;
  if (_selectedAgent?.id && _isAgentPlatformSource(_selectedAgent.source)) {
    await selectAgent(_selectedAgent.id);
  }
}

/** Render the per-row "⋯" menu items based on the target agent's source +
 *  enabled state. Called fresh on each open so the toggle label is right
 *  and builtin agents see only the enable/disable item. */
function _renderAgentRowMenuItems(menu, agentId, source = '') {
  const normalizedSource = _agentSource(source);
  const a = _agentsCache?.find((x) => x.agent_id === agentId && (!normalizedSource || _agentSource(x.source) === normalizedSource))
    || _agentsCache?.find((x) => x.agent_id === agentId);
  const enabled = a ? a.enabled !== false : true;
  const isCustom = a?.source === 'custom';
  // Dev mode lifts the source guard for marketplace edit / delete.
  const canEdit = isCustom || (_isAgentPlatformSource(a?.source) && false);
  // Dev-only entry on builtin: tag the label so the user knows this isn't a
  // normal user capability (mirrors marketplace.upload's "(dev)" treatment).
  const editLabelSuffix = (_isAgentPlatformSource(a?.source) && false) ? t('common.dev_suffix') : '';
  const toggleLabel = enabled ? t('component.disable') : t('component.enable');
  const items = [];
  if (canEdit) {
    items.push(`<div class="agent-row-menu-item" data-action="edit">${escapeHtml(t('agents.edit') + editLabelSuffix)}</div>`);
  }
  // Upload-to-marketplace is owned by marketplace_dev.js (renderer-side dev module). OrkasOpen
  // doesn't ship that file, so `typeof openMarketplaceUpload === 'function'` is false there
  // and the menu item simply doesn't appear — no isDevMode check needed (and would be banned
  // by OrkasOpen's strip-rules anyway).
  if (typeof openMarketplaceUpload === 'function') {
    items.push(`<div class="agent-row-menu-item" data-action="upload-marketplace">${escapeHtml(t('marketplace.upload'))}</div>`);
  }
  items.push(`<div class="agent-row-menu-item" data-action="toggle-enabled">${escapeHtml(toggleLabel)}</div>`);
  if (canEdit) {
    items.push(`<div class="agent-row-menu-item is-danger" data-action="delete">${escapeHtml(t('agents.delete'))}</div>`);
  }
  menu.innerHTML = items.join('');
  for (const item of menu.querySelectorAll('.agent-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      const aid = menu.dataset.agentId;
      const source = menu.dataset.agentSource || a?.source || '';
      _closeAgentRowMenu();
      if (!aid) return;
      if (action === 'edit') {
        await _showAgentsDetailView(aid);
        if (!_agentEditing) await toggleAgentEditMode();
      } else if (action === 'delete') {
        if (_selectedAgent?.id !== aid) await selectAgent(aid);
        await deleteSelectedAgent();
      } else if (action === 'upload-marketplace') {
        if (typeof openMarketplaceUpload === 'function') await openMarketplaceUpload('agent', aid, source);
      } else if (action === 'toggle-enabled') {
        await _flipAgentEnabledFromMenu(aid);
      }
    });
  }
}

async function _flipAgentEnabledFromMenu(agentId) {
  const cached = _agentsCache?.find((x) => x.agent_id === agentId);
  const next = !(cached?.enabled !== false);
  await _flipAgentEnabled(agentId, next);
}

async function selectAgent(agentId) {
  // Discard any uncommitted edit state when switching agents.
  if (_agentEditing && _selectedAgent && _selectedAgent.id !== agentId) {
    await _exitAgentEditMode();
  }
  try {
    const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`);
    const data = await res.json();
    if (!data.ok || !data.agent) return;
    data.agent.source = _agentSource(data.agent.source);
    _selectedAgent = { id: data.agent.agent_id, name: data.agent.name, source: data.agent.source };
    _renderAgentDetail(data.agent, false);
    // Reset every nested scroll container — `.agents-detail-content` and
    // `.agents-detail-body` are the outer two, and `.agents-detail-desc` /
    // `.agents-detail-workflow` each have `overflow-y: auto` of their own
    // (style.css:4190). Without resetting the inner two the previous
    // agent's mid-scroll position bleeds into the next agent's view.
    const detailContent = document.getElementById('agents-detail-content');
    if (detailContent) detailContent.scrollTop = 0;
    for (const sel of ['.agents-detail-body', '#agents-detail-desc', '#agents-detail-workflow']) {
      const el = document.querySelector(sel);
      if (el) el.scrollTop = 0;
    }
  } catch (e) {
    _agentsLog.error('load agent failed', e);
  }
}

// Render the header meta strip for a single agent / skill detail. Used by both
// `agents.js::_renderAgentDetail` and `skills.js::useSkill`. Two forms:
//   - custom item: single "自定义" chip (kept for symmetry with prior chrome)
//   - marketplace-installed item: category chip, without author uid / official tags
  // `item.source` distinguishes custom vs marketplace-installed; `item.category` (code) maps
// to display name via `_mpCategoriesCache` (loaded at marketplace boot, hot in localStorage).
function _renderSourceMetaHtml(item) {
  if (!item) return '';
  if (item.source === 'custom') {
    return `<span class="agents-detail-source is-custom">${escapeHtml(t('agents.source_custom'))}</span>`;
  }
  const parts = [];
  if (item.version) {
    const versionLabel = t('marketplace.version').replace('{version}', String(item.version));
    parts.push(`<span class="agents-detail-source is-version">${escapeHtml(versionLabel)}</span>`);
  }
  const catCode = String(item.category || '').trim();
  if (catCode) {
    const lang = (typeof getLang === 'function') ? getLang() : 'zh';
    const label = _resolveCategoryLabel(catCode, lang);
    parts.push(`<span class="agents-detail-source is-category">${escapeHtml(label)}</span>`);
  }
  const reviewStatus = item.status || item.state;
  if (reviewStatus && typeof _mpReviewStatusLabel === 'function') {
    parts.push(`<span class="agents-detail-source is-status">${escapeHtml(_mpReviewStatusLabel(reviewStatus))}</span>`);
  }
  return parts.join('');
}

function _renderAgentDetail(agent, editing) {
  agent = { ...agent, source: _agentSource(agent.source) };
  document.getElementById('agents-detail-content').style.display = '';

  const nameEl = document.getElementById('agents-detail-name');
  const nameInput = document.getElementById('agents-detail-name-input');
  const sourceEl = document.getElementById('agents-detail-source');
  const descEl = document.getElementById('agents-detail-desc');
  const workflowEl = document.getElementById('agents-detail-workflow');
  const editBtn = document.getElementById('agent-edit-btn');

  nameEl.textContent = agent.name || '';
  if (nameInput) nameInput.value = agent.name || '';
  // Header chips: custom = single "自定义" tag; marketplace-installed items show version + category.
  sourceEl.className = 'agents-detail-source-row';
  sourceEl.innerHTML = _renderSourceMetaHtml(agent);
  // Runtime slot lives at the top of the body now (not the header):
  // an always-editable dropdown so the user can flip Orkas ↔ local CLI
  // without entering edit mode. The header chip was removed because
  // it duplicated information the dropdown already exposes.
  _renderAgentDetailRuntime(agent);
  _renderAgentDetailProjectDir(agent);
  const localizedDesc = pickDesc(agent, getLang()).trim();
  descEl.textContent = localizedDesc;

  _renderAgentDetailAvatar(agent);
  _renderAgentDetailCategory(agent);

  // CLI-backed agents have no authored workflow / skill_list — the
  // external CLI brings its own behavior. Hide the entire workflow
  // section so the detail page doesn't show an empty editor block.
  const workflowSection = document.querySelector('.agents-detail-section-workflow');
  const isCliRuntime = !!(agent.runtime && agent.runtime.kind === 'cli');
  if (workflowSection) workflowSection.style.display = isCliRuntime ? 'none' : '';

  const unsetHtml = `<span class="agents-detail-placeholder">${escapeHtml(t('agents.placeholder_unset'))}</span>`;
  // Workflow renders markdown in readonly mode; raw text in edit mode so user
  // can edit source directly.
  if (editing) {
    workflowEl.textContent = agent.workflow || '';
  } else {
    workflowEl.innerHTML = agent.workflow ? renderMarkdownFull(agent.workflow) : unsetHtml;
  }
  if (!editing && !localizedDesc) descEl.innerHTML = unsetHtml;

  // Detail header actions, fixed order:
  //   use (icon) / edit / enable-disable / delete
  // Edit mode hides everything except the "done" button (the relabeled
  // "edit" button).
  const useBtn = document.getElementById('agent-use-btn');
  const enableBtn = document.getElementById('agent-enabled-btn');
  const uploadBtn = document.getElementById('agent-upload-marketplace-btn');
  const delBtn = document.getElementById('agent-delete-btn');
  const isCustom = agent.source === 'custom';
  const canEdit = isCustom || (_isAgentPlatformSource(agent.source) && false);
  if (useBtn) {
    useBtn.style.display = editing ? 'none' : '';
    useBtn.disabled = agent.enabled === false;
    useBtn.setAttribute('aria-disabled', agent.enabled === false ? 'true' : 'false');
  }
  if (enableBtn) enableBtn.style.display = editing ? 'none' : '';
  // Upload button visibility: gated by marketplace_dev.js's presence (OrkasOpen lacks it).
  if (uploadBtn) uploadBtn.style.display = (typeof openMarketplaceUpload === 'function' && !editing) ? '' : 'none';
  if (delBtn) delBtn.style.display = (canEdit && !editing) ? '' : 'none';
  if (editBtn) {
    editBtn.style.display = canEdit ? '' : 'none';
    // Tag the "Edit" label on marketplace agents (dev-only entry); "Done" stays
    // bare because the user is already in edit mode and the marker would be
    // redundant noise.
    const editSuffix = (!editing && _isAgentPlatformSource(agent.source) && false) ? t('common.dev_suffix') : '';
    editBtn.textContent = editing ? t('agents.edit_btn_done') : (t('agents.edit_btn_edit') + editSuffix);
  }
  _renderAgentEnabledButton({ id: agent.agent_id, enabled: agent.enabled !== false });

  _renderAgentOutputFormatSection(agent);

  _toggleAgentFieldEditable(editing);
}

function _renderAgentDetailCategory(agent) {
  const section = document.getElementById('agents-detail-category-section');
  const slot = document.getElementById('agents-detail-category');
  if (!section || !slot) return;
  const isCustom = agent && agent.source === 'custom';
  section.style.display = isCustom ? '' : 'none';
  if (!isCustom) { slot.innerHTML = ''; return; }
  const agentId = agent.agent_id;
  _mountDetailCategorySelect(slot, {
    value: agent.category || 'general',
    onChange: async (category) => {
      try {
        const res = await window.orkas.invoke('agents.update', {
          agent_id: agentId,
          updates: { category: category || 'general' },
        });
        if (!res || res.ok === false || !res.agent) {
          uiAlert((res && res.error) || t('agents.update_failed'));
          return;
        }
        _agentsCache = null;
        await loadAgents(true);
        if (_selectedAgent?.id === agentId) _renderAgentDetail(res.agent, _agentEditing);
      } catch (err) {
        uiAlert((err && err.message) || t('agents.update_failed'));
      }
    },
  }).catch((err) => _agentsLog.warn('render category select failed', err));
}

/** Render the output-format preference dropdown (auto / text /
 *  dashboard / artifact). Always editable (no edit-mode gating — same convention as the
 *  runtime selector); persists via `agents.update({ output_format })`. Hidden
 *  for CLI agents — those run an external coding CLI and ignore the in-process
 *  system-prompt hint entirely.
 *
 *  Legacy on-disk values map for display: `'markdown_only'` → `'text'`,
 *  `'allow_artifacts'` → `'artifact'`; `'auto'` / missing → `'auto'`
 *  (the default). */
function _renderAgentOutputFormatSection(agent) {
  const section = document.getElementById('agents-detail-output-format-section');
  const slot = document.getElementById('agents-detail-output-format');
  if (!section || !slot) return;
  if (agent.runtime?.kind === 'cli') { section.style.display = 'none'; return; }
  section.style.display = '';

  const canEdit = agent.source === 'custom'
    || (_isAgentPlatformSource(agent.source) && typeof isDevMode === 'function' && false);

  slot.innerHTML = '';
  const mount = document.createElement('div');
  mount.className = 'ai-select';
  slot.appendChild(mount);

  const options = [
    { value: 'auto',           label: t('agents.output_format_auto'),          hint: t('agents.output_format_auto_hint') },
    { value: 'text',           label: t('agents.output_format_text'),          hint: t('agents.output_format_text_hint') },
    { value: 'dashboard',      label: t('agents.output_format_dashboard'),     hint: t('agents.output_format_dashboard_hint') },
    { value: 'artifact',       label: t('agents.output_format_artifact'),      hint: t('agents.output_format_artifact_hint') },
  ];
  // Map legacy on-disk values to the current 4-option display.
  let current;
  switch (agent.output_format) {
    case 'auto':                                current = 'auto';          break;
    case 'text':
    case 'markdown_only':                       current = 'text';          break;
    case 'dashboard':                           current = 'dashboard';     break;
    case 'artifact':
    case 'allow_artifacts':                     current = 'artifact';      break;
    default:                                    current = 'auto';          break;
  }

  const api = _aiSelectMount(mount, {
    options,
    value: current,
    onChange: async (val) => {
      try {
        const res = await window.orkas.invoke('agents.update', {
          agent_id: agent.agent_id,
          updates: { output_format: val },
        });
        if (!res || !res.ok) {
          api.setValue(current);
          uiAlert((res && res.error) || t('agents.update_failed'));
        } else if (res.agent) {
          agent.output_format = res.agent.output_format;
          current = val;
        }
      } catch (err) {
        api.setValue(current);
        uiAlert((err && err.message) || t('agents.update_failed'));
      }
    },
  });
  if (!canEdit) {
    // Disable the trigger — read-only display for builtin agents in
    // non-dev mode (mirrors the runtime row pattern).
    const trigger = mount.querySelector('.ai-select-trigger');
    if (trigger) { trigger.setAttribute('disabled', ''); trigger.style.pointerEvents = 'none'; trigger.style.opacity = '0.6'; }
  }
}


/** Render the runtime control in the detail body.
 *
 *  The runtime "kind" is locked at create time:
 *  - `in_process` (Orkas) agents → never show the selector here. The
 *    runtime row stays hidden; user has no need to see it.
 *  - `cli` agents → show a selector with **CLI options only** (no
 *    Orkas / in_process option). User can swap which CLI backs the
 *    agent at any time, but can't revert to Orkas — that would
 *    invalidate the description and inputs which were authored
 *    specifically for a CLI runtime.
 *
 *  Reuses `_aiSelectMount` (see CLAUDE.md "Reuse UI components") and
 *  persists each change via `agents.update({ runtime })`. */
async function _renderAgentDetailRuntime(agent) {
  const section = document.getElementById('agents-detail-runtime-section');
  const slot = document.getElementById('agents-detail-runtime');
  if (!slot || !section) return;
  slot.innerHTML = '';

  // In-process agents: section stays hidden. No selector, no
  // information to surface.
  if (agent.runtime?.kind !== 'cli') {
    section.style.display = 'none';
    return;
  }

  const entries = (typeof loadLocalCliEntries === 'function') ? await loadLocalCliEntries() : [];
  const available = entries.filter(e => e.available);
  const seen = new Set(available.map(e => e.type));
  const currentType = agent.runtime.cli;

  // Build CLI-only options: every detected CLI + the bound one if it's
  // missing (with a warning suffix so the user can flip away in one
  // click). Orkas / in_process is intentionally absent — see fn doc.
  const options = [];
  for (const e of available) {
    options.push({
      value: `cli:${e.type}`,
      label: `${t('agent_modal.runtime_cli_' + e.type)}${e.version ? ` (${e.version})` : ''}`,
    });
  }
  if (!seen.has(currentType)) {
    const baseLabel = t('agent_modal.runtime_cli_' + currentType);
    const labelText = (baseLabel && baseLabel !== 'agent_modal.runtime_cli_' + currentType)
      ? baseLabel : currentType;
    options.push({
      value: `cli:${currentType}`,
      label: labelText,
      hint: t('agent.cli_missing'),
      iconName: 'warning',
    });
  }
  if (options.length === 0) {
    // Defensive — shouldn't happen since we always add the bound CLI
    // above. Hide the row instead of rendering an empty dropdown.
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const mount = document.createElement('div');
  mount.className = 'ai-select agents-detail-runtime-select';
  slot.appendChild(mount);
  _aiSelectMount(mount, {
    options, value: `cli:${currentType}`,
    onChange: async (next) => {
      const m = /^cli:(.+)$/.exec(next);
      if (!m) return;
      const newCli = m[1];
      // Mirror the create-modal behaviour: if the user's current name /
      // description are still the defaults of the previous CLI (or empty),
      // follow the new CLI's defaults. Otherwise, leave their edits alone.
      const updates = { runtime: { kind: 'cli', cli: newCli } };
      const lang = (typeof getLang === 'function') ? getLang() : 'zh';
      const prev = (typeof getCliDefaults === 'function') ? getCliDefaults(currentType) : null;
      const next2 = (typeof getCliDefaults === 'function') ? getCliDefaults(newCli) : null;
      const prevDescLocal = prev ? pickDesc(prev, lang) : '';
      const curName = (agent.name || '').trim();
      const curDescLocal = pickDesc(agent, lang).trim();
      // Same default-like detection as the create modal: bare default OR
      // dedup-style "<default> 2" / "(2)" suffixes count as untouched.
      const nameUntouched = _isDefaultlikeName(curName, prev?.name);
      const descUntouched = !curDescLocal || (prev && curDescLocal === prevDescLocal);
      if (next2 && nameUntouched) updates.name = next2.name;
      if (next2) {
        if (descUntouched) {
          updates.description_zh = next2.description_zh;
          updates.description_en = next2.description_en;
        }
      }
      try {
        const res = await window.orkas.invoke('agents.update', {
          agent_id: agent.agent_id, updates,
        });
        if (res?.ok && res.agent) {
          _agentsCache = null;
          const fetched = await apiFetch(`/api/agents/${encodeURIComponent(agent.agent_id)}`);
          const data = await fetched.json();
          if (data.ok && data.agent) _renderAgentDetail(data.agent, _agentEditing);
        } else if (res?.code === 'E_AGENT_NAME_TAKEN') {
          // Name we tried to auto-apply already belongs to another
          // agent. Re-issue the update without the name override so
          // the runtime swap still goes through.
          const safeUpdates = { ...updates };
          delete safeUpdates.name;
          await window.orkas.invoke('agents.update', {
            agent_id: agent.agent_id, updates: safeUpdates,
          });
          _agentsCache = null;
          const fetched = await apiFetch(`/api/agents/${encodeURIComponent(agent.agent_id)}`);
          const data = await fetched.json();
          if (data.ok && data.agent) _renderAgentDetail(data.agent, _agentEditing);
        }
      } catch (err) {
        _agentsLog.warn('agents.update runtime failed', err);
      }
    },
  });
}

/** Project directory setting for external coding agents (claude / codex).
 *  Stored in a local-only main-process config; each conversation copies
 *  the effective value on its first coding-agent dispatch. */
async function _renderAgentDetailProjectDir(agent) {
  const section = document.getElementById('agents-detail-project-dir-section');
  const slot = document.getElementById('agents-detail-project-dir');
  if (!section || !slot) return;
  const cli = agent.runtime?.kind === 'cli' ? agent.runtime.cli : '';
  const supportsProjectDir = typeof cliIsCodingAgent === 'function' && cliIsCodingAgent(cli);
  if (!supportsProjectDir) {
    section.style.display = 'none';
    slot.innerHTML = '';
    return;
  }
  section.style.display = '';
  slot.dataset.agentId = agent.agent_id;

  const canEdit = agent.source === 'custom'
    || (_isAgentPlatformSource(agent.source) && typeof isDevMode === 'function' && false);

  const renderInfo = (info) => {
    if (_selectedAgent?.id !== agent.agent_id || slot.dataset.agentId !== agent.agent_id) return;
    const mode = info?.mode === 'custom' ? 'custom' : 'workspace';
    const missing = mode === 'custom' && info.exists === false;
    const pathText = String(info?.path || info?.workspace_path || '');
    const badge = mode === 'custom'
      ? t('agents.project_dir_custom')
      : t('agents.project_dir_workspace');
    const status = missing ? t('agents.project_dir_missing') : badge;
    const cardClass = [
      'agent-project-dir-card',
      mode === 'workspace' ? 'is-workspace' : 'is-custom',
      missing ? 'is-missing' : '',
      canEdit ? '' : 'is-disabled',
    ].filter(Boolean).join(' ');
    slot.innerHTML = `
      <div class="${cardClass}">
        ${_agentUiIconHtml(missing ? 'warning' : 'folder-open', 'agent-project-dir-icon')}
        <div class="agent-project-dir-main">
          <div class="agent-project-dir-path" title="${escapeHtml(pathText)}">${escapeHtml(pathText)}</div>
          <div class="agent-project-dir-mode">${escapeHtml(status)}</div>
        </div>
        <div class="agent-project-dir-actions">
          <button type="button" class="btn btn-sm" data-act="pick" ${canEdit ? '' : 'disabled'}>${escapeHtml(t('input.dir.change'))}</button>
          ${mode === 'custom' ? `<button type="button" class="btn btn-sm" data-act="reset" ${canEdit ? '' : 'disabled'}>${escapeHtml(t('agents.project_dir_use_workspace'))}</button>` : ''}
        </div>
      </div>`;
    const pickBtn = slot.querySelector('[data-act="pick"]');
    const resetBtn = slot.querySelector('[data-act="reset"]');
    const pick = async () => {
      if (!canEdit) return;
      try {
        const picked = await window.orkas.invoke('common.pickDirectory', {
          title: t('agents.label_project_dir'),
        });
        if (!picked || picked.cancelled || !picked.path) return;
        const saved = await window.orkas.invoke('agents.cliProjectDir.set', {
          agent_id: agent.agent_id,
          path: picked.path,
        });
        if (!saved || !saved.ok) {
          await uiAlert((saved && saved.error) || t('agents.project_dir_save_failed'));
          return;
        }
        renderInfo(saved.info);
      } catch (err) {
        await uiAlert((err && err.message) || t('agents.project_dir_save_failed'));
      }
    };
    pickBtn?.addEventListener('click', (e) => { e.stopPropagation(); pick(); });
    resetBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!canEdit) return;
      try {
        const saved = await window.orkas.invoke('agents.cliProjectDir.set', {
          agent_id: agent.agent_id,
          path: '',
        });
        if (!saved || !saved.ok) {
          await uiAlert((saved && saved.error) || t('agents.project_dir_save_failed'));
          return;
        }
        renderInfo(saved.info);
      } catch (err) {
        await uiAlert((err && err.message) || t('agents.project_dir_save_failed'));
      }
    });
  };

  slot.innerHTML = `<div class="agent-project-dir-card is-loading">${_agentUiIconHtml('folder-open', 'agent-project-dir-icon')}<div class="agent-project-dir-main"><div class="agent-project-dir-path">${escapeHtml(t('common.loading'))}</div></div></div>`;
  try {
    const res = await window.orkas.invoke('agents.cliProjectDir.get', { agent_id: agent.agent_id });
    if (!res || !res.ok || !res.info) throw new Error(res?.error || 'failed');
    renderInfo(res.info);
  } catch (err) {
    _agentsLog.warn('load agent project dir failed', err);
    slot.innerHTML = `<div class="agents-detail-placeholder">${escapeHtml(t('agents.project_dir_load_failed'))}</div>`;
  }
}

/** Render the detail-page avatar slot. Custom agents get a clickable avatar
 *  that opens the picker; builtin agents just show theirs read-only. Each
 *  picker change is sent as an `agents.update` IPC and the local cache is
 *  refreshed so the card grid reflects the new combo on next render. */
function _renderAgentDetailAvatar(agent) {
  const slot = document.getElementById('agents-detail-avatar');
  if (!slot) return;
  const isCustom = agent.source === 'custom';
  slot.innerHTML = renderAvatarHtml(agent.icon, agent.color, {
    size: 32,
    seed: agent.agent_id,
    clickable: isCustom,
    extraClass: 'agents-detail-avatar',
  });
  if (!isCustom) return;
  const trigger = slot.querySelector('.avatar-circle');
  if (!trigger) return;
  trigger.title = t('avatar.change');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isAvatarPickerOpenFor(trigger)) { closeAvatarPicker(); return; }
    const cur = { icon: agent.icon, color: agent.color };
    openAvatarPicker(trigger, cur, {}, async (next) => {
      // Optimistic in-place update — keeps the trigger element (and its
      // click handler) intact so the picker stays interactive.
      agent.icon = next.icon;
      agent.color = next.color;
      applyAvatarToElement(trigger, next.icon, next.color, agent.agent_id);
      try {
        const res = await window.orkas.invoke('agents.update', {
          agent_id: agent.agent_id,
          updates: { icon: next.icon, color: next.color },
        });
        if (res?.ok && res.agent) {
          const cached = _agentsCache?.find((a) => a.agent_id === agent.agent_id);
          if (cached) { cached.icon = next.icon; cached.color = next.color; }
          if (_agentsCache) renderAgentsGrid(_agentsCache);
        }
      } catch (err) {
        _agentsLog.warn('agents.update avatar failed', err);
      }
    });
  });
}

/** Per-agent enable / disable button in the detail header.
 *  Clone-replace to drop any prior click handler bound to a stale
 *  agent id. The button label flips between "enable" and "disable"
 *  (whichever the click would do). */
function _renderAgentEnabledButton(agent) {
  const oldBtn = document.getElementById('agent-enabled-btn');
  if (!oldBtn) return;
  const enabled = agent.enabled !== false;
  const btn = oldBtn.cloneNode(true);
  oldBtn.parentNode.replaceChild(btn, oldBtn);
  btn.textContent = enabled ? t('component.disable') : t('component.enable');
  btn.title = enabled ? t('component.toggle_disable_hint') : t('component.toggle_enable_hint');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try { await _flipAgentEnabled(agent.id, !enabled); }
    finally { btn.disabled = false; }
  });
}


function _toggleAgentFieldEditable(on) {
  const nameEl = document.getElementById('agents-detail-name');
  const nameInput = document.getElementById('agents-detail-name-input');
  const descEl = document.getElementById('agents-detail-desc');
  const workflowEl = document.getElementById('agents-detail-workflow');
  if (nameEl) {
    nameEl.setAttribute('contenteditable', 'false');
    nameEl.classList.remove('is-editing');
    nameEl.hidden = !!on;
  }
  if (nameInput) {
    nameInput.hidden = !on;
    nameInput.classList.toggle('is-editing', on);
    nameInput.readOnly = !on;
    nameInput.setAttribute('aria-label', t('agent_modal.name'));
  }
  for (const el of [descEl, workflowEl]) {
    if (!el) continue;
    el.setAttribute('contenteditable', on ? 'plaintext-only' : 'false');
    el.classList.toggle('is-editing', on);
  }
}

async function toggleAgentEditMode() {
  if (!_selectedAgent) return;
  // Marketplace editing is dev-only; lift the source guard accordingly.
  if (_isAgentPlatformSource(_selectedAgent.source) && !false) return;
  if (_agentEditing) {
    await _exitAgentEditMode();
  } else {
    await _enterAgentEditMode();
  }
}

async function _enterAgentEditMode() {
  _agentEditing = true;
  // Re-fetch to show raw workflow (not rendered markdown) for editing.
  const res = await apiFetch(`/api/agents/${encodeURIComponent(_selectedAgent.id)}`);
  const data = await res.json();
  if (data.ok && data.agent) _renderAgentDetail(data.agent, true);
  // External (cli-runtime) agents have no LLM-driven authoring — the
  // CLI brings its own behaviour, and the edit chat would just sit
  // empty. Hide the chat column so the user only sees the manual
  // name + description editors. In-process agents keep the chat.
  const isExternal = !!(data.ok && data.agent && data.agent.runtime?.kind === 'cli');
  const chatCol = document.getElementById('agents-chat-col');
  if (chatCol) chatCol.style.display = isExternal ? 'none' : '';
  if (!isExternal) {
    await _loadAgentChatHistory(_selectedAgent.id);
    setTimeout(() => document.getElementById('agents-chat-input')?.focus(), 50);
  } else {
    setTimeout(() => document.getElementById('agents-detail-name-input')?.focus(), 50);
  }
  // Wire field blur-save (one-time attach)
  _bindAgentFieldSave();
}

async function _exitAgentEditMode() {
  _agentEditing = false;
  // Abort any in-flight reply so the "done" button stops the stream immediately. The
  // agent chat controller is a singleton; leaving it pending also leaks the
  // streaming-button state into the next agent's edit panel.
  try { _agentChatCtrl?.abort(); } catch (_) { /* ignore */ }
  // Flush any pending save and then re-render in readonly mode.
  // The Done button is the explicit commit point — validate name here so
  // a bad value alerts + reverts rather than silently lingering.
  await _flushAgentFieldSave({ validate: true });
  document.getElementById('agents-chat-col').style.display = 'none';
  const aid = _selectedAgent?.id;
  if (aid) {
    const res = await apiFetch(`/api/agents/${encodeURIComponent(aid)}`);
    const data = await res.json();
    if (data.ok && data.agent) _renderAgentDetail(data.agent, false);
  }
  await loadAgents(true);
}

function _bindAgentFieldSave() {
  const fields = [
    ['agents-detail-name-input', 'name', (el) => el.value],
    ['agents-detail-desc', 'description', (el) => el.innerText],
    ['agents-detail-workflow', 'workflow', (el) => el.innerText],
  ];
  for (const [id, field, readValue] of fields) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (el.dataset.bound === '1') continue;
    el.dataset.bound = '1';
    if (field === 'name' && typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(el);
    el.addEventListener('input', () => _scheduleAgentFieldSave(field, readValue(el)));
    el.addEventListener('blur', () => _flushAgentFieldSave());
  }
}

function _restoreAgentNameField() {
  const next = _selectedAgent?.name || '';
  const nameEl = document.getElementById('agents-detail-name');
  const nameInput = document.getElementById('agents-detail-name-input');
  if (nameEl) nameEl.textContent = next;
  if (nameInput) nameInput.value = next;
}

function _scheduleAgentFieldSave(field, value) {
  if (!_selectedAgent) return;
  if (_isAgentPlatformSource(_selectedAgent.source) && !false) return;
  _pendingAgentField = { field, value };
  clearTimeout(_agentFieldSaveTimer);
  _agentFieldSaveTimer = setTimeout(_flushAgentFieldSave, 800);
}

let _pendingAgentField = null;
// `validate` is only true when the user explicitly commits (clicks "done" →
// `_exitAgentEditMode`). Typing-debounced and blur-triggered flushes pass
// false: a bad name silently skips the save (the DOM keeps the user's
// in-progress text) instead of popping a uiAlert mid-keystroke.
async function _flushAgentFieldSave({ validate = false } = {}) {
  clearTimeout(_agentFieldSaveTimer);
  _agentFieldSaveTimer = null;
  if (!_pendingAgentField || !_selectedAgent) return;
  const { field, value } = _pendingAgentField;
  if (field === 'name') {
    const blank = !String(value || '').trim();
    const hasWhitespace = /\s/.test(String(value || ''));
    const reserved = !hasWhitespace && _isReservedAgentName(value);
    const invalid = hasWhitespace || (!reserved && !_isValidAgentNameCharset(value));
    if (blank || reserved || invalid) {
      if (!validate) return;
      _pendingAgentField = null;
      await uiAlert(t(reserved ? 'agents.name_reserved' : 'agents.name_invalid'));
      _restoreAgentNameField();
      return;
    }
  }
  _pendingAgentField = null;
  try {
    const body = { [field]: value };
    const res = await apiFetch(`/api/agents/${encodeURIComponent(_selectedAgent.id)}/update`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) {
      // Surface duplicate-name / reserved-name with their localised messages
      // instead of the raw English server text.
      const localised = _agentCreateErrorMessage(data);
      throw new Error(localised || data.error || 'save failed');
    }
    if (field === 'name') {
      const nextName = data.agent?.name || String(value || '').trim();
      _selectedAgent = { ..._selectedAgent, name: nextName };
      const nameEl = document.getElementById('agents-detail-name');
      const nameInput = document.getElementById('agents-detail-name-input');
      if (nameEl) nameEl.textContent = nextName;
      if (nameInput) nameInput.value = nextName;
    }
    // Eagerly refresh — name changes feed the chat-bubble @-mention regex
    // (`_buildMentionRe` reads `_agentsCache`); leaving the cache null until
    // the next picker open means freshly-typed `@<multi-word-name>` only
    // gets the fallback char class, which stops at the first whitespace.
    await loadAgents(true);
    // Repaint the input-box recipient chip if it's bound to this agent —
    // its `name` field is a localStorage snapshot taken at picker time, so
    // without an explicit re-render the chip keeps showing the old name
    // until the next view switch.
    if (field === 'name' && typeof _renderRecipientChip === 'function') {
      try { _renderRecipientChip(); } catch (_) { /* non-fatal */ }
    }
  } catch (e) {
    _agentsLog.warn('save agent field failed', e);
    if (field === 'name') {
      await uiAlert(e.message || t('agents.create_failed'));
      _restoreAgentNameField();
    }
  }
}

// ─── Create agent (modal-first, two tabs: Create / External) ───
//
// "Create" (default tab) — manual authoring of an in-process agent.
// The LLM-driven edit chat opens immediately on save so the workflow
// can be refined.
//
// "External" — bind a local CLI as the runtime. The CLI selector sits
// at the top (default "not selected"); selecting a CLI auto-fills
// name + description from
// CLI_DEFAULTS. The user can override either; subsequent CLI swaps
// only re-fill fields that still match the previous CLI's defaults
// (so a user-edited value is never clobbered).
//
// Track the last-applied CLI defaults so that "switch CLI → fields
// follow" can detect "did the user touch this field?". `null` =
// nothing applied yet (untouched-default state, or the "create" tab).

function _switchAgentTab(tab) {
  const tabs = document.querySelectorAll('#agent-modal-tabs [data-agent-tab]');
  tabs.forEach((el) => el.classList.toggle('is-active', el.dataset.agentTab === tab));
  const panels = document.querySelectorAll('#agent-modal [data-agent-panel]');
  panels.forEach((el) => el.classList.toggle('is-active', el.dataset.agentPanel === tab));
  const msgEl = document.getElementById('agent-form-msg');
  if (msgEl) { msgEl.textContent = ''; msgEl.className = 'form-msg'; }
  setTimeout(() => {
    const focusId = tab === 'external' ? 'agent-modal-ext-cli-select' : 'agent-name-input';
    const el = document.getElementById(focusId);
    // ai-select wrapper isn't focusable directly; just leave it alone.
    if (el && typeof el.focus === 'function' && el.tagName !== 'DIV') el.focus();
  }, 30);
}
window._switchAgentTab = _switchAgentTab;

// Track which CLI defaults are currently reflected in the External-tab
// inputs. When a user types over a default, the field key drops out of
// this set so subsequent CLI swaps don't overwrite the typed value.
let _extActiveCli = null;
let _extDefaultFieldsAtMount = { name: false, desc: false };

/** Decide whether a current `name` value still counts as "the default
 *  for `defaultName`" — meaning a CLI swap should overwrite it. We
 *  recognise the bare default plus the dedup-style suffixes a user
 *  is likely to add when fighting the name-taken error: "ClaudeCode",
 *  "ClaudeCode2", "ClaudeCode-2", "ClaudeCode(2)", etc. Anything
 *  with non-digit text after the default ("ClaudeCodePro") counts as
 *  user-edited and is kept. */
function _isDefaultlikeName(value, defaultName) {
  if (!value) return true;
  if (!defaultName) return false;
  if (value === defaultName) return true;
  const escaped = defaultName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + escaped + '\\s*(?:[-_]\\s*)?(?:\\(\\s*\\d+\\s*\\)|\\d+)$');
  return re.test(value);
}

function _applyExternalCliDefaults(cliType, { force = false } = {}) {
  const defaults = (typeof getCliDefaults === 'function') ? getCliDefaults(cliType) : null;
  const nameEl = document.getElementById('agent-ext-name-input');
  const descEl = document.getElementById('agent-ext-desc-input');
  if (!nameEl || !descEl) return;

  const lang = (typeof getLang === 'function') ? getLang() : 'zh';
  const localizedDesc = defaults ? pickDesc(defaults, lang) : '';
  const targetName = defaults ? defaults.name : '';
  const targetDesc = localizedDesc;

  // Decide per field whether to overwrite. The two checks are independent —
  // a user who edits the name but leaves the description alone keeps their
  // name and gets a refreshed description. "Default-like name" also covers
  // dedup suffixes like "ClaudeCode2" (added to dodge name-taken errors).
  const prev = (typeof getCliDefaults === 'function') ? getCliDefaults(_extActiveCli) : null;
  const prevDescLocalized = prev ? pickDesc(prev, lang) : '';

  const nameUntouched = force || _isDefaultlikeName(nameEl.value, prev?.name);
  const descUntouched = force
    || descEl.value === ''
    || (prev && descEl.value === prevDescLocalized);

  if (cliType === null) {
    // Reverted to "not selected" — only clear fields that still hold
    // the previous CLI's defaults. Keep user-typed text.
    if (nameUntouched) nameEl.value = '';
    if (descUntouched) descEl.value = '';
  } else {
    if (nameUntouched) nameEl.value = targetName;
    if (descUntouched) descEl.value = targetDesc;
  }
  _extActiveCli = cliType;
}

function openAgentModal() {
  const modal = document.getElementById('agent-modal');
  const msgEl = document.getElementById('agent-form-msg');
  msgEl.textContent = '';
  msgEl.className = 'form-msg';

  // Reset both panels' inputs.
  const nameInput = document.getElementById('agent-name-input');
  const descInput = document.getElementById('agent-desc-input');
  const extName = document.getElementById('agent-ext-name-input');
  const extDesc = document.getElementById('agent-ext-desc-input');
  if (nameInput) nameInput.value = '';
  if (descInput) descInput.value = '';
  if (extName) extName.value = '';
  if (extDesc) extDesc.value = '';
  _extActiveCli = null;
  _extDefaultFieldsAtMount = { name: true, desc: true };
  if (typeof window.bindNameLimitControl === 'function') {
    window.bindNameLimitControl(nameInput);
    window.bindNameLimitControl(extName);
  }

  // Wire tabs (idempotent).
  const tabBar = document.getElementById('agent-modal-tabs');
  if (tabBar && !tabBar.dataset.wired) {
    tabBar.querySelectorAll('[data-agent-tab]').forEach((btn) => {
      btn.addEventListener('click', () => _switchAgentTab(btn.dataset.agentTab));
    });
    tabBar.dataset.wired = '1';
  }
  _switchAgentTab('create');

  // Refresh the External-tab CLI selector. Re-mount each open so newly-
  // installed CLIs surface without an app restart.
  if (typeof mountExternalCliSelect === 'function') {
    mountExternalCliSelect((cli) => _applyExternalCliDefaults(cli)).catch(() => {});
  }

  // Output-format dropdown (Create tab only — External/CLI agents don't read
  // the worker prompt hint). Default `auto` lets the model choose the lightest
  // useful presentation while detail-page dropdown maps legacy values.
  _mountAgentOutputFormatCreateSelect();

  modal.classList.add('open');
  setTimeout(() => document.getElementById('agent-name-input')?.focus(), 50);
}

function _mountAgentOutputFormatCreateSelect() {
  const slot = document.getElementById('agent-output-format-select');
  if (!slot) return;
  // Mount directly on the slot — _aiSelectMount stamps `dataset.value` on the
  // element it's given, and _saveCreateAgent reads `slot.dataset.value`. An
  // intermediate wrapper div would put the dataset out of reach of the save.
  slot.innerHTML = '';
  const options = [
    { value: 'auto',          label: t('agents.output_format_auto'),          hint: t('agents.output_format_auto_hint') },
    { value: 'text',          label: t('agents.output_format_text'),          hint: t('agents.output_format_text_hint') },
    { value: 'dashboard',     label: t('agents.output_format_dashboard'),     hint: t('agents.output_format_dashboard_hint') },
    { value: 'artifact',      label: t('agents.output_format_artifact'),      hint: t('agents.output_format_artifact_hint') },
  ];
  _aiSelectMount(slot, { options, value: 'auto' });
}
window.openAgentModal = openAgentModal;

function closeAgentModal() {
  document.getElementById('agent-modal').classList.remove('open');
}
window.closeAgentModal = closeAgentModal;

async function saveAgentModal() {
  const msgEl = document.getElementById('agent-form-msg');
  const activeTab = document.querySelector('#agent-modal-tabs .is-active')?.dataset.agentTab || 'create';
  if (activeTab === 'external') return _saveExternalAgent({ msgEl });
  return _saveCreateAgent({ msgEl });
}
window.saveAgentModal = saveAgentModal;

async function _saveCreateAgent({ msgEl }) {
  const rawName = document.getElementById('agent-name-input').value;
  const name = rawName.trim();
  const description = document.getElementById('agent-desc-input').value.trim();

  if (!name) {
    msgEl.textContent = t('agents.input_name_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-name-input').focus();
    return;
  }
  const hasWhitespace = /\s/.test(rawName);
  const reserved = !hasWhitespace && _isReservedAgentName(name);
  if (hasWhitespace || (!reserved && !_isValidAgentNameCharset(rawName))) {
    msgEl.textContent = t('agents.name_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-name-input').focus();
    return;
  }
  if (reserved) {
    msgEl.textContent = t('agents.name_reserved');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-name-input').focus();
    return;
  }
  if (!description) {
    msgEl.textContent = t('agents.input_desc_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-desc-input').focus();
    return;
  }

  // Output-format pick from the modal's dropdown. Default `auto` if for some reason the
  // dataset wasn't stamped (defensive — _mountAgentOutputFormatCreateSelect always sets it).
  const outputFormat = document.getElementById('agent-output-format-select')?.dataset.value || 'auto';

  try {
    const avatar = randomAgentAvatar();
    const body = { name, description, icon: avatar.icon, color: avatar.color, category: 'general', output_format: outputFormat };
    const res = await apiFetch('/api/agents/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok || !data.agent) {
      msgEl.textContent = _agentCreateErrorMessage(data) || t('agents.create_failed');
      msgEl.className = 'form-msg err';
            return;
    }
        closeAgentModal();
    setView('agents');
    await loadAgents(true);
    await _showAgentsDetailView(data.agent.agent_id);
    await _enterAgentEditMode();
    const seed = t('agents.seed_workflow', { description });
    await _autoSendAgentChat(seed);
  } catch (e) {
    msgEl.textContent = t('agents.network_error', { reason: e.message || e });
    msgEl.className = 'form-msg err';
  }
}

async function _saveExternalAgent({ msgEl }) {
  const cli = (typeof getExternalCliValue === 'function') ? getExternalCliValue() : null;
  const rawName = document.getElementById('agent-ext-name-input').value;
  const name = rawName.trim();
  const desc = document.getElementById('agent-ext-desc-input').value.trim();

  if (!cli) {
    msgEl.textContent = t('agents.ext_cli_needed');
    msgEl.className = 'form-msg err';
    return;
  }
  if (!name) {
    msgEl.textContent = t('agents.input_name_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-name-input').focus();
    return;
  }
  const hasWhitespace = /\s/.test(rawName);
  const reserved = !hasWhitespace && _isReservedAgentName(name);
  if (hasWhitespace || (!reserved && !_isValidAgentNameCharset(rawName))) {
    msgEl.textContent = t('agents.name_invalid');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-name-input').focus();
    return;
  }
  if (reserved) {
    msgEl.textContent = t('agents.name_reserved');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-name-input').focus();
    return;
  }
  if (!desc) {
    msgEl.textContent = t('agents.input_desc_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-ext-desc-input').focus();
    return;
  }

  // Both `description_zh` + `description_en` are stored so locale switches
  // are zero-cost. The locale we're currently editing in goes into that
  // side; the other side gets the canonical CLI default. Users who want
  // both fully-translated can edit each side later.
  const defaults = (typeof getCliDefaults === 'function') ? getCliDefaults(cli) : null;
  const lang = (typeof getLang === 'function') ? getLang() : 'zh';
  const editingZh = descriptionLocale(lang) === 'zh';
  const description_zh = editingZh ? desc : (defaults ? defaults.description_zh : desc);
  const description_en = editingZh ? (defaults ? defaults.description_en : desc) : desc;

  try {
    const avatar = randomAgentAvatar();
    const body = {
      name,
      description: desc,
      description_zh, description_en,
      icon: avatar.icon, color: avatar.color,
      runtime: { kind: 'cli', cli },
      category: 'general',
    };
    const res = await apiFetch('/api/agents/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok || !data.agent) {
      msgEl.textContent = _agentCreateErrorMessage(data) || t('agents.create_failed');
      msgEl.className = 'form-msg err';
            return;
    }
        closeAgentModal();
    setView('agents');
    await loadAgents(true);
    // External agents go straight to the detail view but skip the LLM
    // edit-chat — there's nothing to author. The user can still rename
    // or reword the description through the inline name/desc editors.
    await _showAgentsDetailView(data.agent.agent_id);
  } catch (e) {
    msgEl.textContent = t('agents.network_error', { reason: e.message || e });
    msgEl.className = 'form-msg err';
  }
}

/** Normalise IPC-shim error replies into a user-facing message. The
 *  backend tags duplicate-name / reserved-name failures with a `code`
 *  so we surface the localised string instead of the raw "agent name
 *  ... is already in use" English text. */
function _agentCreateErrorMessage(data) {
  if (!data) return '';
  const code = data.code;
  if (code === 'E_AGENT_NAME_TAKEN') return t('agents.name_taken');
  if (code === 'E_AGENT_NAME_RESERVED') return t('agents.name_reserved');
  if (code === 'E_AGENT_NAME_INVALID') return t('agents.name_invalid');
  if (code === 'E_AGENT_NAME_TOO_LONG') return t('agents.name_too_long');
  return data.error || '';
}

async function _autoSendAgentChat(content) {
  if (!_selectedAgent) return;
  const container = document.getElementById('agents-chat-messages');
  if (!container) return;
  // Only auto-seed when the chat is empty (fresh agent).
  const existing = container.querySelectorAll('.chat-message');
  if (existing.length > 0) return;
  _ensureAgentChatController();
  await _agentChatCtrl.send(content);
}

async function deleteSelectedAgent() {
  if (!_selectedAgent) return;
  const isMarketplace = _isAgentPlatformSource(_selectedAgent.source);
  if (isMarketplace && !false) return;
  const agentId = _selectedAgent.id;
  if (!(await uiConfirm(t('agents.delete_confirm', { name: _selectedAgent.name || agentId })))) return;
    try {
    const data = isMarketplace
      ? await window.orkas.invoke('agents.builtin.delete', { agent_id: agentId })
      : await (await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' })).json();
    if (!data.ok) throw new Error(data.error || t('agents.delete_failed'));
    _selectedAgent = null; _agentEditing = false;
    document.getElementById('agents-chat-col').style.display = 'none';
    document.getElementById('agents-detail-content').style.display = 'none';
    _showAgentsGridView();
    await loadAgents(true);
    await loadConversations();
  } catch (e) {
    await uiAlert(t('agents.delete_failed_with', { reason: e.message || e }));
  }
}

// ─── Agent inline edit chat ───

let _agentChatCtrl = null;
let _agentEditAttachmentsBound = false;

function _agentEditAttachmentCid(agentId) {
  return agentId ? `agent-edit-${agentId}` : '';
}

function _bindAgentEditAttachments() {
  if (_agentEditAttachmentsBound) return;
  _agentEditAttachmentsBound = true;
  const btn = document.getElementById('agents-chat-attach-btn');
  const area = document.querySelector('.agents-chat-input-area');
  const input = document.getElementById('agents-chat-input');
  const currentCid = () => _agentEditAttachmentCid(_selectedAgent?.id || '');
  if (btn) {
    btn.addEventListener('click', async () => {
      const cid = currentCid();
      if (cid) await _chatAttachPickAndUpload(cid);
    });
  }
  if (area) {
    area.addEventListener('dragover', (e) => {
      const hasFiles = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length;
      const hasInternal = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes(ORKAS_FILE_DRAG_MIME);
      if (!hasFiles && !hasInternal) return;
      e.preventDefault();
      area.classList.add('drag-over');
    });
    area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
    area.addEventListener('drop', async (e) => {
      const cid = currentCid();
      if (!cid) return;
      const internal = _chatAttachInternalDragItems(e.dataTransfer);
      if (internal.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachImportPaths(cid, internal);
        return;
      }
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        e.preventDefault();
        area.classList.remove('drag-over');
        await _chatAttachUpload(cid, e.dataTransfer.files);
      }
    });
  }
  if (input) {
    input.addEventListener('paste', async (e) => {
      if (!e.clipboardData || !e.clipboardData.files || !e.clipboardData.files.length) return;
      const cid = currentCid();
      if (!cid) return;
      e.preventDefault();
      await _chatAttachUpload(cid, e.clipboardData.files);
    });
  }
}

async function _buildAgentEditChatExtraBody(_content, agentId, state) {
  const cid = _agentEditAttachmentCid(agentId);
  const items = _chatAttachList(cid);
  if (!items.length) return undefined;
  if (items.some((a) => a.status === 'uploading')) {
    await uiAlert(t('chat.attach_still_uploading'));
    return null;
  }
  const attachments = items.filter((a) => a.status !== 'error').map((a) => a.name);
  if (!attachments.length) return undefined;
  if (state && (state.pending || state.hasQueue)) {
    await uiAlert(t('chat.attach_queue_blocked'));
    return null;
  }
  _chatAttachClear(cid);
  return { attachments, attachment_cid: cid };
}

function _ensureAgentChatController() {
  if (_agentChatCtrl) return _agentChatCtrl;
  _bindAgentEditAttachments();
  _agentChatCtrl = createChatController({
    historyEl: 'agents-chat-messages',
    inputEl: 'agents-chat-input',
    sendBtnEl: 'agents-chat-send-btn',
    getCurrentId: () => _selectedAgent?.id || null,
    historyEndpoint: (id) => `/api/agents/${encodeURIComponent(id)}/chat`,
    streamEndpoint: (id) => `/api/agents/${encodeURIComponent(id)}/chat/send/stream`,
    clearEndpoint: (id) => `/api/agents/${encodeURIComponent(id)}/chat`,
    features: { archive: false, scrollPin: true, queue: true },
    queue: {
      keyPrefix: 'agent',
      panelId: 'agents-chat-queue',
      listId: 'agents-chat-queue-list',
      countId: 'agents-chat-queue-count',
    },
    hooks: {
      buildExtraBody: _buildAgentEditChatExtraBody,
      async onFinal(ev, msgEl, id) {
        // Agent edit chat may have rewritten name / description / workflow;
        // the `updated` object on the final event carries the diff.
        if (ev.updated && Object.keys(ev.updated).length) {
          try {
            const freshRes = await apiFetch(`/api/agents/${encodeURIComponent(id)}`);
            const freshData = await freshRes.json();
            if (freshData.ok && freshData.agent && _selectedAgent?.id === id) {
              _selectedAgent.name = freshData.agent.name;
              _renderAgentDetail(freshData.agent, true);
              _agentsCache = null;
              await loadAgents(true);
              // Repaint the chat input recipient chip in case its bound
              // agent was the one just renamed by the edit chat.
              if (typeof _renderRecipientChip === 'function') {
                try { _renderRecipientChip(); } catch (_) { /* non-fatal */ }
              }
            }
          } catch (e) {
            _agentsLog.warn('refresh after updated fields failed', e);
          }
        }
      },
    },
  });
  return _agentChatCtrl;
}

async function _loadAgentChatHistory(agentId) {
  _ensureAgentChatController();
  await _agentChatCtrl.loadHistory();
  await _chatAttachRefreshFromServer(_agentEditAttachmentCid(agentId));
  // Custom empty-state message for fresh agents — controller's default is
  // "no messages..."; replace it with an agent-specific prompt when empty.
  const container = document.getElementById('agents-chat-messages');
  const empty = container?.querySelector('.empty');
  const defaultEmptyText = t('chat.empty');
  if (empty && (empty.textContent === defaultEmptyText || empty.textContent.includes('无对话记录') || empty.textContent.includes('No messages'))) {
    empty.textContent = t('agents.edit_chat_empty');
  }
}

async function clearAgentChat() {
  if (!_selectedAgent) return;
  if (!(await uiConfirm(t('agents.clear_confirm')))) return;
  _ensureAgentChatController();
  await _agentChatCtrl.clear();
}

// ─── "Use" flow: new normal conversation seeded with "run <name>" ───

/**
 * Run an agent: creates a fresh normal conversation, navigates to it,
 * then auto-sends a short user-visible message ("run <name>"). The
 * model sees the same visible text and recognises it as a run-agent
 * directive per chat_commander.md rule 0 (instruction following) — no
 * hidden backend injection.
 *
 * `seedText` is the user-visible content. Defaults to "run <name>".
 */
async function useAgent(agentId, seedText) {
  if (_agentsCache?.some((a) => a.agent_id === agentId && a.enabled === false)) return;
  if (!ensureModelConfigured()) return;
  try {
    // Look up the agent so we can title the conv + derive default seed text.
    const aRes = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`);
    const aData = await aRes.json();
    if (!aData.ok || !aData.agent) throw new Error(aData.error || t('agents.agent_not_found'));
    const agent = aData.agent;
    if (agent.enabled === false) return;

    _agentsLog.info('use agent', { agent_id: agentId, has_seed: !!(seedText && seedText.trim()) });
    
    const visible = (seedText || '').trim() || t('agents.run_prefix', { name: agent.name || agent.agent_id });

    // Don't pass a custom title — let backend `groupChat.send` auto-title
    // from the first user message, same rule as every other conv-creation
    // entry point (new-chat panel, commander @-mention). Optimistic title
    // is the run-prefix message itself so the sidebar entry shows the
    // user's intent ("run <name>") instead of bare agent name; this
    // matches what backend `autoTitle` will persist on the same `visible`.
    const res = await apiFetch('/api/conversations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || t('agents.create_conv_failed'));
    const conv = data.conversation;
    conv.title = _autoTitle(visible);
    // Same fix as the new-chat path in conversation.js: backend's create
    // response carries `created_at`/`updated_at` but NOT the derived
    // `last_active_at`, so `timeBucket` would default this brand-new row to
    // the 'older' bucket and the user thinks it disappeared.
    conv.last_active_at = new Date().toISOString();
    conversations.unshift(conv);
    renderConversationList();
    setView('conversation', conv.conversation_id, { skipLoad: true });
    setChatRecipient('conversation', {
      kind: 'agent',
      id: agentId,
      name: agent.name || agent.agent_id,
    });
    // Fire the send after the view switch has the chat DOM ready.
    setTimeout(() => sendInCurrentConversation(visible), 50);
  } catch (e) {
    await uiAlert(t('agents.launch_failed', { reason: e.message || e }));
  }
}

async function useSkill(skillId, skillName) {
  if (_skillsCache?.some((s) => s.id === skillId && s.enabled === false)) return;
  // Skill "use" flow: navigate to the new-chat page with the skill
  // pre-selected and wait for user input.
  _agentsLog.info('use skill', { skill_id: skillId, skill_name: skillName || skillId });
    setView('new-chat');
  if (typeof setChatRecipient === 'function') {
    setChatRecipient('new-chat', { kind: 'commander' });
  }
  setChatSkill('new-chat', skillName || skillId);
  setTimeout(() => document.getElementById('new-chat-input')?.focus(), 50);
}

// ─── Agent picker (one-shot, works on both new-chat and conversation) ───
// Selecting an agent immediately fires a send with the agent's workflow
// auto-injected on the backend. The selection does NOT persist — the user
// picks an agent each time they need one.

// Place popover above the **input area** (not just the anchor button) so
// it never covers the textarea — the toolbar buttons sit at the bottom of
// the input area, and computing "above" from the button alone meant the
// popover's bottom edge landed on top of the textarea above. We look for
// any chat-input wrapper / area ancestor (main conv, new-chat, skill-edit,
// agent-edit) and use its top as the "above" reference, falling back to
// the anchor's own rect for unrelated anchors.
const _INPUT_AREA_CLASS_RE = /(?:^|\s)(?:chat|new-chat|skills-chat|agents-chat)-input-(?:wrapper|area)(?:\s|$)/;
function _findInputAreaTop(anchorEl) {
  let cur = anchorEl;
  while (cur && cur !== document.body) {
    const cls = cur.className;
    if (typeof cls === 'string' && _INPUT_AREA_CLASS_RE.test(cls)) {
      return cur.getBoundingClientRect().top;
    }
    cur = cur.parentElement;
  }
  return null;
}

function _positionPopoverAboveOrBelow(popover, anchorEl) {
  // Make invisible but laid out so we can measure it before positioning.
  popover.style.display = 'flex';
  popover.style.left = '-9999px';
  popover.style.top = '-9999px';
  popover.style.maxHeight = '';
  const rect = anchorEl.getBoundingClientRect();
  const popRect = popover.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  // Reference top for "above" computation: top of the whole input area
  // when the anchor lives in the chat composer; otherwise the anchor's
  // own top. This keeps the popover from overlapping the textarea on
  // chat panels while still working for any other future anchor.
  const aboveRef = _findInputAreaTop(anchorEl);
  const refTop = aboveRef !== null ? aboveRef : rect.top;
  const availAbove = refTop - margin - gap;
  const availBelow = window.innerHeight - rect.bottom - margin - gap;
  const preferAbove = popRect.height <= availAbove || availAbove >= availBelow;

  let left = rect.left;
  if (left + popRect.width > window.innerWidth - margin) {
    left = window.innerWidth - popRect.width - margin;
  }
  if (left < margin) left = margin;

  let top;
  if (preferAbove) {
    const maxH = Math.max(0, availAbove);
    if (popRect.height > maxH) popover.style.maxHeight = maxH + 'px';
    top = Math.max(margin, refTop - Math.min(popRect.height, maxH) - gap);
  } else {
    const maxH = Math.max(0, availBelow);
    if (popRect.height > maxH) popover.style.maxHeight = maxH + 'px';
    top = rect.bottom + gap;
  }
  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
}

// Expose so skills.js can reuse the same positioning math (DRY across the
// two pickers; behaviour must stay identical so users get consistent UX).
if (typeof window !== 'undefined') {
  window.positionPickerPopover = _positionPopoverAboveOrBelow;
}

// Project scope state for the active picker session: when the anchor's
// active context (commander tab / current conv) belongs to a project, the
// picker collapses to that project's bound agents. `null` = no project
// scope active (orphan conv / no project picked) → unrestricted listing.
// Set on every `_openAgentPicker`; consumed by `_renderAgentPickerList` and
// the search-input change handler so live filtering stays scoped.
let _pickerBoundAgentIds = null;
let _agentPickerTab = 'agents';
const _AGENT_PICKER_TAB_ORDER = ['agents', 'skills', 'connectors'];
const _AGENT_PICKER_TABS = new Set(_AGENT_PICKER_TAB_ORDER);

function _normalizeAgentPickerTab(tab) {
  return _AGENT_PICKER_TABS.has(tab) ? tab : 'agents';
}

function _agentPickerAllowsUseTabs(anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  if (target === 'auto') {
    const rec = (typeof window !== 'undefined' && typeof window._autoGetRecipient === 'function')
      ? window._autoGetRecipient()
      : { kind: 'commander' };
    return !rec || rec.kind !== 'agent';
  }
  if (typeof getChatRecipient !== 'function') return true;
  const rec = getChatRecipient(target);
  return !rec || rec.kind !== 'agent';
}

function _agentPickerVisibleTabs(anchorId) {
  return _agentPickerAllowsUseTabs(anchorId)
    ? _AGENT_PICKER_TAB_ORDER
    : ['agents'];
}

function _agentPickerSearchPlaceholder() {
  if (_agentPickerTab === 'skills') return t('agent_picker.search_skills_placeholder');
  if (_agentPickerTab === 'connectors') return t('agent_picker.search_connectors_placeholder');
  return t('agent_picker.search_placeholder');
}

function _updateAgentPickerChrome() {
  const picker = document.getElementById('agent-picker');
  if (!picker) return;
  const visibleTabs = new Set(_agentPickerVisibleTabs(picker.dataset.anchorId || ''));
  picker.querySelectorAll('[data-agent-picker-tab]').forEach((btn) => {
    const tab = btn.dataset.agentPickerTab || 'agents';
    const visible = visibleTabs.has(tab);
    btn.style.display = visible ? '' : 'none';
    const active = visible && tab === _agentPickerTab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  const search = document.getElementById('agent-picker-search');
  if (search) search.placeholder = _agentPickerSearchPlaceholder();
}

function _setAgentPickerTab(tab, opts = {}) {
  const picker = document.getElementById('agent-picker');
  const visibleTabs = _agentPickerVisibleTabs(picker?.dataset.anchorId || '');
  const normalized = _normalizeAgentPickerTab(tab);
  _agentPickerTab = visibleTabs.includes(normalized) ? normalized : 'agents';
  const search = document.getElementById('agent-picker-search');
  if (search && !opts.keepSearch) search.value = '';
  _updateAgentPickerChrome();
  _renderAgentPickerList(search ? search.value : '');
  if (opts.focusSearch !== false) setTimeout(() => search?.focus(), 0);
}

function _moveAgentPickerTab(delta) {
  const picker = document.getElementById('agent-picker');
  const tabs = _agentPickerVisibleTabs(picker?.dataset.anchorId || '');
  const cur = tabs.indexOf(_agentPickerTab);
  const idx = cur >= 0 ? cur : 0;
  const next = (idx + delta + tabs.length) % tabs.length;
  _setAgentPickerTab(tabs[next]);
}

function _resolveActiveProjectId(anchorId) {
  if (anchorId === 'new-chat-recipient-chip') {
    // Empty-state composer creates orphan conversations; no project scope.
    return '';
  }
  if (anchorId === 'project-chat-recipient-chip') {
    return (typeof _projectDetailPid !== 'undefined') ? (_projectDetailPid || '') : '';
  }
  if (anchorId === 'chat-recipient-chip') {
    if (typeof currentCid !== 'undefined' && currentCid
        && typeof conversations !== 'undefined' && Array.isArray(conversations)) {
      const conv = conversations.find((c) => c && c.conversation_id === currentCid);
      return (conv && conv.project_id) || '';
    }
  }
  if (anchorId === 'auto-recipient-chip') {
    // The auto modal sets this when it opens so picker results scope
    // to the task's project (if any). See modules/auto.js.
    return (typeof window !== 'undefined' && typeof window._autoGetProjectId === 'function')
      ? (window._autoGetProjectId() || '')
      : '';
  }
  return '';
}

async function _openAgentPicker(anchorBtn) {
  const picker = document.getElementById('agent-picker');
  if (!anchorBtn || !picker) return;
  picker.dataset.anchorId = anchorBtn.id;
  // Force-refresh `_agentsCache` on every open. The cache's only background
  // refresh source is `_mountCreatedAgentChip` / fallback in conversation.js,
  // which fires when the user is sitting on the conversation view at the
  // moment a `<agent>` container result message arrives. If the user creates
  // an agent in conversation A then immediately opens the picker in
  // conversation B (or just after a renderer reload that refilled cache from
  // an older state), the picker filter still uses fresh project bindings
  // (refreshed below) but reads against a stale `_agentsCache` and the new
  // agent silently disappears from the list. Mirror the `setView('agents')`
  // force-refresh in `boot.js` here so the picker is also a ground-truth
  // surface; cost is one IPC + dir scan per picker open (sub-ms in practice).
  await Promise.all([
    loadAgents(true),
    (typeof loadSkills === 'function' ? loadSkills(true) : Promise.resolve()),
    (typeof loadConnectors === 'function' ? loadConnectors() : Promise.resolve()),
  ]);
  // Refresh project-scoped agent bindings on every open so the picker reflects
  // whatever project the user just picked (commander chip) or whatever
  // project the active conv belongs to. Skills and connectors stay global.
  _pickerBoundAgentIds = null;
  const pid = _resolveActiveProjectId(anchorBtn.id);
  if (pid) {
    try {
      const res = await window.orkas.invoke('projects.bindings.list', { projectId: pid });
      if (res?.ok) {
        _pickerBoundAgentIds = new Set((res.bindings && res.bindings.agents) || []);
      }
    } catch (_) { /* fall back to global listing */ }
  }
  // Render first so measurement in _positionPopoverAboveOrBelow reflects
  // the real list height (not stale content from a previous open).
  _setAgentPickerTab('agents', { focusSearch: false });
  _positionPopoverAboveOrBelow(picker, anchorBtn);
  setTimeout(() => document.getElementById('agent-picker-search')?.focus(), 30);
}

function _closeAgentPicker() {
  const picker = document.getElementById('agent-picker');
  if (picker) picker.style.display = 'none';
  // NOTE: callers that close-without-selection (Esc / click-outside) must
  // also clear `_atKeyMark` — otherwise the next picker open would consume
  // a stale `@`. Selection callers leave the mark so _triggerPickerItem can
  // use it before clearing.
}

function _renderAgentPickerList(filterText) {
  const listEl = document.getElementById('agent-picker-list');
  const picker = document.getElementById('agent-picker');
  if (!listEl) return;
  const anchorId = picker?.dataset.anchorId || '';
  if (!_agentPickerVisibleTabs(anchorId).includes(_agentPickerTab)) {
    _agentPickerTab = 'agents';
  }
  _updateAgentPickerChrome();
  if (_agentPickerTab === 'skills') {
    _renderSkillPickerList(listEl, filterText, anchorId);
    return;
  }
  if (_agentPickerTab === 'connectors') {
    _renderConnectorPickerList(listEl, filterText, anchorId);
    return;
  }
  // Disabled agents are filtered out — picker is a "what can I dispatch right
  // now" UI, and re-enabling lives in the management page (Agents view + ⋯ menu).
  let agents = (_agentsCache || []).filter((a) => a.enabled !== false);
  // Project scope: only show agents bound to the active context's project.
  // Applied AFTER the enabled filter (per CLAUDE.md §6 outer-intersection
  // rule). `null` = no project scope, full listing.
  if (_pickerBoundAgentIds) {
    agents = agents.filter((a) => _pickerBoundAgentIds.has(a.agent_id));
  }
  const q = (filterText || '').toLowerCase();
  // Search matches across the active locale description; cross-language
  // fallback via pickDesc lets users find a single-locale agent regardless
  // of which side they typed in.
  // Match-quality ranking: name-exact (0) < name-prefix (1) < name-substring (2)
  // < description-only (3). Stable sort within ties preserves the source-group
  // order computed below. Without this, an agent whose description happens to
  // mention the query (e.g. "Agent Skill 搜集" mentioning "Claude Code subagents"
  // in passing) outranks the actual `Claude Code` agent because the original
  // list is sorted by hex agent_id, not by relevance.
  const lang = getLang();
  const matchScore = (a) => {
    const name = (a.name || '').toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.includes(q)) return 2;
    return 3;
  };
  const filtered = q
    ? agents
        .filter(a => (a.name || '').toLowerCase().includes(q) || pickDesc(a, lang).toLowerCase().includes(q))
        .sort((a, b) => matchScore(a) - matchScore(b))
    : agents;
  // Recipient chip exposes "commander" as a virtual top entry so the user can
  // switch back without an empty-state. Other anchors keep agent-only listing.
  const isRecipientPicker = anchorId === 'chat-recipient-chip'
    || anchorId === 'new-chat-recipient-chip'
    || anchorId === 'project-chat-recipient-chip'
    || anchorId === 'auto-recipient-chip';
  const commanderName = t('chat.recipient_commander');
  const commanderMatchesFilter = !q || commanderName.toLowerCase().includes(q);
  if (!filtered.length && !(isRecipientPicker && commanderMatchesFilter)) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('agents.no_match'))}</div>`;
    return;
  }
  const groups = { custom: [], marketplace: [] };
  for (const a of filtered) (groups[_agentSource(a.source)] || groups.custom).push(a);
  const groupHtml = (label, list) => {
    if (!list.length) return '';
    return `<div class="skill-picker-group-label">${escapeHtml(label)}</div>` +
      list.map(a => {
        const aDesc = pickDesc(a, lang).trim();
        return `
        <div class="skill-picker-item" data-kind="agent" data-id="${escapeHtml(a.agent_id)}" data-name="${escapeHtml(a.name || a.agent_id)}">
          <div class="skill-picker-item-name">${escapeHtml(a.name || t('agents.unnamed'))}</div>
          ${aDesc ? `<div class="skill-picker-item-desc">${escapeHtml(aDesc)}</div>` : ''}
        </div>`;
      }).join('');
  };
  const commanderHtml = (isRecipientPicker && commanderMatchesFilter)
    ? `<div class="skill-picker-item" data-kind="agent" data-id="__commander__" data-name="${escapeHtml(commanderName)}">
         <div class="skill-picker-item-name">${escapeHtml(commanderName)}</div>
         <div class="skill-picker-item-desc">${escapeHtml(t('chat.recipient_commander_hint'))}</div>
       </div>`
    : '';
  // When the active context is a project AND the project has zero agents
  // bound, surface a hint above the commander entry so the user knows
  // "this isn't broken — go bind an agent first". Suppressed on user search
  // (they're explicitly typing) so the search "no match" message owns the
  // empty rendering.
  const projectEmptyHint = (!q && _pickerBoundAgentIds && _pickerBoundAgentIds.size === 0)
    ? `<div class="skill-picker-empty-hint">${escapeHtml(t('agents.no_project_agents'))}</div>`
    : '';
  listEl.innerHTML = projectEmptyHint + commanderHtml
    + groupHtml(t('agents.source_custom'), groups.custom)
    + groupHtml(t('agents.source_marketplace'), groups.marketplace);
  _bindAgentPickerListItems(listEl, anchorId);
}

function _matchPickerItem(q, name, desc, extra = '') {
  if (!q) return true;
  return String(name || '').toLowerCase().includes(q)
    || String(desc || '').toLowerCase().includes(q)
    || String(extra || '').toLowerCase().includes(q);
}

function _pickerMatchScore(q, name) {
  const n = String(name || '').toLowerCase();
  if (!q) return 0;
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (n.includes(q)) return 2;
  return 3;
}

function _renderSkillPickerList(listEl, filterText, anchorId) {
  const lang = getLang();
  const q = (filterText || '').toLowerCase();
  let skills = (_skillsCache || []).filter((s) => s.enabled !== false);
  const filtered = q
    ? skills
        .filter((s) => _matchPickerItem(q, s.name || s.id, pickDesc(s, lang), s.id))
        .sort((a, b) => _pickerMatchScore(q, a.name || a.id) - _pickerMatchScore(q, b.name || b.id))
    : skills;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(t('skills.no_match'))}</div>`;
    return;
  }
  const groups = { custom: [], marketplace: [] };
  for (const s of filtered) {
    const source = (typeof normalizeCatalogSource === 'function') ? normalizeCatalogSource(s.source) : s.source;
    (groups[source] || groups.custom).push(s);
  }
  const groupHtml = (label, list) => {
    if (!list.length) return '';
    return `<div class="skill-picker-group-label">${escapeHtml(label)}</div>` +
      list.map((s) => {
        const desc = pickDesc(s, lang).trim();
        const name = s.name || s.id;
        return `
        <div class="skill-picker-item" data-kind="skill" data-id="${escapeHtml(s.id)}" data-name="${escapeHtml(name)}">
          <div class="skill-picker-item-name">${escapeHtml(name)}</div>
          ${desc ? `<div class="skill-picker-item-desc">${escapeHtml(desc)}</div>` : ''}
        </div>`;
      }).join('');
  };
  listEl.innerHTML = groupHtml(t('skills.source_custom'), groups.custom)
    + groupHtml(t('skills.source_marketplace'), groups.marketplace);
  _bindAgentPickerListItems(listEl, anchorId);
}

function _renderConnectorPickerList(listEl, filterText, anchorId) {
  const q = (filterText || '').toLowerCase();
  const items = (typeof listUsableConnectorsForPicker === 'function')
    ? listUsableConnectorsForPicker()
    : [];
  const filtered = q
    ? items
        .filter((c) => _matchPickerItem(q, c.name || c.id, c.description, `${c.id} ${c.account || ''}`))
        .sort((a, b) => _pickerMatchScore(q, a.name || a.id) - _pickerMatchScore(q, b.name || b.id))
    : items;
  if (!filtered.length) {
    listEl.innerHTML = `<div class="skill-picker-empty">${escapeHtml(q ? t('connectors.no_match') : t('connectors.no_connected'))}</div>`;
    return;
  }
  listEl.innerHTML = `<div class="skill-picker-group-label">${escapeHtml(t('connectors.group.connected'))}</div>` +
    filtered.map((c) => {
      const descParts = [];
      if (c.description) descParts.push(c.description);
      if (c.account) descParts.push(t('connectors.account_label', { account: c.account }));
      return `
      <div class="skill-picker-item" data-kind="connector" data-id="${escapeHtml(c.id)}" data-name="${escapeHtml(c.name || c.id)}">
        <div class="skill-picker-item-name">${escapeHtml(c.name || c.id)}</div>
        ${descParts.length ? `<div class="skill-picker-item-desc">${escapeHtml(descParts.join(' · '))}</div>` : ''}
      </div>`;
    }).join('');
  _bindAgentPickerListItems(listEl, anchorId);
}

function _bindAgentPickerListItems(listEl, anchorId) {
  for (const el of listEl.querySelectorAll('[data-id]')) {
    el.addEventListener('click', async () => {
      _closeAgentPicker();
      await _triggerPickerItem(el.dataset.kind || 'agent', el.dataset.id, el.dataset.name, anchorId);
    });
    el.addEventListener('mouseenter', () => {
      const all = listEl.querySelectorAll('.skill-picker-item[data-id]');
      const idx = Array.prototype.indexOf.call(all, el);
      if (idx >= 0) _setAgentPickerActive(idx);
    });
  }
  _setAgentPickerActive(0);
}

// ── Agent picker keyboard navigation ─────────────────────────────────────

function _setAgentPickerActive(idx) {
  const listEl = document.getElementById('agent-picker-list');
  if (!listEl) return;
  const items = listEl.querySelectorAll('.skill-picker-item[data-id]');
  if (!items.length) return;
  const clamped = Math.max(0, Math.min(items.length - 1, idx));
  items.forEach((el, i) => el.classList.toggle('active', i === clamped));
  items[clamped].scrollIntoView({ block: 'nearest' });
}

function _moveAgentPickerActive(delta) {
  const listEl = document.getElementById('agent-picker-list');
  if (!listEl) return;
  const items = listEl.querySelectorAll('.skill-picker-item[data-id]');
  if (!items.length) return;
  let cur = -1;
  items.forEach((el, i) => { if (el.classList.contains('active')) cur = i; });
  const next = cur < 0 ? 0 : (cur + delta + items.length) % items.length;
  _setAgentPickerActive(next);
}

function _targetFromPickerAnchor(anchorId) {
  if (anchorId === 'new-chat-recipient-chip') return 'new-chat';
  if (anchorId === 'project-chat-recipient-chip') return 'project';
  if (anchorId === 'auto-recipient-chip') return 'auto';
  return 'conversation';
}

async function _triggerPickerItem(kind, itemId, itemName, anchorId) {
  const target = _targetFromPickerAnchor(anchorId);
  if ((kind === 'skill' || kind === 'connector') && !_agentPickerAllowsUseTabs(anchorId)) {
    _consumeAtKeyChar();
    const inputId = target === 'new-chat'
      ? 'new-chat-input'
      : (target === 'project' ? 'project-chat-input' : (target === 'auto' ? 'auto-task-input' : 'chat-input'));
    _focusInput(document.getElementById(inputId));
    return;
  }
  // Auto form: skill / connector are first-class chip fields on the
  // task record (`task.skill` / `task.connector`). Content stays clean —
  // fire-time `_buildSeedText` in main composes the outgoing text from
  // these refs + the `*.use_prefix` i18n templates, mirroring how the
  // commander composer wraps text from its chip state.
  if (target === 'auto' && kind === 'skill') {
    if (typeof window !== 'undefined' && typeof window._autoOnSkillPicked === 'function') {
      window._autoOnSkillPicked({ id: String(itemId || itemName), name: String(itemName || itemId) });
    }
    _consumeAtKeyChar();
    _focusInput(document.getElementById('auto-task-input'));
    return;
  }
  if (target === 'auto' && kind === 'connector') {
    if (typeof window !== 'undefined' && typeof window._autoOnConnectorPicked === 'function') {
      window._autoOnConnectorPicked({ id: String(itemId), name: String(itemName || itemId) });
    }
    _consumeAtKeyChar();
    _focusInput(document.getElementById('auto-task-input'));
    return;
  }
  if (kind === 'skill') {
    setChatSkill(target, itemName || itemId);
    _consumeAtKeyChar();
    const inputId = target === 'new-chat' ? 'new-chat-input' : (target === 'project' ? 'project-chat-input' : 'chat-input');
    _focusInput(document.getElementById(inputId));
    return;
  }
  if (kind === 'connector') {
    setChatConnector(target, itemId, itemName || itemId);
    _consumeAtKeyChar();
    const inputId = target === 'new-chat' ? 'new-chat-input' : (target === 'project' ? 'project-chat-input' : 'chat-input');
    _focusInput(document.getElementById(inputId));
    return;
  }
  await _triggerAgent(itemId, itemName, anchorId);
}

// Route an agent selection to the right behaviour based on which button
// triggered the picker:
//   - recipient chip / @ picker → update the persistent recipient chip.
//   - other anchors → spin up a fresh conversation for that agent.
async function _triggerAgent(agentId, agentName, anchorId) {
  if (anchorId === 'auto-recipient-chip') {
    // Auto modal owns its own recipient state; route the picked agent
    // (or commander) to its registered handler instead of touching any
    // conversation-scoped chat state.
    const rec = (agentId === '__commander__')
      ? { kind: 'commander' }
      : { kind: 'agent', id: agentId, name: agentName || agentId };
    if (typeof window !== 'undefined' && typeof window._autoOnRecipientPicked === 'function') {
      window._autoOnRecipientPicked(rec);
    }
    _consumeAtKeyChar();
    _focusInput(document.getElementById('auto-task-input'));
    return;
  }
  const isRecipientAnchor = anchorId === 'chat-recipient-chip'
    || anchorId === 'new-chat-recipient-chip'
    || anchorId === 'project-chat-recipient-chip';
  if (isRecipientAnchor) {
    const target = _targetFromPickerAnchor(anchorId);
    if (agentId === '__commander__') {
      setChatRecipient(target, { kind: 'commander' });
    } else {
      setChatRecipient(target, { kind: 'agent', id: agentId, name: agentName || agentId });
    }
    // If the picker was opened by the user typing `@` in the textarea, that
    // `@` is now redundant (the chip carries the recipient) and would also
    // leak into the sent text — strip it.
    _consumeAtKeyChar();
    const inputId = target === 'new-chat' ? 'new-chat-input' : (target === 'project' ? 'project-chat-input' : 'chat-input');
    _focusInput(document.getElementById(inputId));
    return;
  }
  // Sidebar / agent-detail "use" button → spin up a fresh conversation
  await useAgent(agentId);
}

// `@`-keystroke bookkeeping so a successful picker selection can remove the
// `@` the user just typed. Cleared on every open; consumed on selection.
let _atKeyMark = null; // { inputId, posAfter } | null

function _consumeAtKeyChar() {
  const m = _atKeyMark;
  _atKeyMark = null;
  if (!m) return;
  const ta = document.getElementById(m.inputId);
  if (!ta) return;
  const atIdx = m.posAfter - 1;
  if (atIdx < 0 || ta.value.charAt(atIdx) !== '@') return;
  ta.value = ta.value.slice(0, atIdx) + ta.value.slice(atIdx + 1);
  try { ta.setSelectionRange(atIdx, atIdx); } catch (_) {}
  if (typeof autoGrow === 'function') autoGrow(ta, 200);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function _focusInput(input) {
  // Defer to the next tick so the picker's outside-click handler can finish
  // closing first; otherwise focus jumps back to the picker on some browsers.
  setTimeout(() => { try { input.focus(); } catch (_) {} }, 0);
}

// Recipient chip + composer textarea anchor pairs. Three sticky composers
// (commander conversation, new-chat landing, project detail) get bound at
// boot from this table; the auto modal calls `bindRecipientAnchor`
// directly when it mounts so its DOM ID joins the wiring on the fly.
const _RECIPIENT_ANCHOR_PAIRS = [
  { chip: 'chat-recipient-chip',         input: 'chat-input' },
  { chip: 'new-chat-recipient-chip',     input: 'new-chat-input' },
  { chip: 'project-chat-recipient-chip', input: 'project-chat-input' },
];

// Backspace right after a `@<name>` token (with or without the trailing
// space the picker inserts) removes the whole mention as one unit —
// character-by-character deletion of `@<CJK-name> ` is annoying when the
// user picked the wrong agent. Matches the bus mention regex's charset so
// CJK names work.
const _MENTION_DELETE_RE = /@[A-Za-z0-9_一-鿿-]+ ?$/u;

function _onMentionBackspace(e) {
  if (e.key !== 'Backspace') return;
  if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
  const ta = e.currentTarget;
  if (!ta || typeof ta.selectionStart !== 'number') return;
  if (ta.selectionStart !== ta.selectionEnd) return; // user has a selection — let default handle
  const caret = ta.selectionStart;
  if (caret === 0) return;
  const left = ta.value.slice(0, caret);
  const m = _MENTION_DELETE_RE.exec(left);
  if (!m) return;
  const start = caret - m[0].length;
  e.preventDefault();
  ta.value = ta.value.slice(0, start) + ta.value.slice(caret);
  try { ta.setSelectionRange(start, start); } catch (_) {}
  if (typeof autoGrow === 'function') autoGrow(ta, 200);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function _atKeyOpener(chipId) {
  return (e) => {
    if (e.key !== '@') return;
    const btn = document.getElementById(chipId);
    if (!btn) return;
    const ta = e.currentTarget;
    setTimeout(() => {
      _atKeyMark = {
        inputId: ta.id || '',
        posAfter: typeof ta.selectionStart === 'number' ? ta.selectionStart : 0,
      };
      _openAgentPicker(btn);
    }, 0);
  };
}

// Wire (chip → click opens picker) + (textarea → `@` opens picker,
// Backspace deletes whole mention). Guarded with dataset flags so calling
// this twice for the same anchor is a no-op. Called at boot for the three
// sticky composers AND on demand by `modules/auto.js` when its modal
// mounts (registers the 4th `'auto-recipient-chip'` anchor).
function bindRecipientAnchor(chipId, inputId) {
  const btn = document.getElementById(chipId);
  if (btn && btn.dataset.bound !== '1') {
    btn.dataset.bound = '1';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      _atKeyMark = null; // chip click is not a `@`-keystroke trigger
      if (!_agentsCache) await loadAgents();
      const picker = document.getElementById('agent-picker');
      if (picker && picker.style.display !== 'none' && picker.dataset.anchorId === chipId) {
        _closeAgentPicker();
      } else {
        _openAgentPicker(btn);
      }
    });
  }
  const ta = document.getElementById(inputId);
  if (ta && ta.dataset.atBound !== '1') {
    ta.dataset.atBound = '1';
    ta.addEventListener('keydown', _atKeyOpener(chipId));
    ta.addEventListener('keydown', _onMentionBackspace);
  }
}

if (typeof window !== 'undefined') window.bindRecipientAnchor = bindRecipientAnchor;

function bindAgentPickers() {
  // Re-bindable helper: wire the recipient chips on both chat panels +
  // under anchorIds. Guarded with dataset.bound so a second call is a no-op.
  document.querySelectorAll('[data-agent-picker-tab]').forEach((btn) => {
    if (btn.dataset.bound === '1') return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _setAgentPickerTab(btn.dataset.agentPickerTab || 'agents');
    });
  });
  const searchInput = document.getElementById('agent-picker-search');
  searchInput?.addEventListener('input', () => {
    _renderAgentPickerList(searchInput.value);
  });
  searchInput?.addEventListener('keydown', (e) => {
    // IME composition guard (CLAUDE.md §8): Enter / Arrow keys belong to
    // the IME while a Chinese / Japanese / Korean candidate is being
    // composed; without this early-return, pressing Enter to commit an
    // English candidate would also fire our select-active-item handler.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { _atKeyMark = null; _closeAgentPicker(); e.preventDefault(); return; }
    if (e.key === 'ArrowRight') { _moveAgentPickerTab(1); e.preventDefault(); return; }
    if (e.key === 'ArrowLeft')  { _moveAgentPickerTab(-1); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { _moveAgentPickerActive(1); e.preventDefault(); return; }
    if (e.key === 'ArrowUp')   { _moveAgentPickerActive(-1); e.preventDefault(); return; }
    if (e.key === 'Enter') {
      const listEl = document.getElementById('agent-picker-list');
      const active = listEl?.querySelector('.skill-picker-item.active[data-id]')
        || listEl?.querySelector('.skill-picker-item[data-id]');
      if (active) { active.click(); e.preventDefault(); }
    }
  });
  for (const { chip, input } of _RECIPIENT_ANCHOR_PAIRS) {
    bindRecipientAnchor(chip, input);
  }
  // One global click handler is enough — guard with a flag on the picker.
  const picker = document.getElementById('agent-picker');
  if (picker && !picker.dataset.outsideBound) {
    picker.dataset.outsideBound = '1';
    document.addEventListener('click', (e) => {
      if (!picker || picker.style.display === 'none') return;
      if (picker.contains(e.target)) return;
      const anchorId = picker.dataset.anchorId;
      const anchorEl = anchorId ? document.getElementById(anchorId) : null;
      if (anchorEl && anchorEl.contains(e.target)) return;
      _atKeyMark = null;
      _closeAgentPicker();
    });
    window.addEventListener('i18n-change', () => {
      _updateAgentPickerChrome();
      if (picker.style.display !== 'none') {
        const search = document.getElementById('agent-picker-search');
        _renderAgentPickerList(search ? search.value : '');
      }
    });
  }

}
