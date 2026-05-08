// ─── User Workspace selector ────────────────────────────────────────
// Adds a "workspace" chip to the bottom-left of chat input toolbars
// (new-chat + conversation + agent-edit). Clicking it opens a dropdown
// with Default workspace, recently used workspaces, and a folder picker.
//
// Depends on: ipc-shim.js (apiFetch / window.orkas.invoke)

const _wsLog = createLogger('user-workspace');

/** Cached workspace info. */
let _wsInfo = { currentPath: '', defaultPath: '', isDefault: true, recentPaths: [] };

// ── Workspace display helpers ───────────────────────────────────────

/** Extract just the folder name from an absolute path. */
function _wsFolderName(fullPath) {
  if (!fullPath) return t('workspace.unselected');
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || fullPath;
}

/** Update all workspace chip labels on the page. */
function _updateAllChips() {
  const name = _wsFolderName(_wsInfo.currentPath);
  const chips = document.querySelectorAll('.workspace-chip');
  for (const chip of chips) {
    const label = chip.querySelector('.workspace-chip-label');
    if (label) label.textContent = name;
    chip.title = _wsInfo.currentPath || t('workspace.chip_title');
  }
}

// ── Core actions ────────────────────────────────────────────────────

async function _fetchWorkspaceInfo() {
  try {
    const result = await window.orkas.invoke('workspace.getInfo', {});
    if (result && result.ok) {
      _wsInfo = {
        currentPath: result.currentPath || '',
        defaultPath: result.defaultPath || '',
        isDefault: !!result.isDefault,
        recentPaths: result.recentPaths || [],
      };
    }
  } catch (err) {
    _wsLog.warn('failed to fetch workspace info', err);
  }
}

async function _selectAndSetWorkspace(dirPath) {
  try {
    let selectedPath = dirPath;
    if (!selectedPath) {
      const dirResult = await window.orkas.invoke('workspace.selectDirectory', {});
      if (!dirResult || !dirResult.ok || !dirResult.path) return;
      selectedPath = dirResult.path;
    }
    const setResult = await window.orkas.invoke('workspace.set', { path: selectedPath });
    if (setResult && setResult.ok && setResult.path) {
      await _fetchWorkspaceInfo();
      _updateAllChips();
      _wsLog.info('workspace selected', setResult.path);
    }
  } catch (err) {
    _wsLog.error('workspace selection failed', err);
  }
}

async function _resetWorkspace() {
  try {
    const result = await window.orkas.invoke('workspace.reset', {});
    if (result && result.ok && result.path) {
      await _fetchWorkspaceInfo();
      _updateAllChips();
      _wsLog.info('workspace reset to default', result.path);
    }
  } catch (err) {
    _wsLog.error('workspace reset failed', err);
  }
}

async function _openWorkspaceFolder() {
  try {
    const result = await window.orkas.invoke('workspace.openPath', {});
    if (result && result.ok) {
      _wsLog.info('workspace opened', result.path);
    }
  } catch (err) {
    _wsLog.error('workspace open failed', err);
  }
}

// ── Chip creation ───────────────────────────────────────────────────

function _createWorkspaceChip() {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'workspace-chip';
  chip.title = _wsInfo.currentPath
    || (typeof t === 'function' ? t('workspace.chip_title') : 'Click to pick a workspace');
  chip.innerHTML =
    '<svg class="workspace-chip-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>' +
    '</svg>' +
    '<span class="workspace-chip-label">' + _wsFolderName(_wsInfo.currentPath) + '</span>' +
    '<svg class="workspace-chip-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5">' +
    '<polyline points="6 9 12 15 18 9"/>' +
    '</svg>';

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    _showWorkspaceDropdown(chip);
  });

  return chip;
}

// ── Dropdown menu ───────────────────────────────────────────────────

function _showWorkspaceDropdown(anchor) {
  // Remove any existing dropdown
  const old = document.getElementById('workspace-menu');
  if (old) { old.remove(); return; }

  const menu = document.createElement('div');
  menu.id = 'workspace-menu';
  menu.className = 'workspace-menu';

  // Flip chevron
  const chevron = anchor.querySelector('.workspace-chip-chevron');
  if (chevron) anchor.classList.add('workspace-chip--open');

  // ── Default section ──
  const defaultHeader = document.createElement('div');
  defaultHeader.className = 'workspace-menu-header';
  defaultHeader.textContent = t('workspace.default_header');
  menu.appendChild(defaultHeader);

  const defaultItem = _createMenuItem(
    _wsFolderName(_wsInfo.defaultPath),
    _wsInfo.isDefault,
    () => { _closeMenu(); _resetWorkspace(); }
  );
  menu.appendChild(defaultItem);

  // ── Recently section ──
  // If current is not default, show it first in recents with checkmark
  const showRecents = [];
  if (!_wsInfo.isDefault) {
    showRecents.push({ path: _wsInfo.currentPath, active: true });
  }
  for (const rp of _wsInfo.recentPaths) {
    if (rp !== _wsInfo.currentPath) {
      showRecents.push({ path: rp, active: false });
    }
  }
  if (showRecents.length > 0) {
    const recentHeader = document.createElement('div');
    recentHeader.className = 'workspace-menu-header';
    recentHeader.textContent = t('workspace.recent_header');
    menu.appendChild(recentHeader);

    for (const entry of showRecents) {
      const item = _createMenuItem(
        _wsFolderName(entry.path),
        entry.active,
        entry.active ? () => { _closeMenu(); } : () => { _closeMenu(); _selectAndSetWorkspace(entry.path); }
      );
      item.title = entry.path;
      menu.appendChild(item);
    }
  }

  // ── Separator + Select a folder ──
  const sep = document.createElement('div');
  sep.className = 'workspace-menu-sep';
  menu.appendChild(sep);

  const selectItem = document.createElement('div');
  selectItem.className = 'workspace-menu-item';
  selectItem.textContent = t('workspace.pick_folder');
  selectItem.addEventListener('click', () => {
    _closeMenu();
    _selectAndSetWorkspace();
  });
  menu.appendChild(selectItem);

  const openItem = document.createElement('div');
  openItem.className = 'workspace-menu-item';
  openItem.textContent = t('workspace.open_folder');
  openItem.addEventListener('click', () => {
    _closeMenu();
    _openWorkspaceFolder();
  });
  menu.appendChild(openItem);

  // Position above the anchor
  const rect = anchor.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.left = rect.left + 'px';
  menu.style.bottom = (window.innerHeight - rect.top + 4) + 'px';

  document.body.appendChild(menu);

  function _closeMenu() {
    menu.remove();
    anchor.classList.remove('workspace-chip--open');
    document.removeEventListener('mousedown', _onOutside);
  }
  function _onOutside(e) {
    if (!menu.contains(e.target) && !anchor.contains(e.target)) {
      _closeMenu();
    }
  }
  setTimeout(() => document.addEventListener('mousedown', _onOutside), 0);
}

function _createMenuItem(text, isActive, onClick) {
  const item = document.createElement('div');
  item.className = 'workspace-menu-item' + (isActive ? ' workspace-menu-item--active' : '');
  const label = document.createElement('span');
  label.textContent = text;
  item.appendChild(label);
  if (isActive) {
    const check = document.createElement('span');
    check.className = 'workspace-menu-check';
    check.textContent = '✓';
    item.appendChild(check);
  }
  item.addEventListener('click', onClick);
  return item;
}

// ── Init ────────────────────────────────────────────────────────────

async function initUserWorkspace() {
  await _fetchWorkspaceInfo();

  const toolbarIds = [
    '.new-chat-input-wrapper .chat-input-toolbar',
    '#panel-conversation .chat-input-toolbar',
  ];
  for (const sel of toolbarIds) {
    const toolbar = document.querySelector(sel);
    if (toolbar) {
      toolbar.appendChild(_createWorkspaceChip());
    }
  }
}
