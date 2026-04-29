const _agentsLog = createLogger('agents');
// ─── Agents (three-column: list / detail / inline edit chat) ───

let _agentsCache = null;
let _selectedAgent = null; // { id, name, source }
let _agentEditing = false;
let _agentFieldSaveTimer = null;

// Mirror of `agents.ts::RESERVED_AGENT_NAMES` so the renderer can fail fast
// without a round-trip. Server is still authoritative — this is just UX.
const _RESERVED_AGENT_NAMES = new Set(['指挥官', '总指挥', 'commander']);
function _isReservedAgentName(name) {
  const key = String(name || '').replace(/\s+/g, '').toLowerCase();
  return _RESERVED_AGENT_NAMES.has(key);
}

async function loadAgents(forceRefresh) {
  if (_agentsCache && !forceRefresh) { renderAgentsList(_agentsCache); return; }
  try {
    const res = await apiFetch('/api/agents/list');
    const data = await res.json();
    if (data.ok) {
      _agentsCache = data.agents || [];
      renderAgentsList(_agentsCache);
      // 老 spec 没存头像时回填到磁盘 —— 跨设备一致用 seed 派生（同一
      // agent_id 在任何机器都派生出同一组合，避免云同步时两端各写不同
      // 值导致冲突）。已经有 icon+color 的 entry 直接跳过，所以反复
      // 调用 loadAgents 不会重复写。后台异步即可，不阻塞渲染：渲染层
      // 自己也会用 seed 兜底，跟回填值一致，所以肉眼不会看到任何变化。
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
      // 失败也无所谓 —— 渲染层 seed 兜底依然会出同一组合，
      // 下次 loadAgents 再尝试。
      _agentsLog.warn(`backfill ${a.agent_id} failed`, e);
    }
  }
  _agentsLog.info(`avatar backfill: ${missing.length} agent(s)`);
}

function renderAgentsList(agents) { renderAgentsGrid(agents); }

function renderAgentsGrid(agents) {
  const custom = agents.filter(a => a.source === 'custom');
  const builtin = agents.filter(a => a.source === 'builtin');
  const emptyEl = document.getElementById('agents-empty');
  const customGroup = document.getElementById('agents-grid-custom-group');
  const builtinGroup = document.getElementById('agents-grid-builtin-group');
  const customGrid = document.getElementById('agents-grid-custom');
  const builtinGrid = document.getElementById('agents-grid-builtin');

  if (!agents.length) {
    if (emptyEl) emptyEl.style.display = '';
    if (customGroup) customGroup.style.display = 'none';
    if (builtinGroup) builtinGroup.style.display = 'none';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';

  const useTitle = escapeHtml(t('agents.use_tooltip'));
  const moreTitle = escapeHtml(t('agents.more_actions'));

  const cardHtml = (a) => {
    const enabled = a.enabled !== false;
    const desc = pickDesc(a, getLang()).trim();
    const descClass = desc ? 'agent-card-desc' : 'agent-card-desc is-empty';
    const descText = desc || t('agents.placeholder_unset');
    const sourceLabel = a.source === 'custom' ? t('agents.source_custom') : t('agents.source_builtin');
    const sourceCls = a.source === 'custom' ? 'is-custom' : 'is-builtin';
    const moreBtn = `<button type="button" class="agent-card-more" data-agent-more title="${moreTitle}" aria-label="${moreTitle}">⋯</button>`;
    const toggleTitle = escapeHtml(enabled ? t('component.toggle_disable_hint') : t('component.toggle_enable_hint'));
    const toggle = `<label class="toggle-switch is-compact" data-agent-toggle title="${toggleTitle}" aria-label="${toggleTitle}">
        <input type="checkbox" data-agent-toggle-input ${enabled ? 'checked' : ''} />
      </label>`;
    const avatarHtml = renderAvatarHtml(a.icon, a.color, { size: 32, seed: a.agent_id, extraClass: 'agent-card-avatar' });
    return `
      <div class="agent-card${enabled ? '' : ' is-disabled'}" data-id="${escapeHtml(a.agent_id)}" data-source="${a.source}">
        <div class="agent-card-header">
          ${avatarHtml}
          <span class="agent-card-name">${escapeHtml(a.name || t('agents.unnamed'))}</span>
          <span class="agent-card-source ${sourceCls}">${escapeHtml(sourceLabel)}</span>
          ${toggle}
          ${moreBtn}
        </div>
        <div class="${descClass}">${escapeHtml(descText)}</div>
        <div class="agent-card-actions">
          <button type="button" class="agent-card-use" data-agent-use title="${useTitle}" aria-label="${useTitle}">▶</button>
        </div>
      </div>
    `;
  };

  const renderGroup = (list, group, gridEl) => {
    if (!list.length) { group.style.display = 'none'; return; }
    group.style.display = '';
    gridEl.innerHTML = list.map(cardHtml).join('');
  };
  renderGroup(custom, customGroup, customGrid);
  renderGroup(builtin, builtinGroup, builtinGrid);

  for (const card of document.querySelectorAll('.agent-card')) {
    const id = card.dataset.id;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-agent-toggle]')) {
        e.stopPropagation();
        return;
      }
      if (e.target.closest('[data-agent-use]')) {
        e.stopPropagation();
        useAgent(id);
        return;
      }
      if (e.target.closest('[data-agent-more]')) {
        e.stopPropagation();
        _toggleAgentRowMenu(e.target.closest('[data-agent-more]'), id);
        return;
      }
      _showAgentsDetailView(id);
    });
    const toggleInput = card.querySelector('[data-agent-toggle-input]');
    toggleInput?.addEventListener('change', async (e) => {
      e.stopPropagation();
      await _flipAgentEnabledFromCard(id, toggleInput);
    });
  }
}

async function _flipAgentEnabledFromCard(agentId, input) {
  const next = input.checked;
  input.disabled = true;
  try {
    const res = await window.orkas.invoke('agents.setEnabled', { agent_id: agentId, enabled: next });
    if (!res || !res.ok) {
      input.checked = !next;
      await uiAlert(t('component.toggle_failed'));
      return;
    }
    const card = input.closest('.agent-card');
    if (card) card.classList.toggle('is-disabled', !next);
    const cached = _agentsCache?.find((a) => a.agent_id === agentId);
    if (cached) cached.enabled = next;
    await loadAgents(true);
  } catch (err) {
    input.checked = !next;
    await uiAlert(t('component.toggle_failed'));
  } finally {
    input.disabled = false;
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
  await selectAgent(agentId);
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

function _toggleAgentRowMenu(anchorBtn, agentId) {
  const menu = document.getElementById('agent-row-menu');
  if (!menu) return;
  // Toggle off if already open for this same anchor.
  if (menu.style.display !== 'none' && menu.dataset.agentId === agentId) {
    _closeAgentRowMenu();
    return;
  }
  // Reset any prior sticky row before marking the new one.
  for (const el of document.querySelectorAll('.agent-item.is-menu-open')) {
    el.classList.remove('is-menu-open');
  }
  anchorBtn.closest('.agent-item')?.classList.add('is-menu-open');
  menu.dataset.agentId = agentId;
  // Re-render menu items per-open: builtin gets only enable/disable, custom
  // gets edit / delete / enable-disable. Per-row state (enabled?) drives the
  // toggle item label. Done as innerHTML rebuild because there are only
  // ~3 items max and binding cost is negligible.
  _renderAgentRowMenuItems(menu, agentId);
  _positionRowMenu(menu, anchorBtn);
  if (!menu.dataset.bound) {
    menu.dataset.bound = '1';
    document.addEventListener('click', (e) => {
      if (menu.style.display === 'none') return;
      if (menu.contains(e.target)) return;
      if (e.target.closest('.agent-item-more')) return;
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

/** Render the per-row "⋯" menu items based on the target agent's source +
 *  enabled state. Called fresh on each open so the toggle label is right
 *  and builtin agents see only the enable/disable item. */
function _renderAgentRowMenuItems(menu, agentId) {
  const a = _agentsCache?.find((x) => x.agent_id === agentId);
  const enabled = a ? a.enabled !== false : true;
  const isCustom = a?.source === 'custom';
  const toggleLabel = enabled ? t('component.disable') : t('component.enable');
  const items = [];
  if (isCustom) {
    items.push(`<div class="agent-row-menu-item" data-action="edit">${escapeHtml(t('agents.edit'))}</div>`);
  }
  items.push(`<div class="agent-row-menu-item" data-action="toggle-enabled">${escapeHtml(toggleLabel)}</div>`);
  if (isCustom) {
    items.push(`<div class="agent-row-menu-item is-danger" data-action="delete">${escapeHtml(t('agents.delete'))}</div>`);
  }
  menu.innerHTML = items.join('');
  for (const item of menu.querySelectorAll('.agent-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      const aid = menu.dataset.agentId;
      _closeAgentRowMenu();
      if (!aid) return;
      if (action === 'edit') {
        await _showAgentsDetailView(aid);
        if (!_agentEditing) await toggleAgentEditMode();
      } else if (action === 'delete') {
        if (_selectedAgent?.id !== aid) await selectAgent(aid);
        await deleteSelectedAgent();
      } else if (action === 'toggle-enabled') {
        await _flipAgentEnabledFromMenu(aid);
      }
    });
  }
}

async function _flipAgentEnabledFromMenu(agentId) {
  const cached = _agentsCache?.find((x) => x.agent_id === agentId);
  const next = !(cached?.enabled !== false);
  try {
    const res = await window.orkas.invoke('agents.setEnabled', { agent_id: agentId, enabled: next });
    if (!res || !res.ok) {
      await uiAlert(t('component.toggle_failed'));
      return;
    }
    if (cached) cached.enabled = next;
    await loadAgents(true);
  } catch (err) {
    _agentsLog.warn('agents.setEnabled failed', err);
    await uiAlert(t('component.toggle_failed'));
  }
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

function _renderAgentDetail(agent, editing) {
  document.getElementById('agents-detail-content').style.display = '';

  const nameEl = document.getElementById('agents-detail-name');
  const sourceEl = document.getElementById('agents-detail-source');
  const descEl = document.getElementById('agents-detail-desc');
  const workflowEl = document.getElementById('agents-detail-workflow');
  const editBtn = document.getElementById('agent-edit-btn');

  nameEl.textContent = agent.name || '';
  sourceEl.textContent = agent.source === 'builtin' ? t('agents.source_builtin') : t('agents.source_custom');
  sourceEl.className = 'agents-detail-source ' + (agent.source === 'builtin' ? 'is-builtin' : 'is-custom');
  const localizedDesc = pickDesc(agent, getLang()).trim();
  descEl.textContent = localizedDesc;

  _renderAgentDetailAvatar(agent);

  const unsetHtml = `<span class="agents-detail-placeholder">${escapeHtml(t('agents.placeholder_unset'))}</span>`;
  // Workflow renders markdown in readonly mode; raw text in edit mode so user
  // can edit source directly.
  if (editing) {
    workflowEl.textContent = agent.workflow || '';
  } else {
    workflowEl.innerHTML = agent.workflow ? renderMarkdownFull(agent.workflow) : unsetHtml;
  }
  if (!editing && !localizedDesc) descEl.innerHTML = unsetHtml;

  // Detail header actions: 使用 / 编辑 / 删除 + 启用 toggle. Builtin agents
  // hide 编辑 and 删除 (spec-immutable); 编辑 button doubles as 完成 while
  // in edit mode and 使用/删除 hide so the user can't accidentally launch
  // or destroy a half-edited agent.
  const useBtn = document.getElementById('agent-use-btn');
  const delBtn = document.getElementById('agent-delete-btn');
  const isCustom = agent.source === 'custom';
  if (useBtn) useBtn.style.display = editing ? 'none' : '';
  if (delBtn) delBtn.style.display = (isCustom && !editing) ? '' : 'none';
  if (editBtn) {
    editBtn.style.display = isCustom ? '' : 'none';
    editBtn.textContent = editing ? t('agents.edit_btn_done') : t('agents.edit_btn_edit');
  }
  _renderAgentEnabledToggle({ id: agent.agent_id, enabled: agent.enabled !== false });

  _toggleAgentFieldEditable(editing);
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
    size: 44,
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

function _renderAgentEnabledToggle(agent) {
  const wrap = document.getElementById('agent-enabled-toggle-wrap');
  const oldInput = document.getElementById('agent-enabled-toggle');
  const label = document.getElementById('agent-enabled-label');
  if (!wrap || !oldInput || !label) return;
  const enabled = agent.enabled !== false;
  // Clone-replace to drop any prior change listener bound for a different agent.
  const input = oldInput.cloneNode(true);
  input.checked = enabled;
  oldInput.parentNode.replaceChild(input, oldInput);
  label.textContent = enabled ? t('component.enabled') : t('component.disabled');
  wrap.classList.toggle('is-disabled', !enabled);
  wrap.title = enabled ? t('component.toggle_disable_hint') : t('component.toggle_enable_hint');
  input.addEventListener('change', async () => {
    const next = input.checked;
    input.disabled = true;
    try {
      const res = await window.orkas.invoke('agents.setEnabled', { agent_id: agent.id, enabled: next });
      if (!res || !res.ok) {
        input.checked = !next;
        await uiAlert(t('component.toggle_failed'));
        return;
      }
      label.textContent = next ? t('component.enabled') : t('component.disabled');
      wrap.classList.toggle('is-disabled', !next);
      wrap.title = next ? t('component.toggle_disable_hint') : t('component.toggle_enable_hint');
      const cached = _agentsCache?.find((a) => a.agent_id === agent.id);
      if (cached) cached.enabled = next;
      await loadAgents(true);
    } catch (err) {
      input.checked = !next;
      await uiAlert(t('component.toggle_failed'));
    } finally {
      input.disabled = false;
    }
  });
}

function _toggleAgentFieldEditable(on) {
  const nameEl = document.getElementById('agents-detail-name');
  const descEl = document.getElementById('agents-detail-desc');
  const workflowEl = document.getElementById('agents-detail-workflow');
  for (const el of [nameEl, descEl, workflowEl]) {
    el.setAttribute('contenteditable', on ? 'plaintext-only' : 'false');
    el.classList.toggle('is-editing', on);
  }
}

async function toggleAgentEditMode() {
  if (!_selectedAgent) return;
  if (_selectedAgent.source === 'builtin') return;
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
  document.getElementById('agents-chat-col').style.display = '';
  await _loadAgentChatHistory(_selectedAgent.id);
  setTimeout(() => document.getElementById('agents-chat-input')?.focus(), 50);
  // Wire field blur-save (one-time attach)
  _bindAgentFieldSave();
}

async function _exitAgentEditMode() {
  _agentEditing = false;
  // Flush any pending save and then re-render in readonly mode.
  await _flushAgentFieldSave();
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
    ['agents-detail-name', 'name'],
    ['agents-detail-desc', 'description'],
    ['agents-detail-workflow', 'workflow'],
  ];
  for (const [id, field] of fields) {
    const el = document.getElementById(id);
    if (el.dataset.bound === '1') continue;
    el.dataset.bound = '1';
    el.addEventListener('input', () => _scheduleAgentFieldSave(field, el.innerText));
    el.addEventListener('blur', () => _flushAgentFieldSave());
  }
}

function _scheduleAgentFieldSave(field, value) {
  if (!_selectedAgent || _selectedAgent.source === 'builtin') return;
  _pendingAgentField = { field, value };
  clearTimeout(_agentFieldSaveTimer);
  _agentFieldSaveTimer = setTimeout(_flushAgentFieldSave, 800);
}

let _pendingAgentField = null;
async function _flushAgentFieldSave() {
  clearTimeout(_agentFieldSaveTimer);
  _agentFieldSaveTimer = null;
  if (!_pendingAgentField || !_selectedAgent) return;
  const { field, value } = _pendingAgentField;
  _pendingAgentField = null;
  // Block reserved names locally — otherwise the PUT silently fails server-
  // side and the renderer DOM keeps the bad value until the next reload.
  if (field === 'name' && _isReservedAgentName(value)) {
    await uiAlert(t('agents.name_reserved'));
    // Revert the inline editor to the last known-good name and refresh list.
    const nameEl = document.getElementById('agents-detail-name');
    if (nameEl && _selectedAgent.name) nameEl.innerText = _selectedAgent.name;
    return;
  }
  try {
    const res = await apiFetch(`/api/agents/${encodeURIComponent(_selectedAgent.id)}/update`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    _agentsCache = null; // list may need a name refresh
  } catch (e) {
    _agentsLog.warn('save agent field failed', e);
    if (field === 'name') {
      await uiAlert(e.message || t('agents.create_failed'));
      const nameEl = document.getElementById('agents-detail-name');
      if (nameEl && _selectedAgent.name) nameEl.innerText = _selectedAgent.name;
    }
  }
}

// ─── Create agent (modal-first, mirrors skill flow) ───

function openAgentModal() {
  const modal = document.getElementById('agent-modal');
  const nameInput = document.getElementById('agent-name-input');
  const descInput = document.getElementById('agent-desc-input');
  const msgEl = document.getElementById('agent-form-msg');
  nameInput.value = '';
  descInput.value = '';
  msgEl.textContent = '';
  msgEl.className = 'form-msg';
  modal.classList.add('open');
  setTimeout(() => nameInput.focus(), 50);
}
window.openAgentModal = openAgentModal;

function closeAgentModal() {
  document.getElementById('agent-modal').classList.remove('open');
}
window.closeAgentModal = closeAgentModal;

async function saveAgentModal() {
  const name = document.getElementById('agent-name-input').value.trim();
  const description = document.getElementById('agent-desc-input').value.trim();
  const msgEl = document.getElementById('agent-form-msg');

  if (!name) {
    msgEl.textContent = t('agents.input_name_needed');
    msgEl.className = 'form-msg err';
    document.getElementById('agent-name-input').focus();
    return;
  }
  if (_isReservedAgentName(name)) {
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

  try {
    // 创建时本地随机一对头像，让每个新智能体一上来就有不同的视觉锚点。
    // 不让 LLM 介入 —— 头像是 UI 元数据，不影响 prompt 行为。
    const avatar = randomAgentAvatar();
    const res = await apiFetch('/api/agents/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, icon: avatar.icon, color: avatar.color }),
    });
    const data = await res.json();
    if (!data.ok || !data.agent) {
      msgEl.textContent = data.error || t('agents.create_failed');
      msgEl.className = 'form-msg err';
      return;
    }
    closeAgentModal();
    setView('agents');
    await loadAgents(true);
    await _showAgentsDetailView(data.agent.agent_id);
    await _enterAgentEditMode();
    // Auto-seed: use the user's description as context for the LLM so it
    // starts refining the workflow without the user having to restate it.
    const seed = t('agents.seed_workflow', { description });
    await _autoSendAgentChat(seed);
  } catch (e) {
    msgEl.textContent = t('agents.network_error', { reason: e.message || e });
    msgEl.className = 'form-msg err';
  }
}
window.saveAgentModal = saveAgentModal;

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
  if (!_selectedAgent || _selectedAgent.source === 'builtin') return;
  if (!(await uiConfirm(t('agents.delete_confirm')))) return;
  const agentId = _selectedAgent.id;
  try {
    const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`,
      { method: 'DELETE' });
    const data = await res.json();
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
function _ensureAgentChatController() {
  if (_agentChatCtrl) return _agentChatCtrl;
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
  // Custom empty-state message for fresh agents — controller's default is
  // "无对话记录..."; replace it with an agent-specific prompt when empty.
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

// ─── "使用" flow: new normal conversation seeded with "运行 <name>" ───

/**
 * Run an agent: creates a fresh normal conversation, navigates to it, then
 * auto-sends a short user-visible message ("运行 <name>"). The model sees
 * the same visible text and recognises it as a run-agent directive per
 * chat_commander.md rule 0 (instruction following) — no hidden backend injection.
 *
 * `seedText` is the user-visible content. Defaults to "运行 <name>".
 */
async function useAgent(agentId, seedText) {
  if (!ensureModelConfigured()) return;
  _agentsLog.info('use agent', { agent_id: agentId, has_seed: !!(seedText && seedText.trim()) });
  try {
    // Look up the agent so we can title the conv + derive default seed text.
    const aRes = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`);
    const aData = await aRes.json();
    if (!aData.ok || !aData.agent) throw new Error(aData.error || t('agents.agent_not_found'));
    const agent = aData.agent;

    const visible = (seedText || '').trim() || t('agents.run_prefix', { name: agent.name || agent.agent_id });

    const res = await apiFetch('/api/conversations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: agent.name || '' }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || t('agents.create_conv_failed'));
    const conv = data.conversation;
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
  // Skill 使用：跳转到新对话页，预选该技能，等用户输入。
  _agentsLog.info('use skill', { skill_id: skillId, skill_name: skillName || skillId });
  setView('new-chat');
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

function _openAgentPicker(anchorBtn) {
  const picker = document.getElementById('agent-picker');
  if (!anchorBtn || !picker) return;
  picker.dataset.anchorId = anchorBtn.id;
  // Render first so measurement in _positionPopoverAboveOrBelow reflects
  // the real list height (not stale content from a previous open).
  _renderAgentPickerList('');
  _positionPopoverAboveOrBelow(picker, anchorBtn);
  setTimeout(() => document.getElementById('agent-picker-search')?.focus(), 30);
}

function _closeAgentPicker() {
  const picker = document.getElementById('agent-picker');
  if (picker) picker.style.display = 'none';
  // NOTE: callers that close-without-selection (Esc / click-outside) must
  // also clear `_atKeyMark` — otherwise the next picker open would consume
  // a stale `@`. Selection callers leave the mark so _triggerAgent can use
  // it before clearing.
}

function _renderAgentPickerList(filterText) {
  const listEl = document.getElementById('agent-picker-list');
  const picker = document.getElementById('agent-picker');
  const anchorId = picker?.dataset.anchorId || '';
  // Disabled agents are filtered out — picker is a "what can I dispatch right
  // now" UI, and re-enabling lives in the management page (Agents view + ⋯ menu).
  const agents = (_agentsCache || []).filter((a) => a.enabled !== false);
  const q = (filterText || '').toLowerCase();
  // Search matches across the active locale description; cross-language
  // fallback via pickDesc lets users find a single-locale agent regardless
  // of which side they typed in.
  const lang = getLang();
  const filtered = q
    ? agents.filter(a => (a.name || '').toLowerCase().includes(q) || pickDesc(a, lang).toLowerCase().includes(q))
    : agents;
  // Recipient chip exposes "commander" as a virtual top entry so the user can
  // switch back without an empty-state. Other anchors keep agent-only listing.
  const isRecipientPicker = anchorId === 'chat-recipient-chip' || anchorId === 'new-chat-recipient-chip';
  const commanderName = t('chat.recipient_commander');
  const commanderMatchesFilter = !q || commanderName.toLowerCase().includes(q);
  if (!filtered.length && !(isRecipientPicker && commanderMatchesFilter)) {
    listEl.innerHTML = `<div class="skill-picker-item" style="color:#9ca3af">${escapeHtml(t('agents.no_match'))}</div>`;
    return;
  }
  const groups = { custom: [], builtin: [] };
  for (const a of filtered) (groups[a.source] || groups.custom).push(a);
  const groupHtml = (label, list) => {
    if (!list.length) return '';
    return `<div class="skill-picker-group-label">${escapeHtml(label)}</div>` +
      list.map(a => {
        const aDesc = pickDesc(a, lang).trim();
        return `
        <div class="skill-picker-item" data-id="${escapeHtml(a.agent_id)}" data-name="${escapeHtml(a.name || a.agent_id)}">
          <div>${escapeHtml(a.name || t('agents.unnamed'))}</div>
          ${aDesc ? `<div style="font-size:11px;color:#9ca3af;margin-top:2px">${escapeHtml(aDesc)}</div>` : ''}
        </div>`;
      }).join('');
  };
  const commanderHtml = (isRecipientPicker && commanderMatchesFilter)
    ? `<div class="skill-picker-item" data-id="__commander__" data-name="${escapeHtml(commanderName)}">
         <div>${escapeHtml(commanderName)}</div>
         <div style="font-size:11px;color:#9ca3af;margin-top:2px">${escapeHtml(t('chat.recipient_commander_hint'))}</div>
       </div>`
    : '';
  listEl.innerHTML = commanderHtml + groupHtml(t('agents.source_custom'), groups.custom) + groupHtml(t('agents.source_builtin'), groups.builtin);
  for (const el of listEl.querySelectorAll('[data-id]')) {
    el.addEventListener('click', async () => {
      _closeAgentPicker();
      await _triggerAgent(el.dataset.id, el.dataset.name, anchorId);
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

// Route an agent selection to the right behaviour based on which button
// triggered the picker:
//   - conversation toolbar → send/queue "运行 <name>" in the CURRENT conv.
//     Never opens a new conv. No hidden backend injection — the model reads
//     the visible message and follows chat_commander.md rule 0.
//   - new-chat toolbar → create a new normal conv + run agent (useAgent)
// Selection is one-shot (no persistent chip).
async function _triggerAgent(agentId, agentName, anchorId) {
  const isRecipientAnchor = anchorId === 'chat-recipient-chip' || anchorId === 'new-chat-recipient-chip';
  if (isRecipientAnchor) {
    const target = anchorId === 'new-chat-recipient-chip' ? 'new-chat' : 'conversation';
    if (agentId === '__commander__') {
      setChatRecipient(target, { kind: 'commander' });
    } else {
      setChatRecipient(target, { kind: 'agent', id: agentId, name: agentName || agentId });
    }
    // If the picker was opened by the user typing `@` in the textarea, that
    // `@` is now redundant (the chip carries the recipient) and would also
    // leak into the sent text — strip it.
    _consumeAtKeyChar();
    const inputId = target === 'new-chat' ? 'new-chat-input' : 'chat-input';
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

function bindAgentPickers() {
  // Re-bindable helper: wire the recipient chips on both chat panels +
  // under anchorIds. Guarded with dataset.bound so a second call is a no-op.
  const searchInput = document.getElementById('agent-picker-search');
  searchInput?.addEventListener('input', () => {
    _renderAgentPickerList(searchInput.value);
  });
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { _atKeyMark = null; _closeAgentPicker(); e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { _moveAgentPickerActive(1); e.preventDefault(); return; }
    if (e.key === 'ArrowUp')   { _moveAgentPickerActive(-1); e.preventDefault(); return; }
    if (e.key === 'Enter') {
      const listEl = document.getElementById('agent-picker-list');
      const active = listEl?.querySelector('.skill-picker-item.active[data-id]')
        || listEl?.querySelector('.skill-picker-item[data-id]');
      if (active) { active.click(); e.preventDefault(); }
    }
  });
  for (const id of ['chat-recipient-chip', 'new-chat-recipient-chip']) {
    const btn = document.getElementById(id);
    if (!btn || btn.dataset.bound === '1') continue;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      _atKeyMark = null; // chip click is not a `@`-keystroke trigger
      if (!_agentsCache) await loadAgents();
      const picker = document.getElementById('agent-picker');
      if (picker && picker.style.display !== 'none' &&
          picker.dataset.anchorId === id) {
        _closeAgentPicker();
      } else {
        _openAgentPicker(btn);
      }
    });
  }

  // `@` keystroke in either chat textarea opens the recipient picker. The
  // typed `@` itself is removed on a successful pick (see _consumeAtKeyChar)
  // so the chip is the single source of truth for recipient.
  const onAtKey = (anchorId) => (e) => {
    if (e.key !== '@') return;
    const btn = document.getElementById(anchorId);
    if (!btn) return;
    const ta = e.currentTarget;
    setTimeout(() => {
      // After the default insertion, selectionStart sits one past the `@`.
      _atKeyMark = {
        inputId: ta.id || '',
        posAfter: typeof ta.selectionStart === 'number' ? ta.selectionStart : 0,
      };
      if (!_agentsCache) loadAgents().then(() => _openAgentPicker(btn));
      else _openAgentPicker(btn);
    }, 0);
  };
  // Backspace right after a `@<name>` token (with or without the trailing
  // space the picker inserts) should remove the whole mention as one unit
  // — character-by-character deletion of `@张三 ` is annoying when the
  // user picked the wrong agent. Match the same charset as the bus
  // mention regex so `@中文名字` works.
  const MENTION_DELETE_RE = /@[A-Za-z0-9_一-鿿-]+ ?$/u;
  const onBackspaceMention = (e) => {
    if (e.key !== 'Backspace') return;
    if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
    const ta = e.currentTarget;
    if (!ta || typeof ta.selectionStart !== 'number') return;
    if (ta.selectionStart !== ta.selectionEnd) return; // user has a selection — let default handle
    const caret = ta.selectionStart;
    if (caret === 0) return;
    const left = ta.value.slice(0, caret);
    const m = MENTION_DELETE_RE.exec(left);
    if (!m) return;
    const start = caret - m[0].length;
    e.preventDefault();
    ta.value = ta.value.slice(0, start) + ta.value.slice(caret);
    try { ta.setSelectionRange(start, start); } catch (_) {}
    if (typeof autoGrow === 'function') autoGrow(ta, 200);
    // Trigger input event so any debounced draft savers / autosize hooks
    // re-run; not all listeners fire from setSelectionRange alone.
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const newChatInput = document.getElementById('new-chat-input');
  if (newChatInput && !newChatInput.dataset.atBound) {
    newChatInput.dataset.atBound = '1';
    newChatInput.addEventListener('keydown', onAtKey('new-chat-recipient-chip'));
    newChatInput.addEventListener('keydown', onBackspaceMention);
  }
  const chatInput = document.getElementById('chat-input');
  if (chatInput && !chatInput.dataset.atBound) {
    chatInput.dataset.atBound = '1';
    chatInput.addEventListener('keydown', onAtKey('chat-recipient-chip'));
    chatInput.addEventListener('keydown', onBackspaceMention);
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
  }

}

