// Settings tab switching.
//
// PC's Settings tab binding lives in sync_settings.js, which is stripped from
// the open-source build. Keep this tiny standalone module so the remaining local Settings
// panes still bind after sync.

function activateSettingsTab(name) {
  const tabs = Array.from(document.querySelectorAll('.settings-tab'));
  if (!tabs.length) return;

  // If the requested tab was removed by open-source stripping, fall back to the
  // first surviving tab so no pane stays hidden.
  const existing = tabs.find((btn) => btn.dataset.settingsTab === name);
  const target = existing ? name : tabs[0].dataset.settingsTab;
  const panes = document.querySelectorAll('.settings-tab-pane');

  tabs.forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.settingsTab === target);
  });
  panes.forEach((pane) => {
    pane.hidden = pane.dataset.settingsPane !== target;
  });
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

window.initSettingsTabs = initSettingsTabs;
window.activateSettingsTab = activateSettingsTab;
