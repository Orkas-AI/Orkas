/**
 * File-scoped tools injected into every main-conv runner.
 *
 *   - `read_files`    — read one or more files through a `paths` array. Each
 *                       item may carry an exact tagged line/character range;
 *                       `metadata_only` prepares rich-document extraction and
 *                       returns metadata for every path without file bodies.
 *                       Ordinary unbounded reads are token-budgeted and return
 *                       a continuation range instead of spilling to Result Store.
 *   - `search_files`  — locate files by name/glob across the current
 *                       conversation's attachment dir + active workspace.
 *                       Never triggers extract; `total_chars` is included
 *                       only when the cache already has it.
 *   - `grep_files`    — cross-file text search in that same scanned scope.
 *                       text/md/code → direct; PDF/modern Office → extract
 *                       (cached); image and unsupported legacy Office skipped.
 *
 * Scope is enforced via `util/path-sandbox.isPathAllowed`: path-taking tools
 * first verify the target falls under the active workspace, chat attachments,
 * caller-provided extra roots, or the current session's read-only tool-results
 * directory.
 * Paths outside that set return an explicit E_PATH_OUT_OF_SCOPE error.
 *
 * These tools do NOT require localExec permission — they only read from
 * paths visible to the current conv. Permission-gated tools (bash,
 * write_file) live in local-tools.ts.
 */

import { fileFailure, type FileFailureDiagnostic } from '../../../core-agent/src/tools/file-diagnostics';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentTool, ProgramSourceLoader, ToolContext, ToolObservations, ToolResult } from '#core-agent';
import { createLogger } from '../../logger';
import {
  statFile,
  readRange,
  readImageAsJpeg,
  getExtractedText,
  getCachedMeta,
  kindOf,
  NoTextError,
  UnsupportedFileKindError,
} from '../../features/file_indexer';
import { userMarketplaceSkillsDir, userSkillsDir } from '../../paths';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { getWorkspacePath } from '../../features/user_workspace';
import { isPathAllowed } from '../../util/path-sandbox';
import { localAccessAllowsOutsideWorkspace, localAccessRequiresSensitiveApproval } from '../../features/permissions';
import { sensitivePathReasons } from '../../features/local_access_policy';
import { requestBashDecision } from './bash-permissions';
import { macosTccSensitivePath } from '../../util/macos-tcc';
import { parseSkillPath } from '../../features/expert_signals/skill_path';
import { isSkillEnabled } from '../../features/component_enabled';
import { recordRead } from './read-tracker';
import { issueFileRevision } from './file-revision';
import { formatSearchFileResults, type SearchFileHit } from './search-file-result';
import { formatGrepFileResults, type GrepHit } from './grep-file-result';
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';
import {
  DEFAULT_INLINE_RESULT_TOKENS,
  TOOL_RESULT_INLINE_LEDGER_STATE_KEY,
  estimateToolResultTokens,
  type ToolResultInlineLedger,
} from '../../util/tool-result-cap';
import {
  openSkillReadRoots,
  SKILL_RUNTIME_REQUIREMENTS_READ_PRELUDE,
  type SkillRuntimeBinding,
} from './skill-registry';
import {
  fallbackDirectoryExcluded,
  fallbackFileExcluded,
  grepRepository,
  visitRepositoryFiles,
  createRepositorySearchBudget,
  readIgnoreScope,
  isIgnoredByScopes,
  type IgnoreScope,
} from './repository-search';

const log = createLogger('file-tools');

// ── Tunables ──────────────────────────────────────────────────────────────

/** Expensive document extraction has a separate bound from repository text searches. */
const MAX_EXTRACT_FILES = 2000;

/** Max results returned by search_files per call. */
const MAX_SEARCH_RESULTS = 200;

/** Max matches returned by grep_files per call. */
const MAX_GREP_MATCHES = 200;

/** grep_files yields to the event loop every N files scanned so a large text
 *  bucket can't stall the main process (reads are async; this also caps the
 *  CPU-burst between awaits). */
const GREP_YIELD_EVERY = 64;

/** Concurrent extract workers in grep_files. Rich-document cache miss path. */
const GREP_EXTRACT_CONCURRENCY = 4;

/** On-demand invocation facts; paths stay in the host's existing sandbox env. */
export function renderSkillExecutionReadPrelude(ref: string, platform: NodeJS.Platform = process.platform): string {
  const windows = platform === 'win32';
  const quotedRef = `'${ref.replace(/'/g, windows ? "''" : "'\"'\"'")}'`;
  const command = windows
    ? `& "$env:ORKAS_NODE" "$env:ORKAS_PC_DIR/bin/run-skill.cjs" ${quotedRef}`
    : `"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" ${quotedRef}`;
  const attributeRef = ref.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<skill-runtime execution_ref="${attributeRef}">The host has already bound it to this Skill for the current run. Invoke a packaged script with this command template:\n`
    + `\`\`\`${windows ? 'powershell' : 'sh'}\n${command} <script-basename> -- <args...>\n\`\`\`\n</skill-runtime>`;
}

// ── Opts + scope ─────────────────────────────────────────────────────────

export interface FileToolsOpts {
  userId: string;
  /** Maximum exact UTF-8 body size returned by one raw_text call. The normal
   * final-result boundary separately keeps direct calls out of model context
   * when the returned JSON exceeds the inline budget. */
  rawTextMaxBytes?: number;
  /** Current conversation id. Scopes file tools to this cid's attachment
   *  dir (in addition to the user's active workspace). Omitted = no
   *  attachment scope (workspace-only). */
  cid?: string;
  /** Acting agent identity — used to label sensitive-path approval prompts.
   *  Display falls back to agentId, then a generic label. Omitted for the
   *  commander / ad-hoc runs. */
  agentId?: string;
  agentName?: string;
  /** Extra absolute directory roots to allow on top of workspace + attachment.
   *  Read AND write are permitted under these roots — used by per-skill edit
   *  chats to expose the skill dir for the `<<<skill-file>>>` tooling. */
  extraRoots?: readonly string[];
  /** Read-only extra roots: path-taking file tools (read_files)
   *  can see these, but write-side tools (edit_file / write_file
   *  / bash / create_pdf / generate_image) cannot mutate
   *  paths inside. Used by the group-chat commander to inspect agent.json /
   *  built-in agents / skill specs without giving direct-write access — the
   *  `<agent>` / `<skill>` containers are the only sanctioned mutation
   *  channels for those resources, and a sandbox-level lock keeps the LLM
   *  honest even when its prompt strays. */
  readOnlyExtraRoots?: readonly string[];
  /** Mutable read-only roots granted after runner construction by a trusted
   * rich-message resolver. Never populated from raw model/renderer paths. */
  runtimeReadOnlyRoots?: readonly string[];
  /** Run-scoped logical Skill paths collected from the exact prompt render.
   * Values are host-created only; the model can reference them as
   * `@skill/<ref>` or `@skill/<ref>/<relative-path>`. */
  skillRuntimeBindings?: ReadonlyMap<string, SkillRuntimeBinding>;
  /** Session-scoped persisted tool-result root. It is visible for path scope
   *  checks but generic read_files must never use it; retrieval is only through
   *  tool_result. */
  toolResultsRoot?: string;
  /** Project id of the current conversation, when it belongs to one.
   *  Threaded through from group_chat at runTurn so workspace resolution
   *  picks up the project-scoped selection (per CLAUDE.md projects feature).
   *  Empty / missing → default-scope workspace. */
  projectId?: string;
  /** Fires when `read_files` resolves to a SKILL.md path under one of the
   *  three skill roots (System A.custom / A.platform / B). Bus collects
   *  per turn for the `skill_invoked` signal. Pure callback — exceptions
   *  swallowed, never blocks the tool result. */
  onSkillInvoked?: (skill_id: string, system: 'A.custom' | 'A.platform' | 'B', trigger: 'read_file') => void;
}

/** Assemble the allowed-roots list for the current (uid, cid). File-tools
 *  read side: workspace + attachment + extraRoots + readOnlyExtraRoots. */
function allowedRoots(opts: FileToolsOpts): string[] {
  const roots: string[] = [];
  try {
    const ws = getWorkspacePath(opts.userId, opts.projectId);
    if (ws) roots.push(ws);
  } catch (err) { log.warn('resolve workspace failed', { user_id: maskId(opts.userId), project_id: maskId(opts.projectId), error: logErrorRef(err) }); }
  if (opts.cid) {
    try { roots.push(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
    catch (err) { log.warn('resolve attachment dir failed', { user_id: maskId(opts.userId), cid: maskId(opts.cid), error: logErrorRef(err) }); }
  }
  if (opts.extraRoots?.length) {
    for (const r of opts.extraRoots) if (r) roots.push(r);
  }
  if (opts.readOnlyExtraRoots?.length) {
    for (const r of opts.readOnlyExtraRoots) if (r) roots.push(r);
  }
  if (opts.runtimeReadOnlyRoots?.length) {
    for (const r of opts.runtimeReadOnlyRoots) if (r) roots.push(r);
  }
  if (opts.skillRuntimeBindings?.size) {
    for (const binding of opts.skillRuntimeBindings.values()) {
      if (binding.root) roots.push(binding.root);
    }
  }
  // A binding is normally indexed by both display name and id, and Runner
  // also supplies its roots to the read-only lane. Collapse those aliases so
  // every path gate performs one containment check per physical root, not one
  // per logical alias.
  const seen = new Set<string>();
  return roots.filter((root) => {
    const key = path.resolve(root);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolveAbs(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.workingDir ?? '.', p);
}

type RequestedPathResolution =
  | { abs: string; displayPath: string; skillRef?: string; error?: never }
  | { abs?: never; displayPath?: never; skillRef?: never; error: string };

/** Resolve the virtual Skill namespace before the ordinary cwd resolver. The
 * final containment check is the same symlink-safe guard used by all file
 * tools, so a reference file cannot escape its bound Skill root. */
function resolveRequestedPath(
  opts: FileToolsOpts,
  ctx: ToolContext,
  requestedPath: string,
  behavior: { bareSkillRefTarget?: 'entry' | 'root' } = {},
): RequestedPathResolution {
  if (!requestedPath.startsWith('@skill/')) {
    return { abs: resolveAbs(ctx, requestedPath), displayPath: requestedPath };
  }
  if (requestedPath.includes('\0') || requestedPath.includes('\\')) {
    return { error: errText('E_SKILL_REF_INVALID', 'Skill references must use forward slashes and cannot contain NUL bytes.') };
  }

  const tail = requestedPath.slice('@skill/'.length);
  const slash = tail.indexOf('/');
  const ref = (slash >= 0 ? tail.slice(0, slash) : tail).trim();
  const relative = slash >= 0 ? tail.slice(slash + 1) : '';
  if (!ref || ref === '.' || ref === '..') {
    return { error: errText('E_SKILL_REF_INVALID', 'Use @skill/<read-ref> with the exact read ref advertised in Available skills.') };
  }
  const binding = opts.skillRuntimeBindings?.get(ref);
  if (!binding) {
    return {
      error: errText(
        'E_SKILL_NOT_AVAILABLE',
        `@skill/${ref} is not bound for this run. Use an exact read ref from the current Available skills block.`,
      ),
    };
  }

  const segments = relative ? relative.split('/') : [];
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return { error: errText('E_SKILL_REF_INVALID', 'Skill-relative paths cannot contain empty, ".", or ".." segments.') };
  }
  const bareTarget = behavior.bareSkillRefTarget === 'root' ? binding.root : binding.entry;
  const abs = relative ? path.resolve(binding.root, ...segments) : path.resolve(bareTarget);
  if (!isPathAllowed(abs, [binding.root])) {
    return {
      error: errText(
        'E_SKILL_PATH_OUT_OF_SCOPE',
        `the requested Skill file resolves outside @skill/${ref}; use only files inside that Skill.`,
      ),
    };
  }
  return { abs, displayPath: requestedPath, skillRef: ref };
}

/** Keep a run-scoped Skill address logical in every model-visible result.
 * Internal scope checks and extraction still use the canonical filesystem
 * path; only the returned address is rewritten. */
function displayDescendantPath(abs: string, rootAbs: string, rootDisplayPath: string): string {
  if (!rootDisplayPath.startsWith('@skill/')) return abs;
  const relative = path.relative(rootAbs, abs);
  if (!relative) return rootDisplayPath;
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return rootDisplayPath;
  return `${rootDisplayPath.replace(/\/$/, '')}/${relative.split(path.sep).join('/')}`;
}

function displayErrorMessage(err: unknown, abs: string, displayPath: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return abs === displayPath ? message : message.split(abs).join(displayPath);
}

/** True when a successfully-read path is part of the portable skill
 * instruction surface: the skill body itself, or any document below its
 * `references/` tree. This is deliberately structural rather than tied to
 * Orkas source attribution — system, custom, marketplace, agent-owned,
 * package, and global skills all use the same on-disk protocol.
 *
 * Access control has already admitted the path before this classification is
 * used, so recognizing a document never widens the model's readable scope. */
export function isPortableSkillDocumentPath(absPath: string): boolean {
  if (!absPath) return false;
  const abs = path.resolve(absPath);
  if (path.basename(abs) === 'SKILL.md') return true;

  let cursor = path.dirname(abs);
  while (true) {
    if (path.basename(cursor) === 'references') {
      const skillBody = path.join(path.dirname(cursor), 'SKILL.md');
      try {
        if (fs.statSync(skillBody).isFile()) return true;
      } catch { /* this references/ directory does not belong to a skill */ }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
}

/** Prefix each line with its 1-based absolute line number + tab (compact
 *  `cat -n` style; no padding, to keep it token-cheap). `startLine` is the
 *  number of the slice's first line, so a mid-file slice still shows true line
 *  numbers. The `<n>\t` prefix is a DISPLAY annotation — NOT part of the file —
 *  so `edit_file` old_string must omit it. Returns the numbered text plus the
 *  last line number shown (for the `lines="a-b"` header). */
function addLineNumbers(text: string, startLine: number): { text: string; lastLine: number } {
  if (text === '') return { text: '', lastLine: startLine };
  const endsWithNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsWithNewline) lines.pop(); // drop the '' that trails a final newline
  const numbered = lines.map((line, i) => `${startLine + i}\t${line}`).join('\n');
  const lastLine = startLine + lines.length - 1;
  return { text: endsWithNewline ? `${numbered}\n` : numbered, lastLine };
}

function errText(code: string, msg: string): string {
  return `${code}: ${msg}`;
}

function fileReadBatchObservation(
  items: readonly { ok: boolean; error?: string }[],
): NonNullable<ToolObservations['fileReadBatch']> {
  const failures = items.flatMap((item, index) => {
    if (item.ok) return [];
    const code = /^([A-Z][A-Z0-9_]{1,63}):/.exec(String(item.error || '').trim())?.[1]
      || 'E_READ_FAILED';
    return [{ index, code }];
  });
  return {
    attempted: items.length,
    succeeded: items.length - failures.length,
    failed: failures.length,
    failures,
  };
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

function guardPath(opts: FileToolsOpts, abs: string): string | null {
  const roots = allowedRoots(opts);
  if (roots.length && isPathAllowed(abs, roots)) return null;
  if (!localAccessAllowsOutsideWorkspace()) {
    return errText(
      'E_PATH_OUT_OF_SCOPE',
      `path is outside the current workspace/attachment scope and the current access mode only allows workspace files: ${abs}.`,
    );
  }
  return null;
}

async function gateSensitivePathAccess(
  opts: FileToolsOpts,
  abs: string,
  operation: string,
  ctx?: ToolContext,
): Promise<string | null> {
  if (!localAccessRequiresSensitiveApproval()) return null;
  const reasons = sensitivePathReasons(abs, 'read', { trustedRoots: allowedRoots(opts) });
  if (!reasons.length) return null;
  const decision = await requestBashDecision({
    uid: opts.userId,
    cid: opts.cid ?? '',
    agentId: opts.agentId ?? '',
    agentName: opts.agentName ?? opts.agentId ?? '',
    command: '',
    operation,
    subject: abs,
    reasons,
    onWaiting: permissionWaitProgress(ctx, operation),
  });
  if (decision !== 'deny') return null;
  return errText(
    'E_SENSITIVE_PATH_DENIED',
    `the user declined to allow ${operation} on a sensitive path: ${abs}. Do not retry or work around it.`,
  );
}

/** Scope check for path-taking read tools. Folder grants were removed:
 * workspace-vs-all-files access is controlled by the global three-mode
 * setting, and sensitive paths use the standard approval prompt. */
async function gatePathAccess(
  opts: FileToolsOpts,
  abs: string,
  operation: string,
  ctx?: ToolContext,
): Promise<string | null> {
  const denied = guardPath(opts, abs);
  if (denied) return denied;
  return gateSensitivePathAccess(opts, abs, operation, ctx);
}

function disabledSkillIdForPath(opts: FileToolsOpts, abs: string): string | null {
  const uid = opts.userId;
  if (!uid) return null;
  const roots = [userSkillsDir(uid), userMarketplaceSkillsDir(uid)];
  try { roots.push(...openSkillReadRoots(uid)); }
  catch { /* unavailable OPEN registry roots cannot be admitted for reading */ }
  for (const root of roots) {
    const rel = path.relative(path.resolve(root), path.resolve(abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const skillId = rel.split(path.sep)[0];
    if (skillId && !isSkillEnabled(uid, skillId)) return skillId;
  }
  return null;
}

function guardDisabledSkillAccess(opts: FileToolsOpts, abs: string): string | null {
  const skillId = disabledSkillIdForPath(opts, abs);
  if (!skillId) return null;
  return errText(
    'E_SKILL_DISABLED',
    `skill "${skillId}" is disabled for this user; re-enable it before reading or running its workflow.`,
  );
}

/** Build the host-owned reader for run_program(path). It intentionally reuses
 * the exact file-tool scope, sensitive-path, disabled-Skill, and persisted
 * result guards instead of letting the isolated runtime read the filesystem. */
export function createProgramSourceLoader(opts: FileToolsOpts): ProgramSourceLoader {
  return async (requestedPath, ctx, maxSourceChars) => {
    const resolved = resolveRequestedPath(opts, ctx, requestedPath);
    if (resolved.error) {
      return { status: 'denied', code: 'E_PROGRAM_SOURCE_PATH', reason: resolved.error };
    }
    const { abs, displayPath } = resolved;
    const scopeError = await gatePathAccess(opts, abs, `execute JavaScript source ${displayPath}`, ctx);
    if (scopeError) {
      return { status: 'denied', code: 'E_PROGRAM_SOURCE_DENIED', reason: scopeError };
    }
    const disabledSkillError = guardDisabledSkillAccess(opts, abs);
    if (disabledSkillError) {
      return { status: 'denied', code: 'E_PROGRAM_SOURCE_DENIED', reason: disabledSkillError };
    }
    if (opts.toolResultsRoot && isInsideRoot(opts.toolResultsRoot, abs)) {
      return {
        status: 'denied',
        code: 'E_PROGRAM_SOURCE_DENIED',
        reason: errText(
          'E_TOOL_RESULT_REF_REQUIRED',
          'Persisted tool results cannot be executed by path.',
        ),
      };
    }

    try {
      const stat = await fs.promises.stat(abs);
      if (!stat.isFile()) {
        return {
          status: 'denied',
          code: 'E_PROGRAM_SOURCE_NOT_FILE',
          reason: `${displayPath} is not a regular file.`,
        };
      }
      // UTF-8 can occupy at most four bytes per code point. Reject before a
      // read when the file cannot possibly fit, then enforce the exact JS
      // character limit after decoding.
      if (stat.size > maxSourceChars * 4) {
        return {
          status: 'denied',
          code: 'E_PROGRAM_SOURCE_LIMIT',
          reason: `Program source exceeds the ${maxSourceChars}-character limit.`,
        };
      }
      const bytes = await fs.promises.readFile(abs);
      let source: string;
      try {
        // Keep a UTF-8 BOM as U+FEFF so re-encoding the evaluated source has
        // the exact same bytes and the execution hash can match the artifact.
        source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return {
          status: 'denied',
          code: 'E_PROGRAM_SOURCE_ENCODING',
          reason: `${displayPath} must contain valid UTF-8 JavaScript source.`,
        };
      }
      if (source.length > maxSourceChars) {
        return {
          status: 'denied',
          code: 'E_PROGRAM_SOURCE_LIMIT',
          reason: `Program source exceeds the ${maxSourceChars}-character limit.`,
        };
      }
      const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      recordRead(ctx, abs, stat, hash);
      return { status: 'completed', source, resolvedPath: abs };
    } catch (error) {
      const osCode = (error as NodeJS.ErrnoException)?.code;
      return {
        status: 'denied',
        code: osCode === 'ENOENT' || osCode === 'ENOTDIR'
          ? 'E_PROGRAM_SOURCE_NOT_FOUND'
          : osCode === 'EACCES' || osCode === 'EPERM'
            ? 'E_PROGRAM_SOURCE_PERMISSION'
            : 'E_PROGRAM_SOURCE_READ',
        reason: `${displayPath}: ${displayErrorMessage(error, abs, displayPath)}`,
      };
    }
  };
}

function isExtractableRichKind(kind: string): boolean {
  return kind === 'pdf' || kind === 'docx' || kind === 'spreadsheet' || kind === 'presentation';
}

type ReadAddress = {
  charStart?: number;
  charEnd?: number;
  lineStart?: number;
  lineEnd?: number;
};

type ReadAddressResult =
  | { address: ReadAddress; error?: never; diagnostic?: never }
  | { address?: never; error: string; diagnostic?: FileFailureDiagnostic };

const LEGACY_READ_RANGE_KEYS = ['charStart', 'charEnd', 'lineStart', 'lineEnd'] as const;

function taggedReadRangeSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      unit: {
        type: 'string',
        enum: ['line', 'char'],
        description: 'Addressing unit: line is 1-based/inclusive; char is 0-based with an exclusive end.',
      },
      start: { type: 'integer', description: 'Start position in the selected unit.' },
      end: { type: 'integer', description: 'End position: inclusive for line, exclusive for char.' },
    },
    required: ['unit', 'start', 'end'],
  };
}

/** Parse the provider-visible tagged range while retaining old flat fields for
 * already-running conversations and non-model callers. New and legacy forms
 * cannot be combined because their precedence would otherwise be ambiguous. */
function parseReadAddress(input: Record<string, unknown>): ReadAddressResult {
  const invalid = (error: string, reason: FileFailureDiagnostic['reason'], facts: Omit<FileFailureDiagnostic, 'code' | 'reason'> = {}): ReadAddressResult => ({
    error, diagnostic: { code: 'E_BAD_INPUT', reason, stage: 'input', ...facts },
  });
  const rawRange = input.range;
  if (rawRange !== undefined) {
    if (LEGACY_READ_RANGE_KEYS.some((key) => input[key] !== undefined)) {
      return invalid('`range` cannot be combined with legacy flat range fields', 'range_conflict');
    }
    if (!rawRange || typeof rawRange !== 'object' || Array.isArray(rawRange)) {
      return invalid('`range` must be an object with unit, start, and end', 'range_shape');
    }
    const range = rawRange as Record<string, unknown>;
    const unit = range.unit;
    const start = range.start;
    const end = range.end;
    if (unit !== 'line' && unit !== 'char') {
      return invalid('`range.unit` must be "line" or "char"', 'range_unit');
    }
    const valueType = (value: unknown): FileFailureDiagnostic['start_type'] => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const rangeFacts = {
      start_present: start !== undefined, end_present: end !== undefined,
      start_type: valueType(start), end_type: valueType(end),
      start_integer: Number.isInteger(start), end_integer: Number.isInteger(end),
    };
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return invalid('`range.start` and `range.end` must be integers', 'range_integer', rangeFacts);
    }
    const numericStart = start as number;
    const numericEnd = end as number;
    const minimumStart = unit === 'line' ? 1 : 0;
    if (numericStart < minimumStart || numericEnd < numericStart) {
      return invalid((unit === 'line'
          ? '`range` line positions must satisfy 1 <= start <= end'
          : '`range` character positions must satisfy 0 <= start <= end')
          + ` (start=${numericStart}, end=${numericEnd})`,
        'range_order', { ...rangeFacts, start_in_bounds: numericStart >= minimumStart, ordered: numericEnd >= numericStart });
    }
    return unit === 'line'
      ? { address: { lineStart: numericStart, lineEnd: numericEnd } }
      : { address: { charStart: numericStart, charEnd: numericEnd } };
  }

  const hasCharRange = typeof input.charStart === 'number' || typeof input.charEnd === 'number';
  const hasLineRange = typeof input.lineStart === 'number' || typeof input.lineEnd === 'number';
  if (hasCharRange && hasLineRange) {
    return invalid('use either charStart/charEnd or lineStart/lineEnd, not both', 'range_conflict');
  }
  return {
    address: {
      ...(typeof input.charStart === 'number' ? { charStart: input.charStart } : {}),
      ...(typeof input.charEnd === 'number' ? { charEnd: input.charEnd } : {}),
      ...(typeof input.lineStart === 'number' ? { lineStart: input.lineStart } : {}),
      ...(typeof input.lineEnd === 'number' ? { lineEnd: input.lineEnd } : {}),
    },
  };
}

// ── read_files item executor ──────────────────────────────────────────────

/** Internal preparation only; page callbacks never escape read_files. */
type PreparedFileRead = ToolResult & {
  textPage?: {
    minimumTokens: number;
    render: (maxTokens: number) => ToolResult;
  };
};

function createReadFileTool(
  opts: FileToolsOpts,
  behavior: { defaultCharLimit?: number } = {},
): Omit<AgentTool, 'execute'> & {
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<PreparedFileRead>;
} {
  return {
    // Internal-only executor. The host exposes the aggregate read_files tool,
    // not this compatibility-shaped single-item implementation.
    name: 'read_files',
    executionMode: 'parallel',
    description:
      'Read one visible file or exact tagged range as part of read_files.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Path relative to the working directory, a visible absolute path, or @skill/<read-ref>[/relative-path] for a Skill advertised in this run.' },
        range: taggedReadRangeSchema(),
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const raw = String(input.path ?? '');
      if (!raw) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const resolvedPath = resolveRequestedPath(opts, ctx, raw);
      if (resolvedPath.error) return { content: resolvedPath.error, isError: true };
      const { abs, displayPath } = resolvedPath;
      const parsedAddress = parseReadAddress(input);
      if (parsedAddress.error) {
        return {
          content: errText('E_BAD_INPUT', parsedAddress.error),
          isError: true,
          observations: { fileFailure: parsedAddress.diagnostic },
        };
      }
      const { address } = parsedAddress;
      const hasLineRange = address.lineStart !== undefined || address.lineEnd !== undefined;

      const scopeErr = await gatePathAccess(opts, abs, 'read_files', ctx);
      if (scopeErr) {
        log.warn('read_files scope reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: scopeErr, isError: true };
      }
      const disabledSkillErr = guardDisabledSkillAccess(opts, abs);
      if (disabledSkillErr) {
        log.warn('read_files disabled skill reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: disabledSkillErr, isError: true };
      }
      if (opts.toolResultsRoot && isInsideRoot(opts.toolResultsRoot, abs)) {
        return {
          content: errText(
            'E_TOOL_RESULT_REF_REQUIRED',
            'Persisted tool results cannot be read by path. Use the ref from <persisted-output> with tool_result action="search" or action="read".',
          ),
          isError: true,
        };
      }

      let sourceStat: fs.Stats;
      try { sourceStat = fs.statSync(abs); }
      catch (err) {
        const osCode = typeof (err as NodeJS.ErrnoException)?.code === 'string'
          ? (err as NodeJS.ErrnoException).code!
          : '';
        const detail = `${displayPath}: ${displayErrorMessage(err, abs, displayPath)}`;
        if (osCode === 'ENOENT' || osCode === 'ENOTDIR') {
          const siblings = osCode === 'ENOENT' ? findUniquifySiblings(abs) : [];
          log.warn('read_files not found', {
            user_id: maskId(opts.userId),
            path: logPathRef(abs),
            os_code: osCode,
            sibling_count: siblings.length,
            error: logErrorRef(err),
          });
          let content = errText('E_NOT_FOUND', detail);
          content +=
            '\n\n<missing-file-recovery>\n'
            + 'Do not infer this file\'s contents. If the user supplied this exact path, ask for the correct accessible path or an attachment. '
            + 'If you inferred the path, use search_files to locate the source before asking the user.\n'
            + '</missing-file-recovery>';
          if (siblings.length) {
            content +=
              '\n\n<file-renamed-earlier>\n'
              + 'This name was uniquified earlier in this conversation. Existing variants in the same directory:\n'
              + siblings.map((b) => `  - ${b}`).join('\n')
              + '\nUse one of those paths instead — the original requested name was never written.\n'
              + '</file-renamed-earlier>';
          }
          return { content, isError: true };
        }
        if (osCode === 'EACCES' || osCode === 'EPERM') {
          log.warn('read_files permission denied', {
            user_id: maskId(opts.userId),
            path: logPathRef(abs),
            os_code: osCode,
            error: logErrorRef(err),
          });
          return {
            content: errText(
              'E_PERMISSION_DENIED',
              `${detail}\nos_code=${osCode}\nThe operating system denied access. Do not retry automatically or treat the file as missing; ask the user to grant access or choose an accessible file.`,
            ),
            isError: true,
          };
        }
        log.warn('read_files stat failed', {
          user_id: maskId(opts.userId),
          path: logPathRef(abs),
          ...(osCode ? { os_code: osCode } : {}),
          error: logErrorRef(err),
        });
        return {
          content: errText('E_READ_FAILED', `${detail}${osCode ? `\nos_code=${osCode}` : ''}`),
          isError: true,
        };
      }

      const kind = kindOf(abs);
      const portableSkillDocument = isPortableSkillDocumentPath(abs);
      try {
        if (input.rawText === true) {
          if (kind !== 'text') {
            return {
              content: errText(
                'E_RAW_TEXT_UNSUPPORTED',
                `${displayPath}: raw_text supports UTF-8 text files only; use ordinary read_files for kind=${kind}.`,
              ),
              isError: true,
            };
          }
          const maxBytes = Math.max(1, Math.trunc(
            opts.rawTextMaxBytes ?? 8 * 1024 * 1024,
          ));
          if (sourceStat.size > maxBytes) {
            return {
              content: errText(
                'E_RAW_TEXT_LIMIT',
                `${displayPath}: ${sourceStat.size} bytes exceeds the ${maxBytes}-byte raw_text limit. Read bounded ranges instead.`,
              ),
              isError: true,
            };
          }
          const bytes = await fs.promises.readFile(abs);
          let content: string;
          try {
            content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
          } catch {
            return {
              content: errText(
                'E_RAW_TEXT_ENCODING',
                `${displayPath}: raw_text requires valid UTF-8.`,
              ),
              isError: true,
            };
          }
          const sourceHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
          recordRead(ctx, abs, undefined, sourceHash);
          return {
            content: JSON.stringify({
              path: displayPath,
              content,
              total_chars: content.length,
              file_hash: sourceHash,
            }),
            observations: {
              fileReads: [{
                path: abs,
                hash: sourceHash,
                charRange: [0, content.length],
                lineRange: [1, content.split('\n').length],
              }],
            },
          };
        }

        if (input.metadataOnly === true) {
          const meta = kind === 'image'
            ? null
            : kind === 'text'
              ? await statFile(opts.userId, abs)
              : await withReadFilesExtractionSlot(() => statFile(opts.userId, abs));
          const attrs = [
            `path="${displayPath}"`,
            `kind="${kind}"`,
            `bytes="${sourceStat.size}"`,
            ...(meta?.totalChars !== undefined ? [`total_chars="${meta.totalChars}"`] : []),
            ...(meta?.extractionEmpty ? ['extraction="empty_pages"'] : []),
          ];
          log.info('read_files metadata loaded', {
            user_id: maskId(opts.userId),
            path: logPathRef(abs),
            kind,
            bytes: sourceStat.size,
            total_chars: meta?.totalChars,
            extraction_empty: !!meta?.extractionEmpty,
          });
          return { content: `<file ${attrs.join(' ')}/>` };
        }

        if (kind === 'image') {
          const img = await readImageAsJpeg(opts.userId, abs);
          const header = `<file path="${displayPath}" kind="image" bytes="${img.bytes}" compressed="${img.width}x${img.height} color JPEG q=70"/>`;
          log.info('read_files image loaded', {
            user_id: maskId(opts.userId),
            path: logPathRef(abs),
            kind: 'image',
            bytes: img.bytes,
          });
          return {
            content: `${header}\nImage loaded — the compressed color JPEG follows as a user-turn image.`,
            images: [{ data: img.base64, mediaType: img.mediaType }],
          };
        }

        const appliesDefaultCharLimit = !hasLineRange
          && address.charStart === undefined
          && address.charEnd === undefined
          && behavior.defaultCharLimit !== undefined
          && !portableSkillDocument;
        // A first rich-document read prepares the extraction cache in this
        // same tool call. This removes the model-visible stat/read handshake
        // while retaining file_indexer's cache and extraction implementation.
        if (kind !== 'text') {
          await withReadFilesExtractionSlot(() => statFile(opts.userId, abs));
        }
        const result = await readRange(opts.userId, abs, {
          // The shared estimator charges at least one token per four UTF-16
          // units. No larger body can fit, even before headers and preludes.
          maxContentChars: readFilesInlineTokenBudget(ctx, portableSkillDocument) * 4,
          ...(hasLineRange
            ? {
              ...(address.lineStart !== undefined ? { lineStart: address.lineStart } : {}),
              ...(address.lineEnd !== undefined ? { lineEnd: address.lineEnd } : {}),
            }
            : {
              ...(address.charStart !== undefined ? { charStart: address.charStart } : {}),
              ...(address.charEnd !== undefined
                ? { charEnd: address.charEnd }
                : appliesDefaultCharLimit
                  ? { charEnd: behavior.defaultCharLimit }
                  : {}),
            }),
        });

        // Capture the requested/default page after EOF clamping but before
        // budget clipping. File pagination alone cannot describe completeness
        // of an explicitly selected range (including a single long line).
        const requestedPageEnd = result.requestedCharEnd ?? result.range.charEnd;
        const total = result.meta.totalChars ?? 0;
        const cs = result.range.charStart;
        const revision = kind === 'text' && result.sourceHash
          ? issueFileRevision(ctx, abs, sourceStat.size, result.sourceHash)
          : '';
        const runtimeBinding = resolvedPath.skillRef
          ? opts.skillRuntimeBindings?.get(resolvedPath.skillRef)
          : undefined;
        const isRuntimeSkillEntry = !!runtimeBinding
          && path.resolve(abs) === path.resolve(runtimeBinding.entry);
        const entryReadPrelude = isRuntimeSkillEntry
          ? String(runtimeBinding.entryReadPrelude || '').trim()
          : '';
        const runtimeRequirementsPrelude = isRuntimeSkillEntry
          && runtimeBinding.source !== 'system'
          ? SKILL_RUNTIME_REQUIREMENTS_READ_PRELUDE
          : '';
        const executionReadPrelude = isRuntimeSkillEntry
          && resolvedPath.skillRef
          && (() => {
            try { return fs.statSync(path.join(runtimeBinding!.root, 'scripts')).isDirectory(); }
            catch { return false; }
          })()
          ? renderSkillExecutionReadPrelude(resolvedPath.skillRef)
          : '';
        const entryPrelude = [
          entryReadPrelude,
          runtimeRequirementsPrelude,
          executionReadPrelude,
        ].filter(Boolean).join('\n\n');
        const renderPage = (body: string, includePrelude = true) => {
          const ce = cs + body.length;
          // Resume a clipped Skill request within the same requested range;
          // its next result will be bounded by the then-current allowance.
          const nextEnd = portableSkillDocument && ce < requestedPageEnd
            ? requestedPageEnd : Math.min(total, ce + READ_FILES_DEFAULT_SLICE_CHARS);
          // Number the lines for display (the model thinks in lines for code);
          // char offsets remain the addressing/paging unit.
          const { text: numberedContent, lastLine } = addLineNumbers(body, result.startLine);
          const attrs = [
            `path="${displayPath}"`,
            `kind="${kind}"`,
            `total_chars="${total}"`,
            `covered="${cs}-${ce}"`,
            `lines="${result.startLine}-${lastLine}"`,
            `request_complete="${ce === requestedPageEnd}"`,
            ...(ce < requestedPageEnd
              ? [`remaining_request_range="char:${ce}-${requestedPageEnd}"`]
              : []),
            ...(ce < total ? [
              'has_more="true"',
              `next_range="char:${ce}-${nextEnd}"`,
            ] : ['has_more="false"']),
            ...(result.sourceHash ? [`file_hash="${result.sourceHash}"`] : []),
            ...(revision ? [`revision="${revision}"`] : []),
            ...(result.meta.extractionEmpty ? ['extraction="empty_pages"'] : []),
          ];
          const header = `<file ${attrs.join(' ')}>`;
          const fileBlock = `${header}\n${numberedContent}\n</file>`;
          return {
            content: includePrelude && entryPrelude ? `${entryPrelude}\n\n${fileBlock}` : fileBlock,
            lastLine,
          };
        };
        const completePage = renderPage(result.content);
        const documentFlag = portableSkillDocument ? { verbatimDocument: true } : {};
        // An unread receipt carries a continuation but neither entry instructions
        // nor read/OCC evidence. Reserve it before allocating body space.
        const minimum: ToolResult = {
          content: renderPage('', false).content,
          ...documentFlag,
        };
        const completeTokens = estimateToolResultTokens(completePage.content);
        const receiptTokens = estimateToolResultTokens(minimum.content);
        const finishPage = (body: string, page: ReturnType<typeof renderPage>): ToolResult => {
          const ce = cs + body.length;
          const { lastLine } = page;
          log.info('read_files loaded', {
            user_id: maskId(opts.userId),
            path: logPathRef(abs),
            kind,
            covered_start: cs,
            covered_end: ce,
            total_chars: total,
            start_line: result.startLine,
            end_line: lastLine,
          });
          // skill_invoked attribution: when the LLM reads a SKILL.md body through
          // read_files, the body is the progressive-disclosure "use this skill"
          // signal (per Claude Code conventions). Emit AFTER the successful
          // text read — image / rich-document SKILL.md is not a real shape.
          if (opts.onSkillInvoked) {
            const runtimeParsed = isRuntimeSkillEntry
              ? {
                skill_id: runtimeBinding!.id,
                system: runtimeBinding.source === 'custom'
                  ? 'A.custom' as const
                  : runtimeBinding.source === 'builtin' || runtimeBinding.source === 'platform'
                    ? 'A.platform' as const
                    : 'B' as const,
              }
              : null;
            const parsed = runtimeParsed || parseSkillPath(abs, opts.userId);
            if (parsed) {
              try { opts.onSkillInvoked(parsed.skill_id, parsed.system, 'read_file'); }
              catch (err) { log.warn('onSkillInvoked callback failed', { error: logErrorRef(err) }); }
            }
          }
          // Stamp the read-state baseline so a later edit_file accepts an edit
          // built on these bytes (read-before-edit) and rejects it if the file
          // changed since (OCC). See read-tracker.ts.
          recordRead(ctx, abs, undefined, result.sourceHash);
          return {
            content: page.content,
            // Skill pages retain the shared policy's wider inline ceiling.
            ...documentFlag,
            observations: {
              fileReads: [{
                path: abs,
                ...(result.sourceHash ? { hash: result.sourceHash } : {}),
                charRange: [cs, ce],
                lineRange: [result.startLine, lastLine],
              }],
            },
          };
        };
        return {
          content: completePage.content,
          ...documentFlag,
          textPage: {
            minimumTokens: Math.min(completeTokens, receiptTokens),
            render: (maxTokens) => {
              if (completeTokens <= maxTokens) {
                return finishPage(result.content, completePage);
              }
              // Search only a budget-bounded prefix of the already-read text.
              let low = 0;
              let high = Math.min(result.content.length, Math.max(0, Math.floor(maxTokens * 4)));
              while (low < high) {
                const mid = Math.ceil((low + high) / 2);
                if (estimateToolResultTokens(renderPage(result.content.slice(0, mid)).content) <= maxTokens) low = mid;
                else high = mid - 1;
              }
              if (low > 0 && low < result.content.length
                && result.content.charCodeAt(low - 1) >= 0xD800 && result.content.charCodeAt(low - 1) <= 0xDBFF
                && result.content.charCodeAt(low) >= 0xDC00 && result.content.charCodeAt(low) <= 0xDFFF) low--;
              if (low === 0) {
                if (receiptTokens <= maxTokens) return minimum;
                return {
                  content: errText('E_READ_BUDGET', 'Insufficient inline space for a file receipt. Retry in a later call or read fewer files.'),
                  isError: true,
                };
              }
              const body = result.content.slice(0, low);
              return finishPage(body, renderPage(body));
            },
          },
        };
      } catch (err) {
        if (err instanceof NoTextError) {
          log.warn('read_files no text', { user_id: maskId(opts.userId), path: logPathRef(abs) });
          return { content: errText('E_NO_TEXT', `${displayPath}: ${err.kind} has no text representation`), isError: true };
        }
        if (err instanceof UnsupportedFileKindError) {
          log.warn('read_files unsupported kind', { user_id: maskId(opts.userId), path: logPathRef(abs), kind: err.kind });
          return {
            content: errText(
              'E_UNSUPPORTED_FILE',
              `${displayPath}: ${err.kind} cannot be read by the model. Convert it to .docx/.xlsx/.pptx and attach again.`,
            ),
            isError: true,
          };
        }
        const msg = displayErrorMessage(err, abs, displayPath);
        log.warn('read_files failed', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
        return { content: errText('E_READ_FAILED', msg), isError: true };
      }
    },
  };
}

const READ_FILES_MAX_ITEMS = 12;
const READ_FILES_DEFAULT_SLICE_CHARS = 24_000;
const READ_FILES_EXTRACT_CONCURRENCY = 2;
let readFilesActiveExtractions = 0;
const readFilesExtractionWaiters: Array<() => void> = [];

async function withReadFilesExtractionSlot<T>(work: () => Promise<T>): Promise<T> {
  if (readFilesActiveExtractions >= READ_FILES_EXTRACT_CONCURRENCY) {
    await new Promise<void>((resolve) => readFilesExtractionWaiters.push(resolve));
  } else {
    readFilesActiveExtractions++;
  }
  try {
    return await work();
  } finally {
    const next = readFilesExtractionWaiters.shift();
    if (next) next();
    else readFilesActiveExtractions--;
  }
}

function readFilesInlineTokenBudget(ctx: ToolContext, verbatimDocument = false): number {
  const value = ctx.state?.[TOOL_RESULT_INLINE_LEDGER_STATE_KEY];
  const ledger = value && typeof value === 'object'
    ? value as Partial<ToolResultInlineLedger>
    : undefined;
  const skillLimit = ledger?.verbatimDocumentTokens;
  const candidates = [verbatimDocument && Number.isFinite(skillLimit) && skillLimit! > 0
    ? skillLimit! : DEFAULT_INLINE_RESULT_TOKENS];
  if (!verbatimDocument && Number.isFinite(ledger?.perResultTokens)) {
    candidates.push(Math.max(0, ledger!.perResultTokens!));
  }
  if (Number.isFinite(ledger?.remainingTokens)) {
    candidates.push(Math.max(0, ledger!.remainingTokens!));
  }
  return Math.max(0, Math.floor(Math.min(...candidates)));
}

/** Unified one-or-many reader. It deliberately delegates every item to the
 * same internal reader so scope checks, rich-file handling,
 * line-number rendering, skill attribution, and OCC stamps stay identical. */
function createReadFilesTool(opts: FileToolsOpts): AgentTool {
  // Ordinary batch reads default to a bounded slice. Portable skill documents
  // use their wider shared allowance. The delegated reader classifies them
  // after the access gate and reports explicit ranges when pagination is needed.
  const readFile = createReadFileTool(opts, { defaultCharLimit: READ_FILES_DEFAULT_SLICE_CHARS });
  return {
    name: 'read_files',
    executionMode: 'parallel',
    description:
      'Read one or more visible files; use ranges to inspect structure or samples. PDF and Office files are prepared automatically. For text pages, request_complete means the requested/default page reached its end (clamped to EOF); remaining_request_range identifies budget-clipped content. has_more/next_range describe file pagination, not missing requested content. Use metadata_only for metadata; use raw_text when complete original text is needed.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        paths: {
          type: 'array',
          minItems: 1,
          maxItems: READ_FILES_MAX_ITEMS,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: 'Path relative to the working directory, a visible absolute path, or @skill/<read-ref>[/relative-path] for a Skill advertised in this run.' },
              range: taggedReadRangeSchema(),
            },
            required: ['path'],
          },
        },
        metadata_only: {
          type: 'boolean',
          description: 'Prepare document extraction and return metadata for every path without file or image bodies.',
        },
        raw_text: {
          type: 'boolean',
          description: 'Return complete UTF-8 text as JSON {files:[{requested_path,ok,path,content,total_chars,file_hash}|{requested_path,ok:false,error}]}. Cannot combine with ranges/metadata_only. Large direct results may be persisted.',
        },
      },
      required: ['paths'],
    },
    async execute(input, ctx) {
      if (!Array.isArray(input.paths) || input.paths.length === 0) {
        return { content: errText('E_BAD_INPUT', '`paths` must be a non-empty array'), isError: true };
      }
      if (input.paths.length > READ_FILES_MAX_ITEMS) {
        return {
          content: errText('E_BAD_INPUT', `read_files accepts at most ${READ_FILES_MAX_ITEMS} files per call`),
          isError: true,
        };
      }
      const requests = input.paths.map((entry) => (
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? entry as Record<string, unknown>
          : {}
      ));
      const rawText = input.raw_text === true;
      if (rawText && input.metadata_only === true) {
        return {
          content: errText(
            'E_BAD_INPUT',
            'read_files raw_text cannot be combined with metadata_only.',
          ),
          isError: true,
        };
      }
      // Validation failures use the same ordered per-item results as missing
      // or unreadable files. Invalid items never reach the scoped reader.
      const itemErrors: Array<ToolResult | undefined> = [];
      const normalized = requests.map((request, index) => {
        const invalid = (message: string, diagnostic?: FileFailureDiagnostic) => {
          itemErrors[index] = {
            content: errText('E_BAD_INPUT', `read_files item ${index + 1}: ${message}`),
            isError: true,
            ...(diagnostic ? { observations: { fileFailure: { ...diagnostic, item_index: index } } } : {}),
          };
          return { path: typeof request.path === 'string' ? request.path : '' };
        };
        if (typeof request.path !== 'string' || !request.path) {
          return invalid('`path` must be a non-empty string');
        }
        if (rawText && request.range !== undefined) {
          return invalid('raw_text cannot be combined with ranges');
        }
        const parsed = parseReadAddress(request);
        if (parsed.error) return invalid(parsed.error, parsed.diagnostic);
        const address = parsed.address!;
        const hasLineRange = address.lineStart !== undefined || address.lineEnd !== undefined;
        if (hasLineRange) {
          const lineStart = address.lineStart !== undefined && Number.isFinite(address.lineStart)
            ? Math.max(1, Math.trunc(address.lineStart))
            : 1;
          const lineEnd = address.lineEnd !== undefined && Number.isFinite(address.lineEnd)
            ? Math.max(lineStart, Math.trunc(address.lineEnd))
            : lineStart + 399;
          return { path: request.path, lineStart, lineEnd };
        }
        const hasCharacterRange = address.charStart !== undefined || address.charEnd !== undefined;
        if (!hasCharacterRange) return { path: request.path };
        const start = address.charStart !== undefined && Number.isFinite(address.charStart)
          ? Math.max(0, Math.trunc(address.charStart))
          : 0;
        const explicitEnd = address.charEnd !== undefined && Number.isFinite(address.charEnd)
          ? Math.max(start, Math.trunc(address.charEnd))
          : undefined;
        return {
          path: request.path,
          charStart: start,
          charEnd: explicitEnd ?? start + READ_FILES_DEFAULT_SLICE_CHARS,
        };
      });
      const inputFailure = itemErrors.find((result) => result?.observations?.fileFailure)?.observations?.fileFailure;
      if (rawText) {
        // Input-only refusals contain no source payload. Keep their actionable
        // diagnostics, as before, even when the raw source quota is tiny; the
        // ordinary result transformer still bounds their model-context size.
        const validationOnly = normalized.every((_, index) => !!itemErrors[index]);
        const results = [];
        let resultBytes = 0;
        const maxBytes = Math.max(1, Math.trunc(
          opts.rawTextMaxBytes ?? 8 * 1024 * 1024,
        ));
        for (const [index, request] of normalized.entries()) {
          const result = itemErrors[index] ?? await readFile.execute({
            ...request,
            rawText: true,
          }, ctx);
          resultBytes += Buffer.byteLength(result.content, 'utf8');
          if (!validationOnly && resultBytes > maxBytes) {
            return {
              content: errText(
                'E_RAW_TEXT_LIMIT',
                `read_files raw_text result exceeds the ${maxBytes}-byte limit. Split the paths across calls.`,
              ),
              isError: true,
            };
          }
          results.push(result);
        }
        const files = results.map((result, index) => {
          const requestedPath = String(normalized[index].path);
          if (result.isError) {
            return { requested_path: requestedPath, ok: false, error: result.content };
          }
          try {
            return {
              requested_path: requestedPath,
              ok: true,
              ...JSON.parse(result.content) as Record<string, unknown>,
            };
          } catch {
            return {
              requested_path: requestedPath,
              ok: false,
              error: errText('E_READ_FAILED', 'raw_text produced an invalid internal response.'),
            };
          }
        });
        const errors = files.filter((file) => file.ok === false).length;
        const content = JSON.stringify({ files });
        if (!validationOnly && Buffer.byteLength(content, 'utf8') > maxBytes) {
          return {
            content: errText(
              'E_RAW_TEXT_LIMIT',
              `read_files raw_text result exceeds the ${maxBytes}-byte limit. Split the paths across calls.`,
            ),
            isError: true,
          };
        }
        return {
          content,
          ...(errors === files.length ? { isError: true } : {}),
          observations: {
            ...(inputFailure ? { fileFailure: inputFailure } : {}),
            fileReads: results.flatMap((result) => result.observations?.fileReads ?? []),
            fileReadBatch: fileReadBatchObservation(files.map((file) => (
              file.ok === false
                ? { ok: false, error: String(file.error || '') }
                : { ok: true }
            ))),
          },
        };
      }
      // Prepare authorized reads concurrently; allocate their formatted bodies
      // in request order only after the actual sizes and document kinds are known.
      const prepared: PreparedFileRead[] = await Promise.all(normalized.map((request, index) => (
        itemErrors[index] ?? readFile.execute({
          ...request,
          metadataOnly: input.metadata_only === true,
        }, ctx)
      )));
      const hasSkill = prepared.some(result => !result.isError && result.verbatimDocument);
      const inlineBudget = readFilesInlineTokenBudget(ctx, hasSkill);
      const emptyEnvelope =
        `<read-files count="${normalized.length}" errors="0" metadata_only="${input.metadata_only === true}">\n`
        + normalized.map((request, index) => (
          `<read-result index="${index}" ok="true">\nrequested_path=${String(request.path)}\n\n</read-result>`
        )).join('\n')
        + '\n</read-files>';
      const envelopeTokens = estimateToolResultTokens(emptyEnvelope) + 64;
      const minimumTokens = prepared.map(result => (
        result.textPage?.minimumTokens ?? estimateToolResultTokens(result.content)
      ));
      let reservedTokens = minimumTokens.reduce((sum, tokens) => sum + tokens, 0);
      let remainingTokens = Math.max(0, inlineBudget - envelopeTokens);
      const ordinaryBudget = readFilesInlineTokenBudget(ctx);
      const results = prepared.map((result, index): ToolResult => {
        reservedTokens -= minimumTokens[index];
        const available = Math.min(
          result.verbatimDocument ? inlineBudget : ordinaryBudget,
          Math.max(0, remainingTokens - reservedTokens),
        );
        const admitted = result.textPage ? result.textPage.render(available) : result;
        remainingTokens = Math.max(0, remainingTokens - estimateToolResultTokens(admitted.content));
        return admitted;
      });
      const images = results.flatMap((result) => result.images || []);
      const includesVerbatimDocument = results.some((result) => !result.isError && result.verbatimDocument);
      const blocks = results.map((result, index) => {
        const prefix =
          `<read-result index="${index}" ok="${result.isError ? 'false' : 'true'}">\n`
          + `requested_path=${String(normalized[index].path)}\n`;
        const suffix = '\n</read-result>';
        return `${prefix}${result.content}${suffix}`;
      });
      const errors = results.filter((result) => result.isError).length;
      return {
        content:
          `<read-files count="${results.length}" errors="${errors}" metadata_only="${input.metadata_only === true}">\n`
          + `${blocks.join('\n')}\n</read-files>`,
        ...(images.length ? { images } : {}),
        ...(errors === results.length ? { isError: true } : {}),
        ...(includesVerbatimDocument ? { verbatimDocument: true } : {}),
        observations: {
          ...(inputFailure ? { fileFailure: inputFailure } : {}),
          fileReads: results.flatMap((result) => result.observations?.fileReads ?? []),
          fileReadBatch: fileReadBatchObservation(results.map((result) => ({
            ok: !result.isError,
            ...(result.isError ? { error: result.content } : {}),
          }))),
        },
      };
    },
  };
}

// ── search_files ─────────────────────────────────────────────────────────

function compileMatcher(query: string): (target: { abs: string; root: string }) => boolean {
  const q = query.trim();
  if (!q) return () => true;
  // Path queries use the same root-relative rules as include/exclude globs.
  // Bare queries retain their existing filename substring/glob behavior.
  if (q.includes('/')) {
    const [glob] = compileGrepGlobs(q);
    return (target) => targetMatchesGrepGlob(target, glob);
  }
  const hasGlob = /[*?[]/.test(q);
  if (hasGlob) {
    const re = new RegExp(
      '^' + q.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i',
    );
    return (target) => re.test(path.basename(target.abs));
  }
  const lower = q.toLowerCase();
  return (target) => path.basename(target.abs).toLowerCase().includes(lower);
}

type SearchIncompleteReason = 'time_budget' | 'cancelled' | 'result_limit' | 'extraction_limit' | 'io_error' | 'protected_scope';

function searchCompletion(reasons: Set<SearchIncompleteReason>): string {
  return reasons.size
    ? `complete=false reasons=${[...reasons].join(',')}. Results cover only the searched scope; narrow root or filters to continue.`
    : 'complete=true';
}

/** Privacy is checked before either backend. No backend may reopen a skipped root. */
async function visitFiles(
  root: string,
  visit: (file: string) => boolean | Promise<boolean>,
  opts: { includeIgnored?: boolean; signal: AbortSignal },
): Promise<{ backend: 'rg' | 'walk'; capped: boolean; skippedReason?: string; error?: string; interrupted?: boolean }> {
  if (opts.signal.aborted) return { backend: 'walk', capped: false, interrupted: true };
  const protectedRoot = macosTccSensitivePath(path.resolve(root), { recursive: true });
  if (protectedRoot) return { backend: 'walk', capped: false, skippedReason: protectedRoot.reason };
  try {
    if (!(await fs.promises.stat(root)).isDirectory()) return { backend: 'walk', capped: false };
  } catch (error) {
    return { backend: 'walk', capped: false,
      ...((error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : { error: 'directory could not be inspected' }) };
  }
  const native = await visitRepositoryFiles(root, visit, opts);
  if (native.backend === 'rg' || native.interrupted) return native;
  const honourIgnores = opts.includeIgnored !== true;
  let capped = false;
  let failed = false;
  let visited = 0;
  const walk = async (dir: string, inherited: readonly IgnoreScope[]): Promise<void> => {
    if (capped || opts.signal.aborted) return;
    const local = honourIgnores ? readIgnoreScope(dir) : null;
    const scopes = local ? [...inherited, local] : inherited;
    try {
      const entries = await fs.promises.opendir(dir);
      for await (const entry of entries) {
        if (capped || opts.signal.aborted) break;
        if (++visited % GREP_YIELD_EVERY === 0) await new Promise<void>(resolve => setImmediate(resolve));
        if (opts.signal.aborted) break;
        if (entry.name === '.git' || (entry.isDirectory() && fallbackDirectoryExcluded(entry.name))) continue;
        const file = path.join(dir, entry.name);
        if (honourIgnores && isIgnoredByScopes(file, entry.isDirectory(), scopes)) continue;
        if (entry.isDirectory()) await walk(file, scopes);
        else if (entry.isFile() && !fallbackFileExcluded(entry.name)) capped = await visit(file);
      }
    } catch { failed = true; }
  };
  await walk(root, []);
  return { backend: 'walk', capped,
    ...(opts.signal.aborted ? { interrupted: true } : {}),
    ...(failed && !opts.signal.aborted ? { error: 'directory scan was incomplete' } : {}) };
}

function createSearchFilesTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'search_files',
    executionMode: 'parallel',
    description:
      'Find files by substring or glob when the path is unknown. Repository scans respect ignore files and avoid dependency/build trees; exact read_files paths remain available. Returns path/name/size/mtime/source without extracting content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name substring or glob; patterns with / match root-relative paths. Omit to list everything.' },
        root: { type: 'string', description: 'Optional file or directory relative to the working directory, visible absolute path, or @skill/<read-ref>[/relative-path]; searches all visible roots when omitted.' },
        include_glob: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Optional include globs matched against root-relative paths or basenames.' },
        exclude_glob: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Optional exclude globs.' },
        include_ignored: { type: 'boolean', description: 'Include ignored files when explicitly needed; dependency/build directories remain bounded.' },
        max_results: { type: 'number', description: `Maximum results to return, 1-${MAX_SEARCH_RESULTS}.` },
      },
    },
    async execute(input, ctx) {
      const query = String(input.query ?? '');
      const matcher = compileMatcher(query);
      const roots = allowedRoots(opts);
      if (!roots.length) {
        return { content: errText('E_NO_SCOPE', 'no visible roots for this conversation'), isError: true };
      }

      const rootKinds: Array<{ root: string; source: 'attachment' | 'workspace' | 'extra' }> = [];
      try {
        rootKinds.push({ root: getWorkspacePath(opts.userId, opts.projectId), source: 'workspace' });
      } catch { /* workspace unavailable → skip */ }
      if (opts.cid) {
        rootKinds.push({ root: chatAttachmentDirForConversation(opts.userId, opts.cid), source: 'attachment' });
      }
      for (const root of [...(opts.extraRoots || []), ...(opts.readOnlyExtraRoots || [])]) {
        if (root) rootKinds.push({ root, source: 'extra' });
      }
      const requestedRootInput = typeof input.root === 'string' ? input.root.trim() : '';
      const requestedRootResolution = requestedRootInput
        ? resolveRequestedPath(opts, ctx, requestedRootInput, { bareSkillRefTarget: 'root' })
        : null;
      if (requestedRootResolution?.error) {
        return { content: requestedRootResolution.error, isError: true };
      }
      const requestedRoot = requestedRootResolution?.abs || '';
      const requestedRootDisplay = requestedRootResolution?.displayPath || requestedRoot;
      if (requestedRoot) {
        const scopeErr = await gatePathAccess(opts, requestedRoot, 'search_files', ctx);
        if (scopeErr) return { content: scopeErr, isError: true };
        let st: fs.Stats;
        try { st = fs.statSync(requestedRoot); }
        catch (err) {
          return {
            content: errText(
              'E_NOT_FOUND',
              `${requestedRootDisplay}: ${displayErrorMessage(err, requestedRoot, requestedRootDisplay)}`,
            ),
            isError: true,
          };
        }
        if (!st.isDirectory()) {
          // Widening to the parent would read siblings this call never gated,
          // so the refusal stands — but it names the two things the caller
          // actually meant, because retrying the same shape was the common
          // next move.
          return {
            content: errText(
              'E_NOT_DIRECTORY',
              `${requestedRootDisplay}: not a directory. `
              + `To find files near it, pass root="${path.dirname(requestedRootDisplay)}". `
              + 'To search inside this one file, use grep_files with the same path as root, or read_file.',
            ),
            isError: true,
          };
        }
        const source = rootKinds.find(({ root }) => isInsideRoot(root, requestedRoot))?.source ?? 'extra';
        rootKinds.splice(0, rootKinds.length, { root: requestedRoot, source });
      }
      const includeGlobs = compileGrepGlobs(input.include_glob);
      const excludeGlobs = compileGrepGlobs(input.exclude_glob);
      const includeIgnored = input.include_ignored === true;
      const maxResults = Math.max(
        1,
        Math.min(MAX_SEARCH_RESULTS, Math.trunc(Number(input.max_results) || MAX_SEARCH_RESULTS)),
      );

      const hits: SearchFileHit[] = [];
      const reasons = new Set<SearchIncompleteReason>();
      const backends = new Set<string>();
      const budget = createRepositorySearchBudget(ctx.signal);
      let total = 0;
      try {
        for (const { root, source } of rootKinds) {
          const stopReason = budget.reason();
          if (stopReason) { reasons.add(stopReason); break; }
          const scan = await visitFiles(root, async (abs) => {
            const stopReason = budget.reason();
            if (stopReason) { reasons.add(stopReason); return true; }
            const name = path.basename(abs);
            const target = { abs, root };
            if (!matcher(target)) return false;
            if (includeGlobs.length && !includeGlobs.some(glob => targetMatchesGrepGlob(target, glob))) return false;
            if (excludeGlobs.some(glob => targetMatchesGrepGlob(target, glob))) return false;
            let st: fs.Stats;
            try { st = await fs.promises.stat(abs); }
            catch { reasons.add('io_error'); return false; }
            const hit: SearchFileHit = {
              root: requestedRootResolution?.skillRef ? requestedRootDisplay : root,
              path: requestedRootResolution?.skillRef ? displayDescendantPath(abs, requestedRoot, requestedRootDisplay) : abs,
              name, size: st.size, mtime: Math.floor(st.mtimeMs), source,
            };
            total++;
            // Stable newest-first top K, without retaining all matching paths.
            let low = 0, high = hits.length;
            while (low < high) {
              const mid = (low + high) >>> 1;
              if (hits[mid].mtime >= hit.mtime) low = mid + 1;
              else high = mid;
            }
            if (low < maxResults) {
              const cached = getCachedMeta(opts.userId, abs);
              if (cached?.totalChars !== undefined) hit.totalChars = cached.totalChars;
              hits.splice(low, 0, hit);
              if (hits.length > maxResults) hits.pop();
            }
            return false;
          }, { includeIgnored, signal: budget.signal });
          backends.add(scan.backend);
          if (scan.skippedReason) reasons.add('protected_scope');
          if (scan.error) reasons.add('io_error');
          const reason = budget.reason();
          if (reason) { reasons.add(reason); break; }
        }
        if (total > hits.length) reasons.add('result_limit');
        const completion = searchCompletion(reasons);
        if (!hits.length) {
          if (reasons.has('protected_scope') && reasons.size === 1) {
            return { content: `No files were scanned in the privacy-protected workspace. Use an exact path with read_files, or ask the user to attach the file.\n${completion}` };
          }
          return { content: reasons.size
            ? `0 matches in searched scope.\n${completion}`
            : `${query ? `No matches for "${query}".` : 'No files found.'}\n${completion}` };
        }
        log.info('search_files completed', { user_id: maskId(opts.userId), query_chars: query.length, hits: total, shown: hits.length });
        const header = total > hits.length
          ? `${total} match(es), showing ${maxResults}; backend=${[...backends].join('+') || 'walk'}:`
          : `${total} match(es); backend=${[...backends].join('+') || 'walk'}:`;
        return { content: `${header}\n${completion}\n${formatSearchFileResults(hits)}` };
      } finally { budget.dispose(); }
    },
  };
}

// ── grep_files ───────────────────────────────────────────────────────────

/** Minimal glob → RegExp for grep_files scoping. `*` = a run of non-slash
 *  chars, `**` = any directories, `?` = one non-slash char. A glob WITHOUT
 *  `/` is matched against the basename at any depth (e.g. `*.ts`); a glob WITH
 *  `/` is matched against the path relative to its root (e.g. `src/**`). */
function grepGlobToRegExp(glob: string): RegExp {
  let re = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index++;
        if (glob[index + 1] === '/') {
          index++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      re += '[^/]';
      continue;
    }
    re += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${re}$`, 'i');
}

type CompiledGrepGlob = { raw: string; hasSlash: boolean; matcher: RegExp };

function compileGrepGlobs(values: unknown): CompiledGrepGlob[] {
  const raw = Array.isArray(values) ? values : typeof values === 'string' ? [values] : [];
  return raw
    .filter((value): value is string => typeof value === 'string' && !!value.trim())
    .slice(0, 16)
    .map((value) => value.trim())
    .map((value) => ({
      raw: value,
      hasSlash: value.includes('/'),
      matcher: grepGlobToRegExp(value),
    }));
}

function targetMatchesGrepGlob(
  target: { abs: string; root: string },
  glob: CompiledGrepGlob,
): boolean {
  const candidate = glob.hasSlash
    ? path.relative(target.root, target.abs).split(path.sep).join('/')
    : path.basename(target.abs);
  return glob.matcher.test(candidate);
}

function grepHitFromLines(
  target: { abs: string },
  lines: readonly string[],
  index: number,
  matcher: RegExp,
  contextLines: number,
  includeContent: boolean,
): GrepHit | null {
  const match = matcher.exec(lines[index]);
  if (!match) return null;
  const beforeStart = Math.max(0, index - contextLines);
  const afterEnd = Math.min(lines.length, index + contextLines + 1);
  return {
    path: target.abs,
    line: index + 1,
    column: match.index + 1,
    snippet: includeContent ? snippetFromLine(lines[index], match) : '',
    before: lines.slice(beforeStart, index).map((text, offset) => ({
      line: beforeStart + offset + 1,
      text: text.slice(0, 240),
    })),
    after: lines.slice(index + 1, afterEnd).map((text, offset) => ({
      line: index + offset + 2,
      text: text.slice(0, 240),
    })),
  };
}

async function pMapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  const n = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: n }, () => worker());
  await Promise.all(workers);
}

function createGrepFilesTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'grep_files',
    executionMode: 'parallel',
    description:
      'Search visible text, PDF and modern Office content; skips images and other binaries. Prefer shell `rg`/`rg --files` for repository text/file searches when available.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Pattern to search for.' },
        root: { type: 'string', description: 'One file/directory relative to the working directory, visible absolute, or @skill/<read-ref>[/path]. No globs/path lists; omit for all visible roots.' },
        regex: { type: 'boolean', description: 'Default false — treat pattern as a case-insensitive substring.' },
        glob: { type: 'string', description: 'Optional file glob. No "/" matches basenames; with "/" matches relative paths, e.g. "src/**/*.ts".' },
        include_glob: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Optional additional include globs. A file may match any include glob.' },
        exclude_glob: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Optional globs to exclude, e.g. ["node_modules/**","**/*.min.js"].' },
        case_sensitive: { type: 'boolean', description: 'Default false. Match case exactly when true.' },
        context_lines: { type: 'number', description: '0-3 surrounding lines per content match. Default 0.' },
        max_results: { type: 'number', description: `Maximum matches to return, 1-${MAX_GREP_MATCHES}.` },
        include_ignored: { type: 'boolean', description: 'Include ignored files when explicitly needed; dependency/build directories remain bounded.' },
        output_mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content (default): one line per match. files: just the file paths that contain a match — much cheaper when you only need which files. count: number of matches per file.' },
      },
      required: ['pattern'],
    },
    async execute(input, ctx) {
      const pattern = String(input.pattern ?? '');
      if (!pattern) {
        return { content: errText('E_BAD_INPUT', '`pattern` is required'), isError: true };
      }
      const useRegex = input.regex === true;
      const caseSensitive = input.case_sensitive === true;
      let matcher: RegExp;
      try {
        matcher = useRegex
          ? new RegExp(pattern, caseSensitive ? '' : 'i')
          : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? '' : 'i');
      } catch (err) {
        return { content: errText('E_BAD_INPUT', `invalid regex: ${(err as Error).message}`), isError: true };
      }

      const globStr = typeof input.glob === 'string' ? input.glob.trim() : '';
      let includeGlobs: CompiledGrepGlob[];
      let excludeGlobs: CompiledGrepGlob[];
      try {
        includeGlobs = compileGrepGlobs([
          ...(globStr ? [globStr] : []),
          ...(Array.isArray(input.include_glob) ? input.include_glob : []),
        ]);
        excludeGlobs = compileGrepGlobs(input.exclude_glob);
      } catch (err) {
        return { content: errText('E_BAD_INPUT', `invalid glob: ${(err as Error).message}`), isError: true };
      }
      const mode: 'content' | 'files' | 'count' =
        input.output_mode === 'files' || input.output_mode === 'count' ? input.output_mode : 'content';
      const filesMode = mode === 'files';
      const includeContent = mode === 'content';
      const contextLines = includeContent
        ? Math.max(0, Math.min(3, Math.trunc(Number(input.context_lines) || 0)))
        : 0;
      const maxResults = Math.max(
        1,
        Math.min(MAX_GREP_MATCHES, Math.trunc(Number(input.max_results) || MAX_GREP_MATCHES)),
      );

      const roots: string[] = [];
      try { roots.push(getWorkspacePath(opts.userId, opts.projectId)); }
      catch { /* workspace unavailable */ }
      if (opts.cid) roots.push(chatAttachmentDirForConversation(opts.userId, opts.cid));
      for (const root of [...(opts.extraRoots || []), ...(opts.readOnlyExtraRoots || [])]) {
        if (root) roots.push(root);
      }
      const requestedRootInput = typeof input.root === 'string' ? input.root.trim() : '';
      const requestedRootResolution = requestedRootInput
        ? resolveRequestedPath(opts, ctx, requestedRootInput, { bareSkillRefTarget: 'root' })
        : null;
      if (requestedRootResolution?.error) {
        return { content: requestedRootResolution.error, isError: true };
      }
      const requestedRoot = requestedRootResolution?.abs || '';
      const requestedRootDisplay = requestedRootResolution?.displayPath || requestedRoot;
      /** Set when `root` named a file: the scan is that file, not a walk. */
      let singleFileTarget = '';
      if (requestedRoot) {
        const scopeErr = await gatePathAccess(opts, requestedRoot, 'grep_files', ctx);
        if (scopeErr) return { content: scopeErr, isError: true };
        let st: fs.Stats;
        try { st = fs.statSync(requestedRoot); }
        catch (err) {
          return {
            content: errText(
              'E_NOT_FOUND',
              `${requestedRootDisplay}: ${displayErrorMessage(err, requestedRoot, requestedRootDisplay)}`,
            ),
            isError: true,
            observations: fileFailure('E_NOT_FOUND', ['ENOENT', 'ENOTDIR'].includes(String((err as NodeJS.ErrnoException).code)) ? 'target_missing' : 'target_stat', {
              stage: 'stat', target_type: ['ENOENT', 'ENOTDIR'].includes(String((err as NodeJS.ErrnoException).code)) ? 'missing' : 'unknown',
            }),
          };
        }
        if (!st.isDirectory() && !st.isFile()) {
          return { content: errText('E_NOT_DIRECTORY', `${requestedRootDisplay}: not a directory`), isError: true,
            observations: fileFailure('E_NOT_DIRECTORY', 'target_type', { stage: 'stat', target_type: 'other' }),
          };
        }
        // "Search inside this one file" is the same request at a narrower
        // scope, and the model asks for it often enough that refusing cost a
        // round trip every time. The path was gated just above, so answering
        // it reads nothing the caller could not already read; enumeration is
        // skipped rather than widened to the parent directory.
        if (st.isFile()) {
          singleFileTarget = requestedRoot;
          roots.splice(0, roots.length, path.dirname(requestedRoot));
        } else {
          roots.splice(0, roots.length, requestedRoot);
        }
      }
      if (!roots.length) {
        return { content: errText('E_NO_SCOPE', 'no visible roots for this conversation'), isError: true };
      }

      const includeIgnored = input.include_ignored === true;
      const reasons = new Set<SearchIncompleteReason>();
      const budget = createRepositorySearchBudget(ctx.signal);
      const backends = new Set<string>();
      const hits: GrepHit[] = [];
      const extractTargets: Array<{ abs: string }> = [];
      let scanned = 0, skipped = 0, extracted = 0, candidates = 0;
      const shouldStop = () => {
        const reason = budget.reason();
        if (reason) reasons.add(reason);
        if (hits.length >= maxResults) reasons.add('result_limit');
        return !!reason || hits.length >= maxResults;
      };
      const collectMatches = (target: { abs: string }, body: string) => {
        const lines = body.split('\n');
        for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
          if (i % GREP_YIELD_EVERY === 0 && shouldStop()) break;
          const hit = grepHitFromLines(target, lines, i, matcher, contextLines, includeContent);
          if (hit) {
            hits.push(hit);
            if (filesMode) break;
          }
        }
      };
      try {
        for (const root of roots) {
          if (shouldStop()) break;
          // A single file never opens its parent. Directory privacy applies before rg.
          if (!singleFileTarget && macosTccSensitivePath(path.resolve(root), { recursive: true })) {
            reasons.add('protected_scope');
            continue;
          }
          let nativeHandled = false;
          if (!singleFileTarget) {
            try {
              if (!(await fs.promises.stat(root)).isDirectory()) continue;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reasons.add('io_error');
              continue;
            }
            const result = await grepRepository(root, {
              pattern, regex: useRegex, caseSensitive, contextLines, filesOnly: filesMode,
              maxResults: maxResults - hits.length,
              includeGlobs: includeGlobs.map(glob => glob.raw),
              excludeGlobs: excludeGlobs.map(glob => glob.raw),
              includeIgnored, signal: budget.signal,
            });
            if (result.available) {
              if (result.error) {
                return { content: errText('E_GREP_FAILED', requestedRootResolution?.skillRef
                  ? displayErrorMessage(result.error, requestedRoot, requestedRootDisplay) : result.error), isError: true };
              }
              nativeHandled = true;
              backends.add('rg');
              if (result.capped) reasons.add('result_limit');
              for (const hit of result.hits) {
                hits.push({ path: hit.path, line: hit.line, column: hit.column,
                  snippet: includeContent ? snippetFromLine(hit.text, matcher.exec(hit.text)) : '',
                  before: hit.before, after: hit.after });
              }
              if (shouldStop()) break;
            }
          }
          const visit = async (abs: string): Promise<boolean> => {
            if (shouldStop()) return true;
            const target = { abs, root };
            if (includeGlobs.length && !includeGlobs.some(glob => targetMatchesGrepGlob(target, glob))) return false;
            if (excludeGlobs.some(glob => targetMatchesGrepGlob(target, glob))) return false;
            candidates++;
            const kind = kindOf(abs);
            if (isExtractableRichKind(kind)) {
              if (extractTargets.length < MAX_EXTRACT_FILES) extractTargets.push(target);
              else reasons.add('extraction_limit');
            } else if (kind === 'text') {
              if (!nativeHandled) {
                scanned++;
                try { collectMatches(target, await fs.promises.readFile(abs, { encoding: 'utf8', signal: budget.signal })); }
                catch { if (!budget.reason()) reasons.add('io_error'); }
              }
            } else skipped++;
            return shouldStop();
          };
          if (singleFileTarget) {
            backends.add('walk');
            await visit(singleFileTarget);
          } else {
            const scan = await visitFiles(root, visit, { includeIgnored, signal: budget.signal });
            backends.add(scan.backend);
            if (scan.error) reasons.add('io_error');
            if (scan.skippedReason) reasons.add('protected_scope');
          }
        }
        // The deadline prevents new extraction work. Already admitted extractors
        // retain their existing completion/cleanup contract (no detached replay).
        if (!shouldStop()) {
          await pMapLimit(extractTargets, GREP_EXTRACT_CONCURRENCY, async (target) => {
            if (shouldStop()) return;
            scanned++;
            try {
              const { text } = await getExtractedText(opts.userId, target.abs);
              extracted++;
              if (!shouldStop()) collectMatches(target, text);
            } catch (error) {
              reasons.add('io_error');
              log.warn('grep_files extract failed', { user_id: maskId(opts.userId), path: logPathRef(target.abs), error: logErrorRef(error) });
            }
          });
        }
        shouldStop();
        log.info('grep_files completed', {
          user_id: maskId(opts.userId), pattern_chars: pattern.length, use_regex: useRegex,
          hits: hits.length, scanned, extracted, skipped, backend: [...backends].join('+'),
        });
        const completion = searchCompletion(reasons);
        if (!hits.length) {
          if (reasons.has('protected_scope') && reasons.size === 1 && candidates === 0) {
            return { content: `No files were scanned in the privacy-protected workspace. Use an exact path with read_files, or ask the user to attach the file.\n${completion}` };
          }
          if (reasons.size) return { content: `0 matches in searched scope.\n${completion}` };
          if ((includeGlobs.length || excludeGlobs.length) && !candidates) {
            return { content: `No files matched glob filters in the visible scope. include=${includeGlobs.map(glob => glob.raw).join(', ') || '(all)'} exclude=${excludeGlobs.map(glob => glob.raw).join(', ') || '(none)'}\n${completion}` };
          }
          return { content: `No matches for ${useRegex ? `/${pattern}/${caseSensitive ? '' : 'i'}` : `"${pattern}"`}.\nscanned=${scanned} extracted=${extracted} skipped=${skipped}\n${completion}` };
        }
        const tail = `  scanned=${scanned} extracted=${extracted} skipped=${skipped} backend=${[...backends].join('+') || 'walk'}`;
        const visibleHits = requestedRootResolution?.skillRef
          ? hits.map(hit => ({ ...hit, path: displayDescendantPath(hit.path, requestedRoot, requestedRootDisplay) })) : hits;
        const capped = reasons.has('result_limit');
        if (mode === 'files') {
          const files = [...new Set(visibleHits.map(hit => hit.path))];
          return { content: `${files.length} file(s) with matches${capped ? ' (capped — narrow with glob)' : ''}${tail}\n${completion}\n${files.map(file => `  ${file}`).join('\n')}` };
        }
        if (mode === 'count') {
          const counts = new Map<string, number>();
          for (const hit of visibleHits) counts.set(hit.path, (counts.get(hit.path) || 0) + 1);
          return { content: `${counts.size} file(s), ${hits.length} match(es)${capped ? ` (capped at ${maxResults})` : ''}${tail}\n${completion}\n${[...counts.entries()].map(([file, count]) => `  ${file}: ${count}`).join('\n')}` };
        }
        return { content: `${hits.length} match(es)${capped ? ` (capped at ${maxResults})` : ''}${tail}\n${completion}\n${formatGrepFileResults(visibleHits)}` };
      } finally { budget.dispose(); }
    },
  };
}

/** Scan `path.parse(absPath).dir` for siblings matching `<name>-N<ext>` —
 *  the shape produced by `util/uniquify-path.uniquifyPath` when an earlier
 *  write hit a collision. Returned newest-first by N. Tolerates a missing
 *  parent dir (returns []). Used by `read_files`' ENOENT branch as a hint
 *  signal so the LLM is reminded of the rename without having to grep its
 *  own tool history. */
function findUniquifySiblings(absPath: string): string[] {
  const { dir, name, ext } = path.parse(absPath);
  if (!dir) return [];
  let entries: string[];
  try { entries = fs.readdirSync(dir); }
  catch { return []; }
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc(name)}-(\\d+)${esc(ext)}$`);
  const matches: Array<{ basename: string; n: number }> = [];
  for (const e of entries) {
    const m = re.exec(e);
    if (m) matches.push({ basename: e, n: parseInt(m[1], 10) });
  }
  matches.sort((a, b) => a.n - b.n);
  return matches.map((m) => m.basename);
}

function snippetFromLine(line: string, m: RegExpExecArray | null): string {
  if (!m) return line.slice(0, 160);
  const mid = m.index;
  const lo = Math.max(0, mid - 40);
  const hi = Math.min(line.length, mid + m[0].length + 40);
  return (lo > 0 ? '…' : '') + line.slice(lo, hi).replace(/\s+/g, ' ').trim() + (hi < line.length ? '…' : '');
}

// ── Factory ──────────────────────────────────────────────────────────────

// ── list_files ─────────────────────────────────────────────────────────────
//
// Overrides core-agent's builtin `list_files`, which does an unguarded
// `fs.readdir` and would let the model enumerate any directory on disk
// (e.g. ~/.ssh, other users' chat dirs) — bypassing the sandbox every other
// file tool enforces. This override applies the same scope gate as read_files.
function createListFilesTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'list_files',
    executionMode: 'parallel',
    description:
      'List files and subdirectories in a visible directory. Output lines are "d <name>" for directories and "f <name>" for files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the working directory, a visible absolute directory, or @skill/<read-ref>[/relative-path] for a Skill advertised in this run.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const raw = String(input.path ?? '');
      if (!raw) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const resolvedPath = resolveRequestedPath(opts, ctx, raw, { bareSkillRefTarget: 'root' });
      if (resolvedPath.error) return { content: resolvedPath.error, isError: true };
      const { abs, displayPath } = resolvedPath;

      const scopeErr = await gatePathAccess(opts, abs, 'list_files', ctx);
      if (scopeErr) {
        log.warn('list_files scope reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: scopeErr, isError: true };
      }
      const disabledSkillErr = guardDisabledSkillAccess(opts, abs);
      if (disabledSkillErr) {
        log.warn('list_files disabled skill reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: disabledSkillErr, isError: true };
      }

      try {
        const entries = await fs.promises.readdir(abs, { withFileTypes: true });
        const lines = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
        return { content: lines.join('\n') };
      } catch (err) {
        // Conversation workspaces are intentionally materialised only by the
        // first producing tool. Listing that not-yet-created cwd is therefore
        // semantically the same as listing an empty directory, not a failed
        // filesystem operation. Keep genuine typos/missing child paths as
        // errors so the model still gets useful path feedback.
        const code = (err as NodeJS.ErrnoException).code;
        const workingDir = ctx.workingDir ? path.resolve(ctx.workingDir) : '';
        if (code === 'ENOENT' && workingDir && abs === workingDir) {
          return { content: '(empty directory)' };
        }
        log.warn('list_files failed', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
        return {
          content: errText('E_LIST_FAILED', `${displayPath}: ${displayErrorMessage(err, abs, displayPath)}`),
          isError: true,
        };
      }
    },
  };
}

export function createFileTools(opts: FileToolsOpts): AgentTool[] {
  return [
    createReadFilesTool(opts),
    createSearchFilesTool(opts),
    createGrepFilesTool(opts),
    createListFilesTool(opts),
  ];
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
