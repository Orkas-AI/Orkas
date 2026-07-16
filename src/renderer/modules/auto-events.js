// Lightweight boot subscription for automation fires. The full automation
// editor/list bundle is loaded only when its tab or a project page opens.

const _autoEventsLog = createLogger('auto-events');
let _autoEventsHandle = null;

function _autoEventsTrack(kind, action, data) {
  try {
    if (window.Monitor && typeof window.Monitor[kind] === 'function') {
      window.Monitor[kind](action, data || {});
    }
  } catch (_) {}
}

function startAutoEventsSubscription() {
  if (_autoEventsHandle) return;
  if (!window.orkas || typeof window.orkas.stream !== 'function') return;
  try {
    _autoEventsHandle = window.orkas.stream('autoTasks.events', {}, (ev) => {
      const inner = ev && ev.event;
      if (!inner) return;
      const taskId = inner.taskId || inner.task_id || '';
      const cid = inner.cid || inner.conversation_id || '';
      if (inner.type === 'fire_failed') {
        const errorCode = inner.error_code || 'unknown';
        _autoEventsTrack('event', 'auto_task_fire_result', {
          result: 'failure', task_id: taskId, conversation_id: cid,
          duration_ms: Number(inner.duration_ms) || 0, error_code: errorCode,
        });
        _autoEventsTrack('error', 'auto_task_fire', {
          task_id: taskId, conversation_id: cid, error_type: 'runtime',
          error_code: errorCode, error_message: errorCode,
        });
      } else if (inner.type === 'conv_created') {
        _autoEventsTrack('event', 'auto_task_fire_result', {
          result: 'success', task_id: taskId, conversation_id: cid,
          duration_ms: Number(inner.duration_ms) || 0,
        });
        if (typeof loadConversations === 'function') {
          loadConversations().catch((err) => _autoEventsLog.warn('reload after fire failed', err));
        }
      } else {
        return;
      }
      if (typeof _autoLoadedOnce !== 'undefined' && _autoLoadedOnce && typeof loadAutoList === 'function') {
        loadAutoList(true).catch(() => {});
      }
    });
    _autoEventsHandle.promise.catch(() => { /* ignore */ });
  } catch (err) {
    _autoEventsLog.warn('subscribe autoTasks.events failed', err);
  }
}

window.startAutoEventsSubscription = startAutoEventsSubscription;
