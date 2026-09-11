// Sensitive-operation prompts — under approval access modes, when an
// agent wants to run a command, access a path, or call a connector that main
// flagged as sensitive, this module shows an allow-once / deny choice, plus
// a task-scoped choice only when main marks the
// category and actor eligible, alongside the durable local-access mode switch.
// Waiting for a human click is kept alive on the main side with progress
// heartbeats; Renderer never widens main's operation-approval boundary.
//
// Requests queue FIFO so concurrent workers can't stack overlapping dialogs.

const _bashPermLog = createLogger('bash-permission');

const _bashPermQueue = [];
let _bashPermDialogOpen = false;
const _bashPermCancelled = new Set();
const _bashPermDialogClosers = new Map();

const _BASH_PERMISSION_MODES = ['workspace_approval', 'all_files_approval', 'all_files_auto'];
const _BASH_PERMISSION_DEFAULT_MODE = 'all_files_approval';
const _CLI_PERMISSION_POLICIES = ['inherit', 'ask', 'full_access'];
const _BASH_PERMISSION_RISK_CATEGORIES = ['network_egress', 'destructive', 'priv_esc', 'sensitive_path', 'system_package_change', 'external_mutation'];
const _BASH_IRREVERSIBLE_ACTIONS = ['recursive_delete', 'untargeted_process_kill'];

function _bashPermissionVisibilityState() {
  try {
    if (typeof document !== 'undefined' && typeof document.visibilityState === 'string') {
      if (document.visibilityState !== 'visible') return 'hidden';
      if (typeof document.hasFocus === 'function') {
        return document.hasFocus() ? 'visible_focused' : 'visible_unfocused';
      }
      return 'visible_unknown_focus';
    }
  } catch (_) { /* fall through */ }
  return 'unknown';
}

function _bashPermissionTelemetry(name, properties) {
  try {
    if (window.Monitor) Monitor.event(name, properties);
  } catch (_) { /* permission delivery must not depend on observability */ }
}

function _bashPermissionCategories(info) {
  const reasons = Array.isArray(info && info.reasons) ? info.reasons : [];
  return [...new Set(reasons.filter((reason) => _BASH_PERMISSION_RISK_CATEGORIES.includes(reason)))].join('|');
}

// Whether the new-in-auto-mode gate is doing useful work or only adding
// clicks is only answerable if the verdict carries the finding that caused it.
// Same closed-world/pipe-joined shape as `categories`; no path or command.
function _bashPermissionIrreversible(info) {
  const list = Array.isArray(info && info.irreversible) ? info.irreversible : [];
  return [...new Set(list.filter((a) => _BASH_IRREVERSIBLE_ACTIONS.includes(a)))].join('|');
}

function _bashPermissionReceivedAt(info, fallback = Date.now()) {
  const value = Number(info && info._renderer_received_at_ms);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function _bashTrackCancelledPermission(info, currentMode, errorCode = 'request_cancelled') {
  _bashTrackPermissionResult(info, {
    result: 'cancelled',
    decision: 'none',
    effective_decision: 'deny',
    ...(currentMode ? { mode: currentMode } : {}),
    mode_changed: false,
    categories: _bashPermissionCategories(info),
    ...(_bashPermissionIrreversible(info) ? { irreversible: _bashPermissionIrreversible(info) } : {}),
    duration_ms: Math.max(0, Date.now() - _bashPermissionReceivedAt(info)),
    error_type: 'state',
    error_code: errorCode,
  });
}

function _bashTrackPermissionResult(info, properties) {
  if (info._permission_kind === 'connector') {
    // Custom MCP ids derive from a user-authored display name and their tool
    // names are server-defined free text: report the stable `custom` bucket and
    // omit the tool name (same coarsening as connectors.js `_connectorTrackPayload`).
    const rawConnectorId = String(info.connector_id || '');
    const customConnector = rawConnectorId.startsWith('custom-');
    _bashPermissionTelemetry('connector_action_confirmation_result', {
      connector_id: customConnector ? 'custom' : rawConnectorId,
      ...(customConnector ? {} : { tool_name: String(info.tool_name || '') }),
      risk: info.risk || '',
      sensitive_operation: info.sensitive_operation || '',
      decision: properties.effective_decision === 'deny' ? 'denied' : 'approved',
      result: properties.result,
      duration_ms: properties.duration_ms,
      ...((typeof window.getOnboardingTelemetryContext === 'function')
        ? window.getOnboardingTelemetryContext(info.cid)
        : {}),
    });
    return;
  }
  _bashPermissionTelemetry('bash_risk_prompt_result', properties);
}

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

// Main keeps irreversible steps in approval even under all_files_auto. Without
// a word about why, a user who deliberately turned prompts off reads the
// dialog as the setting having failed, so the note names the mode explicitly.
function _bashIrreversibleText(info, currentMode) {
  const list = Array.isArray(info && info.irreversible) ? info.irreversible : [];
  const labels = [...new Set(list.filter((a) => _BASH_IRREVERSIBLE_ACTIONS.includes(a)))]
    .map((a) => _bashT(`bash.permission.irreversible.${a}`, ''))
    .filter(Boolean);
  if (!labels.length) return '';
  const actions = labels.join(t('bash.permission.reason_sep'));
  if (currentMode !== 'all_files_auto') {
    return _bashT('bash.permission.irreversible_note', '')
      ? t('bash.permission.irreversible_note', { actions })
      : '';
  }
  // Name the level the way Settings does, read from the same key, so the user
  // can connect the sentence to the switch they actually flipped.
  const mode = _bashT('settings.localexec.mode.all_files_auto', 'all_files_auto');
  return _bashT('bash.permission.irreversible_auto_note', '')
    ? t('bash.permission.irreversible_auto_note', { actions, mode })
    : '';
}

const _BASH_EXTERNAL_MUTATION_KINDS = [
  'database_write', 'remote_command', 'remote_file_write', 'service_change',
  'deployment_change', 'external_api_write', 'remote_publish', 'external_launch',
];

function _bashExternalMutationText(findings) {
  if (!Array.isArray(findings)) return '';
  const operations = [];
  for (const raw of findings.slice(0, 8)) {
    if (!raw || typeof raw !== 'object' || !_BASH_EXTERNAL_MUTATION_KINDS.includes(raw.kind)) continue;
    const kind = _bashT(`bash.permission.external_kind.${raw.kind}`, raw.kind);
    const action = String(raw.action || '').replace(/\s+/g, ' ').trim().slice(0, 48);
    const target = String(raw.target || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    operations.push([kind, action, target].filter(Boolean).join(' · '));
  }
  if (!operations.length) return '';
  return t('bash.permission.external_operations', { operations: operations.join('\n') });
}

function _bashPermissionModeOptions() {
  return _BASH_PERMISSION_MODES.map((mode) => ({
    mode,
    label: t(`settings.localexec.mode.${mode}`),
    desc: t(`settings.localexec.mode.${mode}_desc`),
  }));
}

function _bashIsCliPermissionPolicy(policy) {
  return _CLI_PERMISSION_POLICIES.includes(policy);
}

function _bashCliPermissionModeOptions(info) {
  const cli = String(info && info.cli || '').trim();
  const advertised = Array.isArray(info && info.permission_policies)
    ? info.permission_policies.filter(_bashIsCliPermissionPolicy)
    : ['inherit'];
  const policies = [...new Set(advertised.length ? advertised : ['inherit'])];
  return policies.map((policy) => ({
    mode: policy,
    label: t(`agents.cli_permission_${policy}`),
    desc: t(`agents.cli_permission_${policy}_desc`, { cli }),
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

function _bashPermissionConversationTitle(info) {
  const direct = String(info && info.conversation_title || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  if (direct) return direct;
  const cid = String(info && info.cid || '').trim();
  try {
    const conv = cid && typeof conversations !== 'undefined' && Array.isArray(conversations)
      ? conversations.find((item) => item && item.conversation_id === cid)
      : null;
    return String(conv && conv.title || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  } catch (_) {
    return '';
  }
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

function _showBashPermissionModeDialog({
  title,
  message,
  currentMode,
  requestId,
  onPresented,
  allowRun = true,
  showModeControl = true,
  modes = _bashPermissionModeOptions(),
  modeValidator = _bashIsMode,
  defaultMode = _BASH_PERMISSION_DEFAULT_MODE,
  modeTitle = _bashT('bash.permission.mode_title', 'Permission level'),
  modeHint = _bashT('bash.permission.mode_hint', 'You can also change this later in Settings > Tool execution permissions.'),
}) {
  const safeCurrentMode = modeValidator(currentMode) ? currentMode : defaultMode;

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
    const modeControlHtml = showModeControl ? `
            <div class="bash-permission-mode-control">
              <button class="btn bash-permission-mode-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
                <span class="bash-permission-mode-trigger-label">${_bashEscapeHtml(initialItem ? initialItem.label : modeTitle)}</span>
                ${caretHtml}
              </button>
            </div>` : '';
    const allowRunHtml = allowRun
      ? `<button class="btn" data-act="choice" data-id="allow_run">${_bashEscapeHtml(t('bash.permission.allow_run'))}</button>`
      : '';

    overlay.innerHTML = `
      <div class="modal modal-standard ui-dialog bash-permission-dialog" role="dialog" aria-modal="true" aria-label="${_bashEscapeHtml(title)}">
        ${titleHtml}
        <div class="modal-body ui-dialog-message bash-permission-message">${msgHtml}</div>
        <div class="bash-permission-footer">
          <div class="modal-actions bash-permission-actions">
            ${modeControlHtml}
            <span class="bash-permission-actions-spacer" aria-hidden="true"></span>
            <button class="btn" data-act="cancel">${_bashEscapeHtml(t('bash.permission.deny'))}</button>
            <button class="btn btn-primary" data-act="choice" data-id="allow_once">${_bashEscapeHtml(t('bash.permission.allow_once'))}</button>
            ${allowRunHtml}
          </div>
          ${showModeControl ? `<div class="bash-permission-mode-hint">${_bashEscapeHtml(modeHint)}</div>` : ''}
        </div>
      </div>
      <div class="bash-permission-mode-menu" role="listbox" hidden>
        ${modeHtml}
      </div>
    `;
    document.body.appendChild(overlay);
    try { if (typeof onPresented === 'function') onPresented(); } catch (_) { /* telemetry only */ }

    const selectedMode = () => {
      return modeValidator(selectedModeValue) ? selectedModeValue : safeCurrentMode;
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
      modeMenu.style.maxHeight = '';
      const menuHeight = modeMenu.offsetHeight;
      const triggerWithinOverlay = {
        top: triggerRect.top - overlayRect.top,
        bottom: triggerRect.bottom - overlayRect.top,
      };
      const placement = _dropdownVerticalPlacement(
        triggerWithinOverlay,
        menuHeight,
        overlayRect.height,
        { edge: 12, gap },
      );
      modeMenu.style.top = `${placement.top}px`;
      modeMenu.style.maxHeight = `${Math.min(280, placement.availableHeight)}px`;
      modeMenu.dataset.placement = placement.openAbove ? 'top' : 'bottom';
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
        if (modeValidator(mode)) {
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
    let finished = false;
    const finish = (choice, cancelled = false) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onDocClick, true);
      if (requestId) _bashPermDialogClosers.delete(requestId);
      const mode = selectedMode();
      overlay.remove();
      resolve({ choice, mode, cancelled });
    };
    if (requestId) {
      _bashPermDialogClosers.set(requestId, () => finish('deny', true));
      if (_bashPermCancelled.has(requestId)) finish('deny', true);
    }
    overlay.querySelectorAll('[data-act="choice"]').forEach((btn) => {
      btn.addEventListener('click', () => finish(btn.dataset.id || 'deny'));
    });
    const cancelBtn = overlay.querySelector('[data-act="cancel"]');
    const allowOnceBtn = overlay.querySelector('[data-id="allow_once"]');
    cancelBtn.addEventListener('click', () => finish('deny'));
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onDocClick, true);
    setTimeout(() => allowOnceBtn?.focus(), 0);
  });
}

async function _showBashPermissionDialog(info) {
  const startedAt = Date.now();
  const requestId = String(info.request_id || '');
  if (_bashPermCancelled.delete(requestId)) {
    _bashTrackCancelledPermission(info, null);
    return;
  }
  const isConnector = info._permission_kind === 'connector';
  const agent = _bashAgentLabel(info);
  const reasonsText = _bashReasonText(info.reasons);
  const command = String(info.command || '');
  const operation = String(info.operation || '').trim();
  const subject = String(info.subject || '').trim();
  const isAction = isConnector || !!(operation || subject);
  const baseMessage = isConnector ? _connectorActionMessage(info) : isAction
    ? t('bash.permission.action_message', {
      agent,
      operation: operation || t('bash.permission.action_fallback'),
      reasons: reasonsText,
    }) + (subject ? `\n\n${subject}` : '')
    : t('bash.permission.message', { agent, reasons: reasonsText }) + '\n\n' + command;
  const externalMutationText = _bashExternalMutationText(info.external_mutations);

  const currentMode = await _getBashPermissionCurrentMode();
  if (_bashPermCancelled.delete(requestId)) {
    _bashTrackCancelledPermission(info, currentMode);
    return;
  }
  // Needs the resolved mode: the same step is worth flagging in every mode,
  // but only an all_files_auto user is owed an explanation for being asked.
  const message = [
    baseMessage,
    _bashIrreversibleText(info, currentMode),
    externalMutationText,
  ].filter(Boolean).join('\n\n');
  let presented = false;
  const isSensitiveApproval = isConnector || (Array.isArray(info.reasons)
    && info.reasons.some((reason) => _BASH_PERMISSION_RISK_CATEGORIES.includes(reason)));
  // Connector approvals bind the exact account, operation and arguments, like
  // other external mutations. A task grant must not widen that approval.
  const canAllowRun = !isConnector && (!isSensitiveApproval || info.can_allow_run === true);
  // An earlier queued permission can switch the account to Trusted while this
  // connector waits. Its host gate already checked availability/prohibitions.
  let result;
  let dialogFailed = false;
  try {
    result = isConnector && currentMode === 'all_files_auto'
      ? { choice: 'allow_once', mode: currentMode }
      : await _showBashPermissionModeDialog({
        title: t(isAction ? 'bash.permission.action_title' : 'bash.permission.title'),
        message,
        currentMode,
        requestId,
        allowRun: canAllowRun,
        showModeControl: true,
        onPresented: () => {
          if (isConnector) return;
          if (presented) return;
          presented = true;
          _bashPermissionTelemetry('bash_risk_prompt_presented', {
            categories: _bashPermissionCategories(info),
            ...(_bashPermissionIrreversible(info) ? { irreversible: _bashPermissionIrreversible(info) } : {}),
            mode: currentMode,
            visibility_state: _bashPermissionVisibilityState(),
            queue_wait_ms: Math.max(0, Date.now() - _bashPermissionReceivedAt(info, startedAt)),
          });
        },
      });
  } catch (err) {
    dialogFailed = true;
    result = { choice: 'deny', mode: currentMode };
    _bashPermLog.warn('operation permission dialog failed', {
      error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
    });
  }
  if (result && result.cancelled) {
    _bashPermCancelled.delete(requestId);
    _bashTrackCancelledPermission(info, currentMode);
    return;
  }
  const choice = result && typeof result === 'object' ? result.choice : result;
  const selectedMode = _bashIsMode(result && result.mode)
    ? result.mode
    : currentMode;
  const requestedDecision = (choice === 'allow_once' || choice === 'allow_run' || choice === 'allow_always')
    ? choice
    : 'deny';
  let decision = (choice === 'allow_once' || choice === 'allow_run') ? choice : 'deny';
  if (!canAllowRun && decision === 'allow_run') decision = 'allow_once';
  let effectiveMode = currentMode;
  if (choice === 'allow_always' && isSensitiveApproval) {
    decision = 'allow_once';
  } else if (choice === 'allow_always') {
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
  if (_bashPermCancelled.delete(requestId)) {
    _bashTrackCancelledPermission(info, effectiveMode);
    return;
  }

  const baseResult = {
    decision: requestedDecision,
    effective_decision: decision,
    mode: effectiveMode,
    mode_changed: effectiveMode !== currentMode,
    categories: _bashPermissionCategories(info),
    ...(_bashPermissionIrreversible(info) ? { irreversible: _bashPermissionIrreversible(info) } : {}),
  };
  try {
    const response = await window.orkas.invoke(
      isConnector ? 'connectors.action_confirm_response' : 'bash.permission_response',
      isConnector
        ? { request_id: info.request_id, approved: decision !== 'deny' }
        : { request_id: info.request_id, decision },
    );
    const failed = !response || response.ok === false;
    const stale = !failed && response.handled === false;
    try {
      _bashTrackPermissionResult(info, {
        ...baseResult,
        result: failed || dialogFailed ? 'failure' : (stale ? 'cancelled' : 'success'),
        duration_ms: Math.max(0, Date.now() - startedAt),
        ...(dialogFailed
          ? { error_code: 'dialog_failed', error_type: 'ui' }
          : failed ? { error_code: 'response_failed', error_type: 'ipc' }
          : (stale ? { error_code: 'stale_request', error_type: 'state' } : {})),
      });
    } catch (_e) { /* permission delivery must not depend on observability */ }
  } catch (err) {
    _bashPermLog.warn('bash permission response failed', {
      error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
    });
    try {
      _bashTrackPermissionResult(info, {
        ...baseResult,
        result: 'failure',
        duration_ms: Math.max(0, Date.now() - startedAt),
        error_type: 'ipc',
        error_code: 'response_failed',
      });
    } catch (_) { /* the permission response must not depend on observability */ }
  }
  _bashPermCancelled.delete(requestId);
}

async function _drainBashPermissionQueue() {
  if (_bashPermDialogOpen) return;
  _bashPermDialogOpen = true;
  try {
    while (_bashPermQueue.length) {
      const info = _bashPermQueue.shift();
      if (info && info._permission_kind === 'local-agent') {
        await _showLocalAgentPermissionDialog(info);
      } else {
        await _showBashPermissionDialog(info);
      }
    }
  } finally {
    _bashPermDialogOpen = false;
  }
}

async function _showLocalAgentPermissionDialog(info) {
  const startedAt = Date.now();
  const requestId = String(info && info.request_id || '');
  if (_bashPermCancelled.delete(requestId)) return;
  const isConnectorPermission = info && info.permission_kind === 'connector';
  const agent = _bashAgentLabel(info);
  const conversationTitle = _bashPermissionConversationTitle(info);
  const action = String(info && (info.tool || info.description) || '').trim()
    || t('agents.cli_permission_action_fallback');
  const details = [];
  const description = String(info && info.description || '').trim();
  const command = String(info && info.command || '').trim();
  const subject = String(info && info.subject || '').trim();
  if (description && description !== action) details.push(description);
  if (command) details.push(command);
  if (subject) details.push(subject);
  const permission = [action, ...details]
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(' · ');
  const message = [
    t('agents.cli_permission_task', { title: conversationTitle || t('chat.new_conv_title') }),
    t('agents.cli_permission_requested', { permission }),
  ].join('\n');
  const currentMode = _bashIsCliPermissionPolicy(info && info.permission_policy)
    ? info.permission_policy
    : 'inherit';
  const modes = _bashCliPermissionModeOptions(info);
  const result = await _showBashPermissionModeDialog({
    title: t('agents.cli_permission_prompt_title'),
    message,
    currentMode,
    requestId,
    allowRun: info && info.can_allow_run === true,
    showModeControl: true,
    modes,
    modeValidator: _bashIsCliPermissionPolicy,
    defaultMode: 'inherit',
    modeTitle: t('agents.cli_permission'),
    modeHint: t('agents.cli_permission_mode_hint', { agent }),
  });
  if (result && result.cancelled) {
    _bashPermCancelled.delete(requestId);
    return;
  }
  const choice = result && typeof result === 'object' ? result.choice : result;
  const selectedMode = _bashIsCliPermissionPolicy(result && result.mode)
    ? result.mode
    : currentMode;
  const decision = choice === 'allow_run'
    ? 'allow_run'
    : choice === 'allow_once' ? 'allow_once' : 'deny';
  let response = null;
  let telemetryResult = 'success';
  let effectiveDecision = decision;
  let errorCode = '';
  let errorType = '';
  try {
    response = await window.orkas.invoke('localAgents.permissionResponse', {
      request_id: requestId,
      decision,
      permission_policy: selectedMode,
    });
    if (!response || response.ok === false) {
      telemetryResult = 'failure';
      effectiveDecision = 'deny';
      errorCode = 'response_failed';
      errorType = 'ipc';
    } else if (response.handled === false) {
      telemetryResult = 'cancelled';
      effectiveDecision = 'deny';
      errorCode = 'stale_request';
      errorType = 'state';
    } else {
      const returnedDecision = response.decision;
      if (returnedDecision === 'allow_once' || returnedDecision === 'allow_run' || returnedDecision === 'deny') {
        effectiveDecision = returnedDecision;
      }
      if (decision !== 'deny' && response.policy_saved === false) {
        telemetryResult = 'failure';
        effectiveDecision = 'deny';
        errorCode = 'permission_level_save_failed';
        errorType = 'storage';
      }
    }
  } catch (err) {
    telemetryResult = 'failure';
    effectiveDecision = 'deny';
    errorCode = 'response_failed';
    errorType = 'ipc';
    _bashPermLog.warn('external CLI permission response failed', {
      error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
    });
  }
  if (isConnectorPermission) {
    _bashPermissionTelemetry('connector_bridge_permission_result', {
      result: telemetryResult,
      decision,
      effective_decision: effectiveDecision,
      duration_ms: Math.max(0, Date.now() - startedAt),
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(errorType ? { error_type: errorType } : {}),
    });
  }
  _bashPermCancelled.delete(requestId);
}

function _cancelBashPermissionRequests(payload, kind) {
  const ids = Array.isArray(payload && payload.request_ids)
    ? payload.request_ids.filter((id) => typeof id === 'string')
    : [];
  const cancelled = new Set(ids);
  for (const id of ids) {
    _bashPermCancelled.add(id);
    const close = _bashPermDialogClosers.get(id);
    if (close) close();
  }
  for (let i = _bashPermQueue.length - 1; i >= 0; i -= 1) {
    const info = _bashPermQueue[i];
    if (info && info._permission_kind === kind && cancelled.has(info.request_id)) {
      _bashPermQueue.splice(i, 1);
      _bashPermCancelled.delete(info.request_id);
      if (kind !== 'local-agent') _bashTrackCancelledPermission(info, null);
    }
  }
}

if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
  try {
    window.orkas.onPushEvent('bash:permission', (info) => {
      if (!info || typeof info.request_id !== 'string') return;
      const queuedInfo = {
        ...info,
        _renderer_received_at_ms: Date.now(),
      };
      _bashPermissionTelemetry('bash_risk_prompt_requested', {
        categories: _bashPermissionCategories(info),
        ...(_bashPermissionIrreversible(info) ? { irreversible: _bashPermissionIrreversible(info) } : {}),
        visibility_state: _bashPermissionVisibilityState(),
      });
      _bashPermQueue.push(queuedInfo);
      _drainBashPermissionQueue();
    });
    window.orkas.onPushEvent('bash:permission_cancelled', (payload) => {
      _cancelBashPermissionRequests(payload, undefined);
    });
    window.orkas.onPushEvent('local-agent:permission', (info) => {
      if (!info || typeof info.request_id !== 'string') return;
      _bashPermQueue.push({
        ...info,
        _permission_kind: 'local-agent',
        _renderer_received_at_ms: Date.now(),
      });
      _drainBashPermissionQueue();
    });
    window.orkas.onPushEvent('local-agent:permission_cancelled', (payload) => {
      _cancelBashPermissionRequests(payload, 'local-agent');
    });
    window.orkas.onPushEvent('connectors:action-confirm', (info) => {
      if (!info || typeof info.request_id !== 'string') return;
      _bashPermQueue.push({
        ...info,
        _permission_kind: 'connector',
        _renderer_received_at_ms: Date.now(),
      });
      _drainBashPermissionQueue();
    });
    window.orkas.onPushEvent('connectors:action-confirm-cancelled', (payload) => {
      _cancelBashPermissionRequests(payload, 'connector');
    });
  } catch (_err) { /* push channel unavailable; bash calls deny on timeout */ }
}
