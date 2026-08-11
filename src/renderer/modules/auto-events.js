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
      if (inner.type === 'fire_failed') {
        // Main reports the reliable privacy-safe telemetry terminal. This
        // stream only refreshes visible state and must never duplicate it.
      } else if (inner.type === 'conv_created') {
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
