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
    description_zh: '在本地项目中实现功能、修复缺陷、跨文件重构、编写测试和调试，通过文件编辑与命令执行交付代码改动及验证结果。',
    description_en: 'Implements features, fixes bugs, refactors across files, writes tests and debugs in a local project, using file edits and commands to deliver code changes and verification results.',
    isCoding: true,
  },
  codex: {
    name: 'Codex',
    description_zh: '在本地项目中按需求或 issue 实现功能、修复缺陷和跨文件重构，通过文件编辑与命令执行交付代码补丁及验证结果。',
    description_en: 'Implements requirements or issues, fixes bugs and refactors across files in a local project, using file edits and commands to deliver code patches and verification results.',
    isCoding: true,
  },
  openclaw: {
    name: 'OpenClaw',
    description_zh: '组合可用工具执行通用多步任务与轻量自动化流程，汇总各步骤结果，交付所需的任务成果。',
    description_en: 'Carries out general multi-step tasks and lightweight automation by combining available tools, consolidating their results into the requested deliverable.',
    isCoding: false,
  },
  opencode: {
    name: 'OpenCode',
    description_zh: '在本地项目中实现功能和修复缺陷，通过文件编辑与终端命令执行交付代码改动及验证结果。',
    description_en: 'Implements features and fixes bugs in a local project, editing files and running terminal commands to deliver code changes and verification results.',
    isCoding: true,
  },
  hermes: {
    name: 'Hermes',
    description_zh: '使用可用工具按既定流程推进通用多步任务，汇总各步骤结果，交付所需的任务成果。',
    description_en: 'Carries out general multi-step tasks by following defined workflows with available tools, consolidating step results into the requested deliverable.',
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
  _externalCliVisibleEntries = Array.isArray(entries) ? entries : [];
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
