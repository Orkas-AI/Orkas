// ─── User Workspace selector ────────────────────────────────────────
// Adds a "workspace" chip to the bottom bar of chat input toolbars
// (new-chat + conversation). Clicking it opens a dropdown with Default
// workspace, recently used workspaces, and a folder picker.
//
// **Scoped resolution** (per CLAUDE.md projects feature):
//   - On the conversation panel, the chip resolves scope from the active
//     `currentCid` — main looks up `conv.project_id` and operates on the
//     project's per-scope workspace entry. Changes apply to every conv in
//     that project.
//   - On the commander (new-chat) panel, scope is always default — new
//     conversations created from the empty-state composer are orphan;
//     project binding happens only inside per-project pages.
//
// Depends on: ipc-shim.js (apiFetch / window.orkas.invoke)

const _wsLog = (typeof createLogger === 'function')
  ? createLogger('user-workspace')
  : { info() {}, warn() {}, error() {} };

/** Cached workspace info, keyed by chip target. The chip on the conversation
 *  panel and the chip on the commander panel may show different paths when
 *  they resolve to different scopes (e.g. conv belongs to project A, commander
 *  has project B picked). */
const _wsInfoByTarget = {
  'new-chat': { currentPath: '', defaultPath: '', isDefault: true, recentPaths: [], scope: 'default' },
  'conversation': { currentPath: '', defaultPath: '', isDefault: true, recentPaths: [], scope: 'default' },
  project: { currentPath: '', defaultPath: '', isDefault: true, recentPaths: [], scope: 'default' },
};

// ── Workspace display helpers ───────────────────────────────────────

/** Extract just the folder name from an absolute path. */
function _wsFolderName(fullPath) {
  if (!fullPath) return t('workspace.unselected');
  const parts = fullPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || fullPath;
}

/** Build the scope hint payload for a given chip target. The conversation
 *  panel passes `cid` (main resolves cid → conv.project_id); the commander
 *  panel passes `projectId` from the current commander chip pick. */
function _wsScopeHintFor(target) {
  if (target === 'conversation') {
    return currentCid ? { cid: currentCid } : {};
  }
  if (target === 'project') {
    const pid = (typeof _projectDetailPid !== 'undefined') ? (_projectDetailPid || '') : '';
    return pid ? { projectId: pid } : {};
  }
  // new-chat / commander panel — always orphan, falls back to default workspace.
  return {};
}

/** Update workspace chip label for one or both targets. */
function _updateChipForTarget(target) {
  const info = _wsInfoByTarget[target] || _wsInfoByTarget['conversation'];
  const sel = target === 'new-chat'
    ? '#panel-new-chat .workspace-chip'
    : (target === 'project' ? '#panel-project .workspace-chip' : '#panel-conversation .workspace-chip');
  const chip = document.querySelector(sel);
  if (!chip) return;
  const label = chip.querySelector('.workspace-chip-label');
  if (label) label.textContent = _wsFolderName(info.currentPath);
  // Tooltip carries the full path + scope context (project vs default).
  let tooltip = info.currentPath || t('workspace.chip_title');
  if (info.scope === 'project' && typeof getCommanderProjectIdName === 'function') {
    // Resolve a friendly project name when available; fallback to the id.
    const name = getCommanderProjectIdName(info.projectId);
    if (name) tooltip += ` · ${t('workspace.scope_project', { name })}`;
  } else if (info.scope === 'project') {
    tooltip += ` · ${t('workspace.scope_project_generic')}`;
  }
  chip.title = tooltip;
}

function _updateAllChips() {
  _updateChipForTarget('new-chat');
  _updateChipForTarget('conversation');
  _updateChipForTarget('project');
}

// ── Core actions ────────────────────────────────────────────────────

async function _fetchWorkspaceInfo(target) {
  const hint = _wsScopeHintFor(target);
  try {
    const result = await window.orkas.invoke('workspace.getInfo', hint);
    if (result && result.ok) {
      _wsInfoByTarget[target] = {
        currentPath: result.currentPath || '',
        defaultPath: result.defaultPath || '',
        isDefault: !!result.isDefault,
        recentPaths: result.recentPaths || [],
        scope: result.scope || 'default',
        ...(result.projectId ? { projectId: result.projectId } : {}),
      };
    }
  } catch (err) {
    _wsLog.warn('failed to fetch workspace info', err);
  }
}

/** Refetch info for both targets — called on boot, on commander chip change,
 *  and on conversation switch. */
async function _refreshAllWorkspaceInfo() {
  await Promise.all([_fetchWorkspaceInfo('new-chat'), _fetchWorkspaceInfo('conversation'), _fetchWorkspaceInfo('project')]);
  _updateAllChips();
}

function _showWorkspaceSetFailure(errOrMessage) {
  const raw = typeof errOrMessage === 'string'
    ? errOrMessage
    : ((errOrMessage && errOrMessage.message) || String(errOrMessage || ''));
  const fallback = t('workspace.set_failed');
  const message = raw && raw !== '[object Object]' ? raw : fallback;
  if (typeof uiToast === 'function') {
    uiToast(message, { variant: 'warning', timeoutMs: 6000 });
  } else if (typeof uiAlert === 'function') {
    uiAlert(message);
  }
}

async function _selectAndSetWorkspace(target, dirPath) {
  const hint = _wsScopeHintFor(target);
  try {
    let selectedPath = dirPath;
    if (!selectedPath) {
      const dirResult = await window.orkas.invoke('workspace.selectDirectory', {});
      if (!dirResult || !dirResult.ok || !dirResult.path) return;
      selectedPath = dirResult.path;
    }
    const setResult = await window.orkas.invoke('workspace.set', { path: selectedPath, ...hint });
    if (setResult && setResult.ok && setResult.path) {
      await _refreshAllWorkspaceInfo();
      _wsLog.info('workspace selected', { target, path: setResult.path });
    } else {
      _showWorkspaceSetFailure((setResult && setResult.error) || t('workspace.set_failed'));
      _wsLog.warn('workspace selection rejected', { target, path: selectedPath, error: setResult && setResult.error });
    }
  } catch (err) {
    _showWorkspaceSetFailure(err);
    _wsLog.error('workspace selection failed', err);
  }
}

async function _resetWorkspace(target) {
  const hint = _wsScopeHintFor(target);
  try {
    const result = await window.orkas.invoke('workspace.reset', hint);
    if (result && result.ok && result.path) {
      await _refreshAllWorkspaceInfo();
      _wsLog.info('workspace reset', { target, path: result.path });
    }
  } catch (err) {
    _wsLog.error('workspace reset failed', err);
  }
}

async function _openWorkspaceFolder(target) {
  const hint = _wsScopeHintFor(target);
  try {
    const result = await window.orkas.invoke('workspace.openPath', hint);
    if (result && result.ok) {
      _wsLog.info('workspace opened', result.path);
    }
  } catch (err) {
    _wsLog.error('workspace open failed', err);
  }
}

// ── Chip creation ───────────────────────────────────────────────────

function _createWorkspaceChip(target) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'workspace-chip';
  chip.dataset.wsTarget = target;
  chip.title = (t('workspace.chip_title'));
  // Text-prefix layout matches the recipient / project chip pattern
  // ("给:" / "项目:" / "工作区:") — the folder icon was replaced per UX
  // feedback so all three left-side chips read as "[label]: [value]".
  const prefix = (t('workspace.chip_label'));
  const chevronIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-down', 'workspace-chip-chevron')
    : '';
  chip.innerHTML =
    `<span class="workspace-chip-prefix">${escapeHtml(prefix)}</span>` +
    '<span class="workspace-chip-label"></span>' +
    chevronIcon;

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    _showWorkspaceDropdown(chip, target);
  });

  return chip;
}

// ── Dropdown menu ───────────────────────────────────────────────────

function _showWorkspaceDropdown(anchor, target) {
  const old = document.getElementById('workspace-menu');
  if (old) { old.remove(); return; }

  const info = _wsInfoByTarget[target] || _wsInfoByTarget['conversation'];

  const menu = document.createElement('div');
  menu.id = 'workspace-menu';
  menu.className = 'workspace-menu';

  anchor.classList.add('workspace-chip--open');

  // ── Default section ──
  const defaultHeader = document.createElement('div');
  defaultHeader.className = 'workspace-menu-header';
  defaultHeader.textContent = t('workspace.default_header');
  menu.appendChild(defaultHeader);

  const defaultItem = _createMenuItem(
    _wsFolderName(info.defaultPath),
    info.isDefault,
    () => { _closeMenu(); _resetWorkspace(target); }
  );
  menu.appendChild(defaultItem);

  // ── Recently section ──
  const showRecents = [];
  if (!info.isDefault) {
    showRecents.push({ path: info.currentPath, active: true });
  }
  for (const rp of (info.recentPaths || [])) {
    if (rp !== info.currentPath) {
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
        entry.active ? () => { _closeMenu(); } : () => { _closeMenu(); _selectAndSetWorkspace(target, entry.path); }
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
    _selectAndSetWorkspace(target);
  });
  menu.appendChild(selectItem);

  const openItem = document.createElement('div');
  openItem.className = 'workspace-menu-item';
  openItem.textContent = t('workspace.open_folder');
  openItem.addEventListener('click', () => {
    _closeMenu();
    _openWorkspaceFolder(target);
  });
  menu.appendChild(openItem);

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
    check.innerHTML = typeof window !== 'undefined' && typeof window.uiIconHtml === 'function'
      ? window.uiIconHtml('check', 'ui-icon workspace-check-icon')
      : '';
    item.appendChild(check);
  }
  item.addEventListener('click', onClick);
  return item;
}

// ── Init ────────────────────────────────────────────────────────────

async function initUserWorkspace() {
  // Insert one chip per panel into the bottom-bar immediately after the
  // recipient chip per PC/docs/design/PATTERNS.md P11
  // ([To] | [workspace] | [skill] | ...). Project-detail panel has no
  // recipient chip — fall back to insert-before-send there.
  _mountWorkspaceChipInBar(document.querySelector('#panel-new-chat .chat-bottom-bar'), 'new-chat');
  _mountWorkspaceChipInBar(document.querySelector('#panel-conversation .chat-bottom-bar'), 'conversation');
  _mountWorkspaceChipInBar(document.querySelector('#panel-project .chat-bottom-bar'), 'project');

  // Before `_restoreLastView` runs there is no active conversation/project,
  // so all three targets resolve to the same default scope. Read that config
  // once instead of issuing three identical startup IPC/disk reads.
  await _fetchWorkspaceInfo('new-chat');
  _wsInfoByTarget.conversation = { ..._wsInfoByTarget['new-chat'] };
  _wsInfoByTarget.project = { ..._wsInfoByTarget['new-chat'] };
  _updateAllChips();
}

function _mountWorkspaceChipInBar(bar, target) {
  if (!bar) return null;

  const existing = Array.from(bar.querySelectorAll(`.workspace-chip[data-ws-target="${target}"]`));
  const chip = existing[0] || _createWorkspaceChip(target);
  for (const duplicate of existing.slice(1)) duplicate.remove();

  const anchor = bar.querySelector('.chat-recipient-chip');
  if (anchor) {
    const ref = anchor.nextSibling;
    if (ref !== chip) bar.insertBefore(chip, ref);
    return chip;
  }

  const sendBtn = bar.querySelector('.chat-send-btn');
  if (sendBtn && sendBtn !== chip) bar.insertBefore(chip, sendBtn);
  else if (!chip.parentNode) bar.appendChild(chip);
  return chip;
}

/** Public: called by conversation.js when the active cid changes (entering a
 *  conversation, or switching tabs while one is mounted). Also called by
 *  projects.js when the commander chip's project pick changes. */
async function refreshWorkspaceChip() {
  const target = (typeof currentView !== 'undefined' && currentView === 'project')
    ? 'project'
    : ((typeof currentView !== 'undefined' && currentView === 'conversation') ? 'conversation' : 'new-chat');
  await _fetchWorkspaceInfo(target);
  _updateChipForTarget(target);
}

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = { _mountWorkspaceChipInBar };
}
