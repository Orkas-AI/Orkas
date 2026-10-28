// ─── Local CLI agents (renderer side) ─────────────────────────────────
//
// Two surfaces share this module:
//   1. The agent-modal "external" tab — selector lists every detected CLI
//      and defaults to the first installed candidate. Selecting one auto-fills
//      name + description from CLI_DEFAULTS so a single click is enough to
//      ship an external-agent shell.
//   2. The agent-detail runtime selector (existing CLI-bound agents)
//      lives in agents.js; this module just supplies the registry list.
//
// CLI_DEFAULTS holds the bilingual seed values used by both create
// and edit. `description_zh` + `description_en` are stored side-by-
// side on the agent so locale switches are zero-cost; `name` is a
// single brand label (the user can rename to disambiguate two
// instances of the same CLI bound to different project directories).
//
// Detection starts when the External Agent selector/runtime picker is opened.
// The create panel first performs path-only discovery so it can paint a list,
// then validates versions in the background. The last successful validated
// result stays cached for the renderer lifetime; entering the External create
// panel always refreshes it. Version probes run concurrently and each result
// is painted as soon as it completes, so one slow CLI does not hold back the
// others. Startup must not probe a surface the user may never visit.

const _localAgentsLog = createLogger('local-agents');

// Single source of truth for default name + description per CLI type.
// English-source (per CLAUDE.md "English-only project text") with the
// Chinese variant carried alongside for the agent description pair.
const CLI_DEFAULTS = {
  claude: {
    name: 'ClaudeCode',
    description_zh: '理解和维护项目代码，解答代码问题、开发功能、修复缺陷和审查改动，提供代码修改或分析建议。',
    description_en: 'Understands and maintains project code, answers code questions, develops features, fixes bugs, and reviews changes, providing code changes or analysis and recommendations.',
    isCoding: true,
  },
  codex: {
    name: 'Codex',
    description_zh: '理解和维护项目代码，解答代码问题、开发功能、修复缺陷和审查改动，提供代码修改或分析建议。',
    description_en: 'Understands and maintains project code, answers code questions, develops features, fixes bugs, and reviews changes, providing code changes or analysis and recommendations.',
    isCoding: true,
  },
  openclaw: {
    name: 'OpenClaw',
    description_zh: '协助处理日常事务，包括查找资料、撰写内容、整理文件和执行自动化任务，提供所需内容及处理结果。',
    description_en: 'Helps with everyday tasks, including finding information, writing content, organizing files, and running automated tasks, providing the requested content and results.',
    isCoding: false,
  },
  opencode: {
    name: 'OpenCode',
    description_zh: '理解和维护项目代码，解答代码问题、开发功能、修复缺陷和审查改动，提供代码修改或分析建议。',
    description_en: 'Understands and maintains project code, answers code questions, develops features, fixes bugs, and reviews changes, providing code changes or analysis and recommendations.',
    isCoding: true,
  },
  hermes: {
    name: 'Hermes',
    description_zh: '完成资料研究、代码开发和需要多个步骤的任务，提供研究结论、代码修改或生成的文件。',
    description_en: 'Carries out research, code development, and tasks that require multiple steps, providing research findings, code changes, or generated files.',
    isCoding: false,
  },
};

/** Defaults for a given CLI type, or null when the type is unknown. */
function getCliDefaults(cliType) {
  return cliType && Object.prototype.hasOwnProperty.call(CLI_DEFAULTS, cliType)
    ? CLI_DEFAULTS[cliType]
    : null;
}

/** True when the CLI exposes the coding-agent project-directory setting.
 *  Mirrors
 *  `cliIsCodingAgent` in features/agents.ts — keep in sync. */
function cliIsCodingAgent(cliType) {
  const d = getCliDefaults(cliType);
  return !!(d && d.isCoding);
}

/** Localized recovery hint for an unavailable registry entry. Keep the
 * registry error code intact instead of collapsing every unavailable CLI
 * into "not installed". */
function getLocalCliUnavailableHint(entry) {
  if (entry?.error === 'version_timeout') {
    return t('agent.cli_version_timeout');
  }
  if (entry?.error === 'version_unknown') {
    return t('agent.cli_version_unknown');
  }
  if (entry?.error === 'version_too_old') {
    return t('agent.cli_version_too_old', { version: entry.version || '?' });
  }
  return t('agent.cli_not_found');
}

let _localCliEntries = null;
let _localCliEntriesInFlight = null;
let _localCliPresenceEntries = null;
let _localCliPresenceInFlight = null;
let _externalCliVisibleEntries = [];

/** Bounded UI state for the current renderer-side discovery cache.
 * A background refresh never hides a completed cache; `detecting` is reserved
 * for a cold path lookup where no result exists yet. Once path-only discovery
 * finds a CLI, availability can be reported immediately while its version is
 * still being validated. */
function getLocalCliAvailabilityState() {
  if (_localCliEntries) {
    return _localCliEntries.some(entry => entry?.available === true)
      ? 'available'
      : 'none';
  }
  if (_localCliPresenceEntries) {
    return _localCliPresenceEntries.some(entry => entry?.available === true)
      ? 'available'
      : 'none';
  }
  return (_localCliPresenceInFlight || _localCliEntriesInFlight)
    ? 'detecting'
    : 'none';
}

/** Fast filesystem-only discovery for the create selector. It intentionally
 * bypasses both renderer and main-process caches, and does not run any CLI
 * version command. Concurrent panel mounts share the same request. */
async function _findInstalledLocalCliEntries() {
  if (_localCliPresenceInFlight) return _localCliPresenceInFlight;
  const request = (async () => {
    try {
      const res = await window.orkas.invoke('localAgents.list', {
        force: true,
        validate: false,
      });
      const entries = Array.isArray(res?.entries) ? res.entries : [];
      _localCliPresenceEntries = entries;
      return { ok: true, entries };
    } catch (e) {
      _localAgentsLog.warn('localAgents path discovery failed', e);
      return { ok: false, entries: [] };
    }
  })();
  _localCliPresenceInFlight = request;
  try {
    return await request;
  } finally {
    if (_localCliPresenceInFlight === request) _localCliPresenceInFlight = null;
  }
}

async function _loadLocalCliEntriesResult({ force = false } = {}) {
  if (_localCliEntries && !force) {
    return { ok: true, entries: _localCliEntries };
  }
  // Coalesce the create panel and detail selector if they become visible
  // together. Each main-process pass can spawn several version commands.
  if (_localCliEntriesInFlight) return _localCliEntriesInFlight;
  const request = (async () => {
    try {
      const res = await window.orkas.invoke('localAgents.list', { force });
      _localCliEntries = Array.isArray(res?.entries) ? res.entries : [];
      return { ok: true, entries: _localCliEntries };
    } catch (e) {
      _localAgentsLog.warn('localAgents.list failed', e);
      // Keep an already-rendered result usable when a background refresh
      // fails. A cold failure is not promoted to cache, so the next panel
      // entry still presents the cold "detecting" state and retries.
      return { ok: false, entries: _localCliEntries || [] };
    }
  })();
  _localCliEntriesInFlight = request;
  try {
    return await request;
  } finally {
    if (_localCliEntriesInFlight === request) _localCliEntriesInFlight = null;
  }
}

function _replaceLocalCliEntry(entries, nextEntry) {
  return entries.map(entry => entry?.type === nextEntry?.type ? nextEntry : entry);
}

/** Validate installed CLI entries concurrently through the single-type IPC.
 * Each successful response is merged into the stable presence-order list and
 * surfaced immediately. The aggregate promise still resolves only after all
 * probes settle so callers can cache one fully validated snapshot. */
async function _validateInstalledLocalCliEntries(entries, installedTypes, onEntry) {
  if (_localCliEntriesInFlight) return _localCliEntriesInFlight;
  const initialEntries = Array.isArray(entries)
    ? entries.map(entry => {
      if (entry?.available === true || entry?.validation !== 'pending') return entry;
      const { validation: _validation, ...completedEntry } = entry;
      return completedEntry;
    })
    : [];
  const types = Array.isArray(installedTypes) ? installedTypes : [];
  const request = (async () => {
    let nextEntries = initialEntries;
    let failedCount = 0;
    await Promise.all(types.map(async (type) => {
      try {
        const res = await window.orkas.invoke('localAgents.detect', { type });
        const entry = res?.entry;
        if (!entry || entry.type !== type) {
          throw new Error('invalid localAgents.detect response');
        }
        nextEntries = _replaceLocalCliEntry(nextEntries, entry);
        _localCliPresenceEntries = nextEntries;
        if (typeof onEntry === 'function') {
          try { onEntry(nextEntries, entry); } catch (_) {}
        }
      } catch (e) {
        failedCount += 1;
        _localAgentsLog.warn(`localAgents.detect failed for ${type}`, e);
      }
    }));
    const ok = failedCount === 0;
    if (ok) _localCliEntries = nextEntries;
    return { ok, entries: nextEntries };
  })();
  _localCliEntriesInFlight = request;
  try {
    return await request;
  } finally {
    if (_localCliEntriesInFlight === request) _localCliEntriesInFlight = null;
  }
}

async function loadLocalCliEntries(options = {}) {
  const result = await _loadLocalCliEntriesResult(options);
  return result.entries;
}

// ── External-tab CLI selector (create modal) ───────────────────────────
//
let _extCliSelectApi = null;
let _externalCliLastOnChange = null;
let _cliUpgradeControlId = 0;

function _setExternalCliDetectionBusy(
  busy,
  { disableSelect = false, showTitleStatus = busy } = {},
) {
  const mount = document.getElementById('agent-modal-ext-cli-select');
  const status = document.getElementById('agent-modal-ext-cli-status');
  if (status) status.hidden = !(busy && showTitleStatus);
  if (!mount) return;
  mount.classList.toggle('is-detecting', busy);
  mount.setAttribute('aria-busy', busy ? 'true' : 'false');
  const trigger = mount.querySelector('.ai-select-trigger');
  if (trigger) {
    trigger.disabled = busy
      ? !!disableSelect
      : mount.classList.contains('is-empty');
  }
}

function _externalCliOptions(entries) {
  return entries
    .map(e => ({
      value: e.type,
      label: `${(getCliDefaults(e.type)?.name) || e.type}${e.version ? ` (${e.version})` : ''}`,
      ...(e.available !== true
        ? {
            hint: e.error === 'version_too_old'
              ? t('agent_modal.ext_cli_status_version_too_old', { version: e.version || '?' })
              : (e.error === 'version_timeout'
                ? t('agent_modal.ext_cli_status_version_timeout')
                : (e.error === 'version_unknown'
                  ? t('agent_modal.ext_cli_status_version_unknown')
                  : t('agent_modal.ext_cli_status_not_found'))),
            ...(e.error === 'version_too_old'
              || e.error === 'version_timeout'
              || e.error === 'version_unknown'
              ? { iconName: 'warning' }
              : {}),
            disabled: true,
          }
        : {}),
    }));
}

function _externalCliSelectionWarning(cliType) {
  if (!cliType) return '';
  const entry = _externalCliVisibleEntries.find(candidate => candidate?.type === cliType);
  return entry?.error === 'version_too_old'
    ? getLocalCliUnavailableHint(entry)
    : '';
}

function _renderExternalCliSelectionWarning(cliType) {
  const warning = document.getElementById('agent-modal-ext-cli-warning');
  const text = _externalCliSelectionWarning(cliType);
  if (warning) {
    warning.textContent = text;
    warning.hidden = !text;
  }
  return text;
}

/** Preserve a known version while the same executable is being revalidated.
 * A new CLI or changed binary path intentionally stays versionless until the
 * background probe confirms what is actually installed there. */
function _mergePresenceWithCachedVersions(entries, cachedEntries) {
  if (!Array.isArray(cachedEntries)) return entries;
  const cachedByType = new Map(cachedEntries.map(entry => [entry.type, entry]));
  return entries.map(entry => {
    const cached = cachedByType.get(entry.type);
    if (
      entry?.available === true
      && cached?.error === 'version_too_old'
      && entry.path === cached.path
    ) {
      return cached;
    }
    if (
      entry?.available !== true
      || cached?.available !== true
      || !cached.version
      || entry.path !== cached.path
    ) {
      return entry;
    }
    return { ...entry, version: cached.version };
  });
}

function _renderExternalCliOptions(entries, onChange) {
  const mount = document.getElementById('agent-modal-ext-cli-select');
  if (!mount) return null;
  if (typeof onChange === 'function') _externalCliLastOnChange = onChange;
  onChange = _externalCliLastOnChange;
  _externalCliVisibleEntries = Array.isArray(entries) ? entries : [];
  _renderExternalCliUpgrades(_externalCliVisibleEntries, onChange);
  const options = _externalCliOptions(entries);
  const hasAvailable = options.some(option => !option.disabled);
  const emptyLabel = options.length > 0 && !hasAvailable
    ? t('agent_modal.ext_cli_unavailable')
    : t('agent_modal.ext_cli_empty');
  const handleChange = (v) => {
    const cli = v || null;
    _renderExternalCliSelectionWarning(cli);
    if (typeof onChange === 'function') onChange(cli);
  };
  mount.classList.toggle('is-empty', options.length === 0);
  if (typeof window.setExternalAgentCreateAvailability === 'function') {
    window.setExternalAgentCreateAvailability(hasAvailable);
  }
  if (!_extCliSelectApi) {
    const nextValue = options.find(option => !option.disabled)?.value || '';
    _extCliSelectApi = _aiSelectMount(mount, {
      options,
      value: nextValue,
      placeholder: emptyLabel,
      onChange: handleChange,
    });
    if (nextValue) handleChange(nextValue);
  } else {
    const current = _extCliSelectApi.getValue();
    const nextValue = options.some(option => option.value === current && !option.disabled)
      ? current
      : (options.find(option => !option.disabled)?.value || '');
    _extCliSelectApi.onChange(handleChange);
    _extCliSelectApi.setOptions(options, { value: nextValue, placeholder: emptyLabel });
    if (nextValue !== current) handleChange(nextValue);
  }
  _renderExternalCliSelectionWarning(_extCliSelectApi.getValue());
  const trigger = mount.querySelector('.ai-select-trigger');
  if (trigger && !mount.classList.contains('is-detecting')) {
    trigger.disabled = options.length === 0;
  }
  return _extCliSelectApi;
}

/**
 * Mount the External-tab CLI selector. The first detected CLI is selected by
 * default; `onChange` fires with the chosen `LocalCliType` (string), or null
 * when no supported local CLI is available. agents.js wires this to the
 * auto-fill logic.
 *
 * Idempotent: concurrent mounts share one discovery pass. Every later entry
 * paints the first cached CLI immediately, then refreshes without blanking
 * the control.
 */
async function mountExternalCliSelect(onChange) {
  const mount = document.getElementById('agent-modal-ext-cli-select');
  if (!mount) return null;
  const cachedEntries = _localCliEntries;
  // Cold entry: put the progress copy in the menu itself and keep the title
  // clean. Cached entry: immediately select its first available CLI and use
  // the title-side live region only for the background update.
  if (!_extCliSelectApi) {
    _extCliSelectApi = _aiSelectMount(mount, {
      options: [],
      value: '',
      placeholder: t('agent_modal.ext_cli_detecting'),
      onChange: () => {},
    });
  }
  if (cachedEntries) {
    _extCliSelectApi.setValue('');
    _renderExternalCliOptions(cachedEntries, onChange);
  } else {
    mount.classList.toggle('is-empty', false);
    _extCliSelectApi.setOptions([], {
      value: '',
      placeholder: t('agent_modal.ext_cli_detecting'),
    });
  }

  const cachedAvailable = cachedEntries?.some(entry => entry.available) === true;
  _setExternalCliDetectionBusy(true, {
    disableSelect: !cachedAvailable,
    showTitleStatus: !!cachedEntries,
  });

  // Phase 1 only checks executable paths. It usually completes in a few
  // milliseconds and lets the user see/select the first installed CLI before
  // any potentially slow `--version` process is started.
  const presence = await _findInstalledLocalCliEntries();
  if (presence.ok) {
    const visiblePresenceEntries = _mergePresenceWithCachedVersions(
      presence.entries,
      cachedEntries,
    );
    _renderExternalCliOptions(visiblePresenceEntries, onChange);
    if (!presence.entries.some(entry => entry?.available === true)) {
      // No executable means there is nothing to version-probe. Treat the
      // path-only result as the completed empty cache and stop immediately.
      _localCliEntries = presence.entries;
      _localCliPresenceEntries = null;
      _setExternalCliDetectionBusy(false);
      return _extCliSelectApi;
    }
    _setExternalCliDetectionBusy(true, {
      disableSelect: false,
      showTitleStatus: true,
    });
  }

  // Phase 2 retains the strict version/compatibility checks, but each
  // installed CLI has an independent IPC response. Paint completed entries
  // immediately while slower probes continue in parallel.
  const validated = presence.ok
    ? await _validateInstalledLocalCliEntries(
      _mergePresenceWithCachedVersions(presence.entries, cachedEntries),
      presence.entries
        .filter(entry => entry?.available === true)
        .map(entry => entry.type),
      entries => _renderExternalCliOptions(entries, onChange),
    )
    : await _loadLocalCliEntriesResult({ force: true });
  _renderExternalCliOptions(
    validated.entries.length > 0
      ? validated.entries
      : (_localCliEntries || (presence.ok ? presence.entries : [])),
    onChange,
  );
  _localCliPresenceEntries = null;
  _setExternalCliDetectionBusy(false);
  return _extCliSelectApi;
}

/** Read the currently-selected CLI type from the External tab, or null when
 *  no supported local CLI is available. */
function getExternalCliValue() {
  return _extCliSelectApi?.getValue() || null;
}

/** Return the localized blocking reason for the selected create-panel CLI.
 * An empty string means the current selection is not known to be invalid. */
function getExternalCliSelectionWarning() {
  return _externalCliSelectionWarning(getExternalCliValue());
}

/** Programmatically set the External-tab selector (used by edit form
 *  to seed from the bound CLI). Pass null to clear the current value before
 *  the next mount chooses the first available CLI. */
function setExternalCliValue(cliType) {
  if (!_extCliSelectApi) return;
  _extCliSelectApi.setValue(cliType || '');
}

window.loadLocalCliEntries = loadLocalCliEntries;
window.getLocalCliAvailabilityState = getLocalCliAvailabilityState;
window.getCliDefaults = getCliDefaults;
window.cliIsCodingAgent = cliIsCodingAgent;
window.getLocalCliUnavailableHint = getLocalCliUnavailableHint;
window.mountExternalCliSelect = mountExternalCliSelect;
window.getExternalCliValue = getExternalCliValue;
window.getExternalCliSelectionWarning = getExternalCliSelectionWarning;
window.setExternalCliValue = setExternalCliValue;

/** Shared recovery action. Updates never replay a failed task or alter its model. */
function createLocalCliUpgradeControl(target, { cli = target.type, chip = false, named = chip, warningVersion } = {}) {
  const root = document.createElement('div');
  root.className = 'local-cli-upgrade-control' + (chip ? ' chat-app-nav-row' : '');
  root.dataset.cli = cli || '';
  root.dataset.named = named ? '1' : '';
  if (warningVersion !== undefined) {
    root.dataset.warningVersion = warningVersion || '?';
    const warning = document.createElement('span');
    warning.className = 'local-cli-upgrade-warning agent-cli-selection-warning';
    root.appendChild(warning);
  }
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn local-cli-upgrade-btn' + (chip ? ' chat-app-nav-btn' : '');
  const status = document.createElement('span');
  status.className = 'agents-detail-cli-note';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const feedback = document.createElement('span');
  feedback.className = 'local-cli-upgrade-feedback';
  const details = document.createElement('button');
  details.type = 'button';
  details.className = 'settings-link-btn local-cli-upgrade-details';
  details.setAttribute('aria-expanded', 'false');
  const label = document.createElement('span');
  label.className = 'local-cli-upgrade-error-label';
  details.appendChild(label);
  if (typeof window.uiIconHtml === 'function') details.insertAdjacentHTML('beforeend', window.uiIconHtml('chevron-right', 'sidebar-section-chevron'));
  const error = document.createElement('div');
  error.className = 'local-cli-upgrade-error';
  error.id = 'local-cli-upgrade-error-' + (++_cliUpgradeControlId);
  error.tabIndex = 0;
  details.setAttribute('aria-controls', error.id);
  feedback.append(status, details);
  root.append(button, feedback, error);
  details.addEventListener('click', () => {
    if (details.hidden) return;
    details.setAttribute('aria-expanded', String(details.getAttribute('aria-expanded') !== 'true'));
    _renderCliUpgradeState(root);
  });
  _renderCliUpgradeState(root);
  button.addEventListener('click', async () => {
    if (button.disabled) return;
    root.dataset.state = 'upgrading';
    details.setAttribute('aria-expanded', 'false');
    error.textContent = '';
    _renderCliUpgradeState(root);
    try {
      const result = await window.orkas.invoke('localAgents.upgrade', target);
      if (result?.ok && result.entry?.available) {
        root.dataset.state = result.outcome === 'up_to_date' ? 'up_to_date' : 'success';
        // Discovery refresh is separate from the updater's authoritative result.
        _localCliEntries = null;
        window.dispatchEvent(new CustomEvent('local-cli-upgraded', { detail: { type: result.type } }));
      } else {
        root.dataset.state = 'failure';
        // Main owns redaction. Treat installer output strictly as bounded text,
        // never Markdown/HTML, and never include it in the telemetry above.
        error.textContent = typeof result?.error_detail === 'string' ? result.error_detail.slice(0, 8192) : '';
      }
    } catch (_) {
      root.dataset.state = 'failure';
    } finally { _renderCliUpgradeState(root); }
  });
  return root;
}
function _renderCliUpgradeState(root) {
  const button = root.querySelector('.local-cli-upgrade-btn');
  const pending = root.dataset.state === 'upgrading';
  const cli = t('agent_modal.runtime_cli_' + root.dataset.cli);
  button.textContent = t(pending ? 'cli_upgrade.pending'
    : root.dataset.named === '1' ? 'cli_upgrade.named_action' : 'cli_upgrade.action', { cli });
  button.disabled = pending;
  button.classList.toggle('is-loading', pending);
  button.setAttribute('aria-busy', String(pending));
  root.querySelector('[role="status"]').textContent = root.dataset.state === 'up_to_date'
    ? t('cli_upgrade.up_to_date') : root.dataset.state === 'success'
      ? t('cli_upgrade.success') : root.dataset.state === 'failure' ? t('cli_upgrade.failed') : '';
  const warning = root.querySelector('.local-cli-upgrade-warning');
  if (warning) {
    warning.hidden = !root.dataset.warningVersion;
    warning.textContent = root.dataset.warningVersion
      ? cli + ': ' + getLocalCliUnavailableHint({ error: 'version_too_old', version: root.dataset.warningVersion }) : '';
  }
  const error = root.querySelector('.local-cli-upgrade-error');
  const details = root.querySelector('.local-cli-upgrade-details');
  details.hidden = root.dataset.state !== 'failure' || !error.textContent;
  if (details.hidden) details.setAttribute('aria-expanded', 'false');
  error.hidden = details.hidden || details.getAttribute('aria-expanded') !== 'true';
  root.querySelector('.local-cli-upgrade-feedback').hidden = !root.querySelector('[role="status"]').textContent;
  root.querySelector('.local-cli-upgrade-error-label').textContent = t('cli_upgrade.error_details');
}
function _renderExternalCliUpgrades(entries) {
  const slot = document.getElementById('agent-modal-ext-cli-upgrades');
  if (!slot) return;
  const oldEntries = entries.filter(entry => entry.error === 'version_too_old');
  // Keep pending and terminal states mounted while discovery refreshes.
  for (const row of slot.querySelectorAll('[data-cli]')) {
    const entry = oldEntries.find(entry => entry.type === row.dataset.cli);
    if (!entry && !row.dataset.state) { row.remove(); continue; }
    if (entry) row.dataset.warningVersion = entry.version || '?';
    else delete row.dataset.warningVersion;
    _renderCliUpgradeState(row);
  }
  for (const entry of oldEntries) {
    if (slot.querySelector('[data-cli="' + entry.type + '"]')) continue;
    slot.appendChild(createLocalCliUpgradeControl({ type: entry.type }, { named: true, warningVersion: entry.version || '?' }));
  }
}
window.createLocalCliUpgradeControl = createLocalCliUpgradeControl;
if (typeof window.addEventListener === 'function') {
  window.addEventListener('i18n-change', () => {
    for (const root of document.querySelectorAll('.local-cli-upgrade-control')) {
      _renderCliUpgradeState(root);
    }
  });
  window.addEventListener('local-cli-upgraded', () => {
    const modal = document.getElementById('agent-modal');
    if (modal?.classList.contains('open')) {
      void loadLocalCliEntries({ force: true }).then(entries => {
        _renderExternalCliOptions(entries, null);
      }).catch(() => {});
    }
  });
}
