// ─── Local CLI agents (renderer side) ─────────────────────────────────
//
// Two surfaces share this module:
//   1. The agent-modal "external" tab — selector lists every detected CLI
//      (default: "not selected"). Selecting one auto-fills name + description
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
    description_zh: '代码研发智能体——在本地项目里端到端做软件开发：实现新功能、修复 bug、跨多文件重构、写测试、调试，可长时间自主迭代、直接改文件跑命令；适合"实现一下这个功能"、"把这个 bug 修了"、"重构这个模块"、"给这段代码加测试"；触发词：写代码、开发、实现、修 bug、重构、加功能、写测试、改代码、调试',
    description_en: "Coding agent for end-to-end software development in your local project — builds features, fixes bugs, refactors across files, writes tests, and debugs autonomously, editing files and running commands directly over long sessions; For: 'implement this feature', 'fix this bug', 'refactor this module', 'add tests for this code'; Triggers: code, develop, implement, fix bug, refactor, add feature, write tests, edit code, debug",
    isCoding: true,
  },
  codex: {
    name: 'Codex',
    description_zh: '代码研发智能体——在本地项目里端到端做软件开发：实现新功能、修复 bug、跨多文件重构、按需求/issue 打补丁，可长时间自主迭代、直接改文件跑命令；适合"实现一下这个功能"、"按 issue 描述打个补丁"、"修一下这个 bug"、"重构这块逻辑"；触发词：写代码、开发、实现、修 bug、重构、加功能、补丁、改代码、issue',
    description_en: "Coding agent for end-to-end software development in your local project — builds features, fixes bugs, refactors across files, and patches against requirements or issues autonomously, editing files and running commands directly over long sessions; For: 'implement this feature', 'patch following this issue', 'fix this bug', 'refactor this logic'; Triggers: code, develop, implement, fix bug, refactor, add feature, patch, edit code, issue",
    isCoding: true,
  },
  openclaw: {
    name: 'OpenClaw',
    description_zh: '通用任务智能体——在多家模型/工具间路由,做任务编排与轻量自动化,擅长把不同模型/工具组合起来跑流程；适合"把这几个工具串起来跑一遍"、"用便宜的模型先草稿一版"、"换个模型再答一次比较"；触发词：编排、自动化、多模型、切换、跑流程、串起来、组合',
    description_en: "General-purpose agent that routes across model/tool providers for task orchestration and lightweight automation, good at chaining different models/tools into a flow; For: 'chain these tools and run the flow', 'draft this with a cheap model first', 'try the same prompt on another model to compare'; Triggers: orchestrate, automate, multi-model, switch model, run flow, chain, compose",
    isCoding: false,
  },
  opencode: {
    name: 'OpenCode',
    description_zh: '代码研发智能体——在本地项目里做软件开发,支持自选模型(含本地模型),实现功能、修 bug、改文件、跑终端命令,可换模型对比；适合"用本地模型实现这个功能"、"修一下这个 bug"、"换个模型再写一版"、"在终端里跑一下"；触发词：写代码、开发、实现、修 bug、改代码、换模型、本地模型、终端',
    description_en: "Coding agent for software development in your local project with bring-your-own-model (including local models) — builds features, fixes bugs, edits files, and runs terminal commands, swap models to compare; For: 'implement this feature with a local model', 'fix this bug', 'try another model and rewrite', 'run it in the terminal'; Triggers: code, develop, implement, fix bug, edit code, switch model, local model, terminal",
    isCoding: false,
  },
  hermes: {
    name: 'Hermes',
    description_zh: '通用任务智能体——通过 ACP 协议跑多步任务、调用工具、按会话粒度续接,擅长按既定流程一步步推进；适合"按这个流程一步步做下来"、"接着上次的会话继续"、"调几个工具配合完成这件事"；触发词：多步、流程、任务、工具调用、会话续接、ACP、协同',
    description_en: "General-purpose multi-step agent over the ACP protocol with tool use and session-scoped resume, good at walking a defined process step by step; For: 'walk through this process step by step', 'continue from the last session', 'coordinate a few tools to finish this'; Triggers: multi-step, process, task, tool use, resume session, ACP, coordinate",
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
// Sentinel value for "not selected" — distinct from empty string so a user who
// genuinely empties the selector still re-routes through this branch.
const EXT_CLI_NONE = '__none__';

let _extCliSelectApi = null;

/**
 * Mount the External-tab CLI selector. Default option is "not
 * selected"; detected CLIs follow. `onChange` fires with the chosen
 * `LocalCliType` (string) or null when the user reverts to the "not
 * selected" sentinel — agents.js wires
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
  const noneLabel = t('agent_modal.ext_cli_none');
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
 *  when the user kept the "not selected" sentinel. */
function getExternalCliValue() {
  const v = _extCliSelectApi ? _extCliSelectApi.getValue() : EXT_CLI_NONE;
  if (!v || v === EXT_CLI_NONE) return null;
  return v;
}

/** Programmatically set the External-tab selector (used by edit form
 *  to seed from the bound CLI). Pass null to revert to the "not
 *  selected" sentinel. */
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
