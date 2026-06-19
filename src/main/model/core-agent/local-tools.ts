/**
 * Local-machine tool wrappers injected into every AgentRunner built by
 * this app.
 *
 * Five tools:
 *   - `bash`          — overrides core-agent's builtin (last-write-wins in
 *                       AgentRunner's tool map). Same schema; tighter
 *                       English description; permission-gated.
 *   - `write_file`    — same pattern as bash. On success, invokes
 *                       `onFileWritten(absPath)` so the caller (chats.ts)
 *                       can accumulate a produced-files list to attach to
 *                       the assistant message. Conflict-uniquifies the
 *                       basename (`-2 / -3 / ...`) when the target path
 *                       already exists AND the caller's `hasProducedPath`
 *                       does not claim it (i.e. it's not our own prior
 *                       write being refined). The rename is surfaced via a
 *                       `<file-renamed>` block in the tool result.
 *   - `edit_file`     — in-place `old_string → new_string` replacement on
 *                       an existing text file. Sandbox-checked
 *                       (workspace + current attachment dir + extraRoots);
 *                       does NOT uniquify (semantics are "modify
 *                       existing"); pdf/docx/image kinds rejected; on
 *                       success fires `onFileWritten` so the UI can show
 *                       the green chip. Companion to `write_file` for
 *                       cheap targeted edits without a full overwrite.
 *   - `markdown_to_pdf` — built-in PDF channel (no pandoc/wkhtmltopdf
 *                       dependency). Renders via util/md-to-pdf +
 *                       Electron's webContents.printToPDF.
 *   - `html_to_pdf`   — same, for hand-crafted HTML input.
 *
 * Permission gate: every execute() re-reads `getLocalExecGranted()` so a
 * mid-conversation grant/revoke takes effect on the next tool call without
 * a rebuild.
 *
 * Note on naming: the two override tools MUST keep the exact core-agent
 * names (`bash` / `write_file`) or the LLM will see both — broken.
 *
 * Note on `bash`: shell-side writes (`cat > foo.py`, `tee`, document
 * generators, etc.) still bypass write_file's conflict protection. Bash
 * auto-reports files created / modified under the current conversation
 * workspace, exposed to scripts as `ORKAS_OUTPUT_DIR`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { bashTool as coreBashTool, writeFileTool as coreWriteFileTool } from '../../../core-agent/src/tools/builtin';
import { buildSandboxEnv, decodeProcessOutput } from '../../../core-agent/src/sandbox/executor';
import { getLocalExecGranted, getLocalExecMode } from '../../features/permissions';
import { classifyBashCommand } from './bash-risk';
import { requestBashDecision } from './bash-permissions';
import { markdownToPdf, htmlToPdf } from '../../util/md-to-pdf';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { isPathAllowed } from '../../util/path-sandbox';
import { kindOf } from '../../features/file_indexer';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDir, userMarketplaceSkillsDir, userSkillsDir } from '../../paths';
import * as chatArtifacts from '../../features/chat_artifacts';
import { readDisabledSets } from '../../features/component_enabled';
import { requestConfirmation as requestDeleteConfirmation, consumeGrantedConfirmation } from './delete-file-confirm';
import { createLogger } from '../../logger';
import { t } from '../../i18n';

const log = createLogger('local-tools');

export interface LocalToolsOpts {
  /** Active uid. Used by `edit_file` to resolve workspace + attachment
   *  sandbox roots; also reserved for future tools that need user-scoped
   *  resolution. Optional so the catalog drift test can call
   *  `createLocalTools({})` without runtime user state. */
  userId?: string;
  /** Current conversation id. Used by `edit_file` to add the current
   *  conv's attachment dir to the sandbox. Without it, only the workspace
   *  (+ extraRoots) is editable. Also the storage key for `create_artifact`
   *  (artifacts live under `chat_artifacts/<cid>/`); the tool errors out
   *  when it's missing. */
  cid?: string;
  /** Stable id for the current actor/model turn. Renderer uses this to group
   *  only delete confirmations produced by that same turn. */
  turnId?: string;
  /** The actor id producing this turn (an agent's id, or `''` for the
   *  group-chat commander / edit chats). Stamped into `create_artifact`'s
   *  metadata so the renderer knows which actor to route an interaction
   *  result back to. */
  agentId?: string;
  /** Display name for the bash risk-permission dialog. Falls back to
   *  `agentId` when absent. */
  agentName?: string;
  /** Project id of the current conversation, when it belongs to one.
   *  Threaded through from group_chat at runTurn so workspace resolution
   *  picks up the project-scoped selection (per CLAUDE.md projects feature).
   *  Empty / missing → default-scope workspace. */
  projectId?: string;
  /** Extra absolute directory roots `edit_file` should treat as in-scope
   *  on top of workspace + attachment. Used by skill-edit / agent-edit
   *  chats so the LLM can edit files inside the skill / agent dir. */
  extraRoots?: readonly string[];
  /** Extra absolute roots that are **read-only** for write-side tools
   *  (`write_file` / `edit_file`) but in-scope for `delete_file`. The
   *  per-call UI confirmation card on `delete_file` is the safety gate
   *  that makes this asymmetry safe — every delete requires explicit
   *  user click, so a path the caller marked read-only is still
   *  protected from silent overwrite by `write_file` / `edit_file`
   *  while still being removable when the user explicitly says yes.
   *  Used by skill-edit chat so the LLM can `delete_file` a script
   *  inside the skill dir without granting it `write_file` access to
   *  the same path. */
  readOnlyExtraRoots?: readonly string[];
  /** Fires with absolute path after every successful write (write_file,
   * edit_file, markdown_to_pdf, html_to_pdf). Lets chats.ts surface
   * produced files to the UI. */
  onFileWritten?: (absPath: string) => void;
  /** Fires after a successful `create_artifact` call. The caller (group_chat
   *  bus) collects these per turn and attaches `message.artifacts` to the
   *  assistant record so the renderer embeds each one in the bubble. */
  onArtifactCreated?: (a: { id: string; title: string }) => void;
  /** Predicate: returns true when the given absolute path was already
   *  written by this caller in the current scope (typically: a Set
   *  populated by `onFileWritten` this turn). When true, the wrapped
   *  tool overwrites in place — the refinement pattern. When false /
   *  absent, an existing file at the target is treated as a foreign
   *  collision and uniquify (`-2 / -3 / ...`) kicks in. Consumed by
   *  `write_file` / `markdown_to_pdf` / `html_to_pdf`; `edit_file`
   *  ignores it (its semantics is "modify existing", uniquify would be
   *  wrong). */
  hasProducedPath?: (absPath: string) => boolean;
}

const DENY_MESSAGE =
  'E_TOOL_EXECUTION_ACCESS_DISABLED: Tool execution access is disabled, so command execution, file writes, PDFs, images, and local artifacts were not created. ' +
  'Ask the user to open Settings > Tool Execution Access and enable "Enable Tool Execution Access", then retry. ' +
  'Do not claim any file, PDF, image, or interactive app has already been created.';

function deniedResult(): ToolResult {
  return { content: DENY_MESSAGE, isError: true };
}

function resolveAbs(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.workingDir ?? '.', p);
}

function isMineFor(opts: LocalToolsOpts): (p: string) => boolean {
  const fn = opts.hasProducedPath;
  return (p) => {
    if (fn?.(p)) return true;
    return !!opts.extraRoots?.length && isPathAllowed(path.resolve(p), opts.extraRoots);
  };
}

function errText(code: string, msg: string): string {
  return `${code}: ${msg}`;
}

function bashMsg(key: string, vars?: Record<string, string | number>): string {
  return t(`bash.error.${key}`, vars);
}

function translateFixedBashError(result: ToolResult): ToolResult {
  const content = result.content || '';
  if (!content) return result;

  let m = /^Command timed out after (\d+)ms$/.exec(content);
  if (m) return { ...result, content: bashMsg('timeout', { ms: m[1] }) };

  m = /^Exit code: (.+)$/.exec(content);
  if (m) return { ...result, content: bashMsg('exit_code', { code: m[1] }) };

  m = /^Failed to start background command: (.+)$/.exec(content);
  if (m) return { ...result, content: bashMsg('background_start_failed', { error: m[1] }) };

  m = /^Command blocked by sandbox policy: (.+)$/.exec(content);
  if (m) return { ...result, content: bashMsg('blocked', { reason: m[1] }) };

  return result;
}

const BASH_PRODUCED_SCAN_LIMIT = 5000;
const BASH_PRODUCED_SKIP_DIRS = new Set([
  '.cache',
  '.git',
  '.github',
  '.hg',
  '.idea',
  '.mypy_cache',
  '.next',
  '.parcel-cache',
  '.pytest_cache',
  '.ruff_cache',
  '.svn',
  '.turbo',
  '.venv',
  '.vs',
  '.vscode',
  '__pycache__',
  'node_modules',
  'venv',
]);
const BASH_PRODUCED_SKIP_FILES = new Set([
  '.DS_Store',
]);
// Repo/package scaffolding that arrives when a skill clones or unpacks its own
// source tree into the workspace. These are never user deliverables, so the bash
// diff must not surface them as produced-file chips. Matched case-insensitively
// against the basename's stem (so README.md / README_CN.md / LICENCE all hit).
const BASH_PRODUCED_SKIP_NAME_STEMS = new Set([
  'agents',
  'authors',
  'changelog',
  'claude',
  'code_of_conduct',
  'contributing',
  'copying',
  'funding',
  'licence',
  'license',
  'notice',
  'readme',
  'security',
]);
// Dotfiles (no meaningful stem) that are repo config, never deliverables.
const BASH_PRODUCED_SKIP_DOTFILES = new Set([
  '.editorconfig',
  '.gitattributes',
  '.gitignore',
  '.npmrc',
  '.nvmrc',
]);

type BashFileSnapshotEntry = { mtimeMs: number; size: number };
type BashFileSnapshot = Map<string, BashFileSnapshotEntry>;

function shouldSkipBashProducedDir(name: string): boolean {
  return BASH_PRODUCED_SKIP_DIRS.has(name);
}

function shouldSkipBashProducedFile(name: string): boolean {
  if (BASH_PRODUCED_SKIP_FILES.has(name)) return true;
  const lower = name.toLowerCase();
  if (BASH_PRODUCED_SKIP_DOTFILES.has(lower)) return true;
  // `.env`, `.env.example`, `.env.local`, …
  if (lower === '.env' || lower.startsWith('.env.')) return true;
  // Stem = name before the first dot, so README.md → "readme". Dotfiles have an
  // empty stem and are handled above; this only matches real scaffold files.
  const stem = lower.split('.')[0];
  if (stem.length === 0) return false;
  if (BASH_PRODUCED_SKIP_NAME_STEMS.has(stem)) return true;
  // Localized readme variants (README_CN, README_EN, README_zh) are common in
  // cloned repos. Only readme prefix-matches; other scaffold names stay exact so
  // a real deliverable like "license_terms.pdf" is never dropped.
  return stem.split('_')[0] === 'readme';
}

function collectBashFileSnapshot(root: string): BashFileSnapshot {
  const out: BashFileSnapshot = new Map();
  const absRoot = path.resolve(root);
  const visit = (dir: string) => {
    if (out.size >= BASH_PRODUCED_SCAN_LIMIT) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (out.size >= BASH_PRODUCED_SCAN_LIMIT) return;
      const name = ent.name;
      if (ent.isDirectory()) {
        if (!shouldSkipBashProducedDir(name)) visit(path.join(dir, name));
        continue;
      }
      if (!ent.isFile() || shouldSkipBashProducedFile(name)) continue;
      const abs = path.join(dir, name);
      let st: fs.Stats;
      try { st = fs.statSync(abs); }
      catch { continue; }
      if (!st.isFile()) continue;
      out.set(path.resolve(abs), { mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  visit(absRoot);
  return out;
}

function emitBashProducedFiles(opts: LocalToolsOpts, before: BashFileSnapshot, root: string): void {
  if (!opts.onFileWritten) return;
  const after = collectBashFileSnapshot(root);
  for (const [abs, next] of after) {
    const prev = before.get(abs);
    if (prev && prev.mtimeMs === next.mtimeMs && prev.size === next.size) continue;
    try { opts.onFileWritten(abs); }
    catch (err) { log.warn(`onFileWritten callback failed: ${(err as Error).message}`); }
  }
}

function withBashOutputEnv(ctx: ToolContext, outputDir: string): () => void {
  const original = ctx.state.sandboxEnv as Record<string, string> | undefined;
  ctx.state.sandboxEnv = {
    ...(original ?? {}),
    ORKAS_OUTPUT_DIR: outputDir,
  };
  return () => {
    if (original) ctx.state.sandboxEnv = original;
    else delete ctx.state.sandboxEnv;
  };
}

type OrkasCliInvocation = {
  script: 'run-skill.cjs' | 'orkas-pkg.cjs';
  nodePath: string;
  scriptPath: string;
  args: string[];
  stdin?: string;
};

const ORKAS_DIRECT_CLI_SCRIPTS = new Set(['run-skill.cjs', 'orkas-pkg.cjs']);
const ORKAS_DIRECT_OUTPUT_LIMIT = 1024 * 1024;

function splitTrailingHeredoc(command: string): { command: string; stdin: string } | null {
  const open = /<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?\s*\r?\n/.exec(command);
  if (!open) return null;
  const marker = open[1];
  const bodyAndEnd = command.slice(open.index + open[0].length);
  const endRe = new RegExp(`\\r?\\n${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*(?:\\r?\\n)?$`);
  const end = endRe.exec(bodyAndEnd);
  if (!end) return null;
  return {
    command: command.slice(0, open.index).trimEnd(),
    stdin: bodyAndEnd.slice(0, end.index),
  };
}

function shellWords(input: string): string[] | null {
  const words: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let hasCur = false;
  const push = () => {
    if (!hasCur) return;
    words.push(cur);
    cur = '';
    hasCur = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else { cur += ch; hasCur = true; }
      continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === '\\' && i + 1 < input.length) {
        cur += input[++i];
      } else {
        cur += ch;
      }
      hasCur = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasCur = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[++i];
      hasCur = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    cur += ch;
    hasCur = true;
  }
  if (quote) return null;
  push();
  return words;
}

function expandOrkasEnvToken(token: string, env: Record<string, string>): string {
  return token
    .replace(/\$\{ORKAS_NODE\}/g, env.ORKAS_NODE || '')
    .replace(/\$ORKAS_NODE/g, env.ORKAS_NODE || '')
    .replace(/\$\{ORKAS_PC_DIR\}/g, env.ORKAS_PC_DIR || '')
    .replace(/\$ORKAS_PC_DIR/g, env.ORKAS_PC_DIR || '');
}

function sameResolvedPath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32'
    ? ra.toLowerCase() === rb.toLowerCase()
    : ra === rb;
}

function parseOrkasCliInvocation(
  input: Record<string, unknown>,
  ctx: ToolContext,
): OrkasCliInvocation | null {
  if (input.run_in_background === true) return null;
  const rawCommand = String(input.command ?? '');
  const heredoc = splitTrailingHeredoc(rawCommand);
  const command = heredoc?.command ?? rawCommand;
  const words = shellWords(command);
  if (!words || words.length < 2) return null;

  const sandboxEnv = (ctx.state.sandboxEnv ?? {}) as Record<string, string>;
  const nodePath = sandboxEnv.ORKAS_NODE;
  const pcDir = sandboxEnv.ORKAS_PC_DIR;
  if (!nodePath || !pcDir) return null;

  const resolvedNode = expandOrkasEnvToken(words[0], sandboxEnv);
  if (!sameResolvedPath(resolvedNode, nodePath)) return null;

  const scriptPath = expandOrkasEnvToken(words[1], sandboxEnv);
  const script = path.basename(scriptPath) as OrkasCliInvocation['script'];
  if (!ORKAS_DIRECT_CLI_SCRIPTS.has(script)) return null;
  if (!sameResolvedPath(scriptPath, path.join(pcDir, 'bin', script))) return null;

  return {
    script,
    nodePath,
    scriptPath: path.resolve(scriptPath),
    args: words.slice(2),
    ...(heredoc ? { stdin: heredoc.stdin } : {}),
  };
}

async function executeDirectOrkasCli(
  invocation: OrkasCliInvocation,
  input: Record<string, unknown>,
  ctx: ToolContext,
  workingDir: string,
): Promise<ToolResult> {
  const timeoutMs = (input.timeoutMs as number | undefined) ?? 300_000;
  const sandboxEnv = (ctx.state.sandboxEnv ?? {}) as Record<string, string>;
  const env = buildSandboxEnv(sandboxEnv);

  return await new Promise<ToolResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let truncatedKind: 'stdout' | 'stderr' | null = null;
    let settled = false;

    const child = spawn(invocation.nodePath, [invocation.scriptPath, ...invocation.args], {
      cwd: workingDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const killChild = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, 5000);
    };

    const append = (kind: 'stdout' | 'stderr', data: Buffer) => {
      if (outputLimitExceeded) return;
      totalBytes += data.length;
      if (totalBytes > ORKAS_DIRECT_OUTPUT_LIMIT) {
        outputLimitExceeded = true;
        truncatedKind = kind;
        const allowed = Math.max(0, data.length - (totalBytes - ORKAS_DIRECT_OUTPUT_LIMIT));
        if (allowed > 0) {
          (kind === 'stdout' ? stdoutChunks : stderrChunks).push(data.subarray(0, allowed));
        }
        killChild();
        return;
      }
      (kind === 'stdout' ? stdoutChunks : stderrChunks).push(data);
    };

    child.stdout.on('data', (data: Buffer) => append('stdout', data));
    child.stderr.on('data', (data: Buffer) => append('stderr', data));

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();

    child.on('error', (err) => {
      finish({ content: bashMsg('start_failed', { command: invocation.script, error: err.message }), isError: true });
    });
    child.on('close', (code) => {
      let stdout = decodeProcessOutput(Buffer.concat(stdoutChunks), process.platform, env);
      let stderr = decodeProcessOutput(Buffer.concat(stderrChunks), process.platform, env);
      if (outputLimitExceeded) {
        if (truncatedKind === 'stdout') stdout += '\n... [output truncated by sandbox]';
        else stderr += '\n... [output truncated by sandbox]';
      }
      if (timedOut) {
        finish({ content: bashMsg('timeout', { ms: timeoutMs }), isError: true });
        return;
      }
      if (outputLimitExceeded) {
        finish({ content: stderr || stdout, isError: code !== 0 });
        return;
      }
      if (code !== 0) {
        finish({ content: stderr || stdout || bashMsg('exit_code', { code: code ?? 'null' }), isError: true });
        return;
      }
      finish({ content: stdout });
    });

    child.stdin.end(invocation.stdin ?? '');
  });
}

async function executeCoreBashWithOutputTracking(
  opts: LocalToolsOpts,
  input: Record<string, unknown>,
  ctx: ToolContext,
  workingDir: string,
): Promise<ToolResult> {
  const outputDir = workingDir;
  const before = opts.onFileWritten ? collectBashFileSnapshot(outputDir) : new Map<string, BashFileSnapshotEntry>();
  const restoreEnv = withBashOutputEnv(ctx, outputDir);
  try {
    const direct = parseOrkasCliInvocation(input, ctx);
    const result = direct
      ? await executeDirectOrkasCli(direct, input, ctx, workingDir)
      : await coreBashTool.execute(input, ctx);
    if (!result.isError) emitBashProducedFiles(opts, before, outputDir);
    return translateFixedBashError(result);
  } finally {
    restoreEnv();
  }
}

/** Assemble the edit-time sandbox roots for the current (uid, cid). Mirrors
 *  `file-tools.ts::allowedRoots` so the read-side and edit-side share the
 *  same visible scope. Returns [] when uid is missing — guardPath then
 *  rejects with E_NO_SCOPE rather than silently allowing an unscoped edit. */
function allowedRootsFor(opts: LocalToolsOpts): string[] {
  const roots: string[] = [];
  if (opts.userId) {
    try {
      const ws = getWorkspacePath(opts.userId, opts.projectId);
      if (ws) roots.push(ws);
    } catch (err) { log.warn(`edit_file resolve workspace: ${(err as Error).message}`); }
    if (opts.cid) {
      try { roots.push(chatAttachmentDir(opts.userId, opts.cid)); }
      catch (err) { log.warn(`edit_file resolve attachment dir: ${(err as Error).message}`); }
    }
  }
  if (opts.extraRoots?.length) {
    for (const r of opts.extraRoots) if (r) roots.push(r);
  }
  return roots;
}

function guardEditPath(opts: LocalToolsOpts, abs: string): string | null {
  const roots = allowedRootsFor(opts);
  if (!roots.length) {
    return errText('E_NO_SCOPE', 'no visible roots for this conversation');
  }
  if (!isPathAllowed(abs, roots)) {
    return errText(
      'E_PATH_OUT_OF_SCOPE',
      `path is outside the current conversation's visible scope (workspace + attachments): ${abs}`,
    );
  }
  return null;
}

/** Like `guardEditPath` but also accepts `readOnlyExtraRoots`. Used only by
 *  `delete_file`, where the per-call UI confirmation is the gate that
 *  justifies including read-only roots in the deletable set. See the
 *  `readOnlyExtraRoots` comment on `LocalToolsOpts`. */
function guardDeletePath(opts: LocalToolsOpts, abs: string): string | null {
  const roots = allowedRootsFor(opts);
  if (opts.readOnlyExtraRoots?.length) {
    for (const r of opts.readOnlyExtraRoots) if (r) roots.push(r);
  }
  if (!roots.length) {
    return errText('E_NO_SCOPE', 'no visible roots for this conversation');
  }
  if (!isPathAllowed(abs, roots)) {
    return errText(
      'E_PATH_OUT_OF_SCOPE',
      `path is outside the current conversation's deletable scope (workspace + attachments + read-only roots): ${abs}`,
    );
  }
  return null;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

function extractRunSkillRefs(command: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[^\w.-])run-skill\.cjs["']?\s+(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const ref = (m[1] || m[2] || m[3] || '').trim();
    if (ref) out.push(ref);
  }
  return out;
}

function commandMentionsSkillRoot(command: string, uid: string, skillId: string): boolean {
  const unescaped = command.replace(/\\([\\ "'$`])/g, '$1');
  const roots = [
    path.resolve(userSkillsDir(uid), skillId),
    path.resolve(userMarketplaceSkillsDir(uid), skillId),
    path.posix.join('cloud', 'skills', skillId),
    path.posix.join('local', 'marketplace', 'skills', skillId),
  ];
  return roots.some((root) => unescaped.includes(root));
}

function guardDisabledSkillBash(opts: LocalToolsOpts, command: string): string | null {
  const uid = opts.userId;
  if (!uid || !command) return null;

  const disabled = readDisabledSets(uid).skills;
  if (!disabled.size) return null;

  for (const ref of extractRunSkillRefs(command)) {
    if (disabled.has(ref)) {
      return errText(
        'E_SKILL_DISABLED',
        `skill "${ref}" is disabled for this user; re-enable it before running its workflow.`,
      );
    }
  }

  for (const skillId of disabled) {
    if (commandMentionsSkillRoot(command, uid, skillId)) {
      return errText(
        'E_SKILL_DISABLED',
        `skill "${skillId}" is disabled for this user; re-enable it before running its workflow.`,
      );
    }
  }

  return null;
}

/** Wrapped `bash` tool — identical schema, permission-gated, host-shell wording. */
function createBashTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'bash',
    description:
      'Execute a shell command on the user\'s local machine and return its output. ' +
      'Use for installing CLIs (brew, npm, pip), running builds, converting files, ' +
      'inspecting the filesystem, and any other host-side work. The shell runs in ' +
      'the user\'s current workspace directory. For files generated by scripts that ' +
      'should be shown to the user as produced-file chips (for example .docx, .xlsx, ' +
      '.pptx, .pdf, images, HTML, CSV, Markdown), write them under the absolute ' +
      '$ORKAS_OUTPUT_DIR path, which is the current conversation workspace. ' +
      'Scratch/cache files should stay in temporary or cache directories.',
    inputSchema: coreBashTool.inputSchema,
    async execute(input, ctx) {
      const mode = getLocalExecMode();
      if (mode === 'off') return deniedResult();
      const command = String(input.command ?? '');
      const disabledSkillErr = guardDisabledSkillBash(opts, command);
      if (disabledSkillErr) {
        log.warn(`bash disabled skill reject user=${opts.userId ?? '?'} command=${command.slice(0, 160)}`);
        return { content: disabledSkillErr, isError: true };
      }
      // risk_prompt: classify the command and block on user confirmation when
      // it trips a risk category (network exfil / dangerous delete / priv-esc
      // / sensitive path). allow_all skips this; off already returned above.
      if (mode === 'risk_prompt' && command.trim()) {
        const { risky, reasons } = classifyBashCommand(command);
        if (risky) {
          const decision = await requestBashDecision({
            uid: opts.userId ?? '',
            cid: opts.cid ?? '',
            agentId: opts.agentId ?? '',
            agentName: opts.agentName ?? opts.agentId ?? '',
            command,
            reasons,
          });
          if (decision === 'deny') {
            log.warn(`bash risk-denied user=${opts.userId ?? '?'} reasons=${reasons.join(',')}`);
            return {
              content: errText(
                'E_BASH_RISK_DENIED',
                `the user declined to run this command (flagged: ${reasons.join(', ')}). `
                + 'Do not retry the same command or work around the prompt; explain in prose what you intended and ask the user how to proceed.',
              ),
              isError: true,
            };
          }
        }
      }
      // `conv_workspace.ts` intentionally defers materialising the
      // per-conversation workspace dir; bash is a frequent first toucher
      // because `child_process.spawn` fails ENOENT if cwd doesn't exist.
      // Two distinct paths so the rmdir-if-empty cleanup only runs on
      // the cold path (this call is the FIRST to need the dir):
      //
      //   hot path  — `ctx.workingDir` already exists (a prior write_file
      //               or earlier bash call materialised it). Skip mkdir,
      //               skip post-check, just delegate. This is every bash
      //               call from the second one onward in a productive
      //               conversation, and stays zero-overhead.
      //
      //   cold path — `ctx.workingDir` doesn't exist yet. We create it,
      //               run bash, then if the command produced nothing
      //               (`ls` / `cat` / `pwd` / `gh search` / pure python
      //               heredoc returning via stdout) the dir is rmdir'd
      //               so a read-only conversation leaves no footprint.
      //               Best-effort cleanup: any rmdir failure (concurrent
      //               bash on same cwd, ENOTEMPTY, EACCES) is silently
      //               swallowed.
      if (!ctx.workingDir) return translateFixedBashError(await coreBashTool.execute(input, ctx));
      const workingDir = path.resolve(ctx.workingDir);
      if (fs.existsSync(workingDir)) {
        return executeCoreBashWithOutputTracking(opts, input, ctx, workingDir);
      }
      try { fs.mkdirSync(ctx.workingDir, { recursive: true }); }
      catch { /* let spawn produce the canonical error */ }
      try {
        return await executeCoreBashWithOutputTracking(opts, input, ctx, workingDir);
      } finally {
        try {
          if (fs.readdirSync(ctx.workingDir).length === 0) {
            fs.rmdirSync(ctx.workingDir);
          }
        } catch { /* best-effort */ }
      }
    },
  };
}

/** Wrapped `write_file` tool — uniquify-on-collision + onFileWritten emit. */
function createWriteFileTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'write_file',
    description:
      'Write content to a file. Use this for workspace artefacts the user wants to keep ' +
      '(notes, source code, markdown, CSV, etc.). Creates parent directories as needed. ' +
      'If the target path already exists and was not written by you earlier in this turn, ' +
      'the basename is automatically suffixed (`-2 / -3 / ...`) to avoid clobbering, and ' +
      'the rename is surfaced in a `<file-renamed>` block in the tool result. Always read ' +
      'that block (when present) and use the saved path verbatim in any subsequent read or ' +
      'message to the user.',
    inputSchema: coreWriteFileTool.inputSchema,
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();
      const inputPath = String(input.path ?? '');
      const inputAbs = resolveAbs(ctx, inputPath);
      if (opts.userId) {
        const scopeErr = guardEditPath(opts, inputAbs);
        if (scopeErr) {
          log.warn(`write_file scope reject user=${opts.userId ?? '?'} path=${inputAbs}`);
          return { content: scopeErr, isError: true };
        }
      }
      const { finalPath, renamed } = await uniquifyPath(inputAbs, isMineFor(opts));
      const rewritten = finalPath !== inputAbs
        ? { ...input, path: finalPath }
        : input;
      const result = await coreWriteFileTool.execute(rewritten, ctx);
      if (!result.isError && opts.onFileWritten) {
        try {
          opts.onFileWritten(finalPath);
        } catch (err) {
          log.warn(`onFileWritten callback failed: ${(err as Error).message}`);
        }
      }
      if (!result.isError && renamed) {
        return {
          ...result,
          content: `${result.content ?? ''}${renderRenameSignal(inputAbs, finalPath)}`,
        };
      }
      return result;
    },
  };
}

/** Wrapped `edit_file` tool — in-place string replacement on existing text files.
 *  Sandbox-checked, permission-gated, no uniquify (semantics is "modify in place").
 *  pdf/docx/image kinds rejected — those are extracted-only. */
function createEditFileTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'edit_file',
    description:
      'Replace `old_string` with `new_string` inside an existing text file. ' +
      'Cheaper and safer than rewriting the whole file via `write_file`; the rest of the file is preserved verbatim.\n' +
      '\n' +
      'Parameters:\n' +
      '  path        — required. Absolute or workspace-relative path. The file MUST already exist.\n' +
      '  old_string  — required. Exact text to find. Must be unique in the file unless `replace_all=true`.\n' +
      '  new_string  — required. Replacement text. May be empty (deletes `old_string`).\n' +
      '  replace_all — optional, default false. When true, every occurrence of `old_string` is replaced.\n' +
      '\n' +
      'How to use:\n' +
      '  - Prefer this over `write_file` for targeted edits to existing files.\n' +
      '  - To CREATE a new file, use `write_file` instead — `edit_file` does not create files.\n' +
      '  - Make `old_string` long enough to be unique. On `E_MULTIPLE_MATCHES`, expand `old_string` with surrounding context, or set `replace_all=true` if every occurrence should change.\n' +
      '  - Cannot edit pdf / docx / image files (text from those is extracted, not the source). Use `write_file` if you really need to overwrite the binary.\n' +
      '\n' +
      'Permission: requires local execution permission (same gate as `write_file` / `bash`).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path to an existing file.' },
        old_string: { type: 'string', description: 'Exact text to find. Must be unique unless replace_all=true.' },
        new_string: { type: 'string', description: 'Replacement text. May be empty.' },
        replace_all: { type: 'boolean', description: 'Default false. When true, every occurrence of old_string is replaced.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();

      const rawPath = String(input.path ?? '');
      if (!rawPath) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const oldStr = typeof input.old_string === 'string' ? input.old_string : null;
      const newStr = typeof input.new_string === 'string' ? input.new_string : null;
      if (oldStr === null || newStr === null) {
        return { content: errText('E_BAD_INPUT', '`old_string` and `new_string` are both required strings'), isError: true };
      }
      if (oldStr.length === 0) {
        return { content: errText('E_BAD_INPUT', '`old_string` must be non-empty'), isError: true };
      }
      if (oldStr === newStr) {
        return { content: errText('E_BAD_INPUT', '`old_string` and `new_string` are identical — no-op rejected'), isError: true };
      }
      const replaceAll = input.replace_all === true;

      const abs = resolveAbs(ctx, rawPath);
      const scopeErr = guardEditPath(opts, abs);
      if (scopeErr) {
        log.warn(`edit_file scope reject user=${opts.userId ?? '?'} path=${abs}`);
        return { content: scopeErr, isError: true };
      }

      let st: fs.Stats;
      try { st = fs.statSync(abs); }
      catch (err) {
        log.warn(`edit_file not-found user=${opts.userId ?? '?'} path=${abs}: ${(err as Error).message}`);
        return {
          content: errText('E_NOT_FOUND', `${abs}: file does not exist (use write_file to create new files)`),
          isError: true,
        };
      }
      if (!st.isFile()) {
        return { content: errText('E_NOT_FOUND', `${abs}: not a regular file`), isError: true };
      }

      const kind = kindOf(abs);
      if (kind === 'pdf' || kind === 'docx' || kind === 'image') {
        return {
          content: errText(
            'E_NOT_EDITABLE',
            `${abs}: kind=${kind} is not editable in place (extracted format). Use write_file to overwrite the file if you really need to.`,
          ),
          isError: true,
        };
      }

      let body: string;
      try { body = fs.readFileSync(abs, 'utf8'); }
      catch (err) {
        const msg = (err as Error).message;
        log.warn(`edit_file read failed user=${opts.userId ?? '?'} path=${abs}: ${msg}`);
        return { content: errText('E_EDIT_FAILED', `${abs}: read failed: ${msg}`), isError: true };
      }

      const count = countOccurrences(body, oldStr);
      if (count === 0) {
        return { content: errText('E_NO_MATCH', `${abs}: \`old_string\` not found in file`), isError: true };
      }
      if (count > 1 && !replaceAll) {
        return {
          content: errText(
            'E_MULTIPLE_MATCHES',
            `${abs}: \`old_string\` matches ${count} occurrences. Provide more surrounding context to make it unique, or set replace_all=true.`,
          ),
          isError: true,
        };
      }

      const next = replaceAll ? body.split(oldStr).join(newStr) : body.replace(oldStr, newStr);

      try {
        fs.writeFileSync(abs, next, 'utf8');
      } catch (err) {
        const msg = (err as Error).message;
        log.warn(`edit_file write failed user=${opts.userId ?? '?'} path=${abs}: ${msg}`);
        return { content: errText('E_EDIT_FAILED', `${abs}: write failed: ${msg}`), isError: true };
      }

      const replaced = replaceAll ? count : 1;
      log.info(`edit_file user=${opts.userId ?? '?'} replaced=${replaced} path=${abs}`);

      if (opts.onFileWritten) {
        try { opts.onFileWritten(abs); }
        catch (err) { log.warn(`onFileWritten callback failed: ${(err as Error).message}`); }
      }

      return {
        content: `<file path="${abs}" edited="${replaced}" kind="${kind}"/>`,
      };
    },
  };
}

/** `markdown_to_pdf` — zero-dependency built-in channel. */
function createMarkdownToPdfTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'markdown_to_pdf',
    description:
      'Render Markdown content to a PDF file at the given path. ' +
      'Supports headings, paragraphs, bold, italic, inline code, fenced code blocks, ' +
      'ordered and unordered lists, horizontal rules, and links. ' +
      'For tables or custom styling, generate HTML yourself and call `html_to_pdf` instead. ' +
      'No external tools required (no pandoc / wkhtmltopdf). ' +
      'If the target path already exists and was not written by you earlier in this turn, ' +
      'the basename is automatically suffixed (`-2 / -3 / ...`) to avoid clobbering, and ' +
      'the rename is surfaced in a `<file-renamed>` block in the tool result.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output PDF path (absolute or relative to the workspace).' },
        markdown: { type: 'string', description: 'Markdown source text.' },
        title: { type: 'string', description: 'Optional document title (shown in the PDF metadata).' },
        pageSize: { type: 'string', description: 'A4 | A3 | Letter | Legal | Tabloid. Default: A4.' },
        landscape: { type: 'boolean', description: 'Default: false.' },
      },
      required: ['path', 'markdown'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();
      const inputAbs = resolveAbs(ctx, String(input.path ?? ''));
      const { finalPath, renamed } = await uniquifyPath(inputAbs, isMineFor(opts));
      try {
        await markdownToPdf(String(input.markdown ?? ''), finalPath, {
          ...(typeof input.title === 'string' ? { title: input.title } : {}),
          ...(typeof input.pageSize === 'string' ? { pageSize: input.pageSize as any } : {}),
          ...(typeof input.landscape === 'boolean' ? { landscape: input.landscape } : {}),
        });
        if (opts.onFileWritten) {
          try { opts.onFileWritten(finalPath); } catch (err) { log.warn(`onFileWritten: ${(err as Error).message}`); }
        }
        const base = `PDF written: ${finalPath}`;
        return { content: renamed ? `${base}${renderRenameSignal(inputAbs, finalPath)}` : base };
      } catch (err) {
        return { content: `Error generating PDF: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

/** `html_to_pdf` — escape hatch for hand-crafted HTML (tables, custom CSS, etc.). */
function createHtmlToPdfTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'html_to_pdf',
    description:
      'Render an HTML document to a PDF file at the given path. ' +
      'Use this when you need tables, custom styling, or layout beyond what `markdown_to_pdf` supports. ' +
      'The input should be a complete HTML document including <html>, <head>, and <body> tags. ' +
      'If the target path already exists and was not written by you earlier in this turn, ' +
      'the basename is automatically suffixed (`-2 / -3 / ...`) to avoid clobbering, and ' +
      'the rename is surfaced in a `<file-renamed>` block in the tool result.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output PDF path (absolute or relative to the workspace).' },
        html: { type: 'string', description: 'Complete HTML document source.' },
        pageSize: { type: 'string', description: 'A4 | A3 | Letter | Legal | Tabloid. Default: A4.' },
        landscape: { type: 'boolean', description: 'Default: false.' },
      },
      required: ['path', 'html'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();
      const inputAbs = resolveAbs(ctx, String(input.path ?? ''));
      const { finalPath, renamed } = await uniquifyPath(inputAbs, isMineFor(opts));
      try {
        await htmlToPdf(String(input.html ?? ''), finalPath, {
          ...(typeof input.pageSize === 'string' ? { pageSize: input.pageSize as any } : {}),
          ...(typeof input.landscape === 'boolean' ? { landscape: input.landscape } : {}),
        });
        if (opts.onFileWritten) {
          try { opts.onFileWritten(finalPath); } catch (err) { log.warn(`onFileWritten: ${(err as Error).message}`); }
        }
        const base = `PDF written: ${finalPath}`;
        return { content: renamed ? `${base}${renderRenameSignal(inputAbs, finalPath)}` : base };
      } catch (err) {
        return { content: `Error generating PDF: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

/** `create_artifact` — build an interactive multi-file app shown live
 *  inside the chat bubble (sandboxed `<iframe>` over the `chat-app://`
 *  protocol). Permission-gated like the other write-style tools; writes only
 *  into the current conversation's artifact pool (`chat_artifacts/<cid>/`),
 *  never the workspace. On success fires `onArtifactCreated` so the caller
 *  attaches it to the assistant message record. */
function createCreateArtifactTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'create_artifact',
    description:
      'Build a small interactive app (self-contained HTML/CSS/JS) that is rendered LIVE and clickable inside this chat reply, embedded in a sandboxed iframe.\n' +
      '\n' +
      'Use it for: interactive dashboards, calculators, data visualizations with filters or drill-down, configurators, simulators, quizzes, mini-games — anything the user should operate directly. For static/read-only KPI, table, timeline, alert, or simple chart summaries, prefer `:::dashboard`. Do NOT use it for static documents (use `html_to_pdf`) or images (use `generate_image`).\n' +
      '\n' +
      'Input: `{ title?, files: [{ path, content, encoding? }, ...] }`\n' +
      '  - `files` MUST include a top-level `index.html` (the entry point). Up to 20 files, 256 KB per file, 1 MB total.\n' +
      '  - `path` is a forward-slash relative path (e.g. `index.html`, `assets/app.js`). No `..`, no leading `/`, no dotfiles, no `__orkas/...`.\n' +
      '  - Allowed extensions: text — `.html .htm .js .mjs .css .json .svg .xml .txt .csv`; binary (base64 only) — `.png .jpg .jpeg .gif .webp .ico .wasm .woff .woff2 .ttf .otf`.\n' +
      '  - `content` is UTF-8 text by default; for a binary extension set `"encoding":"base64"` and pass base64 bytes.\n' +
      '\n' +
      'Constraints: the app runs OFFLINE — no network, no external CDN. Inline your CSS/JS or split into sibling files referenced by RELATIVE URL. The iframe is sandboxed (scripts + forms allowed; it cannot reach the host app).\n' +
      '\n' +
      'To get what the user does back: the app sends a message to its parent —\n' +
      '  `parent.postMessage({ __orkasArtifact: true, type: "submit", payload: <json-serialisable value> }, "*")`\n' +
      'and that arrives as the user\'s next message to you (a readable summary plus a machine tag). Optionally include `<script src="__orkas/bridge.js"></script>` to get `window.orkasArtifact.send(payload)` plus automatic iframe height — without the bridge the iframe is a fixed height (call `window.orkasArtifact.resize(px)` or post `{type:"resize",height:px}` to change it).\n' +
      '\n' +
      'After calling this tool, do NOT also paste the artifact\'s HTML in your reply — it is already shown.\n' +
      '\n' +
      'Permission: requires local execution permission (same gate as `write_file` / `html_to_pdf`).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title shown above the embedded app. Optional; defaults to "Interactive app".' },
        files: {
          type: 'array',
          description: 'The app files. Must include a top-level "index.html". Max 20 files, 256KB/file, 1MB total.',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Forward-slash relative path, e.g. "index.html" or "assets/app.js". No "..", no leading "/", no dotfiles, no "__orkas/...".' },
              content: { type: 'string', description: 'File contents. UTF-8 text by default; for a binary extension set "encoding":"base64" and pass base64.' },
              encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default "utf8". Use "base64" for image / font / wasm files.' },
            },
            required: ['path', 'content'],
          },
        },
      },
      required: ['files'],
    },
    async execute(input) {
      if (!getLocalExecGranted()) return deniedResult();
      const uid = opts.userId;
      const cid = opts.cid;
      if (!uid || !cid) {
        return { content: errText('E_NO_CONVERSATION', 'create_artifact is only available inside a conversation.'), isError: true };
      }
      const r = chatArtifacts.createArtifact(uid, cid, opts.agentId || '', {
        title: (input as { title?: unknown }).title,
        files: (input as { files?: unknown }).files,
      });
      if (!r.ok) {
        // Cast in the error branch — `strictNullChecks: false` keeps the
        // whole `Result<>` union here (codebase-wide workaround).
        const errMsg = (r as { error?: string }).error || 'invalid artifact';
        log.warn(`create_artifact reject user=${uid} cid=${cid}: ${errMsg}`);
        return { content: errText('E_BAD_ARTIFACT', errMsg), isError: true };
      }
      if (opts.onArtifactCreated) {
        try { opts.onArtifactCreated({ id: r.artifactId, title: r.title }); }
        catch (err) { log.warn(`onArtifactCreated callback failed: ${(err as Error).message}`); }
      }
      log.info(`create_artifact user=${uid} cid=${cid} id=${r.artifactId} agent=${opts.agentId || ''}`);
      return {
        content:
          `Artifact "${r.title}" created (id ${r.artifactId}) — it is now shown to the user inside this reply, so do NOT paste its HTML in your message. ` +
          `To receive what the user does in it, the app calls ` +
          `parent.postMessage({ __orkasArtifact: true, type: "submit", payload: <json-serialisable value> }, "*") ` +
          `(or, with <script src="__orkas/bridge.js"></script>, window.orkasArtifact.send(payload)); ` +
          `that becomes the user's next message to you.`,
      };
    },
  };
}

/** Wrapped `delete_file` tool — single-file unlink, sandboxed identically to
 *  `edit_file` (workspace + current attachment dir + extraRoots / readonly).
 *  Destructive, so on top of `localExec` we require a per-call user click
 *  in the inline confirm card. The renderer may group multiple pending
 *  per-file tokens from the same turn into one card, but the tool still
 *  consumes one token per file.
 *
 *  Async token model (does NOT block the LLM turn — see
 *  delete-file-confirm.ts header):
 *    - First call: `delete_file({path})` (no token). Tool mints a token,
 *      emits/adds to a card, and returns IMMEDIATELY with `requires_user_confirmation`
 *      so the LLM can keep doing other tool calls / finish the turn.
 *      Skill-creator authoring rules require the LLM to stop in prose
 *      after this and ask the user; never retry in the same turn.
 *    - Second call: `delete_file({path, confirmation_token})`. Tool
 *      checks the token's state:
 *        granted → unlink
 *        pending → tell LLM the user hasn't clicked yet
 *        denied  → tell LLM the user said no
 *        invalid → token expired / wrong path; mint a fresh one
 */
function createDeleteFileTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'delete_file',
    description:
      'Delete a single file from disk via a two-step user-confirmed flow.\n' +
      '\n' +
      'Sandbox is identical to `edit_file` (workspace + current attachment ' +
      'dir + extraRoots / readonly). Use instead of `bash rm` — `bash` is ' +
      'unaware of the sandbox + the confirm gate.\n' +
      '\n' +
      'Flow:\n' +
      '  Step 1 — `delete_file({path})` (no token). Tool emits an inline ' +
      'confirm card to the user and returns `requires_user_confirmation: ' +
      'true` with a `confirmation_token`. Multiple Step 1 calls from the ' +
      'same turn may be grouped into one user-facing card. The tool does NOT block. Tell ' +
      'the user in prose what you intend to delete; do NOT retry with ' +
      'the token in the same turn — wait for the user to click the card ' +
      'and reply, then retry on the next turn.\n' +
      '  Step 2 — `delete_file({path, confirmation_token})`. Tool checks ' +
      'the token state: granted → unlink + return success; pending → user ' +
      "hasn't clicked yet, stop and wait; denied → user declined, give up; " +
      'invalid → token expired or path changed, call Step 1 again.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Relative or absolute path to the file to delete. Resolved against the conversation working directory.',
        },
        confirmation_token: {
          type: 'string',
          description:
            "Token returned by a prior delete_file call's `requires_user_confirmation` result. Pass it back on the second call to actually perform the unlink after the user has clicked the confirm card. Omit on the first call.",
        },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();

      const rawPath = String(input.path ?? '');
      if (!rawPath) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const token = typeof input.confirmation_token === 'string' && input.confirmation_token.trim()
        ? input.confirmation_token.trim()
        : '';

      const abs = resolveAbs(ctx, rawPath);
      const scopeErr = guardDeletePath(opts, abs);
      if (scopeErr) {
        log.warn(`delete_file scope reject user=${opts.userId ?? '?'} path=${abs}`);
        return { content: scopeErr, isError: true };
      }

      // ── Step 2: token-bearing call → consume + unlink if granted.
      if (token) {
        const outcome = consumeGrantedConfirmation(token, abs);
        if (outcome.outcome === 'pending') {
          return {
            content: errText(
              'E_AWAITING_USER',
              `${abs}: the user has not clicked the confirmation card yet. Stop the turn here, ask the user to confirm, and retry with the same confirmation_token after they reply.`,
            ),
            isError: true,
          };
        }
        if (outcome.outcome === 'denied') {
          log.info(`delete_file denied (token) user=${opts.userId ?? '?'} path=${abs}`);
          return {
            content: errText(
              'E_USER_DENIED',
              `${abs}: the user declined the deletion. Do not retry; treat the file as kept.`,
            ),
            isError: true,
          };
        }
        if (outcome.outcome === 'invalid') {
          return {
            content: errText(
              'E_INVALID_TOKEN',
              `${abs}: the confirmation_token is unknown / expired / mismatched with the path. Call delete_file again WITHOUT the token to mint a fresh card.`,
            ),
            isError: true,
          };
        }
        // granted — verify file still exists and unlink.
        let st: fs.Stats;
        try { st = fs.statSync(abs); }
        catch (err) {
          log.warn(`delete_file granted-but-missing user=${opts.userId ?? '?'} path=${abs}: ${(err as Error).message}`);
          return {
            content: errText('E_NOT_FOUND', `${abs}: file no longer exists (already removed?)`),
            isError: true,
          };
        }
        if (!st.isFile()) {
          return {
            content: errText('E_NOT_FILE', `${abs}: not a regular file`),
            isError: true,
          };
        }
        try { fs.unlinkSync(abs); }
        catch (err) {
          const msg = (err as Error).message;
          log.warn(`delete_file unlink failed user=${opts.userId ?? '?'} path=${abs}: ${msg}`);
          return {
            content: errText('E_DELETE_FAILED', `${abs}: unlink failed: ${msg}`),
            isError: true,
          };
        }
        log.info(`delete_file user=${opts.userId ?? '?'} path=${abs}`);
        return { content: `Deleted ${abs}` };
      }

      // ── Step 1: no token → check file exists, mint token + emit card.
      let st: fs.Stats;
      try { st = fs.statSync(abs); }
      catch (err) {
        log.warn(`delete_file not-found user=${opts.userId ?? '?'} path=${abs}: ${(err as Error).message}`);
        return {
          content: errText('E_NOT_FOUND', `${abs}: file does not exist`),
          isError: true,
        };
      }
      if (!st.isFile()) {
        return {
          content: errText('E_NOT_FILE', `${abs}: not a regular file (refuse to recursively delete directories from this tool)`),
          isError: true,
        };
      }
      const newToken = requestDeleteConfirmation(abs, {
        display_path: rawPath,
        cid: opts.cid,
        turn_id: opts.turnId,
      });
      log.info(`delete_file confirmation requested user=${opts.userId ?? '?'} path=${abs} token=${newToken}`);
      return {
        content:
          `requires_user_confirmation: "${rawPath}" has been added to the user's confirmation card.\n` +
          `confirmation_token: ${newToken}\n` +
          `Next step: stop calling tools this turn after requesting all intended deletes. In your reply prose, tell the user what you plan to delete and ask them to click the card. ` +
          `On the user's next reply, call delete_file again with BOTH \`path\` and \`confirmation_token\` set to complete the deletion.`,
      };
    },
  };
}

/** Build the array of local-machine tools for a single runner. */
export function createLocalTools(opts: LocalToolsOpts = {}): AgentTool[] {
  const tools: AgentTool[] = [
    createBashTool(opts),
    createWriteFileTool(opts),
    createEditFileTool(opts),
    createDeleteFileTool(opts),
    createMarkdownToPdfTool(opts),
    createHtmlToPdfTool(opts),
  ];
  // `create_artifact` only makes sense on a conversation surface that
  // renders the embedded result and routes interactions back — i.e. a `cid`
  // plus an `onArtifactCreated` sink (group chat). Edit chats / ad-hoc runs
  // don't pass the sink, so the tool isn't offered there.
  if (opts.cid && opts.onArtifactCreated) tools.push(createCreateArtifactTool(opts));
  return tools;
}

export { createFileTools } from './file-tools';

/** Exposed for tests / diagnostics. */
export { DENY_MESSAGE };
