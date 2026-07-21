/**
 * Skill-script invocation contract.
 *
 * Marketplace and system skill directories are protected install roots. A
 * SKILL.md (or agent workflow) must never teach the model to resolve a bundled
 * script path and invoke it directly. `bin/run-skill.cjs` is the only stable
 * bridge: it resolves the active skill, selects the runtime, and keeps the
 * protected install path out of the model-authored command.
 */

import { Violation } from '../types';

const STANDARD_RUNNER_RE = /\brun-skill\.cjs\b/i;
const SKILL_ROOT_SCRIPT_RE = /(?:<(?:(?:this[-_])?skill(?:[-_](?:dir|directory))?)>|\$(?:\{)?(?:ORKAS_)?SKILL_DIR(?:\})?)[\\/]scripts[\\/]/i;
const MARKETPLACE_INSTALL_SCRIPT_RE = /\.orkas[\\/]data[\\/][^\s"'`]+[\\/]local[\\/]marketplace[\\/][^\s"'`]*[\\/]scripts[\\/]/i;
const INTERPRETER_SCRIPT_RE = /(?:^|[;&|]\s*|\s)(?:["']?\$(?:\{)?(?:ORKAS_NODE|ORKAS_PYTHON)(?:\})?["']?|node(?:\.exe)?|python(?:3(?:\.\d+)?)?|py(?:\.exe)?(?:\s+-3)?|bash|sh|zsh|ruby|pwsh(?:\.exe)?|powershell(?:\.exe)?|cmd(?:\.exe)?)(?:\s+-[^\s]+)*\s+["']?(?:\.{0,2}[\\/])?scripts[\\/]/i;
const DIRECT_EXECUTABLE_RE = /(?:^|[;&|]\s*)(?:\.{0,2}[\\/])?scripts[\\/][^\s"'`]+\.(?:py|js|mjs|ts|sh|bash|zsh|rb|ps1|cmd|bat)\b/i;

const SUGGESTED_FIX = 'Invoke bundled scripts through `"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" <skill-id-or-name> <script-basename> -- <args...>`; never resolve or mention the skill installation path.';

function _isDirectSkillScriptCommand(command: string): boolean {
  if (STANDARD_RUNNER_RE.test(command)) return false;
  return SKILL_ROOT_SCRIPT_RE.test(command)
    || MARKETPLACE_INSTALL_SCRIPT_RE.test(command)
    || INTERPRETER_SCRIPT_RE.test(command)
    || DIRECT_EXECUTABLE_RE.test(command);
}

function _excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Return the first direct bundled-script invocation in a text field. */
export function scanSkillRunnerContract(args: {
  content: string;
  field: string;
}): Violation[] {
  const lines = args.content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const startLine = index + 1;
    let command = lines[index].trim();
    while (/[\\`^]\s*$/.test(command) && index + 1 < lines.length) {
      command = `${command.replace(/[\\`^]\s*$/, '')} ${lines[++index].trim()}`;
    }
    if (!_isDirectSkillScriptCommand(command)) continue;
    return [{
      level: 'EXTREME',
      rule: 'skill_script_requires_runner',
      field: `${args.field}:${startLine}`,
      snippet: _excerpt(command),
      suggested_fix: SUGGESTED_FIX,
    }];
  }
  return [];
}

/** Scan every user-authored string field in an agent spec independently. */
export function scanAgentRunnerContract(value: unknown, field = 'agent.json'): Violation[] {
  if (typeof value === 'string') {
    return scanSkillRunnerContract({ content: value, field });
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const hit = scanAgentRunnerContract(value[index], `${field}[${index}]`);
      if (hit.length > 0) return hit;
    }
    return [];
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const hit = scanAgentRunnerContract(child, `${field}:${key}`);
      if (hit.length > 0) return hit;
    }
  }
  return [];
}
