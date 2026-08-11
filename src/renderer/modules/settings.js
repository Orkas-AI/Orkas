// ─── Settings (entries-based: picker + priority list) ────────────────────
// The page is split in two:
//   1. "Add model auth": pick provider + model, then "+ Add account" →
//      either an API Key form or the OAuth flow, depending on what the
//      provider supports. On success we auto-create a priority-list
//      entry pointing at the new credential.
//   2. "Model configuration (by priority)": ordered list of
//      (provider, model, profile) entries. The first available entry is the
//      default model; later available items are the fallback chain. Available
//      rows are drag-reorderable. Disabled official rows stay at the bottom
//      as gray, non-rotating entries with an Enable action.

const _settingsLog = createLogger('settings');
const _OPENROUTER_CUSTOM_MODEL_VALUE = '__openrouter_custom_model__';

function _settingsIsOpenRouterCustomModel(providerId, modelId) {
  return providerId === 'openrouter' && modelId === _OPENROUTER_CUSTOM_MODEL_VALUE;
}

function _settingsResolveApiKeyModelId(providerId, selectedModelId, enteredModelId) {
  return _settingsIsOpenRouterCustomModel(providerId, selectedModelId)
    ? String(enteredModelId || '').trim()
    : String(selectedModelId || '').trim();
}

let _settingsState = {
  providers: [],      // from auth.listProviders  [{id, label, supportsApiKey, supportsOAuth, profiles, ...}]
  entries: [],        // from auth.listEntries
  modelsCache: {},    // provider → [{id, name}]
  pickerProviderSel: null,
  pickerModelSel: null,
  pickerProviderEl: null,
  pickerModelEl: null,
  addBtnEl: null,
  ttsPresets: [],
  ttsProfiles: [],
  ttsProviderSel: null,
  dragState: null,
  taskNotifications: {
    enabled: true,
    permission: { state: 'unknown', can_open_settings: false },
  },
  taskNotificationsBound: false,
  taskNotificationsToggleEpoch: 0,
  taskNotificationPermissionRefreshTimer: null,
  taskNotificationPermissionTelemetryKey: '',
  clientConfigBound: false,
  recycleBound: false,
};

function _settingsTrackClick() {}

function _settingsTrackEvent(action, payload) {
  void action;
  void payload;
}

function _settingsTrackError(action, payload) {
  void action;
  void payload;
}

// The open build keeps the settings flow intact but intentionally has no
// internal model-configuration telemetry sink.
function _settingsTrackModelConfigResult() {}

function _settingsResultErrorCode(res, fallback = 'operation_failed') {
  const code = String((res && res.code) || '').trim();
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : fallback;
}

async function _settingsSafeCall(label, fn) {
  if (typeof fn !== 'function') return;
  try {
    await fn();
  } catch (err) {
    _settingsLog.warn(`${label} failed`, { error: (err && err.message) || String(err) });
  }
}

async function loadSettings() {
  // 4-tab structure (batch 6). Initialize switching + activate default tab
  // (通用 by default — matches the is-active class on the markup).
  if (typeof initSettingsTabs === 'function') initSettingsTabs();
  _settingsBindLanguageOnce();
  _settingsBindTaskNotificationsOnce();
  _settingsBindClientConfigOnce();
  _settingsBindRecycleBinOnce();
  _settingsSyncLanguageRadio();
  await Promise.all([
    _settingsSafeCall('settings providers refresh', _settingsRefreshProviders),
    _settingsSafeCall('settings entries refresh', _settingsRefreshEntries),
    _settingsSafeCall('settings local execution refresh', _settingsRefreshLocalExec),
    _settingsSafeCall('settings search refresh', _settingsRefreshSearchProfiles),
    _settingsSafeCall('settings image refresh', _settingsRefreshImageProfiles),
    _settingsSafeCall('settings video refresh', _settingsRefreshVideoProfiles),
    _settingsSafeCall('settings tts refresh', _settingsRefreshTtsProfiles),
    _settingsSafeCall('settings task notifications refresh', _settingsRefreshTaskNotifications),
    _settingsSafeCall('settings metacognition refresh', _settingsRefreshMetacognition),
    _settingsSafeCall('settings data root refresh', _settingsRefreshDataRoot),
    _settingsSafeCall('settings recycle bin refresh', _settingsRefreshRecycleBin),
  ]);
  await _settingsSafeCall('settings picker render', _settingsRenderPicker);
  await _settingsSafeCall('settings entries render', _settingsRenderEntries);
  await _settingsSafeCall('settings local execution render', _settingsRenderLocalExec);
  await _settingsSafeCall('settings search render', _settingsRenderSearchSection);
  await _settingsSafeCall('settings image render', _settingsRenderImageSection);
  await _settingsSafeCall('settings video render', _settingsRenderVideoSection);
  await _settingsSafeCall('settings tts render', _settingsRenderTtsEntries);
  await _settingsSafeCall('settings task notifications render', _settingsRenderTaskNotifications);
  await _settingsSafeCall('settings metacognition render', _settingsRenderMetacognition);
  await _settingsSafeCall('settings data root render', _settingsRenderDataRoot);
  // Account card + subscription card (views/login/account_settings.js — absent in
  // the open-source build, so these are no-ops there). renderSubscriptionSettings rebinds the
  // action button's click handler with the current subscription state on every
  // render — opening the panel is the canonical "guarantee fresh button binding"
  // moment, so call it explicitly here (not just from the account.onChange listener
  // which only fires on state changes — for a Free user with no transitions the
  // listener never fires after boot, leaving the button bound to whatever its
  // first render captured).
}

// ── Native task notifications ──
// Stored at preferences.json::task_notifications_enabled. Missing means ON;
// the main-process notification outlet reads the same preference at delivery
// time, so changes apply immediately to manual and scheduled tasks.

function _settingsTaskNotificationPermissionState(state) {
  return String(state?.permission?.state || 'unknown');
}

function _settingsNormalizeTaskNotificationPermission(permission) {
  return {
    state: String(permission && permission.state || 'unknown'),
    can_open_settings: !!(permission && permission.can_open_settings),
  };
}

function _settingsReportTaskNotificationPermission(source) {
  const state = _settingsState.taskNotifications || {
    enabled: true,
    permission: { state: 'unknown', can_open_settings: false },
  };
  const permissionState = _settingsTaskNotificationPermissionState(state);
  const key = `${!!state.enabled}:${permissionState}`;
  if (_settingsState.taskNotificationPermissionTelemetryKey === key) return;
  _settingsState.taskNotificationPermissionTelemetryKey = key;
  const payload = {
    enabled: !!state.enabled,
    permission_state: permissionState,
    source: String(source || 'settings_load'),
  };
  _settingsTrackEvent('task_notification_permission_state', payload);
  _settingsLog.info('task notification state observed', payload);
}

async function _settingsRefreshTaskNotifications(source = 'settings_load') {
  const epoch = _settingsState.taskNotificationsToggleEpoch;
  try {
    const res = await window.orkas.invoke('prefs.getTaskNotifications');
    if (!res || !res.ok) return false;
    const permission = _settingsNormalizeTaskNotificationPermission(res.permission);
    if (epoch !== _settingsState.taskNotificationsToggleEpoch) {
      // The preference read is stale, but the OS permission is an independent
      // device constraint. Preserve the newer user choice while still applying
      // the permission result and its recovery UI.
      _settingsState.taskNotifications = {
        ...(_settingsState.taskNotifications || { enabled: true }),
        permission,
      };
    } else {
      _settingsState.taskNotifications = {
        enabled: !!res.enabled,
        permission,
      };
    }
  } catch (_) {
    return false;
  }
  _settingsReportTaskNotificationPermission(source);
  _settingsRenderTaskNotifications();
  return true;
}

function _settingsBindTaskNotificationsOnce() {
  if (_settingsState.taskNotificationsBound) return;
  _settingsState.taskNotificationsBound = true;
  window.addEventListener('focus', () => {
    // The user can change the permission by opening System Settings directly,
    // so refresh on every return to Orkas rather than only after our own link.
    if (typeof currentView !== 'undefined' && currentView !== 'settings') return;
    if (_settingsState.taskNotificationPermissionRefreshTimer) {
      clearTimeout(_settingsState.taskNotificationPermissionRefreshTimer);
    }
    _settingsState.taskNotificationPermissionRefreshTimer = setTimeout(async () => {
      _settingsState.taskNotificationPermissionRefreshTimer = null;
      await _settingsRefreshTaskNotifications('window_focus');
      _settingsRenderTaskNotifications();
    }, 350);
  });
}

function _settingsRenderTaskNotifications() {
  const cb = document.getElementById('settings-task-notifications-toggle');
  if (!cb) return;
  const state = _settingsState.taskNotifications || {
    enabled: true,
    permission: { state: 'unknown', can_open_settings: false },
  };
  cb.checked = !!state.enabled;

  const warning = document.getElementById('settings-task-notification-permission');
  const warningText = document.getElementById('settings-task-notification-permission-text');
  const openBtn = document.getElementById('settings-task-notification-open-settings');
  const permissionState = String(state.permission && state.permission.state || 'unknown');
  const permissionBlocked = state.enabled
    && (permissionState === 'denied' || permissionState === 'presentation_disabled');
  if (warning) warning.hidden = !permissionBlocked;
  if (warningText) {
    const warningKey = permissionState === 'presentation_disabled'
      ? 'settings.task_notifications.presentation_disabled'
      : 'settings.task_notifications.permission_disabled';
    warningText.dataset.i18n = warningKey;
    warningText.textContent = t(warningKey);
  }
  if (openBtn) {
    openBtn.hidden = !(state.permission && state.permission.can_open_settings);
    if (!openBtn.dataset.bound) {
      openBtn.addEventListener('click', async () => {
        openBtn.disabled = true;
        _settingsTrackClick('task_notification_permission_open');
        try {
          const res = await window.orkas.invoke('prefs.openTaskNotificationSettings');
          if (!res || !res.ok || !res.opened) {
            _settingsLog.warn('open task notification settings rejected', {
              error_code: 'open_settings_rejected',
            });
          }
        } catch (err) {
          _settingsLog.warn('open task notification settings failed', {
            error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
          });
        } finally {
          openBtn.disabled = false;
        }
      });
      openBtn.dataset.bound = '1';
    }
  }
  if (!cb.dataset.bound) {
    cb.addEventListener('change', async () => {
      _settingsState.taskNotificationsToggleEpoch += 1;
      const startedAt = Date.now();
      const next = !!cb.checked;
      const currentState = _settingsState.taskNotifications || {
        enabled: true,
        permission: { state: 'unknown', can_open_settings: false },
      };
      const previous = !!currentState.enabled;
      const targetState = next ? 'enabled' : 'disabled';
      const permissionState = _settingsTaskNotificationPermissionState(currentState);
      // Keep state aligned with the already-changed checkbox while persistence
      // is pending. A concurrent permission refresh can then render without
      // visually rolling the user's choice back.
      _settingsState.taskNotifications = { ...currentState, enabled: next };
      _settingsLog.info('task notification toggle requested', {
        previous_enabled: previous,
        enabled: next,
        permission_state: permissionState,
      });
      cb.disabled = true;
      try {
        const res = await window.orkas.invoke('prefs.setTaskNotifications', { enabled: next });
        const savedEnabled = !!(res && res.enabled);
        const latestState = _settingsState.taskNotifications || currentState;
        if (res && res.ok && savedEnabled === next) {
          _settingsState.taskNotifications = {
            ...latestState,
            enabled: savedEnabled,
            permission: res.permission
              ? _settingsNormalizeTaskNotificationPermission(res.permission)
              : latestState.permission,
          };
          const savedPermissionState = _settingsTaskNotificationPermissionState(_settingsState.taskNotifications);
          _settingsTrackEvent('task_notification_toggle_result', {
            result: 'success',
            enabled: savedEnabled,
            target_state: targetState,
            permission_state: savedPermissionState,
            duration_ms: Math.max(0, Date.now() - startedAt),
          });
          _settingsLog.info('task notification toggle saved', {
            previous_enabled: previous,
            enabled: savedEnabled,
            permission_state: savedPermissionState,
          });
          _settingsReportTaskNotificationPermission('toggle_result');
        } else {
          const actualEnabled = res && res.ok ? savedEnabled : previous;
          _settingsState.taskNotifications = {
            ...latestState,
            enabled: actualEnabled,
            permission: res && res.permission
              ? _settingsNormalizeTaskNotificationPermission(res.permission)
              : latestState.permission,
          };
          const actualPermissionState = _settingsTaskNotificationPermissionState(
            _settingsState.taskNotifications,
          );
          const mismatch = !!(res && res.ok);
          _settingsTrackEvent('task_notification_toggle_result', {
            result: 'failure',
            enabled: actualEnabled,
            target_state: targetState,
            permission_state: actualPermissionState,
            duration_ms: Math.max(0, Date.now() - startedAt),
            error_type: 'persistence',
            error_code: mismatch ? 'update_mismatch' : 'update_rejected',
          });
          _settingsLog.warn('set task notifications rejected', {
            target_enabled: next,
            actual_enabled: actualEnabled,
            error_code: mismatch ? 'update_mismatch' : 'update_rejected',
          });
          if (mismatch) _settingsReportTaskNotificationPermission('toggle_result');
        }
      } catch (err) {
        _settingsState.taskNotifications = {
          ...(_settingsState.taskNotifications || currentState),
          enabled: previous,
        };
        const actualPermissionState = _settingsTaskNotificationPermissionState(
          _settingsState.taskNotifications,
        );
        _settingsTrackEvent('task_notification_toggle_result', {
          result: 'failure',
          enabled: previous,
          target_state: targetState,
          permission_state: actualPermissionState,
          duration_ms: Math.max(0, Date.now() - startedAt),
          error_type: 'ipc',
          error_code: 'invoke_failed',
        });
        _settingsLog.warn('set task notifications failed', {
          error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
        });
      } finally {
        cb.disabled = false;
        _settingsRenderTaskNotifications();
      }
    });
    cb.dataset.bound = '1';
  }
}

function _settingsBindClientConfigOnce() {}

// ── Local recycle bin ──

function _settingsRecycleAvailable() {
  return !!(
    window.orkas
    && window.orkas.recycleBin
    && typeof window.orkas.recycleBin.list === 'function'
  );
}

function _settingsRecycleTitle(batch) {
  const direct = String(batch?.display_title || batch?.label || '').trim();
  if (direct) return direct;
  const displayItems = Array.isArray(batch?.display_items) ? batch.display_items : [];
  const titles = displayItems
    .map((item) => String(item?.title || '').trim())
    .filter(Boolean);
  if (titles.length) return titles.join('; ');
  const paths = Array.isArray(batch?.paths_preview) ? batch.paths_preview : [];
  const names = paths
    .map((item) => String(item || '').split('/').filter(Boolean).pop() || '')
    .filter(Boolean);
  return names.join('; ') || t('settings.recycle.display_unknown');
}

function _settingsRecycleRowHtml(batch) {
  const id = escapeHtml(String(batch?.id || ''));
  const title = escapeHtml(_settingsRecycleTitle(batch));
  const timestamp = Number(batch?.created_at_ms) || 0;
  const deletedAt = timestamp ? new Date(timestamp).toLocaleString() : '';
  return `
    <div class="settings-recycle-row">
      <div class="settings-recycle-row-head">
        <div class="settings-recycle-main">
          <div class="settings-recycle-name">${title}</div>
          <div class="settings-recycle-meta">${escapeHtml(deletedAt)}</div>
        </div>
        <div class="settings-recycle-actions">
          <button class="btn btn-sm" type="button" data-recycle-restore="${id}">${escapeHtml(t('settings.recycle.restore'))}</button>
          <button class="btn btn-sm btn-danger" type="button" data-recycle-delete="${id}">${escapeHtml(t('settings.recycle.delete'))}</button>
        </div>
      </div>
    </div>
  `;
}

async function _settingsRefreshRecycleBin() {
  const body = document.getElementById('settings-recycle-body');
  if (!body || !_settingsRecycleAvailable()) return;
  try {
    const res = await window.orkas.recycleBin.list();
    const batches = Array.isArray(res?.batches) ? res.batches : [];
    body.innerHTML = batches.length
      ? batches.map(_settingsRecycleRowHtml).join('')
      : `<div class="settings-empty">${escapeHtml(t('settings.recycle.empty'))}</div>`;
  } catch (err) {
    _settingsLog.warn('recycle bin refresh failed', {
      error: (err && err.message) || String(err),
    });
    body.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.recycle.empty'))}</div>`;
  }
}

function _settingsBindRecycleBinOnce() {
  if (_settingsState.recycleBound) return;
  const body = document.getElementById('settings-recycle-body');
  if (!body) return;
  _settingsState.recycleBound = true;
  body.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('[data-recycle-restore], [data-recycle-delete]');
    if (!button || !_settingsRecycleAvailable()) return;
    const deleting = button.hasAttribute('data-recycle-delete');
    const id = button.getAttribute(deleting ? 'data-recycle-delete' : 'data-recycle-restore') || '';
    if (!id) return;
    const confirmed = deleting && typeof uiConfirmDanger === 'function'
      ? await uiConfirmDanger({
          title: t('settings.recycle.delete_title'),
          message: t('settings.recycle.delete_confirm'),
          dangerLabel: t('settings.recycle.delete'),
        })
      : await uiConfirm({
          message: t(deleting ? 'settings.recycle.delete_confirm' : 'settings.recycle.restore_confirm'),
          okLabel: t(deleting ? 'settings.recycle.delete' : 'settings.recycle.restore'),
        });
    if (!confirmed) return;
    button.disabled = true;
    try {
      if (deleting) {
        const res = await window.orkas.recycleBin.delete(id);
        if (!res?.deleted) throw new Error(t('settings.recycle.delete_not_found'));
      } else {
        await window.orkas.recycleBin.restore(id);
        if (typeof loadProjects === 'function') await loadProjects(true);
        if (typeof loadConversations === 'function') await loadConversations();
      }
    } catch (err) {
      _settingsLog.warn(`recycle bin ${deleting ? 'delete' : 'restore'} failed`, {
        error: (err && err.message) || String(err),
      });
      if (typeof uiAlert === 'function') {
        await uiAlert((err && err.message) || t(
          deleting ? 'settings.recycle.delete_failed' : 'settings.recycle.restore_failed',
        ));
      }
    } finally {
      button.disabled = false;
      await _settingsRefreshRecycleBin();
    }
  });
}

// ── Tool execution access permission ──

const _LOCALEXEC_MODES = ['workspace_approval', 'all_files_approval', 'all_files_auto'];

async function _settingsRefreshLocalExec() {
  const epoch = _settingsState.localExecToggleEpoch;
  const res = await window.orkas.invoke('permissions.getLocalExec');
  if (epoch !== _settingsState.localExecToggleEpoch) return;
  const mode = (res && res.ok && _LOCALEXEC_MODES.includes(res.mode)) ? res.mode : 'all_files_approval';
  _settingsState.localExec = { mode };
  _settingsRenderLocalExec();
}

function _settingsRenderLocalExec() {
  const container = document.getElementById('settings-localexec-modes');
  if (!container) return;
  const mode = (_settingsState.localExec && _settingsState.localExec.mode) || 'all_files_approval';
  const radios = container.querySelectorAll('input[name="localexec-mode"]');
  radios.forEach((r) => { r.checked = (r.value === mode); });
  if (!container.dataset.bound) {
    radios.forEach((radio) => {
      radio.addEventListener('change', async () => {
        if (!radio.checked) return;
        _settingsState.localExecToggleEpoch += 1;
        const startedAt = Date.now();
        const next = radio.value;
        const prev = (_settingsState.localExec && _settingsState.localExec.mode) || 'all_files_approval';
        try {
          const res = await window.orkas.invoke('permissions.setLocalExecMode', { mode: next });
          const returnedMode = res && _LOCALEXEC_MODES.includes(res.mode) ? res.mode : '';
          if (res && res.ok && returnedMode === next) {
            _settingsState.localExec = { mode: res.mode };
            _settingsRenderLocalExec();
          } else {
            const actual = res && res.ok && returnedMode ? returnedMode : prev;
            _settingsState.localExec = { mode: actual };
            _settingsRenderLocalExec();
            _settingsTrackOperationResult(
              'localexec_mode_change_result', startedAt, 'failure',
              { target_mode: next, actual_mode: actual },
              res && res.ok ? 'update_mismatch' : 'update_rejected',
            );
          }
        } catch (err) {
          _settingsState.localExec = { mode: prev };
          _settingsRenderLocalExec();
          _settingsTrackOperationResult(
            'localexec_mode_change_result', startedAt, 'failure',
            { target_mode: next, actual_mode: prev }, 'invoke_failed', 'ipc',
          );
          _settingsLog.warn('local exec mode set failed', {
            error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
          });
        }
      });
    });
    container.dataset.bound = '1';
  }
}

// ── Metacognition (agent self-evolution) ──
// Stored at preferences.json::metacognition_enabled. The env var
// `ORKAS_METACOGNITION='0'` is still a higher-priority kill switch
// (surfaced as `envForcedOff`); when active, the UI greys out the
// toggle and shows an explanatory hint.

async function _settingsRefreshMetacognition(options = {}) {
  const epoch = _settingsState.metacognitionToggleEpoch;
  const hasFailureFallback = typeof options.failureFallbackEnabled === 'boolean';
  try {
    const res = await window.orkas.invoke('prefs.getMetacognition');
    const refreshed = (res && res.ok)
      ? { enabled: !!res.enabled, envForcedOff: !!res.envForcedOff }
      : {
          enabled: hasFailureFallback ? options.failureFallbackEnabled : true,
          envForcedOff: false,
        };
    if (epoch !== _settingsState.metacognitionToggleEpoch) {
      if (!res || !res.ok) return;
      // A newer user preference supersedes only the stale enabled value. The
      // environment kill switch is an independent, authoritative capability
      // gate and must still reach the UI.
      _settingsState.metacognition = {
        ...(_settingsState.metacognition || { enabled: true }),
        envForcedOff: refreshed.envForcedOff,
      };
      // Rendering a forced-off result immediately is required for correctness.
      // A false result can wait for the pending write, keeping the control
      // disabled until that write settles.
      if (refreshed.envForcedOff) _settingsRenderMetacognition();
      return !!(res && res.ok);
    }
    _settingsState.metacognition = refreshed;
    // This read is independent of the other settings requests. Render it as
    // soon as it resolves instead of leaving the toggle stale until the
    // slowest request in loadSettings() finishes.
    _settingsRenderMetacognition();
    return !!(res && res.ok);
  } catch (_) {
    if (epoch !== _settingsState.metacognitionToggleEpoch) return false;
    _settingsState.metacognition = {
      enabled: hasFailureFallback ? options.failureFallbackEnabled : true,
      envForcedOff: false,
    };
    _settingsRenderMetacognition();
    return false;
  }
}

function _settingsBindMetacognitionOnce() {
  const cb = document.getElementById('settings-metacognition-toggle');
  if (!cb || cb.dataset.bound) return;
  cb.addEventListener('change', async () => {
    if (cb.disabled) return;
    const epoch = ++_settingsState.metacognitionToggleEpoch;
    const startedAt = Date.now();
    const next = !!cb.checked;
    const previous = !!(_settingsState.metacognition && _settingsState.metacognition.enabled);
    _settingsState.metacognition = {
      envForcedOff: false,
      ...(_settingsState.metacognition || {}),
      enabled: next,
    };
    cb.disabled = true;
    try {
      const res = await window.orkas.invoke('prefs.setMetacognition', { enabled: next });
      if (epoch !== _settingsState.metacognitionToggleEpoch) return;
      if (res && res.ok) {
        _settingsState.metacognition = { ..._settingsState.metacognition, enabled: !!res.enabled };
        _settingsTrackEvent('metacognition_toggle_result', {
          result: 'success',
          enabled: !!res.enabled,
          target_enabled: next,
          duration_ms: Math.max(0, Date.now() - startedAt),
        });
      } else {
        // The initial preference read may have been in flight when the user
        // clicked. Its enabled value is intentionally ignored after the epoch
        // changes, so a rejected write must fetch the persisted truth again
        // instead of rolling back to a possibly uninitialized placeholder.
        await _settingsRefreshMetacognition({ failureFallbackEnabled: previous });
        const actualEnabled = !!(_settingsState.metacognition && _settingsState.metacognition.enabled);
        _settingsLog.warn('setMetacognition rejected', { error_code: 'update_rejected' });
        _settingsTrackEvent('metacognition_toggle_result', {
          result: 'failure',
          enabled: actualEnabled,
          target_enabled: next,
          duration_ms: Math.max(0, Date.now() - startedAt),
          error_type: 'operation',
          error_code: 'update_rejected',
        });
      }
    } catch (err) {
      if (epoch !== _settingsState.metacognitionToggleEpoch) return;
      await _settingsRefreshMetacognition({ failureFallbackEnabled: previous });
      const actualEnabled = !!(_settingsState.metacognition && _settingsState.metacognition.enabled);
      _settingsLog.warn('setMetacognition failed', {
        error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
      });
      _settingsTrackEvent('metacognition_toggle_result', {
        result: 'failure',
        enabled: actualEnabled,
        target_enabled: next,
        duration_ms: Math.max(0, Date.now() - startedAt),
        error_type: 'ipc',
        error_code: 'invoke_failed',
      });
    } finally {
      if (epoch === _settingsState.metacognitionToggleEpoch) {
        _settingsRenderMetacognition();
      }
    }
  });
  cb.dataset.bound = '1';
}

function _settingsRenderMetacognition() {
  const cb = document.getElementById('settings-metacognition-toggle');
  const status = document.getElementById('settings-metacognition-status');
  if (!cb) return;
  const s = _settingsState.metacognition || { enabled: true, envForcedOff: false };
  cb.checked = s.envForcedOff ? false : !!s.enabled;
  cb.disabled = !!s.envForcedOff;
  if (status) {
    status.textContent = s.envForcedOff ? t('settings.metacognition.env_forced_off') : '';
  }
  if (!cb.dataset.bound) {
    cb.addEventListener('change', async () => {
      if (cb.disabled) return;
      const next = !!cb.checked;
      try {
        const res = await window.orkas.invoke('prefs.setMetacognition', { enabled: next });
        if (res && res.ok) {
          _settingsState.metacognition = { ..._settingsState.metacognition, enabled: !!res.enabled };
        } else {
          // Roll back the UI on write failure.
          cb.checked = !next;
          _settingsLog.warn('setMetacognition rejected', res);
          _settingsTrackEvent('metacognition_toggle_result', { result: 'failure', enabled: !next });
          _settingsTrackError('metacognition_toggle', {
            error_type: 'operation',
            error_message: 'metacognition_toggle_rejected',
          });
        }
      } catch (err) {
        cb.checked = !next;
        _settingsLog.warn('setMetacognition failed', err);
        _settingsTrackEvent('metacognition_toggle_result', { result: 'failure', enabled: !next });
        _settingsTrackError('metacognition_toggle', {
          error_type: 'operation',
          error_message: 'metacognition_toggle_failed',
        });
      }
    });
    cb.dataset.bound = '1';
  }
}

// ── Data root row ──
// Read-only display of the unified data root path; click to open it in
// the OS file manager via the `app.openDataRoot` IPC.

async function _settingsRefreshDataRoot() {
  try {
    const res = await window.orkas.invoke('app.dataRootPath');
    _settingsState.dataRoot = (res && res.ok && res.path) ? String(res.path) : '';
  } catch (_) {
    _settingsState.dataRoot = '';
  }
}

function _settingsRenderDataRoot() {
  const btn = document.getElementById('settings-data-root-btn');
  const span = document.getElementById('settings-data-root-path');
  if (!btn || !span) return;
  span.textContent = _settingsState.dataRoot || '';
  if (!btn.dataset.bound) {
    btn.addEventListener('click', async () => {
      const startedAt = Date.now();
      let res;
      try {
        await window.orkas.invoke('app.openDataRoot');
      } catch (err) {
        _settingsLog.warn('open data root failed', {
          error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
        });
        _settingsTrackEvent('settings_open_data_root_result', {
          result: 'failure',
          duration_ms: Math.max(0, Date.now() - startedAt),
          error_type: 'ipc',
          error_code: 'invoke_failed',
        });
        return;
      }
      if (!res || res.ok === false) {
        _settingsLog.warn('open data root rejected', { error_code: 'open_rejected' });
        _settingsTrackEvent('settings_open_data_root_result', {
          result: 'failure',
          duration_ms: Math.max(0, Date.now() - startedAt),
          error_type: 'operation',
          error_code: 'open_rejected',
        });
        return;
      }
      _settingsTrackEvent('settings_open_data_root_result', {
        result: 'success',
        duration_ms: Math.max(0, Date.now() - startedAt),
      });
    });
    btn.dataset.bound = '1';
  }
}

// ── Language dropdown ──
// Bound once on first panel open; `loadSettings` then calls _settingsSyncLanguageRadio()
// to re-sync the dropdown's current value with whatever setLang() last persisted.
// Option labels are each language's autonym (本族语自称), intentionally NOT routed
// through t() — a Chinese user picking "English" should see "English", not the
// translation of "English" in the current UI language.

let _settingsLanguageSel = null;   // _aiSelectMount api

const _SETTINGS_LANG_OPTIONS = [
  ...((typeof getSupportedLanguages === 'function')
    ? getSupportedLanguages().map((l) => ({ value: l.code, label: l.label }))
    : [
        { value: 'zh', label: '简体中文' },
        { value: 'en', label: 'English' },
        { value: 'ja', label: '日本語' },
      ]),
];

function _settingsBindLanguageOnce() {
  if (_settingsLanguageSel) return;
  const el = document.getElementById('settings-language-select');
  if (!el) return;
  _settingsLanguageSel = _aiSelectMount(el, {
    ariaLabel: t('settings.language.title'),
    options: _SETTINGS_LANG_OPTIONS,
    value: (typeof getLang === 'function') ? getLang() : 'en',
  });
  _settingsLanguageSel.onChange(async (next) => {
    if (typeof isSupportedLang === 'function' && !isSupportedLang(next)) return;
    try {
      await setLang(next);
      _settingsLog.info('language changed', { lang: next });
    } catch (err) {
      _settingsLog.warn('setLang failed', { error: (err && err.message) || String(err) });
    }
  });
}

function _settingsSyncLanguageRadio() {
  // Function name kept for caller-side compatibility; semantics is now "sync dropdown value".
  const cur = (typeof getLang === 'function') ? getLang() : 'en';
  if (_settingsLanguageSel) {
    _settingsLanguageSel.setValue(cur);
    _settingsLanguageSel.setAriaLabel(t('settings.language.title'));
  }
}

// Keep the radio in sync if some other code path changes language, and
// re-render sections whose text is written by JS (so their content
// isn't refreshed by applyDomI18n's data-i18n sweep).
window.addEventListener('i18n-change', () => {
  _settingsSyncLanguageRadio();
  _settingsRenderLocalExec();
  _settingsRenderPicker();
  _settingsRenderEntries();
  _settingsRenderSearchSection();
  _settingsRenderImageSection();
  _settingsRenderVideoSection();
  _settingsRenderMetacognition();
});

async function _settingsRefreshProviders() {
  const res = await window.orkas.invoke('auth.listProviders');
  _settingsState.providers = (res && res.ok && Array.isArray(res.providers)) ? res.providers : [];
}

async function _settingsRefreshEntries() {
  const res = await window.orkas.invoke('auth.listEntries', { includeUnavailable: true });
  _settingsState.entries = (res && res.ok && Array.isArray(res.entries)) ? res.entries : [];
  if (typeof trackModelConfigSnapshot === 'function') trackModelConfigSnapshot(_settingsState.entries);
}

async function _settingsGetModels(providerId) {
  if (!providerId) return [];
  if (_settingsState.modelsCache[providerId]) return _settingsState.modelsCache[providerId];
  const res = await window.orkas.invoke('auth.listModels', { provider: providerId });
  const list = (res && res.ok && Array.isArray(res.models)) ? res.models : [];
  _settingsState.modelsCache[providerId] = list;
  return list;
}

// ── Picker (provider + model + add button) ──

function _settingsProviderDisplayName(provider) {
  if (!provider) return '';
  return provider.labelKey ? t(provider.labelKey) : (provider.label || provider.id || '');
}

async function _settingsRenderPicker() {
  const providerEl = document.getElementById('settings-picker-provider');
  const modelEl    = document.getElementById('settings-picker-model');
  if (!providerEl || !modelEl) return;

  const providerOptions = _settingsState.providers.map((p) => {
    const baseLabel = _settingsProviderDisplayName(p);
    const label = p.recommended ? `${baseLabel} ${t('settings.picker.recommended_suffix')}` : baseLabel;
    let authHint = '';
    if (p.supportsOAuth && p.supportsApiKey)       authHint = t('settings.oauth.support_api_and_oauth');
    else if (p.supportsOAuth && !p.supportsApiKey) authHint = t('settings.oauth.support_oauth_only');
    else if (p.supportsApiKey)                     authHint = t('settings.oauth.support_api_only');
    // subscriptionNote is the "wrong-account → 401 wastes the key"
    // class of critical prerequisite, so it goes first; the auth
    // capability hint comes second. Join with ' · ' when both exist.
    // subscriptionNote is an i18n key (see the field comment in
    // provider_catalog.ts) — translated on render.
    const subNote = p.subscriptionNote ? t(p.subscriptionNote) : '';
    const hint = [subNote, authHint].filter(Boolean).join(' · ');
    return { value: p.id, label, hint };
  });

  const prevProvider = _settingsState.pickerProviderSel?.getValue()
    || providerEl.dataset.value
    || '';
  if (!_settingsState.pickerProviderSel || _settingsState.pickerProviderEl !== providerEl) {
    _settingsState.pickerProviderEl = providerEl;
    _settingsState.pickerProviderSel = _aiSelectMount(providerEl, {
      placeholder: t('settings.picker.select_provider'),
    });
    _settingsState.pickerProviderSel.onChange(async (val) => {
      await _settingsPopulatePickerModel(val, '');
      _settingsSetStatus('settings-picker-status', '', '');
    });
  }
  _settingsState.pickerProviderSel.setOptions(providerOptions, {
    value: prevProvider,
    placeholder: t('settings.picker.select_provider'),
  });

  const prevModel = _settingsState.pickerModelSel?.getValue()
    || modelEl.dataset.value
    || '';
  if (!_settingsState.pickerModelSel || _settingsState.pickerModelEl !== modelEl) {
    _settingsState.pickerModelEl = modelEl;
    _settingsState.pickerModelSel = _aiSelectMount(modelEl, {
      placeholder: t('settings.picker.pick_provider_first'),
    });
    _settingsState.pickerModelSel.onChange((val) => {
      _settingsSetStatus('settings-picker-status', '', '');
    });
  }
  await _settingsPopulatePickerModel(
    _settingsState.pickerProviderSel.getValue(),
    prevModel,
  );

  const addBtn = document.getElementById('settings-add-entry-btn');
  if (addBtn && _settingsState.addBtnEl !== addBtn) {
    _settingsState.addBtnEl = addBtn;
    addBtn.addEventListener('click', _settingsClickAddEntry);
  }
}

async function _settingsPopulatePickerModel(providerId, selected) {
  const sel = _settingsState.pickerModelSel;
  if (!sel) return;
  const provider = _settingsState.providers.find((p) => p.id === providerId);
  const modelRow = document.getElementById('settings-picker-model-row');
  const isCustom = !!provider?.customOpenAICompatible;
  if (modelRow) modelRow.hidden = isCustom;
  if (isCustom) {
    sel.setOptions([], {
      value: '',
      placeholder: t('settings.picker.custom_config_in_dialog'),
    });
    return;
  }
  const models = await _settingsGetModels(providerId);
  // Provider changes can overlap network requests. Ignore a late response
  // from the previously selected provider instead of rendering a model list
  // that the main-process catalog will reject for the current provider.
  if ((_settingsState.pickerProviderSel?.getValue() || '') !== providerId) return;
  const options = models.map((m) => ({ value: m.id, label: m.name || m.id }));
  if (providerId === 'openrouter') {
    options.unshift({
      value: _OPENROUTER_CUSTOM_MODEL_VALUE,
      label: t('settings.picker.openrouter_custom_model'),
      hint: t('settings.picker.openrouter_custom_hint'),
    });
  }
  sel.setOptions(
    options,
    { value: selected || '', placeholder: providerId ? t('settings.picker.select_model') : t('settings.picker.pick_provider_first') },
  );
}

async function _settingsClickAddEntry() {
  const providerId = _settingsState.pickerProviderSel?.getValue() || '';
  if (!providerId) { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_provider_needed')); return; }

  const provider = _settingsState.providers.find((p) => p.id === providerId);
  if (!provider) { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_provider_missing')); return; }
  if (provider.customOpenAICompatible) {
    _settingsSetStatus('settings-picker-status', '', '');
    _settingsShowCustomModelForm(provider);
    return;
  }

  const modelId = _settingsState.pickerModelSel?.getValue() || '';
  if (!modelId) { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_model_needed')); return; }

  _settingsSetStatus('settings-picker-status', '', '');
  _settingsChooseAccountMethod(provider, modelId);
}

// ── Method chooser + credential forms ──

function _settingsChooseAccountMethod(provider, modelId) {
  if (_settingsIsOpenRouterCustomModel(provider.id, modelId)) {
    _settingsShowApiKeyForm(provider, modelId);
    return;
  }

  const hasApi   = !!provider.supportsApiKey;
  const hasOAuth = !!provider.supportsOAuth;

  if (hasApi && hasOAuth) {
    // Present the two-tile chooser first.
    const overlay = document.getElementById('add-account-modal');
    const title   = document.getElementById('add-account-title');
    const body    = document.getElementById('add-account-body');
    const actions = document.getElementById('add-account-actions');
    if (!overlay || !title || !body || !actions) return;

    title.textContent = t('settings.modal.add_account_title_with_provider', { provider: provider.label || provider.id });
    body.innerHTML = `
      <div class="method-chooser">
        <div class="method-tile" data-method="api_key">
          <div class="method-title">${escapeHtml(t('settings.modal.method_api_title'))}</div>
          <div class="method-hint">${escapeHtml(t('settings.modal.method_api_hint'))}</div>
        </div>
        <div class="method-tile" data-method="oauth">
          <div class="method-title">${escapeHtml(t('settings.modal.method_oauth_title'))}</div>
          <div class="method-hint">${escapeHtml(t('settings.modal.method_oauth_hint'))}</div>
        </div>
      </div>
    `;
    actions.innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn';
    cancelBtn.textContent = t('common.cancel');
    cancelBtn.onclick = () => _settingsCloseModal(overlay);
    actions.appendChild(cancelBtn);

    body.querySelector('.method-chooser').addEventListener('click', (e) => {
      const tile = e.target.closest('.method-tile');
      if (!tile) return;
      const method = tile.dataset.method;
      _settingsCloseModal(overlay);
      if (method === 'api_key') _settingsShowApiKeyForm(provider, modelId);
      else _settingsStartOAuthFlow(provider, modelId);
    });

    _settingsOpenModal(overlay);
    return;
  }

  if (hasOAuth && !hasApi) { _settingsStartOAuthFlow(provider, modelId); return; }
  _settingsShowApiKeyForm(provider, modelId);
}

function _settingsShowApiKeyForm(provider, modelId) {
  const overlay = document.getElementById('add-account-modal');
  const title   = document.getElementById('add-account-title');
  const body    = document.getElementById('add-account-body');
  const actions = document.getElementById('add-account-actions');
  if (!overlay || !title || !body || !actions) return;

  title.textContent = t('settings.modal.api_key_form_title', { provider: provider.label || provider.id });
  // docs_prefix has `{url}` which we fill with a marked-up span; escape the
  // surrounding text but keep the span as raw HTML.
  const docsUrlMarkup = `<span class="form-hint-url">${escapeHtml(provider.docsUrl || '')}</span>`;
  const docsRaw = t('settings.modal.docs_prefix', { url: '\u0001URL\u0001' });
  const docsHtml = provider.docsUrl
    ? `<div class="form-hint">${escapeHtml(docsRaw).replace(escapeHtml('\u0001URL\u0001'), docsUrlMarkup)}</div>`
    : '';
  const subNoteHtml = provider.subscriptionNote
    ? `<div class="form-hint form-hint-warn">${escapeHtml(t(provider.subscriptionNote))}</div>`
    : '';
  const enterOpenRouterModel = _settingsIsOpenRouterCustomModel(provider.id, modelId);
  const openRouterModelHtml = enterOpenRouterModel
    ? `<div class="form-row">
      <label>${escapeHtml(t('settings.custom.model_id'))}</label>
      <input type="text" class="openrouter-model-input form-input" placeholder="x-ai/grok-4.20" autocomplete="off" spellcheck="false" />
      <div class="form-hint">${escapeHtml(t('settings.picker.openrouter_custom_hint'))}</div>
    </div>`
    : '';
  body.innerHTML = `
    ${subNoteHtml}
    ${openRouterModelHtml}
    <div class="form-row">
      <label>${escapeHtml(t('settings.modal.label'))}</label>
      <input type="text" class="api-label-input form-input" placeholder="${escapeHtml(t('settings.modal.label_placeholder'))}" autocomplete="off" spellcheck="false" />
    </div>
    <div class="form-row">
      <label>API Key</label>
      <input type="password" class="api-key-input form-input" placeholder="sk-…" autocomplete="new-password" spellcheck="false" />
    </div>
    ${docsHtml}
    <div class="form-msg"></div>
  `;
  actions.innerHTML = '';

  const modelInput = body.querySelector('.openrouter-model-input');
  const labelInput = body.querySelector('.api-label-input');
  const keyInput   = body.querySelector('.api-key-input');
  const msg        = body.querySelector('.form-msg');

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.onclick = () => _settingsCloseModal(overlay);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = t('settings.save');
  const save = async () => {
    const startedAt = Date.now();
    const resolvedModelId = _settingsResolveApiKeyModelId(provider.id, modelId, modelInput?.value);
    const label  = (labelInput.value || '').trim();
    const apiKey = (keyInput.value || '').trim();
    if (!resolvedModelId) {
      msg.textContent = t('settings.custom.error_model');
      msg.className = 'form-msg error';
      _settingsTrackModelConfigResult(startedAt, 'add', 'api_key', 'blocked', 'model_required');
      modelInput?.focus();
      return;
    }
    if (!apiKey) {
      msg.textContent = t('settings.paste_key_first');
      msg.className = 'form-msg error';
      _settingsTrackModelConfigResult(startedAt, 'add', 'api_key', 'blocked', 'api_key_required');
      return;
    }
    saveBtn.disabled = true;
    msg.textContent = t('settings.save_loading'); msg.className = 'form-msg';
    _settingsLog.info('add api key', { provider: provider.id, model: resolvedModelId, has_label: !!label });
    let addRes = null;
    try {
      addRes = await window.orkas.invoke('auth.addApiKeyEntry', {
        provider: provider.id,
        model: resolvedModelId,
        apiKey,
        label: label || undefined,
      });
    } catch (_) {
      addRes = { ok: false, code: 'invoke_failed' };
    }
    if (!addRes || !addRes.ok) {
      saveBtn.disabled = false;
      msg.textContent = (addRes && addRes.error) || t('settings.save_failed');
      msg.className = 'form-msg error';
      _settingsLog.warn('add api key failed', { provider: provider.id, error: addRes && addRes.error });
      return;
    }
    _settingsTrackModelConfigResult(startedAt, 'add', 'api_key', 'success');
    saveBtn.disabled = false;
    _settingsCloseModal(overlay);
    await _settingsReload();
  };
  saveBtn.onclick = save;
  // IME guard (CLAUDE.md §8): Enter on these inputs advances focus / saves;
  // skip while a Chinese / Japanese / Korean candidate is being composed.
  modelInput?.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { labelInput.focus(); e.preventDefault(); }
  });
  labelInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { keyInput.focus(); e.preventDefault(); }
  });
  keyInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { save(); e.preventDefault(); }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  _settingsOpenModal(overlay);
  setTimeout(() => (modelInput || labelInput).focus(), 0);
}

function _settingsCustomModelError(code, fallback) {
  const key = ({
    CUSTOM_BASE_URL_REQUIRED: 'settings.custom.error_base_url',
    CUSTOM_BASE_URL_INVALID: 'settings.custom.error_base_url_invalid',
    CUSTOM_MODEL_REQUIRED: 'settings.custom.error_model',
    CUSTOM_API_KEY_REQUIRED: 'settings.custom.error_api_key',
    CUSTOM_TOKEN_LIMIT_INVALID: 'settings.custom.error_token_limits',
  })[String(code || '')];
  return key ? t(key) : (fallback || t('settings.save_failed'));
}

function _settingsModelConfigValidationCode(code) {
  return ({
    CUSTOM_BASE_URL_REQUIRED: 'base_url_required',
    CUSTOM_BASE_URL_INVALID: 'base_url_invalid',
    CUSTOM_MODEL_REQUIRED: 'model_required',
    CUSTOM_API_KEY_REQUIRED: 'api_key_required',
    CUSTOM_TOKEN_LIMIT_INVALID: 'token_limit_invalid',
  })[String(code || '')] || 'validation_failed';
}

function _settingsValidateCustomBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'CUSTOM_BASE_URL_REQUIRED';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return 'CUSTOM_BASE_URL_INVALID';
    if (url.username || url.password || url.search || url.hash) return 'CUSTOM_BASE_URL_INVALID';
  } catch (_) {
    return 'CUSTOM_BASE_URL_INVALID';
  }
  return '';
}

function _settingsNormalizeCustomBaseUrl(value) {
  const raw = String(value || '').trim();
  try {
    const url = new URL(raw);
    const chatPathIndex = url.pathname.search(/\/chat(?:\/|$)/i);
    if (chatPathIndex >= 0) {
      url.pathname = url.pathname.slice(0, chatPathIndex).replace(/\/+$/, '') || '/';
    }
    return url.toString().replace(/\/+$/, '');
  } catch (_) {
    return raw;
  }
}

function _settingsBuildCustomModelPayload(values) {
  const maxTokens = String(values.maxTokens ?? '').trim();
  return {
    label: String(values.label || '').trim(),
    baseUrl: _settingsNormalizeCustomBaseUrl(values.baseUrl),
    model: String(values.model || '').trim(),
    apiKey: String(values.apiKey || '').trim(),
    ...(maxTokens ? { maxTokens } : {}),
  };
}

function _settingsShowCustomModelForm(provider) {
  const overlay = document.getElementById('add-account-modal');
  const title = document.getElementById('add-account-title');
  const body = document.getElementById('add-account-body');
  const actions = document.getElementById('add-account-actions');
  if (!overlay || !title || !body || !actions) return;

  title.innerHTML = `
    <span class="modal-title-text">${escapeHtml(t('settings.custom.title'))}</span>
    <span class="form-hint custom-model-intro">${escapeHtml(t('settings.custom.compat_hint'))}</span>
  `;
  body.innerHTML = `
    <div class="form-row">
      <label>${escapeHtml(t('settings.custom.label'))}</label>
      <input type="text" class="custom-label-input form-input" placeholder="${escapeHtml(t('settings.custom.label_placeholder'))}" autocomplete="off" spellcheck="false" />
    </div>
    <div class="form-row">
      <label>${escapeHtml(t('settings.custom.base_url'))}</label>
      <input type="text" class="custom-base-url-input form-input" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false" />
    </div>
    <div class="form-row">
      <label>${escapeHtml(t('settings.custom.model_id'))}</label>
      <input type="text" class="custom-model-input form-input" placeholder="${escapeHtml(t('settings.custom.model_placeholder'))}" autocomplete="off" spellcheck="false" />
    </div>
    <div class="form-row custom-model-advanced">
      <label>${escapeHtml(t('settings.custom.max_tokens'))}</label>
      <input type="number" class="custom-max-tokens-input form-input" min="1" max="16777216" step="1" placeholder="32768" inputmode="numeric" />
      <div class="form-hint">${escapeHtml(t('settings.custom.max_tokens_hint'))}</div>
    </div>
    <div class="form-row">
      <label>API Key</label>
      <input type="password" class="custom-key-input form-input" placeholder="sk-…" autocomplete="new-password" spellcheck="false" />
    </div>
    <div class="form-msg"></div>
  `;
  actions.innerHTML = '';

  const labelInput = body.querySelector('.custom-label-input');
  const baseUrlInput = body.querySelector('.custom-base-url-input');
  const modelInput = body.querySelector('.custom-model-input');
  const maxTokensInput = body.querySelector('.custom-max-tokens-input');
  const keyInput = body.querySelector('.custom-key-input');
  const msg = body.querySelector('.form-msg');

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.textContent = t('common.cancel');
  cancelBtn.onclick = () => _settingsCloseModal(overlay);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn btn-primary';
  saveBtn.textContent = t('settings.save');
  const save = async () => {
    const startedAt = Date.now();
    const payload = _settingsBuildCustomModelPayload({
      label: labelInput.value,
      baseUrl: baseUrlInput.value,
      model: modelInput.value,
      maxTokens: maxTokensInput.value,
      apiKey: keyInput.value,
    });
    const { label, baseUrl, model, apiKey } = payload;
    let errorCode = _settingsValidateCustomBaseUrl(baseUrl);
    if (!errorCode && !model) errorCode = 'CUSTOM_MODEL_REQUIRED';
    if (!errorCode && !apiKey) errorCode = 'CUSTOM_API_KEY_REQUIRED';
    if (errorCode) {
      msg.textContent = _settingsCustomModelError(errorCode);
      msg.className = 'form-msg error';
      _settingsTrackModelConfigResult(
        startedAt,
        'add',
        'custom',
        'blocked',
        _settingsModelConfigValidationCode(errorCode),
      );
      return;
    }

    saveBtn.disabled = true;
    msg.textContent = t('settings.save_loading');
    msg.className = 'form-msg';
    _settingsLog.info('add custom model', { provider: provider.id, model, has_label: !!label });
    let addRes = null;
    try {
      addRes = await window.orkas.invoke('auth.addCustomModelEntry', payload);
    } catch (_) {
      addRes = { ok: false, code: 'invoke_failed' };
    }
    if (!addRes || !addRes.ok) {
      saveBtn.disabled = false;
      msg.textContent = _settingsCustomModelError(addRes && addRes.code, addRes && addRes.error);
      msg.className = 'form-msg error';
      _settingsLog.warn('add custom model failed', {
        provider: provider.id,
        model,
        error_code: addRes && addRes.code,
      });
      _settingsTrackModelConfigResult(
        startedAt,
        'add',
        'custom',
        'failure',
        _settingsResultErrorCode(addRes),
      );
      return;
    }
    _settingsTrackModelConfigResult(startedAt, 'add', 'custom', 'success');
    saveBtn.disabled = false;
    _settingsCloseModal(overlay);
    await _settingsReload();
  };
  saveBtn.onclick = save;

  const focusNextOnEnter = (input, next) => {
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { next.focus(); e.preventDefault(); }
    });
  };
  focusNextOnEnter(labelInput, baseUrlInput);
  focusNextOnEnter(baseUrlInput, modelInput);
  focusNextOnEnter(modelInput, maxTokensInput);
  focusNextOnEnter(maxTokensInput, keyInput);
  keyInput.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { save(); e.preventDefault(); }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  _settingsOpenModal(overlay);
  setTimeout(() => labelInput.focus(), 0);
}

function _settingsOpenModal(overlay) {
  overlay.classList.add('open');
  const onKey = (e) => { if (e.key === 'Escape') _settingsCloseModal(overlay, onKey); };
  overlay._onKey = onKey;
  document.addEventListener('keydown', onKey, true);
}

function _settingsCloseModal(overlay) {
  overlay.classList.remove('open');
  if (overlay._onKey) {
    document.removeEventListener('keydown', overlay._onKey, true);
    delete overlay._onKey;
  }
}

// ── OAuth flow modal ──

let _oauthFlowPollTimer = null;
let _oauthFlowId        = null;
let _oauthFlowTarget    = null; // { provider, modelId }
let _oauthFlowTelemetry = null;

function _settingsFinishOAuthTelemetry(result, errorCode = '') {
  if (!_oauthFlowTelemetry || _oauthFlowTelemetry.done) return;
  const startedAt = _oauthFlowTelemetry.startedAt;
  _oauthFlowTelemetry.done = true;
  _settingsTrackModelConfigResult(startedAt, 'add', 'oauth', result, errorCode);
}

async function _settingsStartOAuthFlow(provider, modelId) {
  const overlay   = document.getElementById('oauth-flow-modal');
  const title     = document.getElementById('oauth-flow-title');
  const body      = document.getElementById('oauth-flow-body');
  const closeBtn  = document.getElementById('oauth-flow-close-btn');
  if (!overlay || !title || !body || !closeBtn) return;

  // OAuth back-end may be different from the user-picked provider (e.g.
  // openai → openai-codex). `oauthProvider` is the id we actually log into.
  const oauthProviderId = provider.oauthProvider || provider.id;
  const aliased = oauthProviderId !== provider.id;

  _oauthFlowTarget = { provider, modelId, oauthProviderId };
  _oauthFlowTelemetry = { startedAt: Date.now(), done: false };
  title.textContent = t('settings.oauth.title_prefix', { provider: provider.label || provider.id });
  const aliasTip = aliased
    ? `<div class="oauth-flow-hint">${escapeHtml(t('settings.oauth.alias_tip', { provider: oauthProviderId }))}</div>`
    : '';
  body.innerHTML = `<div class="oauth-flow-stage">${escapeHtml(t('settings.oauth.starting'))}</div>${aliasTip}`;
  overlay.classList.add('open');

  const closeFlow = () => {
    _settingsFinishOAuthTelemetry('cancelled', 'cancelled');
    if (_oauthFlowPollTimer) { clearInterval(_oauthFlowPollTimer); _oauthFlowPollTimer = null; }
    if (_oauthFlowId) {
      window.orkas.invoke('auth.cancelOAuthFlow', { flowId: _oauthFlowId }).catch(() => {});
    }
    _oauthFlowId = null;
    _oauthFlowTarget = null;
    _oauthFlowTelemetry = null;
    overlay.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') closeFlow(); };
  closeBtn.onclick = closeFlow;
  document.addEventListener('keydown', onKey, true);

  _settingsLog.info('oauth start', { provider: oauthProviderId });
  const startRes = await window.orkas.invoke('auth.startOAuth', { provider: oauthProviderId });
  if (!startRes || !startRes.ok) {
    body.innerHTML = `<div class="oauth-flow-stage error">${escapeHtml((startRes && startRes.error) || t('settings.oauth.start_failed'))}</div>`;
    _settingsLog.warn('oauth start failed', { provider: oauthProviderId, error: startRes && startRes.error });
    return;
  }
  _oauthFlowId = startRes.flowId;

  let lastKind = '';
  _oauthFlowPollTimer = setInterval(async () => {
    if (!_oauthFlowId) return;
    const res = await window.orkas.invoke('auth.pollOAuthFlow', { flowId: _oauthFlowId });
    if (!res || !res.ok) return;
    const status = res.status || {};
    if (status.kind === lastKind && status.kind !== 'done' && status.kind !== 'error') return;
    lastKind = status.kind;
    _oauthFlowRender(provider, status, closeFlow);
  }, 400);
}

function _oauthFlowRender(provider, status, closeFlow) {
  const body = document.getElementById('oauth-flow-body');
  if (!body) return;

  if (status.kind === 'starting' || status.kind === 'progress') {
    body.innerHTML = `<div class="oauth-flow-stage">${escapeHtml(status.message || t('settings.oauth.processing'))}</div>`;
    return;
  }

  if (status.kind === 'awaiting_auth') {
    const url = status.url || '';
    const instructions = status.instructions || '';
    // Device-code flows (e.g. MiniMax) don't run a local callback server,
    // so the "paste callback URL" box doesn't apply — the user_code in
    // instructions is what carries the flow forward.
    const usesCallbackServer = status.usesCallbackServer !== false;
    const topHint = usesCallbackServer
      ? t('settings.oauth.top_hint_browser')
      : t('settings.oauth.top_hint_page');
    const subHint = usesCallbackServer
      ? t('settings.oauth.sub_hint_callback')
      : t('settings.oauth.sub_hint_devicecode');
    body.innerHTML = `
      <div class="oauth-flow-stage">${escapeHtml(topHint)}</div>
      <div class="oauth-flow-hint">${escapeHtml(subHint)}</div>
      <div class="oauth-flow-actions">
        <button class="btn oauth-open-btn">${escapeHtml(t('settings.oauth.reopen'))}</button>
        <button class="btn oauth-copy-btn">${escapeHtml(t('settings.oauth.copy_link'))}</button>
      </div>
      ${(!usesCallbackServer && instructions) ? `<div class="oauth-flow-tip oauth-flow-tip-multiline">${escapeHtml(instructions)}</div>` : ''}
      ${usesCallbackServer ? `
      <div class="oauth-manual-row">
        <input type="text" class="oauth-manual-input form-input" placeholder="${escapeHtml(t('settings.oauth.manual_placeholder'))}" autocomplete="off" spellcheck="false" />
        <button class="btn oauth-manual-submit-btn">${escapeHtml(t('settings.oauth.submit'))}</button>
      </div>` : ''}
    `;
    body.querySelector('.oauth-open-btn').onclick = () => {
      window.orkas.invoke('auth.openExternal', { url }).catch(() => {});
    };
    body.querySelector('.oauth-copy-btn').onclick = async () => {
      try { await navigator.clipboard.writeText(url); } catch (_) {}
    };
    if (usesCallbackServer) {
      const input = body.querySelector('.oauth-manual-input');
      const submit = async () => {
        const val = (input.value || '').trim();
        if (!val) return;
        body.innerHTML = `<div class="oauth-flow-stage">${escapeHtml(t('settings.oauth.submitting'))}</div>`;
        await window.orkas.invoke('auth.submitOAuthInput', { flowId: _oauthFlowId, value: val });
      };
      body.querySelector('.oauth-manual-submit-btn').onclick = submit;
      input.addEventListener('keydown', (e) => {
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter') { submit(); e.preventDefault(); }
      });
    }
    return;
  }

  if (status.kind === 'awaiting_input') {
    const prompt = status.prompt || {};
    const msg = prompt.message || t('settings.oauth.enter_prompt_fallback');
    const placeholder = prompt.placeholder || '';
    body.innerHTML = `
      <div class="oauth-flow-stage">${escapeHtml(msg)}</div>
      <div class="form-row">
        <input type="text" class="oauth-input form-input" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false" />
      </div>
      <div class="oauth-flow-actions">
        <button class="btn btn-primary oauth-submit-btn">${escapeHtml(t('settings.oauth.submit'))}</button>
      </div>
    `;
    const input = body.querySelector('.oauth-input');
    const submit = async () => {
      const val = input.value || '';
      if (!val && !prompt.allowEmpty) return;
      body.innerHTML = `<div class="oauth-flow-stage">${escapeHtml(t('settings.oauth.submitting'))}</div>`;
      await window.orkas.invoke('auth.submitOAuthInput', { flowId: _oauthFlowId, value: val });
    };
    body.querySelector('.oauth-submit-btn').onclick = submit;
    input.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { submit(); e.preventDefault(); }
    });
    setTimeout(() => input.focus(), 0);
    return;
  }

  if (status.kind === 'done') {
    const target = _oauthFlowTarget;
    const profileId = status.profileId || '';
    body.innerHTML = `<div class="oauth-flow-stage ok">${escapeHtml(t('settings.oauth.success_writing'))}</div>`;
    if (_oauthFlowPollTimer) { clearInterval(_oauthFlowPollTimer); _oauthFlowPollTimer = null; }
    (async () => {
      const removeNewCredential = async () => {
        if (!profileId) return;
        await window.orkas.invoke('auth.removeCredential', { profileId }).catch(() => {});
      };
      const failEntrySave = async (errorCode, message, logContext = {}) => {
        await removeNewCredential();
        body.innerHTML = `<div class="oauth-flow-stage error">${escapeHtml(message || t('settings.add_entry_failed'))}</div>`;
        _settingsLog.warn('oauth entry save failed', {
          error_code: errorCode,
          ...logContext,
        });
        _settingsFinishOAuthTelemetry('failure', errorCode);
      };

      if (!target || !target.modelId || !profileId) {
        await failEntrySave('entry_context_missing', t('settings.add_entry_failed'));
        return;
      }

      try {
        // profileId is namespaced with the OAuth back-end provider (e.g.
        // `openai-codex:default`), so the entry must use the same provider
        // or addEntry will reject it as a cross-provider mismatch.
        const entryProvider = target.oauthProviderId || target.provider.id;
        // The user picked a model from the user-facing provider (e.g.
        // `openai`), but OAuth's back-end (e.g. `openai-codex`) may expose
        // a different model list. Remap to a supported model if needed, or
        // the chat-time call will throw "model not found".
        let model = target.modelId;
        if (entryProvider !== target.provider.id) {
          const modelsRes = await window.orkas.invoke('auth.listModels', { provider: entryProvider });
          const supported = (modelsRes && modelsRes.ok && Array.isArray(modelsRes.models)) ? modelsRes.models : [];
          const hit = supported.find(m => m.id === model);
          if (!hit && supported.length) model = supported[0].id;
        }
        const entryRes = await window.orkas.invoke('auth.addEntry', {
          provider: entryProvider,
          model,
          profileId,
        });
        if (!entryRes || !entryRes.ok) {
          // The OAuth profile was created specifically for this flow. If its
          // model entry cannot be committed, remove it again so a catalog
          // race or write failure cannot look successful or leave hidden
          // credential-only state.
          const message = (entryRes && entryRes.error) || t('settings.add_entry_failed');
          await failEntrySave(_settingsResultErrorCode(entryRes, 'entry_save_failed'), message, {
            provider: entryProvider,
            model,
          });
          return;
        }
      } catch (err) {
        await failEntrySave('invoke_failed', t('settings.add_entry_failed'), {
          error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
        });
        return;
      }
      _settingsFinishOAuthTelemetry('success');
      closeFlow();
      await _settingsReload();
    })();
    return;
  }

  if (status.kind === 'error') {
    body.innerHTML = `<div class="oauth-flow-stage error">${escapeHtml(status.error || t('settings.oauth.auth_failed'))}</div>`;
    if (_oauthFlowPollTimer) { clearInterval(_oauthFlowPollTimer); _oauthFlowPollTimer = null; }
    _settingsFinishOAuthTelemetry('failure', 'oauth_failed');
    return;
  }
}

// ── Entries list (priority, drag-reorderable) ──

function _settingsRenderEntries() {
  const container = document.getElementById('settings-entries');
  if (!container) return;
  container.innerHTML = '';

  if (!_settingsState.entries.length) {
    container.innerHTML = `<div class="settings-empty" data-i18n="settings.entries.empty">${escapeHtml(t('settings.entries.empty'))}</div>`;
    return;
  }

  const displayedEntries = _settingsState.entries.filter((entry) => (
    entry && entry.official !== true && entry.profileType !== 'managed'
  ));
  displayedEntries.forEach((entry, idx) => {
    container.appendChild(_settingsRenderEntryRow(entry, idx));
  });
}

function _settingsEntryModelState(entry, list) {
  const unavailable = entry.modelAvailable === false;
  const models = Array.isArray(list) ? [...list] : [];
  if (!unavailable && entry.provider === 'openrouter' && entry.model
      && !models.some((model) => model.id === entry.model)) {
    models.unshift({ id: entry.model, name: entry.model });
  }
  return {
    unavailable,
    options: models.map(m => ({ value: m.id, label: m.name || m.id })),
    value: unavailable ? '' : entry.model,
    placeholder: unavailable
      ? t('settings.entries.model_unavailable')
      : (entry.modelName || entry.model),
  };
}

function _settingsEntryProblem(entry) {
  if (entry.profileAvailable === false) {
    return t('settings.entries.credential_missing');
  }
  if (entry.modelAvailable === false) {
    return t('settings.entries.model_unavailable');
  }
  return '';
}

async function _settingsUpdateEntryModel(entry, model, modelSel) {
  const requestedModel = String(model || '').trim();
  if (
    !entry
    || !entry.entryId
    || !requestedModel
    || requestedModel === String(entry.model || '').trim()
  ) return false;
  const startedAt = Date.now();
  let res = null;
  try {
    res = await window.orkas.invoke('auth.updateEntryModel', {
      entryId: entry.entryId,
      model: requestedModel,
    });
  } catch (_) {
    res = { ok: false, code: 'invoke_failed' };
  }
  if (!res || !res.ok) {
    const errorCode = _settingsResultErrorCode(res);
    _settingsLog.warn('model configuration update failed', { error_code: errorCode });
    _settingsTrackModelConfigResult(
      startedAt,
      'update_model',
      'existing',
      'failure',
      errorCode,
    );
    await uiAlert((res && res.error) || t('settings.entries.switch_model_failed'));
    modelSel?.setValue(entry.model);
    return false;
  }
  _settingsTrackModelConfigResult(startedAt, 'update_model', 'existing', 'success');
  await _settingsReload();
  return true;
}

function _settingsRenderEntryRow(entry, priorityIdx) {
  const row = document.createElement('div');
  row.className = 'entry-row' + (priorityIdx === 0 ? ' is-default' : '');
  row.dataset.entryId = entry.entryId;
  row.draggable = true;

  const rank = document.createElement('div');
  rank.className = 'entry-rank';
  rank.textContent = priorityIdx === 0
    ? t('settings.entries.default_tag')
    : `#${priorityIdx + 1}`;
  row.appendChild(rank);

  const main = document.createElement('div');
  main.className = 'entry-main';
  const primary = document.createElement('div');
  primary.className = 'entry-primary';
  const providerName = entry.providerLabelKey ? t(entry.providerLabelKey) : (entry.providerLabel || entry.provider);
  const modelControl = entry.modelEditable === false
    ? `<span class="entry-model-static">${escapeHtml(entry.modelName || entry.model)}</span>`
    : '<div class="ai-select ai-select-compact entry-model-select"></div>';
  primary.innerHTML = `
    <span class="entry-provider">${escapeHtml(providerName)}</span>
    <span class="entry-sep">·</span>
    ${modelControl}
    <span class="entry-account-chip" title="${escapeHtml(t('settings.entries.account_title'))}">@ ${escapeHtml(entry.profileLabel || '')}</span>
  `;
  main.appendChild(primary);

  // Inline model picker — lets users switch the entry's model without
  // deleting + re-adding. auth.listModels is the shortcut catalog; a valid
  // manually entered OpenRouter id is injected only for its existing row so
  // the picker can continue to display that saved selection.
  const modelEl = primary.querySelector('.entry-model-select');
  if (modelEl) {
    const initialModelState = _settingsEntryModelState(entry, []);
    const modelSel = _aiSelectMount(modelEl, {
      placeholder: initialModelState.placeholder,
    });
    // Prevent drag from starting when interacting with the picker.
    modelEl.addEventListener('mousedown', (e) => e.stopPropagation());
    modelEl.setAttribute('draggable', 'false');
    (async () => {
      const res = await window.orkas.invoke('auth.listModels', { provider: entry.provider });
      const list = (res && res.ok && Array.isArray(res.models)) ? res.models : [];
      const modelState = _settingsEntryModelState(entry, list);
      modelSel.setOptions(modelState.options, {
        value: modelState.value,
        placeholder: modelState.placeholder,
      });
      modelSel.onChange(async (val) => {
        await _settingsUpdateEntryModel(entry, val, modelSel);
      });
    })();
  }

  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  const badge = document.createElement('span');
  if (entry.profileType === 'oauth') {
    badge.className = 'account-type-badge oauth' + (entry.oauthExpired ? ' expired' : '');
    badge.textContent = entry.oauthExpired ? t('settings.entries.oauth_expired') : t('settings.entries.oauth_badge');
  } else {
    badge.className = 'account-type-badge';
    badge.textContent = 'API Key';
  }
  meta.appendChild(badge);

  if (entry.profileMasked) {
    const mask = document.createElement('span');
    mask.className = 'account-mask';
    mask.textContent = entry.profileMasked;
    meta.appendChild(mask);
  }
  main.appendChild(meta);

  const status = document.createElement('div');
  status.className = 'entry-status';
  const entryProblem = _settingsEntryProblem(entry);
  if (entryProblem) {
    status.className += ' error';
    status.textContent = entryProblem;
  }
  main.appendChild(status);
  row.appendChild(main);

  const actions = document.createElement('div');
  actions.className = 'entry-actions';

  const testBtn = document.createElement('button');
  testBtn.className = 'icon-btn';
  testBtn.textContent = t('settings.entries.test');
  testBtn.onclick = () => _settingsTestEntry(entry, status);
  actions.appendChild(testBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'icon-btn danger';
  delBtn.textContent = t('common.delete');
  delBtn.onclick = () => _settingsRemoveEntry(entry);
  actions.appendChild(delBtn);

  row.appendChild(actions);

  _settingsAttachReorderDnd(row, {
    kind: 'chat',
    id: entry.entryId,
    getIds: () => _settingsState.entries.map((e) => e.entryId),
    ipcName: 'auth.reorderEntries',
    onSuccess: (res) => {
      _settingsState.entries = Array.isArray(res.entries) ? res.entries : _settingsState.entries;
      _settingsRenderEntries();
    },
  });

  return row;
}

// Shared row drag-and-drop reorder. `kind` discriminates between the three
// lists (chat / search / image) so a drag started in one list can't drop
// into another — without the check, dragover would still highlight foreign
// rows and the drop handler would feed a stranger's id to the wrong reorder
// IPC. `getIds` is read at drop time (not bound at attach time) so each row
// sees the current state's id order even after re-renders.
async function _settingsAttachReorderDnd(row, opts) {
  const { kind, id, getIds, ipcName, onSuccess } = opts;
  row.draggable = true;
  const handle = document.createElement('div');
  handle.className = 'entry-drag-handle';
  handle.title = t('settings.entries.drag_title');
  handle.textContent = '⋮⋮';
  row.prepend(handle);
  row.addEventListener('dragstart', (e) => {
    _settingsState.dragState = { kind, id };
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
  });
  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    row.parentElement?.querySelectorAll('.entry-row').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
    _settingsState.dragState = null;
  });
  row.addEventListener('dragover', (e) => {
    const ds = _settingsState.dragState;
    if (!ds || ds.kind !== kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    row.classList.toggle('drop-before', before);
    row.classList.toggle('drop-after', !before);
  });
  row.addEventListener('dragleave', () => {
    row.classList.remove('drop-before', 'drop-after');
  });
  row.addEventListener('drop', async (e) => {
    const ds = _settingsState.dragState;
    if (!ds || ds.kind !== kind) return;
    e.preventDefault();
    row.classList.remove('drop-before', 'drop-after');
    const srcId = ds.id;
    if (srcId === id) return;
    const rect = row.getBoundingClientRect();
    const before = (e.clientY - rect.top) < rect.height / 2;
    const ids = [...getIds()];
    const srcIdx = ids.indexOf(srcId);
    if (srcIdx < 0) return;
    ids.splice(srcIdx, 1);
    let refIdx = ids.indexOf(id);
    if (refIdx < 0) refIdx = ids.length;
    ids.splice(before ? refIdx : refIdx + 1, 0, srcId);
    const res = await window.orkas.invoke(ipcName, { orderedIds: ids });
    if (res && res.ok) {
      await onSuccess(res);
    } else {
      await uiAlert((res && res.error) || t('settings.entries.reorder_failed'));
    }
  });
}

async function _settingsTestEntry(entry, statusEl) {
  _settingsSetRowStatus(statusEl, 'busy', t('settings.entries.testing'), 'entry-status');
  const res = await window.orkas.invoke('auth.testConnection', {
    provider: entry.provider,
    model: entry.model,
    profileId: entry.profileId,
  });
  if (res && res.ok) {
    const ms = typeof res.durationMs === 'number' ? `${res.durationMs}ms` : '';
    _settingsSetRowStatus(statusEl, 'ok', t('settings.entries.conn_ok', { ms }).trim(), 'entry-status');
  } else {
    const msg = (res && res.error) || t('settings.entries.conn_failed');
    _settingsSetRowStatus(statusEl, 'error', msg.slice(0, 160), 'entry-status');
  }
}

async function _settingsRemoveEntry(entry) {
  const providerName = entry.providerLabelKey ? t(entry.providerLabelKey) : (entry.providerLabel || entry.provider);
  const title = `${providerName} · ${entry.modelName || entry.model} · ${entry.profileLabel}`;
  if (!(await uiConfirm(t('settings.entries.delete_confirm', { title })))) return;
  const startedAt = Date.now();
  _settingsLog.info('remove entry', {
    entry_id: entry.entryId,
    provider: entry.provider,
    model: entry.model,
  });
  const res = await window.orkas.invoke('auth.removeEntry', { entryId: entry.entryId });
  if (!res || !res.ok) {
    _settingsLog.warn('remove entry failed', { entry_id: entry.entryId, error: res && res.error });
    _settingsTrackModelConfigResult(
      startedAt,
      'remove',
      'existing',
      'failure',
      _settingsResultErrorCode(res),
    );
    await uiAlert((res && res.error) || t('settings.entries.delete_failed'));
    return;
  }
  _settingsTrackModelConfigResult(startedAt, 'remove', 'existing', 'success');
  await _settingsReload();
}

// ── Helpers ──

async function _settingsReload() {
  await Promise.all([_settingsRefreshProviders(), _settingsRefreshEntries()]);
  _settingsRenderPicker();
  _settingsRenderEntries();
  // The priority list just changed — re-check the model-guard flag so the
  // top banner and gated actions unlock (or re-lock, after removing the
  // last entry) without waiting for a reload.
  if (typeof refreshModelGuard === 'function') {
    refreshModelGuard().catch(() => {});
  }
}

function _settingsSetStatus(id, kind, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'settings-status' + (kind ? ` ${kind}` : '');
}

function _settingsSetRowStatus(el, kind, text, baseCls = 'account-row-status') {
  if (!el) return;
  el.textContent = text || '';
  el.className = baseCls + (kind ? ` ${kind}` : '');
}

// ── Search API key section ──────────────────────────────────────────────
//
// Shape mirrors the chat-entries list visually but uses simpler rows
// (provider + label + delete). Provider list is fixed (Tavily / Serper /
// Brave Search API / Baidu AI Search); see search-adapters.ts for the
// canonical registry.

function _settingsVisibleApiProfiles(profiles) {
  return (Array.isArray(profiles) ? profiles : []).filter((profile) => (
    profile && profile.managed !== true && !String(profile.id || '').startsWith('managed:')
  ));
}

const _SEARCH_PROVIDER_OPTIONS = [
  { id: 'tavily',            label: 'Tavily', docs: 'https://tavily.com/' },
  { id: 'serper',            label: 'Serper', docs: 'https://serper.dev/' },
  { id: 'brave-search',      label: 'Brave', docs: 'https://brave.com/search/api/' },
  { id: 'baidu-ai-search',   label: 'Baidu', docs: 'https://cloud.baidu.com/doc/qianfan-api/s/em82g4tlk' },
  { id: 'metaso',            label: 'Metaso', docs: 'https://metaso.cn/' },
];

function _searchProviderLabel(id) {
  const hit = _SEARCH_PROVIDER_OPTIONS.find((p) => p.id === id);
  return hit ? hit.label : id;
}

async function _settingsRefreshSearchProfiles() {
  const res = await window.orkas.invoke('searchAuth.list');
  _settingsState.searchProfiles = (res && res.ok && Array.isArray(res.profiles)) ? res.profiles : [];
}

function _settingsRenderSearchSection() {
  _settingsRenderSearchPicker();
  _settingsRenderSearchEntries();
}

function _settingsRenderSearchPicker() {
  const el = document.getElementById('settings-search-provider');
  if (!el) return;
  if (!_settingsState.searchProviderSel) {
    _settingsState.searchProviderSel = _aiSelectMount(el, {
      placeholder: t('settings.search.pick_provider'),
    });
  }
  // setOptions on every call — the second arg refreshes the placeholder so a
  // mid-session language switch updates the dropdown header text.
  const prev = _settingsState.searchProviderSel.getValue();
  _settingsState.searchProviderSel.setOptions(
    _SEARCH_PROVIDER_OPTIONS.map((p) => ({ value: p.id, label: p.label, hint: p.docs })),
    { value: prev || '', placeholder: t('settings.search.pick_provider') },
  );
  const addBtn = document.getElementById('settings-search-add-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', _settingsClickAddSearchKey);
  }
}

async function _settingsClickAddSearchKey() {
  const provider = _settingsState.searchProviderSel?.getValue() || '';
  const input = document.getElementById('settings-search-key-input');
  const apiKey = (input?.value || '').trim();
  if (!provider) { _settingsSetStatus('settings-search-status', 'error', t('settings.search.error_provider_needed')); return; }
  if (!apiKey)   { _settingsSetStatus('settings-search-status', 'error', t('settings.search.error_key_needed')); return; }
  _settingsSetStatus('settings-search-status', 'busy', t('settings.search.adding'));
  try {
    const res = await window.orkas.invoke('searchAuth.add', { provider, apiKey, label: 'default' });
    if (!res || !res.ok) {
      _settingsSetStatus('settings-search-status', 'error', (res && res.error) || t('settings.search.add_failed'));
      return;
    }
    if (input) input.value = '';
    _settingsSetStatus('settings-search-status', 'ok', t('settings.search.add_ok'));
    await _settingsRefreshSearchProfiles();
    _settingsRenderSearchEntries();
  } catch (err) {
    _settingsSetStatus('settings-search-status', 'error', (err && err.message) || String(err));
  }
}

function _settingsRenderSearchEntries() {
  const container = document.getElementById('settings-search-entries');
  if (!container) return;
  container.innerHTML = '';
  const list = _settingsVisibleApiProfiles(_settingsState.searchProfiles);
  if (!list.length) {
    container.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.search.empty'))}</div>`;
    return;
  }
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'entry-row' + (idx === 0 ? ' is-default' : '');
    row.dataset.profileId = p.id;

    const rank = document.createElement('div');
    rank.className = 'entry-rank';
    rank.textContent = idx === 0 ? t('settings.search.active_tag') : `#${idx + 1}`;
    row.appendChild(rank);

    const main = document.createElement('div');
    main.className = 'entry-main';
    const primary = document.createElement('div');
    primary.className = 'entry-primary';
    primary.innerHTML = `
      <span class="entry-provider">${escapeHtml(_searchProviderLabel(p.provider))}</span>
      <span class="entry-sep">·</span>
      <span class="entry-account-chip">@ ${escapeHtml(p.label || 'default')}</span>
      ${p.apiKeyMasked ? `<span class="account-mask">${escapeHtml(p.apiKeyMasked)}</span>` : ''}
    `;
    main.appendChild(primary);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('settings.delete');
    delBtn.addEventListener('click', async () => {
      const ok = await uiConfirm(t('settings.search.confirm_delete', { provider: _searchProviderLabel(p.provider) }));
      if (!ok) return;
      const res = await window.orkas.invoke('searchAuth.remove', { id: p.id });
      if (res && res.ok) {
        await _settingsRefreshSearchProfiles();
        _settingsRenderSearchEntries();
      }
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    _settingsAttachReorderDnd(row, {
      kind: 'search',
      id: p.id,
      getIds: () => _settingsVisibleApiProfiles(_settingsState.searchProfiles).map((x) => x.id),
      ipcName: 'searchAuth.reorder',
      onSuccess: async () => {
        await _settingsRefreshSearchProfiles();
        _settingsRenderSearchEntries();
      },
    });

    container.appendChild(row);
  });
}

// ── Image generation API key section ────────────────────────────────────
//
// Multi-model providers are flattened into individual choices. The picker
// shows DouBao · Seedream 5.0 Lite / Pro directly, while the main process
// still persists provider=doubao plus the selected model id.

const _IMAGE_PROVIDER_OPTIONS = [
  { id: 'openai',  label: 'OpenAI · GPT Image 2', docs: 'https://platform.openai.com/api-keys' },
  { id: 'google',  label: 'Google · Nano Banana 2', docs: 'https://aistudio.google.com/app/apikey' },
  { id: 'doubao',  label: 'DouBao · Seedream', docs: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
];

function _imageProviderLabel(id) {
  const hit = _IMAGE_PROVIDER_OPTIONS.find((p) => p.id === id);
  return hit ? hit.label : id;
}

async function _settingsRefreshImageProfiles() {
  const res = await window.orkas.invoke('imageAuth.list');
  _settingsState.imageProfiles = (res && res.ok && Array.isArray(res.profiles)) ? res.profiles : [];
}

function _settingsRenderImageSection() {
  _settingsRenderImagePicker();
  _settingsRenderImageEntries();
}

function _settingsRenderImagePicker() {
  const el = document.getElementById('settings-image-provider');
  if (!el) return;
  if (!_settingsState.imageProviderSel) {
    _settingsState.imageProviderSel = _aiSelectMount(el, {
      placeholder: t('settings.image.pick_provider'),
    });
  }
  const prev = _settingsState.imageProviderSel.getValue();
  _settingsState.imageProviderSel.setOptions(
    _IMAGE_PROVIDER_OPTIONS.map((p) => ({ value: p.id, label: p.label, hint: p.docs })),
    { value: prev || '', placeholder: t('settings.image.pick_provider') },
  );
  const addBtn = document.getElementById('settings-image-add-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', _settingsClickAddImageKey);
  }
}

async function _settingsClickAddImageKey() {
  const provider = _settingsState.imageProviderSel?.getValue() || '';
  const input = document.getElementById('settings-image-key-input');
  const apiKey = (input?.value || '').trim();
  if (!provider) { _settingsSetStatus('settings-image-status', 'error', t('settings.image.error_provider_needed')); return; }
  if (!apiKey)   { _settingsSetStatus('settings-image-status', 'error', t('settings.image.error_key_needed')); return; }
  _settingsSetStatus('settings-image-status', 'busy', t('settings.image.adding'));
  try {
    const res = await window.orkas.invoke('imageAuth.add', { provider, model, apiKey, label: 'default' });
    if (!res || !res.ok) {
      _settingsSetStatus('settings-image-status', 'error', (res && res.error) || t('settings.image.add_failed'));
      return;
    }
    if (input) input.value = '';
    _settingsSetStatus('settings-image-status', 'ok', t('settings.image.add_ok'));
    await _settingsRefreshImageProfiles();
    _settingsRenderImageEntries();
  } catch (err) {
    _settingsSetStatus('settings-image-status', 'error', (err && err.message) || String(err));
  }
}

function _settingsRenderImageEntries() {
  const container = document.getElementById('settings-image-entries');
  if (!container) return;
  container.innerHTML = '';
  const list = _settingsVisibleApiProfiles(_settingsState.imageProfiles);
  if (!list.length) {
    container.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.image.empty'))}</div>`;
    return;
  }
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'entry-row' + (idx === 0 ? ' is-default' : '');
    row.dataset.profileId = p.id;

    const rank = document.createElement('div');
    rank.className = 'entry-rank';
    rank.textContent = idx === 0 ? t('settings.image.active_tag') : `#${idx + 1}`;
    row.appendChild(rank);

    const main = document.createElement('div');
    main.className = 'entry-main';
    const primary = document.createElement('div');
    primary.className = 'entry-primary';
    primary.innerHTML = `
      <span class="entry-provider">${escapeHtml(_imageProviderLabel(p.provider))}</span>
      <span class="entry-sep">·</span>
      <span class="entry-account-chip">@ ${escapeHtml(p.label || 'default')}</span>
      ${p.apiKeyMasked ? `<span class="account-mask">${escapeHtml(p.apiKeyMasked)}</span>` : ''}
    `;
    main.appendChild(primary);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('settings.delete');
    delBtn.addEventListener('click', async () => {
      const ok = await uiConfirm(t('settings.image.confirm_delete', { provider: _imageProviderLabel(p.provider, p.model) }));
      if (!ok) return;
      const res = await window.orkas.invoke('imageAuth.remove', { id: p.id });
      if (res && res.ok) {
        await _settingsRefreshImageProfiles();
        _settingsRenderImageEntries();
      }
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    _settingsAttachReorderDnd(row, {
      kind: 'image',
      id: p.id,
      getIds: () => _settingsVisibleApiProfiles(_settingsState.imageProfiles).map((x) => x.id),
      ipcName: 'imageAuth.reorder',
      onSuccess: async () => {
        await _settingsRefreshImageProfiles();
        _settingsRenderImageEntries();
      },
    });

    container.appendChild(row);
  });
}

// ── Video generation API key section ────────────────────────────────────
//
// Dedicated BYO video-generation credentials. The open-source build exposes
// User-owned provider keys only; bundled video providers stay stripped.

const _VIDEO_AUTH_PROVIDER_OPTIONS = [
  { id: 'doubao', label: 'DouBao · Seedance', docs: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
];

function _settingsVideoProviderOptions() {
  return Array.isArray(_settingsState.videoAuthProviderOptions) && _settingsState.videoAuthProviderOptions.length
    ? _settingsState.videoAuthProviderOptions
    : _VIDEO_AUTH_PROVIDER_OPTIONS;
}

function _videoProviderLabel(id) {
  const hit = _settingsVideoProviderOptions().find((p) => p.id === id);
  return hit ? hit.label : id;
}

function _settingsSelectedVideoProvider() {
  return _settingsState.videoProviderSel?.getValue()
    || document.getElementById('settings-video-provider')?.dataset?.value
    || '';
}

async function _settingsRefreshVideoProfiles() {
  const res = await window.orkas.invoke('videoAuth.list');
  _settingsState.videoProfiles = (res && res.ok && Array.isArray(res.profiles)) ? res.profiles : [];
  _settingsState.videoAuthProviderOptions = (res && res.ok && Array.isArray(res.providers) && res.providers.length)
    ? res.providers
    : _VIDEO_AUTH_PROVIDER_OPTIONS;
}

function _settingsRenderVideoSection() {
  _settingsRenderVideoPicker();
  _settingsRenderVideoEntries();
}

function _settingsRenderVideoPicker() {
  const providerEl = document.getElementById('settings-video-provider');
  if (!providerEl) return;
  if (!_settingsState.videoProviderSel) {
    _settingsState.videoProviderSel = _aiSelectMount(providerEl, {
      placeholder: t('settings.video.pick_provider'),
    });
    _settingsState.videoProviderSel.onChange((provider) => {
      _settingsTrackModelProviderSelect('video_auth_picker', provider);
      _settingsSetStatus('settings-video-status', '', '');
    });
  }
  const prevProvider = _settingsState.videoProviderSel.getValue();
  _settingsState.videoProviderSel.setOptions(
    _settingsVideoProviderOptions().map((p) => ({
      value: p.id,
      label: p.label || p.id,
      hint: p.docs,
    })),
    { value: prevProvider || '', placeholder: t('settings.video.pick_provider') },
  );
  const addBtn = document.getElementById('settings-video-add-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', _settingsClickAddVideoKey);
  }
}

async function _settingsClickAddVideoKey() {
  const provider = _settingsSelectedVideoProvider();
  const input = document.getElementById('settings-video-key-input');
  const apiKey = (input?.value || '').trim();
  if (!provider) { _settingsSetStatus('settings-video-status', 'error', t('settings.video.error_provider_needed')); return; }
  if (!apiKey) { _settingsSetStatus('settings-video-status', 'error', t('settings.video.error_key_needed')); return; }
  _settingsSetStatus('settings-video-status', 'busy', t('settings.video.adding'));
  try {
    const res = await window.orkas.invoke('videoAuth.add', { provider, apiKey, label: 'default' });
    if (!res || !res.ok) {
      _settingsSetStatus('settings-video-status', 'error', (res && res.error) || t('settings.video.add_failed'));
      return;
    }
    if (input) input.value = '';
    _settingsSetStatus('settings-video-status', 'ok', t('settings.video.add_ok'));
    await _settingsRefreshVideoProfiles();
    _settingsRenderVideoEntries();
  } catch (err) {
    _settingsSetStatus('settings-video-status', 'error', (err && err.message) || String(err));
  }
}

function _settingsRenderVideoEntries() {
  const container = document.getElementById('settings-video-entries');
  if (!container) return;
  container.innerHTML = '';
  const list = _settingsVisibleApiProfiles(_settingsState.videoProfiles);
  if (!list.length) {
    container.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.video.empty'))}</div>`;
    return;
  }
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'entry-row' + (idx === 0 ? ' is-default' : '');
    row.dataset.profileId = p.id;

    const rank = document.createElement('div');
    rank.className = 'entry-rank';
    rank.textContent = idx === 0 ? t('settings.video.active_tag') : `#${idx + 1}`;
    row.appendChild(rank);

    const main = document.createElement('div');
    main.className = 'entry-main';
    const primary = document.createElement('div');
    primary.className = 'entry-primary';
    primary.innerHTML = `
      <span class="entry-provider">${escapeHtml(_videoProviderLabel(p.provider))}</span>
      <span class="entry-sep">·</span>
      <span class="entry-account-chip">@ ${escapeHtml(p.label || 'default')}</span>
      ${p.apiKeyMasked ? `<span class="account-mask">${escapeHtml(p.apiKeyMasked)}</span>` : ''}
    `;
    main.appendChild(primary);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('settings.delete');
    delBtn.addEventListener('click', async () => {
      const ok = await uiConfirm(t('settings.video.confirm_delete', { provider: _videoProviderLabel(p.provider, p.model) }));
      if (!ok) return;
      const res = await window.orkas.invoke('videoAuth.remove', { id: p.id });
      if (res && res.ok) {
        await _settingsRefreshVideoProfiles();
        _settingsRenderVideoEntries();
      }
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    _settingsAttachReorderDnd(row, {
      kind: 'video',
      id: p.id,
      getIds: () => _settingsVisibleApiProfiles(_settingsState.videoProfiles).map((x) => x.id),
      ipcName: 'videoAuth.reorder',
      onSuccess: async () => {
        await _settingsRefreshVideoProfiles();
        _settingsRenderVideoEntries();
      },
    });

    container.appendChild(row);
  });
}

// ── Text-to-speech API key section ─────────────────────────────────────────

async function _settingsRefreshTtsProfiles() {
  const res = await window.orkas.invoke('ttsAuth.list');
  if (!res || !res.ok) return;
  _settingsState.ttsPresets = Array.isArray(res.presets) ? res.presets : [];
  _settingsState.ttsProfiles = Array.isArray(res.profiles) ? res.profiles : [];
  const providerEl = document.getElementById('settings-tts-provider');
  if (providerEl && !_settingsState.ttsProviderSel) {
    _settingsState.ttsProviderSel = _aiSelectMount(providerEl, { placeholder: t('settings.tts.pick_provider') });
    _settingsState.ttsProviderSel.onChange((id) => {
      _settingsTtsPrefillProvider(id);
      _settingsTtsApplyProviderFields(id);
      _settingsSetStatus('settings-tts-status', '', '');
    });
  }
  if (_settingsState.ttsProviderSel) {
    const prev = _settingsState.ttsProviderSel.getValue();
    _settingsState.ttsProviderSel.setOptions(
      (_settingsState.ttsPresets || []).map((p) => ({ value: p.id, label: p.label, hint: p.docs })),
      { value: prev || '', placeholder: t('settings.tts.pick_provider') },
    );
    _settingsTtsApplyProviderFields(_settingsState.ttsProviderSel.getValue());
  }
  const addBtn = document.getElementById('settings-tts-add-btn');
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = '1';
    addBtn.addEventListener('click', _settingsClickAddTts);
  }
  _settingsRenderTtsEntries();
}

function _settingsTtsPreset(providerId) {
  return (_settingsState.ttsPresets || []).find((p) => p.id === providerId);
}

function _ttsProviderLabel(id) {
  if (id === 'orkas-voice') return 'Orkas · Voice';
  const hit = (_settingsState.ttsPresets || []).find((p) => p.id === id);
  return hit ? hit.label : (id || 'custom');
}

function _settingsTtsPrefillProvider(providerId) {
  const preset = _settingsTtsPreset(providerId);
  const baseInput = document.getElementById('settings-tts-base-input');
  const modelInput = document.getElementById('settings-tts-model-input');
  const voiceInput = document.getElementById('settings-tts-voice-input');
  const resInput = document.getElementById('settings-tts-doubao-resource');
  if (baseInput) baseInput.value = preset?.baseUrl || '';
  if (modelInput) modelInput.value = preset?.defaultModel || '';
  if (voiceInput) {
    voiceInput.value = '';
    voiceInput.placeholder = preset?.defaultVoice || 'alloy';
  }
  if (resInput) resInput.value = preset?.defaultResourceId || '';
}

function _settingsTtsSetRowHidden(selector, hidden) {
  document.querySelectorAll(selector).forEach((el) => {
    el.hidden = !!hidden;
    el.style.display = hidden ? 'none' : '';
    el.setAttribute('aria-hidden', hidden ? 'true' : 'false');
  });
}

function _settingsTtsApplyProviderFields(providerId) {
  const preset = _settingsTtsPreset(providerId);
  const isCustom = providerId === 'custom';
  const needsVoice = !!providerId && !preset?.defaultVoice;
  _settingsTtsSetRowHidden('#settings-tts-key-row', false);
  _settingsTtsSetRowHidden('.tts-row-base, .tts-row-model', !isCustom);
  _settingsTtsSetRowHidden('.tts-row-voice', !needsVoice);
  _settingsTtsSetRowHidden('.tts-row-doubao-res', true);
}

function _settingsTtsAddFailure(errorLike) {
  const errorCode = String(errorLike?.code || '').trim();
  const storageFull = errorCode === 'ENOSPC';
  return {
    message: storageFull ? t('settings.storage_full') : t('settings.tts.add_failed'),
    errorCode: errorCode || 'unknown',
    errorType: storageFull ? 'storage' : 'operation',
  };
}

async function _settingsClickAddTts() {
  const provider = _settingsState.ttsProviderSel?.getValue() || '';
  if (!provider) { _settingsSetStatus('settings-tts-status', 'error', t('settings.tts.error_provider_needed')); return; }
  const preset = _settingsTtsPreset(provider);
  const apiKey = (document.getElementById('settings-tts-key-input')?.value || '').trim();
  const voice = (document.getElementById('settings-tts-voice-input')?.value || '').trim();
  if (!apiKey) { _settingsSetStatus('settings-tts-status', 'error', t('settings.tts.error_key_needed')); return; }

  let payload;
  if (provider === 'doubao') {
    const resourceId = (document.getElementById('settings-tts-doubao-resource')?.value || '').trim();
    payload = { provider, apiKey, voice: voice || (preset?.defaultVoice || ''), resourceId };
  } else {
    const baseUrl = (document.getElementById('settings-tts-base-input')?.value || '').trim() || (preset?.baseUrl || '');
    const model = (document.getElementById('settings-tts-model-input')?.value || '').trim() || (preset?.defaultModel || '');
    const finalVoice = voice || (preset?.defaultVoice || '');
    if (!baseUrl) { _settingsSetStatus('settings-tts-status', 'error', t('settings.tts.error_base_needed')); return; }
    if (!model) { _settingsSetStatus('settings-tts-status', 'error', t('settings.tts.error_model_needed')); return; }
    if (!finalVoice) { _settingsSetStatus('settings-tts-status', 'error', t('settings.tts.error_voice_needed')); return; }
    payload = { provider, baseUrl, model, apiKey, voice: finalVoice };
  }

  _settingsSetStatus('settings-tts-status', 'busy', t('settings.tts.adding'));
  try {
    const res = await window.orkas.invoke('ttsAuth.add', payload);
    if (!res || !res.ok) {
      const failure = _settingsTtsAddFailure(res);
      _settingsSetStatus('settings-tts-status', 'error', failure.message);
      return;
    }
    const keyInput = document.getElementById('settings-tts-key-input');
    if (keyInput) keyInput.value = '';
    _settingsSetStatus('settings-tts-status', 'ok', t('settings.tts.add_ok'));
    await _settingsRefreshTtsProfiles();
  } catch (err) {
    const failure = _settingsTtsAddFailure(err);
    _settingsSetStatus('settings-tts-status', 'error', failure.message);
    _settingsLog.warn('add TTS provider failed', {
      error_type: failure.errorType,
      error_code: failure.errorCode,
    });
  }
}

function _settingsRenderTtsEntries() {
  const container = document.getElementById('settings-tts-entries');
  if (!container) return;
  container.innerHTML = '';
  const list = _settingsVisibleApiProfiles(_settingsState.ttsProfiles);
  if (!list.length) {
    container.innerHTML = `<div class="settings-empty">${escapeHtml(t('settings.tts.empty'))}</div>`;
    return;
  }
  list.forEach((p, idx) => {
    const row = document.createElement('div');
    row.className = 'entry-row' + (idx === 0 ? ' is-default' : '');
    row.dataset.profileId = p.id;

    const rank = document.createElement('div');
    rank.className = 'entry-rank';
    rank.textContent = idx === 0 ? t('settings.tts.active_tag') : `#${idx + 1}`;
    row.appendChild(rank);

    const main = document.createElement('div');
    main.className = 'entry-main';
    const primary = document.createElement('div');
    primary.className = 'entry-primary';
    const detail = p.provider === 'doubao' ? (p.resourceId || '') : (p.model || '');
    primary.innerHTML = `
      <span class="entry-provider">${escapeHtml(_ttsProviderLabel(p.provider))}</span>
      ${detail ? `<span class="entry-sep">·</span><span class="entry-model">${escapeHtml(detail)}</span>` : ''}
      ${p.voice ? `<span class="entry-sep">·</span><span class="entry-model">${escapeHtml(p.voice)}</span>` : ''}
      <span class="entry-sep">·</span>
      <span class="entry-account-chip">@ ${escapeHtml(p.label || 'default')}</span>
      ${p.apiKeyMasked ? `<span class="account-mask">${escapeHtml(p.apiKeyMasked)}</span>` : ''}
    `;
    main.appendChild(primary);
    row.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'entry-actions';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('settings.delete');
    delBtn.addEventListener('click', async () => {
      const ok = await uiConfirm(t('settings.tts.confirm_delete', { provider: _ttsProviderLabel(p.provider) }));
      if (!ok) return;
      const res = await window.orkas.invoke('ttsAuth.remove', { id: p.id });
      if (res && res.ok) await _settingsRefreshTtsProfiles();
    });
    actions.appendChild(delBtn);
    row.appendChild(actions);

    _settingsAttachReorderDnd(row, {
      kind: 'tts',
      id: p.id,
      getIds: () => _settingsVisibleApiProfiles(_settingsState.ttsProfiles).map((x) => x.id),
      ipcName: 'ttsAuth.reorder',
      onSuccess: async () => {
        await _settingsRefreshTtsProfiles();
        _settingsRenderTtsEntries();
      },
    });

    container.appendChild(row);
  });
}
