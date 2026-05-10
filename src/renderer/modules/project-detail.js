// ─── Project detail panel ───────────────────────────────────────────────
// Drives `#panel-project`: shows the project's bindings (agents + skills)
// and exposes Add / Remove for each. Opened by clicking a project row in
// the sidebar (`projects.js::_renderProjectRow` — single click both
// expands the row and switches view here).
//
// Header carries 3 actions: + New chat / Rename / Delete. The "Back" button
// was intentionally removed — the sidebar IS the back navigation.
//
// Add picker is a centered modal (`.modal-overlay`) — reuses the existing
// dialog overlay shell so it doesn't get clipped at the panel edge.

const _projectDetailLog = createLogger('project-detail');

let _projectDetailPid = '';     // pid currently rendered in the panel
let _projectDetailMeta = null;  // { project, bindings, agentDetails, skillDetails }

// ── Public: navigate-into ──────────────────────────────────────────────

/** Called by boot.js setView('project', pid) on entry. */
async function loadProjectDetail(pid) {
  _projectDetailPid = pid || '';
  if (!_projectDetailPid) {
    _renderProjectDetailEmpty();
    return;
  }
  try {
    const [getRes, listRes] = await Promise.all([
      window.orkas.invoke('projects.get', { projectId: pid }),
      window.orkas.invoke('projects.bindings.list', { projectId: pid }),
    ]);
    if (!getRes?.ok || !listRes?.ok) {
      throw new Error((getRes && getRes.error) || (listRes && listRes.error) || 'load_failed');
    }
    _projectDetailMeta = {
      project: getRes.project,
      bindings: listRes.bindings || { agents: [], skills: [] },
      agentDetails: Array.isArray(listRes.agentDetails) ? listRes.agentDetails : [],
      skillDetails: Array.isArray(listRes.skillDetails) ? listRes.skillDetails : [],
    };
    _renderProjectDetail();
  } catch (err) {
    _projectDetailLog.warn('load project detail failed', err);
    if (typeof setView === 'function') setView('new-chat');
    if (typeof uiAlert === 'function') uiAlert(t('project.detail_load_failed'));
  }
}

function _renderProjectDetailEmpty() {
  const titleEl = document.getElementById('project-detail-title');
  if (titleEl) titleEl.textContent = '';
  document.getElementById('project-agents-list').innerHTML = '';
  document.getElementById('project-skills-list').innerHTML = '';
}

function _renderProjectDetail() {
  if (!_projectDetailMeta) { _renderProjectDetailEmpty(); return; }
  const { project, bindings, agentDetails, skillDetails } = _projectDetailMeta;

  const titleEl = document.getElementById('project-detail-title');
  if (titleEl) titleEl.textContent = project?.name || '';

  // Stale ids (binding referent missing — agent / skill was deleted).
  const agentValidIds = new Set(agentDetails.map((a) => a.agent_id));
  const skillValidIds = new Set(skillDetails.map((s) => s.id));
  const staleAgents = (bindings.agents || []).filter((id) => !agentValidIds.has(id));
  const staleSkills = (bindings.skills || []).filter((id) => !skillValidIds.has(id));

  document.getElementById('project-agents-list').innerHTML = _renderBindingsRows(
    'agent', agentDetails, staleAgents,
  );
  document.getElementById('project-skills-list').innerHTML = _renderBindingsRows(
    'skill', skillDetails, staleSkills,
  );

  applyDomI18n();
  _bindRemoveButtons();
}

function _renderBindingsRows(kind, items, staleIds) {
  const lang = _activeLang();
  const removeLabel = escapeHtml(t('project.bindings.remove'));
  const rows = [];
  for (const it of items) {
    const id = (kind === 'agent') ? it.agent_id : it.id;
    const name = escapeHtml(it.name || id);
    const desc = _pickItemDescription(it, lang);
    const descHtml = desc ? `<div class="project-binding-desc muted">${escapeHtml(desc)}</div>` : '';
    const sourceTag = it.source ? `<span class="project-binding-source">${escapeHtml(it.source)}</span>` : '';
    rows.push(`
      <div class="project-binding-row" data-kind="${kind}" data-id="${escapeHtml(id)}">
        <div class="project-binding-main">
          <div class="project-binding-head">
            <span class="project-binding-name">${name}</span>
            ${sourceTag}
          </div>
          ${descHtml}
        </div>
        <button type="button" class="btn btn-sm btn-danger" data-action="remove">${removeLabel}</button>
      </div>
    `);
  }
  for (const id of staleIds) {
    rows.push(`
      <div class="project-binding-row project-binding-row--stale" data-kind="${kind}" data-id="${escapeHtml(id)}">
        <div class="project-binding-main">
          <div class="project-binding-head">
            <span class="project-binding-name">${escapeHtml(id)}</span>
            <span class="project-binding-source project-binding-source--stale" data-i18n="project.bindings.stale">Removed</span>
          </div>
        </div>
        <button type="button" class="btn btn-sm" data-action="remove">${removeLabel}</button>
      </div>
    `);
  }
  if (!rows.length) {
    const emptyKey = kind === 'agent' ? 'project.bindings.empty_agents' : 'project.bindings.empty_skills';
    return `<div class="empty" data-i18n="${emptyKey}">${escapeHtml(t(emptyKey))}</div>`;
  }
  return rows.join('');
}

function _activeLang() {
  if (typeof getLang === 'function') return getLang();
  return 'en';
}

function _pickItemDescription(item, lang) {
  // Centralised across the renderer: `utils.js::pickDesc` does the
  // cross-locale fallback (zh ?? en ?? '') so a one-language entry never
  // renders blank. Don't duplicate the rule here.
  return (typeof pickDesc === 'function') ? pickDesc(item, lang) : '';
}

function _bindRemoveButtons() {
  document.querySelectorAll('#project-detail-content [data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const row = btn.closest('.project-binding-row');
      if (!row) return;
      const kind = row.dataset.kind;
      const id = row.dataset.id;
      try {
        await window.orkas.invoke('projects.bindings.remove', {
          projectId: _projectDetailPid, kind, id,
        });
        await loadProjectDetail(_projectDetailPid);
      } catch (err) {
        _projectDetailLog.warn('remove binding failed', err);
      }
    });
  });
}

// ── Add picker (centered modal with search) ───────────────────────────

async function _openAddPicker(kind) {
  // Dispose any previously-open picker so re-clicks don't stack.
  document.getElementById('project-binding-picker-overlay')?.remove();

  let candidates;
  try {
    const res = await window.orkas.invoke('projects.bindings.candidates', {
      projectId: _projectDetailPid,
    });
    if (!res?.ok) throw new Error(res?.error || 'load_failed');
    candidates = (kind === 'agent') ? (res.agents || []) : (res.skills || []);
  } catch (err) {
    _projectDetailLog.warn('load candidates failed', err);
    return;
  }

  const titleKey = kind === 'agent' ? 'project.bindings.picker_title_agents' : 'project.bindings.picker_title_skills';
  const emptyKey = kind === 'agent' ? 'project.bindings.candidates_empty_agents' : 'project.bindings.candidates_empty_skills';
  const closeText = escapeHtml(t('project.bindings.picker_close'));
  const searchPh = escapeHtml(t('project.bindings.picker_search_placeholder'));

  const overlay = document.createElement('div');
  overlay.id = 'project-binding-picker-overlay';
  overlay.className = 'modal-overlay open';
  overlay.innerHTML = `
    <div class="modal project-binding-picker-modal" role="dialog" aria-modal="true">
      <div class="project-binding-picker-header">
        <span class="project-binding-picker-title" data-i18n="${titleKey}">${escapeHtml(t(titleKey))}</span>
        <button type="button" class="project-binding-picker-close" data-action="close" aria-label="${closeText}">×</button>
      </div>
      <div class="project-binding-picker-search">
        <input type="text" id="project-binding-picker-search-input"
               placeholder="${searchPh}" autocomplete="off" spellcheck="false" />
      </div>
      <div class="project-binding-picker-body">
        <div class="project-binding-picker-list" id="project-binding-picker-list"></div>
        <div class="empty muted" id="project-binding-picker-empty" style="display:none"></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const listEl = overlay.querySelector('#project-binding-picker-list');
  const emptyEl = overlay.querySelector('#project-binding-picker-empty');
  const searchEl = overlay.querySelector('#project-binding-picker-search-input');

  // Render current candidate set, applying the search filter. Re-rendered
  // on every keystroke + after each successful add.
  const render = () => {
    const lang = _activeLang();
    const q = (searchEl.value || '').trim().toLocaleLowerCase();
    const filtered = !q ? candidates : candidates.filter((c) => {
      const id = (kind === 'agent') ? c.agent_id : c.id;
      const name = (c.name || '').toLocaleLowerCase();
      const desc = (_pickItemDescription(c, lang) || '').toLocaleLowerCase();
      return name.includes(q) || desc.includes(q) || (id || '').toLocaleLowerCase().includes(q);
    });
    if (!filtered.length) {
      listEl.innerHTML = '';
      const noMatch = q ? t('project.bindings.picker_no_match') : t(emptyKey);
      emptyEl.textContent = noMatch;
      emptyEl.style.display = '';
      return;
    }
    emptyEl.style.display = 'none';
    listEl.innerHTML = filtered.map((c) => {
      const id = (kind === 'agent') ? c.agent_id : c.id;
      const name = escapeHtml(c.name || id);
      const desc = _pickItemDescription(c, lang);
      const descHtml = desc ? `<div class="project-binding-desc muted">${escapeHtml(desc)}</div>` : '';
      const source = c.source ? `<span class="project-binding-source">${escapeHtml(c.source)}</span>` : '';
      return `
        <div class="project-binding-picker-item" data-kind="${kind}" data-id="${escapeHtml(id)}">
          <div class="project-binding-main">
            <div class="project-binding-head">
              <span class="project-binding-name">${name}</span>
              ${source}
            </div>
            ${descHtml}
          </div>
          <button type="button" class="btn btn-sm" data-action="pick" aria-label="Add">+</button>
        </div>
      `;
    }).join('');
    // Only the `+` button adds — clicking the row body itself is a no-op
    // (per design: explicit confirm, no accidental adds when scanning the
    // description).
    listEl.querySelectorAll('.project-binding-picker-item [data-action="pick"]').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const row = btn.closest('.project-binding-picker-item');
        if (!row) return;
        const id = row.dataset.id;
        const k = row.dataset.kind;
        try {
          const res = await window.orkas.invoke('projects.bindings.add', {
            projectId: _projectDetailPid, kind: k, id,
          });
          if (!res?.ok) throw new Error(res?.error || 'add_failed');
          // Drop the picked id from the local candidate set so it
          // disappears from subsequent renders without a server round-trip.
          candidates = candidates.filter((c) => {
            const cid = (k === 'agent') ? c.agent_id : c.id;
            return cid !== id;
          });
          render();
          // Background refresh of the detail page list so newly-bound
          // items appear in the rail behind the modal.
          loadProjectDetail(_projectDetailPid).catch((err) => _projectDetailLog.warn('refresh failed', err));
        } catch (err) {
          _projectDetailLog.warn('add binding failed', err);
        }
      });
    });
  };

  searchEl.addEventListener('input', render);
  searchEl.addEventListener('keydown', (e) => {
    // IME guard (CLAUDE.md §8) — Esc while composing should commit the
    // candidate, not close the modal.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape' && document.activeElement !== searchEl) close();
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-action="close"]')?.addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);

  render();
  setTimeout(() => searchEl.focus(), 0);
}

// ── Header actions: New chat / Rename / Delete ────────────────────────

function _onNewConvAction() {
  if (!_projectDetailPid) return;
  // Pin pid into the commander chip's localStorage key so the new-chat
  // panel mounts with this project pre-selected. Mirrors
  // `projects.js::_newConvWithProject` semantics — keep the key in sync.
  try { localStorage.setItem('commander.lastProject', _projectDetailPid); } catch (_) {}
  if (typeof setView === 'function') setView('new-chat');
}

function _onRenameAction() {
  if (!_projectDetailMeta) return;
  const titleEl = document.getElementById('project-detail-title');
  const inputEl = document.getElementById('project-detail-title-input');
  if (!titleEl || !inputEl) return;
  inputEl.value = _projectDetailMeta.project?.name || '';
  titleEl.style.display = 'none';
  inputEl.style.display = '';
  inputEl.focus();
  inputEl.select();
}

async function _commitRename(newName) {
  if (!_projectDetailPid || !_projectDetailMeta) return;
  const old = _projectDetailMeta.project?.name || '';
  const trimmed = (newName || '').trim();
  // No change OR empty → revert silently.
  if (!trimmed || trimmed === old) {
    _exitRenameMode();
    return;
  }
  let code = '';
  try {
    const res = await window.orkas.invoke('projects.rename', {
      projectId: _projectDetailPid, name: trimmed,
    });
    if (!res || !res.ok) {
      code = (res && res.error) || 'generic';
    } else {
      _projectDetailMeta.project = res.project;
      if (typeof loadProjects === 'function') loadProjects(true);
      _exitRenameMode();
      _renderProjectDetail();
      return;
    }
  } catch (err) {
    code = (err && err.message) || 'generic';
  }
  if (code === 'name_dup') {
    await uiAlert(t('project.name_dup_inline'));
  } else if (code === 'name_empty') {
    await uiAlert(t('project.name_empty'));
  } else if (code) {
    await uiAlert(t('project.error.generic'));
  }
  _exitRenameMode();
}

function _exitRenameMode() {
  const titleEl = document.getElementById('project-detail-title');
  const inputEl = document.getElementById('project-detail-title-input');
  if (titleEl) titleEl.style.display = '';
  if (inputEl) inputEl.style.display = 'none';
}

async function _onDeleteAction() {
  if (!_projectDetailPid || !_projectDetailMeta) return;
  // Reuse the sidebar's delete confirm flow so the danger label / count
  // wording stays in one place. `_confirmDeleteProject` is defined in
  // `projects.js` and runs the IPC + post-delete cleanup. The sidebar
  // handler doesn't navigate away on its own when the user is on the
  // project detail panel (currentCid is null there), so we check post-hoc:
  // if the project disappeared from the cache, jump to new-chat.
  const targetPid = _projectDetailPid;
  if (typeof _confirmDeleteProject === 'function') {
    await _confirmDeleteProject(targetPid);
  }
  const stillExists = Array.isArray(_projectsCache)
    && _projectsCache.some((p) => p && p.project_id === targetPid);
  if (!stillExists && currentView === 'project') {
    if (typeof setView === 'function') setView('new-chat');
  }
}

// ── Empty-bindings banner inside in-project conversations ─────────────

async function refreshConvProjectEmptyBanner(cid) {
  const banner = document.getElementById('conv-project-empty-banner');
  if (!banner) return;
  let pid = '';
  if (typeof conversations !== 'undefined' && Array.isArray(conversations)) {
    const conv = conversations.find((c) => c && c.conversation_id === cid);
    if (conv && conv.project_id) pid = conv.project_id;
  }
  if (!pid) {
    banner.style.display = 'none';
    delete banner.dataset.pid;
    return;
  }
  try {
    const res = await window.orkas.invoke('projects.bindings.list', { projectId: pid });
    const b = res && res.bindings ? res.bindings : { agents: [], skills: [] };
    const isEmpty = !(b.agents || []).length && !(b.skills || []).length;
    banner.style.display = isEmpty ? '' : 'none';
    banner.dataset.pid = pid;
  } catch (_) {
    banner.style.display = 'none';
  }
}

// ── Boot wiring ────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('project-add-agent-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openAddPicker('agent');
  });
  document.getElementById('project-add-skill-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openAddPicker('skill');
  });
  document.getElementById('project-action-new-conv')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _onNewConvAction();
  });
  document.getElementById('project-action-rename')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _onRenameAction();
  });
  document.getElementById('project-action-delete')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _onDeleteAction();
  });
  // Inline rename input handlers.
  const inputEl = document.getElementById('project-detail-title-input');
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      // IME guard (CLAUDE.md §8) — Enter while composing must commit
      // the candidate, not the rename.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); _commitRename(inputEl.value); }
      else if (e.key === 'Escape') { e.preventDefault(); _exitRenameMode(); }
    });
    inputEl.addEventListener('blur', () => _commitRename(inputEl.value));
  }
  // In-conv empty-bindings banner action.
  document.getElementById('conv-project-empty-banner-open')?.addEventListener('click', () => {
    const banner = document.getElementById('conv-project-empty-banner');
    const pid = banner?.dataset?.pid || '';
    if (pid && typeof setView === 'function') setView('project', pid);
  });
  window.addEventListener('i18n-change', () => {
    if (currentView === 'project' && _projectDetailMeta) _renderProjectDetail();
  });
});
