// ─── Settings (entries-based: picker + priority list) ────────────────────
// The page is split in two:
//   1. "Add model auth": pick provider + model, then "+ Add account" →
//      either an API Key form or the OAuth flow, depending on what the
//      provider supports. On success we auto-create a priority-list
//      entry pointing at the new credential.
//   2. "Configured (by priority)": ordered list of
//      (provider, model, profile)
//      entries. First = default model; later items are the fallback chain.
//      Rows are drag-reorderable.

const _settingsLog = createLogger('settings');

let _settingsState = {
  providers: [],      // from auth.listProviders  [{id, label, supportsApiKey, supportsOAuth, profiles, ...}]
  entries: [],        // from auth.listEntries
  modelsCache: {},    // provider → [{id, name}]
  pickerProviderSel: null,
  pickerModelSel: null,
  pickerProviderEl: null,
  pickerModelEl: null,
  addBtnEl: null,
  dragState: null,
  clientConfigBound: false,
};

function _settingsTrackClick() {}

function _settingsTrackModelProviderSelect(surface, provider) {
  const value = String(provider || '').trim();
  if (!value) return;
  _settingsTrackClick('model_provider_select', { surface, provider: value });
}

function _settingsTrackModelSelect(surface, provider, model) {
  const modelValue = String(model || '').trim();
  if (!modelValue) return;
  const payload = { surface, model: modelValue };
  const providerValue = String(provider || '').trim();
  if (providerValue) payload.provider = providerValue;
  _settingsTrackClick('model_model_select', payload);
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
  _settingsBindClientConfigOnce();
  _settingsSyncLanguageRadio();
  await Promise.all([
    _settingsSafeCall('settings providers refresh', _settingsRefreshProviders),
    _settingsSafeCall('settings entries refresh', _settingsRefreshEntries),
    _settingsSafeCall('settings local execution refresh', _settingsRefreshLocalExec),
    _settingsSafeCall('settings search refresh', _settingsRefreshSearchProfiles),
    _settingsSafeCall('settings image refresh', _settingsRefreshImageProfiles),
    _settingsSafeCall('settings video refresh', _settingsRefreshVideoProfiles),
    _settingsSafeCall('settings commander avatar refresh', _settingsRefreshCommanderAvatar),
    _settingsSafeCall('settings metacognition refresh', _settingsRefreshMetacognition),
    _settingsSafeCall('settings data root refresh', _settingsRefreshDataRoot),
  ]);
  await _settingsSafeCall('settings picker render', _settingsRenderPicker);
  await _settingsSafeCall('settings entries render', _settingsRenderEntries);
  await _settingsSafeCall('settings local execution render', _settingsRenderLocalExec);
  await _settingsSafeCall('settings search render', _settingsRenderSearchSection);
  await _settingsSafeCall('settings image render', _settingsRenderImageSection);
  await _settingsSafeCall('settings video render', _settingsRenderVideoSection);
  await _settingsSafeCall('settings commander avatar render', _settingsRenderCommanderAvatar);
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

function _settingsBindClientConfigOnce() {}

// ── Commander avatar ──
// Commander avatar goes through the prefs IPC and lands in
// preferences.json. After a change we immediately push it back to the
// cache (conversation.js's _commanderAvatarCache) so chat rows pick up
// the new avatar without waiting for the next view switch.

function _settingsCommanderDefaultAvatar() {
  if (typeof COMMANDER_DEFAULT !== 'undefined' && COMMANDER_DEFAULT) {
    return { ...COMMANDER_DEFAULT };
  }
  return { icon: 'crown', color: 'gold' };
}

async function _settingsRefreshCommanderAvatar() {
  try {
    const res = await window.orkas.invoke('prefs.getCommanderAvatar');
    _settingsState.commanderAvatar = (res && res.avatar)
      ? { icon: res.avatar.icon, color: res.avatar.color }
      : _settingsCommanderDefaultAvatar();
  } catch (_) {
    _settingsState.commanderAvatar = _settingsCommanderDefaultAvatar();
  }
}

function _settingsRenderCommanderAvatar() {
  const slot = document.getElementById('settings-commander-avatar');
  if (!slot) return;
  const cur = _settingsState.commanderAvatar || _settingsCommanderDefaultAvatar();
  if (typeof renderAvatarHtml !== 'function') return;
  slot.innerHTML = renderAvatarHtml(cur.icon, cur.color, {
    size: 44, seed: 'commander', clickable: true,
  });
  const trigger = slot.querySelector('.avatar-circle');
  if (!trigger) return;
  trigger.title = t('avatar.change');
  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (typeof openAvatarPicker !== 'function') return;
    if (typeof isAvatarPickerOpenFor === 'function' && isAvatarPickerOpenFor(trigger)) {
      if (typeof closeAvatarPicker === 'function') closeAvatarPicker();
      return;
    }
    // The commander avatar's icon is fixed at crown, so the picker
    // only shows the color row. Backend validation still requires both
    // tokens, so we force-write crown on save.
    openAvatarPicker(trigger, cur, { allowCommanderCombo: true, hideIcons: true }, async (next) => {
      const icon = _settingsCommanderDefaultAvatar().icon;
      _settingsState.commanderAvatar = { icon, color: next.color };
      cur.icon = icon; cur.color = next.color;
      // Update in place — the trigger's click listener is preserved so
      // the user can click a few times in a row until satisfied.
      if (typeof applyAvatarToElement === 'function') applyAvatarToElement(trigger, icon, next.color, 'commander');
      try {
        const res = await window.orkas.invoke('prefs.setCommanderAvatar', { icon, color: next.color });
        if (res?.ok && res.avatar) {
          if (typeof setCommanderAvatarCache === 'function') setCommanderAvatarCache(res.avatar);
        }
      } catch (err) {
        _settingsLog.warn('save commander avatar failed', err);
      }
    });
  });
}

// ── Tool execution access permission ──

const _LOCALEXEC_MODES = ['off', 'risk_prompt', 'allow_all'];

async function _settingsRefreshLocalExec() {
  const res = await window.orkas.invoke('permissions.getLocalExec');
  const mode = (res && res.ok && _LOCALEXEC_MODES.includes(res.mode)) ? res.mode : 'risk_prompt';
  _settingsState.localExec = { mode };
}

function _settingsRenderLocalExec() {
  const container = document.getElementById('settings-localexec-modes');
  if (!container) return;
  const mode = (_settingsState.localExec && _settingsState.localExec.mode) || 'risk_prompt';
  const radios = container.querySelectorAll('input[name="localexec-mode"]');
  radios.forEach((r) => { r.checked = (r.value === mode); });
  if (!container.dataset.bound) {
    radios.forEach((radio) => {
      radio.addEventListener('change', async () => {
        if (!radio.checked) return;
        const next = radio.value;
        const prev = (_settingsState.localExec && _settingsState.localExec.mode) || 'risk_prompt';
        try {
          const res = await window.orkas.invoke('permissions.setLocalExecMode', { mode: next });
          if (res && res.ok && res.mode) {
            _settingsState.localExec = { mode: res.mode };
            _settingsRenderLocalExec();
          } else {
            _settingsState.localExec = { mode: prev };
            _settingsRenderLocalExec();
          }
        } catch (err) {
          _settingsState.localExec = { mode: prev };
          _settingsRenderLocalExec();
          _settingsLog.warn('local exec mode set failed', err);
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

async function _settingsRefreshMetacognition() {
  try {
    const res = await window.orkas.invoke('prefs.getMetacognition');
    _settingsState.metacognition = (res && res.ok)
      ? { enabled: !!res.enabled, envForcedOff: !!res.envForcedOff }
      : { enabled: true, envForcedOff: false };
  } catch (_) {
    _settingsState.metacognition = { enabled: true, envForcedOff: false };
  }
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
        }
      } catch (err) {
        cb.checked = !next;
        _settingsLog.warn('setMetacognition failed', err);
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
      try {
        await window.orkas.invoke('app.openDataRoot');
      } catch (err) {
        _settingsLog.warn('open data root failed', { error: (err && err.message) || String(err) });
      }
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
  if (_settingsLanguageSel) _settingsLanguageSel.setValue(cur);
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
  const res = await window.orkas.invoke('auth.listEntries');
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

async function _settingsRenderPicker() {
  const providerEl = document.getElementById('settings-picker-provider');
  const modelEl    = document.getElementById('settings-picker-model');
  if (!providerEl || !modelEl) return;

  const providerOptions = _settingsState.providers.map((p) => {
    const baseLabel = p.label || p.id;
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
      _settingsTrackModelProviderSelect('model_auth_picker', val);
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
      _settingsTrackModelSelect('model_auth_picker', _settingsState.pickerProviderSel?.getValue(), val);
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
  const models = await _settingsGetModels(providerId);
  sel.setOptions(
    models.map((m) => ({ value: m.id, label: m.name || m.id })),
    { value: selected || '', placeholder: providerId ? t('settings.picker.select_model') : t('settings.picker.pick_provider_first') },
  );
}

async function _settingsClickAddEntry() {
  const providerId = _settingsState.pickerProviderSel?.getValue() || '';
  const modelId    = _settingsState.pickerModelSel?.getValue() || '';
  if (!providerId) { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_provider_needed')); return; }
  if (!modelId)    { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_model_needed')); return; }

  const provider = _settingsState.providers.find((p) => p.id === providerId);
  if (!provider) { _settingsSetStatus('settings-picker-status', 'error', t('settings.picker.error_provider_missing')); return; }

  _settingsSetStatus('settings-picker-status', '', '');
  _settingsChooseAccountMethod(provider, modelId);
}

// ── Method chooser + credential forms ──

function _settingsChooseAccountMethod(provider, modelId) {

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
  body.innerHTML = `
    ${subNoteHtml}
    <div class="form-row">
      <label>${escapeHtml(t('settings.modal.label'))}</label>
      <input type="text" class="api-label-input form-input" placeholder="${escapeHtml(t('settings.modal.label_placeholder'))}" autocomplete="off" spellcheck="false" />
    </div>
    <div class="form-row">
      <label>API Key</label>
      <input type="text" class="api-key-input form-input" placeholder="sk-…" autocomplete="off" spellcheck="false" />
    </div>
    ${docsHtml}
    <div class="form-msg"></div>
  `;
  actions.innerHTML = '';

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
    const label  = (labelInput.value || '').trim();
    const apiKey = (keyInput.value || '').trim();
    if (!apiKey) { msg.textContent = t('settings.paste_key_first'); msg.className = 'form-msg error'; return; }
    saveBtn.disabled = true;
    msg.textContent = t('settings.save_loading'); msg.className = 'form-msg';
    _settingsLog.info('add api key', { provider: provider.id, model: modelId, has_label: !!label });
    const addRes = await window.orkas.invoke('auth.addApiKey', {
      provider: provider.id,
      apiKey,
      label: label || undefined,
    });
    if (!addRes || !addRes.ok) {
      saveBtn.disabled = false;
      msg.textContent = (addRes && addRes.error) || t('settings.save_failed');
      msg.className = 'form-msg error';
      _settingsLog.warn('add api key failed', { provider: provider.id, error: addRes && addRes.error });
      return;
    }
    const entryRes = await window.orkas.invoke('auth.addEntry', {
      provider: provider.id,
      model: modelId,
      profileId: addRes.profileId,
    });
    saveBtn.disabled = false;
    if (!entryRes || !entryRes.ok) {
      msg.textContent = (entryRes && entryRes.error) || t('settings.add_entry_failed');
      msg.className = 'form-msg error';
      return;
    }
    _settingsCloseModal(overlay);
    await _settingsReload();
  };
  saveBtn.onclick = save;
  // IME guard (CLAUDE.md §8): Enter on these inputs advances focus / saves;
  // skip while a Chinese / Japanese / Korean candidate is being composed.
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

async function _settingsStartOAuthFlow(provider, modelId) {
  const overlay   = document.getElementById('oauth-flow-modal');
  const title     = document.getElementById('oauth-flow-title');
  const body      = document.getElementById('oauth-flow-body');
  const cancelBtn = document.getElementById('oauth-flow-cancel-btn');
  if (!overlay || !title || !body || !cancelBtn) return;

  // OAuth back-end may be different from the user-picked provider (e.g.
  // openai → openai-codex). `oauthProvider` is the id we actually log into.
  const oauthProviderId = provider.oauthProvider || provider.id;
  const aliased = oauthProviderId !== provider.id;

  _oauthFlowTarget = { provider, modelId, oauthProviderId };
  title.textContent = t('settings.oauth.title_prefix', { provider: provider.label || provider.id });
  const aliasTip = aliased
    ? `<div class="oauth-flow-hint">${escapeHtml(t('settings.oauth.alias_tip', { provider: oauthProviderId }))}</div>`
    : '';
  body.innerHTML = `<div class="oauth-flow-stage">${escapeHtml(t('settings.oauth.starting'))}</div>${aliasTip}`;
  overlay.classList.add('open');

  const closeFlow = () => {
    if (_oauthFlowPollTimer) { clearInterval(_oauthFlowPollTimer); _oauthFlowPollTimer = null; }
    if (_oauthFlowId) {
      window.orkas.invoke('auth.cancelOAuthFlow', { flowId: _oauthFlowId }).catch(() => {});
    }
    _oauthFlowId = null;
    _oauthFlowTarget = null;
    overlay.classList.remove('open');
    document.removeEventListener('keydown', onKey, true);
  };
  const onKey = (e) => { if (e.key === 'Escape') closeFlow(); };
  cancelBtn.onclick = closeFlow;
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
      if (target && target.modelId && profileId) {
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
        await window.orkas.invoke('auth.addEntry', {
          provider: entryProvider,
          model,
          profileId,
        });
      }
      closeFlow();
      await _settingsReload();
    })();
    return;
  }

  if (status.kind === 'error') {
    body.innerHTML = `<div class="oauth-flow-stage error">${escapeHtml(status.error || t('settings.oauth.auth_failed'))}</div>`;
    if (_oauthFlowPollTimer) { clearInterval(_oauthFlowPollTimer); _oauthFlowPollTimer = null; }
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

  _settingsState.entries.forEach((entry, idx) => {
    container.appendChild(_settingsRenderEntryRow(entry, idx));
  });
}

function _settingsRenderEntryRow(entry, idx) {
  const row = document.createElement('div');
  row.className = 'entry-row' + (idx === 0 ? ' is-default' : '');
  row.dataset.entryId = entry.entryId;
  row.draggable = true;

  const rank = document.createElement('div');
  rank.className = 'entry-rank';
  rank.textContent = idx === 0 ? t('settings.entries.default_tag') : `#${idx + 1}`;
  row.appendChild(rank);

  const main = document.createElement('div');
  main.className = 'entry-main';
  const primary = document.createElement('div');
  primary.className = 'entry-primary';
  primary.innerHTML = `
    <span class="entry-provider">${escapeHtml(entry.providerLabel || entry.provider)}</span>
    <span class="entry-sep">·</span>
    <div class="ai-select ai-select-compact entry-model-select"></div>
    <span class="entry-account-chip" title="${escapeHtml(t('settings.entries.account_title'))}">@ ${escapeHtml(entry.profileLabel || '')}</span>
  `;
  main.appendChild(primary);

  // Inline model picker — lets users switch the entry's model without
  // deleting + re-adding. The list is the provider's valid model set
  // (auth.listModels applies the curated whitelist for OAuth-backed
  // providers so users can't pick something the API will reject).
  const modelEl = primary.querySelector('.entry-model-select');
  const modelSel = _aiSelectMount(modelEl, { placeholder: entry.modelName || entry.model });
  // Prevent drag from starting when interacting with the picker.
  modelEl.addEventListener('mousedown', (e) => e.stopPropagation());
  modelEl.setAttribute('draggable', 'false');
  (async () => {
    const res = await window.orkas.invoke('auth.listModels', { provider: entry.provider });
    const list = (res && res.ok && Array.isArray(res.models)) ? res.models : [];
    const options = list.map(m => ({ value: m.id, label: m.name || m.id }));
    // Fall back: include the current model even if it's no longer in the
    // curated list, so we don't visually drop what the entry points at.
    if (!options.some(o => o.value === entry.model)) {
      options.unshift({ value: entry.model, label: entry.modelName || entry.model });
    }
    modelSel.setOptions(options, { value: entry.model });
    modelSel.onChange(async (val) => {
      if (!val || val === entry.model) return;
      _settingsTrackModelSelect('configured_model_entry', entry.provider, val);
      const up = await window.orkas.invoke('auth.updateEntryModel', { entryId: entry.entryId, model: val });
      if (!up || !up.ok) {
        await uiAlert((up && up.error) || t('settings.entries.switch_model_failed'));
        modelSel.setValue(entry.model);
        return;
      }
      await _settingsReload();
    });
  })();

  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  const badge = document.createElement('span');
  if (entry.profileType === 'oauth') {
    badge.className = 'account-type-badge oauth' + (entry.oauthExpired ? ' expired' : '');
    badge.textContent = entry.oauthExpired ? t('settings.entries.oauth_expired') : t('settings.entries.oauth_badge');
  } else if (entry.profileType === 'managed') {
    badge.className = 'account-type-badge';
    badge.textContent = 'Orkas';
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
  const title = `${entry.providerLabel || entry.provider} · ${entry.modelName || entry.model} · ${entry.profileLabel}`;
  if (!(await uiConfirm(t('settings.entries.delete_confirm', { title })))) return;
  _settingsLog.info('remove entry', {
    entry_id: entry.entryId,
    provider: entry.provider,
    model: entry.model,
  });
  const res = await window.orkas.invoke('auth.removeEntry', { entryId: entry.entryId });
  if (!res || !res.ok) {
    _settingsLog.warn('remove entry failed', { entry_id: entry.entryId, error: res && res.error });
    await uiAlert((res && res.error) || t('settings.entries.delete_failed'));
    return;
  }
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
  const list = _settingsState.searchProfiles || [];
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
      getIds: () => (_settingsState.searchProfiles || []).map((x) => x.id),
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
// Same pattern as the search section but the provider list is the
// image-gen capability map (provider_catalog.IMAGE_GEN_BY_PROVIDER).
// Model id is fixed per-provider on the main side — never user-overridable.

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
    const res = await window.orkas.invoke('imageAuth.add', { provider, apiKey, label: 'default' });
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
  const list = _settingsState.imageProfiles || [];
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
      const ok = await uiConfirm(t('settings.image.confirm_delete', { provider: _imageProviderLabel(p.provider) }));
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
      getIds: () => (_settingsState.imageProfiles || []).map((x) => x.id),
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
// user-owned provider keys only; managed Orkas video providers stay stripped.

const _VIDEO_AUTH_PROVIDER_OPTIONS = [
  { id: 'doubao', label: 'DouBao · Seedance', docs: 'https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey' },
];

const _VIDEO_AUTH_MODELS_BY_PROVIDER = {
  doubao: [
    { id: 'doubao-seedance-2-0-260128', name: 'Seedance 2.0' },
  ],
};

function _settingsVideoProviderOptions() {
  return Array.isArray(_settingsState.videoAuthProviderOptions) && _settingsState.videoAuthProviderOptions.length
    ? _settingsState.videoAuthProviderOptions
    : _VIDEO_AUTH_PROVIDER_OPTIONS;
}

function _settingsVideoModelsByProvider() {
  return _settingsState.videoModelsByProvider && typeof _settingsState.videoModelsByProvider === 'object'
    ? _settingsState.videoModelsByProvider
    : _VIDEO_AUTH_MODELS_BY_PROVIDER;
}

function _videoProviderLabel(id) {
  const hit = _settingsVideoProviderOptions().find((p) => p.id === id);
  return hit ? hit.label : id;
}

function _videoModelLabel(provider, model) {
  const list = _settingsVideoModelsByProvider()[provider] || [];
  const hit = list.find((m) => m.id === model);
  return hit ? hit.name : model;
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
  _settingsState.videoModelsByProvider = (res && res.ok && res.modelsByProvider && typeof res.modelsByProvider === 'object')
    ? res.modelsByProvider
    : _VIDEO_AUTH_MODELS_BY_PROVIDER;
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
  const list = _settingsState.videoProfiles || [];
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
      <span class="entry-model">${escapeHtml(_videoModelLabel(p.provider, p.model))}</span>
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
      const ok = await uiConfirm(t('settings.video.confirm_delete', { provider: _videoProviderLabel(p.provider) }));
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
      getIds: () => (_settingsState.videoProfiles || []).map((x) => x.id),
      ipcName: 'videoAuth.reorder',
      onSuccess: async () => {
        await _settingsRefreshVideoProfiles();
        _settingsRenderVideoEntries();
      },
    });

    container.appendChild(row);
  });
}
