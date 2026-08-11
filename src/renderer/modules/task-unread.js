/* Orkas Frontend — unread task replies
 *
 * A task becomes unread when its top-level run reaches a user-visible
 * terminal state while that conversation is not being viewed. The state is
 * persisted per account so a relaunch does not erase the attention cue.
 * Project ownership is cached with the unread record so aggregate dots still
 * work when a project's conversation page is collapsed or not yet loaded.
 */

const _TASK_UNREAD_STORAGE_PREFIX = 'task_unread_v1_';
const _TASK_UNREAD_MAX_RECORDS = 500;

let _taskUnreadOwnerUserId = '';
let _taskUnreadScopeRefreshPromise = null;
const _taskUnreadByCid = new Map(); // cid -> { projectId: string|null, finishedAt: number }
const _taskReadAtByCid = new Map(); // cid -> last acknowledged terminal timestamp
const _taskUnreadPendingTerminals = new Map(); // terminal events received before initUser

function _taskUnreadCurrentUserId() {
  try {
    return typeof currentUserId === 'string' ? currentUserId.trim() : '';
  } catch (_) {
    return '';
  }
}

function _taskUnreadStorageKey(userId) {
  return `${_TASK_UNREAD_STORAGE_PREFIX}${encodeURIComponent(String(userId || ''))}`;
}

function _taskUnreadSafeCid(value) {
  const cid = typeof value === 'string' ? value.trim() : '';
  return cid && /^[A-Za-z0-9_-]+$/.test(cid) ? cid : '';
}

function _taskUnreadTimestamp(value, fallback = Date.now()) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function _taskUnreadLoadOwner(userId) {
  _taskUnreadOwnerUserId = userId;
  _taskUnreadByCid.clear();
  _taskReadAtByCid.clear();
  if (!userId) return;
  try {
    const raw = localStorage.getItem(_taskUnreadStorageKey(userId));
    if (!raw) return;
    const parsed = JSON.parse(raw);
    // Early development builds used a bare cid array. Accept it so upgrading
    // never silently loses an attention marker.
    const unreadRows = Array.isArray(parsed)
      ? parsed.map((cid) => ({ cid, projectId: null, finishedAt: 0 }))
      : (Array.isArray(parsed?.unread) ? parsed.unread : []);
    const readRows = Array.isArray(parsed?.read) ? parsed.read : [];
    for (const row of unreadRows.slice(0, _TASK_UNREAD_MAX_RECORDS)) {
      const cid = _taskUnreadSafeCid(row?.cid);
      if (!cid) continue;
      const projectId = row.projectId === null || row.projectId === undefined
        ? null
        : String(row.projectId || '');
      _taskUnreadByCid.set(cid, {
        projectId,
        finishedAt: _taskUnreadTimestamp(row.finishedAt, 0),
      });
    }
    for (const row of readRows.slice(0, _TASK_UNREAD_MAX_RECORDS)) {
      const cid = _taskUnreadSafeCid(row?.cid);
      if (!cid) continue;
      _taskReadAtByCid.set(cid, _taskUnreadTimestamp(row.readAt, 0));
    }
    // A crash between two storage writes or a hand-edited preference can
    // leave the same terminal in both arrays. The read watermark wins only
    // when it is at least as new; a genuinely newer reply remains unread.
    for (const [cid, record] of Array.from(_taskUnreadByCid.entries())) {
      if (_taskReadAtByCid.has(cid)
          && (_taskReadAtByCid.get(cid) || 0) >= record.finishedAt) {
        _taskUnreadByCid.delete(cid);
      }
    }
  } catch (_) {
    _taskUnreadByCid.clear();
    _taskReadAtByCid.clear();
  }
}

function _taskUnreadEnsureOwner() {
  const userId = _taskUnreadCurrentUserId();
  if (userId !== _taskUnreadOwnerUserId) _taskUnreadLoadOwner(userId);
  return userId;
}

function _taskUnreadSave() {
  const userId = _taskUnreadEnsureOwner();
  if (!userId) return;
  try {
    const unread = Array.from(_taskUnreadByCid.entries())
      .map(([cid, record]) => ({ cid, ...record }))
      .sort((a, b) => b.finishedAt - a.finishedAt)
      .slice(0, _TASK_UNREAD_MAX_RECORDS);
    const read = Array.from(_taskReadAtByCid.entries())
      .map(([cid, readAt]) => ({ cid, readAt }))
      .sort((a, b) => b.readAt - a.readAt)
      .slice(0, _TASK_UNREAD_MAX_RECORDS);
    const keepUnread = new Set(unread.map((row) => row.cid));
    const keepRead = new Set(read.map((row) => row.cid));
    for (const cid of Array.from(_taskUnreadByCid.keys())) {
      if (!keepUnread.has(cid)) _taskUnreadByCid.delete(cid);
    }
    for (const cid of Array.from(_taskReadAtByCid.keys())) {
      if (!keepRead.has(cid)) _taskReadAtByCid.delete(cid);
    }
    localStorage.setItem(_taskUnreadStorageKey(userId), JSON.stringify({ unread, read }));
  } catch (_) {
    // The indicator is helpful but must never affect task settlement or view
    // navigation when storage is unavailable.
  }
}

function _taskUnreadConversationScope(cid) {
  const rows = typeof conversations !== 'undefined' && Array.isArray(conversations)
    ? conversations
    : [];
  const conversation = rows.find((row) => row && row.conversation_id === cid);
  if (!conversation) return { known: false, projectId: null };
  return { known: true, projectId: String(conversation.project_id || '') };
}

function _taskUnreadHydrateScopes() {
  let changed = false;
  for (const [cid, record] of _taskUnreadByCid) {
    const scope = _taskUnreadConversationScope(cid);
    if (!scope.known || record.projectId === scope.projectId) continue;
    record.projectId = scope.projectId;
    changed = true;
  }
  if (changed) _taskUnreadSave();
  return changed;
}

function _taskUnreadConversationIsActivelyViewed(cid) {
  let sameConversation = false;
  try {
    sameConversation = currentView === 'conversation' && currentCid === cid;
  } catch (_) {}
  if (!sameConversation) return false;
  try {
    if (document.visibilityState === 'hidden') return false;
    if (typeof document.hasFocus === 'function' && !document.hasFocus()) return false;
  } catch (_) {}
  return true;
}

function _isConversationUnread(cid) {
  _taskUnreadEnsureOwner();
  return _taskUnreadByCid.has(String(cid || ''));
}

function _taskUnreadProjectCount(projectId) {
  _taskUnreadEnsureOwner();
  _taskUnreadHydrateScopes();
  const pid = String(projectId || '');
  let count = 0;
  for (const record of _taskUnreadByCid.values()) {
    if (record.projectId === pid) count += 1;
  }
  return count;
}

function _taskUnreadResolveUnknownScopesSoon() {
  if (_taskUnreadScopeRefreshPromise || typeof loadConversations !== 'function') return;
  _taskUnreadScopeRefreshPromise = Promise.resolve()
    // The bounded startup list intentionally omits conversations under
    // collapsed projects. A terminal event can still arrive for one of those
    // tasks, so resolving an unknown cid must request the authoritative full
    // list or its Projects/project parent dots would never light up.
    .then(() => loadConversations({ full: true }))
    .then(() => {
      _taskUnreadHydrateScopes();
      _refreshUnreadTaskIndicators();
    })
    .catch(() => {})
    .finally(() => { _taskUnreadScopeRefreshPromise = null; });
}

function _markConversationUnread(cid, options = {}) {
  const id = _taskUnreadSafeCid(cid);
  if (!id) return false;
  const finishedAt = _taskUnreadTimestamp(options.finishedAt);
  if (_taskUnreadConversationIsActivelyViewed(id)) {
    _markConversationRead(id, { readAt: finishedAt });
    return false;
  }
  if (!_taskUnreadEnsureOwner()) {
    _taskUnreadPendingTerminals.set(id, Math.max(
      _taskUnreadPendingTerminals.get(id) || 0,
      finishedAt,
    ));
    return true;
  }
  if ((_taskReadAtByCid.get(id) || 0) >= finishedAt) return false;
  const scope = _taskUnreadConversationScope(id);
  const previous = _taskUnreadByCid.get(id);
  _taskUnreadByCid.set(id, {
    projectId: scope.known ? scope.projectId : (previous?.projectId ?? null),
    finishedAt: Math.max(previous?.finishedAt || 0, finishedAt),
  });
  _taskUnreadSave();
  _refreshUnreadTaskIndicators();
  if (!scope.known) _taskUnreadResolveUnknownScopesSoon();
  return true;
}

function _markConversationRead(cid, options = {}) {
  const id = _taskUnreadSafeCid(cid);
  if (!id) return false;
  _taskUnreadPendingTerminals.delete(id);
  if (!_taskUnreadEnsureOwner()) return false;
  const unread = _taskUnreadByCid.get(id);
  const readAt = Math.max(
    _taskReadAtByCid.get(id) || 0,
    unread?.finishedAt || 0,
    _taskUnreadTimestamp(options.readAt),
  );
  const changed = !!unread || readAt > (_taskReadAtByCid.get(id) || 0);
  _taskUnreadByCid.delete(id);
  _taskReadAtByCid.set(id, readAt);
  if (changed) {
    _taskUnreadSave();
    _refreshUnreadTaskIndicators();
  }
  return !!unread;
}

function _forgetUnreadConversation(cid) {
  const id = _taskUnreadSafeCid(cid);
  if (!id) return;
  _taskUnreadEnsureOwner();
  _taskUnreadPendingTerminals.delete(id);
  const removedUnread = _taskUnreadByCid.delete(id);
  const removedRead = _taskReadAtByCid.delete(id);
  const changed = removedUnread || removedRead;
  if (changed) {
    _taskUnreadSave();
    _refreshUnreadTaskIndicators();
  }
}

function _forgetUnreadProject(projectId) {
  const pid = String(projectId || '');
  if (!pid) return;
  _taskUnreadEnsureOwner();
  let changed = false;
  for (const [cid, record] of Array.from(_taskUnreadByCid.entries())) {
    const scope = record.projectId === null ? _taskUnreadConversationScope(cid) : null;
    if (record.projectId === pid || (scope?.known && scope.projectId === pid)) {
      _taskUnreadByCid.delete(cid);
      _taskReadAtByCid.delete(cid);
      changed = true;
    }
  }
  if (changed) {
    _taskUnreadSave();
    _refreshUnreadTaskIndicators();
  }
}

function _restoreUnreadTaskState() {
  _taskUnreadOwnerUserId = '';
  if (!_taskUnreadEnsureOwner()) return;
  for (const [cid, finishedAt] of Array.from(_taskUnreadPendingTerminals.entries())) {
    _taskUnreadPendingTerminals.delete(cid);
    _markConversationUnread(cid, { finishedAt });
  }
  _taskUnreadHydrateScopes();
  _refreshUnreadTaskIndicators();
}

function _taskUnreadSetDot(el, visible) {
  if (!el) return;
  el.hidden = !visible;
}

function _refreshUnreadTaskIndicators(projectIdOverride) {
  _taskUnreadEnsureOwner();
  _taskUnreadHydrateScopes();

  // Unread attention belongs only to the sidebar navigation. Other task-list
  // surfaces reuse `.conv-item`, so keep the selector scoped or the same task
  // will incorrectly grow a dot in project/content workbenches too.
  if (typeof document?.querySelectorAll === 'function') {
    for (const item of document.querySelectorAll('.sidebar-conversation-nav .conv-item[data-cid]')) {
      const unread = _taskUnreadByCid.has(item.dataset?.cid || '');
      item.classList?.toggle?.('has-unread', unread);
      const row = item.querySelector?.(':scope > .conv-item-row')
        || item.querySelector?.('.conv-item-row');
      if (!row) continue;
      let dot = row.querySelector?.(':scope > .task-unread-dot')
        || row.querySelector?.('.task-unread-dot');
      if (!unread) {
        dot?.remove?.();
        continue;
      }
      if (!dot && typeof document.createElement === 'function') {
        dot = document.createElement('span');
        dot.className = 'task-unread-dot conv-item-unread-dot';
        dot.setAttribute?.('aria-hidden', 'true');
        const title = row.querySelector?.('.conv-item-title, .conv-item-title-input');
        // Keep the dot immediately after the visible title, matching the
        // Settings label-dot treatment instead of leading the task text.
        row.insertBefore?.(dot, title?.nextSibling || null);
      }
    }
  }

  let globalCount = 0;
  let projectsCount = 0;
  for (const record of _taskUnreadByCid.values()) {
    if (record.projectId === '') globalCount += 1;
    else if (record.projectId) projectsCount += 1;
  }
  _taskUnreadSetDot(document.getElementById?.('tasks-unread-dot'), globalCount > 0);
  _taskUnreadSetDot(document.getElementById?.('projects-unread-dot'), projectsCount > 0);

  for (const dot of document.querySelectorAll?.('[data-project-unread-dot]') || []) {
    _taskUnreadSetDot(dot, _taskUnreadProjectCount(dot.dataset?.projectUnreadDot) > 0);
  }
}

function _handleTaskTerminalUnread(payload) {
  if (!payload || payload.type !== 'terminal') return false;
  const status = String(payload.status || '').trim().toLowerCase();
  if (!['completed', 'failed', 'waiting_input'].includes(status)) return false;
  return _markConversationUnread(payload.conversation_id, {
    finishedAt: payload.finished_at_ms,
  });
}

function _acknowledgeVisibleUnreadTask() {
  let cid = '';
  try {
    if (currentView === 'conversation') cid = currentCid || '';
  } catch (_) {}
  if (cid && _taskUnreadConversationIsActivelyViewed(cid)) _markConversationRead(cid);
}

try {
  window.addEventListener('focus', () => setTimeout(_acknowledgeVisibleUnreadTask, 0));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') _acknowledgeVisibleUnreadTask();
  });
} catch (_) {}

if (typeof window !== 'undefined') {
  window.TaskUnread = {
    isUnread: _isConversationUnread,
    projectCount: _taskUnreadProjectCount,
    markRead: _markConversationRead,
    refresh: _refreshUnreadTaskIndicators,
  };
}
