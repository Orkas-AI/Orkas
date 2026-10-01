// Local Settings tab binding. Hosted data hooks and telemetry are omitted.

function activateSettingsTab(name) {
  const tabs = Array.from(document.querySelectorAll('.settings-tab'));
  if (!tabs.length) return;

  // If the requested tab was removed by open-source stripping, fall back to the
  // first surviving tab so no pane stays hidden.
  const existing = tabs.find((btn) => btn.dataset.settingsTab === name);
  const target = existing ? name : tabs[0].dataset.settingsTab;
  const panes = document.querySelectorAll('.settings-tab-pane');

  tabs.forEach((btn) => {
    const active = btn.dataset.settingsTab === target;
    btn.classList.toggle('is-active', active);
    if (typeof btn.setAttribute === 'function') {
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    btn.tabIndex = active ? 0 : -1;
  });
  panes.forEach((pane) => {
    pane.hidden = pane.dataset.settingsPane !== target;
  });
}

const _settingsTabsBound = new WeakSet();

function initSettingsTabs() {
  const tabs = document.querySelectorAll('.settings-tab');
  if (!tabs.length) return;

  const tabList = Array.from(tabs);
  const switchTo = (btn, focus = false) => {
    activateSettingsTab(btn.dataset.settingsTab);
    if (focus && typeof btn.focus === 'function') btn.focus();
  };

  tabs.forEach((btn) => {
    if (_settingsTabsBound.has(btn)) return;
    _settingsTabsBound.add(btn);
    btn.addEventListener('click', () => switchTo(btn));
    btn.addEventListener('keydown', (event) => {
      if (!event || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const index = tabList.indexOf(btn);
      if (index < 0) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabList.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabList.length) % tabList.length;
      switchTo(tabList[next], true);
    });
  });

  const defaultTab = document.querySelector('.settings-tab.is-active')?.dataset.settingsTab
    || tabs[0]?.dataset.settingsTab;
  activateSettingsTab(defaultTab);
}

window.initSettingsTabs = initSettingsTabs;
window.activateSettingsTab = activateSettingsTab;

// The settings shell is already parsed; bind before the lazy feature can load.
initSettingsTabs();
