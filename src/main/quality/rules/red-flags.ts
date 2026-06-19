/**
 * EXTREME red-flag patterns scanned across skill scripts + SKILL.md embedded
 * code blocks + agent.json paths.
 *
 * Each rule = one regex against the textual content. The 9-rule list is the
 * sole authority; new rules append here, no other file changes.
 *
 * Why static patterns: deterministic, no LLM judgment, < 1ms per file. This
 * is a "block 60-80% of explicit malice" tool — runtime path-sandbox is the
 * sandbox layer that catches the rest.
 *
 * Scope:
 *   - 'script' files (scripts/<file>.{py,sh,ts,js,mjs,rb,bash,ps1,cmd,bat})
 *   - 'skill_md' embedded fenced code blocks (```bash / ```sh / ```python)
 *   - 'agent_json' path-string fields
 *   Prose in SKILL.md is NOT scanned — false-positive rate is too high
 *   ("this skill handles ssh config" ≠ "reads ssh private keys").
 */

import { RuleDef, ScanKind, Violation } from '../types';

// ── Rule list ────────────────────────────────────────────────────────────

export const RED_FLAGS: ReadonlyArray<RuleDef> = [
  {
    id: 'no_credential_path_read',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md', 'agent_json'],
    // ~/.ssh, ~/.aws/credentials, ~/.gnupg, .env / .env.*, security find-generic-password
    pattern: /(~\/\.ssh\/|\.aws\/credentials|~\/\.gnupg\/|(?:^|[\s'"\/=:])\.env(?:\.[\w-]+)?(?:[\s'"]|$)|security\s+find-generic-password)/i,
    suggested_fix: 'Do not access credential files directly. Accept the relevant path or secret as an input argument from the user.',
  },
  {
    id: 'no_eval_with_external_input',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // eval( / new Function( / Python exec( / shell `eval "$VAR"`
    pattern: /\b(?:eval|exec)\s*\(\s*(?!['"][^'"]*['"]?\s*\))|new\s+Function\s*\(|eval\s+["']?\$[A-Z_]/,
    suggested_fix: 'Avoid eval / exec on non-literal input. Restructure to call specific functions explicitly.',
  },
  {
    id: 'no_download_then_execute',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // curl|bash / wget|sh / curl|powershell / curl|cmd / pip install <url-or-git>
    pattern: /(?:curl|wget)\b[^\n]*\|\s*(?:bash|sh|zsh|powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?)\b|pip\s+install\s+(?:https?:\/\/|git\+)/i,
    suggested_fix: 'Do not pipe remote content into a shell. Require the user to install dependencies through normal package managers.',
  },
  {
    id: 'no_shell_init_or_persistence',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // Write to ~/.bashrc / .zshrc / .profile / .bash_profile / LaunchAgents / cron / systemd unit
    pattern: /(?:>>?|tee|cat\s+>|cp\b[^\n]*?)\s*(?:~|\$HOME)\/\.(bashrc|zshrc|profile|bash_profile)|~\/Library\/LaunchAgents\/|\/etc\/cron|systemd\b[^\n]*?\.service/i,
    suggested_fix: 'Do not modify shell startup files or install persistence services. Skill code must not alter the user environment outside the workspace.',
  },
  {
    id: 'no_cross_agent_private_read',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md', 'agent_json'],
    // ~/.claude/projects/*/memory/ / paths into other agents' meta/ or other skills' SKILL.md
    pattern: /~\/\.claude\/projects\/[^\/\s]+\/memory\/|cloud\/agents\/[^\/\s]+\/meta\/|cloud\/skills\/[^\/\s]+\/SKILL\.md/,
    suggested_fix: 'Do not read other agents\' memory / metacognition or other skills\' SKILL.md. Each skill or agent only accesses its own data.',
  },
  {
    id: 'no_obfuscated_payload',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // Three forms:
    //   1. `base64 -d | <interpreter>` shell pipeline
    //   2. `atob(...) ; eval(...)` (two separate calls in sequence)
    //   3. `eval(atob(...))` / `Function(atob(...))` (nested call)
    pattern: /base64\s+(?:-d|--decode)[^\n]*?\|\s*(?:bash|sh|powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?|python|python3|node|tsx)\b|atob\s*\([^)]*\)\s*[;,]?\s*(?:eval|new\s+Function)\s*\(|(?:eval|new\s+Function)\s*\(\s*atob\s*\(/i,
    suggested_fix: 'Do not decode and execute encoded payloads. Write the executable logic in clear text so it can be reviewed.',
  },
  {
    id: 'no_shell_history_read',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    pattern: /\.(bash|zsh|fish)_history\b/,
    suggested_fix: 'Do not read shell history files; they often contain ad-hoc credentials and per-user context outside the skill\'s scope.',
  },
  {
    id: 'no_spec_self_modification',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // Shell redirect / shell write commands / JS write APIs targeting a spec file.
    // Each form requires syntactically valid usage so the rule doesn't false-positive
    // on prose mentions like `<capability> SKILL.md` or Python strings such as
    // `estimated_total_nodes > 100(SKILL.md ...)`.
    pattern: /(?:^|\s|;|&&|\|\|)(?:>>?)\s*['"]?(?:(?:\.{1,2}|~|\$[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][\w.-]*|\/)[^'"\s;|&]*\/)?(?:SKILL\.md|agent\.json|_install\.json)\b|(?:^|\s|;|&&|\|\|)(?:tee|cp|mv)\s+[^\n;|&]*?(?:SKILL\.md|agent\.json|_install\.json)\b|(?:writeFileSync|fs\.writeFile|fs\.promises\.writeFile|open\s*\([^)]*['"](?:w|wb)['"])\s*[^\n;]*?(?:SKILL\.md|agent\.json|_install\.json)\b/i,
    suggested_fix: 'Skill or agent code must not mutate its own spec or another skill\'s spec. Spec changes go through the editor or the spec_patch_suggester evolution flow.',
  },
  {
    id: 'no_write_outside_workspace',
    level: 'EXTREME',
    appliesTo: ['script', 'skill_md'],
    // Common absolute writes outside obvious workspace / cache / tmp roots.
    // Conservative: only matches when an absolute path looks like it targets
    // user / system directories that a skill should never touch. The intent
    // is high precision, low recall — better miss a write than misflag.
    pattern: /(?:>>?|tee|cp\b|mv\b|writeFileSync\s*\(|fs\.writeFile|open\s*\([^)]*['"]w['"])[^\n]*?(?:\/etc\/|\/usr\/(?:bin|local|share)|\/System\/|\/Library\/(?!Caches\/))/,
    suggested_fix: 'Do not write to system directories. Skills must only write inside the workspace, the system temp directory, or a path the user explicitly provided.',
  },
];

// ── Application ──────────────────────────────────────────────────────────

/**
 * Scan content + return violations from the matching rules.
 * `kind === 'other'` returns []; no scanning of prose / docs / assets.
 */
export function scanRedFlags(args: {
  content: string;
  kind: ScanKind;
  field: string;       // path-like locator for the report
}): Violation[] {
  if (args.kind === 'other') return [];
  const out: Violation[] = [];
  for (const rule of RED_FLAGS) {
    if (!rule.appliesTo.includes(args.kind)) continue;
    const match = rule.pattern.exec(args.content);
    if (!match) continue;
    const lineNo = _lineNumberAt(args.content, match.index);
    const snippet = _excerpt(args.content, match.index, match[0].length);
    out.push({
      level: rule.level,
      rule: rule.id,
      field: lineNo > 0 ? `${args.field}:${lineNo}` : args.field,
      snippet,
      suggested_fix: rule.suggested_fix,
    });
    // Reset stateful regex (`/g`) — we don't use /g but be safe across future
    // changes by zeroing lastIndex.
    rule.pattern.lastIndex = 0;
  }
  return out;
}

/**
 * Extract fenced code blocks of executable languages from a SKILL.md body
 * and yield each block paired with its kind for further scanning.
 *
 * Languages: bash / sh / zsh / powershell / ps1 / batch / bat / cmd /
 * python / py / js / ts / ruby / rb.
 * Code blocks of other languages (markdown / json / yaml / text / unspecified)
 * are skipped — they're documentation, not execution surface.
 */
export function extractExecutableBlocks(skillMdBody: string): Array<{
  lang: string;
  content: string;
  startLine: number;
}> {
  const out: Array<{ lang: string; content: string; startLine: number }> = [];
  const re = /```(bash|sh|zsh|powershell|ps1|batch|bat|cmd|python|py|js|javascript|ts|typescript|ruby|rb)\s*\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(skillMdBody)) !== null) {
    out.push({
      lang: m[1].toLowerCase(),
      content: m[2],
      startLine: _lineNumberAt(skillMdBody, m.index),
    });
  }
  return out;
}

function _lineNumberAt(text: string, byteIndex: number): number {
  if (byteIndex < 0 || byteIndex >= text.length) return 0;
  let n = 1;
  for (let i = 0; i < byteIndex; i++) if (text.charCodeAt(i) === 0x0a) n++;
  return n;
}

function _excerpt(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 30);
  const end = Math.min(text.length, idx + len + 30);
  return text.slice(start, end).replace(/\s+/g, ' ').slice(0, 200).trim();
}
