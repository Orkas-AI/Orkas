// ── Project goal tab ─────────────────────────────────────────────────────
// The first tab of the project's Context card (Goal · Rules · Memory): the
// optional goal, its status and success criteria, and its editor (plan
// Common/docs/plans/commander-project-continuity.md §3.6).

const _projectGoalLog = createLogger('project-goal');

let _projectGoalState = { pid: '', account: '', loaded: false, shared: false, goal: null };
let _projectGoalEnabled;
let _projectGoalLoadSeq = 0;
// Until the user picks a Context tab in this run, opening a project selects
// Goal when it has a goal, otherwise Rules as before.
let _projectGoalTabChosen = false;
let _projectGoalFeedbackTimer = 0;
let _projectGoalEditorRelease = null;
let _projectGoalEditorEpoch = 0;
let _projectGoalEditorOwner = null;
let _projectGoalSaving = false;

const _PROJECT_GOAL_MAX = 400;
const _PROJECT_GOAL_CRITERIA_MAX = 5;
const _PROJECT_GOAL_CRITERION_MAX = 200;

function _projectGoalAccount() {
  return typeof currentUserId === 'string' ? currentUserId : '';
}

function _projectGoalCurrent(pid) {
  return _projectGoalEnabled === true && pid === _projectDetailPid && _projectGoalState.pid === pid
    && _projectGoalState.account === _projectGoalAccount();
}

/** Read the open project's goal. `chooseTab` is set by a navigation load,
 *  never by a background refresh. */
async function loadProjectGoal(pid, { chooseTab = false } = {}) {
  if (_projectGoalEnabled === false || !pid || !window.orkas) return;
  const account = _projectGoalAccount();
  const seq = ++_projectGoalLoadSeq;
  // Another project's goal must never show while this one loads.
  if (_projectGoalState.pid !== pid || _projectGoalState.account !== account) {
    _projectGoalState = { pid, account, loaded: false, shared: false, goal: null };
    renderProjectGoal();
  }
  const goalRes = await window.orkas.invoke('projects.goal.get', { projectId: pid })
    .catch((err) => ({ ok: false, error: err?.message || String(err) }));
  if (seq !== _projectGoalLoadSeq || pid !== _projectDetailPid || account !== _projectGoalAccount()) return;
  if (goalRes?.ok) _projectGoalEnabled = goalRes.enabled !== false;
  else _projectGoalLog.warn('project goal load failed');
  const loaded = !!goalRes?.ok && _projectGoalEnabled;
  _projectGoalState = {
    pid,
    account,
    loaded,
    shared: !!goalRes?.shared,
    goal: loaded ? (goalRes.goal || null) : null,
  };
  if (chooseTab && !_projectGoalTabChosen) {
    _projectSideActiveTabs.context = !_projectGoalState.shared && _projectGoalState.goal ? 'goal' : 'instructions';
  }
  renderProjectGoal();
  if (typeof _syncProjectSideTabState === 'function') _syncProjectSideTabState('context');
}

/** The project page calls this when the user picks a Context tab themselves. */
function projectGoalNoteTabChoice() {
  _projectGoalTabChosen = true;
}

function renderProjectGoal() {
  const tab = document.getElementById('project-goal-tab');
  const head = document.getElementById('project-goal-head');
  const status = document.getElementById('project-goal-status');
  const body = document.getElementById('project-goal-body');
  const text = document.getElementById('project-goal-text');
  const criteria = document.getElementById('project-goal-criteria');
  const empty = document.getElementById('project-goal-empty');
  const setup = document.getElementById('project-goal-setup-btn');
  const edit = document.getElementById('project-goal-edit-btn');
  const menu = document.getElementById('project-goal-menu-btn');
  if (!tab) return;
  const state = _projectGoalState;
  const current = _projectGoalCurrent(_projectDetailPid);
  tab.hidden = !current || state.shared;
  if (tab.hidden && _projectSideActiveTabs.context === 'goal') _projectSideActiveTabs.context = 'instructions';
  const goal = current ? state.goal : null;
  if (head) head.hidden = !goal;
  if (status) {
    const achieved = goal?.status === 'achieved';
    status.className = `project-goal-status ${achieved ? 'is-achieved' : 'is-active'}`;
    status.textContent = goal ? t(achieved ? 'project.goal.status_achieved' : 'project.goal.status_active') : '';
  }
  if (body) body.hidden = !goal;
  if (text) text.textContent = goal ? goal.goal : '';
  if (criteria) {
    const items = goal && Array.isArray(goal.success_criteria) ? goal.success_criteria : [];
    criteria.innerHTML = items.map((item) => `<li>${escapeHtml(item)}</li>`).join('');
    criteria.hidden = !items.length;
  }
  if (empty) empty.hidden = !!goal || !current || !state.loaded;
  // An unread goal must not be replaced blind: editing waits for a good read.
  const locked = !current || !state.loaded || _projectGoalSaving;
  if (setup) setup.disabled = locked;
  if (edit) edit.disabled = locked;
  if (menu) menu.disabled = locked;
}

function _setProjectGoalFeedback(message) {
  const el = document.getElementById('project-goal-feedback');
  if (!el) return;
  el.textContent = message || '';
  clearTimeout(_projectGoalFeedbackTimer);
  if (message) _projectGoalFeedbackTimer = setTimeout(() => { el.textContent = ''; }, 2400);
}

/** Save through the goal store; reports success to the caller. */
async function _saveProjectGoal(patch, successMessage, owner = { pid: _projectDetailPid, account: _projectGoalAccount() }) {
  const pid = _projectDetailPid;
  if (!_projectGoalEnabled || !pid || _projectGoalSaving) return false;
  const account = _projectGoalAccount();
  if (!owner || owner.pid !== pid || owner.account !== account || currentView !== 'project') {
    if (typeof uiAlert === 'function') uiAlert(t('project.goal.save_failed'));
    return false;
  }
  _projectGoalSaving = true;
  renderProjectGoal();
  try {
    const res = await window.orkas.invoke('projects.goal.set', { projectId: pid, ...patch });
    if (!res?.ok || res.enabled === false) throw new Error(res?.error || 'goal_save_failed');
    if (pid === _projectDetailPid && account === _projectGoalAccount() && _projectGoalState.pid === pid) {
      _projectGoalState.goal = res.goal || null;
      if (successMessage) _setProjectGoalFeedback(successMessage);
    }
    return true;
  } catch (err) {
    _projectGoalLog.warn('project goal save failed', err);
    if (pid === _projectDetailPid && typeof uiAlert === 'function') uiAlert(t('project.goal.save_failed'));
    return false;
  } finally {
    _projectGoalSaving = false;
    renderProjectGoal();
  }
}

function _openProjectGoalMenu(button) {
  const goal = _projectGoalState.goal;
  if (!goal || !_projectGoalCurrent(_projectDetailPid) || typeof showContextMenu !== 'function' || !button) return;
  const owner = { pid: _projectGoalState.pid, account: _projectGoalState.account };
  const items = [
    goal.status === 'achieved'
      ? { label: t('project.goal.mark_active'), onClick: () => _saveProjectGoal({ status: 'active' }, t('project.goal.saved'), owner) }
      : { label: t('project.goal.mark_achieved'), onClick: () => _saveProjectGoal({ status: 'achieved' }, t('project.goal.saved'), owner) },
    {
      label: t('project.goal.clear'),
      danger: true,
      onClick: async () => {
        const pid = _projectDetailPid;
        if (typeof uiConfirm === 'function' && !(await uiConfirm(t('project.goal.clear_confirm')))) return;
        if (pid !== _projectDetailPid) return;
        await _saveProjectGoal({ goal: '' }, t('project.goal.cleared'), owner);
      },
    },
  ];
  const rect = button.getBoundingClientRect();
  showContextMenu({ clientX: rect.right, clientY: rect.bottom + 4 }, items);
}

// ── Editor (P18) ────────────────────────────────────────────────────────

function _projectGoalCriterionRowHtml(value) {
  const removeIcon = typeof uiIconHtml === 'function' ? uiIconHtml('x', 'project-goal-criterion-remove-icon') : '×';
  return '<div class="project-goal-criterion">'
    + `<input type="text" class="project-goal-criterion-input" maxlength="${_PROJECT_GOAL_CRITERION_MAX}"`
    + ` placeholder="${escapeHtml(t('project.goal.criteria_placeholder'))}" value="${escapeHtml(value || '')}" />`
    + `<button type="button" class="project-side-icon-btn project-goal-criterion-remove"`
    + ` title="${escapeHtml(t('project.goal.criteria_remove'))}" aria-label="${escapeHtml(t('project.goal.criteria_remove'))}">${removeIcon}</button>`
    + '</div>';
}

function _projectGoalEditorValues() {
  const input = document.getElementById('project-goal-input');
  const rows = Array.from(document.querySelectorAll('#project-goal-criteria-editor .project-goal-criterion-input'));
  return {
    goal: String(input?.value || '').trim(),
    // A row left blank is not a criterion.
    success_criteria: rows.map((row) => String(row.value || '').trim()).filter(Boolean),
  };
}

function _projectGoalEditorDirty() {
  const saved = _projectGoalState.goal;
  const values = _projectGoalEditorValues();
  return values.goal !== (saved ? saved.goal : '')
    || JSON.stringify(values.success_criteria) !== JSON.stringify(saved ? saved.success_criteria || [] : []);
}

function _updateProjectGoalEditor() {
  const input = document.getElementById('project-goal-input');
  const counter = document.getElementById('project-goal-counter');
  const save = document.getElementById('project-goal-save-btn');
  const add = document.getElementById('project-goal-criteria-add');
  const rows = document.querySelectorAll('#project-goal-criteria-editor .project-goal-criterion').length;
  const length = String(input?.value || '').trim().length;
  const over = length > _PROJECT_GOAL_MAX;
  if (counter) {
    counter.textContent = `${length}/${_PROJECT_GOAL_MAX}`;
    counter.classList.toggle('is-over', over);
  }
  if (add) add.disabled = rows >= _PROJECT_GOAL_CRITERIA_MAX;
  if (save) save.disabled = _projectGoalSaving || over || !_projectGoalEditorDirty();
}

function openProjectGoalEditor() {
  const overlay = document.getElementById('project-goal-modal');
  const input = document.getElementById('project-goal-input');
  const editor = document.getElementById('project-goal-criteria-editor');
  if (!overlay || !input || !editor || !_projectGoalCurrent(_projectDetailPid) || !_projectGoalState.loaded || _projectGoalState.shared) return;
  _projectGoalEditorOwner = { pid: _projectGoalState.pid, account: _projectGoalState.account };
  _projectGoalEditorEpoch++;
  const goal = _projectGoalState.goal;
  input.value = goal ? goal.goal : '';
  editor.innerHTML = (goal && Array.isArray(goal.success_criteria) ? goal.success_criteria : [])
    .map((item) => _projectGoalCriterionRowHtml(item)).join('');
  if (typeof hydrateUiIcons === 'function') hydrateUiIcons(overlay);
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  if (typeof _uiKeepDialogFocus === 'function') _projectGoalEditorRelease = _uiKeepDialogFocus(overlay, input);
  _updateProjectGoalEditor();
  setTimeout(() => {
    input.focus();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, 0);
}

async function closeProjectGoalEditor({ force = false } = {}) {
  const overlay = document.getElementById('project-goal-modal');
  if (!overlay || !overlay.classList.contains('open')) return;
  if (!force && _projectGoalEditorDirty() && typeof uiConfirm === 'function') {
    const epoch = _projectGoalEditorEpoch;
    const ok = await uiConfirm(t('project.goal.discard_confirm'));
    if (!ok || epoch !== _projectGoalEditorEpoch || !overlay.classList.contains('open')) return;
  }
  _projectGoalEditorEpoch++;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  const release = _projectGoalEditorRelease;
  _projectGoalEditorRelease = null;
  if (typeof release === 'function') release();
  const returnTo = _projectGoalState.goal
    ? document.getElementById('project-goal-edit-btn')
    : document.getElementById('project-goal-setup-btn');
  returnTo?.focus();
}

async function _submitProjectGoalEditor() {
  const save = document.getElementById('project-goal-save-btn');
  if (!save || save.disabled) return;
  const epoch = _projectGoalEditorEpoch;
  const values = _projectGoalEditorValues();
  // Saving an empty goal clears it, criteria included.
  const patch = values.goal ? values : { goal: '' };
  const hadGoal = !!_projectGoalState.goal;
  const saved = await _saveProjectGoal(patch, values.goal ? t('project.goal.saved') : (hadGoal ? t('project.goal.cleared') : ''), _projectGoalEditorOwner);
  if (saved && epoch === _projectGoalEditorEpoch) await closeProjectGoalEditor({ force: true });
  else _updateProjectGoalEditor();
}

function _bindProjectGoal() {
  const overlay = document.getElementById('project-goal-modal');
  if (!overlay || overlay.dataset.bound === '1') return;
  overlay.dataset.bound = '1';
  document.getElementById('project-goal-setup-btn')?.addEventListener('click', openProjectGoalEditor);
  document.getElementById('project-goal-edit-btn')?.addEventListener('click', openProjectGoalEditor);
  document.getElementById('project-goal-menu-btn')?.addEventListener('click', (event) => {
    event.stopPropagation();
    _openProjectGoalMenu(event.currentTarget);
  });
  document.getElementById('project-goal-cancel-btn')?.addEventListener('click', () => { void closeProjectGoalEditor(); });
  document.getElementById('project-goal-save-btn')?.addEventListener('click', () => { void _submitProjectGoalEditor(); });
  document.getElementById('project-goal-input')?.addEventListener('input', _updateProjectGoalEditor);
  document.getElementById('project-goal-input')?.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void _submitProjectGoalEditor();
    }
  });
  const editor = document.getElementById('project-goal-criteria-editor');
  editor?.addEventListener('input', _updateProjectGoalEditor);
  editor?.addEventListener('click', (event) => {
    const remove = event.target.closest?.('.project-goal-criterion-remove');
    if (!remove) return;
    remove.closest('.project-goal-criterion')?.remove();
    _updateProjectGoalEditor();
    document.getElementById('project-goal-criteria-add')?.focus();
  });
  document.getElementById('project-goal-criteria-add')?.addEventListener('click', () => {
    if (!editor || editor.querySelectorAll('.project-goal-criterion').length >= _PROJECT_GOAL_CRITERIA_MAX) return;
    editor.insertAdjacentHTML('beforeend', _projectGoalCriterionRowHtml(''));
    if (typeof hydrateUiIcons === 'function') hydrateUiIcons(editor);
    const inputs = editor.querySelectorAll('.project-goal-criterion-input');
    inputs[inputs.length - 1]?.focus();
    _updateProjectGoalEditor();
  });
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) void closeProjectGoalEditor();
  });
  document.addEventListener('keydown', (event) => {
    if (!overlay.classList.contains('open')) return;
    if (typeof _uiIsTopDialogOverlay === 'function' && !_uiIsTopDialogOverlay(overlay)) return;
    if (event.isComposing || event.keyCode === 229) return;
    if (typeof _uiTrapDialogTab === 'function' && _uiTrapDialogTab(overlay, event)) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      void closeProjectGoalEditor();
    }
  });
  if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
    window.orkas.onPushEvent('projects:goal-changed', (payload) => {
      const pid = payload && payload.projectId;
      if (pid && pid === _projectDetailPid && typeof currentView !== 'undefined' && currentView === 'project') void loadProjectGoal(pid);
    });
  }
  window.addEventListener('i18n-change', () => renderProjectGoal());
}

_bindProjectGoal();
