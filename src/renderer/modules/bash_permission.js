// Sensitive-operation prompts — under approval access modes, when an
// in-process agent wants to run a command or access a path the classifier
// flagged as sensitive (network exfil / dangerous delete / privilege
// escalation / sensitive path), main pushes `bash:permission` and this module shows the
// allow-once / allow-for-this-run / deny choice, plus a compact selector for
// the durable local-access permission level. Waiting for a human click is kept
// alive on the main side with progress heartbeats.
//
// Requests queue FIFO so concurrent workers can't stack overlapping dialogs.

const _bashPermLog = createLogger('bash-permission');

const _bashPermQueue = [];
let _bashPermDialogOpen = false;

const _BASH_PERMISSION_MODES = ['workspace_approval', 'all_files_approval', 'all_files_auto'];
const _BASH_PERMISSION_DEFAULT_MODE = 'all_files_approval';

function _bashIsMode(mode) {
  return _BASH_PERMISSION_MODES.includes(mode);
}

function _bashT(key, fallback) {
  try {
    const v = t(key);
    return v && v !== key ? v : fallback;
  } catch (_) {
    return fallback;
  }
}

function _bashEscapeHtml(value) {
  try {
    if (typeof escapeHtml === 'function') return escapeHtml(String(value || ''));
  } catch (_) { /* fall through */ }
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _bashReasonText(reasons) {
  const list = Array.isArray(reasons) ? reasons : [];
  const labels = list.map((r) => t(`bash.permission.reason.${r}`));
  return labels.filter(Boolean).join(t('bash.permission.reason_sep'));
}

function _bashPermissionModeOptions() {
  return _BASH_PERMISSION_MODES.map((mode) => ({
    mode,
    label: t(`settings.localexec.mode.${mode}`),
    desc: t(`settings.localexec.mode.${mode}_desc`),
  }));
}

function _bashAgentLabel(info) {
  const id = String((info && (info.agent_id || info.agentId)) || '').trim();
  const name = String((info && (info.agent_name || info.agentName)) || '').trim();
  const loweredName = name.toLowerCase();
  if (id === 'commander' || loweredName === 'commander' || loweredName === 'orkas_chat') {
    return _bashT('chat.from_commander', 'Commander');
  }
  return name || id || t('bash.permission.agent_fallback');
}

async function _getBashPermissionCurrentMode() {
  try {
    const res = await window.orkas.invoke('permissions.getLocalExec');
    const mode = res && res.mode;
    return _bashIsMode(mode) ? mode : _BASH_PERMISSION_DEFAULT_MODE;
  } catch (err) {
    _bashPermLog.warn('get local access mode failed', { error: err && err.message });
    return _BASH_PERMISSION_DEFAULT_MODE;
  }
}

async function _setBashPermissionMode(mode) {
  if (!_bashIsMode(mode)) return false;
  try {
    const res = await window.orkas.invoke('permissions.setLocalExecMode', { mode });
    return !!(res && res.mode === mode && res.ok !== false);
  } catch (err) {
    _bashPermLog.warn('set local access mode failed', { mode, error: err && err.message });
    return false;
  }
}

function _showBashPermissionModeDialog({ title, message, currentMode }) {
  const modes = _bashPermissionModeOptions();
  const safeCurrentMode = _bashIsMode(currentMode) ? currentMode : _BASH_PERMISSION_DEFAULT_MODE;
  const modeTitle = _bashT('bash.permission.mode_title', 'Permission level');
  const modeHint = _bashT('bash.permission.mode_hint', 'You can also change this later in Settings > Tool execution permissions.');

  // Test harness hook: production always uses the DOM dialog below.
  try {
    const hook = window && window.__orkasBashPermissionDialogForTest;
    if (typeof hook === 'function') {
      return Promise.resolve(hook({ title, message, currentMode: safeCurrentMode, modeTitle, modeHint, modes }));
    }
  } catch (_) { /* ignore test hook lookup failures */ }

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay open';
    const titleHtml = title ? `<div class="modal-title ui-dialog-title">${_bashEscapeHtml(title)}</div>` : '';
    const msgHtml = _bashEscapeHtml(message).replace(/\n/g, '<br />');
    let selectedModeValue = safeCurrentMode;
    const selectedItem = () => modes.find((item) => item.mode === selectedModeValue) || modes.find((item) => item.mode === safeCurrentMode) || modes[0];
    const modeHtml = modes.map((item) => `
      <button class="bash-permission-mode-option${item.mode === safeCurrentMode ? ' is-selected' : ''}" type="button" role="option" aria-selected="${item.mode === safeCurrentMode ? 'true' : 'false'}" data-mode="${_bashEscapeHtml(item.mode)}">
        <span class="bash-permission-mode-check" aria-hidden="true">${item.mode === safeCurrentMode ? '✓' : ''}</span>
        <span class="bash-permission-mode-copy">
          <span class="bash-permission-mode-label">${_bashEscapeHtml(item.label)}</span>
          <span class="bash-permission-mode-desc">${_bashEscapeHtml(item.desc)}</span>
        </span>
      </button>
    `).join('');
    const initialItem = selectedItem();
    const caretHtml = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
      ? window.uiIconHtml('chevron-down', 'bash-permission-mode-trigger-caret')
      : '<span class="bash-permission-mode-trigger-caret" aria-hidden="true">⌄</span>';

    overlay.innerHTML = `
      <div class="modal modal-standard ui-dialog bash-permission-dialog" role="dialog" aria-modal="true">
        ${titleHtml}
        <div class="modal-body ui-dialog-message bash-permission-message">${msgHtml}</div>
        <div class="bash-permission-footer">
          <div class="modal-actions bash-permission-actions">
            <div class="bash-permission-mode-control">
              <button class="btn bash-permission-mode-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
                <span class="bash-permission-mode-trigger-label">${_bashEscapeHtml(initialItem ? initialItem.label : modeTitle)}</span>
                ${caretHtml}
              </button>
            </div>
            <span class="bash-permission-actions-spacer" aria-hidden="true"></span>
            <button class="btn" data-act="cancel">${_bashEscapeHtml(t('bash.permission.deny'))}</button>
            <button class="btn btn-primary" data-act="choice" data-id="allow_once">${_bashEscapeHtml(t('bash.permission.allow_once'))}</button>
            <button class="btn" data-act="choice" data-id="allow_run">${_bashEscapeHtml(t('bash.permission.allow_run'))}</button>
          </div>
          <div class="bash-permission-mode-hint">${_bashEscapeHtml(modeHint)}</div>
        </div>
      </div>
      <div class="bash-permission-mode-menu" role="listbox" hidden>
        ${modeHtml}
      </div>
    `;
    document.body.appendChild(overlay);

    const selectedMode = () => {
      return _bashIsMode(selectedModeValue) ? selectedModeValue : safeCurrentMode;
    };
    const modeTrigger = overlay.querySelector('.bash-permission-mode-trigger');
    const modeMenu = overlay.querySelector('.bash-permission-mode-menu');
    const modeTriggerLabel = overlay.querySelector('.bash-permission-mode-trigger-label');
    const modeOptions = Array.from(overlay.querySelectorAll('.bash-permission-mode-option'));
    const updateModeUi = () => {
      const item = selectedItem();
      if (modeTriggerLabel && item) modeTriggerLabel.textContent = item.label;
      modeOptions.forEach((btn) => {
        const isSelected = btn.dataset.mode === selectedModeValue;
        btn.classList.toggle('is-selected', isSelected);
        btn.setAttribute('aria-selected', isSelected ? 'true' : 'false');
        const check = btn.querySelector('.bash-permission-mode-check');
        if (check) check.textContent = isSelected ? '✓' : '';
      });
    };
    const closeMenu = () => {
      if (!modeMenu || modeMenu.hidden) return;
      modeMenu.hidden = true;
      modeTrigger?.setAttribute('aria-expanded', 'false');
    };
    const positionMenu = () => {
      if (!modeMenu || !modeTrigger) return;
      const triggerRect = modeTrigger.getBoundingClientRect();
      const overlayRect = overlay.getBoundingClientRect();
      const menuWidth = Math.min(360, Math.max(320, overlayRect.width - 24));
      modeMenu.style.width = `${menuWidth}px`;
      modeMenu.style.left = `${Math.max(12, Math.min(triggerRect.left - overlayRect.left, overlayRect.width - menuWidth - 12))}px`;
      const gap = 8;
      const menuHeight = modeMenu.offsetHeight;
      const topAbove = triggerRect.top - overlayRect.top - menuHeight - gap;
      const topBelow = triggerRect.bottom - overlayRect.top + gap;
      const top = topAbove >= 12
        ? topAbove
        : Math.min(topBelow, Math.max(12, overlayRect.height - menuHeight - 12));
      modeMenu.style.top = `${top}px`;
    };
    const openMenu = () => {
      if (!modeMenu) return;
      modeMenu.hidden = false;
      positionMenu();
      modeTrigger?.setAttribute('aria-expanded', 'true');
    };
    modeTrigger?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!modeMenu) return;
      if (modeMenu.hidden) openMenu();
      else closeMenu();
    });
    modeOptions.forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (_bashIsMode(mode)) {
          selectedModeValue = mode;
          updateModeUi();
        }
        closeMenu();
        modeTrigger?.focus();
      });
    });
    const onDocClick = (e) => {
      const control = overlay.querySelector('.bash-permission-mode-control');
      if (control && !control.contains(e.target) && modeMenu && !modeMenu.contains(e.target)) closeMenu();
    };

    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        if (modeMenu && !modeMenu.hidden) {
          closeMenu();
          e.preventDefault();
          return;
        }
        finish('deny');
      }
    };
    const finish = (choice) => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onDocClick, true);
      const mode = selectedMode();
      overlay.remove();
      resolve({ choice, mode });
    };
    overlay.querySelectorAll('[data-act="choice"]').forEach((btn) => {
      btn.addEventListener('click', () => finish(btn.dataset.id || 'deny'));
    });
    const cancelBtn = overlay.querySelector('[data-act="cancel"]');
    cancelBtn.addEventListener('click', () => finish('deny'));
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onDocClick, true);
    setTimeout(() => cancelBtn.focus(), 0);
  });
}

async function _showBashPermissionDialog(info) {
  const agent = _bashAgentLabel(info);
  const reasonsText = _bashReasonText(info.reasons);
  const command = String(info.command || '');
  const operation = String(info.operation || '').trim();
  const subject = String(info.subject || '').trim();
  const isAction = !!(operation || subject);
  const message = isAction
    ? t('bash.permission.action_message', {
      agent,
      operation: operation || t('bash.permission.action_fallback'),
      reasons: reasonsText,
    }) + (subject ? `\n\n${subject}` : '')
    : t('bash.permission.message', { agent, reasons: reasonsText }) + '\n\n' + command;

  const currentMode = await _getBashPermissionCurrentMode();
  const result = await _showBashPermissionModeDialog({
    title: t(isAction ? 'bash.permission.action_title' : 'bash.permission.title'),
    message,
    currentMode,
  });
  const choice = result && typeof result === 'object' ? result.choice : result;
  const selectedMode = _bashIsMode(result && result.mode) ? result.mode : currentMode;
  let decision = (choice === 'allow_once' || choice === 'allow_run') ? choice : 'deny';
  let effectiveMode = currentMode;
  if (choice === 'allow_always') {
    const ok = currentMode === 'all_files_auto' || await _setBashPermissionMode('all_files_auto');
    if (ok) {
      decision = 'allow_once';
      effectiveMode = 'all_files_auto';
    } else {
      decision = 'deny';
    }
  } else if (decision !== 'deny' && selectedMode !== currentMode) {
    const ok = await _setBashPermissionMode(selectedMode);
    if (ok) effectiveMode = selectedMode;
    else decision = 'deny';
  }

  try {
    if (window.Monitor) {
      Monitor.event('bash_risk_prompt_result', {
        decision: choice === 'allow_always' ? 'allow_always' : decision,
        mode: effectiveMode,
        mode_changed: effectiveMode !== currentMode,
        categories: (info.reasons || []).join('|'),
      });
    }
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
