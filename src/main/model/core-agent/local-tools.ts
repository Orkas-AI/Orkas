/**
 * Local-machine tool wrappers injected into every AgentRunner built by
 * this app.
 *
 * Local-machine tools:
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
 *                       existing"); non-text/extracted kinds rejected; on
 *                       success fires `onFileWritten` so the UI can show
 *                       the green chip. Companion to `write_file` for
 *                       cheap targeted edits without a full overwrite.
 *   - `markdown_to_pdf` — built-in PDF channel (no pandoc/wkhtmltopdf
 *                       dependency). Renders via util/md-to-pdf +
 *                       Electron's webContents.printToPDF.
 *   - `html_to_pdf`   — same, for hand-crafted HTML input.
 *   - `interactive_cli_*` — live stdin/stdout sessions for CLIs that need
 *                       user interaction such as OAuth codes or setup prompts.
 *
 * Permission gate: every execute() re-reads the local access mode so a
 * mid-conversation settings change takes effect on the next tool call without
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

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import {
  BASH_PROGRESS_INTERVAL_MS,
  bashTool as coreBashTool,
  normalizeBashTimeoutMs,
  writeFileTool as coreWriteFileTool,
} from '../../../core-agent/src/tools/builtin';
import { buildSandboxEnv, decodeProcessOutput, killProcessTree } from '../../../core-agent/src/sandbox/executor';
import {
  ProcessOutputCapture,
  discardStreamedToolOutput,
  type CapturedProcessOutput,
} from '../../../core-agent/src/sandbox/output-capture';
import {
  getLocalExecGranted,
  getLocalExecMode,
  localAccessAllowsOutsideWorkspace,
  localAccessRequiresSensitiveApproval,
} from '../../features/permissions';
import { classifyConfiguredBashCommand, sensitivePathReasons, type LocalAccessRiskCategory } from '../../features/local_access_policy';
import { classifyBashCommand } from './bash-risk';
import { requestBashDecision } from './bash-permissions';
import { markdownToPdf, htmlToPdf } from '../../util/md-to-pdf';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { isPathAllowed } from '../../util/path-sandbox';
import { kindOf } from '../../features/file_indexer';
import { getWorkspacePath } from '../../features/user_workspace';
import {
  userMarketplaceAgentsDir,
  userMarketplaceSkillsDir,
  userSystemSkillsDir,
  userSkillsDir,
} from '../../paths';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import * as chatArtifacts from '../../features/chat_artifacts';
import { finalizeProducedArtifact, producedDocumentFooterText } from '../../features/produced_output_hooks';
import { readDisabledSets } from '../../features/component_enabled';
import {
  cancelConfirmation as cancelDeleteConfirmation,
  consumeGrantedConfirmation,
  requestConfirmation as requestDeleteConfirmation,
  waitForConfirmationVisible as waitForDeleteConfirmationVisible,
} from './delete-file-confirm';
import { fileEditLock } from '../../util/locks';
import { checkEditFreshness, recordRead } from './read-tracker';
import { createLogger } from '../../logger';
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';
import { t } from '../../i18n';
import {
  closeInteractiveCliSession,
  readInteractiveCliSession,
  sendInteractiveCliInput,
  startInteractiveCliSession,
} from './interactive-cli-sessions';
import type { InteractiveCliSessionView } from './interactive-cli-sessions';
import { VIDEO_STUDIO_AGENT_ID } from './tool-catalog';
import {
  browserAutomationHitWaf,
  browserRuntimeInstallRequiresExplicitRequest,
} from './browser-automation-guard';

const log = createLogger('local-tools');

export interface LocalToolsOpts {
  /** Host shell platform override for deterministic wrapper integration tests.
   *  Production callers omit this and use `process.platform`. */
  hostPlatform?: NodeJS.Platform;
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
  /** Extra roots that read tools may expose but local execution must never
   *  mutate. This is a deny-only lane: it does not make paths readable or
   *  writable for localTools, and it overrides all-files access modes. */
  readOnlyExtraRoots?: readonly string[];
  /** Fires with absolute path after every successful write (write_file,
   * edit_file, markdown_to_pdf, html_to_pdf). Lets chats.ts surface
   * produced files to the UI. */
  onFileWritten?: (absPath: string) => void | Promise<void>;
  /** Validates and records the complete list declared through
   * `publish_outputs`; returns only paths accepted by the active turn. */
  onOutputsPublished?: (absPaths: string[]) => string[] | Promise<string[]>;
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

function permissionWaitProgress(ctx: ToolContext | undefined, operation: string): (elapsedMs: number) => void {
  return (elapsedMs: number) => {
    ctx?.emitProgress?.({
      phase: 'permission',
      message: `Waiting for user approval for ${operation}`,
      data: {
        heartbeat: true,
        userAction: true,
        elapsedMs,
        timeoutMs: elapsedMs + 60_000,
      },
    });
  };
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
  '.orkas-output-manifest',
]);
const BASH_OUTPUT_MANIFEST_NAME = '.orkas-output-manifest';
const BASH_OUTPUT_MANIFEST_MAX_BYTES = 256 * 1024;
const BASH_OUTPUT_MANIFEST_MAX_FILES = 500;

type BashFileSnapshotEntry = { mtimeMs: number; size: number };
type BashFileSnapshot = Map<string, BashFileSnapshotEntry>;

function shouldSkipBashProducedDir(name: string): boolean {
  return BASH_PRODUCED_SKIP_DIRS.has(name);
}

function shouldSkipBashProducedFile(name: string): boolean {
  return BASH_PRODUCED_SKIP_FILES.has(name);
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

function _bashShellWords(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      push();
      out.push(';');
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === '&' || ch === '|' || ch === ';') {
      push();
      if ((ch === '&' || ch === '|') && command[i + 1] === ch) {
        out.push(ch + ch);
        i += 1;
      } else {
        out.push(ch);
      }
      continue;
    }
    cur += ch;
  }
  push();
  return out;
}

function _isShellBoundaryToken(token: string): boolean {
  return token === '&&' || token === '||' || token === ';' || token === '|';
}

function _cloneOptionConsumesValue(token: string): boolean {
  return [
    '-b', '--branch',
    '-c', '--config',
    '-j', '--jobs',
    '-o', '--origin',
    '--depth',
    '--reference',
    '--reference-if-able',
    '--separate-git-dir',
    '--shallow-exclude',
    '--shallow-since',
    '--template',
  ].includes(token);
}

function _cloneOperands(tokens: string[], start: number): string[] {
  const operands: string[] = [];
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];
    if (_isShellBoundaryToken(token) || token === '--') break;
    if (token.startsWith('-')) {
      if (!token.includes('=') && _cloneOptionConsumesValue(token)) i += 1;
      continue;
    }
    operands.push(token);
    if (operands.length >= 2) break;
  }
  return operands;
}

function _repoDefaultDir(repo: string): string {
  const raw = String(repo || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const tail = raw.split(/[/:]/).filter(Boolean).pop() || '';
  return tail.replace(/\.git$/i, '') || 'repo';
}

function _sameOrInside(parent: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function _uniqueResolvedRoots(input: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const root of input) {
    if (!root) continue;
    const abs = path.resolve(root);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function protectedWriteRootsFor(opts: LocalToolsOpts): string[] {
  const roots: string[] = [];
  if (opts.userId) {
    roots.push(
      userMarketplaceAgentsDir(opts.userId),
      userMarketplaceSkillsDir(opts.userId),
      userSystemSkillsDir(opts.userId),
    );
  }
  if (opts.readOnlyExtraRoots?.length) roots.push(...opts.readOnlyExtraRoots);
  return _uniqueResolvedRoots(roots);
}

function protectedRootForPath(opts: LocalToolsOpts, abs: string): string | null {
  const candidate = path.resolve(abs);
  for (const root of protectedWriteRootsFor(opts)) {
    if (_sameOrInside(root, candidate)) return root;
  }
  return null;
}

function protectedRootMentionedByCommand(opts: LocalToolsOpts, command: string): string | null {
  if (!command) return null;
  const normalized = command.replace(/\\([\\ "'$`])/g, '$1').replace(/\\/g, '/');
  for (const root of protectedWriteRootsFor(opts)) {
    const resolved = path.resolve(root).replace(/\\/g, '/');
    if (normalized.includes(resolved)) return root;
  }
  return null;
}

function protectedWriteError(abs: string, root: string): string {
  return errText(
    'E_PROTECTED_PATH_READ_ONLY',
    `path is inside a protected read-only Orkas resource root and cannot be modified by local tools: ${abs} (root: ${root}). Use the agent/skill edit or fork flow instead.`,
  );
}

function _addDownloadDir(out: string[], root: string, target: string): void {
  if (!target || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return;
  const abs = path.resolve(root, target);
  if (_sameOrInside(root, abs)) out.push(abs);
}

function _addDownloadFile(out: Set<string>, root: string, target: string): void {
  if (!target || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return;
  const abs = path.resolve(root, target);
  if (_sameOrInside(root, abs)) out.add(abs);
}

function _downloadNameFromUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const tail = u.pathname.split('/').filter(Boolean).pop() || '';
    return tail || 'index.html';
  } catch {
    const clean = String(raw || '').replace(/[?#].*$/, '').replace(/\/+$/, '');
    return clean.split('/').filter(Boolean).pop() || 'index.html';
  }
}

function _buildExternalDownloadSkipper(command: string, root: string): (absPath: string) => boolean {
  const tokens = _bashShellWords(command);
  const skipDirs: string[] = [];
  const skipFiles = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const c = tokens[i + 2];
    if (a === 'git' && b === 'clone') {
      const operands = _cloneOperands(tokens, i + 2);
      if (operands[0]) _addDownloadDir(skipDirs, root, operands[1] || _repoDefaultDir(operands[0]));
    } else if (a === 'gh' && b === 'repo' && c === 'clone') {
      const operands = _cloneOperands(tokens, i + 3);
      if (operands[0]) _addDownloadDir(skipDirs, root, operands[1] || _repoDefaultDir(operands[0]));
    } else if (a === 'curl') {
      let output = '';
      let remoteName = false;
      let url = '';
      for (let j = i + 1; j < tokens.length && !_isShellBoundaryToken(tokens[j]); j++) {
        const token = tokens[j];
        if (token === '-o' || token === '--output') output = tokens[++j] || '';
        else if (token.startsWith('--output=')) output = token.slice('--output='.length);
        else if (token === '-O' || token === '--remote-name') remoteName = true;
        else if (/^https?:\/\//i.test(token)) url = token;
      }
      if (output) _addDownloadFile(skipFiles, root, output);
      else if (remoteName && url) _addDownloadFile(skipFiles, root, _downloadNameFromUrl(url));
    } else if (a === 'wget') {
      let output = '';
      let url = '';
      for (let j = i + 1; j < tokens.length && !_isShellBoundaryToken(tokens[j]); j++) {
        const token = tokens[j];
        if (token === '-O' || token === '--output-document') output = tokens[++j] || '';
        else if (token.startsWith('--output-document=')) output = token.slice('--output-document='.length);
        else if (/^https?:\/\//i.test(token)) url = token;
      }
      if (output) _addDownloadFile(skipFiles, root, output);
      else if (url) _addDownloadFile(skipFiles, root, _downloadNameFromUrl(url));
    }
  }

  return (absPath: string) => {
    const abs = path.resolve(absPath);
    if (skipFiles.has(abs)) return true;
    return skipDirs.some((dir) => _sameOrInside(dir, abs));
  };
}

async function emitBashProducedFiles(
  opts: LocalToolsOpts,
  before: BashFileSnapshot,
  root: string,
  command: string,
  manifestedPaths: readonly string[] = [],
): Promise<void> {
  if (!opts.onFileWritten) return;
  const after = collectBashFileSnapshot(root);
  const isExternalDownload = _buildExternalDownloadSkipper(command, root);
  const discovered = new Set<string>(manifestedPaths);
  for (const [abs, next] of after) {
    const prev = before.get(abs);
    if (prev && prev.mtimeMs === next.mtimeMs && prev.size === next.size) continue;
    if (isExternalDownload(abs)) continue;
    discovered.add(abs);
  }
  for (const abs of discovered) {
    try { await opts.onFileWritten(abs); }
    catch (err) { log.warn('onFileWritten callback failed', { path: logPathRef(abs), error: logErrorRef(err) }); }
  }
}

function readBashOutputManifest(manifestPath: string, root: string): string[] {
  let st: fs.Stats;
  try { st = fs.statSync(manifestPath); }
  catch { return []; }
  if (!st.isFile() || st.size <= 0 || st.size > BASH_OUTPUT_MANIFEST_MAX_BYTES) return [];

  let body = '';
  try { body = fs.readFileSync(manifestPath, 'utf8'); }
  catch { return []; }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of body.split(/\r?\n/)) {
    if (out.length >= BASH_OUTPUT_MANIFEST_MAX_FILES) break;
    let declared = rawLine.trim();
    if (!declared) continue;
    if (declared.startsWith('"')) {
      try {
        const parsed = JSON.parse(declared);
        if (typeof parsed === 'string') declared = parsed;
      } catch { continue; }
    }
    const abs = path.isAbsolute(declared) ? path.normalize(declared) : path.resolve(root, declared);
    if (!_sameOrInside(root, abs) || seen.has(abs)) continue;
    try {
      const fileStat = fs.lstatSync(abs);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) continue;
    } catch { continue; }
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function withBashOutputEnv(ctx: ToolContext, outputDir: string, manifestPath: string): () => void {
  const original = ctx.state.sandboxEnv as Record<string, string> | undefined;
  ctx.state.sandboxEnv = {
    ...(original ?? {}),
    ORKAS_OUTPUT_DIR: outputDir,
    ORKAS_OUTPUT_MANIFEST: manifestPath,
  };
  return () => {
    if (original) ctx.state.sandboxEnv = original;
    else delete ctx.state.sandboxEnv;
  };
}

function withBashWritableRoots(ctx: ToolContext, roots: string[]): () => void {
  const original = ctx.state.sandboxAllowedDirs;
  ctx.state.sandboxAllowedDirs = roots;
  return () => {
    if (original !== undefined) ctx.state.sandboxAllowedDirs = original;
    else delete ctx.state.sandboxAllowedDirs;
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

function hasUnquotedShellControlSyntax(input: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
        continue;
      }
      if (ch === '\\' && i + 1 < input.length) i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === ';' || ch === '|' || ch === '&' || ch === '<' || ch === '>') {
      return true;
    }
  }
  return false;
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

function shellEnvValue(env: Record<string, string>, name: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function replaceKnownShellEnvTokens(
  raw: string,
  env: Record<string, string>,
  onUnknown?: (token: string) => void,
): string {
  const replace = (token: string, name: string): string => {
    const value = shellEnvValue(env, name);
    if (value !== undefined) return value;
    onUnknown?.(token);
    return token;
  };
  return raw
    // PowerShell environment-variable forms must run before the generic
    // `$NAME` replacement, otherwise `$env:NAME` is misread as an unknown
    // variable named `env` and the path guard rejects a documented command.
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/gi, (token, name) => replace(token, name))
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (token, name) => replace(token, name))
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (token, name) => replace(token, name))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (token, name) => replace(token, name))
    // Explicit `cmd /c` commands use `%NAME%` even though PowerShell is the
    // default Windows host shell.
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (token, name) => replace(token, name));
}

function expandOrkasEnvToken(token: string, env: Record<string, string>): string {
  const known = {
    ORKAS_NODE: shellEnvValue(env, 'ORKAS_NODE') || '',
    ORKAS_PC_DIR: shellEnvValue(env, 'ORKAS_PC_DIR') || '',
  };
  return replaceKnownShellEnvTokens(token, known);
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
  // A PowerShell executable path needs the call operator (`&`). Standard
  // Orkas CLI invocations are executed directly by the host, so accept that
  // prefix and keep the same cross-platform fast/safe path.
  const command = (heredoc?.command ?? rawCommand).replace(/^\s*&\s+/, '');
  if (hasUnquotedShellControlSyntax(command)) return null;
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

/** Minimum interval between forwarded script progress events; the 60s
 *  heartbeat still carries the latest one in between. */
const SCRIPT_PROGRESS_FORWARD_MIN_MS = 5_000;

/**
 * Incremental scanner for the skill-script progress protocol: scripts (video
 * skills et al) write `{"type":"progress",...}` JSONL to stderr. feed() returns
 * the parsed payloads of any complete progress lines in the chunk; other
 * stderr content is ignored.
 */
export function createScriptProgressScanner(): { feed(chunk: string): Array<Record<string, unknown>> } {
  let buf = '';
  return {
    feed(chunk: string) {
      buf += chunk;
      const events: Array<Record<string, unknown>> = [];
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('{') || !line.includes('"progress"')) continue;
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed && parsed.type === 'progress') events.push(parsed);
        } catch { /* not a progress line */ }
      }
      // A stream that never emits a newline must not grow the buffer forever.
      if (buf.length > 64 * 1024) buf = buf.slice(-8 * 1024);
      return events;
    },
  };
}

/** One-line human summary of a script progress payload for the tool progress UI. */
export function formatScriptProgress(p: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === 'string' && v ? v : '');
  if (s(p.message)) return s(p.message);
  const parts = [s(p.source), s(p.op), s(p.phase), s(p.status)].filter((v, i, a) => v && a.indexOf(v) === i);
  const pct = typeof p.percent === 'number' && Number.isFinite(p.percent) ? ` ${Math.round(p.percent as number)}%` : '';
  const t = typeof p.out_time_sec === 'number' && Number.isFinite(p.out_time_sec) ? ` t=${Math.round(p.out_time_sec as number)}s` : '';
  const elapsed = typeof p.elapsed_sec === 'number' && Number.isFinite(p.elapsed_sec) ? ` (${Math.round(p.elapsed_sec as number)}s elapsed)` : '';
  return parts.length ? `${parts.join(' ')}${pct}${t}${elapsed}` : 'script progress';
}

async function executeDirectOrkasCli(
  invocation: OrkasCliInvocation,
  input: Record<string, unknown>,
  ctx: ToolContext,
  workingDir: string,
): Promise<ToolResult> {
  const timeoutMs = normalizeBashTimeoutMs(input.timeoutMs);
  const sandboxEnv = (ctx.state.sandboxEnv ?? {}) as Record<string, string>;
  const env = buildSandboxEnv(sandboxEnv);

  return await new Promise<ToolResult>((resolve) => {
    const spoolDir = typeof ctx.state.toolResultSpoolDir === 'string'
      ? ctx.state.toolResultSpoolDir
      : undefined;
    const stdoutCapture = spoolDir
      ? new ProcessOutputCapture({
        spoolDir,
        prefix: 'orkas-cli-stdout',
        memoryBytes: ORKAS_DIRECT_OUTPUT_LIMIT,
      })
      : null;
    const stderrCapture = spoolDir
      ? new ProcessOutputCapture({
        spoolDir,
        prefix: 'orkas-cli-stderr',
        memoryBytes: ORKAS_DIRECT_OUTPUT_LIMIT,
      })
      : null;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let truncatedKind: 'stdout' | 'stderr' | null = null;
    let settled = false;
    let killed = false;
    const startedAt = Date.now();
    let heartbeat: NodeJS.Timeout | null = null;
    let settleTimer: NodeJS.Timeout | null = null;
    let abortListener: (() => void) | null = null;

    const child = spawn(invocation.nodePath, [invocation.scriptPath, ...invocation.args], {
      cwd: workingDir,
      env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (heartbeat) clearInterval(heartbeat);
      if (settleTimer) clearTimeout(settleTimer);
      if (ctx.signal && abortListener) ctx.signal.removeEventListener('abort', abortListener);
      resolve(result);
    };

    const finishFromChunks = (code: number | null) => {
      if (settled) return;
      let stdout: string;
      let stderr: string;
      let capturedStdout: CapturedProcessOutput | null = null;
      let capturedStderr: CapturedProcessOutput | null = null;
      if (stdoutCapture && stderrCapture) {
        const decode = (bytes: Buffer) => decodeProcessOutput(bytes, process.platform, env);
        capturedStdout = stdoutCapture.finish({
          decode,
          normalizeSpoolToUtf8: process.platform === 'win32',
        });
        capturedStderr = stderrCapture.finish({
          decode,
          normalizeSpoolToUtf8: process.platform === 'win32',
        });
        stdout = capturedStdout.text;
        stderr = capturedStderr.text;
      } else {
        stdout = decodeProcessOutput(Buffer.concat(stdoutChunks), process.platform, env);
        stderr = decodeProcessOutput(Buffer.concat(stderrChunks), process.platform, env);
        if (outputLimitExceeded) {
          if (truncatedKind === 'stdout') stdout += '\n... [output truncated by sandbox]';
          else stderr += '\n... [output truncated by sandbox]';
        }
      }
      const discardCaptured = () => {
        discardStreamedToolOutput(capturedStdout?.streamedOutput);
        discardStreamedToolOutput(capturedStderr?.streamedOutput);
      };
      if (timedOut) {
        discardCaptured();
        finish({ content: bashMsg('timeout', { ms: timeoutMs }), isError: true });
        return;
      }
      if (outputLimitExceeded) {
        const useStderr = truncatedKind === 'stderr';
        const selected = useStderr ? capturedStderr : capturedStdout;
        discardStreamedToolOutput(useStderr
          ? capturedStdout?.streamedOutput
          : capturedStderr?.streamedOutput);
        finish({
          content: useStderr ? stderr : stdout,
          ...(selected?.streamedOutput ? { streamedOutput: selected.streamedOutput } : {}),
          isError: true,
        });
        return;
      }
      if (code !== 0) {
        const useStderr = (capturedStderr?.bytes ?? Buffer.byteLength(stderr)) > 0;
        const selected = useStderr ? capturedStderr : capturedStdout;
        discardStreamedToolOutput(useStderr
          ? capturedStdout?.streamedOutput
          : capturedStderr?.streamedOutput);
        finish({
          content: (useStderr ? stderr : stdout) || bashMsg('exit_code', { code: code ?? 'null' }),
          ...(selected?.streamedOutput ? { streamedOutput: selected.streamedOutput } : {}),
          isError: true,
        });
        return;
      }
      discardStreamedToolOutput(capturedStderr?.streamedOutput);
      finish({
        content: stdout,
        ...(capturedStdout?.streamedOutput
          ? { streamedOutput: capturedStdout.streamedOutput }
          : {}),
      });
    };

    const killChild = () => {
      if (killed) return;
      killed = true;
      killProcessTree(child, 'SIGTERM');
      const killTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 5000);
      if (typeof killTimer.unref === 'function') killTimer.unref();
      settleTimer = setTimeout(() => finishFromChunks(null), 6000);
      if (typeof settleTimer.unref === 'function') settleTimer.unref();
    };

    const append = (kind: 'stdout' | 'stderr', data: Buffer) => {
      if (outputLimitExceeded) return;
      const capture = kind === 'stdout' ? stdoutCapture : stderrCapture;
      if (capture) {
        if (!capture.append(data)) {
          outputLimitExceeded = true;
          truncatedKind = kind;
          killChild();
        }
        return;
      }
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
    const progressScanner = createScriptProgressScanner();
    let lastScriptProgress: Record<string, unknown> | null = null;
    let lastProgressForwardAt = 0;
    child.stderr.on('data', (data: Buffer) => {
      append('stderr', data);
      if (!ctx.emitProgress) return;
      for (const ev of progressScanner.feed(data.toString('utf8'))) {
        lastScriptProgress = ev;
        const now = Date.now();
        if (now - lastProgressForwardAt < SCRIPT_PROGRESS_FORWARD_MIN_MS) continue;
        lastProgressForwardAt = now;
        ctx.emitProgress({
          phase: 'running',
          message: formatScriptProgress(ev),
          data: { script_progress: ev },
        });
      }
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      killChild();
    }, timeoutMs);
    if (typeof timeout.unref === 'function') timeout.unref();

    if (ctx.signal) {
      abortListener = () => killChild();
      if (ctx.signal.aborted) abortListener();
      else ctx.signal.addEventListener('abort', abortListener, { once: true });
    }

    if (ctx.emitProgress) {
      heartbeat = setInterval(() => {
        const elapsedMs = Date.now() - startedAt;
        const scriptNote = lastScriptProgress ? `; last: ${formatScriptProgress(lastScriptProgress)}` : '';
        ctx.emitProgress?.({
          phase: 'running',
          message: `Command still running (${formatBashDuration(elapsedMs)} elapsed; timeout ${formatBashDuration(timeoutMs)})${scriptNote}`,
          data: {
            elapsedMs,
            timeoutMs,
            heartbeat: true,
            ...(lastScriptProgress ? { script_progress: lastScriptProgress } : {}),
          },
        });
      }, BASH_PROGRESS_INTERVAL_MS);
      if (typeof heartbeat.unref === 'function') heartbeat.unref();
    }

    child.on('error', (err) => {
      stdoutCapture?.discard();
      stderrCapture?.discard();
      finish({ content: bashMsg('start_failed', { command: invocation.script, error: err.message }), isError: true });
    });
    child.on('close', (code) => {
      finishFromChunks(code);
    });

    child.stdin.end(invocation.stdin ?? '');
  });
}

function formatBashDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return `${ms}ms`;
  if (ms >= 60_000) return `${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms >= 1_000) return `${Math.max(1, Math.round(ms / 1_000))}s`;
  return `${Math.round(ms)}ms`;
}

async function executeCoreBashWithOutputTracking(
  opts: LocalToolsOpts,
  input: Record<string, unknown>,
  ctx: ToolContext,
  workingDir: string,
): Promise<ToolResult> {
  const outputDir = workingDir;
  const command = String(input.command ?? '');
  const manifestPath = path.join(outputDir, BASH_OUTPUT_MANIFEST_NAME);
  try { fs.rmSync(manifestPath, { force: true }); } catch { /* best-effort stale cleanup */ }
  const before = opts.onFileWritten ? collectBashFileSnapshot(outputDir) : new Map<string, BashFileSnapshotEntry>();
  const restoreEnv = withBashOutputEnv(ctx, outputDir, manifestPath);
  const restoreWritableRoots = withBashWritableRoots(ctx, bashWritableRootsFor(opts, workingDir));
  try {
    const direct = parseOrkasCliInvocation(input, ctx);
    const macWriteSandboxActive = process.platform === 'darwin'
      && fs.existsSync('/usr/bin/sandbox-exec')
      && Array.isArray(ctx.state.sandboxAllowedDirs)
      && ctx.state.sandboxAllowedDirs.length > 0;
    const result = direct && !macWriteSandboxActive
      ? await executeDirectOrkasCli(direct, input, ctx, workingDir)
      : await coreBashTool.execute(input, ctx);
    if (!result.isError) {
      const manifestedPaths = readBashOutputManifest(manifestPath, outputDir);
      await emitBashProducedFiles(opts, before, outputDir, command, manifestedPaths);
    }
    return translateFixedBashError(result);
  } finally {
    try { fs.rmSync(manifestPath, { force: true }); } catch { /* best-effort */ }
    restoreWritableRoots();
    restoreEnv();
  }
}

/** Assemble the workspace-scoped writable roots for the current (uid, cid).
 *  The global access mode may allow paths outside these roots, but these
 *  roots remain the default safe scope and the macOS write sandbox scope for
 *  `workspace_approval`. */
function allowedRootsFor(opts: LocalToolsOpts): string[] {
  const roots: string[] = [];
  if (opts.userId) {
    try {
      const ws = getWorkspacePath(opts.userId, opts.projectId);
      if (ws) roots.push(ws);
    } catch (err) { log.warn('edit_file resolve workspace failed', { user_id: maskId(opts.userId), project_id: maskId(opts.projectId), error: logErrorRef(err) }); }
    if (opts.cid) {
      try { roots.push(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
      catch (err) { log.warn('edit_file resolve attachment dir failed', { user_id: maskId(opts.userId), cid: maskId(opts.cid), error: logErrorRef(err) }); }
    }
  }
  if (opts.extraRoots?.length) {
    for (const r of opts.extraRoots) if (r) roots.push(r);
  }
  return roots;
}

function guardEditPath(opts: LocalToolsOpts, abs: string): string | null {
  const protectedRoot = protectedRootForPath(opts, abs);
  if (protectedRoot) return protectedWriteError(abs, protectedRoot);
  const roots = allowedRootsFor(opts);
  if (!roots.length && !localAccessAllowsOutsideWorkspace()) {
    return errText('E_NO_SCOPE', 'no visible roots for this conversation');
  }
  if (roots.length && isPathAllowed(abs, roots)) return null;
  if (!localAccessAllowsOutsideWorkspace()) {
    return errText(
      'E_PATH_OUT_OF_SCOPE',
      `path is outside the current workspace/attachment scope and the current access mode only allows workspace files: ${abs}`,
    );
  }
  return null;
}

async function gateSensitiveLocalPath(
  opts: LocalToolsOpts,
  abs: string,
  operation: string,
  access: 'read' | 'write',
  ctx?: ToolContext,
): Promise<string | null> {
  const result = await gateSensitiveLocalPathDetailed(opts, abs, operation, access, ctx);
  return result.error;
}

async function gateSensitiveLocalPathDetailed(
  opts: LocalToolsOpts,
  abs: string,
  operation: string,
  access: 'read' | 'write',
  ctx?: ToolContext,
): Promise<BashPathGateResult> {
  if (!localAccessRequiresSensitiveApproval()) return { error: null, approvedReasons: [] };
  const reasons = sensitivePathReasons(abs, access);
  if (!reasons.length) return { error: null, approvedReasons: [] };
  const decision = await requestBashDecision({
    uid: opts.userId ?? '',
    cid: opts.cid ?? '',
    agentId: opts.agentId ?? '',
    agentName: opts.agentName ?? opts.agentId ?? '',
    command: '',
    operation,
    subject: abs,
    reasons,
    onWaiting: permissionWaitProgress(ctx, operation),
  });
  if (decision !== 'deny') return { error: null, approvedReasons: reasons };
  return {
    error: errText(
      'E_SENSITIVE_PATH_DENIED',
      `the user declined to allow ${operation} on a sensitive path: ${abs}. Do not retry or work around it.`,
    ),
    approvedReasons: [],
  };
}

/** Write-side access gate. Folder grants were removed: paths outside the
 * workspace are controlled only by the global three-mode access setting. */
async function gateEditPath(opts: LocalToolsOpts, abs: string, ctx?: ToolContext): Promise<string | null> {
  const denied = guardEditPath(opts, abs);
  if (denied) return denied;
  return gateSensitiveLocalPath(opts, abs, 'write_file', 'write', ctx);
}

function guardDeletePath(opts: LocalToolsOpts, abs: string): string | null {
  const protectedRoot = protectedRootForPath(opts, abs);
  if (protectedRoot) return protectedWriteError(abs, protectedRoot);
  const roots = allowedRootsFor(opts);
  if (!roots.length && !localAccessAllowsOutsideWorkspace()) {
    return errText('E_NO_SCOPE', 'no visible roots for this conversation');
  }
  if (roots.length && isPathAllowed(abs, roots)) return null;
  if (!localAccessAllowsOutsideWorkspace()) {
    return errText(
      'E_PATH_OUT_OF_SCOPE',
      `path is outside the current workspace/attachment scope and the current access mode only allows workspace files: ${abs}`,
    );
  }
  return null;
}

function isInWritableWorkspaceScope(opts: LocalToolsOpts, abs: string): boolean {
  const roots = allowedRootsFor(opts);
  return roots.length > 0 && isPathAllowed(abs, roots);
}

function deleteRequiresUserConfirmation(opts: LocalToolsOpts, abs: string): boolean {
  return !isInWritableWorkspaceScope(opts, abs) && localAccessRequiresSensitiveApproval();
}

type BashPathToken = { type: 'word' | 'op'; value: string };
type BashPathCandidate = { raw: string; abs?: string; reason: string; dynamic?: boolean };
type BashPathGateResult = { error: string | null; approvedReasons: LocalAccessRiskCategory[] };
type BashFilesystemGuardResult = { result: ToolResult | null; approvedReasons: LocalAccessRiskCategory[] };

const BASH_PATH_SEGMENT_OPS = new Set([';', '&&', '||', '|', '|&', '&']);
const BASH_OUTPUT_REDIR_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '1>', '1>>', '2>', '2>>']);
const BASH_FILE_INPUT_REDIR_OPS = new Set(['<']);
const BASH_NON_FILE_INPUT_REDIR_OPS = new Set(['<<', '<<<']);
const BASH_GUARD_WRAPPERS = new Set(['env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'ionice', 'stdbuf', 'setsid']);
const BASH_GUARD_PRIV_ESC = new Set(['sudo', 'doas', 'pkexec']);
const BASH_MUTATE_ALL_OPERANDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'mkdir', 'touch', 'chmod', 'chown', 'chgrp', 'mv', 'ln']);
const BASH_DEST_LAST_OPERAND = new Set(['cp', 'install', 'rsync']);
const BASH_READ_ALL_OPERANDS = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'ls', 'find',
  'sort', 'uniq', 'cut', 'strings', 'realpath', 'readlink', 'open',
  'get-content', 'get-childitem', 'get-item', 'test-path', 'resolve-path',
]);
const BASH_READ_PATTERN_FIRST_CMDS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const BASH_READ_SCRIPT_CMDS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish',
  'python', 'python3', 'node', 'ruby', 'perl', 'php',
]);
const BASH_PROTECTED_READ_ONLY_CMDS = new Set([
  'cat', 'head', 'tail', 'wc', 'stat', 'file', 'du', 'ls',
  'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find',
  'echo', 'printf', 'pwd', 'dirname', 'basename', 'true', 'false', 'test', '[',
  'get-content', 'get-childitem', 'get-item', 'test-path', 'resolve-path', 'write-output',
]);
const BASH_FIND_MUTATING_ACTIONS = new Set([
  '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls', '-fprint', '-fprint0', '-fprintf',
]);
const BASH_ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
const BASH_GENERIC_FLAGS_WITH_VALUE = new Set([
  '-C', '-D', '-F', '-G', '-I', '-J', '-M', '-O', '-S', '-T', '-b', '-c', '-d', '-e', '-f', '-g', '-m', '-o', '-p', '-r', '-s', '-t', '-u',
  '--backup', '--context', '--group', '--mode', '--owner', '--reference', '--suffix', '--target-directory',
]);
const BASH_GREP_FLAGS_WITH_VALUE = new Set([...BASH_GENERIC_FLAGS_WITH_VALUE, '-e', '-f', '-m', '-A', '-B', '-C', '--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context', '--glob', '-g', '--type', '-t']);
const BASH_AWK_FLAGS_WITH_VALUE = new Set([...BASH_GENERIC_FLAGS_WITH_VALUE, '-f', '-v', '-F']);

function tokenizeBashPathGuard(input: string): BashPathToken[] {
  const toks: BashPathToken[] = [];
  let cur = '';
  let hasCur = false;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const push = () => {
    if (!hasCur) return;
    toks.push({ type: 'word', value: cur });
    cur = '';
    hasCur = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (escaped) {
      cur += ch;
      hasCur = true;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      const next = input[i + 1] || '';
      const escapable = quote === "'"
        ? false
        : quote === '"'
          ? ['"', '\\', '$', '`'].includes(next)
          : /[\s'"\\;&|<>$`]/.test(next);
      if (escapable) escaped = true;
      else { cur += ch; hasCur = true; }
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else { cur += ch; hasCur = true; }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasCur = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      if (ch === '\n' || ch === '\r') toks.push({ type: 'op', value: ';' });
      continue;
    }

    const three = input.slice(i, i + 3);
    if (three === '&>>' || three === '<<<' || /^\d>>$/.test(three)) {
      push(); toks.push({ type: 'op', value: three }); i += 2; continue;
    }
    const two = input.slice(i, i + 2);
    if (['&&', '||', '|&', '>>', '>|', '&>', '<<'].includes(two) || /^\d>$/.test(two)) {
      push(); toks.push({ type: 'op', value: two }); i += 1; continue;
    }
    if (ch === '|' || ch === '&' || ch === ';' || ch === '>' || ch === '<') {
      push(); toks.push({ type: 'op', value: ch }); continue;
    }
    cur += ch;
    hasCur = true;
  }
  push();
  return toks;
}

function bashPathSegments(command: string): Array<{ words: string[]; redirectTargets: string[]; inputTargets: string[] }> {
  const out: Array<{ words: string[]; redirectTargets: string[]; inputTargets: string[] }> = [];
  let words: string[] = [];
  let redirectTargets: string[] = [];
  let inputTargets: string[] = [];
  let expect: 'out' | 'in' | 'skip' | null = null;
  const push = () => {
    if (words.length || redirectTargets.length || inputTargets.length) out.push({ words, redirectTargets, inputTargets });
    words = [];
    redirectTargets = [];
    inputTargets = [];
  };

  for (const tok of tokenizeBashPathGuard(command)) {
    if (tok.type === 'op') {
      if (BASH_PATH_SEGMENT_OPS.has(tok.value)) {
        push();
        expect = null;
      } else if (BASH_OUTPUT_REDIR_OPS.has(tok.value)) {
        expect = 'out';
      } else if (BASH_FILE_INPUT_REDIR_OPS.has(tok.value)) {
        expect = 'in';
      } else if (BASH_NON_FILE_INPUT_REDIR_OPS.has(tok.value)) {
        expect = 'skip';
      } else {
        expect = null;
      }
      continue;
    }
    if (expect === 'out') {
      redirectTargets.push(tok.value);
      expect = null;
      continue;
    }
    if (expect === 'in') {
      inputTargets.push(tok.value);
      expect = null;
      continue;
    }
    if (expect === 'skip') {
      expect = null;
      continue;
    }
    words.push(tok.value);
  }
  push();
  return out;
}

function bashEffectiveCommand(words: string[]): { cmd: string; args: string[] } | null {
  let w = words.slice();
  while (w.length && BASH_ENV_ASSIGN_RE.test(w[0])) w = w.slice(1);
  if (!w.length) return null;
  let cmd = path.basename(w[0]).toLowerCase();

  if (cmd === 'env') {
    w = w.slice(1);
    while (w.length && (BASH_ENV_ASSIGN_RE.test(w[0]) || w[0].startsWith('-'))) w = w.slice(1);
    if (!w.length) return null;
    cmd = path.basename(w[0]).toLowerCase();
  }
  while (BASH_GUARD_WRAPPERS.has(cmd)) {
    w = w.slice(1);
    while (w.length && BASH_ENV_ASSIGN_RE.test(w[0])) w = w.slice(1);
    if (!w.length) return null;
    cmd = path.basename(w[0]).toLowerCase();
  }
  if (BASH_GUARD_PRIV_ESC.has(cmd)) {
    w = w.slice(1);
    while (w.length && w[0].startsWith('-')) w = w.slice(1);
    if (!w.length) return null;
    cmd = path.basename(w[0]).toLowerCase();
  }
  return { cmd, args: w.slice(1) };
}

/**
 * The protected-root mention guard is intentionally conservative because an
 * interpreter can mutate a literal protected path without using a shell
 * redirection that the path guard can inspect. Let only a small, auditable
 * read-only command subset continue to the normal read/write path checks.
 */
function bashProtectedRootMentionIsProvablyReadOnly(command: string): boolean {
  if (!command.trim() || /\$\(|`|[<>]\(/.test(command)) return false;
  const segments = bashPathSegments(command);
  if (!segments.length) return false;
  for (const segment of segments) {
    const effective = bashEffectiveCommand(segment.words);
    if (!effective || !BASH_PROTECTED_READ_ONLY_CMDS.has(effective.cmd)) return false;
    if (effective.cmd === 'find' && effective.args.some((arg) => BASH_FIND_MUTATING_ACTIONS.has(arg))) {
      return false;
    }
    if ((effective.cmd === 'rg' || effective.cmd === 'ag' || effective.cmd === 'ack')
      && effective.args.some((arg) => arg === '--pre' || arg.startsWith('--pre='))) {
      return false;
    }
  }
  return true;
}

function bashNonFlagOperands(args: string[], flagsWithValue: Set<string> = BASH_GENERIC_FLAGS_WITH_VALUE): string[] {
  const out: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!endOfOptions && a === '--') { endOfOptions = true; continue; }
    if (!endOfOptions && a.startsWith('--target-directory=')) {
      out.push(a.slice('--target-directory='.length));
      continue;
    }
    if (!endOfOptions && a.startsWith('-')) {
      if (!a.includes('=') && flagsWithValue.has(a)) i += 1;
      continue;
    }
    out.push(a);
  }
  return out;
}

function bashEnvForPathResolution(ctx: ToolContext, workingDir: string): Record<string, string> {
  return {
    ...(ctx.state.sandboxEnv as Record<string, string> | undefined),
    ORKAS_OUTPUT_DIR: workingDir,
    PWD: workingDir,
    HOME: process.env.HOME || process.env.USERPROFILE || '',
  };
}

export function expandKnownShellPathVars(raw: string, env: Record<string, string>): { value: string; dynamic: boolean } {
  let dynamic = false;
  const value = path.normalize(replaceKnownShellEnvTokens(raw, env, () => { dynamic = true; }));
  return {
    value,
    dynamic: dynamic || value.includes('$') || value.includes('`') || /%[A-Za-z_][A-Za-z0-9_]*%/.test(value),
  };
}

function resolveBashCandidate(raw: string, workingDir: string, env: Record<string, string>): { abs?: string; dynamic?: boolean } | null {
  const trimmed = String(raw || '').trim();
  if (!trimmed || trimmed === '-' || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return null;
  const expanded = expandKnownShellPathVars(trimmed, env);
  if (expanded.dynamic) return { dynamic: true };
  let value = expanded.value;
  if (value === '~' || value.startsWith('~/')) {
    const home = env.HOME || process.env.HOME || process.env.USERPROFILE || '';
    if (!home) return { dynamic: true };
    value = path.join(home, value.slice(2));
  }
  const globAt = value.search(/[*?\[\]{}]/);
  if (globAt >= 0) {
    const prefix = value.slice(0, globAt);
    value = prefix.endsWith(path.sep) ? prefix.slice(0, -1) : path.dirname(prefix || '.');
  }
  return { abs: path.resolve(workingDir, value) };
}

function addBashCandidate(
  out: BashPathCandidate[],
  raw: string,
  reason: string,
  workingDir: string,
  env: Record<string, string>,
): void {
  const resolved = resolveBashCandidate(raw, workingDir, env);
  if (!resolved) return;
  out.push({ raw, reason, ...(resolved.abs ? { abs: resolved.abs } : {}), ...(resolved.dynamic ? { dynamic: true } : {}) });
}

function addBashCurlTargets(out: BashPathCandidate[], args: string[], workingDir: string, env: Record<string, string>): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-o' || a === '--output') && args[i + 1]) addBashCandidate(out, args[++i], 'download output', workingDir, env);
    else if (a.startsWith('--output=')) addBashCandidate(out, a.slice('--output='.length), 'download output', workingDir, env);
  }
}

function addBashWgetTargets(out: BashPathCandidate[], args: string[], workingDir: string, env: Record<string, string>): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === '-O' || a === '--output-document') && args[i + 1]) addBashCandidate(out, args[++i], 'download output', workingDir, env);
    else if (a.startsWith('--output-document=')) addBashCandidate(out, a.slice('--output-document='.length), 'download output', workingDir, env);
  }
}

function gitCloneDestination(args: string[], gh = false): string | null {
  const start = gh ? 2 : 1;
  const operands = _cloneOperands(gh ? ['gh', 'repo', 'clone', ...args.slice(2)] : ['git', 'clone', ...args.slice(1)], gh ? 3 : 2);
  if (!operands[0]) return null;
  return operands[1] || _repoDefaultDir(operands[0] || args[start] || 'repo');
}

function tarFileOperand(args: string[]): string | null {
  const fIdx = args.findIndex((a) => a === '-f' || a === '--file');
  if (fIdx >= 0 && args[fIdx + 1]) return args[fIdx + 1];
  const eq = args.find((a) => a.startsWith('--file='));
  if (eq) return eq.slice('--file='.length);
  const clustered = args.find((a) => /^-[A-Za-z]*f[A-Za-z]*$/.test(a));
  if (clustered) {
    const idx = args.indexOf(clustered);
    if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  }
  return null;
}

function bashScriptOperand(cmd: string, args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') return args[i + 1] || null;
    if (a === '-') return null;
    if (cmd === 'node' && (a === '-e' || a === '--eval' || a === '-p' || a === '--print')) {
      i += 1;
      continue;
    }
    if ((cmd === 'python' || cmd === 'python3') && (a === '-c' || a === '-m')) {
      i += 1;
      continue;
    }
    if ((cmd === 'perl' || cmd === 'ruby' || cmd === 'php') && (a === '-e' || a === '-E')) {
      i += 1;
      continue;
    }
    if (a === '-c') {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    return a;
  }
  return null;
}

function grepReadOperands(args: string[]): string[] {
  const operands = bashNonFlagOperands(args, BASH_GREP_FLAGS_WITH_VALUE);
  if (!operands.length) return [];
  const hasPatternFlag = args.some((a) => a === '-e' || a === '--regexp' || a.startsWith('--regexp='));
  return hasPatternFlag ? operands : operands.slice(1);
}

function sedReadOperands(args: string[]): string[] {
  if (args.some((a) => a === '-i' || a.startsWith('-i'))) return [];
  const operands = bashNonFlagOperands(args);
  if (!operands.length) return [];
  const hasScriptFlag = args.some((a) => a === '-e' || a === '-f' || a === '--expression' || a === '--file' || a.startsWith('--expression=') || a.startsWith('--file='));
  return hasScriptFlag ? operands : operands.slice(1);
}

function awkReadOperands(args: string[]): string[] {
  const operands = bashNonFlagOperands(args, BASH_AWK_FLAGS_WITH_VALUE);
  if (!operands.length) return [];
  const hasScriptFile = args.some((a) => a === '-f' || a.startsWith('-f') || a === '--file' || a.startsWith('--file='));
  return hasScriptFile ? operands : operands.slice(1);
}

function collectBashMutationCandidates(command: string, workingDir: string, env: Record<string, string>): BashPathCandidate[] {
  const out: BashPathCandidate[] = [];
  for (const seg of bashPathSegments(command)) {
    for (const target of seg.redirectTargets) addBashCandidate(out, target, 'redirection', workingDir, env);
    const eff = bashEffectiveCommand(seg.words);
    if (!eff) continue;
    const { cmd, args } = eff;

    if (BASH_MUTATE_ALL_OPERANDS.has(cmd)) {
      for (const operand of bashNonFlagOperands(args)) addBashCandidate(out, operand, cmd, workingDir, env);
    } else if (BASH_DEST_LAST_OPERAND.has(cmd)) {
      const operands = bashNonFlagOperands(args);
      if (operands.length) addBashCandidate(out, operands[operands.length - 1], cmd, workingDir, env);
    } else if (cmd === 'tee') {
      for (const operand of bashNonFlagOperands(args, new Set(['-a', '-i', '-p', '--append', '--ignore-interrupts']))) {
        addBashCandidate(out, operand, 'tee output', workingDir, env);
      }
    } else if (cmd === 'dd') {
      for (const a of args) if (a.startsWith('of=')) addBashCandidate(out, a.slice(3), 'dd output', workingDir, env);
    } else if (cmd === 'sed' && args.some((a) => a === '-i' || a.startsWith('-i'))) {
      for (const operand of bashNonFlagOperands(args).filter((a) => {
        const r = resolveBashCandidate(a, workingDir, env);
        return !!r?.abs && fs.existsSync(r.abs);
      })) addBashCandidate(out, operand, 'sed in-place edit', workingDir, env);
    } else if (cmd === 'perl' && args.some((a) => /^-.*i/.test(a))) {
      for (const operand of bashNonFlagOperands(args).filter((a) => {
        const r = resolveBashCandidate(a, workingDir, env);
        return !!r?.abs && fs.existsSync(r.abs);
      })) addBashCandidate(out, operand, 'perl in-place edit', workingDir, env);
    } else if (cmd === 'curl') {
      addBashCurlTargets(out, args, workingDir, env);
    } else if (cmd === 'wget') {
      addBashWgetTargets(out, args, workingDir, env);
    } else if (cmd === 'git' && args[0] === 'clone') {
      const dest = gitCloneDestination(args);
      if (dest) addBashCandidate(out, dest, 'git clone destination', workingDir, env);
    } else if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      const dest = gitCloneDestination(args, true);
      if (dest) addBashCandidate(out, dest, 'gh repo clone destination', workingDir, env);
    } else if (cmd === 'tar' && args.some((a) => /^-.*x/.test(a) || a === '--extract')) {
      const cIdx = args.findIndex((a) => a === '-C' || a === '--directory');
      const eq = args.find((a) => a.startsWith('--directory='));
      if (cIdx >= 0 && args[cIdx + 1]) addBashCandidate(out, args[cIdx + 1], 'tar extract directory', workingDir, env);
      else if (eq) addBashCandidate(out, eq.slice('--directory='.length), 'tar extract directory', workingDir, env);
    } else if (cmd === 'unzip') {
      const dIdx = args.findIndex((a) => a === '-d');
      if (dIdx >= 0 && args[dIdx + 1]) addBashCandidate(out, args[dIdx + 1], 'unzip output directory', workingDir, env);
    }
  }
  return out;
}

function collectBashReadCandidates(command: string, workingDir: string, env: Record<string, string>): BashPathCandidate[] {
  const out: BashPathCandidate[] = [];
  for (const seg of bashPathSegments(command)) {
    for (const target of seg.inputTargets) addBashCandidate(out, target, 'input redirection', workingDir, env);
    const eff = bashEffectiveCommand(seg.words);
    if (!eff) continue;
    const { cmd, args } = eff;

    if (BASH_READ_ALL_OPERANDS.has(cmd)) {
      for (const operand of bashNonFlagOperands(args)) addBashCandidate(out, operand, cmd, workingDir, env);
    } else if (BASH_READ_PATTERN_FIRST_CMDS.has(cmd)) {
      for (const operand of grepReadOperands(args)) addBashCandidate(out, operand, cmd, workingDir, env);
    } else if (cmd === 'sed') {
      for (const operand of sedReadOperands(args)) addBashCandidate(out, operand, 'sed read', workingDir, env);
    } else if (cmd === 'awk') {
      for (const operand of awkReadOperands(args)) addBashCandidate(out, operand, 'awk read', workingDir, env);
    } else if (cmd === 'cd' || cmd === 'pushd') {
      const operand = bashNonFlagOperands(args)[0];
      if (operand) addBashCandidate(out, operand, cmd, workingDir, env);
    } else if (BASH_DEST_LAST_OPERAND.has(cmd)) {
      const operands = bashNonFlagOperands(args);
      for (const operand of operands.slice(0, -1)) addBashCandidate(out, operand, `${cmd} source`, workingDir, env);
    } else if (BASH_READ_SCRIPT_CMDS.has(cmd)) {
      const operand = bashScriptOperand(cmd, args);
      if (operand) addBashCandidate(out, operand, `${cmd} script`, workingDir, env);
    } else if (cmd === 'tar') {
      const operand = tarFileOperand(args);
      if (operand) addBashCandidate(out, operand, 'tar archive', workingDir, env);
    } else if (cmd === 'unzip') {
      const operand = bashNonFlagOperands(args)[0];
      if (operand) addBashCandidate(out, operand, 'unzip archive', workingDir, env);
    }
  }
  return out;
}

function bashScopedRootsFor(opts: LocalToolsOpts, workingDir: string): string[] {
  if (localAccessAllowsOutsideWorkspace()) return [];
  const roots = allowedRootsFor(opts);
  if (!opts.userId && workingDir) roots.push(workingDir);
  return roots;
}

function bashWritableRootsFor(opts: LocalToolsOpts, workingDir: string): string[] {
  return bashScopedRootsFor(opts, workingDir);
}

function guardBashScopedPath(opts: LocalToolsOpts, abs: string, workingDir: string, access: 'read' | 'write'): string | null {
  if (access === 'write') {
    const protectedRoot = protectedRootForPath(opts, abs);
    if (protectedRoot) return protectedWriteError(abs, protectedRoot);
  }
  const roots = bashScopedRootsFor(opts, workingDir);
  if (!roots.length) {
    return localAccessAllowsOutsideWorkspace()
      ? null
      : errText('E_NO_SCOPE', `no ${access === 'read' ? 'readable' : 'writable'} roots for this bash command`);
  }
  if (isPathAllowed(abs, roots)) return null;
  if (!localAccessAllowsOutsideWorkspace()) {
    return errText(
      'E_PATH_OUT_OF_SCOPE',
      `bash target is outside the current workspace/attachment scope and the current access mode only allows workspace files: ${abs}`,
    );
  }
  return null;
}

function guardBashWritablePath(opts: LocalToolsOpts, abs: string, workingDir: string): string | null {
  return guardBashScopedPath(opts, abs, workingDir, 'write');
}

async function gateBashPathAccess(
  opts: LocalToolsOpts,
  abs: string,
  workingDir: string,
  access: 'read' | 'write',
  ctx?: ToolContext,
): Promise<BashPathGateResult> {
  const denied = guardBashScopedPath(opts, abs, workingDir, access);
  if (denied) return { error: denied, approvedReasons: [] };
  return gateSensitiveLocalPathDetailed(opts, abs, 'bash', access, ctx);
}

function mergeRiskReasons(target: LocalAccessRiskCategory[], source: readonly LocalAccessRiskCategory[]): void {
  for (const reason of source) if (!target.includes(reason)) target.push(reason);
}

async function guardBashPathCandidates(
  opts: LocalToolsOpts,
  ctx: ToolContext,
  workingDir: string,
  candidates: BashPathCandidate[],
  access: 'read' | 'write',
): Promise<BashFilesystemGuardResult> {
  const approvedReasons: LocalAccessRiskCategory[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = c.abs || `dynamic:${c.raw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (c.dynamic || !c.abs) {
      return {
        result: {
          content: errText(
            'E_BASH_DYNAMIC_PATH_UNSUPPORTED',
            `bash ${c.reason} target "${c.raw}" uses an unresolved variable, command substitution, or glob that Orkas cannot verify. `
            + (access === 'write'
              ? 'Use an explicit path inside the workspace, or use write_file/edit_file/delete_file for file changes.'
              : 'Use an explicit path inside the workspace, or ask the user to switch to an all-files access mode.'),
          ),
          isError: true,
        },
        approvedReasons,
      };
    }
    const gated = await gateBashPathAccess(opts, c.abs, workingDir, access, ctx);
    mergeRiskReasons(approvedReasons, gated.approvedReasons);
    if (gated.error) {
      log.warn(access === 'write' ? 'bash filesystem mutation scope reject' : 'bash filesystem read scope reject', {
        user_id: maskId(opts.userId),
        path: logPathRef(c.abs),
        reason: c.reason,
      });
      return {
        result: {
          content: errText(
            access === 'write' ? 'E_BASH_PATH_OUT_OF_SCOPE' : 'E_BASH_READ_PATH_OUT_OF_SCOPE',
            `bash ${c.reason} target is not ${access === 'write' ? 'writable' : 'readable'}: ${c.raw} -> ${c.abs}. ${gated.error}`,
          ),
          isError: true,
        },
        approvedReasons,
      };
    }
  }
  return { result: null, approvedReasons };
}

async function guardBashFilesystemTargets(
  opts: LocalToolsOpts,
  input: Record<string, unknown>,
  ctx: ToolContext,
  workingDir: string,
): Promise<BashFilesystemGuardResult> {
  const command = String(input.command ?? '');
  const env = bashEnvForPathResolution(ctx, workingDir);
  const approvedReasons: LocalAccessRiskCategory[] = [];
  const mutation = await guardBashPathCandidates(
    opts,
    ctx,
    workingDir,
    collectBashMutationCandidates(command, workingDir, env),
    'write',
  );
  mergeRiskReasons(approvedReasons, mutation.approvedReasons);
  if (mutation.result) return { result: mutation.result, approvedReasons };

  const read = await guardBashPathCandidates(
    opts,
    ctx,
    workingDir,
    collectBashReadCandidates(command, workingDir, env),
    'read',
  );
  mergeRiskReasons(approvedReasons, read.approvedReasons);
  if (read.result) return { result: read.result, approvedReasons };
  return { result: null, approvedReasons };
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

function editableFileHash(body: string): string {
  return `sha256:${crypto.createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function editRecoveryContext(body: string, needle: string, fileHash: string): string {
  const maxChars = 1_200;
  let matchAt = body.indexOf(needle);
  if (matchAt < 0) {
    const candidates = needle
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 8)
      .sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
      matchAt = body.indexOf(candidate.slice(0, 160));
      if (matchAt >= 0) break;
    }
  }
  let start = 0;
  let end = Math.min(body.length, maxChars);
  if (body.length > maxChars && matchAt >= 0) {
    start = Math.max(0, Math.min(body.length - maxChars, matchAt - Math.floor(maxChars / 3)));
    end = Math.min(body.length, start + maxChars);
  }
  const content = body.slice(start, end);
  const omittedTail = end < body.length ? `\n...[${body.length - end} chars omitted]` : '';
  return [
    `<edit-recovery file_hash="${fileHash}" char_start="${start}" char_end="${end}" total_chars="${body.length}">`,
    content + omittedTail,
    '</edit-recovery>',
    `Retry with expected_hash="${fileHash}" and an old_string copied from this current raw context.`,
  ].join('\n');
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

function commandStartsNoBrowserAuthLogin(command: string): boolean {
  const normalized = String(command || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const startsAuthLogin =
    /\bgcloud\s+auth\s+(?:application-default\s+)?login\b/i.test(normalized)
    || /\bgws\s+auth\s+login\b/i.test(normalized);
  const requestsManualCode =
    /(?:^|\s)--no-launch-browser(?:\s|$|=true\b)/i.test(normalized)
    || /(?:^|\s)--no-browser(?:\s|$|=true\b)/i.test(normalized);
  return startsAuthLogin && requestsManualCode;
}

function guardUnsupportedAuthCodeFlow(command: string): string | null {
  if (!commandStartsNoBrowserAuthLogin(command)) return null;
  return errText(
    'E_INTERACTIVE_AUTH_CODE_UNSUPPORTED',
    'this command starts a one-time browser verification-code flow that cannot be completed reliably through chat. '
    + 'Do not ask the user to paste verification codes into the conversation or keep a background process waiting. '
    + 'Use interactive_cli_start for commands that need live user input, use a browser/callback OAuth flow that completes on its own, '
    + 'use an Orkas connector OAuth flow, or stop and give the user a one-time terminal command to run.',
  );
}

const GOOGLE_CLOUD_SDK_OAUTH_CLIENT_IDS = [
  '32555940559.apps.googleusercontent.com',
  '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com',
];

const GOOGLE_WORKSPACE_SCOPE_RE =
  /https?:\/\/(?:www\.)?googleapis\.com\/auth\/(?:gmail(?:[.\s/&?]|$)|drive(?:[.\s/&?]|$)|documents(?:[\s/&?]|$)|spreadsheets(?:[\s/&?]|$)|calendar(?:[.\s/&?]|$)|contacts(?:[.\s/&?]|$)|tasks(?:[\s/&?]|$))/i;

function decodedOAuthText(input: string): string {
  const raw = String(input || '');
  let decoded = raw.replace(/\+/g, ' ');
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(decoded).replace(/\+/g, ' ');
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return `${raw}\n${decoded}`;
}

function containsCloudSdkClientWithWorkspaceScope(input: string): boolean {
  const haystack = decodedOAuthText(input);
  return GOOGLE_CLOUD_SDK_OAUTH_CLIENT_IDS.some((clientId) => haystack.includes(clientId))
    && GOOGLE_WORKSPACE_SCOPE_RE.test(haystack);
}

function googleWorkspaceOauthClientScopeMismatchErr(): string {
  return errText(
    'E_GOOGLE_OAUTH_CLIENT_SCOPE_MISMATCH',
    'Google Cloud SDK OAuth client IDs cannot be reused with Gmail, Drive, Docs, Sheets, Calendar, Contacts, or Tasks scopes. '
    + 'Do not synthesize Google OAuth URLs or scripts with Cloud SDK client IDs. Use an Orkas connector OAuth flow or stop and explain that Google Workspace access needs a product-managed Google connector.',
  );
}

function guardGoogleWorkspaceOauthClientMismatchText(input: string): string | null {
  return containsCloudSdkClientWithWorkspaceScope(input)
    ? googleWorkspaceOauthClientScopeMismatchErr()
    : null;
}

function unquoteShellToken(token: string): string {
  const s = String(token || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function guardGoogleWorkspaceOauthClientMismatchCommand(command: string, cwd?: string): string | null {
  const directErr = guardGoogleWorkspaceOauthClientMismatchText(command);
  if (directErr) return directErr;

  const re = /\b(?:python3?|node|bash|sh|zsh)\s+((?:"[^"]+"|'[^']+'|[^\s;&|]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const scriptRef = unquoteShellToken(m[1]);
    if (!scriptRef || scriptRef.startsWith('-')) continue;
    const abs = path.isAbsolute(scriptRef)
      ? scriptRef
      : path.resolve(cwd || process.cwd(), scriptRef);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile() || st.size > 512 * 1024) continue;
      const fileErr = guardGoogleWorkspaceOauthClientMismatchText(fs.readFileSync(abs, 'utf8'));
      if (fileErr) return fileErr;
    } catch {
      // Missing/unreadable script paths should fail naturally when the command runs.
    }
  }
  return null;
}

function guardInteractiveNoBrowserAuthFlow(command: string, allowNoBrowserAuth: boolean): string | null {
  if (allowNoBrowserAuth || !commandStartsNoBrowserAuthLogin(command)) return null;
  return errText(
    'E_INTERACTIVE_AUTH_NO_BROWSER_UNSUPPORTED',
    'this interactive command disables the browser OAuth callback flow. Start the same login without --no-browser/--no-launch-browser so the CLI can open the browser and complete after the user authorizes. '
    + 'Do not switch to another OAuth method, ask for codes in chat, or install alternate auth libraries unless the user explicitly asks for a no-browser flow.',
  );
}

const VIDEO_STUDIO_UNMANAGED_RUNTIME_PATTERNS: RegExp[] = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|ci|add)\b/i,
  /\b(?:pip3?|uv\s+pip|python3?\s+-m\s+pip)\s+install\b/i,
  /\bpython3?\s+-m\s+http\.server\b/i,
  /\bphp\s+-S\s+\S+/i,
  /\bruby\s+-run\s+-e\s+httpd\b/i,
  /\b(?:npx|pnpm\s+dlx|bunx)\s+(?:serve|http-server|vite)\b/i,
  /\b(?:chromium|chromium-browser|google-chrome|chrome)(?:\s|[^;&|])*--headless\b/i,
  /\b(?:puppeteer(?:-core)?|playwright)\b/i,
];

function videoStudioUnmanagedRuntimeError(command: string, cwd?: string): string | null {
  const inspect = (text: string): boolean => VIDEO_STUDIO_UNMANAGED_RUNTIME_PATTERNS.some((pattern) => pattern.test(text));
  if (inspect(command)) {
    return errText(
      'E_VIDEO_STUDIO_UNMANAGED_RUNTIME_FORBIDDEN',
      'VideoStudio may not install ad-hoc packages or start its own browser, HTTP server, watcher, or headless QA runtime. Use the native video_studio composition.lint/inspect/snapshot operations and their persisted findings instead.',
    );
  }
  const scriptRe = /\b(?:python3?|node|bash|sh|zsh)\s+((?:"[^"]+"|'[^']+'|[^\s;&|]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(command)) !== null) {
    const scriptRef = unquoteShellToken(match[1]);
    if (!scriptRef || scriptRef.startsWith('-')) continue;
    const abs = path.isAbsolute(scriptRef) ? scriptRef : path.resolve(cwd || process.cwd(), scriptRef);
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size <= 512 * 1024 && inspect(fs.readFileSync(abs, 'utf8'))) {
        return errText(
          'E_VIDEO_STUDIO_UNMANAGED_RUNTIME_FORBIDDEN',
          'the requested script starts or installs an unmanaged browser/server runtime. Use native video_studio QA operations instead.',
        );
      }
    } catch {
      // Missing scripts fail naturally when executed.
    }
  }
  return null;
}

function guardVideoStudioUnmanagedRuntime(opts: LocalToolsOpts, command: string, cwd?: string): string | null {
  return opts.agentId === VIDEO_STUDIO_AGENT_ID
    ? videoStudioUnmanagedRuntimeError(command, cwd)
    : null;
}

function unquotedShellSurface(command: string): string {
  let quote = '';
  let escaped = false;
  let out = '';
  for (const ch of command) {
    if (escaped) {
      out += quote ? ' ' : ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' || (quote === '"' && ch === '`')) {
      escaped = true;
      out += quote ? ' ' : ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      out += ch === '\n' ? '\n' : ' ';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Detect commands that are valid POSIX shell but invalid in Windows
 * PowerShell 5.1, the host shell used by the compatibility-named `bash` tool.
 * Keep this conservative: reject only high-confidence syntax mismatches and
 * return rewrite guidance before paying for a real failed process. */
export function windowsPowerShellCompatibilityError(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform !== 'win32') return null;
  const surface = unquotedShellSurface(String(command || ''));
  const findings: string[] = [];
  if (/&&|\|\|/.test(surface)) findings.push('POSIX &&/|| chaining');
  if (/<<-?\s*[A-Za-z_][A-Za-z0-9_]*/.test(surface)) findings.push('POSIX heredoc');
  if (/(?:^|[;\r\n]\s*)(?:source|export)\b/m.test(surface)) findings.push('source/export');
  if (/(?:^|[;|\r\n]\s*)head(?:\s|$)/m.test(surface)) findings.push('head');
  if (/(?:^|[;|\r\n]\s*)mktemp(?:\s|$)/m.test(surface)) findings.push('mktemp');
  if (/\/dev\/null\b/.test(surface)) findings.push('/dev/null');
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*=[^\s;]+\s+\S/m.test(surface)) findings.push('POSIX inline environment assignment');
  if (!findings.length) return null;
  return errText(
    'E_SHELL_SYNTAX_MISMATCH',
    `host shell is Windows PowerShell, but the command contains ${findings.join(', ')}. `
    + 'Rewrite it as PowerShell before retrying: use `;` for sequencing, `$env:NAME = value` for environment variables, '
    + '`$null` for discarded output, `Select-Object -First N` for head, and a `[System.IO.Path]::GetTempFileName()` or '
    + '`New-Item` temporary path. For a multi-line script, write a `.ps1` file and invoke it with PowerShell.',
  );
}

/** Wrapped `bash` tool — identical schema, permission-gated, host-shell wording. */
function createBashTool(opts: LocalToolsOpts): AgentTool {
  const wafBlockedCommands = new Set<string>();
  const windowsShellDescription = process.platform === 'win32'
    ? 'This tool is the host shell (PowerShell on Windows), despite its compatibility name `bash`. ' +
      'Use `$env:NAME` for environment variables, `;` for sequencing, and PowerShell-native ' +
      'pipelines. Do not use POSIX-only `&&`, heredocs, `source`/`export`, `/dev/null`, `head`, ' +
      'or `mktemp`. Invoke a quoted executable with `&`, for example ' +
      '`& "$env:ORKAS_NODE" "$env:ORKAS_PC_DIR/bin/run-skill.cjs" ...`. '
    : '';
  const outputDirDescription = process.platform === 'win32'
    ? 'Use the absolute `$env:ORKAS_OUTPUT_DIR` path for final generated outputs. ' +
      'Complex scripts may append one final output path per line to `$env:ORKAS_OUTPUT_MANIFEST`. '
    : 'Use the absolute `$ORKAS_OUTPUT_DIR` path for final generated outputs. ' +
      'Complex scripts may append one final output path per line to `$ORKAS_OUTPUT_MANIFEST`. ';

  return {
    name: 'bash',
    description:
      'Execute a shell command on the user\'s local machine and return its output. ' +
      'Use for installing CLIs (brew, npm, pip), running builds, converting files, ' +
      'inspecting the filesystem, and any other host-side work. The shell runs in ' +
      'the user\'s current workspace directory. Files generated under the conversation ' +
      'workspace are surfaced as produced-file chips, except for files clearly created ' +
      'by external download/clone commands such as git clone, gh repo clone, curl, or wget. ' +
      outputDirDescription +
      windowsShellDescription +
      'Scratch/cache files should stay in temporary or cache directories. ' +
      'For GUI apps, browsers, servers, watchers, or any command you would normally ' +
      'background with `&`, set run_in_background=true instead of shell-backgrounding it; ' +
      'inherited stdout/stderr can otherwise keep the tool waiting.',
    inputSchema: {
      ...(coreBashTool.inputSchema as Record<string, unknown>),
      properties: {
        ...(((coreBashTool.inputSchema as Record<string, unknown>).properties || {}) as Record<string, unknown>),
        allow_browser_runtime_install: {
          type: 'boolean',
          description: 'Set true only when the user explicitly requested installing Playwright/Puppeteer or another browser automation runtime. Leave false for ordinary web research or one-off page actions.',
        },
      },
    },
    async execute(input, ctx) {
      const mode = getLocalExecMode();
      const command = String(input.command ?? '');
      const commandKey = command.trim();
      const shellMismatch = windowsPowerShellCompatibilityError(command, opts.hostPlatform ?? process.platform);
      if (shellMismatch) {
        log.warn('bash host shell syntax reject', {
          user_id: maskId(opts.userId),
          cid: maskId(opts.cid),
          command_chars: command.length,
        });
        return { content: shellMismatch, isError: true } as ToolResult;
      }
      if (wafBlockedCommands.has(commandKey)) {
        return {
          content: errText(
            'E_BROWSER_WAF_USER_ACTION_REQUIRED',
            'this exact browser automation command already reached an anti-bot/WAF challenge. Do not retry or install another browser runtime. Ask the user to complete the site interaction manually, or use an accessible official source/search result.',
          ),
          isError: true,
        } as ToolResult;
      }
      if (browserRuntimeInstallRequiresExplicitRequest(command)
        && input.allow_browser_runtime_install !== true) {
        return {
          content: errText(
            'E_BROWSER_RUNTIME_INSTALL_REQUIRES_EXPLICIT_USER_REQUEST',
            'do not install Playwright/Puppeteer for ad-hoc browsing or to work around a site challenge. Use web_search/web_fetch or an existing browser capability. Only retry with allow_browser_runtime_install=true when the user explicitly requested browser automation runtime installation.',
          ),
          isError: true,
        } as ToolResult;
      }
      const finalizeBrowserResult = (result: ToolResult): ToolResult => {
        if (!browserAutomationHitWaf(command, String(result.content || ''))) return result;
        if (commandKey) wafBlockedCommands.add(commandKey);
        return {
          content: errText(
            'E_BROWSER_WAF_USER_ACTION_REQUIRED',
            'the browser reached an anti-bot/WAF or human-verification page instead of the requested content. Stop browser retries; ask the user to complete the interaction manually, or use an accessible official source/search result.',
          ),
          isError: true,
        } as ToolResult;
      };
      const unmanagedRuntimeErr = guardVideoStudioUnmanagedRuntime(opts, command, ctx.workingDir);
      if (unmanagedRuntimeErr) {
        log.warn('bash VideoStudio unmanaged runtime reject', {
          user_id: maskId(opts.userId),
          cid: maskId(opts.cid),
          command_chars: command.length,
        });
        return { content: unmanagedRuntimeErr, isError: true };
      }
      const protectedMention = protectedRootMentionedByCommand(opts, command);
      if (protectedMention && !bashProtectedRootMentionIsProvablyReadOnly(command)) {
        log.warn('bash protected root reject', {
          user_id: maskId(opts.userId),
          command_chars: command.length,
          root: logPathRef(protectedMention),
        });
        return {
          content: protectedWriteError(protectedMention, protectedMention),
          isError: true,
        };
      }
      const oauthClientMismatchErr = guardGoogleWorkspaceOauthClientMismatchCommand(command, ctx.workingDir);
      if (oauthClientMismatchErr) {
        log.warn('bash google oauth client/scope mismatch reject', {
          user_id: maskId(opts.userId),
          command_chars: command.length,
        });
        return { content: oauthClientMismatchErr, isError: true };
      }
      const disabledSkillErr = guardDisabledSkillBash(opts, command);
      if (disabledSkillErr) {
        log.warn('bash disabled skill reject', {
          user_id: maskId(opts.userId),
          command_chars: command.length,
        });
        return { content: disabledSkillErr, isError: true };
      }
      const unsupportedAuthErr = guardUnsupportedAuthCodeFlow(command);
      if (unsupportedAuthErr) {
        log.warn('bash unsupported auth-code flow reject', {
          user_id: maskId(opts.userId),
          command_chars: command.length,
        });
        return { content: unsupportedAuthErr, isError: true };
      }
      const workingDirForGuard = path.resolve(ctx.workingDir ?? '.');
      const filesystemGate = await guardBashFilesystemTargets(opts, input, ctx, workingDirForGuard);
      if (filesystemGate.result) return filesystemGate.result;
      // Approval modes: classify the command and block on user confirmation
      // when it trips a sensitive category. all_files_auto skips this.
      if (localAccessRequiresSensitiveApproval(mode) && command.trim()) {
        const base = classifyBashCommand(command);
        const pathApprovalCoveredSensitive = filesystemGate.approvedReasons.includes('sensitive_path');
        const baseReasons = pathApprovalCoveredSensitive
          ? base.reasons.filter((reason) => reason !== 'sensitive_path')
          : base.reasons;
        const reasons = classifyConfiguredBashCommand(command, baseReasons, {
          includePathPatterns: !pathApprovalCoveredSensitive,
        });
        if (reasons.length) {
          const decision = await requestBashDecision({
            uid: opts.userId ?? '',
            cid: opts.cid ?? '',
            agentId: opts.agentId ?? '',
            agentName: opts.agentName ?? opts.agentId ?? '',
            command,
            reasons,
            onWaiting: permissionWaitProgress(ctx, 'bash'),
          });
          if (decision === 'deny') {
            log.warn('bash risk denied', {
              user_id: maskId(opts.userId),
              cid: maskId(opts.cid),
              agent_id: maskId(opts.agentId),
              command_chars: command.length,
              reasons,
            });
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
      if (!ctx.workingDir) {
        return finalizeBrowserResult(translateFixedBashError(await coreBashTool.execute(input, ctx)));
      }
      const workingDir = path.resolve(ctx.workingDir);
      if (fs.existsSync(workingDir)) {
        return finalizeBrowserResult(await executeCoreBashWithOutputTracking(opts, input, ctx, workingDir));
      }
      try { fs.mkdirSync(ctx.workingDir, { recursive: true }); }
      catch { /* let spawn produce the canonical error */ }
      try {
        return finalizeBrowserResult(await executeCoreBashWithOutputTracking(opts, input, ctx, workingDir));
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

async function gateInteractiveCliStart(
  opts: LocalToolsOpts,
  command: string,
  settings?: { allowNoBrowserAuth?: boolean; workingDir?: string },
  ctx?: ToolContext,
): Promise<ToolResult | null> {
  const mode = getLocalExecMode();
  const shellMismatch = windowsPowerShellCompatibilityError(command, opts.hostPlatform ?? process.platform);
  if (shellMismatch) return { content: shellMismatch, isError: true };
  const unmanagedRuntimeErr = guardVideoStudioUnmanagedRuntime(opts, command, settings?.workingDir);
  if (unmanagedRuntimeErr) return { content: unmanagedRuntimeErr, isError: true };
  const protectedMention = protectedRootMentionedByCommand(opts, command);
  if (protectedMention) {
    log.warn('interactive_cli_start protected root reject', {
      user_id: maskId(opts.userId),
      command_chars: command.length,
      root: logPathRef(protectedMention),
    });
    return {
      content: protectedWriteError(protectedMention, protectedMention),
      isError: true,
    };
  }
  const oauthClientMismatchErr = guardGoogleWorkspaceOauthClientMismatchCommand(command, settings?.workingDir);
  if (oauthClientMismatchErr) {
    log.warn('interactive_cli_start google oauth client/scope mismatch reject', {
      user_id: maskId(opts.userId),
      command_chars: command.length,
    });
    return { content: oauthClientMismatchErr, isError: true };
  }
  const unsupportedNoBrowserAuthErr = guardInteractiveNoBrowserAuthFlow(
    command,
    settings?.allowNoBrowserAuth === true,
  );
  if (unsupportedNoBrowserAuthErr) {
    log.warn('interactive_cli_start unsupported no-browser auth reject', {
      user_id: maskId(opts.userId),
      command_chars: command.length,
    });
    return { content: unsupportedNoBrowserAuthErr, isError: true };
  }
  const disabledSkillErr = guardDisabledSkillBash(opts, command);
  if (disabledSkillErr) {
    log.warn('interactive_cli_start disabled skill reject', {
      user_id: maskId(opts.userId),
      command_chars: command.length,
    });
    return { content: disabledSkillErr, isError: true };
  }
  if (localAccessRequiresSensitiveApproval(mode) && command.trim()) {
    const base = classifyBashCommand(command);
    const reasons = classifyConfiguredBashCommand(command, base.reasons);
    if (reasons.length) {
      const decision = await requestBashDecision({
        uid: opts.userId ?? '',
        cid: opts.cid ?? '',
        agentId: opts.agentId ?? '',
            agentName: opts.agentName ?? opts.agentId ?? '',
            command,
            reasons,
            onWaiting: permissionWaitProgress(ctx, 'interactive_cli_start'),
          });
      if (decision === 'deny') {
        log.warn('interactive_cli_start risk denied', {
          user_id: maskId(opts.userId),
          cid: maskId(opts.cid),
          agent_id: maskId(opts.agentId),
          command_chars: command.length,
          reasons,
        });
        return {
          content: errText(
            'E_BASH_RISK_DENIED',
            `the user declined to run this interactive command (flagged: ${reasons.join(', ')}). `
            + 'Do not retry the same command or work around the prompt; explain in prose what you intended and ask the user how to proceed.',
          ),
          isError: true,
        };
      }
    }
  }
  return null;
}

function jsonToolResult(value: unknown): ToolResult {
  return { content: JSON.stringify(value, null, 2) };
}

function interactiveCliUserActionState(view: InteractiveCliSessionView): {
  userActionRequired: boolean;
  reason?: string;
  nextStep: string;
} {
  if (view.status !== 'running') {
    return {
      userActionRequired: false,
      nextStep:
        view.status === 'error'
          ? 'The interactive command ended with an error before user input was needed. Explain the problem and next step to the user in prose; do not wait for input in the panel.'
          : 'The interactive command already finished. Continue the task or summarize the result to the user.',
    };
  }

  const output = String(view.output || '');
  const urls = Array.isArray(view.urls) ? view.urls.join('\n') : '';
  const authBrowser =
    /browser has been opened|opened to visit|complete the sign-in prompts|accounts\.google\.com\/o\/oauth2|redirect_uri=http/i.test(output)
    || /accounts\.google\.com\/o\/oauth2|redirect_uri=http|code_challenge=/i.test(urls);
  if (authBrowser) {
    return {
      userActionRequired: true,
      reason: 'browser_auth',
      nextStep:
        'The CLI has already opened or shown the browser authorization page. Stop tool use now. Do not call open/xdg-open/start, do not restart or close this auth command, do not check auth status, do not install alternate auth libraries, and do not switch to another OAuth method such as ADC or Python OAuth. Tell the user to finish authorization in the browser; continue only after the user replies, cancels, or the session exits.',
    };
  }
  if (view.prompt_kind) {
    return {
      userActionRequired: true,
      reason: view.prompt_kind,
      nextStep:
        'The CLI is waiting for user input. Stop tool use now and ask the user to enter the requested value in the Orkas interactive CLI panel, not in chat. Do not close this command, retry with another auth method, or install alternate auth libraries while it is waiting. Continue only after the user replies, cancels, or the session output changes.',
    };
  }
  return {
    userActionRequired: false,
    nextStep:
      'Use interactive_cli_read only after meaningful progress is expected, such as after waiting or after the user has acted. Do not repeat identical reads in a tight loop.',
  };
}

function interactiveCliToolPayload(view: InteractiveCliSessionView): Record<string, unknown> {
  const state = interactiveCliUserActionState(view);
  return {
    session_id: view.session_id,
    ...(view.purpose ? { purpose: view.purpose } : {}),
    status: view.status,
    ...(view.status !== 'running' ? { exit_code: view.exit_code ?? null } : {}),
    output: view.output,
    urls: view.urls,
    ...(view.prompt_kind ? { prompt_kind: view.prompt_kind } : {}),
    ...(typeof view.sensitive_hint === 'boolean' ? { sensitive_hint: view.sensitive_hint } : {}),
    user_action_required: state.userActionRequired,
    agent_should_stop: state.userActionRequired,
    ...(state.reason ? { user_action_reason: state.reason } : {}),
    next_step: state.nextStep,
  };
}

function createInteractiveCliStartTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'interactive_cli_start',
    description:
      'Start a local CLI command that needs live user stdin, such as OAuth/device-code login, password prompts, confirmations, or setup wizards. Use bash for one-shot commands, --help, validation, and installs. Tell users to enter secrets/codes in the interactive CLI panel, not chat. Avoid full-screen TUI programs.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to start in the conversation workspace. Required.',
        },
        max_lifetime_ms: {
          type: 'number',
          description: 'Optional maximum session lifetime. Defaults to 30 minutes; values below 10 minutes are raised to 10 minutes; hard cap is 2 hours.',
        },
        purpose: {
          type: 'string',
          description: 'Short user-facing title for the interactive panel. Do not put the raw command here.',
        },
        allow_no_browser_auth: {
          type: 'boolean',
          description: 'Only set true when the user explicitly says browser OAuth cannot be used. Otherwise OAuth login commands with --no-browser/--no-launch-browser are rejected.',
        },
      },
      required: ['command'],
    },
    async execute(input, ctx) {
      const command = String(input.command ?? '').trim();
      if (!command) return { content: errText('E_BAD_INPUT', '`command` is required'), isError: true };
      const workingDir = path.resolve(ctx.workingDir ?? '.');
      const gate = await gateInteractiveCliStart(opts, command, {
        allowNoBrowserAuth: input.allow_no_browser_auth === true,
        workingDir,
      }, ctx);
      if (gate) return gate;
      try { fs.mkdirSync(workingDir, { recursive: true }); }
      catch { /* spawn will report the canonical error */ }
      const view = startInteractiveCliSession({
        uid: opts.userId ?? '',
        cid: opts.cid,
        agentId: opts.agentId,
        agentName: opts.agentName ?? opts.agentId,
        purpose: typeof input.purpose === 'string' ? input.purpose : undefined,
        command,
        cwd: workingDir,
        sandboxEnv: (ctx.state.sandboxEnv ?? {}) as Record<string, string>,
        maxLifetimeMs: Number(input.max_lifetime_ms),
      });
      await new Promise((resolve) => setTimeout(resolve, 250));
      const latest = readInteractiveCliSession(opts.userId ?? '', view.session_id);
      if (latest.status !== 'running') {
        const result = interactiveCliToolPayload(latest);
        return {
          content: JSON.stringify(result, null, 2),
          isError: latest.status === 'error',
        };
      }
      return jsonToolResult(interactiveCliToolPayload(latest));
    },
  };
}

function createInteractiveCliReadTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'interactive_cli_read',
    description:
      'Read the current status and recent output of an interactive CLI session started with interactive_cli_start. ' +
      'Use this after waiting or after the user has entered input in the interactive CLI panel.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id returned by interactive_cli_start.' },
      },
      required: ['session_id'],
    },
    async execute(input) {
      if (!getLocalExecGranted()) return deniedResult();
      const sessionId = String(input.session_id ?? '').trim();
      if (!sessionId) return { content: errText('E_BAD_INPUT', '`session_id` is required'), isError: true };
      try {
        return jsonToolResult(interactiveCliToolPayload(readInteractiveCliSession(opts.userId ?? '', sessionId)));
      } catch (err) {
        return { content: errText('E_INTERACTIVE_CLI', (err as Error).message), isError: true };
      }
    },
  };
}

function createInteractiveCliSendTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'interactive_cli_send',
    description:
      'Send non-secret input to an interactive CLI session stdin. ' +
      'Use for agent-known responses such as y/n, menu choices, or pressing Enter. ' +
      'Do not use this for OAuth authorization codes, passwords, tokens, API keys, or other user secrets; ask the user to type those in the Orkas interactive CLI panel instead.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id returned by interactive_cli_start.' },
        input: { type: 'string', description: 'Input to send to stdin.' },
        add_newline: { type: 'boolean', description: 'Default true. Append a newline after input.' },
      },
      required: ['session_id', 'input'],
    },
    async execute(input) {
      if (!getLocalExecGranted()) return deniedResult();
      const sessionId = String(input.session_id ?? '').trim();
      if (!sessionId) return { content: errText('E_BAD_INPUT', '`session_id` is required'), isError: true };
      try {
        const view = sendInteractiveCliInput(opts.userId ?? '', sessionId, String(input.input ?? ''), {
          addNewline: input.add_newline !== false,
          sensitive: false,
        });
        return jsonToolResult({ session_id: view.session_id, status: view.status, sent: true });
      } catch (err) {
        return { content: errText('E_INTERACTIVE_CLI', (err as Error).message), isError: true };
      }
    },
  };
}

function createInteractiveCliCloseTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'interactive_cli_close',
    description:
      'Close an interactive CLI session and terminate its process tree. Use when setup is done, the command is stuck, or the user cancels. ' +
      'Do not close a session that is waiting for browser authorization or user input unless the user explicitly cancels; in that case set force=true and provide a brief reason.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id returned by interactive_cli_start.' },
        force: {
          type: 'boolean',
          description: 'Required to close a running session that is currently waiting for user action. Use only after explicit user cancellation or test cleanup.',
        },
        reason: {
          type: 'string',
          description: 'Brief reason for forcing close, for example "user cancelled authorization".',
        },
      },
      required: ['session_id'],
    },
    async execute(input) {
      if (!getLocalExecGranted()) return deniedResult();
      const sessionId = String(input.session_id ?? '').trim();
      if (!sessionId) return { content: errText('E_BAD_INPUT', '`session_id` is required'), isError: true };
      try {
        const current = readInteractiveCliSession(opts.userId ?? '', sessionId);
        const state = interactiveCliUserActionState(current);
        if (current.status === 'running' && state.userActionRequired && input.force !== true) {
          return {
            content: errText(
              'E_INTERACTIVE_CLI_WAITING_FOR_USER',
              'this interactive CLI session is waiting for the user. Do not close, restart, poll, or switch to another auth method before the user acts. '
              + 'Only close it with force=true after the user explicitly cancels.',
            ),
            isError: true,
          };
        }
        if (input.force === true) {
          const reason = String(input.reason || '').replace(/\s+/g, ' ').trim();
          log.info('interactive_cli_close force requested', {
            user_id: maskId(opts.userId),
            session_id: maskId(sessionId),
            reason_chars: reason.length,
          });
        }
        return jsonToolResult(interactiveCliToolPayload(closeInteractiveCliSession(opts.userId ?? '', sessionId)));
      } catch (err) {
        return { content: errText('E_INTERACTIVE_CLI', (err as Error).message), isError: true };
      }
    },
  };
}

/** Wrapped `write_file` tool — uniquify-on-collision + onFileWritten emit. */
function createWriteFileTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'write_file',
    description:
      'Write a kept workspace artifact such as source, notes, markdown, or CSV. Creates parents. On collision with a file not written by you this turn, the basename is auto-suffixed and reported in <file-renamed>; use that final path afterward.',
    inputSchema: coreWriteFileTool.inputSchema,
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();
      const oauthClientMismatchErr = guardGoogleWorkspaceOauthClientMismatchText(String(input.content ?? ''));
      if (oauthClientMismatchErr) {
        log.warn('write_file google oauth client/scope mismatch reject', { user_id: maskId(opts.userId) });
        return { content: oauthClientMismatchErr, isError: true };
      }
      const inputPath = String(input.path ?? '');
      if (!inputPath) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const inputAbs = resolveAbs(ctx, inputPath);
      const scopeErr = await gateEditPath(opts, inputAbs, ctx);
      if (scopeErr) {
        log.warn('write_file scope reject', { user_id: maskId(opts.userId), path: logPathRef(inputAbs) });
        return { content: scopeErr, isError: true };
      }
      const { finalPath, renamed } = await uniquifyPath(inputAbs, isMineFor(opts));
      const rewritten = finalPath !== inputAbs
        ? { ...input, path: finalPath }
        : input;
      const result = await coreWriteFileTool.execute(rewritten, ctx);
      if (!result.isError) {
        // Stamp the just-written bytes so a follow-up edit_file accepts an edit
        // without an intervening read_file (the model already knows the content
        // it wrote), and so OCC compares against this write, not a stale read.
        recordRead(ctx, finalPath);
      }
      if (!result.isError && opts.onFileWritten) {
        try {
          await opts.onFileWritten(finalPath);
        } catch (err) {
          log.warn('onFileWritten callback failed', { error: logErrorRef(err) });
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
 *  Non-text and extracted kinds are rejected. */
function createEditFileTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'edit_file',
    description:
      'Replace old_string with new_string in an existing text file. Prefer this for targeted edits; use write_file to create files. old_string must match raw file text (not read_file line-number prefixes) and be unique unless replace_all=true. Pass read_file\'s file_hash as expected_hash for explicit optimistic concurrency. E_NOT_READ/E_STALE/E_NO_MATCH return bounded current context and a fresh hash for one safe retry. Cannot edit PDF/Office/image sources in place.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path to an existing file.' },
        old_string: { type: 'string', description: 'Exact text to find. Must be unique unless replace_all=true.' },
        new_string: { type: 'string', description: 'Replacement text. May be empty.' },
        replace_all: { type: 'boolean', description: 'Default false. When true, every occurrence of old_string is replaced.' },
        expected_hash: {
          type: 'string',
          description: 'Optional sha256 file_hash returned by read_file or a prior edit recovery response.',
          pattern: '^sha256:[a-f0-9]{64}$',
        },
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
      const expectedHash = typeof input.expected_hash === 'string' ? input.expected_hash.trim() : '';
      if (expectedHash && !/^sha256:[a-f0-9]{64}$/.test(expectedHash)) {
        return { content: errText('E_BAD_INPUT', '`expected_hash` must be a lowercase sha256:<64 hex> file hash'), isError: true };
      }

      const abs = resolveAbs(ctx, rawPath);
      const scopeErr = await gateEditPath(opts, abs, ctx);
      if (scopeErr) {
        log.warn('edit_file scope reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: scopeErr, isError: true };
      }

      // Serialize the read-modify-write per file: parallel workers share this
      // process + filesystem, so two concurrent edits of the same file must not
      // interleave stat→read→write (lost update). Distinct files never contend.
      const release = await fileEditLock(abs).acquire();
      try {
        let st: fs.Stats;
        try { st = fs.statSync(abs); }
        catch (err) {
          log.warn('edit_file not found', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
          return {
            content: errText('E_NOT_FOUND', `${abs}: file does not exist (use write_file to create new files)`),
            isError: true,
          };
        }
        if (!st.isFile()) {
          return { content: errText('E_NOT_FOUND', `${abs}: not a regular file`), isError: true };
        }

        const kind = kindOf(abs);
        if (kind !== 'text') {
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
          log.warn('edit_file read failed', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
          return { content: errText('E_EDIT_FAILED', `${abs}: read failed: ${msg}`), isError: true };
        }
        const currentHash = editableFileHash(body);

        // Read-before-edit + OCC: a run-scoped baseline or an explicit hash
        // must identify the exact bytes being edited. A rejected attempt
        // refreshes the baseline and returns bounded current context, so the
        // next attempt can recover without another tool round.
        const block = checkEditFreshness(ctx, abs, st, {
          ...(expectedHash ? { expectedHash } : {}),
          currentHash,
        });
        if (block) {
          recordRead(ctx, abs, st, currentHash);
          log.warn('edit_file freshness reject', { user_id: maskId(opts.userId), path: logPathRef(abs), code: block.code });
          return {
            content: `${errText(block.code, block.msg)}\n${editRecoveryContext(body, oldStr, currentHash)}`,
            isError: true,
          };
        }

        const count = countOccurrences(body, oldStr);
        if (count === 0) {
          recordRead(ctx, abs, st, currentHash);
          return {
            content: `${errText('E_NO_MATCH', `${abs}: \`old_string\` not found in the current file`)}\n${editRecoveryContext(body, oldStr, currentHash)}`,
            isError: true,
          };
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
        const oauthClientMismatchErr = guardGoogleWorkspaceOauthClientMismatchText(next);
        if (oauthClientMismatchErr) {
          log.warn('edit_file google oauth client/scope mismatch reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
          return { content: oauthClientMismatchErr, isError: true };
        }

        try {
          fs.writeFileSync(abs, next, 'utf8');
        } catch (err) {
          const msg = (err as Error).message;
          log.warn('edit_file write failed', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
          return { content: errText('E_EDIT_FAILED', `${abs}: write failed: ${msg}`), isError: true };
        }

        // Refresh the baseline to the post-edit bytes so a follow-up edit in a
        // later round doesn't trip OCC on this same intended change.
        const nextHash = editableFileHash(next);
        recordRead(ctx, abs, undefined, nextHash);

        const replaced = replaceAll ? count : 1;
        log.info('edit_file applied', { user_id: maskId(opts.userId), path: logPathRef(abs), replaced });

        if (opts.onFileWritten) {
          try { await opts.onFileWritten(abs); }
          catch (err) { log.warn('onFileWritten callback failed', { error: logErrorRef(err) }); }
        }

        return {
          content: `<file path="${abs}" edited="${replaced}" kind="${kind}" file_hash="${nextHash}"/>`,
        };
      } finally {
        release();
      }
    },
  };
}

/** Declare the complete user-facing deliverable set for the current turn.
 * This tool does not read or write files. The group-chat owner validates each
 * normalized path against files actually written during the active turn. */
function createPublishOutputsTool(opts: LocalToolsOpts): AgentTool {
  return {
    name: 'publish_outputs',
    description:
      'Declare the complete final deliverable list for this turn after all file generation is finished. ' +
      'Include every file the user should see in the message footer; exclude source assets, previews, caches, logs, and other working files. ' +
      'Use an empty paths list when this turn created only working files and has no user-facing file deliverable. ' +
      'Only files actually written in this turn are accepted. A later call replaces the earlier declaration.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 50,
          description: 'Complete list of final file paths, absolute or relative to $working_dir; empty means no file deliverable.',
        },
      },
      required: ['paths'],
    },
    async execute(input, ctx) {
      if (!input || !Array.isArray(input.paths)) {
        return { content: errText('E_BAD_INPUT', '`paths` must be an array'), isError: true };
      }
      const rawPaths = input.paths;
      const normalized: string[] = [];
      const seen = new Set<string>();
      for (const raw of rawPaths.slice(0, 50)) {
        if (typeof raw !== 'string' || !raw.trim()) continue;
        const abs = resolveAbs(ctx, raw.trim());
        if (seen.has(abs)) continue;
        seen.add(abs);
        normalized.push(abs);
      }
      if (rawPaths.length > 0 && normalized.length === 0) {
        return { content: errText('E_BAD_INPUT', '`paths` must be empty or contain valid file paths'), isError: true };
      }
      if (!opts.onOutputsPublished) {
        return { content: errText('E_OUTPUT_PUBLICATION_UNAVAILABLE', 'this conversation cannot publish file outputs'), isError: true };
      }
      try {
        const accepted = await opts.onOutputsPublished(normalized);
        const acceptedSet = new Set(Array.isArray(accepted) ? accepted.map((p) => path.resolve(p)) : []);
        const acceptedCount = normalized.filter((p) => acceptedSet.has(p)).length;
        if (normalized.length > 0 && !acceptedCount) {
          return {
            content: errText(
              'E_OUTPUT_NOT_PRODUCED',
              'none of the requested paths were written in this turn; publish only successful current-turn outputs',
            ),
            isError: true,
          };
        }
        return {
          content: JSON.stringify({ published: acceptedCount, requested: normalized.length }),
        };
      } catch (err) {
        return {
          content: errText('E_OUTPUT_PUBLICATION_FAILED', (err as Error).message || String(err)),
          isError: true,
        };
      }
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
      const rawPath = String(input.path ?? '');
      if (!rawPath) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const inputAbs = resolveAbs(ctx, rawPath);
      const scopeErr = await gateEditPath(opts, inputAbs, ctx);
      if (scopeErr) {
        log.warn('markdown_to_pdf scope reject', { user_id: maskId(opts.userId), path: logPathRef(inputAbs) });
        return { content: scopeErr, isError: true };
      }
      const { finalPath, renamed } = await uniquifyPath(inputAbs, isMineFor(opts));
      if (finalPath !== inputAbs) {
        const finalScopeErr = await gateEditPath(opts, finalPath, ctx);
        if (finalScopeErr) {
          log.warn('markdown_to_pdf final scope reject', { user_id: maskId(opts.userId), path: logPathRef(finalPath) });
          return { content: finalScopeErr, isError: true };
        }
      }
      try {
        const footerText = producedDocumentFooterText({ userId: opts.userId, cid: opts.cid, source: 'markdown_to_pdf' });
        await markdownToPdf(String(input.markdown ?? ''), finalPath, {
          ...(typeof input.title === 'string' ? { title: input.title } : {}),
          ...(typeof input.pageSize === 'string' ? { pageSize: input.pageSize as any } : {}),
          ...(typeof input.landscape === 'boolean' ? { landscape: input.landscape } : {}),
          ...(footerText ? { footerText } : {}),
        });
        if (opts.onFileWritten) await opts.onFileWritten(finalPath);
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
      const rawPath = String(input.path ?? '');
      if (!rawPath) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const inputAbs = resolveAbs(ctx, rawPath);
      const scopeErr = await gateEditPath(opts, inputAbs, ctx);
      if (scopeErr) {
        log.warn('html_to_pdf scope reject', { user_id: maskId(opts.userId), path: logPathRef(inputAbs) });
        return { content: scopeErr, isError: true };
      }
      const { finalPath, renamed } = await uniquifyPath(inputAbs, isMineFor(opts));
      if (finalPath !== inputAbs) {
        const finalScopeErr = await gateEditPath(opts, finalPath, ctx);
        if (finalScopeErr) {
          log.warn('html_to_pdf final scope reject', { user_id: maskId(opts.userId), path: logPathRef(finalPath) });
          return { content: finalScopeErr, isError: true };
        }
      }
      try {
        const footerText = producedDocumentFooterText({ userId: opts.userId, cid: opts.cid, source: 'html_to_pdf' });
        await htmlToPdf(String(input.html ?? ''), finalPath, {
          ...(typeof input.pageSize === 'string' ? { pageSize: input.pageSize as any } : {}),
          ...(typeof input.landscape === 'boolean' ? { landscape: input.landscape } : {}),
          ...(footerText ? { footerText } : {}),
        });
        if (opts.onFileWritten) await opts.onFileWritten(finalPath);
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
      'Create an offline interactive HTML/CSS/JS artifact rendered live in chat. Use for calculators, dashboards, filters, simulations, quizzes, mini-games; prefer :::dashboard for static summaries. Input files: [{path, content, encoding?}], including top-level index.html; no network/CDN, use relative sibling files. Optional __orkas/bridge.js provides send(payload)/resize. Do not paste HTML after calling.',
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
        log.warn('create_artifact reject', {
          user_id: maskId(uid),
          cid: maskId(cid),
          agent_id: maskId(opts.agentId),
          error: logErrorRef(new Error(errMsg)),
        });
        return { content: errText('E_BAD_ARTIFACT', errMsg), isError: true };
      }
      const resolved = chatArtifacts.resolveArtifactDir(uid, cid, r.artifactId);
      if (!resolved.ok) {
        return { content: errText('E_ARTIFACT_FINALIZE_FAILED', 'artifact directory could not be resolved after creation'), isError: true };
      }
      try {
        await finalizeProducedArtifact(resolved.dirPath, {
          userId: uid,
          cid,
          artifactId: r.artifactId,
          source: 'create_artifact',
        });
      } catch (err) {
        log.warn('create_artifact finalizer failed', {
          user_id: maskId(uid),
          cid: maskId(cid),
          artifact_id: maskId(r.artifactId),
          error: logErrorRef(err),
        });
        return { content: errText('E_ARTIFACT_FINALIZE_FAILED', (err as Error).message || 'artifact post-processing failed'), isError: true };
      }
      if (opts.onArtifactCreated) {
        try { opts.onArtifactCreated({ id: r.artifactId, title: r.title }); }
        catch (err) { log.warn('onArtifactCreated callback failed', { artifact_id: maskId(r.artifactId), error: logErrorRef(err) }); }
      }
      log.info('create_artifact created', {
        user_id: maskId(uid),
        cid: maskId(cid),
        agent_id: maskId(opts.agentId),
        artifact_id: maskId(r.artifactId),
        file_count: Array.isArray((input as { files?: unknown }).files) ? ((input as { files: unknown[] }).files.length) : undefined,
      });
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
 *  `edit_file` (workspace + current attachment dir + writable extraRoots).
 *  Files inside that writable workspace scope are removed immediately.
 *  Destructive deletes outside that scope keep a per-call user click in the
 *  inline confirm card. The renderer may group multiple pending per-file
 *  tokens from the same turn into one card, but the tool still consumes one
 *  token per file.
 *
 *  Async token model (does NOT block the LLM turn — see
 *  delete-file-confirm.ts header):
 *    - First call: `delete_file({path})` (no token). Tool mints a token,
 *      emits/adds to a card, waits briefly for renderer visibility ack, and
 *      then returns with `requires_user_confirmation` so the LLM can keep
 *      doing other tool calls / finish the turn.
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
      'Delete one visible file. Files inside the current workspace/attachment/editor scope are deleted immediately. Files outside that scope use a two-step user confirmation flow: first call with path only to request a confirm card and get confirmation_token; after the user confirms, call again with path and token. Use this instead of bash rm.',
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
        log.warn('delete_file scope reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: scopeErr, isError: true };
      }
      const requiresConfirmation = deleteRequiresUserConfirmation(opts, abs);

      // ── Step 2: token-bearing call → consume + unlink if granted.
      if (token && requiresConfirmation) {
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
          log.info('delete_file denied by user', { user_id: maskId(opts.userId), path: logPathRef(abs) });
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
          log.warn('delete_file granted but missing', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
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
          log.warn('delete_file unlink failed', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
          return {
            content: errText('E_DELETE_FAILED', `${abs}: unlink failed: ${msg}`),
            isError: true,
          };
        }
        log.info('delete_file removed', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: `Deleted ${abs}` };
      }

      // ── Step 1: no token → check file exists, mint token + emit card.
      let st: fs.Stats;
      try { st = fs.statSync(abs); }
      catch (err) {
        log.warn('delete_file not found', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
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
      if (!requiresConfirmation) {
        try { fs.unlinkSync(abs); }
        catch (err) {
          const msg = (err as Error).message;
          log.warn('delete_file unlink failed', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
          return {
            content: errText('E_DELETE_FAILED', `${abs}: unlink failed: ${msg}`),
            isError: true,
          };
        }
        log.info('delete_file removed without confirmation', {
          user_id: maskId(opts.userId),
          path: logPathRef(abs),
          reason: isInWritableWorkspaceScope(opts, abs) ? 'workspace_scope' : 'all_files_auto',
        });
        return { content: `Deleted ${abs}` };
      }
      const newToken = requestDeleteConfirmation(abs, {
        display_path: rawPath,
        cid: opts.cid,
        turn_id: opts.turnId,
      });
      const cardVisible = await waitForDeleteConfirmationVisible(newToken);
      if (!cardVisible) {
        cancelDeleteConfirmation(newToken);
        log.warn('delete_file confirmation card unavailable', {
          user_id: maskId(opts.userId),
          cid: maskId(opts.cid),
          turn_id: maskId(opts.turnId),
          path: logPathRef(abs),
          confirmation_id: maskId(newToken),
        });
        return {
          content: errText(
            'E_CONFIRMATION_UNAVAILABLE',
            `${abs}: could not display the delete confirmation card, so no file was deleted. Tell the user the confirmation card did not appear and ask them to retry when the chat is visible.`,
          ),
          isError: true,
        };
      }
      log.info('delete_file confirmation requested', {
        user_id: maskId(opts.userId),
        cid: maskId(opts.cid),
        turn_id: maskId(opts.turnId),
        path: logPathRef(abs),
        confirmation_id: maskId(newToken),
      });
      return {
        content:
          `requires_user_confirmation: "${rawPath}" is outside the current writable workspace scope and needs the user's confirmation card.\n` +
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
    createInteractiveCliStartTool(opts),
    createInteractiveCliReadTool(opts),
    createInteractiveCliSendTool(opts),
    createInteractiveCliCloseTool(opts),
    createWriteFileTool(opts),
    createEditFileTool(opts),
    createDeleteFileTool(opts),
    createMarkdownToPdfTool(opts),
    createHtmlToPdfTool(opts),
  ];
  if (opts.onOutputsPublished) tools.push(createPublishOutputsTool(opts));
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
