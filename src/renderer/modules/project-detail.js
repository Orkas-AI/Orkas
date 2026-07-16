// ─── Project detail panel ───────────────────────────────────────────────
// Drives `#panel-project`: shows the project composer, task panes, and a
// right-side rail for project agents + files.
//
// Header carries Rename / Delete. The "Back" button was intentionally
// removed — the sidebar IS the back navigation.
//
// Add picker and project-file viewer are centered modals (`.modal-overlay`)
// so they don't get clipped by the project panel's scrolling regions.

const _projectDetailLog = createLogger('project-detail');
const PROJECT_LIBRARY_INTERNAL_DRAG_TYPE = 'application/x-project-library-path';

// Keep DOM drag uploads aligned with the native project-file picker and the
// main-process allow-list. Project Libraries additionally support video files.
const PROJECT_LIBRARY_ALLOWED_EXTS = [
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
  '.pdf', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp4', '.webm', '.mov', '.m4v', '.ogv',
];

function _projectTrackClick(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _projectTrackEvent(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _projectTrackError(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _projectFileUploadPayload(fileList, source, targetDir) {
  const files = Array.from(fileList || []);
  let totalBytes = 0;
  for (const file of files) totalBytes += Number((file && (file.size || file.bytes)) || 0);
  return {
    source,
    file_count: files.length,
    total_bytes: totalBytes,
    has_target_dir: !!targetDir,
  };
}

let _projectDetailPid = '';     // pid currently rendered in the panel
let _projectDetailMeta = null;  // { project, agentDetails, skillDetails, files, libraryStatus? }
let _projectKbStatusByName = {}; // {[name]: {status, chunks?, error?, kind?}}
let _projectKbEventsHandle = null;
let _projectKbEventsPid = '';
let _projectLibraryActiveName = '';
let _projectLibraryMveController = null;
let _projectOfficeBlobUrl = null;
const _projectLibraryExpanded = new Set();
const _projectLibrarySelected = new Set();
let _projectLibrarySelectionAnchor = null;
const _projectLibraryDrafts = new Map();
let _projectKbStatusRefreshTimer = null;
let _projectKbReconcileInFlight = false;
let _projectDetailLoadSeq = 0;
let _projectAutoTabLoad = null;
let _projectAutoLoadedSeq = 0;

function _projectCachedSummary(pid) {
  if (!pid || !Array.isArray(typeof _projectsCache !== 'undefined' ? _projectsCache : null)) return null;
  return _projectsCache.find((project) => project && project.project_id === pid) || null;
}

function _setProjectDetailBusy(busy) {
  const content = document.getElementById('project-detail-content');
  if (!content) return;
  content.classList.toggle('is-loading', !!busy);
  content.setAttribute('aria-busy', busy ? 'true' : 'false');
}

// ── Public: navigate-into ──────────────────────────────────────────────

/** Called by boot.js setView('project', pid) on entry. */
async function loadProjectDetail(pid) {
  const loadSeq = ++_projectDetailLoadSeq;
  const prevPid = _projectDetailPid;
  if (prevPid && prevPid !== pid) {
    _projectLibraryDrafts.clear();
    _projectLibraryExpanded.clear();
    _projectLibrarySelected.clear();
    _projectLibrarySelectionAnchor = null;
    _clearProjectLibraryViewer();
  }
  _projectDetailPid = pid || '';
  if (!_projectDetailPid) {
    _setProjectDetailBusy(false);
    _renderProjectDetailEmpty();
    return;
  }
  if (prevPid !== _projectDetailPid || !_projectDetailMeta) {
    _projectTodos = [];
    _closeProjectTodoEditor();
    _projectMemory = [];
    _projectMemoryEditor = null;
    _projectMemoryLoadSeq += 1;
    _projectKbStatusByName = {};
    _projectDetailMeta = {
      project: _projectCachedSummary(_projectDetailPid) || {
        project_id: _projectDetailPid,
        name: '',
      },
      agentDetails: [],
      skillDetails: [],
      files: [],
      libraryStatus: null,
      instructions: null,
    };
    _setProjectAutoTabCount(0);
    // Paint the existing project shell immediately. Secondary cards remain in
    // their empty/loading state while independent main-process work proceeds.
    _renderProjectDetail({ hydrateSecondary: false });
    if (_projectDetailActiveTab === 'auto') {
      _ensureProjectAutoTabLoaded(_projectDetailPid);
    }
  }
  _setProjectDetailBusy(true);
  // The visible Tasks tab needs this project's conversation rows. Batch 25
  // makes this a physical-root read, so it no longer reconstructs all projects.
  if (typeof loadConversationProject === 'function') {
    loadConversationProject(_projectDetailPid).catch((err) => {
      _projectDetailLog.warn('load project conversations failed', err);
    });
  }
  // Surface any pending commander-draft attachment for this project (e.g. a KB
  // file queued via "ask the commander about this file").
  if (typeof _chatAttachRenderChips === 'function') _chatAttachRenderChips(_projectChatDraftCid(_projectDetailPid));
  if (typeof _renderQuotePreview === 'function') _renderQuotePreview(_projectChatDraftCid(_projectDetailPid));
  if (_projectKbEventsPid && _projectKbEventsPid !== _projectDetailPid) {
    _stopProjectKbEventSubscription();
  }
  try {
    const [getRes, listRes, filesRes, kbRes, instrRes, autoRes] = await Promise.all([
      window.orkas.invoke('projects.get', { projectId: pid }),
      window.orkas.invoke('projects.bindings.list', { projectId: pid }),
      window.orkas.invoke('projects.files.tree', { projectId: pid }),
      window.orkas.invoke('projects.files.status', { projectId: pid, skipReconcile: true }).catch((err) => ({ ok: false, error: err?.message || String(err) })),
      window.orkas.invoke('projects.instructions.get', { projectId: pid }).catch((err) => ({ ok: false, error: err?.message || String(err) })),
      window.orkas.invoke('autoTasks.list', { projectId: pid }).catch((err) => ({ ok: false, error: err?.message || String(err) })),
    ]);
    if (loadSeq !== _projectDetailLoadSeq || pid !== _projectDetailPid) return;
    if (!getRes?.ok || !listRes?.ok || !filesRes?.ok) {
      throw new Error((getRes && getRes.error) || (listRes && listRes.error) || (filesRes && filesRes.error) || 'load_failed');
    }
    const fileTree = Array.isArray(filesRes.tree) ? filesRes.tree : [];
    const flatFiles = _flattenProjectLibraryFiles(fileTree);
    _projectKbStatusByName = _buildProjectKbStatusMap(flatFiles, kbRes?.ok ? (kbRes.files || []) : []);
    _projectDetailMeta = {
      project: getRes.project,
      agentDetails: Array.isArray(listRes.agentDetails) ? listRes.agentDetails : [],
      skillDetails: Array.isArray(listRes.skillDetails) ? listRes.skillDetails : [],
      files: fileTree,
      libraryStatus: kbRes?.ok ? kbRes : null,
      instructions: instrRes?.ok ? { content: String(instrRes.content || ''), limit: Number(instrRes.limit) || 4000 } : null,
    };
    _renderProjectDetail();
    _setProjectAutoTabCount(Array.isArray(autoRes?.tasks) ? autoRes.tasks.length : 0);
    _kickProjectKbReconcileIfNeeded();
    _scheduleProjectKbStatusRefreshIfNeeded();
  } catch (err) {
    if (loadSeq !== _projectDetailLoadSeq || pid !== _projectDetailPid) return;
    _projectDetailLog.warn('load project detail failed', err);
    if (typeof setView === 'function') setView('new-chat');
    if (typeof uiAlert === 'function') uiAlert(t('project.detail_load_failed'));
  } finally {
    if (loadSeq === _projectDetailLoadSeq && pid === _projectDetailPid) {
      _setProjectDetailBusy(false);
    }
  }
}

function _renderProjectDetailEmpty() {
  _projectKbStatusByName = {};
  _stopProjectKbEventSubscription();
  _setProjectDetailRenameMode(false);
  const titleEl = document.getElementById('project-detail-title');
  if (titleEl) titleEl.textContent = '';
  const agents = document.getElementById('project-agents-list');
  const files = document.getElementById('project-files-list');
  const agentsEmpty = document.getElementById('project-agents-empty');
  if (agents) agents.innerHTML = '';
  if (files) files.innerHTML = '';
  if (agentsEmpty) agentsEmpty.style.display = '';
  _clearProjectLibraryViewer();
  _setCardCount('project-detail-agents-count', 0);
  _setCardCount('project-detail-files-count', 0);
  const taskCount = document.getElementById('project-tasks-count');
  if (taskCount) taskCount.textContent = '0';
  _setProjectAutoTabCount(0);
}

function _renderProjectDetail({ hydrateSecondary = true } = {}) {
  if (!_projectDetailMeta) { _renderProjectDetailEmpty(); return; }
  const { project, agentDetails, files } = _projectDetailMeta;

  const titleEl = document.getElementById('project-detail-title');
  if (titleEl) titleEl.textContent = project?.name || '';

  const agentsList = document.getElementById('project-agents-list');
  const hasAgents = (agentDetails || []).length > 0;
  if (agentsList) {
    agentsList.innerHTML = _renderProjectAgentCards(agentDetails || []);
    agentsList.style.display = hasAgents ? '' : 'none';
  }
  const agentsEmpty = document.getElementById('project-agents-empty');
  if (agentsEmpty) agentsEmpty.style.display = hasAgents ? 'none' : '';
  _renderProjectFiles(files || []);
  _renderProjectAllTasks();
  _renderProjectInstructions();
  _renderProjectMemoryList();
  _bindProjectDetailTabs();
  _bindProjectSideTabs();
  _bindProjectAutoAddBtn();
  _bindProjectInstructions();
  _bindProjectMemory();
  _bindProjectTodos();
  if (hydrateSecondary) {
    _loadProjectTodos(_projectDetailPid).catch(() => { /* ignore */ });
    _loadProjectMemory(_projectDetailPid).catch(() => { /* ignore */ });
  }

  // Per-card count chips beside each card title.
  _setCardCount('project-detail-agents-count', (agentDetails || []).length);
  _setCardCount('project-detail-files-count', _flattenProjectLibraryFiles(files || []).length);

  applyDomI18n();
  _setProjectDetailRenameMode(_isProjectDetailRenameMode());
  _bindProjectAgentCards();
  _bindRemoveButtons();
  _bindProjectFileRows();
  if (typeof refreshWorkspaceChip === 'function') refreshWorkspaceChip();
  if (typeof hydrateUiIcons === 'function') hydrateUiIcons(document.getElementById('project-detail-content'));
  if (hydrateSecondary) {
    _ensureProjectKbEventSubscription(_projectDetailPid);
    if (_projectDetailActiveTab === 'auto') {
      _ensureProjectAutoTabLoaded(_projectDetailPid);
    }
  }
}

/** Tab nav binding: switch panel visibility + remember the active tab. */
let _projectDetailActiveTab = 'tasks';
function _bindProjectDetailTabs() {
  const tabs = Array.from(document.querySelectorAll('.project-detail-tab'));
  if (!tabs.length) return;
  const available = new Set(tabs.map((tab) => tab.dataset.projectTab || 'tasks'));
  if (!available.has(_projectDetailActiveTab)) _projectDetailActiveTab = 'tasks';
  for (const tab of tabs) {
    if (tab.dataset.bound !== '1') {
      tab.dataset.bound = '1';
      tab.addEventListener('click', () => {
        _projectDetailActiveTab = tab.dataset.projectTab || 'tasks';
        _syncProjectDetailTabState();
        if (_projectDetailActiveTab === 'auto') {
          _ensureProjectAutoTabLoaded(_projectDetailPid);
        }
      });
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const current = tabs.indexOf(tab);
        const next = tabs[(current + step + tabs.length) % tabs.length];
        next.click();
        next.focus();
      });
    }
  }
  _syncProjectDetailTabState();
}

async function _ensureProjectAutoTabLoaded(pid) {
  if (!pid || pid !== _projectDetailPid) return;
  // The shell render and the hydrated render can both observe a persisted
  // Automation tab. They belong to the same detail-load generation and must
  // share one list refresh even when the first request finishes very quickly.
  if (_projectAutoLoadedSeq === _projectDetailLoadSeq) return;
  if (_projectAutoTabLoad?.pid === pid) return _projectAutoTabLoad.promise;
  const listEl = document.getElementById('project-auto-list');
  if (listEl && typeof loadProjectAutoList !== 'function') {
    listEl.innerHTML = `<div class="empty muted">${escapeHtml(t('chat.loading'))}</div>`;
  }
  const run = (async () => {
    const loader = typeof loadRendererFeature === 'function'
      ? loadRendererFeature
      : window.loadRendererFeature;
    if (typeof loadProjectAutoList !== 'function' && typeof loader === 'function') {
      await loader('auto');
    }
    if (pid !== _projectDetailPid || _projectDetailActiveTab !== 'auto') return;
    _bindProjectAutoAddBtn();
    if (typeof loadProjectAutoList === 'function') {
      await loadProjectAutoList(pid);
      if (pid === _projectDetailPid && _projectDetailActiveTab === 'auto') {
        _projectAutoLoadedSeq = _projectDetailLoadSeq;
      }
    }
  })();
  _projectAutoTabLoad = { pid, promise: run };
  try {
    await run;
  } catch (err) {
    _projectDetailLog.warn('load project automation failed', err);
  } finally {
    if (_projectAutoTabLoad?.promise === run) _projectAutoTabLoad = null;
  }
}

function _syncProjectDetailTabState() {
  const tabs = document.querySelectorAll('.project-detail-tab');
  const panels = document.querySelectorAll('.project-detail-tab-panel');
  for (const tab of tabs) {
    const selected = (tab.dataset.projectTab || 'tasks') === _projectDetailActiveTab;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of panels) {
    panel.hidden = (panel.dataset.projectPanel !== _projectDetailActiveTab);
    panel.setAttribute('role', 'tabpanel');
  }
}

/** The right rail has two compact tab groups. Their cards stay fixed in the
 *  three-row rail while only the content inside each card switches. */
const _projectSideActiveTabs = {
  context: 'instructions',
  resources: 'agents',
};

function _bindProjectSideTabs() {
  const tablists = document.querySelectorAll('[data-project-side-tabs]');
  for (const tablist of tablists) {
    const group = tablist.dataset.projectSideTabs || '';
    const tabs = Array.from(tablist.querySelectorAll('[data-project-side-tab]'));
    if (!group || !tabs.length) continue;
    const available = new Set(tabs.map((tab) => tab.dataset.projectSideTab || ''));
    if (!available.has(_projectSideActiveTabs[group])) {
      _projectSideActiveTabs[group] = tabs[0].dataset.projectSideTab || '';
    }
    for (const tab of tabs) {
      tab.setAttribute('role', 'tab');
      if (tab.dataset.bound === '1') continue;
      tab.dataset.bound = '1';
      tab.addEventListener('click', () => {
        _projectSideActiveTabs[group] = tab.dataset.projectSideTab || '';
        _syncProjectSideTabState(group);
      });
      tab.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const step = event.key === 'ArrowRight' ? 1 : -1;
        const current = tabs.indexOf(tab);
        const next = tabs[(current + step + tabs.length) % tabs.length];
        _projectSideActiveTabs[group] = next.dataset.projectSideTab || '';
        _syncProjectSideTabState(group);
        next.focus();
      });
    }
    _syncProjectSideTabState(group);
  }
}

function _syncProjectSideTabState(group) {
  const tablist = document.querySelector(`[data-project-side-tabs="${group}"]`);
  const card = tablist?.closest('.project-side-card');
  if (!tablist || !card) return;
  const active = _projectSideActiveTabs[group] || '';
  for (const tab of tablist.querySelectorAll('[data-project-side-tab]')) {
    const selected = tab.dataset.projectSideTab === active;
    tab.classList.toggle('is-active', selected);
    tab.setAttribute('aria-selected', selected ? 'true' : 'false');
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of card.querySelectorAll('[data-project-side-panel]')) {
    const selected = panel.dataset.projectSidePanel === active;
    panel.hidden = !selected;
    panel.setAttribute('role', 'tabpanel');
  }
  if (group === 'resources') {
    for (const action of card.querySelectorAll('[data-project-resource-action]')) {
      action.hidden = action.dataset.projectResourceAction !== active;
    }
  }
  if (group === 'context') {
    for (const action of card.querySelectorAll('[data-project-context-action]')) {
      action.hidden = action.dataset.projectContextAction !== active;
    }
  }
}

/** Bind the "+ 新建任务" button in the project's automation tab. Opens the
 *  shared auto-task modal with this project pre-bound (locked mode). */
function _bindProjectAutoAddBtn() {
  const btn = document.getElementById('project-auto-add-btn');
  if (!btn || btn.dataset.bound === '1') return;
  btn.dataset.bound = '1';
  btn.addEventListener('click', () => {
    if (!_projectDetailPid || typeof openAutoTaskDialog !== 'function') return;
    _projectTrackClick('project_auto_task_open', { project_id: _projectDetailPid });
    openAutoTaskDialog({
      projectId: _projectDetailPid,
      onSaved: () => {
        if (typeof loadProjectAutoList === 'function') loadProjectAutoList(_projectDetailPid).catch(() => {});
      },
    });
  });
}

// ── Project instructions (user-authored ORKAS.md) ─────────────────────────
// The user's own rules for this project — injected into every conversation
// in the project. User-owned: saved only from here, agents just read it.

function _renderProjectInstructions() {
  const input = document.getElementById('project-instructions-input');
  if (!input) return;
  const meta = _projectDetailMeta?.instructions;
  const limit = (meta && Number(meta.limit)) || 4000;
  input.value = meta ? meta.content : '';
  input.dataset.savedValue = input.value;
  input.dataset.limit = String(limit);
  // Instructions failed to load (e.g. legacy main) → disable rather than
  // let a save blank out content we never saw.
  input.disabled = !meta;
  _updateProjectInstructionsFoot();
}

function _updateProjectInstructionsFoot() {
  const input = document.getElementById('project-instructions-input');
  const counter = document.getElementById('project-instructions-counter');
  const saveBtn = document.getElementById('project-instructions-save-btn');
  if (!input) return;
  const limit = Number(input.dataset.limit) || 4000;
  const len = input.value.length;
  const dirty = !input.disabled && input.value !== (input.dataset.savedValue || '');
  const over = len > limit;
  if (counter) {
    counter.textContent = `${len}/${limit}`;
    counter.classList.toggle('is-over', over);
  }
  if (saveBtn) saveBtn.disabled = !dirty || over;
}

function _bindProjectInstructions() {
  const input = document.getElementById('project-instructions-input');
  const saveBtn = document.getElementById('project-instructions-save-btn');
  if (!input || input.dataset.bound === '1') return;
  input.dataset.bound = '1';
  input.addEventListener('input', _updateProjectInstructionsFoot);
  saveBtn?.addEventListener('click', async () => {
    if (!_projectDetailPid || input.disabled) return;
    const content = input.value;
    saveBtn.disabled = true;
    try {
      const res = await window.orkas.invoke('projects.instructions.set', { projectId: _projectDetailPid, content });
      if (!res?.ok) throw new Error(res?.error || 'save_failed');
      input.dataset.savedValue = content;
      if (_projectDetailMeta?.instructions) _projectDetailMeta.instructions.content = content;
    } catch (err) {
      _projectDetailLog.warn('save project instructions failed', err);
      if (typeof uiAlert === 'function') uiAlert(t('project.instructions.save_failed'));
    }
    _updateProjectInstructionsFoot();
  });
}

/** "All tasks" tab pane: full list of conversations belonging to this
 *  project. Replaces the earlier capped "recent conversations" section
 *  (no view-all button — this IS the full list). */
function _renderProjectAllTasks() {
  const listEl = document.getElementById('project-tasks-list');
  const emptyEl = document.getElementById('project-tasks-empty');
  const countEl = document.getElementById('project-tasks-count');
  if (!listEl) return;
  const hasRenderer = typeof _renderConversationSidebarItem === 'function'
    && typeof conversations !== 'undefined'
    && Array.isArray(conversations);
  if (!_projectDetailPid || !hasRenderer) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = '';
    if (countEl) countEl.textContent = '0';
    return;
  }
  const convs = conversations.filter((c) => c && c.project_id === _projectDetailPid);
  const pagedTotal = typeof _projectConversationTotal === 'function'
    ? _projectConversationTotal(_projectDetailPid) : 0;
  const total = Math.max(convs.length, pagedTotal);
  if (countEl) countEl.textContent = String(total);
  if (!convs.length) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  listEl.innerHTML = (typeof _renderConversationTimeBucketList === 'function')
    ? _renderConversationTimeBucketList(convs, { nested: true, bucketScope: `project-detail:${_projectDetailPid}` })
    : convs
        .slice()
        .sort((a, b) => {
          const ta = a.last_active_at || a.updated_at || a.created_at || '';
          const tb = b.last_active_at || b.updated_at || b.created_at || '';
          return tb.localeCompare(ta);
        })
        .map((c) => _renderConversationSidebarItem(c, { nested: true }))
        .join('');
  if (typeof _projectConversationHasMore === 'function'
      && _projectConversationHasMore(_projectDetailPid)) {
    listEl.insertAdjacentHTML('beforeend', `<button type="button" class="conversation-list-load-more" data-project-detail-conv-more="1">
      ${escapeHtml(t('sidebar.load_more_conversations'))}</button>`);
    listEl.querySelector('[data-project-detail-conv-more]')?.addEventListener('click', async (e) => {
      const button = e.currentTarget;
      if (button.disabled) return;
      const projectId = _projectDetailPid;
      button.disabled = true;
      try { await loadConversationProject(projectId, { append: true }); }
      catch (err) { _projectDetailLog.warn('load more project conversations failed', err); }
      finally { if (button.isConnected) button.disabled = false; }
    });
  }
  if (typeof _bindConversationSidebarItems === 'function') {
    _bindConversationSidebarItems(listEl, {
      selector: '.conv-item',
      onBucketToggle: _renderProjectAllTasks,
      async afterDelete() {
        if (typeof loadProjects === 'function') await loadProjects(true);
      },
    });
  }
  if (typeof _refreshAllConvBadges === 'function') _refreshAllConvBadges();
}

function _setCardCount(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = Number(n) > 0 ? String(n) : '';
}

function _setProjectAutoTabCount(n) {
  const el = document.getElementById('project-auto-tab-count');
  if (el) el.textContent = String(Math.max(0, Number(n) || 0));
}

// ── Project To-do card (structured task board — features/project_tasks.ts) ──
// Add through the shared side-card editor pattern, toggle open/done from the
// whole row, and delete with the isolated × action. Owner remains display-only.
// ── Project memory — the project's MEMORY.md: durable facts, decisions and
//    outcomes scoped to this project. The commander and the user can write it;
//    dispatched project agents receive it as read-only context.
let _projectMemory = [];
let _projectMemoryLoadSeq = 0;
let _projectMemoryEditor = null; // { mode:'add'|'edit', oldText:string } | null
let _projectMemoryMutating = false;

async function _loadProjectMemory(pid) {
  const loadSeq = ++_projectMemoryLoadSeq;
  if (!pid) { _projectMemory = []; _renderProjectMemoryList(); return; }
  let nextMemory = [];
  try {
    const res = await window.orkas.invoke('memory.list', { target: 'project', projectId: pid });
    nextMemory = (res && res.ok && Array.isArray(res.entries)) ? res.entries : [];
  } catch (err) {
    _projectDetailLog.warn('load project memory failed', err);
    nextMemory = [];
  }
  if (loadSeq !== _projectMemoryLoadSeq || pid !== _projectDetailPid) return;
  _projectMemory = nextMemory;
  _renderProjectMemoryList();
}

function _renderProjectMemoryList() {
  const listEl = document.getElementById('project-memory-list');
  const emptyEl = document.getElementById('project-memory-empty');
  const countEl = document.getElementById('project-memory-count');
  if (!listEl) return;
  const entries = Array.isArray(_projectMemory) ? _projectMemory : [];
  listEl.innerHTML = '';
  let shown = 0;
  entries.forEach((entry, index) => {
    const text = String(entry == null ? '' : entry).trim();
    if (!text) return;
    const row = document.createElement('div');
    row.className = 'project-memory-item';

    const textEl = document.createElement('div');
    textEl.className = 'project-memory-item-text';
    textEl.textContent = text;
    row.appendChild(textEl);

    const actions = document.createElement('div');
    actions.className = 'project-memory-item-actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'project-memory-item-action';
    edit.dataset.action = 'project-memory-edit';
    edit.dataset.memoryIndex = String(index);
    edit.title = t('project.memory.edit');
    edit.setAttribute('aria-label', edit.title);
    edit.innerHTML = typeof uiIconHtml === 'function' ? uiIconHtml('edit-pencil') : '✎';
    actions.appendChild(edit);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'project-memory-item-action is-danger';
    remove.dataset.action = 'project-memory-delete';
    remove.dataset.memoryIndex = String(index);
    remove.title = t('project.memory.delete');
    remove.setAttribute('aria-label', remove.title);
    remove.innerHTML = typeof uiIconHtml === 'function' ? uiIconHtml('x') : '×';
    actions.appendChild(remove);
    row.appendChild(actions);

    listEl.appendChild(row);
    shown += 1;
  });
  listEl.style.display = shown ? '' : 'none';
  if (countEl) countEl.textContent = shown > 0 ? String(shown) : '';
  if (emptyEl) emptyEl.style.display = shown ? 'none' : '';
}

function _updateProjectMemoryEditor() {
  const input = document.getElementById('project-memory-editor-input');
  const counter = document.getElementById('project-memory-editor-counter');
  const save = document.getElementById('project-memory-editor-save');
  if (!input) return;
  const text = input.value.trim();
  if (counter) counter.textContent = `${input.value.length}/${input.maxLength}`;
  if (save) {
    save.disabled = _projectMemoryMutating
      || !text
      || (_projectMemoryEditor?.mode === 'edit' && text === _projectMemoryEditor.oldText);
  }
}

function _openProjectMemoryEditor(mode, oldText = '') {
  const editor = document.getElementById('project-memory-editor');
  const input = document.getElementById('project-memory-editor-input');
  if (!editor || !input) return;
  _projectMemoryEditor = { mode: mode === 'edit' ? 'edit' : 'add', oldText: String(oldText || '') };
  input.value = _projectMemoryEditor.oldText;
  editor.hidden = false;
  _updateProjectMemoryEditor();
  setTimeout(() => {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, 0);
}

function _closeProjectMemoryEditor() {
  const editor = document.getElementById('project-memory-editor');
  const input = document.getElementById('project-memory-editor-input');
  _projectMemoryEditor = null;
  if (input) input.value = '';
  if (editor) editor.hidden = true;
  _updateProjectMemoryEditor();
}

async function _mutateProjectMemory(channel, payload) {
  if (!_projectDetailPid || _projectMemoryMutating) return false;
  const pid = _projectDetailPid;
  _projectMemoryMutating = true;
  _projectMemoryLoadSeq += 1;
  _updateProjectMemoryEditor();
  try {
    const res = await window.orkas.invoke(channel, {
      target: 'project',
      projectId: pid,
      ...(payload || {}),
    });
    if (!res || res.ok === false) throw new Error(res?.error || 'memory_update_failed');
    if (pid !== _projectDetailPid) return false;
    if (Array.isArray(res.entries)) {
      _projectMemory = res.entries;
      _renderProjectMemoryList();
    } else {
      await _loadProjectMemory(pid);
    }
    return true;
  } catch (err) {
    _projectDetailLog.warn('project memory mutate failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('project.memory.failed'));
    return false;
  } finally {
    _projectMemoryMutating = false;
    _updateProjectMemoryEditor();
  }
}

async function _saveProjectMemoryEditor() {
  const input = document.getElementById('project-memory-editor-input');
  const content = String(input?.value || '').trim();
  if (!content || !_projectMemoryEditor) return;
  const isEdit = _projectMemoryEditor.mode === 'edit';
  const oldText = _projectMemoryEditor.oldText;
  const ok = await _mutateProjectMemory(
    isEdit ? 'memory.replace' : 'memory.add',
    isEdit ? { oldText, content } : { content },
  );
  if (ok) _closeProjectMemoryEditor();
}

function _bindProjectMemory() {
  const add = document.getElementById('project-memory-add-btn');
  const input = document.getElementById('project-memory-editor-input');
  const cancel = document.getElementById('project-memory-editor-cancel');
  const save = document.getElementById('project-memory-editor-save');
  const list = document.getElementById('project-memory-list');

  if (add && add.dataset.bound !== '1') {
    add.dataset.bound = '1';
    add.addEventListener('click', () => _openProjectMemoryEditor('add'));
  }
  if (input && input.dataset.bound !== '1') {
    input.dataset.bound = '1';
    input.addEventListener('input', _updateProjectMemoryEditor);
    input.addEventListener('keydown', (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        _closeProjectMemoryEditor();
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        _saveProjectMemoryEditor();
      }
    });
  }
  if (cancel && cancel.dataset.bound !== '1') {
    cancel.dataset.bound = '1';
    cancel.addEventListener('click', _closeProjectMemoryEditor);
  }
  if (save && save.dataset.bound !== '1') {
    save.dataset.bound = '1';
    save.addEventListener('click', _saveProjectMemoryEditor);
  }
  if (list && list.dataset.bound !== '1') {
    list.dataset.bound = '1';
    list.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-action^="project-memory-"]');
      if (!button) return;
      const index = Number(button.dataset.memoryIndex);
      const text = String(_projectMemory[index] || '').trim();
      if (!text) return;
      if (button.dataset.action === 'project-memory-edit') {
        _openProjectMemoryEditor('edit', text);
        return;
      }
      if (button.dataset.action !== 'project-memory-delete') return;
      const confirmed = typeof uiConfirm === 'function'
        ? await uiConfirm({
          message: t('project.memory.delete_confirm'),
          okLabel: t('project.memory.delete'),
          cancelLabel: t('project.memory.cancel'),
        })
        : false;
      if (!confirmed) return;
      const ok = await _mutateProjectMemory('memory.remove', { oldText: text });
      if (ok && _projectMemoryEditor?.oldText === text) _closeProjectMemoryEditor();
    });
  }
  if (!_projectMemoryEditor) _closeProjectMemoryEditor();
}

let _projectTodos = [];
let _projectTodoLoadSeq = 0;
let _projectTodoMutating = false;

async function _loadProjectTodos(pid) {
  const loadSeq = ++_projectTodoLoadSeq;
  if (!pid) { _projectTodos = []; _renderProjectTodosList(); return; }
  let nextTodos = [];
  try {
    const res = await window.orkas.invoke('projects.tasks.list', { projectId: pid });
    nextTodos = (res && res.ok && Array.isArray(res.tasks)) ? res.tasks : [];
  } catch (err) {
    _projectDetailLog.warn('load project todos failed', err);
    nextTodos = [];
  }
  // Ignore responses superseded by a mutation/newer refresh as well as
  // responses that belong to a project the user has already left.
  if (loadSeq !== _projectTodoLoadSeq || pid !== _projectDetailPid) return;
  _projectTodos = nextTodos;
  _renderProjectTodosList();
}

function _renderProjectTodosList() {
  const listEl = document.getElementById('project-todo-list');
  const emptyEl = document.getElementById('project-todo-empty');
  const countEl = document.getElementById('project-todo-count');
  if (!listEl) return;
  const tasks = Array.isArray(_projectTodos) ? _projectTodos : [];
  const total = tasks.length;
  const done = tasks.filter((task) => task && task.status === 'done').length;
  if (countEl) countEl.textContent = total > 0 ? `${done}/${total}` : '';
  listEl.innerHTML = '';
  listEl.style.display = total ? '' : 'none';
  if (!total) { if (emptyEl) emptyEl.style.display = ''; return; }
  if (emptyEl) emptyEl.style.display = 'none';
  for (const task of tasks) {
    if (!task || !task.id) continue;
    const status = task.status || 'todo';
    const row = document.createElement('div');
    row.className = 'project-todo-item'
      + (status === 'done' ? ' is-done' : '')
      + (status === 'cancelled' ? ' is-cancelled' : '');
    row.dataset.tid = task.id;
    row.dataset.status = status;

    const statusBtn = document.createElement('button');
    statusBtn.type = 'button';
    statusBtn.className = 'project-todo-status';
    statusBtn.dataset.status = status;
    statusBtn.title = t('project.todo.status_' + status);
    statusBtn.setAttribute('aria-label', statusBtn.title);
    row.appendChild(statusBtn);

    const titleEl = document.createElement('span');
    titleEl.className = 'project-todo-title';
    titleEl.textContent = task.title || '';
    row.appendChild(titleEl);

    if (task.owner_agent) {
      const owner = document.createElement('span');
      owner.className = 'project-todo-owner muted';
      owner.textContent = '@' + task.owner_agent;
      row.appendChild(owner);
    }

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'project-todo-del';
    del.dataset.action = 'todo-delete';
    del.title = t('project.todo.delete');
    del.setAttribute('aria-label', del.title);
    del.textContent = '×';
    row.appendChild(del);

    listEl.appendChild(row);
  }
}

function _updateProjectTodoEditor() {
  const input = document.getElementById('project-todo-input');
  const counter = document.getElementById('project-todo-counter');
  const save = document.getElementById('project-todo-save');
  if (!input) return;
  if (counter) counter.textContent = `${input.value.length}/${input.maxLength}`;
  if (save) save.disabled = _projectTodoMutating || !input.value.trim();
}

function _openProjectTodoEditor() {
  const editor = document.getElementById('project-todo-add');
  const input = document.getElementById('project-todo-input');
  if (!editor || !input) return;
  editor.hidden = false;
  _updateProjectTodoEditor();
  setTimeout(() => {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, 0);
}

function _closeProjectTodoEditor() {
  const editor = document.getElementById('project-todo-add');
  const input = document.getElementById('project-todo-input');
  if (input) input.value = '';
  if (editor) editor.hidden = true;
  _updateProjectTodoEditor();
}

async function _todoMutate(fn) {
  const pid = _projectDetailPid;
  if (!pid || _projectTodoMutating) return false;
  _projectTodoMutating = true;
  _updateProjectTodoEditor();
  // Invalidate any list request that started before this mutation. Otherwise
  // its stale payload can repaint a task immediately after a successful delete.
  _projectTodoLoadSeq += 1;
  let ok = false;
  try {
    const res = await fn();
    if (res && res.ok === false) throw new Error(res.error || 'failed');
    ok = true;
  } catch (err) {
    _projectDetailLog.warn('project todo mutate failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('project.todo.failed'));
  } finally {
    _projectTodoMutating = false;
    _updateProjectTodoEditor();
  }
  if (pid === _projectDetailPid) await _loadProjectTodos(pid);
  return ok;
}

async function _saveProjectTodoEditor() {
  const input = document.getElementById('project-todo-input');
  const title = String(input?.value || '').trim();
  if (!title || !_projectDetailPid) return;
  const ok = await _todoMutate(() => window.orkas.invoke('projects.tasks.create', {
    projectId: _projectDetailPid,
    title,
  }));
  if (ok) _closeProjectTodoEditor();
}

function _nextProjectTodoStatus(status) {
  return status === 'done' ? 'todo' : 'done';
}

function _bindProjectTodos() {
  const addBtn = document.getElementById('project-todo-add-btn');
  const input = document.getElementById('project-todo-input');
  const cancel = document.getElementById('project-todo-cancel');
  const save = document.getElementById('project-todo-save');
  const listEl = document.getElementById('project-todo-list');

  if (addBtn && addBtn.dataset.bound !== '1') {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', _openProjectTodoEditor);
  }
  if (input && input.dataset.bound !== '1') {
    input.dataset.bound = '1';
    input.addEventListener('input', _updateProjectTodoEditor);
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return; // IME composition guard
      if (e.key === 'Escape') {
        e.preventDefault();
        _closeProjectTodoEditor();
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        _saveProjectTodoEditor();
      }
    });
  }
  if (cancel && cancel.dataset.bound !== '1') {
    cancel.dataset.bound = '1';
    cancel.addEventListener('click', _closeProjectTodoEditor);
  }
  if (save && save.dataset.bound !== '1') {
    save.dataset.bound = '1';
    save.addEventListener('click', _saveProjectTodoEditor);
  }
  if (listEl && listEl.dataset.bound !== '1') {
    listEl.dataset.bound = '1';
    listEl.addEventListener('click', async (e) => {
      const target = e.target;
      const row = target?.closest?.('.project-todo-item');
      const tid = row?.dataset.tid;
      if (!tid || !_projectDetailPid || _projectTodoMutating) return;
      const deleteBtn = target?.closest?.('[data-action="todo-delete"]');
      if (deleteBtn) {
        await _todoMutate(() => window.orkas.invoke('projects.tasks.delete', { projectId: _projectDetailPid, taskId: tid }));
        return;
      }
      const fromStatus = row.dataset.status || 'todo';
      const nextStatus = _nextProjectTodoStatus(fromStatus);
      const startedAt = Date.now();
      _projectTrackClick('project_todo_toggle', {
        project_id: _projectDetailPid,
        from_status: fromStatus,
        to_status: nextStatus,
      });
      const ok = await _todoMutate(() => window.orkas.invoke('projects.tasks.update', {
        projectId: _projectDetailPid,
        taskId: tid,
        status: nextStatus,
      }));
      const resultPayload = {
        project_id: _projectDetailPid,
        result: ok ? 'success' : 'failure',
        from_status: fromStatus,
        to_status: nextStatus,
        duration_ms: Date.now() - startedAt,
      };
      _projectTrackEvent('project_todo_toggle_result', resultPayload);
      if (!ok) {
        _projectTrackError('project_todo_toggle', {
          project_id: _projectDetailPid,
          from_status: fromStatus,
          to_status: nextStatus,
          error_type: 'update_failed',
        });
      }
    });
  }
}

function _renderProjectAgentCards(items) {
  const sorted = (items || []).slice().sort(_byDisplayName);
  if (!sorted.length) return '';
  const useTitle = escapeHtml(t('agents.use_tooltip'));
  const useLabel = escapeHtml(t('agents.use'));
  const removeTitle = escapeHtml(t('project.bindings.remove'));
  return sorted.map((a) => {
    const id = a.agent_id || a.id || '';
    const enabled = a.enabled !== false;
    const avatarHtml = (typeof renderAvatarHtml === 'function')
      ? renderAvatarHtml(a.icon, a.color, {
        size: 28, seed: id, extraClass: 'project-agent-row-avatar',
      })
      : '';
    return `
      <div class="project-agent-row${enabled ? '' : ' is-disabled'}" role="button" tabindex="0"
           data-project-agent-id="${escapeHtml(id)}" data-project-agent-name="${escapeHtml(a.name || '')}" data-source="${escapeHtml(a.source || '')}">
        ${avatarHtml}
        <span class="project-agent-row-name">${escapeHtml(a.name || t('agents.unnamed'))}</span>
        <div class="project-agent-row-actions">
          <button type="button" class="project-agent-row-run agent-card-use" data-project-agent-run title="${useTitle}" aria-label="${useTitle}">
            ${useLabel}
          </button>
          <button type="button" class="project-agent-row-remove" data-project-agent-remove title="${removeTitle}" aria-label="${removeTitle}">
            ${_projectUiIconHtml('x', 'project-agent-remove-icon') || '×'}
          </button>
        </div>
      </div>
    `;
  }).join('');
}

function _bindProjectAgentCards() {
  const root = document.getElementById('project-agents-list');
  if (!root) return;
  root.querySelectorAll('.project-agent-row[data-project-agent-id]').forEach((card) => {
    const id = card.dataset.projectAgentId || '';
    card.addEventListener('click', async () => {
      await _openProjectAgentDetail(id);
    });
    card.addEventListener('keydown', async (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.target?.closest?.('button')) return;
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      await _openProjectAgentDetail(id);
    });
    card.querySelector('[data-project-agent-run]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await _selectProjectAgentRecipient(id, card.dataset.projectAgentName || '');
    });
    card.querySelector('[data-project-agent-remove]')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      await _removeProjectAgent(id);
    });
  });
}

async function _openProjectAgentDetail(agentId) {
  if (!agentId) return;
  try {
    if (typeof setView === 'function') setView('agents');
    if (typeof _showAgentsDetailView === 'function') {
      await _showAgentsDetailView(agentId);
    } else if (typeof selectAgent === 'function') {
      await selectAgent(agentId);
    }
  } catch (err) {
    _projectDetailLog.warn('open project agent detail failed', err);
  }
}

async function _selectProjectAgentRecipient(agentId, agentName = '') {
  if (!agentId) return;
  try {
    if (typeof setChatRecipient === 'function') {
      setChatRecipient('project', { kind: 'agent', id: agentId, name: agentName || agentId });
    }
    _projectTrackClick('project_agent_select_recipient', {
      project_id: _projectDetailPid,
      agent_id: agentId,
    });
    setTimeout(() => {
      try { document.getElementById('project-chat-input')?.focus(); } catch (_) {}
    }, 0);
  } catch (e) {
    if (typeof uiAlert === 'function') await uiAlert(t('agents.launch_failed', { reason: e.message || e }));
  }
}

function _openProjectAgentMenu(anchorBtn, agentId) {
  let menu = document.getElementById('project-agent-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'project-agent-row-menu';
    menu.className = 'ctx-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.agentId === agentId && menu.style.display !== 'none';
  if (sameAnchor) { _closeProjectAgentMenu(); return; }
  _closeProjectAgentMenu();
  menu.innerHTML = `<div class="ctx-row-menu-item is-danger" data-action="remove">${escapeHtml(t('project.bindings.remove'))}</div>`;
  menu.dataset.agentId = agentId;
  const card = anchorBtn.closest('.agent-card');
  if (card) card.classList.add('is-menu-open');
  _positionProjectFileMenu(menu, anchorBtn);
  menu.querySelector('[data-action="remove"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    _closeProjectAgentMenu();
    await _removeProjectAgent(agentId);
  });
  setTimeout(() => {
    document.addEventListener('mousedown', _onProjectAgentMenuOutside, true);
    document.addEventListener('keydown', _onProjectAgentMenuKeyDown, true);
    window.addEventListener('resize', _closeProjectAgentMenu, { once: true });
  }, 0);
}

function _closeProjectAgentMenu() {
  const menu = document.getElementById('project-agent-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.agentId;
  }
  document.querySelectorAll('#project-agents-list .agent-card.is-menu-open')
    .forEach((card) => card.classList.remove('is-menu-open'));
  document.removeEventListener('mousedown', _onProjectAgentMenuOutside, true);
  document.removeEventListener('keydown', _onProjectAgentMenuKeyDown, true);
  window.removeEventListener('resize', _closeProjectAgentMenu);
}

function _onProjectAgentMenuOutside(ev) {
  const menu = document.getElementById('project-agent-row-menu');
  if (!menu || menu.style.display === 'none') return;
  if (menu.contains(ev.target)) return;
  if (ev.target && ev.target.closest && ev.target.closest('[data-project-agent-more]')) return;
  _closeProjectAgentMenu();
}

function _onProjectAgentMenuKeyDown(ev) {
  if (ev.key === 'Escape') _closeProjectAgentMenu();
}

async function _removeProjectAgent(agentId) {
  if (!_projectDetailPid || !agentId) return;
  try {
    const res = await window.orkas.invoke('projects.bindings.remove', {
      projectId: _projectDetailPid,
      kind: 'agent',
      id: agentId,
    });
    if (res && res.ok === false) throw new Error(res.error || 'remove_failed');
    await loadProjectDetail(_projectDetailPid);
  } catch (err) {
    _projectDetailLog.warn('remove project agent failed', err);
  }
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
    const descHtml = desc ? `<div class="project-binding-desc">${escapeHtml(desc)}</div>` : '';
    const sourceTag = _projectBindingSourceHtml(it.source, kind);
    // Agents carry an avatar (icon + color seeded by agent_id) — mirrors
    // the agents grid card chrome so a binding row reads as the same actor.
    // Skills don't have an avatar in the spec; we leave the slot empty.
    const avatarHtml = (kind === 'agent' && typeof renderAvatarHtml === 'function')
      ? renderAvatarHtml(it.icon, it.color, {
        size: 32, seed: it.agent_id, extraClass: 'project-binding-avatar',
      })
      : '';
    rows.push(`
      <div class="project-binding-row" data-kind="${kind}" data-id="${escapeHtml(id)}">
        ${avatarHtml}
        <div class="project-binding-main">
          <div class="project-binding-head">
            <span class="project-binding-name">${name}</span>
            ${sourceTag}
          </div>
          ${descHtml}
        </div>
        <button type="button" class="project-binding-remove" data-action="remove"
                title="${removeLabel}" aria-label="${removeLabel}">×</button>
      </div>
    `);
  }
  if (!rows.length) {
    const emptyKey = kind === 'agent' ? 'project.bindings.empty_agents' : 'project.bindings.empty_skills';
    return `<div class="empty" data-i18n="${emptyKey}">${escapeHtml(t(emptyKey))}</div>`;
  }
  return rows.join('');
}

function _isProjectLibraryVectorizableKind(kind) {
  return ['text', 'pdf', 'docx', 'spreadsheet', 'presentation', 'image'].includes(String(kind || ''));
}

function _projectLibraryRel(node) {
  return String(node?.relPath || node?.name || '');
}

function _projectBasename(rel) {
  const s = String(rel || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function _projectDirname(rel) {
  const s = String(rel || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(0, i) : '';
}

function _projectJoinPath(dir, name) {
  const d = String(dir || '').replace(/\/+$/, '');
  const n = String(name || '').replace(/^\/+/, '');
  return d ? `${d}/${n}` : n;
}

function _projectFormatMtime(mtime) {
  const n = Number(mtime);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n > 100000000000 ? n : n * 1000;
  try {
    const locale = (typeof getLocaleMeta === 'function' && typeof getLang === 'function')
      ? getLocaleMeta(getLang()).intlLocale
      : undefined;
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toLocaleString();
  }
}

function _projectFileIconHtml(name, kind) {
  if (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function') {
    return window.fileKindIconHtml(name, kind);
  }
  return _projectUiIconHtml('file', 'skill-tree-node-svg');
}

function _flattenProjectLibraryFiles(nodes) {
  const out = [];
  const walk = (items) => {
    for (const node of items || []) {
      if (!node) continue;
      if (node.type === 'dir') walk(node.children || []);
      else out.push(node);
    }
  };
  walk(nodes || []);
  return out;
}

function _projectLibraryEntryPaths(nodes, out = []) {
  for (const node of nodes || []) {
    const rel = _projectLibraryRel(node);
    if (!rel) continue;
    out.push(rel);
    if (node.type === 'dir') _projectLibraryEntryPaths(node.children || [], out);
  }
  return out;
}

function _sortProjectLibraryNodes(nodes) {
  return (nodes || []).slice().sort((a, b) => {
    const at = a?.type === 'dir';
    const bt = b?.type === 'dir';
    if (at !== bt) return at ? -1 : 1;
    const an = a?.name || _projectBasename(_projectLibraryRel(a));
    const bn = b?.name || _projectBasename(_projectLibraryRel(b));
    return an.localeCompare(bn, undefined, { sensitivity: 'base', numeric: true });
  });
}

function _buildProjectKbStatusMap(files, statusRows) {
  const next = {};
  for (const row of statusRows || []) {
    const name = row?.name || row?.path;
    if (!name) continue;
    next[name] = {
      status: row.status,
      chunks: row.chunks,
      error: row.error,
      kind: row.kind,
    };
  }
  for (const file of files || []) {
    const name = _projectLibraryRel(file);
    if (!name || !_isProjectLibraryVectorizableKind(file.kind)) continue;
    if (!next[name]) next[name] = { status: 'pending', kind: file.kind };
  }
  return next;
}

function _hasActiveProjectKbStatuses() {
  return Object.values(_projectKbStatusByName || {}).some((st) =>
    st && (st.status === 'pending' || st.status === 'processing'));
}

function _hasPendingProjectKbStatuses() {
  return Object.values(_projectKbStatusByName || {}).some((st) =>
    st && st.status === 'pending');
}

async function _refreshProjectKbStatusSnapshot(pid) {
  if (!pid || pid !== _projectDetailPid) return;
  const res = await window.orkas.invoke('projects.files.status', { projectId: pid, skipReconcile: true });
  if (!res?.ok || pid !== _projectDetailPid) return;
  const flatFiles = _flattenProjectLibraryFiles(_projectDetailMeta?.files || []);
  _projectKbStatusByName = _buildProjectKbStatusMap(flatFiles, res.files || []);
  for (const file of flatFiles) {
    const name = _projectLibraryRel(file);
    if (name) _updateProjectFileKbChip(name);
  }
}

function _kickProjectKbReconcileIfNeeded() {
  if (_projectKbReconcileInFlight || !_hasPendingProjectKbStatuses()) return;
  const pid = _projectDetailPid;
  if (!pid) return;
  _projectKbReconcileInFlight = true;
  window.orkas.invoke('projects.files.reconcile', { projectId: pid })
    .then(() => _refreshProjectKbStatusSnapshot(pid))
    .catch((err) => _projectDetailLog.warn('project kb reconcile failed', err))
    .finally(() => {
      _projectKbReconcileInFlight = false;
      _scheduleProjectKbStatusRefreshIfNeeded();
    });
}

function _scheduleProjectKbStatusRefreshIfNeeded() {
  if (_projectKbStatusRefreshTimer || !_hasActiveProjectKbStatuses()) return;
  if (typeof currentView !== 'undefined' && currentView !== 'project') return;
  const pid = _projectDetailPid;
  _projectKbStatusRefreshTimer = setTimeout(async () => {
    _projectKbStatusRefreshTimer = null;
    if (!pid || pid !== _projectDetailPid) return;
    if (typeof currentView !== 'undefined' && currentView !== 'project') return;
    try { await _refreshProjectKbStatusSnapshot(pid); }
    catch (err) { _projectDetailLog.warn('project kb status refresh failed', err); }
    if (_hasActiveProjectKbStatuses()) {
      _kickProjectKbReconcileIfNeeded();
      _scheduleProjectKbStatusRefreshIfNeeded();
    }
  }, 2000);
}

function _projectKbStatusChipHtml(name) {
  const st = _projectKbStatusByName[name];
  if (!st) return '';
  if (st.status === 'ready') return '';
  if (st.status === 'processing' || st.status === 'pending') {
    const label = st.status === 'pending' ? t('contexts.kb.pending') : t('contexts.kb.processing');
    return `<span class="ctx-kb-chip is-processing" title="${escapeHtml(label)}"><span class="ctx-kb-spinner"></span></span>`;
  }
  if (st.status === 'failed') {
    return `<span class="ctx-kb-chip is-failed" data-action="project-file-reprocess" title="${escapeHtml(t('contexts.kb.failed'))}">!</span>`;
  }
  return '';
}

function _findProjectFileRow(name) {
  const rows = document.querySelectorAll('.project-file-row[data-project-file]');
  for (const row of rows) {
    if ((row.dataset.projectFile || '') === name) return row;
  }
  return null;
}

function _findProjectDirRow(name) {
  const rows = document.querySelectorAll('.project-dir-row[data-project-dir]');
  for (const row of rows) {
    if ((row.dataset.projectDir || '') === name) return row;
  }
  return null;
}

function _renderProjectFiles(files) {
  const list = document.getElementById('project-files-list');
  const status = document.getElementById('project-files-status');
  if (!list) return;
  if (status) {
    status.textContent = '';
    status.style.display = 'none';
  }
  const nodes = Array.isArray(files) ? files : [];
  _setCardCount('project-detail-files-count', _flattenProjectLibraryFiles(nodes).length);
  if (!nodes.length) {
    _projectLibrarySelected.clear();
    _projectLibrarySelectionAnchor = null;
    list.innerHTML = `<div class="empty" data-i18n="project.files.empty">${escapeHtml(t('project.files.empty'))}</div>`;
    _renderProjectLibraryBatchBar();
    if (_projectLibraryActiveName) _clearProjectLibraryViewer();
    return;
  }
  const existing = new Set(_projectLibraryEntryPaths(nodes));
  for (const rel of Array.from(_projectLibrarySelected)) {
    if (!existing.has(rel)) _projectLibrarySelected.delete(rel);
  }
  if (_projectLibrarySelectionAnchor && !existing.has(_projectLibrarySelectionAnchor)) {
    _projectLibrarySelectionAnchor = null;
  }
  const flatFiles = _flattenProjectLibraryFiles(nodes);
  list.innerHTML = _renderProjectFileNodes(nodes);
  _renderProjectLibraryBatchBar();
  if (_projectLibraryActiveName && !flatFiles.some((f) => _projectLibraryRel(f) === _projectLibraryActiveName)) {
    _clearProjectLibraryViewer();
  }
}

function _renderProjectFileNodes(nodes, depth = 0) {
  const moreLabel = escapeHtml(t('contexts.menu.more_actions'));
  const indent = 10 + depth * 14;
  return _sortProjectLibraryNodes(nodes).map((f) => {
    const rel = _projectLibraryRel(f);
    const name = f.name || _projectBasename(rel);
    const label = escapeHtml(name);
    if (f.type === 'dir') {
      const open = _projectLibraryExpanded.has(rel);
      const selected = _projectLibrarySelected.has(rel) ? ' is-selected' : '';
      const caretCls = open ? 'skill-tree-caret' : 'skill-tree-caret collapsed';
      const icon = open
        ? _projectUiIconHtml('folder-open', 'skill-tree-node-svg')
        : _projectUiIconHtml('folder', 'skill-tree-node-svg');
      const childrenHtml = open
        ? `<div class="skill-tree-children">${_renderProjectFileNodes(f.children || [], depth + 1)}</div>`
        : '';
      return `
        <div class="ctx-tree-wrap project-dir-row" data-project-dir="${escapeHtml(rel)}" data-type="dir" draggable="true">
          <div class="skill-tree-node skill-tree-dir${selected}" style="padding-left:${indent}px" title="${escapeHtml(rel)}">
            <span class="${caretCls}"></span>
            <span class="skill-tree-icon icon-folder">${icon}</span>
            <span class="skill-tree-label">${label}</span>
            <button type="button" class="ctx-row-menu-btn project-file-menu-btn" data-action="project-dir-menu"
                    title="${moreLabel}" aria-label="${moreLabel}">${_projectUiIconHtml('more-horizontal', 'ctx-row-menu-icon')}</button>
          </div>
          ${childrenHtml}
        </div>
      `;
    }
    const chip = _projectKbStatusChipHtml(rel);
    const ext = _projectFileExt(name).replace(/^\./, '');
    const active = _projectLibraryActiveName === rel ? ' active' : '';
    const selected = _projectLibrarySelected.has(rel) ? ' is-selected' : '';
    const mtime = _projectFormatMtime(f.mtime);
    return `
      <div class="ctx-tree-wrap project-file-row" data-project-file="${escapeHtml(rel)}" data-project-file-kind="${escapeHtml(f.kind || '')}" data-type="file" draggable="true">
        <div class="skill-tree-node skill-tree-file${active}${selected}" data-ext="${escapeHtml(ext)}" style="padding-left:${indent}px" title="${escapeHtml(rel)}">
          <span class="skill-tree-caret skill-tree-caret-empty"></span>
          <span class="skill-tree-icon icon-file" data-ext="${escapeHtml(ext)}">${_projectFileIconHtml(name, f.kind)}</span>
          <span class="skill-tree-main"><span class="skill-tree-label">${label}</span>${mtime ? `<span class="skill-tree-meta">${escapeHtml(mtime)}</span>` : ''}</span>
          ${chip}
          <button type="button" class="ctx-row-menu-btn project-file-menu-btn" data-action="project-file-menu"
                  title="${moreLabel}" aria-label="${moreLabel}">${_projectUiIconHtml('more-horizontal', 'ctx-row-menu-icon')}</button>
        </div>
      </div>
    `;
  }).join('');
}

function _syncProjectLibrarySelectionDom() {
  const root = document.getElementById('project-files-list');
  root?.querySelectorAll('.ctx-tree-wrap[data-type]').forEach((row) => {
    const rel = row.dataset.type === 'dir' ? row.dataset.projectDir : row.dataset.projectFile;
    row.querySelector(':scope > .skill-tree-node')?.classList.toggle('is-selected', _projectLibrarySelected.has(rel));
  });
  _renderProjectLibraryBatchBar();
}

function _selectProjectLibraryEntry(rel, event) {
  const root = document.getElementById('project-files-list');
  if (!root) return false;
  const toggle = !!(event?.metaKey || event?.ctrlKey);
  const range = !!event?.shiftKey;
  if (range && _projectLibrarySelectionAnchor) {
    const visible = Array.from(root.querySelectorAll('.ctx-tree-wrap[data-type]'))
      .filter((row) => row.offsetParent !== null)
      .map((row) => row.dataset.type === 'dir' ? row.dataset.projectDir : row.dataset.projectFile);
    const start = visible.indexOf(_projectLibrarySelectionAnchor);
    const end = visible.indexOf(rel);
    if (start >= 0 && end >= 0) {
      if (!toggle) _projectLibrarySelected.clear();
      const [lo, hi] = start <= end ? [start, end] : [end, start];
      for (const path of visible.slice(lo, hi + 1)) if (path) _projectLibrarySelected.add(path);
    }
  } else if (toggle) {
    if (_projectLibrarySelected.has(rel)) _projectLibrarySelected.delete(rel);
    else _projectLibrarySelected.add(rel);
    _projectLibrarySelectionAnchor = rel;
  } else {
    _projectLibrarySelected.clear();
    _projectLibrarySelected.add(rel);
    _projectLibrarySelectionAnchor = rel;
  }
  _syncProjectLibrarySelectionDom();
  return toggle || range;
}

function _projectLibrarySelectionFor(rel) {
  if (_projectLibrarySelected.has(rel)) return Array.from(_projectLibrarySelected);
  _projectLibrarySelected.clear();
  _projectLibrarySelected.add(rel);
  _projectLibrarySelectionAnchor = rel;
  _syncProjectLibrarySelectionDom();
  return [rel];
}

function _renderProjectLibraryBatchBar() {
  const host = document.querySelector('.project-side-library');
  if (!host) return;
  let bar = document.getElementById('project-library-batch-bar');
  if (_projectLibrarySelected.size < 2) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'project-library-batch-bar';
    bar.className = 'library-batch-bar';
    host.appendChild(bar);
  }
  bar.innerHTML = `
    <span class="library-batch-count">${escapeHtml(t('contexts.transfer.selected_count', { count: _projectLibrarySelected.size }))}</span>
    <button type="button" class="btn btn-sm btn-primary" data-library-batch-organize>${escapeHtml(t('contexts.transfer.title'))}</button>
    <button type="button" class="library-batch-clear" data-library-batch-clear title="${escapeHtml(t('contexts.transfer.clear_selection'))}" aria-label="${escapeHtml(t('contexts.transfer.clear_selection'))}">${_projectUiIconHtml('x', 'library-batch-clear-icon')}</button>
  `;
  bar.querySelector('[data-library-batch-organize]')?.addEventListener('click', () => {
    _openProjectLibraryTransfer(Array.from(_projectLibrarySelected), 'batch');
  });
  bar.querySelector('[data-library-batch-clear]')?.addEventListener('click', () => {
    _projectLibrarySelected.clear();
    _projectLibrarySelectionAnchor = null;
    _syncProjectLibrarySelectionDom();
  });
}

function _projectLibraryHasDragType(dataTransfer, type) {
  try { return Array.from(dataTransfer?.types || []).includes(type); }
  catch (_) { return false; }
}

function _projectLibraryDragKind(dataTransfer) {
  if (_projectLibraryHasDragType(dataTransfer, PROJECT_LIBRARY_INTERNAL_DRAG_TYPE)) return 'internal';
  if (_projectLibraryHasDragType(dataTransfer, 'Files') || (dataTransfer?.files?.length || 0) > 0) return 'external';
  return '';
}

function _projectLibraryDropPayload(dataTransfer) {
  let src = '';
  try { src = dataTransfer?.getData?.(PROJECT_LIBRARY_INTERNAL_DRAG_TYPE) || ''; }
  catch (_) { /* protected drag data — advertised types are enough until drop */ }
  if (src) return { kind: 'internal', src, files: [] };
  const files = Array.from(dataTransfer?.files || []).filter(Boolean);
  if (_projectLibraryHasDragType(dataTransfer, 'Files') || files.length) {
    return { kind: 'external', src: '', files };
  }
  return { kind: '', src: '', files: [] };
}

function _projectLibraryParentDir(relPath) {
  const rel = String(relPath || '');
  const slash = rel.lastIndexOf('/');
  return slash >= 0 ? rel.slice(0, slash) : '';
}

function _projectLibraryExternalDropTargetDir(target) {
  const row = target?.closest?.('.ctx-tree-wrap');
  if (!row) return '';
  if (row.dataset?.type === 'dir') return String(row.dataset?.projectDir || '');
  return _projectLibraryParentDir(row.dataset?.projectFile || '');
}

function _clearProjectLibraryDropHighlights(root) {
  root.classList.remove('is-root-drag-over');
  root.querySelectorAll('.skill-tree-node.is-drag-over')
    .forEach((node) => node.classList.remove('is-drag-over'));
}

function _showProjectLibraryExternalDropTarget(root, targetDir) {
  _clearProjectLibraryDropHighlights(root);
  if (!targetDir) {
    root.classList.add('is-root-drag-over');
    return;
  }
  const targetRow = Array.from(root.querySelectorAll('.project-dir-row[data-project-dir]'))
    .find((row) => row.dataset?.projectDir === targetDir);
  targetRow?.querySelector(':scope > .skill-tree-node')?.classList.add('is-drag-over');
}

async function _handleProjectLibraryDrop(dataTransfer, targetDir) {
  const payload = _projectLibraryDropPayload(dataTransfer);
  if (payload.kind === 'internal') {
    await _handleProjectLibraryMove(payload.src, targetDir);
    return true;
  }
  if (payload.kind === 'external' && payload.files.length) {
    await _uploadProjectFiles(payload.files, targetDir, 'drop');
    return true;
  }
  return false;
}

function _bindProjectLibraryDetailDrop(container, getTargetDir = () => _projectLibraryParentDir(_projectLibraryActiveName)) {
  if (!container || container.dataset.externalDropBound) return;
  container.dataset.externalDropBound = '1';
  container.addEventListener('dragover', (e) => {
    if (_projectLibraryDragKind(e.dataTransfer) !== 'external') return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    container.classList.add('is-external-drag-over');
  });
  container.addEventListener('dragleave', (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    container.classList.remove('is-external-drag-over');
  });
  container.addEventListener('drop', async (e) => {
    if (_projectLibraryDragKind(e.dataTransfer) !== 'external') return;
    e.preventDefault();
    e.stopPropagation();
    container.classList.remove('is-external-drag-over');
    await _handleProjectLibraryDrop(e.dataTransfer, getTargetDir());
  });
}

function _bindProjectFileRows() {
  const root = document.getElementById('project-files-list');
  if (!root) return;
  root.querySelectorAll('.project-dir-row[data-project-dir]').forEach((row) => {
    const rel = row.dataset.projectDir || '';
    const node = row.querySelector(':scope > .skill-tree-node') || row;
    node.addEventListener('click', async (e) => {
      if (e.target.closest('[data-action="project-dir-menu"]')) {
        e.stopPropagation();
        _projectLibrarySelectionFor(rel);
        _openProjectDirMenu(e.target.closest('[data-action="project-dir-menu"]'), rel);
        return;
      }
      e.stopPropagation();
      if (_selectProjectLibraryEntry(rel, e)) return;
      if (_projectLibraryExpanded.has(rel)) _projectLibraryExpanded.delete(rel);
      else _projectLibraryExpanded.add(rel);
      _renderProjectFiles(_projectDetailMeta?.files || []);
      _bindProjectFileRows();
      if (typeof hydrateUiIcons === 'function') hydrateUiIcons(document.getElementById('project-files-list'));
    });
  });
  root.querySelectorAll('.project-file-row[data-project-file]').forEach((row) => {
    const name = row.dataset.projectFile || '';
    const node = row.querySelector(':scope > .skill-tree-node') || row;
    node.addEventListener('click', async (e) => {
      if (e.target.closest('[data-action="project-file-menu"]')) {
        e.stopPropagation();
        _projectLibrarySelectionFor(name);
        _openProjectFileMenu(e.target.closest('[data-action="project-file-menu"]'), name);
        return;
      }
      if (e.target.closest('[data-action="project-file-reprocess"]')) {
        e.stopPropagation();
        await _reprocessProjectFile(name);
        return;
      }
      e.stopPropagation();
      if (_selectProjectLibraryEntry(name, e)) return;
      await _openProjectFile(name);
    });
  });

  root.querySelectorAll('.ctx-tree-wrap[data-type]').forEach((row) => {
    const kind = row.dataset.type || '';
    const rel = kind === 'dir'
      ? (row.dataset.projectDir || '')
      : (row.dataset.projectFile || '');
    const node = row.querySelector(':scope > .skill-tree-node');
    if (!rel || !node) return;
    row.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.setData(PROJECT_LIBRARY_INTERNAL_DRAG_TYPE, rel);
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('is-dragging');
      _clearProjectLibraryDropHighlights(root);
    });
    if (kind !== 'dir') return;
    const hover = (e) => {
      const dragKind = _projectLibraryDragKind(e.dataTransfer);
      if (!dragKind) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = dragKind === 'internal' ? 'move' : 'copy';
      if (dragKind === 'external') _clearProjectLibraryDropHighlights(root);
      node.classList.add('is-drag-over');
    };
    node.addEventListener('dragover', hover);
    node.addEventListener('dragenter', hover);
    node.addEventListener('dragleave', (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      node.classList.remove('is-drag-over');
    });
    node.addEventListener('drop', async (e) => {
      if (!_projectLibraryDragKind(e.dataTransfer)) return;
      e.preventDefault();
      e.stopPropagation();
      _clearProjectLibraryDropHighlights(root);
      await _handleProjectLibraryDrop(e.dataTransfer, rel);
    });
  });

  if (!root.dataset.projectDropRootBound) {
    root.dataset.projectDropRootBound = '1';
    root.addEventListener('dragover', (e) => {
      const dragKind = _projectLibraryDragKind(e.dataTransfer);
      if (!dragKind) return;
      const overEntry = e.target.closest('.ctx-tree-wrap');
      if (dragKind === 'internal' && overEntry) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = dragKind === 'internal' ? 'move' : 'copy';
      if (dragKind === 'external') {
        _showProjectLibraryExternalDropTarget(root, _projectLibraryExternalDropTargetDir(e.target));
      } else {
        root.classList.add('is-root-drag-over');
      }
    });
    root.addEventListener('dragleave', (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      _clearProjectLibraryDropHighlights(root);
    });
    root.addEventListener('drop', async (e) => {
      const dragKind = _projectLibraryDragKind(e.dataTransfer);
      if (!dragKind) return;
      const overEntry = e.target.closest('.ctx-tree-wrap');
      if (dragKind === 'internal' && overEntry) return;
      e.preventDefault();
      e.stopPropagation();
      const targetDir = dragKind === 'external'
        ? _projectLibraryExternalDropTargetDir(e.target)
        : '';
      _clearProjectLibraryDropHighlights(root);
      await _handleProjectLibraryDrop(e.dataTransfer, targetDir);
    });
  }
}

async function _resolveProjectFilePath(name) {
  if (!_projectDetailPid || !name) return null;
  try {
    const res = await window.orkas.invoke('projects.files.absPath', {
      projectId: _projectDetailPid,
      name,
    });
    if (!res?.ok || !res.path) throw new Error(res?.error || 'not_found');
    return res.path;
  } catch (err) {
    _projectDetailLog.warn('resolve project file failed', err);
    return null;
  }
}

async function _openProjectFile(name) {
  if (!_projectDetailPid || !name) return;
  const row = _findProjectFileRow(name);
  const kind = row?.dataset?.projectFileKind || '';
  _projectTrackClick('project_file_open', {
    project_id: _projectDetailPid,
    file_kind: kind || 'other',
  });
  _projectLibraryActiveName = name;
  _markProjectLibraryActive();
  try {
    if (kind === 'text') return await _showProjectTextViewer(name);
    if (kind === 'image') return await _showProjectImageViewer(name);
    if (kind === 'pdf') return await _showProjectPdfViewer(name);
    if (kind === 'docx') return await _showProjectDocxViewer(name);
    if (kind === 'spreadsheet' || kind === 'presentation') return await _showProjectOfficeViewer(name);
    return await _showProjectBinaryViewer(name, kind || 'other');
  } catch (err) {
    _projectDetailLog.warn('open project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('contexts.read_failed'));
  }
}

function _projectFileExt(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

function _projectUiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className);
  }
  return '';
}

function _projectChatMediaLocalUrl(absPath) {
  if (typeof _chatMediaLocalUrl === 'function') return _chatMediaLocalUrl(absPath);
  let p = String(absPath || '');
  if (p.includes('\\')) p = p.replace(/\\/g, '/');
  if (p.startsWith('/')) p = p.slice(1);
  return `chat-media://local/${encodeURI(p)}`;
}

function _markProjectLibraryActive() {
  document.querySelectorAll('#project-files-list .project-file-row').forEach((row) => {
    const active = (row.dataset.projectFile || '') === _projectLibraryActiveName;
    row.querySelector(':scope > .skill-tree-node')?.classList.toggle('active', active);
  });
}

function _prepProjectLibraryViewer(name) {
  if (_projectOfficeBlobUrl) {
    try { URL.revokeObjectURL(_projectOfficeBlobUrl); } catch (_) { /* ignore */ }
    _projectOfficeBlobUrl = null;
  }
  if (_projectLibraryMveController) {
    try { _projectLibraryMveController.destroy(); } catch (_) { /* ignore */ }
    _projectLibraryMveController = null;
  }
  const modal = document.getElementById('project-library-viewer-modal');
  const empty = document.getElementById('project-library-editor-empty');
  const wrap = document.getElementById('project-library-viewer-wrap');
  const pathEl = document.getElementById('project-library-editor-path');
  if (!wrap) return null;
  if (modal) {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  }
  if (empty) empty.style.display = 'none';
  wrap.style.display = 'flex';
  if (pathEl) pathEl.textContent = name;
  _markProjectLibraryActive();
  return {
    bodyEl: document.getElementById('project-library-viewer-body'),
    actionsEl: document.getElementById('project-library-viewer-actions'),
  };
}

function _clearProjectLibraryViewer() {
  if (_projectLibraryMveController) {
    try { _projectLibraryMveController.destroy(); } catch (_) { /* ignore */ }
    _projectLibraryMveController = null;
  }
  if (_projectOfficeBlobUrl) {
    try { URL.revokeObjectURL(_projectOfficeBlobUrl); } catch (_) { /* ignore */ }
    _projectOfficeBlobUrl = null;
  }
  _projectLibraryActiveName = '';
  const modal = document.getElementById('project-library-viewer-modal');
  const empty = document.getElementById('project-library-editor-empty');
  const wrap = document.getElementById('project-library-viewer-wrap');
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
  if (empty) empty.style.display = 'flex';
  if (wrap) wrap.style.display = 'none';
  _markProjectLibraryActive();
}

async function _showProjectTextViewer(name) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  const res = await window.orkas.invoke('projects.files.readText', {
    projectId: _projectDetailPid,
    name,
  });
  if (!res?.ok) throw new Error(res?.error || 'read_failed');
  if (typeof mountMdViewEdit !== 'function') {
    els.bodyEl.innerHTML = `<pre class="ctx-viewer-pre">${escapeHtml(res.content || '')}</pre>`;
    els.actionsEl.innerHTML = '';
    return;
  }
  _projectLibraryMveController = mountMdViewEdit({
    bodyEl: els.bodyEl,
    actionsEl: els.actionsEl,
    source: { kind: 'project-file', projectId: _projectDetailPid, name },
    initialContent: res.content || '',
    initialDraft: _projectLibraryDrafts.get(name) || null,
    callbacks: {
      onDraftChange: (draft) => {
        if (draft === null) _projectLibraryDrafts.delete(name);
        else _projectLibraryDrafts.set(name, draft);
      },
      onReveal: () => _revealProjectFile(name),
      onDelete: () => _deleteProjectFileFromViewer(name),
      onSaved: async () => {
        _projectLibraryDrafts.delete(name);
        await loadProjectDetail(_projectDetailPid);
      },
    },
  });
  els.bodyEl.scrollTop = 0;
}

async function _showProjectImageViewer(name) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  const res = await window.orkas.invoke('projects.files.image', {
    projectId: _projectDetailPid,
    name,
  });
  if (!res?.ok) throw new Error(res?.error || 'read_failed');
  const src = `data:${res.mediaType};base64,${res.base64}`;
  const sizeKb = res.bytes ? ` · ${Math.round(res.bytes / 1024)}KB` : '';
  els.bodyEl.innerHTML = `
    <div class="ctx-viewer-image-wrap">
      <img class="ctx-viewer-image" src="${src}" alt="${escapeHtml(name)}"/>
      <div class="ctx-viewer-image-meta">${escapeHtml(name)}${sizeKb}</div>
    </div>
  `;
  _renderProjectLibraryViewerActions(els.actionsEl, name);
  els.bodyEl.scrollTop = 0;
}

async function _showProjectPdfViewer(name) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  const absPath = await _resolveProjectFilePath(name);
  if (!absPath) throw new Error('not_found');
  const src = _projectChatMediaLocalUrl(absPath);
  els.bodyEl.innerHTML = `<iframe class="ctx-viewer-pdf" src="${src}#toolbar=1&navpanes=0" title="${escapeHtml(name)}"></iframe>`;
  _renderProjectLibraryViewerActions(els.actionsEl, name);
}

async function _showProjectDocxViewer(name) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  const res = await window.orkas.invoke('projects.files.docxHtml', {
    projectId: _projectDetailPid,
    name,
  });
  if (!res?.ok) throw new Error(res?.error || 'read_failed');
  els.bodyEl.innerHTML = `<div class="ctx-viewer-docx markdown-body">${res.html || `<p class="muted">${escapeHtml(t('contexts.viewer.docx_empty'))}</p>`}</div>`;
  _renderProjectLibraryViewerActions(els.actionsEl, name);
  els.bodyEl.scrollTop = 0;
}

async function _showProjectOfficeViewer(name) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  els.bodyEl.innerHTML = `<div class="chat-file-viewer-loading">…</div>`;
  const res = await window.orkas.invoke('projects.files.officeHtml', {
    projectId: _projectDetailPid,
    name,
  });
  if (!res?.ok) throw new Error(res?.error || 'read_failed');
  if (_projectOfficeBlobUrl) {
    try { URL.revokeObjectURL(_projectOfficeBlobUrl); } catch (_) { /* ignore */ }
  }
  _projectOfficeBlobUrl = URL.createObjectURL(new Blob([String(res.html || '')], { type: 'text/html;charset=utf-8' }));
  const style = res.previewHeight ? ` style="height:${Math.max(120, Number(res.previewHeight) || 0)}px"` : '';
  els.bodyEl.innerHTML = `<iframe class="ctx-viewer-office" sandbox="" src="${_projectOfficeBlobUrl}"${style} title="${escapeHtml(name)}"></iframe>`;
  _renderProjectLibraryViewerActions(els.actionsEl, name);
  els.bodyEl.scrollTop = 0;
}

async function _showProjectBinaryViewer(name, kind) {
  const els = _prepProjectLibraryViewer(name);
  if (!els || !els.bodyEl || !els.actionsEl) return;
  const kindLabel = t(`contexts.viewer.kind_${kind}`) || kind.toUpperCase();
  const icon = (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function')
    ? window.fileKindIconHtml(name, kind)
    : _projectUiIconHtml('file', 'chat-file-kind-icon');
  els.bodyEl.innerHTML = `
    <div class="ctx-viewer-binary">
      <div class="ctx-viewer-binary-icon">${icon}</div>
      <div class="ctx-viewer-binary-name">${escapeHtml(name)}</div>
      <div class="ctx-viewer-binary-hint">${escapeHtml(t('contexts.viewer.binary_hint', { kind: kindLabel }))}</div>
      <button class="btn btn-primary" id="project-viewer-reveal-big">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    </div>
  `;
  _renderProjectLibraryViewerActions(els.actionsEl, name);
  els.bodyEl.querySelector('#project-viewer-reveal-big')?.addEventListener('click', () => _revealProjectFile(name));
  await _revealProjectFile(name);
}

function _renderProjectLibraryViewerActions(actionsEl, name) {
  if (!actionsEl) return;
  actionsEl.innerHTML = `
    <button class="btn btn-sm" data-action="project-viewer-reveal">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    <button class="btn btn-sm btn-danger" data-action="project-viewer-delete">${escapeHtml(t('contexts.viewer.delete'))}</button>
  `;
  actionsEl.querySelector('[data-action="project-viewer-reveal"]')?.addEventListener('click', () => _revealProjectFile(name));
  actionsEl.querySelector('[data-action="project-viewer-delete"]')?.addEventListener('click', () => _deleteProjectFileFromViewer(name));
}

async function _deleteProjectFileFromViewer(name) {
  await _deleteProjectFile(name);
}

async function _revealProjectFile(name) {
  if (!_projectDetailPid || !name) return;
  const absPath = await _resolveProjectFilePath(name);
  if (!absPath) return;
  try {
    const res = await window.orkas.invoke('workspace.revealPath', {
      path: absPath,
      projectId: _projectDetailPid,
    });
    if (!res?.ok) throw new Error(res?.error || 'reveal_failed');
  } catch (err) {
    _projectDetailLog.warn('reveal project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('project.files.reveal_failed'));
  }
}

async function _reprocessProjectFile(name) {
  if (!_projectDetailPid || !name) return;
  const startedAt = performance.now();
  _projectTrackClick('project_file_reprocess', { project_id: _projectDetailPid });
  try {
    _projectKbStatusByName[name] = {
      ...(_projectKbStatusByName[name] || {}),
      status: 'pending',
    };
    _updateProjectFileKbChip(name);
    _scheduleProjectKbStatusRefreshIfNeeded();
    const res = await window.orkas.invoke('projects.files.reprocess', {
      projectId: _projectDetailPid,
      name,
    });
    if (!res?.ok) throw new Error(res?.error || 'reprocess_failed');
    _projectTrackEvent('project_file_reprocess_result', {
      project_id: _projectDetailPid,
      result: 'success',
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (err) {
    _projectTrackEvent('project_file_reprocess_result', {
      project_id: _projectDetailPid,
      result: 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _projectTrackError('project_file_reprocess', {
      project_id: _projectDetailPid,
      error_type: 'exception',
    });
    _projectDetailLog.warn('reprocess project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('project.files.reprocess_failed'));
  }
}

async function _deleteProjectFile(name) {
  if (!_projectDetailPid || !name) return;
  const row = _findProjectFileRow(name);
  const isDir = !!_findProjectDirRow(name);
  const kind = isDir ? 'dir' : (row?.dataset?.projectFileKind || '');
  if (typeof uiConfirm !== 'function') return;
  const prompt = isDir
    ? t('contexts.dir.del_confirm', { name: _projectBasename(name) })
    : t('contexts.file.del_confirm', { name: _projectBasename(name) });
  if (!(await uiConfirm(prompt))) return;
  const startedAt = performance.now();
  _projectTrackClick('project_file_delete', {
    project_id: _projectDetailPid,
    file_kind: kind || 'other',
  });
  try {
    const res = await window.orkas.invoke('projects.files.delete', {
      projectId: _projectDetailPid,
      name,
    });
    if (!res?.ok) throw new Error(res?.error || 'delete_failed');
    if (_projectLibraryActiveName === name || _projectLibraryActiveName.startsWith(`${name}/`)) {
      for (const key of Array.from(_projectLibraryDrafts.keys())) {
        if (key === name || key.startsWith(`${name}/`)) _projectLibraryDrafts.delete(key);
      }
      _clearProjectLibraryViewer();
    }
    _projectLibraryExpanded.delete(name);
    await loadProjectDetail(_projectDetailPid);
    _projectTrackEvent('project_file_delete_result', {
      project_id: _projectDetailPid,
      result: 'success',
      file_kind: kind || 'other',
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (err) {
    _projectTrackEvent('project_file_delete_result', {
      project_id: _projectDetailPid,
      result: 'failure',
      file_kind: kind || 'other',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _projectTrackError('project_file_delete', {
      project_id: _projectDetailPid,
      error_type: 'exception',
    });
    _projectDetailLog.warn('delete project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('project.files.delete_failed'));
  }
}

function _projectFileMenuItemsFor(name) {
  const row = _findProjectFileRow(name);
  const kind = row?.dataset?.projectFileKind || '';
  const items = [];
  if (kind === 'text') items.push({ action: 'edit', label: t('contexts.menu.edit') });
  items.push({ action: 'rename', label: t('contexts.menu.rename') });
  items.push({ action: 'delete', label: t('contexts.menu.delete'), danger: true });
  items.push({ action: 'ask_commander', label: t('contexts.menu.ask_commander'), dividerBefore: true });
  items.push({ action: 'organize', label: t('contexts.transfer.title') });
  items.push({ action: 'reveal', label: t('project.files.reveal'), dividerBefore: true });
  return items;
}

function _projectLibraryRootMenuItems() {
  return [
    { action: 'new_text', label: t('contexts.menu.new_text') },
    { action: 'new_folder', label: t('contexts.menu.new_folder') },
    { action: 'upload', label: t('contexts.menu.upload') },
  ];
}

function _projectDirMenuItemsFor() {
  return [
    { action: 'new_text', label: t('contexts.menu.new_text') },
    { action: 'new_folder', label: t('contexts.menu.new_folder') },
    { action: 'upload', label: t('contexts.menu.upload') },
    { action: 'organize', label: t('contexts.transfer.title'), dividerBefore: true },
    { action: 'rename', label: t('contexts.menu.rename') },
    { action: 'delete', label: t('contexts.menu.delete'), danger: true, dividerBefore: true },
  ];
}

function _projectLibraryMenuItemsHtml(items) {
  return items.map((it) => `
    ${it.dividerBefore ? '<div class="ctx-row-menu-divider" role="separator"></div>' : ''}
    <div class="ctx-row-menu-item${it.danger ? ' is-danger' : ''}" data-action="${escapeHtml(it.action)}">${escapeHtml(it.label)}</div>
  `).join('');
}

function _openProjectLibraryRootMenu(anchorBtn) {
  let menu = document.getElementById('project-file-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'project-file-row-menu';
    menu.className = 'ctx-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.kind === 'root' && menu.style.display !== 'none';
  if (sameAnchor) { _closeProjectFileMenu(); return; }
  _closeProjectFileMenu();
  menu.innerHTML = _projectLibraryMenuItemsHtml(_projectLibraryRootMenuItems());
  menu.dataset.kind = 'root';
  anchorBtn.closest('.contexts-section-header')?.classList.add('is-menu-open');
  _positionProjectFileMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.ctx-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeProjectFileMenu();
      await _runProjectLibraryRootAction(action);
    });
  }
  setTimeout(() => {
    document.addEventListener('mousedown', _onProjectFileMenuOutside, true);
    document.addEventListener('keydown', _onProjectFileMenuKeyDown, true);
    window.addEventListener('resize', _closeProjectFileMenu, { once: true });
  }, 0);
}

function _openProjectFileMenu(anchorBtn, name) {
  let menu = document.getElementById('project-file-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'project-file-row-menu';
    menu.className = 'ctx-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.fileName === name && menu.style.display !== 'none';
  if (sameAnchor) { _closeProjectFileMenu(); return; }
  _closeProjectFileMenu();

  const items = _projectFileMenuItemsFor(name);
  menu.innerHTML = _projectLibraryMenuItemsHtml(items);
  menu.dataset.fileName = name;
  delete menu.dataset.dirName;

  const srcRow = anchorBtn.closest('.project-file-row');
  for (const r of document.querySelectorAll('.is-menu-open')) r.classList.remove('is-menu-open');
  if (srcRow) srcRow.classList.add('is-menu-open');

  _positionProjectFileMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.ctx-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeProjectFileMenu();
      await _runProjectFileMenuAction(action, name);
    });
  }
  setTimeout(() => {
    document.addEventListener('mousedown', _onProjectFileMenuOutside, true);
    document.addEventListener('keydown', _onProjectFileMenuKeyDown, true);
    window.addEventListener('resize', _closeProjectFileMenu, { once: true });
  }, 0);
}

function _openProjectDirMenu(anchorBtn, name) {
  let menu = document.getElementById('project-file-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'project-file-row-menu';
    menu.className = 'ctx-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  const sameAnchor = menu.dataset.dirName === name && menu.style.display !== 'none';
  if (sameAnchor) { _closeProjectFileMenu(); return; }
  _closeProjectFileMenu();

  const items = _projectDirMenuItemsFor(name);
  menu.innerHTML = _projectLibraryMenuItemsHtml(items);
  menu.dataset.dirName = name;
  delete menu.dataset.fileName;

  const srcRow = anchorBtn.closest('.project-dir-row');
  for (const r of document.querySelectorAll('.is-menu-open')) r.classList.remove('is-menu-open');
  if (srcRow) srcRow.classList.add('is-menu-open');

  _positionProjectFileMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.ctx-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeProjectFileMenu();
      await _runProjectDirMenuAction(action, name);
    });
  }
  setTimeout(() => {
    document.addEventListener('mousedown', _onProjectFileMenuOutside, true);
    document.addEventListener('keydown', _onProjectFileMenuKeyDown, true);
    window.addEventListener('resize', _closeProjectFileMenu, { once: true });
  }, 0);
}

function _positionProjectFileMenu(menuEl, anchorEl) {
  menuEl.style.display = 'block';
  menuEl.style.left = '-9999px';
  menuEl.style.top = '-9999px';
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
  menuEl.style.left = `${left}px`;
  menuEl.style.top = `${top}px`;
}

function _closeProjectFileMenu() {
  const menu = document.getElementById('project-file-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.fileName;
    delete menu.dataset.dirName;
    delete menu.dataset.kind;
  }
  document.querySelectorAll('.project-file-row.is-menu-open, .project-dir-row.is-menu-open')
    .forEach((row) => row.classList.remove('is-menu-open'));
  document.querySelectorAll('#project-library-root-menu-btn')
    .forEach((btn) => btn.closest('.contexts-section-header')?.classList.remove('is-menu-open'));
  document.removeEventListener('mousedown', _onProjectFileMenuOutside, true);
  document.removeEventListener('keydown', _onProjectFileMenuKeyDown, true);
  window.removeEventListener('resize', _closeProjectFileMenu);
}

function _onProjectFileMenuOutside(ev) {
  const menu = document.getElementById('project-file-row-menu');
  if (!menu || menu.style.display === 'none') return;
  if (menu.contains(ev.target)) return;
  if (ev.target && ev.target.closest && ev.target.closest('.project-file-menu-btn, #project-library-root-menu-btn')) return;
  _closeProjectFileMenu();
}

function _onProjectFileMenuKeyDown(ev) {
  if (ev.key === 'Escape') _closeProjectFileMenu();
}

async function _runProjectFileMenuAction(action, name) {
  if (action === 'open') await _openProjectFile(name);
  else if (action === 'edit') await _editProjectFile(name);
  else if (action === 'reveal') await _revealProjectFile(name);
  else if (action === 'rename') await _renameProjectFile(name);
  else if (action === 'delete') await _deleteProjectFile(name);
  else if (action === 'organize') await _openProjectLibraryTransfer(_projectLibrarySelectionFor(name), 'menu');
  else if (action === 'ask_commander') await _askProjectFileCommander(name);
}

// The project composer's per-project draft attachment pool cid.
function _projectChatDraftCid(pid) {
  return 'projchat-' + pid;
}

// Attach a project file to the project composer's draft pool and stay on the
// project page (no new conversation — _submitProjectChat adopts the draft on
// send). Main resolves the path + validates the project + imports the file.
async function _askProjectFileCommander(name) {
  if (!_projectDetailPid || !name) return;
  if (typeof ensureModelConfigured === 'function' && !ensureModelConfigured()) return;
  const pid = _projectDetailPid;
  try {
    await window.attachKbFileToDraft(
      'projects.files.attachToDraft',
      { projectId: pid, name },
      _projectChatDraftCid(pid),
      () => {
        if (typeof setView === 'function') setView('project', pid);
        document.getElementById('project-chat-input')?.focus();
      },
    );
  } catch (_) {
    if (typeof uiAlert === 'function') await uiAlert(t('contexts.ask_commander_failed'));
  }
}

async function _runProjectDirMenuAction(action, name) {
  if (action === 'upload') {
    await _uploadProjectFilesNative(name || '');
    return;
  }
  if (action === 'new_text') await _createProjectTextFile(name);
  else if (action === 'new_folder') await _createProjectDir(name);
  else if (action === 'organize') await _openProjectLibraryTransfer(_projectLibrarySelectionFor(name), 'menu');
  else if (action === 'rename') await _renameProjectFile(name);
  else if (action === 'delete') await _deleteProjectFile(name);
}

async function _runProjectLibraryRootAction(action) {
  if (action === 'upload') {
    await _uploadProjectFilesNative('');
    return;
  }
  if (action === 'new_text') {
    await _createProjectTextFile('');
  }
  if (action === 'new_folder') {
    await _createProjectDir('');
  }
}

async function _openProjectLibraryTransfer(paths, entryPoint) {
  if (!_projectDetailPid || !window.LibraryTransfer?.open || !paths?.length) return;
  const sourceProjectId = _projectDetailPid;
  await window.LibraryTransfer.open({
    source: { scope: 'project', projectId: sourceProjectId },
    paths,
    entryPoint,
    onComplete: async (result) => {
      const successful = (result.results || []).filter((row) => row.ok);
      if (result.mode === 'move') {
        const staysInProject = result.destination?.scope === 'project'
          && result.destination.projectId === sourceProjectId;
        for (const row of successful) {
          if (staysInProject) {
            _applyProjectLibraryPathChange(row.source, row.destination, result.destination.dir || '');
            continue;
          }
          for (const key of Array.from(_projectLibraryDrafts.keys())) {
            if (key === row.source || key.startsWith(`${row.source}/`)) _projectLibraryDrafts.delete(key);
          }
          if (_projectLibraryActiveName === row.source || _projectLibraryActiveName.startsWith(`${row.source}/`)) {
            _clearProjectLibraryViewer();
          }
        }
      }
      _projectLibrarySelected.clear();
      _projectLibrarySelectionAnchor = null;
      await loadProjectDetail(sourceProjectId);
    },
  });
}

async function _createProjectTextFile(parentDir = '') {
  if (!_projectDetailPid) return;
  const stem = t('contexts.new.untitled_stem');
  const fullPath = _projectJoinPath(parentDir, `${stem}.md`);
  const startedAt = performance.now();
  _projectTrackClick('project_file_create_text', {
    project_id: _projectDetailPid,
    has_target_dir: !!parentDir,
  });
  try {
    const res = await window.orkas.invoke('projects.files.createText', {
      projectId: _projectDetailPid,
      name: fullPath,
    });
    if (!res?.ok) throw new Error(res?.error || 'create_failed');
    const name = res.info?.relPath || res.info?.name || fullPath;
    if (parentDir) _projectLibraryExpanded.add(parentDir);
    _projectLibraryActiveName = name;
    await loadProjectDetail(_projectDetailPid);
    await _openProjectFile(name);
    if (_projectLibraryMveController) _projectLibraryMveController.setMode('edit');
    _projectTrackEvent('project_file_create_text_result', {
      project_id: _projectDetailPid,
      result: 'success',
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (err) {
    _projectTrackEvent('project_file_create_text_result', {
      project_id: _projectDetailPid,
      result: 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _projectTrackError('project_file_create_text', {
      project_id: _projectDetailPid,
      error_type: 'exception',
    });
    _projectDetailLog.warn('create project text failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('contexts.file.create_failed'));
  }
}

async function _createProjectDir(parentDir = '') {
  if (!_projectDetailPid || typeof uiPrompt !== 'function') return;
  const nameRaw = (await uiPrompt(t('contexts.menu.new_folder'), '') || '').trim();
  if (!nameRaw) return;
  if (nameRaw.includes('/') || nameRaw.includes('..') || nameRaw.includes('\\')) {
    if (typeof uiAlert === 'function') await uiAlert(t('contexts.new.bad_chars'));
    return;
  }
  const rel = _projectJoinPath(parentDir, nameRaw);
  const startedAt = performance.now();
  _projectTrackClick('project_folder_create', {
    project_id: _projectDetailPid,
    has_target_dir: !!parentDir,
  });
  try {
    const res = await window.orkas.invoke('projects.files.mkdir', {
      projectId: _projectDetailPid,
      path: rel,
    });
    if (!res?.ok) throw new Error(res?.error || 'create_failed');
    if (parentDir) _projectLibraryExpanded.add(parentDir);
    _projectLibraryExpanded.add(res.path || rel);
    await loadProjectDetail(_projectDetailPid);
    _projectTrackEvent('project_folder_create_result', {
      project_id: _projectDetailPid,
      result: 'success',
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (err) {
    _projectTrackEvent('project_folder_create_result', {
      project_id: _projectDetailPid,
      result: 'failure',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _projectTrackError('project_folder_create', {
      project_id: _projectDetailPid,
      error_type: 'exception',
    });
    _projectDetailLog.warn('create project folder failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('contexts.dir.create_failed'));
  }
}

async function _editProjectFile(name) {
  if (!name) return;
  await _openProjectFile(name);
  if (_projectLibraryMveController) _projectLibraryMveController.setMode('edit');
}

function _applyProjectLibraryPathChange(oldName, nextName, targetDir = '') {
  for (const [key, val] of Array.from(_projectLibraryDrafts.entries())) {
    if (key === oldName) {
      _projectLibraryDrafts.set(nextName, val);
      _projectLibraryDrafts.delete(key);
    } else if (key.startsWith(`${oldName}/`)) {
      _projectLibraryDrafts.set(`${nextName}${key.slice(oldName.length)}`, val);
      _projectLibraryDrafts.delete(key);
    }
  }
  for (const expanded of Array.from(_projectLibraryExpanded)) {
    if (expanded === oldName || expanded.startsWith(`${oldName}/`)) {
      _projectLibraryExpanded.delete(expanded);
      _projectLibraryExpanded.add(`${nextName}${expanded.slice(oldName.length)}`);
    }
  }
  if (targetDir) _projectLibraryExpanded.add(targetDir);
  if (_projectLibraryActiveName === oldName || _projectLibraryActiveName.startsWith(`${oldName}/`)) {
    _projectLibraryActiveName = `${nextName}${_projectLibraryActiveName.slice(oldName.length)}`;
    const pathEl = document.getElementById('project-library-editor-path');
    if (pathEl) pathEl.textContent = _projectLibraryActiveName;
    if (_projectLibraryMveController?.setSource) {
      _projectLibraryMveController.setSource({
        kind: 'project-file',
        projectId: _projectDetailPid,
        name: _projectLibraryActiveName,
      });
    }
  }
}

function _flashProjectLibraryMovedEntry(name) {
  const row = _findProjectFileRow(name) || _findProjectDirRow(name);
  const node = row?.querySelector(':scope > .skill-tree-node');
  if (!node) return;
  node.scrollIntoView?.({ block: 'nearest' });
  node.classList.remove('is-move-complete');
  requestAnimationFrame(() => node.classList.add('is-move-complete'));
  setTimeout(() => node.classList.remove('is-move-complete'), 1500);
}

function _projectMoveTargetLabel(targetDir) {
  if (!targetDir) return t('contexts.root_label');
  return _projectBasename(targetDir) || t('contexts.root_label');
}

async function _handleProjectLibraryMove(srcName, targetDir) {
  if (!_projectDetailPid || !srcName) return;
  const base = _projectBasename(srcName);
  const next = _projectJoinPath(targetDir, base);
  if (next === srcName) return;
  if (targetDir === srcName || targetDir.startsWith(`${srcName}/`)) {
    _projectTrackEvent('project_file_move_result', {
      project_id: _projectDetailPid,
      result: 'failure',
      entry_type: 'dir',
      has_target_dir: !!targetDir,
      duration_ms: 0,
      error_code: 'invalid_target',
    });
    if (typeof uiAlert === 'function') await uiAlert(t('contexts.dnd.invalid_self'));
    return;
  }
  const row = _findProjectFileRow(srcName) || _findProjectDirRow(srcName);
  const entryType = row?.dataset?.type || 'file';
  const startedAt = performance.now();
  try {
    const res = await window.orkas.invoke('projects.files.rename', {
      projectId: _projectDetailPid,
      oldName: srcName,
      name: next,
    });
    if (!res?.ok) throw new Error(res?.error || 'move_failed');
    const actual = res.name || next;
    _applyProjectLibraryPathChange(srcName, actual, targetDir);
    await loadProjectDetail(_projectDetailPid);
    _flashProjectLibraryMovedEntry(actual);
    if (typeof uiToast === 'function') {
      uiToast(t('contexts.dnd.moved_to', { target: _projectMoveTargetLabel(targetDir) }), { variant: 'success' });
    }
    _projectTrackEvent('project_file_move_result', {
      project_id: _projectDetailPid,
      result: 'success',
      entry_type: entryType,
      has_target_dir: !!targetDir,
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (err) {
    const rawCode = String(err?.message || 'move_failed');
    const errorCode = ['target_exists', 'forbidden', 'not_found'].includes(rawCode)
      ? rawCode
      : 'move_failed';
    _projectTrackEvent('project_file_move_result', {
      project_id: _projectDetailPid,
      result: 'failure',
      entry_type: entryType,
      has_target_dir: !!targetDir,
      duration_ms: Math.round(performance.now() - startedAt),
      error_code: errorCode,
    });
    _projectTrackError('project_file_move', {
      project_id: _projectDetailPid,
      entry_type: entryType,
      error_type: 'exception',
      error_code: errorCode,
    });
    _projectDetailLog.warn('move project library entry failed', err);
    if (typeof uiAlert === 'function') {
      const message = errorCode === 'target_exists'
        ? t('contexts.dnd.target_exists', { name: base })
        : t('contexts.dnd.move_failed');
      await uiAlert(message);
    }
  }
}

async function _renameProjectFile(name) {
  if (!_projectDetailPid || !name || typeof uiPrompt !== 'function') return;
  const base = _projectBasename(name);
  const parentDir = _projectDirname(name);
  const nextBase = (await uiPrompt(t('project.files.rename_prompt'), base) || '').trim();
  if (!nextBase || nextBase === base) return;
  if (nextBase.includes('/') || nextBase.includes('..') || nextBase.includes('\\')) {
    if (typeof uiAlert === 'function') await uiAlert(t('contexts.entry.rename_bad_name'));
    return;
  }
  const next = _projectJoinPath(parentDir, nextBase);
  const row = _findProjectFileRow(name);
  const kind = row?.dataset?.projectFileKind || '';
  const startedAt = performance.now();
  let failureKey = 'contexts.entry.rename_failed';
  _projectTrackClick('project_file_rename', {
    project_id: _projectDetailPid,
    file_kind: kind || 'other',
  });
  try {
    const res = await window.orkas.invoke('projects.files.rename', {
      projectId: _projectDetailPid,
      oldName: name,
      name: next,
    });
    if (!res?.ok) {
      if (res?.error === 'target_exists') failureKey = 'contexts.entry.rename_target_exists';
      throw new Error('rename_failed');
    }
    const actual = res.name || next;
    _applyProjectLibraryPathChange(name, actual, parentDir);
    await loadProjectDetail(_projectDetailPid);
    _projectTrackEvent('project_file_rename_result', {
      project_id: _projectDetailPid,
      result: 'success',
      file_kind: kind || 'other',
      duration_ms: Math.round(performance.now() - startedAt),
    });
  } catch (err) {
    _projectTrackEvent('project_file_rename_result', {
      project_id: _projectDetailPid,
      result: 'failure',
      file_kind: kind || 'other',
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _projectTrackError('project_file_rename', {
      project_id: _projectDetailPid,
      error_type: 'exception',
    });
    _projectDetailLog.warn('rename project file failed', err);
    if (typeof uiAlert === 'function') uiAlert(t(failureKey));
  }
}

function _updateProjectFileKbChip(name) {
  const row = _findProjectFileRow(name);
  if (!row) return;
  const existing = row.querySelector('.ctx-kb-chip');
  const html = _projectKbStatusChipHtml(name);
  if (existing) {
    if (html) existing.outerHTML = html;
    else existing.remove();
  } else if (html) {
    const menuBtn = row.querySelector('.project-file-menu-btn');
    if (menuBtn) menuBtn.insertAdjacentHTML('beforebegin', html);
  }
  row.querySelector('[data-action="project-file-reprocess"]')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    await _reprocessProjectFile(name);
  });
}

function _applyProjectKbEvent(ev) {
  if (!ev || ev.projectId !== _projectDetailPid) return;
  const name = ev.name || ev.relPath;
  if (!name) return;
  if (ev.status === 'deleted') {
    delete _projectKbStatusByName[name];
  } else {
    _projectKbStatusByName[name] = {
      status: ev.status,
      ...(ev.chunks != null ? { chunks: ev.chunks } : {}),
      ...(ev.error ? { error: ev.error } : {}),
      ...(ev.kind ? { kind: ev.kind } : {}),
    };
  }
  _updateProjectFileKbChip(name);
  _scheduleProjectKbStatusRefreshIfNeeded();
}

function _ensureProjectKbEventSubscription(pid) {
  if (!pid || !window.orkas || typeof window.orkas.stream !== 'function') return;
  if (_projectKbEventsHandle && _projectKbEventsPid === pid) return;
  _stopProjectKbEventSubscription();
  _projectKbEventsPid = pid;
  try {
    _projectKbEventsHandle = window.orkas.stream('project.kb.events', { projectId: pid }, (msg) => {
      if (msg?.type === 'event' && msg.event) _applyProjectKbEvent(msg.event);
    });
    _projectKbEventsHandle.promise.catch(() => {
      /* stream closes on navigation/cancel */
    }).finally(() => {
      if (_projectKbEventsPid === pid) {
        _projectKbEventsHandle = null;
        _projectKbEventsPid = '';
      }
    });
  } catch (err) {
    _projectDetailLog.warn('subscribe project kb events failed', err);
    _projectKbEventsHandle = null;
    _projectKbEventsPid = '';
  }
}

function _stopProjectKbEventSubscription() {
  try { _projectKbEventsHandle?.cancel?.(); } catch { /* ignore */ }
  _projectKbEventsHandle = null;
  _projectKbEventsPid = '';
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
  if (!status) return;
  const body = text || '';
  status.textContent = body;
  status.style.display = body ? '' : 'none';
}

function _projectUploadFailureMessage(rows) {
  const names = rows
    .map((row) => String((row && (row.name || row.targetName)) || '').trim())
    .filter(Boolean);
  return names.length
    ? t('contexts.upload_failed', { list: names.join('\n') })
    : t('contexts.upload_failed_generic');
}

function _projectUploadHasHiddenPath(file) {
  const name = String(file?.webkitRelativePath || file?.name || '');
  return name.split('/').some((part) => part.startsWith('.'));
}

function _projectUploadIsSupported(file) {
  return PROJECT_LIBRARY_ALLOWED_EXTS.includes(_projectFileExt(file?.name || ''));
}

async function _runProjectUploadPool(items, worker, concurrency = 3) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  }));
}

async function _uploadProjectFiles(fileList, targetDir = '', source = 'drop') {
  if (!_projectDetailPid || !fileList || !fileList.length) return;
  const uploadProjectId = _projectDetailPid;
  const files = Array.from(fileList).filter(Boolean);
  if (!files.length) return;
  if (targetDir) _projectLibraryExpanded.add(targetDir);
  const payload = _projectFileUploadPayload(files, source, targetDir);
  const startedAt = performance.now();
  _projectTrackClick('project_file_upload', { project_id: uploadProjectId, ...payload });
  _setProjectFilesStatus(t('project.files.uploading'));
  const hiddenRejected = files
    .filter((file) => _projectUploadHasHiddenPath(file))
    .map((file) => ({ name: file.name || '' }));
  const extRejected = files
    .filter((file) => !_projectUploadHasHiddenPath(file) && !_projectUploadIsSupported(file))
    .map((file) => ({ name: file.name || '' }));
  const uploadable = files.filter((file) => !_projectUploadHasHiddenPath(file) && _projectUploadIsSupported(file));
  const failed = [];
  try {
    await _runProjectUploadPool(uploadable, async (file) => {
      try {
        const buf = await file.arrayBuffer();
        const targetName = _projectJoinPath(targetDir, file.name || 'file');
        const res = await window.orkas.invoke('projects.files.upload', {
          projectId: uploadProjectId,
          name: targetName,
          data: _arrayBufferToBase64(buf),
        });
        if (!res?.ok) failed.push({ name: file.name || '' });
      } catch (_) {
        failed.push({ name: file.name || '' });
      }
    });
  } finally {
    _setProjectFilesStatus('');
  }
  const rejectedCount = hiddenRejected.length + extRejected.length;
  const unsuccessfulCount = rejectedCount + failed.length;
  _projectTrackEvent('project_file_upload_result', {
    project_id: uploadProjectId,
    ...payload,
    result: unsuccessfulCount ? (unsuccessfulCount < files.length ? 'partial_failure' : 'failure') : 'success',
    uploaded_count: Math.max(0, uploadable.length - failed.length),
    failed_count: unsuccessfulCount,
    rejected_count: rejectedCount,
    duration_ms: Math.round(performance.now() - startedAt),
  });
  if (unsuccessfulCount) {
    _projectTrackError('project_file_upload', {
      project_id: uploadProjectId,
      source,
      failed_count: unsuccessfulCount,
    });
  }
  if (extRejected.length && typeof uiAlert === 'function') {
    await uiAlert(t('contexts.upload_rejected', {
      list: extRejected.map((row) => row.name).join('\n'),
    }));
  }
  if (hiddenRejected.length && typeof uiAlert === 'function') {
    await uiAlert(t('contexts.upload_hidden_rejected', {
      list: hiddenRejected.map((row) => row.name).join('\n'),
    }));
  }
  if (failed.length && typeof uiAlert === 'function') {
    await uiAlert(_projectUploadFailureMessage(failed));
  }
  if (uploadable.length && _projectDetailPid === uploadProjectId) {
    try {
      await loadProjectDetail(uploadProjectId);
    } catch (err) {
      _projectDetailLog.warn('refresh project detail after upload failed', err);
    }
  }
}

async function _uploadProjectFilesNative(targetDir = '') {
  if (!_projectDetailPid) return;
  const uploadProjectId = _projectDetailPid;
  if (targetDir) _projectLibraryExpanded.add(targetDir);
  const payload = { source: 'picker', has_target_dir: !!targetDir };
  const startedAt = performance.now();
  _projectTrackClick('project_file_upload', { project_id: uploadProjectId, ...payload });
  _setProjectFilesStatus(t('project.files.uploading'));
  let data;
  try {
    data = await window.orkas.invoke('projects.files.pickAndUpload', {
      projectId: uploadProjectId,
      targetDir,
    });
  } catch (_) {
    _setProjectFilesStatus('');
    _projectTrackEvent('project_file_upload_result', {
      project_id: uploadProjectId,
      ...payload,
      result: 'failure',
      uploaded_count: 0,
      failed_count: 1,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _projectTrackError('project_file_upload', {
      project_id: uploadProjectId,
      error_type: 'exception',
    });
    if (typeof uiAlert === 'function') {
      await uiAlert(t('contexts.upload_picker_failed'));
    }
    return;
  }
  _setProjectFilesStatus('');
  const rows = Array.isArray(data && data.files) ? data.files : [];
  const failed = rows.filter((r) => !r || r.ok === false);
  _projectTrackEvent('project_file_upload_result', {
    project_id: uploadProjectId,
    ...payload,
    result: failed.length ? (failed.length < rows.length ? 'partial_failure' : 'failure') : 'success',
    uploaded_count: Math.max(0, rows.length - failed.length),
    failed_count: failed.length,
    file_count: rows.length,
    duration_ms: Math.round(performance.now() - startedAt),
  });
  if (failed.length && typeof uiAlert === 'function') {
    await uiAlert(_projectUploadFailureMessage(failed));
  }
  if (_projectDetailPid === uploadProjectId) {
    try {
      await loadProjectDetail(uploadProjectId);
    } catch (err) {
      _projectDetailLog.warn('refresh project detail after native upload failed', err);
    }
  }
}

async function _submitProjectChat() {
  if (!_projectDetailPid) return;
  const input = document.getElementById('project-chat-input');
  const btn = document.getElementById('project-chat-send-btn');
  const raw = (input?.value || '').trim();
  const draftCid = _projectChatDraftCid(_projectDetailPid);
  const quotes = (typeof _getQuotes === 'function') ? _getQuotes(draftCid).slice() : [];
  if (!raw && !quotes.length) return;
  if (typeof ensureModelConfigured === 'function' && !ensureModelConfigured()) return;
  const references = (typeof _referenceSnapshotsForQuotes === 'function')
    ? _referenceSnapshotsForQuotes(quotes)
    : [];
  const requestText = raw || t('chat.reference_default_prompt');
  const useSelections = (typeof consumeChatUseSelections === 'function')
    ? consumeChatUseSelections('project')
    : [];
  const recipient = (typeof getChatRecipient === 'function')
    ? getChatRecipient('project')
    : null;
  const withUse = (typeof transformWithChatUse === 'function')
    ? transformWithChatUse(requestText)
    : requestText;
  const content = (typeof applyRecipientPrefix === 'function')
    ? applyRecipientPrefix(withUse, 'project')
    : withUse;
  const recipientType = recipient && recipient.kind ? recipient.kind : 'commander';
  const sendPayload = {
    project_id: _projectDetailPid,
    source_view: 'project',
    content_length: raw.length,
    recipient_type: recipientType,
    has_skill: useSelections.some((sel) => sel.kind === 'skill'),
    has_connector: useSelections.some((sel) => sel.kind === 'connector'),
    attachment_count: 0,
    has_project: true,
  };
  _projectTrackClick('project_chat_send', sendPayload);
  _projectTrackClick('chat_send', sendPayload);
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
    const titleSeed = (typeof transformChatUseTokens === 'function') ? transformChatUseTokens(requestText) : requestText;
    conv.title = (typeof _autoTitle === 'function') ? _autoTitle(titleSeed) : titleSeed.slice(0, 32);
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

  // Adopt the project composer's draft attachments (e.g. a KB file added via
  // "ask the commander about this file") into the new conversation — mirrors the
  // new-chat draft adopt. No-op when there are none, so normal sends are
  // unaffected.
  const _draftNames = (typeof _chatAttachList === 'function' ? _chatAttachList(draftCid) : [])
    .map((it) => it && it.name).filter(Boolean);
  let _adopted = [];
  if (_draftNames.length) {
    try {
      const aRes = await apiFetch('/api/conversations/attachments/adopt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_cid: draftCid, to_cid: convId }),
      });
      const aData = await aRes.json();
      if (aData.ok) _adopted = _draftNames;
    } catch (_) { /* best-effort: fall through, file simply not attached */ }
    if (typeof _chatAttachClear === 'function') {
      if (_adopted.length) _chatAttachClear(draftCid);
      else await _chatAttachClear(draftCid, { deleteFiles: true });
    }
  }
  if (typeof _clearQuotes === 'function') _clearQuotes(draftCid);

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
  if (btn) btn.disabled = false;
  if (typeof sendInCurrentConversation === 'function') {
    const extra = {
      ...(_adopted.length ? { attachments: _adopted } : {}),
      ...(useSelections.length ? { use_selections: useSelections } : {}),
      ...(references.length ? { references } : {}),
    };
    await sendInCurrentConversation(content, Object.keys(extra).length ? extra : undefined);
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
      const startedAt = performance.now();
      _projectTrackClick('project_binding_remove', {
        project_id: _projectDetailPid,
        binding_kind: kind,
        binding_id: id,
      });
      try {
        await window.orkas.invoke('projects.bindings.remove', {
          projectId: _projectDetailPid, kind, id,
        });
        await loadProjectDetail(_projectDetailPid);
        _projectTrackEvent('project_binding_remove_result', {
          project_id: _projectDetailPid,
          binding_kind: kind,
          result: 'success',
          duration_ms: Math.round(performance.now() - startedAt),
        });
      } catch (err) {
        _projectTrackEvent('project_binding_remove_result', {
          project_id: _projectDetailPid,
          binding_kind: kind,
          result: 'failure',
          duration_ms: Math.round(performance.now() - startedAt),
        });
        _projectTrackError('project_binding_remove', {
          project_id: _projectDetailPid,
          binding_kind: kind,
          error_type: 'exception',
        });
        _projectDetailLog.warn('remove binding failed', err);
      }
    });
  });
}

// ── Add picker (centered modal with search) ───────────────────────────

async function _openAddPicker(kind) {
  // Dispose any previously-open picker so re-clicks don't stack.
  document.getElementById('project-binding-picker-overlay')?.remove();
  _projectTrackClick('project_binding_picker_open', {
    project_id: _projectDetailPid,
    binding_kind: kind,
  });

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
        <button type="button" class="modal-close-btn project-binding-picker-close" data-action="close" title="${closeText}" aria-label="${closeText}">${_projectUiIconHtml('x', 'modal-close-icon') || '×'}</button>
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
        const startedAt = performance.now();
        _projectTrackClick('project_binding_add', {
          project_id: _projectDetailPid,
          binding_kind: k,
          binding_id: id,
        });
        try {
          const res = await window.orkas.invoke('projects.bindings.add', {
            projectId: _projectDetailPid, kind: k, id,
          });
          if (!res?.ok) throw new Error(res?.error || 'add_failed');
          _projectTrackEvent('project_binding_add_result', {
            project_id: _projectDetailPid,
            binding_kind: k,
            result: 'success',
            duration_ms: Math.round(performance.now() - startedAt),
          });
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
          _projectTrackEvent('project_binding_add_result', {
            project_id: _projectDetailPid,
            binding_kind: k,
            result: 'failure',
            duration_ms: Math.round(performance.now() - startedAt),
          });
          _projectTrackError('project_binding_add', {
            project_id: _projectDetailPid,
            binding_kind: k,
            error_type: 'exception',
          });
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
  _setProjectDetailRenameMode(true);
  inputEl.focus();
  inputEl.select();
}

async function _commitRename(newName) {
  if (!_projectDetailPid || !_projectDetailMeta) return;
  const old = _projectDetailMeta.project?.name || '';
  let trimmed = String(newName || '').trim();
  if (typeof window.limitNameDisplayText === 'function') trimmed = window.limitNameDisplayText(trimmed);
  // No change OR empty → revert silently.
  if (!trimmed || trimmed === old) {
    _exitRenameMode();
    return;
  }
  let code = '';
  const startedAt = performance.now();
  _projectTrackClick('project_rename_submit', {
    project_id: _projectDetailPid,
    name_length: trimmed.length,
    source: 'detail',
  });
  try {
    const res = await window.orkas.invoke('projects.rename', {
      projectId: _projectDetailPid, name: trimmed,
    });
    if (!res || !res.ok) {
      code = (res && res.error) || 'generic';
    } else {
      _projectTrackEvent('project_rename_result', {
        project_id: _projectDetailPid,
        result: 'success',
        source: 'detail',
        duration_ms: Math.round(performance.now() - startedAt),
      });
      _projectDetailMeta.project = res.project;
      if (typeof loadProjects === 'function') loadProjects(true);
      _exitRenameMode();
      _renderProjectDetail();
      return;
    }
  } catch (err) {
    code = (err && err.message) || 'generic';
  }
  _projectTrackEvent('project_rename_result', {
    project_id: _projectDetailPid,
    result: 'failure',
    source: 'detail',
    duration_ms: Math.round(performance.now() - startedAt),
  });
  _projectTrackError('project_rename', {
    project_id: _projectDetailPid,
    source: 'detail',
    error_type: code || 'exception',
  });
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
  _setProjectDetailRenameMode(false);
}

function _setProjectDetailRenameMode(on) {
  const titleEl = document.getElementById('project-detail-title');
  const inputEl = document.getElementById('project-detail-title-input');
  const renameBtn = document.getElementById('project-action-rename');
  const deleteBtn = document.getElementById('project-action-delete');
  if (titleEl) titleEl.style.display = on ? 'none' : '';
  if (inputEl) inputEl.style.display = on ? '' : 'none';
  if (renameBtn) {
    renameBtn.textContent = on ? t('project.action.done') : t('project.action.rename');
    renameBtn.setAttribute('data-rename-mode', on ? '1' : '0');
  }
  if (deleteBtn) deleteBtn.style.display = on ? 'none' : '';
}

function _isProjectDetailRenameMode() {
  const inputEl = document.getElementById('project-detail-title-input');
  return !!inputEl && inputEl.style.display !== 'none';
}

async function _onDeleteAction() {
  if (!_projectDetailPid || !_projectDetailMeta) return;
  // Reuse the sidebar's delete confirm flow so the danger label / count
  // wording stays in one place. `_confirmDeleteProject` is defined in
  // `projects.js` and runs the IPC + post-delete cleanup, including choosing
  // the next project/task destination when this detail page is deleted.
  if (typeof _confirmDeleteProject === 'function') {
    await _confirmDeleteProject(_projectDetailPid);
  }
}

// Kept as a no-op compatibility hook because conversation.js calls it after
// loading history. Empty project-agent guidance now lives only on the project
// detail page's Agents module.
async function refreshConvProjectEmptyBanner(_cid) {
  return undefined;
}

// ── Boot wiring ────────────────────────────────────────────────────────

function _initProjectDetailBindings() {
  document.getElementById('project-add-agent-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openAddPicker('agent');
  });
  document.getElementById('project-action-rename')?.addEventListener('mousedown', (e) => {
    if (_isProjectDetailRenameMode()) e.preventDefault();
  });
  document.getElementById('project-action-rename')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const inputEl = document.getElementById('project-detail-title-input');
    if (_isProjectDetailRenameMode() && inputEl) _commitRename(inputEl.value);
    else _onRenameAction();
  });
  document.getElementById('project-action-delete')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _onDeleteAction();
  });
  document.getElementById('project-library-root-menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openProjectLibraryRootMenu(e.currentTarget);
  });
  const projectLibraryViewerModal = document.getElementById('project-library-viewer-modal');
  _bindProjectLibraryDetailDrop(projectLibraryViewerModal?.querySelector('.project-library-viewer-dialog'));
  projectLibraryViewerModal?.querySelector('[data-action="project-library-viewer-close"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _clearProjectLibraryViewer();
  });
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229 || e.key !== 'Escape') return;
    if (projectLibraryViewerModal?.classList.contains('open')) {
      _clearProjectLibraryViewer();
      e.preventDefault();
    }
  });
  document.getElementById('project-chat-attach-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _uploadProjectFilesNative('');
  });
  const projectInput = document.getElementById('project-chat-input');
  if (projectInput) {
    projectInput.addEventListener('input', () => {
      if (typeof autoGrow === 'function') autoGrow(projectInput, 180);
    });
    projectInput.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (_handleModifiedComposerEnter(e)) return;
      if (_isPlainComposerEnter(e)) {
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
    if (typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(inputEl);
    inputEl.addEventListener('keydown', (e) => {
      // IME guard (CLAUDE.md §8) — Enter while composing must commit
      // the candidate, not the rename.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); _commitRename(inputEl.value); }
      else if (e.key === 'Escape') { e.preventDefault(); _exitRenameMode(); }
    });
    inputEl.addEventListener('blur', () => _commitRename(inputEl.value));
  }
  window.addEventListener('i18n-change', () => {
    if (currentView === 'project' && _projectDetailMeta) _renderProjectDetail();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _initProjectDetailBindings, { once: true });
} else {
  _initProjectDetailBindings();
}
