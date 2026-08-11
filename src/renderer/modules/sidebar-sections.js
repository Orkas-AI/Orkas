// Top-level Projects and Tasks section collapse state.
(function () {
  const STORAGE_KEY = 'sidebar.sectionCollapsed';
  const SECTION_CONFIG = [
    {
      name: 'projects',
      sectionSelector: '.sidebar-projects-section',
      toggleId: 'projects-section-toggle',
      bodyId: 'projects-list',
      labelKey: 'sidebar.projects',
    },
    {
      name: 'tasks',
      sectionSelector: '.sidebar-conversations-section',
      toggleId: 'tasks-section-toggle',
      bodyId: 'conversation-list',
      labelKey: 'sidebar.conversations',
    },
  ];

  function readCollapsedState(storage) {
    try {
      const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return Object.fromEntries(
        SECTION_CONFIG.map(({ name }) => [name, parsed[name] === true]),
      );
    } catch (_) {
      return {};
    }
  }

  function writeCollapsedState(storage, state) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (_) {}
  }

  function applySectionState(doc, config, collapsed, translate) {
    const section = doc.querySelector(config.sectionSelector);
    const toggle = doc.getElementById(config.toggleId);
    const body = doc.getElementById(config.bodyId);
    if (!section || !toggle || !body) return;

    section.classList.toggle('is-collapsed', collapsed);
    body.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    const sectionLabel = translate(config.labelKey);
    toggle.setAttribute(
      'aria-label',
      translate(collapsed ? 'sidebar.section_expand' : 'sidebar.section_collapse', { section: sectionLabel }),
    );
  }

  function trackSidebarSectionToggle(detail, monitor) {
    try {
      if (monitor && typeof monitor.click === 'function') {
        monitor.click('sidebar_section_toggle', {
          section: detail.name,
          control_state: detail.collapsed ? 'close' : 'open',
        });
      }
    } catch (_) {}
  }

  function initSidebarSections(doc, storage, translate, onToggle) {
    const state = readCollapsedState(storage);
    const applyAll = () => SECTION_CONFIG.forEach((config) => {
      applySectionState(doc, config, state[config.name] === true, translate);
    });

    SECTION_CONFIG.forEach((config) => {
      const toggle = doc.getElementById(config.toggleId);
      if (!toggle || toggle.dataset.sectionCollapseBound === '1') return;
      toggle.dataset.sectionCollapseBound = '1';
      toggle.addEventListener('click', () => {
        state[config.name] = state[config.name] !== true;
        writeCollapsedState(storage, state);
        applySectionState(doc, config, state[config.name], translate);
        if (typeof onToggle === 'function') {
          onToggle({ name: config.name, collapsed: state[config.name] });
        }
      });
    });
    applyAll();
    return { state, applyAll };
  }

  function start() {
    const controller = initSidebarSections(
      document,
      localStorage,
      (key, params) => t(key, params),
      (detail) => {
        trackSidebarSectionToggle(detail, window.Monitor);
        window.dispatchEvent(new CustomEvent('sidebar-section-toggle', { detail }));
      },
    );
    window.addEventListener('i18n-change', controller.applyAll);
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      STORAGE_KEY,
      SECTION_CONFIG,
      readCollapsedState,
      applySectionState,
      initSidebarSections,
      trackSidebarSectionToggle,
    };
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }
})();
