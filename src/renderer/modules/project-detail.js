// ─── Project detail panel ───────────────────────────────────────────────
// Drives `#panel-project`: shows the project composer, files, and bindings
// (agents + skills), and exposes Add / Remove for each.
//
// Header carries 3 actions: + New chat / Rename / Delete. The "Back" button
// was intentionally removed — the sidebar IS the back navigation.
//
// Add picker is a centered modal (`.modal-overlay`) — reuses the existing
// dialog overlay shell so it doesn't get clipped at the panel edge.

const _projectDetailLog = createLogger('project-detail');

let _projectDetailPid = '';     // pid currently rendered in the panel
let _projectDetailMeta = null;  // { project, agentDetails, skillDetails, files }

// ── Public: navigate-into ──────────────────────────────────────────────

/** Called by boot.js setView('project', pid) on entry. */
async function loadProjectDetail(pid) {
  _projectDetailPid = pid || '';
  if (!_projectDetailPid) {
    _renderProjectDetailEmpty();
    return;
  }
  try {
    const [getRes, listRes, filesRes] = await Promise.all([
      window.orkas.invoke('projects.get', { projectId: pid }),
      window.orkas.invoke('projects.bindings.list', { projectId: pid }),
      window.orkas.invoke('projects.files.list', { projectId: pid }),
    ]);
    if (!getRes?.ok || !listRes?.ok || !filesRes?.ok) {
      throw new Error((getRes && getRes.error) || (listRes && listRes.error) || (filesRes && filesRes.error) || 'load_failed');
    }
    _projectDetailMeta = {
      project: getRes.project,
      agentDetails: Array.isArray(listRes.agentDetails) ? listRes.agentDetails : [],
      skillDetails: Array.isArray(listRes.skillDetails) ? listRes.skillDetails : [],
      files: Array.isArray(filesRes.files) ? filesRes.files : [],
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
  const agents = document.getElementById('project-agents-list');
  const skills = document.getElementById('project-skills-list');
  const files = document.getElementById('project-files-list');
  if (agents) agents.innerHTML = '';
  if (skills) skills.innerHTML = '';
  if (files) files.innerHTML = '';
}

function _renderProjectDetail() {
  if (!_projectDetailMeta) { _renderProjectDetailEmpty(); return; }
  const { project, agentDetails, skillDetails, files } = _projectDetailMeta;

  const titleEl = document.getElementById('project-detail-title');
  if (titleEl) titleEl.textContent = project?.name || '';

  document.getElementById('project-agents-list').innerHTML = _renderBindingsRows(
    'agent', agentDetails,
  );
  document.getElementById('project-skills-list').innerHTML = _renderBindingsRows(
    'skill', skillDetails,
  );
  _renderProjectFiles(files || []);

  applyDomI18n();
  _bindRemoveButtons();
  _bindProjectFileRows();
  if (typeof refreshWorkspaceChip === 'function') refreshWorkspaceChip();
  if (typeof hydrateUiIcons === 'function') hydrateUiIcons(document.getElementById('project-detail-content'));
}

function _renderBindingsRows(kind, items) {
  const lang = _activeLang();
  const removeLabel = escapeHtml(t('project.bindings.remove'));
  const sorted = (items || []).slice().sort(_byDisplayName);
  const rows = [];
  for (const it of sorted) {
    const id = (kind === 'agent') ? it.agent_id : it.id;
    const name = escapeHtml(it.name || id);
    const desc = kind === 'agent' ? '' : _pickItemDescription(it, lang);
    const descHtml = desc ? `<div class="project-binding-desc muted">${escapeHtml(desc)}</div>` : '';
    const sourceTag = _projectBindingSourceHtml(it.source, kind);
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
  if (!rows.length) {
    const emptyKey = kind === 'agent' ? 'project.bindings.empty_agents' : 'project.bindings.empty_skills';
    return `<div class="empty" data-i18n="${emptyKey}">${escapeHtml(t(emptyKey))}</div>`;
  }
  return rows.join('');
}

function _formatProjectFileBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function _renderProjectFiles(files) {
  const list = document.getElementById('project-files-list');
  const status = document.getElementById('project-files-status');
  if (!list) return;
  if (status) status.textContent = '';
  const sorted = (files || []).slice().sort(_byDisplayName);
  if (!sorted.length) {
    list.innerHTML = `<div class="empty" data-i18n="project.files.empty">${escapeHtml(t('project.files.empty'))}</div>`;
    return;
  }
  const removeLabel = escapeHtml(t('project.files.remove'));
  list.innerHTML = sorted.map((f) => {
    const name = f.name || '';
    const label = escapeHtml(name);
    const icon = (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function')
      ? window.fileKindIconHtml(name, f.kind)
      : '';
    const meta = _formatProjectFileBytes(f.bytes);
    return `
      <div class="project-file-row" data-project-file="${label}">
        <button type="button" class="project-file-main" title="${label}" data-action="open-file">
          <span class="project-file-icon">${icon}</span>
          <span class="project-file-name">${label}</span>
          ${meta ? `<span class="project-file-meta">${escapeHtml(meta)}</span>` : ''}
        </button>
        <button type="button" class="project-file-remove" data-action="remove-file"
                title="${removeLabel}" aria-label="${removeLabel}">×</button>
      </div>
    `;
  }).join('');
}

function _bindProjectFileRows() {
  const root = document.getElementById('project-files-list');
  if (!root) return;
  root.querySelectorAll('.project-file-row[data-project-file]').forEach((row) => {
    const name = row.dataset.projectFile || '';
    row.querySelector('[data-action="open-file"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await _openProjectFile(name);
    });
    row.querySelector('[data-action="remove-file"]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await _deleteProjectFile(name);
    });
  });
}

async function _openProjectFile(name) {
  if (!_projectDetailPid || !name || typeof openChatFileViewer !== 'function') return;
  try {
    const res = await window.orkas.invoke('projects.files.absPath', {
      projectId: _projectDetailPid,
      name,
    });
    if (!res?.ok || !res.path) throw new Error(res?.error || 'not_found');
    openChatFileViewer(res.path, name, { projectId: _projectDetailPid });
  } catch (err) {
    _projectDetailLog.warn('open project file failed', err);
  }
}

async function _deleteProjectFile(name) {
  if (!_projectDetailPid || !name) return;
  try {
    const res = await window.orkas.invoke('projects.files.delete', {
      projectId: _projectDetailPid,
      name,
    });
    if (!res?.ok) throw new Error(res?.error || 'delete_failed');
    await loadProjectDetail(_projectDetailPid);
  } catch (err) {
    _projectDetailLog.warn('delete project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('project.files.delete_failed'));
  }
}

function _arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf || new ArrayBuffer(0));
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
  }
  return btoa(binary);
}

function _setProjectFilesStatus(text) {
  const status = document.getElementById('project-files-status');
  if (status) status.textContent = text || '';
}

async function _uploadProjectFiles(fileList) {
  if (!_projectDetailPid || !fileList || !fileList.length) return;
  const files = Array.from(fileList).filter(Boolean);
  if (!files.length) return;
  _setProjectFilesStatus(t('project.files.uploading'));
  const failed = [];
  await Promise.all(files.map(async (file) => {
    try {
      const buf = await file.arrayBuffer();
      const res = await window.orkas.invoke('projects.files.upload', {
        projectId: _projectDetailPid,
        name: file.name || 'file',
        data: _arrayBufferToBase64(buf),
      });
      if (!res?.ok) {
        failed.push(t('project.files.upload_failed', {
          name: file.name || 'file',
          reason: res?.error || t('chat.attach_upload_generic_fail'),
        }));
      }
    } catch (err) {
      failed.push(t('project.files.upload_failed', {
        name: file.name || 'file',
        reason: err?.message || t('chat.attach_upload_generic_fail'),
      }));
    }
  }));
  await loadProjectDetail(_projectDetailPid);
  if (failed.length && typeof uiAlert === 'function') {
    await uiAlert(t('project.files.upload_failed_list', { list: failed.join('\n') }));
  }
}

async function _submitProjectChat() {
  if (!_projectDetailPid) return;
  const input = document.getElementById('project-chat-input');
  const btn = document.getElementById('project-chat-send-btn');
  const raw = (input?.value || '').trim();
  if (!raw) return;
  if (typeof ensureModelConfigured === 'function' && !ensureModelConfigured()) return;
  const useSelection = (typeof consumeChatUseSelection === 'function')
    ? consumeChatUseSelection('project')
    : null;
  const recipient = (typeof getChatRecipient === 'function')
    ? getChatRecipient('project')
    : null;
  const withUse = (typeof transformWithChatUse === 'function')
    ? transformWithChatUse(raw, useSelection)
    : raw;
  const content = (typeof applyRecipientPrefix === 'function')
    ? applyRecipientPrefix(withUse, 'project')
    : withUse;
  if (btn) btn.disabled = true;
  let convId = '';
  try {
    const res = await apiFetch('/api/conversations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'normal', projectId: _projectDetailPid }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || t('chat.create_conv_failed'));
    const conv = data.conversation;
    convId = conv.conversation_id;
    conv.title = (typeof _autoTitle === 'function') ? _autoTitle(raw) : raw.slice(0, 32);
    conversations.unshift(conv);
    renderConversationList();
    if (typeof loadProjects === 'function') loadProjects(true);
  } catch (err) {
    if (typeof uiAlert === 'function') {
      await uiAlert(t('chat.create_conv_failed_with_reason', { reason: err?.message || err }));
    }
    if (btn) btn.disabled = false;
    return;
  }

  if (input) {
    input.value = '';
    if (typeof autoGrow === 'function') autoGrow(input, 180);
  }
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.value = '';
    if (typeof autoGrow === 'function') autoGrow(chatInput, 200);
  }
  if (typeof setView === 'function') setView('conversation', convId, { skipLoad: true });
  if (recipient && typeof setChatRecipient === 'function') {
    setChatRecipient('conversation', recipient);
  }
  if (useSelection && typeof setChatUseSelection === 'function') {
    setChatUseSelection('conversation', useSelection);
  }
  if (btn) btn.disabled = false;
  if (typeof sendInCurrentConversation === 'function') {
    await sendInCurrentConversation(content);
  }
}

function _activeLang() {
  if (typeof getLang === 'function') return getLang();
  return 'en';
}

/** Stable A→Z order by display name (case + diacritic insensitive,
 *  numeric-aware so "Item 2" precedes "Item 10"). Falls back to id when
 *  a name is missing. Used in both the bound-items rail and the candidate
 *  picker so user-facing lists stay legible regardless of insertion
 *  order. zh + en mix sorts reasonably under default locale collation. */
function _byDisplayName(a, b) {
  const na = (a && (a.name || a.agent_id || a.id)) || '';
  const nb = (b && (b.name || b.agent_id || b.id)) || '';
  return na.localeCompare(nb, undefined, { sensitivity: 'base', numeric: true });
}

function _pickItemDescription(item, lang) {
  // Centralised across the renderer: `utils.js::pickDesc` does the
  // cross-locale fallback (zh ?? en ?? '') so a one-language entry never
  // renders blank. Don't duplicate the rule here.
  return (typeof pickDesc === 'function') ? pickDesc(item, lang) : '';
}

function _projectBindingSourceHtml(source, kind) {
  if (!source) return '';
  const label = (typeof catalogSourceLabel === 'function')
    ? catalogSourceLabel(source, kind === 'skill' ? 'skills' : 'agents')
    : String(source);
  if (!label) return '';
  const normalized = (typeof normalizeCatalogSource === 'function')
    ? normalizeCatalogSource(source)
    : String(source);
  return `<span class="project-binding-source project-binding-source--${escapeHtml(normalized)}">${escapeHtml(label)}</span>`;
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
    candidates = ((kind === 'agent') ? (res.agents || []) : (res.skills || [])).slice().sort(_byDisplayName);
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
      const source = _projectBindingSourceHtml(c.source, kind);
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

// ── Header actions: Rename / Delete ────────────────────────────────────

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

function _setConvProjectBannerVisible(visible) {
  const pane = document.querySelector('#panel-conversation .chat-main-pane');
  if (pane) pane.classList.toggle('has-project-empty-banner', !!visible);
}

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
    _setConvProjectBannerVisible(false);
    return;
  }
  try {
    const res = await window.orkas.invoke('projects.bindings.list', { projectId: pid });
    const b = res && res.bindings ? res.bindings : { agents: [], skills: [] };
    // Skills aren't project-scoped this round — only the agents bucket
    // gates whether the user can do anything inside this project.
    const isEmpty = !(b.agents || []).length;
    banner.style.display = isEmpty ? '' : 'none';
    if (isEmpty) banner.dataset.pid = pid;
    else delete banner.dataset.pid;
    _setConvProjectBannerVisible(isEmpty);
  } catch (_) {
    banner.style.display = 'none';
    delete banner.dataset.pid;
    _setConvProjectBannerVisible(false);
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
  document.getElementById('project-action-rename')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _onRenameAction();
  });
  document.getElementById('project-action-delete')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _onDeleteAction();
  });
  document.getElementById('project-add-file-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('project-file-input')?.click();
  });
  document.getElementById('project-chat-attach-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('project-file-input')?.click();
  });
  document.getElementById('project-file-input')?.addEventListener('change', async (e) => {
    await _uploadProjectFiles(e.target.files);
    e.target.value = '';
  });
  const projectInput = document.getElementById('project-chat-input');
  if (projectInput) {
    projectInput.addEventListener('input', () => {
      if (typeof autoGrow === 'function') autoGrow(projectInput, 180);
    });
    projectInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        _submitProjectChat();
      }
    });
  }
  document.getElementById('project-chat-send-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _submitProjectChat();
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
