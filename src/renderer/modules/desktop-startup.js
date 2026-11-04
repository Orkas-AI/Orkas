// Device-scoped OS startup consent. Guidance is offered only on an Automation tab visit.
(() => {
  const toggle = document.getElementById('settings-startup-toggle');
  const status = document.getElementById('settings-startup-status');
  const settingsLink = document.getElementById('settings-startup-open-settings');
  let state = null, revision = 0, saving = false, checking = false, activePrompt = null;
  const invoke = (channel, payload) => window.orkas.invoke(channel, payload || {});
  const errorText = code => t(code === 'E_STARTUP_UNAVAILABLE' ? 'settings.startup.unavailable' : code === 'E_STARTUP_READ' ? 'settings.startup.read_failed' : 'settings.startup.save_failed');
  const paint = () => {
    if (toggle) { toggle.checked = state?.enabled === true; toggle.disabled = saving || !state?.available; }
    if (status) {
      const key = !state ? 'read_failed' : state.status === 'approval' ? 'approval' : '';
      status.textContent = key ? t(`settings.startup.${key}`) : '';
      status.hidden = !key;
    }
    if (settingsLink) {
      settingsLink.hidden = state?.status !== 'approval';
      settingsLink.style.display = settingsLink.hidden ? 'none' : '';
    }
  };
  async function refresh() {
    if (saving) return;
    const token = ++revision;
    try {
      const result = await invoke('desktop.getStartup');
      if (token !== revision || saving) return;
      if (!result.ok || typeof result.startup?.enabled !== 'boolean') throw new Error();
      state = result.startup;
    } catch { if (token !== revision) return; state = null; }
    paint();
  }
  async function enable(value) {
    ++revision; saving = true; paint();
    try {
      const result = await invoke('desktop.setStartup', { enabled: value });
      if (!result.ok || !result.startup) return errorText(result.code);
      state = result.startup;
      if (state.status === 'approval') uiToast(t('settings.startup.approval'));
      return null;
    } catch { return errorText('E_STARTUP_SAVE'); }
    finally { saving = false; paint(); }
  }
  toggle?.addEventListener('change', async () => {
    if (saving) return;
    const error = await enable(toggle.checked);
    // Read back even after a failure: the OS might have accepted a partial change.
    if (error) { uiToast(error, { variant: 'error' }); await refresh(); }
  });
  settingsLink?.addEventListener('click', async () => {
    try { const result = await invoke('desktop.openStartupSettings'); if (!result.ok) throw new Error(); }
    catch { uiToast(t('settings.startup.open_failed'), { variant: 'error' }); }
  });
  async function visitAutomation() {
    if (checking || activePrompt || !document.getElementById('panel-auto')?.classList.contains('active') || document.querySelector('.modal-overlay.open')) return;
    checking = true;
    let claimed = false;
    try {
      const result = await invoke('desktop.claimStartupPrompt');
      if (!result.ok || !result.id) return;
      claimed = true;
      if (!document.getElementById('panel-auto')?.classList.contains('active') || document.querySelector('.modal-overlay.open')) return;
      const abort = new AbortController(); activePrompt = abort;
      let acknowledged;
      // uiChoice appends the standard modal synchronously before returning its promise.
      const choice = uiChoice({
        title: t('settings.startup.prompt_title'),
        message: t('settings.startup.prompt_body') + '\n' + t('settings.startup.prompt_settings'),
        cancelLabel: t('settings.startup.later'),
        choices: [{ id: 'enable-startup', label: t('settings.startup.enable') }],
        signal: abort.signal,
        onChoice: async () => {
          if (!await acknowledged) return errorText('E_STARTUP_SAVE');
          return enable(true);
        },
      });
      acknowledged = invoke('desktop.markStartupPromptShown', { id: result.id }).then(response => response.ok && response.shown === true, () => false);
      if (!await acknowledged) { abort.abort(); return; }
      await choice;
    } catch {
      // A failed lookup must leave guidance eligible on a later tab visit.
      createLogger('desktop-startup').warn('startup guidance unavailable');
    } finally {
      checking = false; activePrompt = null;
      if (claimed) { try { await invoke('desktop.releaseStartupPrompt'); } catch { /* lease also expires */ } }
    }
  }
  window.DesktopStartup = { visitAutomation };
  window.addEventListener('focus', () => { void refresh(); });
  window.addEventListener('i18n-change', paint);
  void refresh();
})();
