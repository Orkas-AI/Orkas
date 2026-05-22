// Settings tab switching.
//
// Lifted out of `sync_settings.js` (stripped from the OrkasOpen build) so the
// 4-tab restructure still binds. Sync-card init is gone here on purpose —
// OrkasOpen has no cloud sync, so the 数据 tab only shows the 本地 section.
//
// Settings.js calls `initSettingsTabs()` under a `typeof === 'function'` guard,
// which is what made the old "tabs unclickable" bug silent.

function activateSettingsTab(name) {
  const tabs = Array.from(document.querySelectorAll('.settings-tab'));
  if (!tabs.length) return;
  // If the requested tab was removed (e.g. the 账号 tab is stripped here),
  // fall through to the first surviving tab so no pane stays hidden.
  const existing = tabs.find((b) => b.dataset.settingsTab === name);
  const target = existing ? name : tabs[0].dataset.settingsTab;
  const panes = document.querySelectorAll('.settings-tab-pane');
  tabs.forEach((b) => b.classList.toggle('is-active', b.dataset.settingsTab === target));
  panes.forEach((p) => { p.hidden = p.dataset.settingsPane !== target; });
}

function initSettingsTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  if (!tabs.length) return;
  tabs.forEach((btn) => {
    btn.addEventListener('click', () => activateSettingsTab(btn.dataset.settingsTab));
  });
  const defaultTab = document.querySelector('.settings-tab.is-active')?.dataset.settingsTab
    || tabs[0]?.dataset.settingsTab;
  activateSettingsTab(defaultTab);
}

// Hand out for settings.js (which guards on typeof) + cross-module navigation
// that needs to jump straight to a tab (e.g. the model-guard banner CTA).
window.initSettingsTabs = initSettingsTabs;
window.activateSettingsTab = activateSettingsTab;
