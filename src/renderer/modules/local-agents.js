// ─── Local CLI agents (renderer side) ─────────────────────────────────
//
// One dropdown in the create-agent modal:
//   Orkas (default, in-process) | Claude Code | Codex | OpenClaw | OpenCode | Hermes
// Anything not detected on this machine is omitted from the list.
//
// Model + custom_args are intentionally NOT exposed in the modal — the
// CLI picks its own default model (closer to what the user's account
// actually supports), and most users never need extra flags. The spec
// still supports both fields; advanced users can hand-edit `agent.json`
// or we add a "details" toggle later when there's real demand.
//
// Detection pre-warms 500ms after the first agents-page render so the
// 60s registry cache is warm by the time the user opens the modal —
// the first cold detection runs `which` + `--version` for each CLI in
// parallel and can take ~200ms; this avoids the layout-shift flash
// that comes from awaiting it inside `openAgentModal`.

const _localAgentsLog = createLogger('local-agents');

let _localCliEntries = null;          // cached availability list

async function loadLocalCliEntries({ force = false } = {}) {
  if (_localCliEntries && !force) return _localCliEntries;
  try {
    const res = await window.orkas.invoke('localAgents.list', { force });
    _localCliEntries = Array.isArray(res?.entries) ? res.entries : [];
  } catch (e) {
    _localAgentsLog.warn('localAgents.list failed', e);
    _localCliEntries = [];
  }
  return _localCliEntries;
}

let _runtimeSelectApi = null;

/**
 * Render the runtime selector inside the create-agent modal.
 * - No CLIs detected → row stays hidden, selector treated as Orkas.
 * - At least one detected → fills with "Orkas" (default) + each
 *   available CLI; defaults to Orkas.
 * Idempotent: calling again rebuilds the row from current detection.
 */
async function mountLocalAgentRuntimeRow() {
  const row = document.getElementById('agent-modal-runtime-row');
  const mount = document.getElementById('agent-modal-runtime-select');
  if (!row || !mount) return false;

  const entries = await loadLocalCliEntries();
  const available = entries.filter(e => e.available);
  if (available.length === 0) {
    row.style.display = 'none';
    if (_runtimeSelectApi) _runtimeSelectApi.setOptions([], { value: 'in_process' });
    return false;
  }

  row.style.display = '';
  const options = [
    { value: 'in_process', label: t('agent_modal.runtime_in_process') },
    ...available.map(e => ({
      value: `cli:${e.type}`,
      label: `${t('agent_modal.runtime_cli_' + e.type)}${e.version ? ` (${e.version})` : ''}`,
    })),
  ];
  // Mount once, re-set options on subsequent opens. Keeps the API
  // instance stable so `getRuntimeFormValue` reads the same widget.
  if (!_runtimeSelectApi) {
    _runtimeSelectApi = _aiSelectMount(mount, {
      options, value: 'in_process',
      placeholder: t('agent_modal.runtime_in_process'),
      onChange: () => { /* read on save */ },
    });
  } else {
    _runtimeSelectApi.setOptions(options, { value: 'in_process' });
  }
  return true;
}

/**
 * Read the current selector state into a runtime spec, or null when
 * the user kept "Orkas" (so the caller doesn't write a runtime field
 * at all and the agent stays in-process by default). Model + custom
 * args are not collected here — backends fall back to their own
 * defaults, which is usually what users want.
 */
function getRuntimeFormValue() {
  const v = _runtimeSelectApi ? _runtimeSelectApi.getValue() : 'in_process';
  if (!v || v === 'in_process') return null;
  const m = /^cli:(.+)$/.exec(v);
  if (!m) return null;
  return { kind: 'cli', cli: m[1] };
}

// Pre-warm the registry cache shortly after script load so the first
// modal open doesn't pay the cold detection cost. Fire-and-forget.
setTimeout(() => { loadLocalCliEntries().catch(() => { /* warm-up best-effort */ }); }, 500);

window.mountLocalAgentRuntimeRow = mountLocalAgentRuntimeRow;
window.getRuntimeFormValue = getRuntimeFormValue;
window.loadLocalCliEntries = loadLocalCliEntries;
