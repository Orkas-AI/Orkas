// Bash risk-permission prompts — under the "risk_prompt" tool-execution mode,
// when an in-process agent wants to run a command the classifier flagged as
// risky (network exfil / dangerous delete / privilege escalation / sensitive
// path), main pushes `bash:permission` and this module shows the
// allow-once / allow-for-this-run / deny choice. No answer (user closes the
// dialog or walks away) denies on the main-side timeout; replying to a stale
// request is harmless (`handled:false`).
//
// Requests queue FIFO so concurrent workers can't stack overlapping dialogs.

const _bashPermLog = createLogger('bash-permission');

const _bashPermQueue = [];
let _bashPermDialogOpen = false;

function _bashReasonText(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  const labels = list.map((r) => t(`bash.permission.reason.${r}`));
  return labels.filter(Boolean).join(t('bash.permission.reason_sep'));
}

async function _showBashPermissionDialog(info) {
  const agent = info.agent_name || t('bash.permission.agent_fallback');
  const reasonsText = _bashReasonText(info.reasons);
  const command = String(info.command || '');
  const message =
    t('bash.permission.message', { agent, reasons: reasonsText }) +
    '\n\n' + command;

  const choice = await uiChoice({
    title: t('bash.permission.title'),
    message,
    cancelLabel: t('bash.permission.deny'),
    choices: [
      { id: 'allow_once', label: t('bash.permission.allow_once') },
      { id: 'allow_run', label: t('bash.permission.allow_run'), style: '' },
    ],
  });
  const decision = (choice === 'allow_once' || choice === 'allow_run') ? choice : 'deny';

  try {
  } catch (_e) { /* telemetry must not break the gate */ }

  try {
    await window.orkas.invoke('bash.permission_response', {
      request_id: info.request_id,
      decision,
    });
  } catch (err) {
    _bashPermLog.warn('bash permission response failed', { error: err && err.message });
  }
}

async function _drainBashPermissionQueue() {
  if (_bashPermDialogOpen) return;
  _bashPermDialogOpen = true;
  try {
    while (_bashPermQueue.length) {
      const info = _bashPermQueue.shift();
      await _showBashPermissionDialog(info);
    }
  } finally {
    _bashPermDialogOpen = false;
  }
}

if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
  try {
    window.orkas.onPushEvent('bash:permission', (info) => {
      if (!info || typeof info.request_id !== 'string') return;
      _bashPermQueue.push(info);
      _drainBashPermissionQueue();
    });
  } catch (_err) { /* push channel unavailable; bash calls deny on timeout */ }
}
