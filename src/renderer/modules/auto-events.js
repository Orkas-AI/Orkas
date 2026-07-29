// Lightweight boot subscription for automation fires. The full automation
// editor/list bundle is loaded only when its tab or a project page opens.

const _autoEventsLog = createLogger('auto-events');
let _autoEventsHandle = null;
let _autoEventsRetryTimer = null;
let _autoEventsRetryAttempt = 0;
let _autoEventsStopping = false;
const _AUTO_EVENTS_RETRY_BASE_MS = 1000;
const _AUTO_EVENTS_RETRY_MAX_MS = 30000;

function _autoEventsActiveUserId() {
  const value = typeof currentUserId !== 'undefined'
    ? currentUserId
    : (window && window.currentUserId);
  return typeof value === 'string' ? value.trim() : '';
}

function _autoEventsIdentifier(value) {
  return typeof value === 'string' ? value.slice(0, 128) : '';
}

function _autoEventsErrorCode(value) {
  return typeof value === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value)
    ? value
    : 'unknown';
}

function _autoEventsDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return 0;
  return Math.min(24 * 60 * 60 * 1000, Math.max(0, duration));
}

function _autoEventsTrack(kind, action, data) {
  try {
    if (window.Monitor && typeof window.Monitor[kind] === 'function') {
      window.Monitor[kind](action, data || {});
    }
  } catch (_) {}
}

function _autoEventsScheduleRetry() {
  if (_autoEventsStopping || _autoEventsRetryTimer || _autoEventsHandle) return;
  if (!window.orkas || typeof window.orkas.stream !== 'function') return;
  const delay = Math.min(
    _AUTO_EVENTS_RETRY_MAX_MS,
    _AUTO_EVENTS_RETRY_BASE_MS * (2 ** _autoEventsRetryAttempt),
  );
  _autoEventsRetryAttempt += 1;
  _autoEventsRetryTimer = setTimeout(() => {
    _autoEventsRetryTimer = null;
    _autoEventsOpenSubscription();
  }, delay);
}

function _autoEventsOpenSubscription() {
  if (_autoEventsStopping || _autoEventsHandle) return;
  if (!window.orkas || typeof window.orkas.stream !== 'function') return;
  try {
    const handle = window.orkas.stream('autoTasks.events', {}, (ev) => {
      const inner = ev && ev.event;
      if (!inner) return;
      const activeUserId = _autoEventsActiveUserId();
      if (!activeUserId || inner.user_id !== activeUserId) return;
      _autoEventsRetryAttempt = 0;
      const taskId = _autoEventsIdentifier(inner.taskId || inner.task_id);
      const cid = _autoEventsIdentifier(inner.cid || inner.conversation_id);
      if (inner.type === 'fire_failed') {
        const errorCode = _autoEventsErrorCode(inner.error_code);
        _autoEventsTrack('event', 'auto_task_fire_result', {
          result: 'failure', task_id: taskId, conversation_id: cid,
          duration_ms: _autoEventsDuration(inner.duration_ms), error_code: errorCode,
        });
        _autoEventsTrack('error', 'auto_task_fire', {
          task_id: taskId, conversation_id: cid, error_type: 'runtime',
          error_code: errorCode, error_message: errorCode,
        });
      } else if (inner.type === 'conv_created') {
        _autoEventsTrack('event', 'auto_task_fire_result', {
          result: 'success', task_id: taskId, conversation_id: cid,
          duration_ms: _autoEventsDuration(inner.duration_ms),
        });
        if (typeof loadConversations === 'function') {
          Promise.resolve(loadConversations())
            .catch(() => _autoEventsLog.warn('reload after fire failed'));
        }
      } else {
        return;
      }
      if (typeof _autoLoadedOnce !== 'undefined' && _autoLoadedOnce && typeof loadAutoList === 'function') {
        Promise.resolve(loadAutoList(true)).catch(() => {});
      }
    });
    if (!handle || !handle.promise || typeof handle.cancel !== 'function') {
      try { handle?.cancel?.(); } catch (_) {}
      _autoEventsScheduleRetry();
      return;
    }
    _autoEventsHandle = handle;
    Promise.resolve(handle.promise).then(
      () => {
        if (_autoEventsHandle !== handle) return;
        _autoEventsHandle = null;
        _autoEventsScheduleRetry();
      },
      () => {
        if (_autoEventsHandle !== handle) return;
        _autoEventsHandle = null;
        _autoEventsScheduleRetry();
      },
    );
  } catch (_) {
    _autoEventsLog.warn('subscribe autoTasks.events failed');
    _autoEventsScheduleRetry();
  }
}

function startAutoEventsSubscription() {
  _autoEventsStopping = false;
  if (_autoEventsRetryTimer) {
    clearTimeout(_autoEventsRetryTimer);
    _autoEventsRetryTimer = null;
  }
  _autoEventsOpenSubscription();
}

function stopAutoEventsSubscription() {
  _autoEventsStopping = true;
  if (_autoEventsRetryTimer) {
    clearTimeout(_autoEventsRetryTimer);
    _autoEventsRetryTimer = null;
  }
  const handle = _autoEventsHandle;
  _autoEventsHandle = null;
  try { handle?.cancel?.(); } catch (_) {}
}

window.addEventListener('beforeunload', stopAutoEventsSubscription, { once: true });
window.startAutoEventsSubscription = startAutoEventsSubscription;
window.stopAutoEventsSubscription = stopAutoEventsSubscription;
