// ── What's new ───────────────────────────────────────────────────────────
// What changed in the open project since this device last showed the user
// (plan Common/docs/plans/commander-project-continuity.md §3.3, §3.6): the
// first workspace tab, left of Tasks, present only while there is something
// new, listing P15 rows. It is the digest the project Commander is told, so
// both show the same facts. Shown in a visible, focused window, it counts as
// seen; within one visit a refresh keeps what was listed and adds what is new.

const _projectRecapLog = createLogger('project-recap');

let _projectRecapState = { pid: '', account: '', loaded: false, since: '', recap: null, seenThrough: '', reported: false };
let _projectRecapDisabled = false;
let _projectRecapLoadSeq = 0;
let _projectRecapRefreshTimer = null;

/** Glyph and P15 status color for each line of the digest. */
const _PROJECT_RECAP_LINES = {
  stuck: ['warning', 'waiting_input'],
  started: ['live', 'progress'],
  review: ['hourglass', 'review'],
  done: ['check-circle', 'completed'],
  automation_failed: ['x-circle', 'failed'],
  automation_unfinished: ['clock', 'stopped'],
  added: ['plus', 'todo'],
};

function _projectRecapAccount() {
  return typeof currentUserId === 'string' ? currentUserId : '';
}

function _projectRecapCurrent(pid) {
  return pid === _projectDetailPid && _projectRecapState.pid === pid
    && _projectRecapState.account === _projectRecapAccount();
}

/**
 * Read the digest for the open project. A navigation starts a new visit from
 * the stored seen time and, unless it asked for another tab, opens on this tab
 * when there is news; later refreshes in the same visit reuse its start and
 * never move the tab.
 */
async function loadProjectRecap(pid, { newVisit = false, openOnNews = true } = {}) {
  if (_projectRecapDisabled || !pid || !window.orkas) return;
  const account = _projectRecapAccount();
  const seq = ++_projectRecapLoadSeq;
  const previous = _projectRecapState;
  const sameVisit = !newVisit && previous.pid === pid && previous.account === account && previous.loaded;
  if (!sameVisit) {
    // Another project's or visit's news must never show while this one loads.
    _projectRecapState = { pid, account, loaded: false, since: '', recap: null, seenThrough: '', reported: false };
    renderProjectRecap();
    if (typeof _syncProjectDetailTabState === 'function') _syncProjectDetailTabState();
  }
  const res = await window.orkas.invoke('projects.recap.get', { projectId: pid, ...(sameVisit && previous.since ? { since: previous.since } : {}) })
    .catch((err) => ({ ok: false, error: err?.message || String(err) }));
  if (seq !== _projectRecapLoadSeq || pid !== _projectDetailPid || account !== _projectRecapAccount()) return;
  if (!res?.ok) {
    // Keep what is already listed; the next refresh tries again.
    _projectRecapLog.warn('project changes load failed');
    return;
  }
  if (res.enabled === false) {
    // This is a startup setting. Keep the tab hidden and stop asking for updates.
    _projectRecapDisabled = true;
    clearTimeout(_projectRecapRefreshTimer);
    _projectRecapRefreshTimer = null;
    return;
  }
  const state = _projectRecapState;
  // A refresh belongs to the same visit, including an acknowledgement still
  // in flight. Keep that identity so its result can update this visit.
  _projectRecapState = Object.assign(sameVisit ? previous : {}, {
    pid,
    account,
    loaded: true,
    since: sameVisit ? previous.since : String(res.since || ''),
    recap: res.shared ? null : res,
    seenThrough: state.pid === pid ? state.seenThrough : '',
    reported: state.pid === pid ? state.reported : false,
  });
  if (!sameVisit && openOnNews && _projectRecapState.recap?.total && typeof _openProjectDetailNewsTab === 'function') {
    _openProjectDetailNewsTab();
  }
  renderProjectRecap();
  if (typeof _syncProjectDetailTabState === 'function') _syncProjectDetailTabState();
  else acknowledgeProjectRecapIfVisible();
  // A change from this very second is left for the next digest; look again
  // once the second is over.
  if (res.settling) _scheduleProjectRecapRefresh(pid, 1100);
}

function _scheduleProjectRecapRefresh(pid, delay = 300) {
  if (_projectRecapDisabled || !pid || pid !== _projectDetailPid || typeof currentView === 'undefined' || currentView !== 'project') return;
  clearTimeout(_projectRecapRefreshTimer);
  _projectRecapRefreshTimer = setTimeout(() => {
    _projectRecapRefreshTimer = null;
    if (pid === _projectDetailPid) void loadProjectRecap(pid);
  }, delay);
}

/** Record what is shown as seen, only while this tab is open in front of the
 *  user. A background load or another tab is not the user looking. */
function acknowledgeProjectRecapIfVisible() {
  const state = _projectRecapState;
  const recap = state.recap;
  if (!recap?.total || !recap.computed_at || !_projectRecapCurrent(state.pid)) return;
  if (typeof currentView === 'undefined' || currentView !== 'project') return;
  if (typeof _projectDetailActiveTab === 'undefined' || _projectDetailActiveTab !== 'recap') return;
  if (document.visibilityState === 'hidden' || (typeof document.hasFocus === 'function' && !document.hasFocus())) return;
  if (state.acknowledging) return;
  if (state.seenThrough === recap.computed_at) return;
  const computedAt = recap.computed_at;
  state.seenThrough = computedAt;
  // One telemetry row per visit that showed news; later refreshes only move the record.
  const wasReported = state.reported;
  const counts = wasReported ? {} : (recap.counts || {});
  state.reported = true;
  state.acknowledging = true;
  window.orkas.invoke('projects.recap.markSeen', { projectId: state.pid, computedAt, counts })
    .then(() => {
      if (_projectRecapState !== state) return;
      state.acknowledging = false;
      // News refreshed during the write still needs its own acknowledgement.
      if (state.recap?.computed_at !== computedAt) acknowledgeProjectRecapIfVisible();
    })
    .catch(() => {
      // Not recorded: a later look records it.
      if (_projectRecapState === state && state.seenThrough === computedAt) {
        state.acknowledging = false;
        state.seenThrough = '';
        state.reported = wasReported;
      }
    });
}

function _projectRecapLocale() {
  try {
    return getLocaleMeta(getLang()).intlLocale || undefined;
  } catch (_) {
    return undefined;
  }
}

function _projectRecapRelativeTime(value) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return t('common.just_now');
  const locale = _projectRecapLocale();
  try {
    const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const minutes = Math.round(diff / 60000);
    if (minutes < 60) return relative.format(-minutes, 'minute');
    const hours = Math.round(diff / 3600000);
    if (hours < 24) return relative.format(-hours, 'hour');
    const days = Math.round(diff / 86400000);
    if (days < 7) return relative.format(-days, 'day');
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toLocaleDateString();
  }
}

function _projectRecapIcon(name, className) {
  return typeof uiIconHtml === 'function' ? uiIconHtml(name, className) : '';
}

/** A P15 row: status glyph, title, the status in words with the note and time,
 *  and the action. Titles and notes are text, never markup. */
function _projectRecapRowHtml(line, item) {
  const [icon, kind] = _PROJECT_RECAP_LINES[line] || ['dot', 'todo'];
  const title = String(item.text || '').split('\n').map((part) => part.trim()).find(Boolean) || item.id;
  const note = String(item.note || '').replace(/\s+/g, ' ').trim();
  const details = [note, _projectRecapRelativeTime(item.at)].filter(Boolean).map((part) => escapeHtml(part)).join(' · ');
  return `<button type="button" class="home-row project-recap-row" data-recap-kind="${escapeHtml(item.kind)}"`
    + ` data-recap-id="${escapeHtml(item.id)}"${item.cid ? ` data-recap-cid="${escapeHtml(item.cid)}"` : ''}>`
    + `<span class="home-row-status is-${escapeHtml(kind)}" aria-hidden="true">${_projectRecapIcon(icon, 'home-row-status-icon')}</span>`
    + '<span class="home-row-main">'
    + `<span class="home-row-title">${escapeHtml(title)}</span>`
    + `<span class="home-row-meta"><span class="home-row-source">${escapeHtml(t(`project.recap.line_${line}`))}</span>${details}</span>`
    + '</span>'
    + `<span class="home-row-action">${escapeHtml(t('project.recap.view'))}${_projectRecapIcon('chevron-right', 'home-row-action-icon')}</span>`
    + '</button>';
}

function renderProjectRecap() {
  const tab = document.getElementById('project-recap-tab');
  const count = document.getElementById('project-recap-count');
  const list = document.getElementById('project-recap-list');
  if (!tab || !list) return;
  const state = _projectRecapState;
  const recap = _projectRecapCurrent(_projectDetailPid) ? state.recap : null;
  const total = Number(recap?.total) || 0;
  tab.hidden = !total;
  if (count) count.textContent = total ? String(total) : '';
  if (!total) {
    list.innerHTML = '';
    return;
  }
  const lines = Array.isArray(recap.lines) ? recap.lines : [];
  const rows = lines.flatMap((group) => (Array.isArray(group.items) ? group.items : []).map((item) => _projectRecapRowHtml(group.line, item)));
  const more = Math.max(0, total - rows.length);
  list.innerHTML = rows.join('')
    + (more ? `<div class="project-recap-more">${escapeHtml(t('project.recap.more', { count: more }))}</div>` : '');
}

function _openProjectRecapItem(row) {
  const kind = row.dataset.recapKind || '';
  const id = row.dataset.recapId || '';
  const cid = row.dataset.recapCid || '';
  if (kind === 'task') {
    const task = typeof _projectTodos !== 'undefined' && Array.isArray(_projectTodos)
      ? _projectTodos.find((item) => item && item.id === id) : null;
    if (task && typeof _openProjectTodoEditor === 'function') {
      _openProjectTodoEditor(task);
      return;
    }
  }
  // An automation run, or a to-do no longer on this board: its conversation holds the work.
  if (cid && typeof setView === 'function') setView('conversation', cid, { entryPoint: 'project' });
}

function _bindProjectRecap() {
  const list = document.getElementById('project-recap-list');
  if (!list || list.dataset.bound === '1') return;
  list.dataset.bound = '1';
  list.addEventListener('click', (event) => {
    const row = event.target.closest?.('.project-recap-row');
    if (row) _openProjectRecapItem(row);
  });
  // Coming back to the window with this tab open is the user looking.
  window.addEventListener('focus', acknowledgeProjectRecapIfVisible);
  document.addEventListener('visibilitychange', acknowledgeProjectRecapIfVisible);
  if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
    window.orkas.onPushEvent('projects:tasks-changed', (payload) => {
      _scheduleProjectRecapRefresh(payload && payload.projectId);
    });
  }
  window.addEventListener('i18n-change', () => renderProjectRecap());
}

_bindProjectRecap();
