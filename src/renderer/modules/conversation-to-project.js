/* Orkas Frontend — file a loose task under a project
 *
 * Reachable from the `⋯` menu of a conversation that has no project. One picker offers two
 * flows, both ending in the same `conversations.move` call:
 *
 *   New project    — ask for a name, create it through the same channel the
 *                    sidebar's inline create uses, move the conversation in,
 *                    then add the agents selected in the picker.
 *   Add to project — pick an existing project, move, and add the selected agents.
 *
 * The move is never optimistic: it relocates the conversation's messages,
 * sessions, attachments and artifacts on disk and can legitimately refuse (a
 * running turn), so the sidebar is only updated once the backend confirms.
 *
 * Loaded as a top-level renderer module, so these are globals for
 * `conversation.js::_conversationActionItems`. Renderer rules (PC/CLAUDE.md
 * §8) forbid `import`/`export` here.
 */

/** Backend refusal codes → the copy that tells the user what to do next. */
const _CONV_MOVE_ERROR_KEYS = {
  has_running_conv: 'chat.conv_move_running',
  already_in_project: 'chat.conv_move_already',
  project_not_found: 'chat.conv_move_no_project',
};

function _convMoveErrorText(code) {
  const key = _CONV_MOVE_ERROR_KEYS[String(code || '')] || 'chat.conv_move_failed';
  return t(key);
}

function _convMoveRow(cid) {
  return Array.isArray(conversations)
    ? conversations.find((c) => c && c.conversation_id === cid)
    : null;
}

/**
 * Agents that took part in the conversation.
 *
 * The row's `agent_ids` is a denormalized sidebar summary that can lag behind
 * the roster, and the starting agent may never have been @-mentioned, so the
 * three sources are unioned: the summary, the starting agent, and the actor
 * list the turns actually used.
 */
async function _convMoveAgentIds(cid, conv, names = new Map()) {
  const ids = new Set();
  if (Array.isArray(conv && conv.agent_ids)) {
    for (const id of conv.agent_ids) if (id) ids.add(String(id));
  }
  if (conv && conv.agent_id) ids.add(String(conv.agent_id));
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/members`);
    const data = await res.json();
    for (const actor of (data && data.actors) || []) {
      if (actor && actor.kind === 'agent' && actor.id) {
        ids.add(String(actor.id));
        if (actor.name) names.set(String(actor.id), actor.name);
      }
    }
  } catch (_) { /* the denormalized summary is the fallback */ }
  return [...ids].filter((id) => !_isCommanderAgent(id));
}

/** Read lightweight names once; roster names remain useful for deleted agents. */
async function _convMoveAgents(cid, conv) {
  const names = new Map();
  const [ids, summaries] = await Promise.all([
    _convMoveAgentIds(cid, conv, names),
    apiFetch('/api/agents/list?summary=1').then((res) => res.json()).catch(() => null),
  ]);
  const details = new Map();
  for (const agent of (summaries && summaries.agents) || []) {
    if (agent.agent_id) details.set(agent.agent_id, agent);
    if (agent.agent_id && agent.name) names.set(agent.agent_id, agent.name);
  }
  return ids.map((id) => ({
    id, name: names.get(id) || id, icon: details.get(id)?.icon, color: details.get(id)?.color,
  }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function _requestConversationMove(cid, projectId) {
  const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/move`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
  const data = await res.json();
  if (!data || data.ok === false || !data.conversation) {
    throw new Error((data && data.error) || 'move_failed');
  }
  return data.conversation;
}

/** Re-home the cached row so the sidebar nests it under the project, then let
 *  the authoritative loaders correct counts and pagination. */
async function _applyConversationMoved(cid, moved) {
  if (Array.isArray(conversations)) {
    const idx = conversations.findIndex((c) => c && c.conversation_id === cid);
    if (idx >= 0) conversations[idx] = { ...conversations[idx], ...moved };
  }
  if (typeof _sortConversationCacheForSidebar === 'function') _sortConversationCacheForSidebar();
  if (typeof renderConversationList === 'function') renderConversationList();
  if (typeof _refreshChatHeader === 'function') _refreshChatHeader();
  if (typeof loadProjects === 'function') {
    try { await loadProjects(true); } catch (_) { /* sidebar counts refresh on the next load */ }
  }
}

/** Bind the conversation's agents to the project. Failures are per agent and
 *  never undo the move: `projects.bindings.add` rejects a disabled agent, and
 *  losing one binding is not a reason to leave the task where it was. */
async function _bindConversationAgentsToProject(projectId, agentIds) {
  let bound = 0;
  for (const agentId of agentIds) {
    try {
      const res = await window.orkas.invoke('projects.bindings.add', { projectId, kind: 'agent', id: agentId });
      if (res && res.ok !== false) bound++;
    } catch (_) { /* reported in aggregate by the caller's toast */ }
  }
  return bound;
}

async function _moveConversationToNewProject(cid, agentIds) {
  const conv = _convMoveRow(cid);
  if (!conv || conv.project_id) return;
  if (isConvPending(cid)) { uiToast(t('chat.conv_move_running')); return; }
  const raw = await uiPrompt(t('chat.conv_new_project_prompt'), '', { nameLimit: true });
  if (raw === null) return;
  const name = typeof _normaliseProjectNameFinal === 'function'
    ? _normaliseProjectNameFinal(raw)
    : String(raw || '').trim();
  if (!name) { uiToast(t('project.name_empty')); return; }

  let projectId = '';
  try {
    const res = await window.orkas.invoke('projects.create', { name });
    if (!res || !res.ok || !res.project) {
      uiToast(typeof _projectInlineErrorText === 'function'
        ? _projectInlineErrorText(res && res.error)
        : t('project.error.generic'));
      return;
    }
    projectId = res.project.project_id;
  } catch (_) {
    uiToast(t('project.error.generic'));
    return;
  }

  // The project exists from here on. A refused move leaves the user with an
  // empty project rather than a silent no-op, which is recoverable and
  // visible; deleting it behind their back is not.
  try {
    const moved = await _requestConversationMove(cid, projectId);
    await _applyConversationMoved(cid, moved);
  } catch (err) {
    uiToast(_convMoveErrorText(err && err.message));
    if (typeof loadProjects === 'function') { try { await loadProjects(true); } catch (_) { /* ignore */ } }
    return;
  }
  await _finishConversationProjectMove(projectId, name, agentIds);
}

async function _finishConversationProjectMove(projectId, name, agentIds) {
  const bound = await _bindConversationAgentsToProject(projectId, agentIds);
  if (typeof loadProjects === 'function') { try { await loadProjects(true); } catch (_) { /* refreshed on next load */ } }
  const failed = agentIds.length - bound;
  uiToast(failed > 0
    ? t('chat.conv_moved_agents_failed', { name, count: failed })
    : t('chat.conv_moved', { name }));
}

function _convProjectIcon() {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml('folder', 'conv-project-pick-icon');
  }
  return '';
}

/**
 * Pick one project from a list, then confirm.
 *
 * A row per project rather than a row of buttons: the list reads as the thing
 * being chosen from, Cancel stays visibly secondary next to a real primary
 * action, and one stray click can no longer move a task. Resolves to the
 * chosen project and agent ids, or null.
 */
let _closeConversationProjectPicker = null;

function _openConversationProjectPicker(projects, agents = []) {
  if (_closeConversationProjectPicker) _closeConversationProjectPicker(null);
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.id = 'conv-project-picker-overlay';
    overlay.className = 'modal-overlay ui-dialog-overlay conv-project-picker-overlay open';
    const rows = projects.map((project) => `
      <button type="button" class="conv-project-pick-row" role="option" aria-selected="false"
              data-project-id="${escapeHtml(project.project_id)}">
        ${_convProjectIcon()}
        <span class="conv-project-pick-name">${escapeHtml(project.name || project.project_id)}</span>
      </button>
    `).join('');
    overlay.innerHTML = `
      <div class="modal modal-standard conv-project-picker" role="dialog" aria-modal="true"
           aria-labelledby="conv-project-picker-title" aria-describedby="conv-project-picker-hint">
        <div class="modal-title conv-project-picker-title" id="conv-project-picker-title" data-i18n="chat.conv_to_project">${escapeHtml(t('chat.conv_to_project'))}</div>
        <div class="conv-project-picker-hint" id="conv-project-picker-hint" data-i18n="chat.conv_pick_project_message">${escapeHtml(t('chat.conv_pick_project_message'))}</div>
        <div class="conv-project-pick-list" role="listbox" aria-labelledby="conv-project-picker-title">${rows}</div>
        <button type="button" class="btn" data-act="new" data-i18n="chat.conv_to_new_project">${escapeHtml(t('chat.conv_to_new_project'))}</button>
        ${agents.length ? `<fieldset class="conv-project-agents">
          <legend data-i18n="chat.conv_project_agents">${escapeHtml(t('chat.conv_project_agents'))}</legend>
          <div class="conv-project-agent-list">${agents.map((agent) => `
            <label class="ui-dialog-checkbox-row">
              <input type="checkbox" data-agent-id="${escapeHtml(agent.id)}" checked>
              <span aria-hidden="true">${renderAvatarHtml(agent.icon, agent.color, { size: 24, seed: agent.id })}</span>
              <span class="conv-project-agent-name">${escapeHtml(agent.name)}</span>
            </label>`).join('')}</div>
        </fieldset>` : ''}
        <div class="modal-actions">
          <button type="button" class="btn" data-act="cancel" data-i18n="common.cancel">${escapeHtml(t('common.cancel'))}</button>
          <button type="button" class="btn btn-primary" data-act="ok" data-i18n="chat.conv_move_submit" disabled>${escapeHtml(t('chat.conv_move_submit'))}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('[data-act="ok"]');
    const cancelBtn = overlay.querySelector('[data-act="cancel"]');
    // Initial focus and the focus guard agree: a focus change outside the
    // dialog after it opened (a view finishing its own deferred focus)
    // returns to the first choice, never to Cancel.
    const initialFocus = overlay.querySelector('.conv-project-pick-row') || overlay.querySelector('[data-act="new"]');
    const releaseFocusGuard = _uiKeepDialogFocus(overlay, initialFocus);
    const selection = () => ({
      projectId: picked,
      agentIds: [...overlay.querySelectorAll('input[data-agent-id]:checked')].map((el) => el.dataset.agentId),
    });
    let picked = '';
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      releaseFocusGuard();
      if (_closeConversationProjectPicker === finish) _closeConversationProjectPicker = null;
      overlay.remove();
      _uiRestoreDialogFocus(previousFocus);
      resolve(value || null);
    };
    const onKey = (e) => {
      // IME guard (PC/CLAUDE.md §8): Escape mid-composition belongs to the IME.
      if (e.isComposing || e.keyCode === 229) return;
      if (!_uiIsTopDialogOverlay(overlay)) return;
      if (_uiTrapDialogTab(overlay, e)) return;
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };
    _closeConversationProjectPicker = finish;
    overlay.querySelectorAll('.conv-project-pick-row').forEach((row) => {
      row.addEventListener('click', () => {
        picked = row.dataset.projectId || '';
        for (const other of overlay.querySelectorAll('.conv-project-pick-row')) {
          const on = other === row;
          other.classList.toggle('is-picked', on);
          other.setAttribute('aria-selected', String(on));
        }
        okBtn.disabled = !picked;
      });
      row.addEventListener('dblclick', () => { if (picked) finish(selection()); });
    });
    overlay.querySelector('[data-act="new"]').addEventListener('click', () => finish({ ...selection(), create: true }));
    okBtn.addEventListener('click', () => { if (picked) finish(selection()); });
    cancelBtn.addEventListener('click', () => finish(null));
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => {
      if (initialFocus && document.body.contains(overlay) && _uiIsTopDialogOverlay(overlay)) initialFocus.focus();
    }, 0);
  });
}

async function _moveConversationToExistingProject(cid) {
  const conv = _convMoveRow(cid);
  if (!conv || conv.project_id) return;
  if (isConvPending(cid)) { uiToast(t('chat.conv_move_running')); return; }
  let projects = [];
  try {
    const res = await window.orkas.invoke('projects.list', {});
    projects = Array.isArray(res && res.projects) ? res.projects : [];
  } catch (_) { uiToast(t('project.error.generic')); return; }

  const agents = await _convMoveAgents(cid, conv);
  const choice = await _openConversationProjectPicker(projects, agents);
  if (!choice) return;
  if (isConvPending(cid)) { uiToast(t('chat.conv_move_running')); return; }
  if (choice.create) { await _moveConversationToNewProject(cid, choice.agentIds); return; }
  const { projectId, agentIds } = choice;
  const picked = projects.find((p) => p && p.project_id === projectId);

  try {
    const moved = await _requestConversationMove(cid, projectId);
    await _applyConversationMoved(cid, moved);
  } catch (err) {
    uiToast(_convMoveErrorText(err && err.message));
    return;
  }
  await _finishConversationProjectMove(projectId, (picked && picked.name) || projectId, agentIds);
}
