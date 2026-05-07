// ─── Local CLI agents (renderer side) ─────────────────────────────────
//
// Two surfaces share this module:
//   1. The agent-modal "外接" tab — selector lists every detected CLI
//      (default: 未选择). Selecting one auto-fills name + description
//      from CLI_DEFAULTS so a single click is enough to ship an
//      external-agent shell.
//   2. The agent-detail runtime selector (existing CLI-bound agents)
//      lives in agents.js; this module just supplies the registry list.
//
// CLI_DEFAULTS holds the bilingual seed values used by both create
// and edit. `description_zh` + `description_en` are stored side-by-
// side on the agent so locale switches are zero-cost; `name` is a
// single brand label (the user can rename to disambiguate two
// instances of the same CLI bound to different project_dirs).
//
// Detection pre-warms 500ms after script load so the first modal
// open doesn't pay the cold detection cost.

const _localAgentsLog = createLogger('local-agents');

// Single source of truth for default name + description per CLI type.
// English-source (per CLAUDE.md "English-only project text") with the
// Chinese variant carried alongside for the agent description pair.
const CLI_DEFAULTS = {
  claude: {
    name: 'Claude Code',
    description_zh: 'Anthropic 出品的本地编码智能体 CLI，擅长代码理解、重构与多文件改动；支持工程上下文感知、工具调用与流式回复。',
    description_en: "Anthropic's local coding agent CLI — strong at code understanding, refactoring, and multi-file edits; project-aware context, tool use, streaming output.",
    isCoding: true,
  },
  codex: {
    name: 'Codex',
    description_zh: 'OpenAI 出品的本地编码智能体 CLI，擅长代码生成与补丁式改写；支持沙箱执行与会话续接。',
    description_en: "OpenAI's local coding agent CLI — strong at code generation and patch-style edits; sandboxed execution and session resume.",
    isCoding: true,
  },
  openclaw: {
    name: 'OpenClaw',
    description_zh: '开源多模型聚合智能体 CLI，可在多家模型/工具间切换；适合通用任务编排与轻量自动化。',
    description_en: 'Open-source multi-model agent CLI; routes across providers and tools — good for general orchestration and lightweight automation.',
    isCoding: false,
  },
  opencode: {
    name: 'OpenCode',
    description_zh: '开源编码智能体 CLI，支持多模型切换;侧重代码生成、文件改写与终端任务。',
    description_en: 'Open-source coding agent CLI with multi-model support; focused on code generation, file editing, and terminal tasks.',
    isCoding: false,
  },
  hermes: {
    name: 'Hermes',
    description_zh: '通过 ACP 协议接入的智能体 CLI，可执行多步任务与工具调用；以会话粒度协同。',
    description_en: 'Agent CLI integrated over the ACP protocol; runs multi-step tasks with tool use; session-scoped collaboration.',
    isCoding: false,
  },
};

/** Defaults for a given CLI type, or null when the type is unknown. */
function getCliDefaults(cliType) {
  return cliType && Object.prototype.hasOwnProperty.call(CLI_DEFAULTS, cliType)
    ? CLI_DEFAULTS[cliType]
    : null;
}

/** True when the CLI is one of claude / codex (the coding agents that
 *  expose a project-dir form input). Mirrors `cliSupportsProjectDir`
 *  in features/agents.ts — keep in sync. */
function cliIsCodingAgent(cliType) {
  const d = getCliDefaults(cliType);
  return !!(d && d.isCoding);
}

let _localCliEntries = null;

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

// ── External-tab CLI selector (create modal) ───────────────────────────
//
// Sentinel value for "未选择" — distinct from empty string so a user who
// genuinely empties the selector still re-routes through this branch.
const EXT_CLI_NONE = '__none__';

let _extCliSelectApi = null;

/**
 * Mount the External-tab CLI selector. Default option is 未选择;
 * detected CLIs follow. `onChange` fires with the chosen `LocalCliType`
 * (string) or null when the user reverts to 未选择 — agents.js wires
 * this to the auto-fill / project-dir-row toggling logic.
 *
 * Idempotent: re-mounting just resets options + value so a re-open of
 * the modal picks up newly-installed CLIs.
 */
async function mountExternalCliSelect(onChange) {
  const mount = document.getElementById('agent-modal-ext-cli-select');
  if (!mount) return null;
  const entries = await loadLocalCliEntries();
  const available = entries.filter(e => e.available);
  const noneLabel = t('agent_modal.ext_cli_none') || '未选择';
  const options = [
    { value: EXT_CLI_NONE, label: noneLabel },
    ...available.map(e => ({
      value: e.type,
      label: `${(getCliDefaults(e.type)?.name) || e.type}${e.version ? ` (${e.version})` : ''}`,
    })),
  ];
  const handleChange = (v) => {
    const cli = (!v || v === EXT_CLI_NONE) ? null : v;
    if (typeof onChange === 'function') onChange(cli);
  };
  if (!_extCliSelectApi) {
    _extCliSelectApi = _aiSelectMount(mount, {
      options, value: EXT_CLI_NONE,
      placeholder: noneLabel,
      onChange: handleChange,
    });
  } else {
    _extCliSelectApi.setOptions(options, { value: EXT_CLI_NONE });
  }
  return _extCliSelectApi;
}

/** Read the currently-selected CLI type from the External tab, or null
 *  when the user kept "未选择". */
function getExternalCliValue() {
  const v = _extCliSelectApi ? _extCliSelectApi.getValue() : EXT_CLI_NONE;
  if (!v || v === EXT_CLI_NONE) return null;
  return v;
}

/** Programmatically set the External-tab selector (used by edit form
 *  to seed from the bound CLI). Pass null to revert to 未选择. */
function setExternalCliValue(cliType) {
  if (!_extCliSelectApi) return;
  _extCliSelectApi.setValue(cliType || EXT_CLI_NONE);
}

// Pre-warm the registry cache.
setTimeout(() => { loadLocalCliEntries().catch(() => { /* warm-up best-effort */ }); }, 500);

window.loadLocalCliEntries = loadLocalCliEntries;
window.getCliDefaults = getCliDefaults;
window.cliIsCodingAgent = cliIsCodingAgent;
window.mountExternalCliSelect = mountExternalCliSelect;
window.getExternalCliValue = getExternalCliValue;
window.setExternalCliValue = setExternalCliValue;
