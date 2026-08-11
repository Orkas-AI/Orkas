// orkas-bridge permission prompts — when an external CLI agent (claude
// code / codex) asks to call one of the user's connected services through
// the bridge, main pushes `bridge:permission` and this module shows the
// allow-once / always-allow / deny choice. No answer (user closes the
// dialog or walks away) denies on the main-side timeout; replying to a
// stale request is harmless (`handled:false`).
//
// Requests queue FIFO so two concurrent CLI runs can't stack overlapping
// dialogs.

const _bridgeLog = createLogger('bridge');

const _bridgePermissionQueue = [];
let _bridgeDialogOpen = false;
const _bridgePermissionCancelled = new Set();
const _bridgePermissionControllers = new Map();

function _bridgePermissionLabel(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

async function _showBridgePermissionDialog(info) {
  const startedAt = Date.now();
  const requestId = String(info.request_id || '');
  if (_bridgePermissionCancelled.delete(requestId)) return;
  const agent = _bridgePermissionLabel(info.agent_name || info.agent_id);
  const connector = _bridgePermissionLabel(info.connector_name || info.connector_id);
  const tool = _bridgePermissionLabel(info.tool_name);
  let choice = null;
  let dialogFailed = false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller) _bridgePermissionControllers.set(requestId, controller);
  try {
    choice = await uiChoice({
      title: t('bridge.permission.title'),
      message: t('bridge.permission.message', { agent, connector, tool }),
      cancelLabel: t('bridge.permission.deny'),
      choices: [
        { id: 'allow_once', label: t('bridge.permission.allow_once') },
        { id: 'allow_always', label: t('bridge.permission.allow_always'), style: '' },
      ],
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (_err) {
    // A broken dialog must fail closed and must not block later queued
    // requests. Main also has a timeout, but replying deny gives immediate,
    // predictable recovery.
    dialogFailed = true;
    _bridgeLog.warn('permission dialog failed; denying request');
  }
  _bridgePermissionControllers.delete(requestId);
  if (_bridgePermissionCancelled.delete(requestId)) return;
  const allow = choice === 'allow_once' || choice === 'allow_always';
  const decision = choice === 'allow_once' || choice === 'allow_always' ? choice : 'deny';
  let effectiveDecision = decision;
  let result = dialogFailed ? 'failure' : 'success';
  let errorCode = dialogFailed ? 'dialog_failed' : '';
  let errorType = dialogFailed ? 'ui' : '';
  try {
    const response = await window.orkas.invoke('bridge.permission_response', {
      request_id: info.request_id,
      allow,
      always: choice === 'allow_always',
    });
    if (!dialogFailed && response && response.handled === false) {
      result = 'cancelled';
      errorCode = 'request_stale';
      errorType = 'state';
    } else if (!dialogFailed && choice === 'allow_always' && response && response.always_saved === false) {
      result = 'failure';
      errorCode = 'remember_failed';
      errorType = 'storage';
      effectiveDecision = 'allow_once';
    }
  } catch (err) {
    result = 'failure';
    errorCode = 'response_failed';
    errorType = 'ipc';
    _bridgeLog.warn('permission response failed', {
      error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
    });
  }
  try {
    const level = result === 'failure' ? 'warn' : 'info';
    _bridgeLog[level]('permission response result', {
      result,
      decision,
      effective_decision: effectiveDecision,
      duration_ms: Math.max(0, Date.now() - startedAt),
      ...(errorCode ? { error_code: errorCode } : {}),
    });
  } catch (_) {}
  try {
    if (window.Monitor) {
      const payload = {
        result,
        decision,
        effective_decision: effectiveDecision,
        duration_ms: Math.max(0, Date.now() - startedAt),
      };
      if (errorCode) payload.error_code = errorCode;
      if (errorType) payload.error_type = errorType;
      Monitor.event('connector_bridge_permission_result', payload);
    }
  } catch (_) {
    // Permission handling must not depend on observability.
  }
}

async function _drainBridgePermissionQueue() {
  if (_bridgeDialogOpen) return;
  _bridgeDialogOpen = true;
  try {
    while (_bridgePermissionQueue.length) {
      const info = _bridgePermissionQueue.shift();
      await _showBridgePermissionDialog(info);
    }
  } finally {
    _bridgeDialogOpen = false;
  }
}

if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
  try {
    window.orkas.onPushEvent('bridge:permission', (info) => {
      if (!info || typeof info.request_id !== 'string' || !info.request_id.trim()) return;
      _bridgePermissionQueue.push(info);
      _drainBridgePermissionQueue().catch(() => {
        _bridgeLog.warn('permission queue failed');
      });
    });
    window.orkas.onPushEvent('bridge:permission_cancelled', (payload) => {
      const ids = Array.isArray(payload && payload.request_ids)
        ? payload.request_ids.filter((id) => typeof id === 'string')
        : [];
      for (const id of ids) {
        _bridgePermissionCancelled.add(id);
        const controller = _bridgePermissionControllers.get(id);
        if (controller) controller.abort();
      }
      if (ids.length) {
        const cancelled = new Set(ids);
        for (let i = _bridgePermissionQueue.length - 1; i >= 0; i -= 1) {
          if (cancelled.has(_bridgePermissionQueue[i] && _bridgePermissionQueue[i].request_id)) {
            _bridgePermissionQueue.splice(i, 1);
          }
        }
      }
    });
  } catch (_err) { /* push channel unavailable; bridge calls deny on timeout */ }
}
