/**
 * File-scoped tools injected into every main-conv runner.
 *
 *   - `read_file`     — read a slice of a file's text through an optional
 *                       tagged line/character range. The executor retains the
 *                       legacy flat range fields for conversation compatibility;
 *                       the server does not truncate. Text works as-is; rich
 *                       document kinds require a prior `stat_file` call so this tool
 *                       never triggers extract side-effects. Image returns an
 *                       inline compressed grayscale JPEG (no range).
 *                       Overrides core-agent's builtin of the same name.
 *   - `stat_file`     — extract (if needed) and return `total_chars` for a
 *                       file. The only tool that triggers pdfjs / mammoth /
 *                       OOXML extraction.
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

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentTool, ToolContext } from '#core-agent';
import { createLogger } from '../../logger';
import {
  statFile,
  readRange,
  readImageAsGrayJpeg,
  getExtractedText,
  getCachedMeta,
  kindOf,
  NeedStatError,
  NoTextError,
  UnsupportedFileKindError,
} from '../../features/file_indexer';
import { ocrFile } from '../../features/ocr_runtime';
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
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';
import type { SkillRuntimeBinding } from './skill-registry';
import {
  fallbackDirectoryExcluded,
  fallbackFileExcluded,
  grepRepository,
  listRepositoryFiles,
  readIgnoreScope,
  isIgnoredByScopes,
  type IgnoreScope,
} from './repository-search';

const log = createLogger('file-tools');

// ── Tunables ──────────────────────────────────────────────────────────────

/** Hard ceiling for `search_files` / `grep_files` directory walks — protects
 *  against accidentally pointing at a huge workspace tree. */
const MAX_SCAN_FILES = 2000;

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

// ── Opts + scope ─────────────────────────────────────────────────────────

export interface FileToolsOpts {
  userId: string;
  /** Local OCR is a specialized capability and is omitted by default.
   * Runner policy enables it for scanned-PDF / explicit OCR workflows or
   * when the selected model cannot receive attached images. */
  includeOcrFile?: boolean;
  /** The selected model can consume image blocks. Used only to provide a
   * controlled visual fallback after the local OCR runtime fails. */
  visionFallbackAvailable?: boolean;
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
  /** Read-only extra roots: path-taking file tools (read_file / stat_file)
   *  can see these, but write-side tools (edit_file / write_file
   *  / bash / markdown_to_pdf / html_to_pdf / generate_image) cannot mutate
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
   *  checks but generic read_file must never use it; retrieval is only through
   *  tool_result_search / tool_result_read_chunk. */
  toolResultsRoot?: string;
  /** Project id of the current conversation, when it belongs to one.
   *  Threaded through from group_chat at runTurn so workspace resolution
   *  picks up the project-scoped selection (per CLAUDE.md projects feature).
   *  Empty / missing → default-scope workspace. */
  projectId?: string;
  /** Fires when `read_file` resolves to a SKILL.md path under one of the
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
  const reasons = sensitivePathReasons(abs, 'read');
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

function disabledSystemASkillIdForPath(opts: FileToolsOpts, abs: string): string | null {
  const uid = opts.userId;
  if (!uid) return null;
  const roots = [userSkillsDir(uid), userMarketplaceSkillsDir(uid)];
  for (const root of roots) {
    const rel = path.relative(path.resolve(root), path.resolve(abs));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const skillId = rel.split(path.sep)[0];
    if (skillId && !isSkillEnabled(uid, skillId)) return skillId;
  }
  return null;
}

function guardDisabledSkillAccess(opts: FileToolsOpts, abs: string): string | null {
  const skillId = disabledSystemASkillIdForPath(opts, abs);
  if (!skillId) return null;
  return errText(
    'E_SKILL_DISABLED',
    `skill "${skillId}" is disabled for this user; re-enable it before reading or running its workflow.`,
  );
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
  | { address: ReadAddress; error?: never }
  | { address?: never; error: string };

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
  const rawRange = input.range;
  if (rawRange !== undefined) {
    if (LEGACY_READ_RANGE_KEYS.some((key) => input[key] !== undefined)) {
      return { error: '`range` cannot be combined with legacy flat range fields' };
    }
    if (!rawRange || typeof rawRange !== 'object' || Array.isArray(rawRange)) {
      return { error: '`range` must be an object with unit, start, and end' };
    }
    const range = rawRange as Record<string, unknown>;
    const unit = range.unit;
    const start = range.start;
    const end = range.end;
    if (unit !== 'line' && unit !== 'char') {
      return { error: '`range.unit` must be "line" or "char"' };
    }
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return { error: '`range.start` and `range.end` must be integers' };
    }
    const numericStart = start as number;
    const numericEnd = end as number;
    const minimumStart = unit === 'line' ? 1 : 0;
    if (numericStart < minimumStart || numericEnd < numericStart) {
      return {
        error: unit === 'line'
          ? '`range` line positions must satisfy 1 <= start <= end'
          : '`range` character positions must satisfy 0 <= start <= end',
      };
    }
    return unit === 'line'
      ? { address: { lineStart: numericStart, lineEnd: numericEnd } }
      : { address: { charStart: numericStart, charEnd: numericEnd } };
  }

  const hasCharRange = typeof input.charStart === 'number' || typeof input.charEnd === 'number';
  const hasLineRange = typeof input.lineStart === 'number' || typeof input.lineEnd === 'number';
  if (hasCharRange && hasLineRange) {
    return { error: 'use either charStart/charEnd or lineStart/lineEnd, not both' };
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

// ── read_file ─────────────────────────────────────────────────────────────

function createReadFileTool(
  opts: FileToolsOpts,
  behavior: { defaultCharLimit?: number } = {},
): AgentTool {
  return {
    name: 'read_file',
    executionMode: 'parallel',
    description:
      'Read a whole file or an exact range: {unit:"line",start,end} is 1-based/inclusive; {unit:"char",start,end} is 0-based/end-exclusive. Text results include an opaque revision token for exact follow-up file mutations; copy it instead of converting character counts to byte offsets. Text lines are returned as "<line>\\t<text>"; do not include that prefix in edits. For new PDF/Office files, stat_file may be required first; images return an inline preview.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Visible absolute path, or @skill/<read-ref>[/relative-path] for a Skill advertised in this run.' },
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
        };
      }
      const { address } = parsedAddress;
      const hasLineRange = address.lineStart !== undefined || address.lineEnd !== undefined;

      const scopeErr = await gatePathAccess(opts, abs, 'read_file', ctx);
      if (scopeErr) {
        log.warn('read_file scope reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: scopeErr, isError: true };
      }
      const disabledSkillErr = guardDisabledSkillAccess(opts, abs);
      if (disabledSkillErr) {
        log.warn('read_file disabled skill reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: disabledSkillErr, isError: true };
      }
      if (opts.toolResultsRoot && isInsideRoot(opts.toolResultsRoot, abs)) {
        return {
          content: errText(
            'E_TOOL_RESULT_REF_REQUIRED',
            'Persisted tool results cannot be read by path. Use the ref from <persisted-output> with tool_result_search or tool_result_read_chunk.',
          ),
          isError: true,
        };
      }

      let sourceStat: fs.Stats;
      try { sourceStat = fs.statSync(abs); }
      catch (err) {
        const siblings = findUniquifySiblings(abs);
        log.warn('read_file not found', {
          user_id: maskId(opts.userId),
          path: logPathRef(abs),
          sibling_count: siblings.length,
          error: logErrorRef(err),
        });
        let content = errText('E_NOT_FOUND', `${displayPath}: ${displayErrorMessage(err, abs, displayPath)}`);
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

      const kind = kindOf(abs);
      const portableSkillDocument = isPortableSkillDocumentPath(abs);
      try {
        if (kind === 'image') {
          const img = await readImageAsGrayJpeg(opts.userId, abs);
          const header = `<file path="${displayPath}" kind="image" bytes="${img.bytes}" compressed="${img.width}x${img.height} gray JPEG q=70"/>`;
          log.info('read_file image loaded', {
            user_id: maskId(opts.userId),
            path: logPathRef(abs),
            kind: 'image',
            bytes: img.bytes,
          });
          return {
            content: `${header}\nImage loaded — the compressed grayscale JPEG follows as a user-turn image.`,
            images: [{ data: img.base64, mediaType: img.mediaType }],
          };
        }

        const appliesDefaultCharLimit = !hasLineRange
          && address.charStart === undefined
          && address.charEnd === undefined
          && behavior.defaultCharLimit !== undefined
          && !portableSkillDocument;
        let result = await readRange(opts.userId, abs, {
          ...(address.charStart !== undefined ? { charStart: address.charStart } : {}),
          ...(address.charEnd !== undefined
            ? { charEnd: address.charEnd }
            : appliesDefaultCharLimit
              ? { charEnd: behavior.defaultCharLimit }
              : {}),
        });
        if (hasLineRange) {
          const full = result.content;
          const requestedStart = Math.max(1, Math.trunc(Number(address.lineStart) || 1));
          const requestedEnd = Math.max(
            requestedStart,
            Math.trunc(Number(address.lineEnd) || requestedStart + 399),
          );
          let currentLine = 1;
          let startChar = requestedStart === 1 ? 0 : full.length;
          let endChar = full.length;
          for (let index = 0; index < full.length; index++) {
            if (full.charCodeAt(index) !== 10) continue;
            currentLine++;
            if (currentLine === requestedStart) startChar = index + 1;
            if (currentLine === requestedEnd + 1) {
              endChar = index;
              break;
            }
          }
          if (requestedStart > currentLine) startChar = full.length;
          result = {
            ...result,
            content: full.slice(startChar, endChar),
            range: { charStart: startChar, charEnd: endChar },
            startLine: Math.min(requestedStart, currentLine),
          };
        }

        const total = result.meta.totalChars ?? 0;
        const cs = result.range.charStart;
        const ce = result.range.charEnd;
        const revision = kind === 'text' && result.sourceHash
          ? issueFileRevision(ctx, abs, sourceStat.size, result.sourceHash)
          : '';
        // Number the lines for display (the model thinks in lines for code);
        // char offsets remain the addressing/paging unit.
        const { text: numberedContent, lastLine } = addLineNumbers(result.content, result.startLine);
        const attrs = [
          `path="${displayPath}"`,
          `kind="${kind}"`,
          `total_chars="${total}"`,
          `covered="${cs}-${ce}"`,
          `lines="${result.startLine}-${lastLine}"`,
          ...(result.sourceHash ? [`file_hash="${result.sourceHash}"`] : []),
          ...(revision ? [`revision="${revision}"`] : []),
          ...(result.meta.extractionEmpty ? ['extraction="empty_pages"'] : []),
        ];
        const header = `<file ${attrs.join(' ')}>`;
        log.info('read_file loaded', {
          user_id: maskId(opts.userId),
          path: logPathRef(abs),
          kind,
          covered_start: cs,
          covered_end: ce,
          total_chars: total,
          start_line: result.startLine,
          end_line: lastLine,
        });
        // skill_invoked attribution: when the LLM read_file's a SKILL.md
        // body, the body is the progressive-disclosure "use this skill"
        // signal (per Claude Code conventions). Emit AFTER the successful
        // text read — image / rich-document SKILL.md is not a real shape.
        if (opts.onSkillInvoked) {
          const runtimeBinding = resolvedPath.skillRef
            ? opts.skillRuntimeBindings?.get(resolvedPath.skillRef)
            : undefined;
          const runtimeParsed = runtimeBinding
            && path.resolve(abs) === path.resolve(runtimeBinding.entry)
            ? {
              skill_id: runtimeBinding.id,
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
          content: `${header}\n${numberedContent}\n</file>`,
          // A skill body or its reference is a document the model was told to
          // read whole. Spilled, it comes back as a stub the model keyword-
          // searches, and whatever the search misses goes unread — so the
          // result policy gives it a wider (still bounded) inline ceiling.
          ...(portableSkillDocument ? { verbatimDocument: true } : {}),
          observations: {
            fileReads: [{
              path: abs,
              ...(result.sourceHash ? { hash: result.sourceHash } : {}),
              charRange: [cs, ce],
              lineRange: [result.startLine, lastLine],
            }],
          },
        };
      } catch (err) {
        if (err instanceof NeedStatError) {
          log.warn('read_file need stat', { user_id: maskId(opts.userId), path: logPathRef(abs), kind: err.kind });
          return {
            content: errText(
              'E_NEED_STAT',
              `${displayPath}: ${err.kind} has not been extracted yet. Call stat_file(path=...) first to get total_chars, then call read_file with charStart/charEnd.`,
            ),
            isError: true,
          };
        }
        if (err instanceof NoTextError) {
          log.warn('read_file no text', { user_id: maskId(opts.userId), path: logPathRef(abs) });
          return { content: errText('E_NO_TEXT', `${displayPath}: image has no text representation`), isError: true };
        }
        if (err instanceof UnsupportedFileKindError) {
          log.warn('read_file unsupported kind', { user_id: maskId(opts.userId), path: logPathRef(abs), kind: err.kind });
          return {
            content: errText(
              'E_UNSUPPORTED_FILE',
              `${displayPath}: ${err.kind} cannot be read by the model. Convert it to .docx/.xlsx/.pptx and attach again.`,
            ),
            isError: true,
          };
        }
        const msg = displayErrorMessage(err, abs, displayPath);
        log.warn('read_file failed', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
        return { content: errText('E_READ_FAILED', msg), isError: true };
      }
    },
  };
}

const READ_FILES_MAX_ITEMS = 12;
const READ_FILES_MAX_OUTPUT_CHARS = 160_000;
const READ_FILES_DEFAULT_SLICE_CHARS = 24_000;

/** Bounded batch companion to read_file. It deliberately delegates every
 * request to the normal read tool so scope checks, rich-file handling,
 * line-number rendering, skill attribution, and OCC stamps stay identical. */
function createReadFilesTool(opts: FileToolsOpts): AgentTool {
  // Ordinary batch reads default to a bounded slice. Portable skill documents
  // are the exception: the delegated read_file classifies them only after its
  // normal access gate and reads them whole, so a skill never silently becomes
  // a valid-looking prefix.
  const readFile = createReadFileTool(opts, { defaultCharLimit: READ_FILES_DEFAULT_SLICE_CHARS });
  return {
    name: 'read_files',
    executionMode: 'parallel',
    description:
      'Read several related files or bounded exact tagged ranges after search/grep. Each request accepts path plus optional range {unit:"line"|"char",start,end}. Results retain line numbers, hashes, scope checks, and rich-file behavior.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        files: {
          type: 'array',
          minItems: 1,
          maxItems: READ_FILES_MAX_ITEMS,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', description: 'Visible absolute path, or @skill/<read-ref>[/relative-path] for a Skill advertised in this run.' },
              range: taggedReadRangeSchema(),
            },
            required: ['path'],
          },
        },
      },
      required: ['files'],
    },
    async execute(input, ctx) {
      if (!Array.isArray(input.files) || input.files.length === 0) {
        return { content: errText('E_BAD_INPUT', '`files` must be a non-empty array'), isError: true };
      }
      if (input.files.length > READ_FILES_MAX_ITEMS) {
        return {
          content: errText('E_BAD_INPUT', `read_files accepts at most ${READ_FILES_MAX_ITEMS} files per call`),
          isError: true,
        };
      }
      const requests = input.files.map((entry) => (
        entry && typeof entry === 'object' && !Array.isArray(entry)
          ? entry as Record<string, unknown>
          : {}
      ));
      if (requests.some((entry) => typeof entry.path !== 'string' || !entry.path)) {
        return {
          content: errText('E_BAD_INPUT', 'every read_files item requires a non-empty `path`'),
          isError: true,
        };
      }
      const parsedAddresses = requests.map((entry) => parseReadAddress(entry));
      const invalidAddressIndex = parsedAddresses.findIndex((entry) => entry.error !== undefined);
      if (invalidAddressIndex >= 0) {
        return {
          content: errText(
            'E_BAD_INPUT',
            `read_files item ${invalidAddressIndex + 1}: ${parsedAddresses[invalidAddressIndex].error}`,
          ),
          isError: true,
        };
      }

      const normalized = requests.map((request, index) => {
        const address = parsedAddresses[index].address!;
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
      const results = await Promise.all(normalized.map((request) => readFile.execute(request, ctx)));
      const images = results.flatMap((result) => result.images || []);
      const includesVerbatimDocument = results.some((result) => !result.isError && result.verbatimDocument);
      // Skill documents must remain lossless. AgentRunner's final result cap
      // persists an oversized aggregate and charges the round ledger; applying
      // this older character truncation first would destroy the omitted bytes
      // before that policy can act.
      let remaining = includesVerbatimDocument ? Number.POSITIVE_INFINITY : READ_FILES_MAX_OUTPUT_CHARS;
      let truncated = false;
      const blocks = results.map((result, index) => {
        const prefix =
          `<read-result index="${index}" ok="${result.isError ? 'false' : 'true'}">\n`
          + `requested_path=${String(normalized[index].path)}\n`;
        const suffix = '\n</read-result>';
        const available = Math.max(0, remaining - prefix.length - suffix.length);
        let body = result.content;
        if (body.length > available) {
          body = `${body.slice(0, Math.max(0, available - 80))}\n...[batch output limit reached]`;
          truncated = true;
        }
        const block = `${prefix}${body}${suffix}`;
        remaining = Math.max(0, remaining - block.length);
        return block;
      });
      const errors = results.filter((result) => result.isError).length;
      return {
        content:
          `<read-files count="${results.length}" errors="${errors}" truncated="${truncated}">\n`
          + `${blocks.join('\n')}\n</read-files>`,
        ...(images.length ? { images } : {}),
        ...(errors === results.length ? { isError: true } : {}),
        ...(includesVerbatimDocument ? { verbatimDocument: true } : {}),
        observations: {
          fileReads: results.flatMap((result) => result.observations?.fileReads ?? []),
        },
      };
    },
  };
}

// ── stat_file ────────────────────────────────────────────────────────────

function createStatFileTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'stat_file',
    description:
      'Extract/cache readable text metadata and return total_chars for a visible file. Use before first read_file when attachments/search_files did not provide total_chars, especially for PDF/Office. Skip when total_chars is already known. Images return E_NO_TEXT; use read_file for image previews.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Visible absolute path, or @skill/<read-ref>[/relative-path] for a Skill advertised in this run.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const raw = String(input.path ?? '');
      if (!raw) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const resolvedPath = resolveRequestedPath(opts, ctx, raw);
      if (resolvedPath.error) return { content: resolvedPath.error, isError: true };
      const { abs, displayPath } = resolvedPath;

      const scopeErr = await gatePathAccess(opts, abs, 'stat_file', ctx);
      if (scopeErr) {
        log.warn('stat_file scope reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: scopeErr, isError: true };
      }
      const disabledSkillErr = guardDisabledSkillAccess(opts, abs);
      if (disabledSkillErr) {
        log.warn('stat_file disabled skill reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: disabledSkillErr, isError: true };
      }

      try { fs.statSync(abs); }
      catch (err) {
        log.warn('stat_file not found', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
        return { content: errText('E_NOT_FOUND', `${displayPath}: ${displayErrorMessage(err, abs, displayPath)}`), isError: true };
      }

      const kind = kindOf(abs);
      try {
        const meta = await statFile(opts.userId, abs);
        const total = meta.totalChars ?? 0;
        const emptyAttr = meta.extractionEmpty ? ' extraction="empty_pages"' : '';
        log.info('stat_file loaded', {
          user_id: maskId(opts.userId),
          path: logPathRef(abs),
          kind,
          total_chars: total,
          extraction_empty: !!meta.extractionEmpty,
        });
        return {
          content: `<file path="${displayPath}" kind="${kind}" total_chars="${total}"${emptyAttr}/>`,
        };
      } catch (err) {
        if (err instanceof NoTextError) {
          log.warn('stat_file no text', { user_id: maskId(opts.userId), path: logPathRef(abs) });
          return { content: errText('E_NO_TEXT', `${displayPath}: image has no text representation`), isError: true };
        }
        if (err instanceof UnsupportedFileKindError) {
          log.warn('stat_file unsupported kind', { user_id: maskId(opts.userId), path: logPathRef(abs), kind: err.kind });
          return {
            content: errText(
              'E_UNSUPPORTED_FILE',
              `${displayPath}: ${err.kind} cannot be read by the model. Convert it to .docx/.xlsx/.pptx and attach again.`,
            ),
            isError: true,
          };
        }
        const msg = displayErrorMessage(err, abs, displayPath);
        log.warn('stat_file failed', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
        return { content: errText('E_STAT_FAILED', msg), isError: true };
      }
    },
  };
}

// ── ocr_file ─────────────────────────────────────────────────────────────

function createOcrFileTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'ocr_file',
    executionMode: 'sequential',
    description:
      'Run local OCR on scanned/image-only PDFs or images when exact text recognition is required and read_file/stat_file cannot recover it. Do not use this for ordinary image understanding when the image is already visible to the model. For normal text PDFs/Office, use stat_file/read_file first. Never repair OCR with shell package installs.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Visible absolute path, or @skill/<read-ref>[/relative-path] for a Skill advertised in this run.' },
        pages: { type: 'string', description: 'Optional PDF pages, e.g. "1-3,5". Omit to OCR all pages.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const raw = String(input.path ?? '');
      if (!raw) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const resolvedPath = resolveRequestedPath(opts, ctx, raw);
      if (resolvedPath.error) return { content: resolvedPath.error, isError: true };
      const { abs, displayPath } = resolvedPath;

      const scopeErr = await gatePathAccess(opts, abs, 'ocr_file', ctx);
      if (scopeErr) {
        log.warn('ocr_file scope reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: scopeErr, isError: true };
      }
      const disabledSkillErr = guardDisabledSkillAccess(opts, abs);
      if (disabledSkillErr) {
        log.warn('ocr_file disabled skill reject', { user_id: maskId(opts.userId), path: logPathRef(abs) });
        return { content: disabledSkillErr, isError: true };
      }
      try { fs.statSync(abs); }
      catch (err) {
        log.warn('ocr_file not found', { user_id: maskId(opts.userId), path: logPathRef(abs), error: logErrorRef(err) });
        return { content: errText('E_NOT_FOUND', `${displayPath}: ${displayErrorMessage(err, abs, displayPath)}`), isError: true };
      }

      const kind = kindOf(abs);
      if (kind !== 'pdf' && kind !== 'image') {
        return {
          content: errText(
            'E_OCR_UNSUPPORTED_FILE',
            `ocr_file currently supports PDF and image files only; got kind=${kind}. Use read_file/stat_file for normal text or Office files.`,
          ),
          isError: true,
        };
      }

      const pages = typeof input.pages === 'string' ? input.pages : undefined;
      const result = await ocrFile({
        userId: opts.userId,
        absPath: abs,
        ...(pages ? { pages } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        onProgress: (event) => ctx.emitProgress?.({
          phase: event.phase,
          message: event.message,
          ...(event.data ? { data: event.data } : {}),
        }),
      });
      if (result.ok === false) {
        const processBlock = result.processLog?.length
          ? `\n\n<ocr-process>\n${result.processLog.map((line) => `- ${line}`).join('\n')}\n</ocr-process>`
          : '';
        const repairHint = '\n\nDo not retry ocr_file or install/repair OCR dependencies with bash, pip, or uv.';
        if (opts.visionFallbackAvailable && kind === 'image') {
          try {
            const image = await readImageAsGrayJpeg(opts.userId, abs);
            return {
              content:
                `<ocr-vision-fallback path="${displayPath}" reason="${result.errorCode}" action="inspect_attached_image">\n`
                + 'Local OCR is unavailable. Continue once from the attached model-visible image; do not call OCR or shell repair commands.\n'
                + `</ocr-vision-fallback>${processBlock}`,
              images: [{ data: image.base64, mediaType: image.mediaType }],
            };
          } catch (fallbackErr) {
            log.warn('ocr_file image fallback failed', {
              user_id: maskId(opts.userId),
              path: logPathRef(abs),
              error: logErrorRef(fallbackErr),
            });
          }
        }
        const visionFallback = opts.visionFallbackAvailable && kind === 'pdf'
          ? '\n\n<ocr-vision-fallback action="pdf_render" retry_ocr="false">Render only the needed PDF pages, one page per call, and inspect the returned images. Do not use shell extraction or package installation.</ocr-vision-fallback>'
          : '';
        return {
          content: errText(
            result.errorCode,
            displayErrorMessage(`${result.message}${processBlock}${visionFallback}${repairHint}`, abs, displayPath),
          ),
          isError: true,
        };
      }
      log.info('ocr_file completed', {
        user_id: maskId(opts.userId),
        path: logPathRef(abs),
        kind,
        cached: !!result.cached,
        text_chars: result.content.length,
      });
      return { content: displayErrorMessage(result.content, abs, displayPath) };
    },
  };
}

// ── search_files ─────────────────────────────────────────────────────────

interface SearchHit {
  path: string;
  name: string;
  size: number;
  mtime: number;
  ext: string;
  source: 'attachment' | 'workspace' | 'extra';
  /** Only present when a fresh cache entry is already on disk. Never
   *  triggers extract just to populate this field. */
  totalChars?: number;
}

function compileMatcher(query: string): (name: string) => boolean {
  const q = query.trim();
  if (!q) return () => true;
  const hasGlob = /[*?[]/.test(q);
  if (hasGlob) {
    const re = new RegExp(
      '^' + q.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i',
    );
    return (name) => re.test(name);
  }
  const lower = q.toLowerCase();
  return (name) => name.toLowerCase().includes(lower);
}

function walkFiles(
  root: string,
  max: number,
  opts: { includeIgnored?: boolean } = {},
): { files: string[]; skippedReason?: string } {
  const out: string[] = [];
  if (!root) return { files: out };
  const protectedRoot = macosTccSensitivePath(path.resolve(root), { recursive: true });
  if (protectedRoot) return { files: out, skippedReason: protectedRoot.reason };
  let rootStat: fs.Stats;
  try { rootStat = fs.statSync(root); }
  catch { return { files: out }; }
  if (!rootStat.isDirectory()) return { files: out };

  // Ignore files are honoured here too, not just by the `rg` backend: the tool
  // promises repository scans respect them, and a machine without ripgrep must
  // not start surfacing ignored build output and local config.
  const honourIgnores = opts.includeIgnored !== true;
  const rootScope = honourIgnores ? readIgnoreScope(root) : null;
  const stack: Array<{ dir: string; scopes: readonly IgnoreScope[] }> = [
    { dir: root, scopes: rootScope ? [rootScope] : [] },
  ];
  while (stack.length && out.length < max) {
    const { dir, scopes } = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name === '.git') continue;
      if (e.isDirectory() && fallbackDirectoryExcluded(e.name)) continue;
      const p = path.join(dir, e.name);
      if (honourIgnores && isIgnoredByScopes(p, e.isDirectory(), scopes)) continue;
      if (e.isDirectory()) {
        // A nested `.gitignore` governs its own subtree, as in git.
        const nested = honourIgnores ? readIgnoreScope(p) : null;
        stack.push({ dir: p, scopes: nested ? [...scopes, nested] : scopes });
      } else if (e.isFile()) {
        if (fallbackFileExcluded(e.name)) continue;
        out.push(p);
        if (out.length >= max) break;
      }
    }
  }
  return { files: out };
}

async function enumerateFiles(
  root: string,
  max: number,
  opts: { includeIgnored?: boolean; signal?: AbortSignal } = {},
): Promise<{ files: string[]; backend: 'rg' | 'walk'; capped: boolean; skippedReason?: string }> {
  const protectedRoot = macosTccSensitivePath(path.resolve(root), { recursive: true });
  if (protectedRoot) {
    return { files: [], backend: 'walk', capped: false, skippedReason: protectedRoot.reason };
  }
  const repository = await listRepositoryFiles(root, max, opts);
  if (repository.backend === 'rg') return repository;
  const fallback = walkFiles(root, max, opts);
  return {
    files: fallback.files,
    backend: 'walk',
    capped: fallback.files.length >= max,
    ...(fallback.skippedReason ? { skippedReason: fallback.skippedReason } : {}),
  };
}

function createSearchFilesTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'search_files',
    executionMode: 'parallel',
    description:
      'Find files by substring or glob when the path is unknown. Repository scans respect ignore files and avoid dependency/build trees; exact read_file paths remain available. Returns path/name/size/mtime/source without extracting content.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring or glob. Omit to list everything.' },
        root: { type: 'string', description: 'Optional visible directory or @skill/<read-ref>[/relative-path] to search instead of all visible roots.' },
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
          return { content: errText('E_NOT_DIRECTORY', `${requestedRootDisplay}: not a directory`), isError: true };
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

      const hits: SearchHit[] = [];
      const skippedScans: string[] = [];
      const backends = new Set<string>();
      let budget = MAX_SCAN_FILES;
      for (const { root, source } of rootKinds) {
        if (budget <= 0) break;
        const scan = await enumerateFiles(root, budget, { includeIgnored, signal: ctx.signal });
        if (scan.skippedReason) {
          skippedScans.push(`${source}:${scan.skippedReason}`);
          continue;
        }
        backends.add(scan.backend);
        const files = scan.files;
        budget -= files.length;
        for (const abs of files) {
          const name = path.basename(abs);
          if (!matcher(name)) continue;
          const target = { abs, root };
          if (includeGlobs.length && !includeGlobs.some((glob) => targetMatchesGrepGlob(target, glob))) continue;
          if (excludeGlobs.some((glob) => targetMatchesGrepGlob(target, glob))) continue;
          let st: fs.Stats;
          try { st = fs.statSync(abs); }
          catch { continue; }
          const ext = path.extname(name).toLowerCase();
          const hit: SearchHit = {
            path: requestedRootResolution?.skillRef
              ? displayDescendantPath(abs, requestedRoot, requestedRootDisplay)
              : abs,
            name,
            size: st.size,
            mtime: Math.floor(st.mtimeMs),
            ext,
            source,
          };
          // Only include total_chars when a cache entry already exists — never
          // trigger extract from a search. Model can call stat_file if needed.
          const cached = getCachedMeta(opts.userId, abs);
          if (cached?.totalChars !== undefined) hit.totalChars = cached.totalChars;
          hits.push(hit);
        }
      }

      if (!hits.length) {
        if (skippedScans.length) {
          return {
            content: 'No files were scanned in the privacy-protected workspace. Use an exact path with read_file/stat_file, or ask the user to attach the file.',
          };
        }
        return { content: query ? `No matches for "${query}".` : 'No files found.' };
      }
      // Newest-first, THEN cap — so the cap keeps the most recently modified
      // files (previously the cap was applied during the walk, which dropped
      // recent files that happened to be visited late in the traversal).
      hits.sort((a, b) => b.mtime - a.mtime);
      const total = hits.length;
      const shown = total > maxResults ? hits.slice(0, maxResults) : hits;
      const lines = shown.map((h) => {
        const bits = [
          `path=${h.path}`,
          `size=${h.size}`,
          `mtime=${new Date(h.mtime).toISOString()}`,
          `source=${h.source}`,
          ...(h.totalChars !== undefined ? [`total_chars=${h.totalChars}`] : []),
        ];
        return `- ${h.name}  (${bits.join(', ')})`;
      });
      log.info('search_files completed', {
        user_id: maskId(opts.userId),
        query_chars: query.length,
        hits: total,
        shown: shown.length,
      });
      const header = total > shown.length
        ? `${total} match(es), showing ${maxResults}; backend=${[...backends].join('+') || 'walk'}:`
        : `${total} match(es); backend=${[...backends].join('+') || 'walk'}:`;
      return { content: `${header}\n${lines.join('\n')}` };
    },
  };
}

// ── grep_files ───────────────────────────────────────────────────────────

interface GrepHit {
  path: string;
  line: number;
  column: number;
  snippet: string;
  before: Array<{ line: number; text: string }>;
  after: Array<{ line: number; text: string }>;
  source: 'attachment' | 'workspace' | 'extra';
}

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
  target: { abs: string; source: 'attachment' | 'workspace' | 'extra' },
  lines: readonly string[],
  index: number,
  matcher: RegExp,
  contextLines: number,
): GrepHit | null {
  const match = matcher.exec(lines[index]);
  if (!match) return null;
  const beforeStart = Math.max(0, index - contextLines);
  const afterEnd = Math.min(lines.length, index + contextLines + 1);
  return {
    path: target.abs,
    line: index + 1,
    column: match.index + 1,
    snippet: snippetFromLine(lines[index], matcher),
    before: lines.slice(beforeStart, index).map((text, offset) => ({
      line: beforeStart + offset + 1,
      text: text.slice(0, 240),
    })),
    after: lines.slice(index + 1, afterEnd).map((text, offset) => ({
      line: index + offset + 2,
      text: text.slice(0, 240),
    })),
    source: target.source,
  };
}

async function pMapLimit<T, U>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<U>,
): Promise<U[]> {
  const out: U[] = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  const n = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: n }, () => worker());
  await Promise.all(workers);
  return out;
}

function createGrepFilesTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'grep_files',
    executionMode: 'parallel',
    description:
      'Search for a pattern across files visible to this conversation (workspace + attachment dir).\n'
      + 'File type handling:\n'
      + '  • text / md / csv / code → searched directly on the source file\n'
      + '  • PDF / modern Office → extracted to text (cached) and searched\n'
      + '  • images / legacy Office / binaries → skipped\n'
      + 'First cross-file grep on a fresh set of rich documents may be slow (parallel extract);\n'
      + 'subsequent calls in the same session are cached. On a large project, pass `glob` to\n'
      + 'scope the files and `output_mode:"files"` when you only need to know WHICH files match.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Pattern to search for.' },
        root: { type: 'string', description: 'Optional visible directory or @skill/<read-ref>[/relative-path] to search instead of all visible roots.' },
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
      const contextLines = Math.max(0, Math.min(3, Math.trunc(Number(input.context_lines) || 0)));
      const maxResults = Math.max(
        1,
        Math.min(MAX_GREP_MATCHES, Math.trunc(Number(input.max_results) || MAX_GREP_MATCHES)),
      );

      const rootKinds: Array<{ root: string; source: 'attachment' | 'workspace' | 'extra' }> = [];
      try { rootKinds.push({ root: getWorkspacePath(opts.userId, opts.projectId), source: 'workspace' }); }
      catch { /* workspace unavailable */ }
      if (opts.cid) rootKinds.push({ root: chatAttachmentDirForConversation(opts.userId, opts.cid), source: 'attachment' });
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
          };
        }
        if (!st.isDirectory()) {
          return { content: errText('E_NOT_DIRECTORY', `${requestedRootDisplay}: not a directory`), isError: true };
        }
        const source = rootKinds.find(({ root }) => isInsideRoot(root, requestedRoot))?.source ?? 'extra';
        rootKinds.splice(0, rootKinds.length, { root: requestedRoot, source });
      }
      if (!rootKinds.length) {
        return { content: errText('E_NO_SCOPE', 'no visible roots for this conversation'), isError: true };
      }

      const targets: Array<{ abs: string; source: 'attachment' | 'workspace' | 'extra'; root: string }> = [];
      const skippedScans: string[] = [];
      const includeIgnored = input.include_ignored === true;
      const enumerationBackends = new Set<string>();
      let budget = MAX_SCAN_FILES;
      for (const { root, source } of rootKinds) {
        if (budget <= 0) break;
        const scan = await enumerateFiles(root, budget, { includeIgnored, signal: ctx.signal });
        if (scan.skippedReason) {
          skippedScans.push(`${source}:${scan.skippedReason}`);
          continue;
        }
        enumerationBackends.add(scan.backend);
        const files = scan.files;
        budget -= files.length;
        for (const abs of files) targets.push({ abs, source, root });
      }
      if (!targets.length && skippedScans.length) {
        return {
          content: 'No files were scanned in the privacy-protected workspace. Use an exact path with read_file/stat_file, or ask the user to attach the file.',
        };
      }

      // Scope by glob (when given). No-slash globs match the basename at any
      // depth; slash globs match the root-relative path (normalized to "/").
      const scoped = targets.filter((target) => {
        const included = includeGlobs.length === 0
          || includeGlobs.some((glob) => targetMatchesGrepGlob(target, glob));
        const excluded = excludeGlobs.some((glob) => targetMatchesGrepGlob(target, glob));
        return included && !excluded;
      });
      if ((includeGlobs.length || excludeGlobs.length) && !scoped.length) {
        const includeText = includeGlobs.map((glob) => glob.raw).join(', ') || '(all)';
        const excludeText = excludeGlobs.map((glob) => glob.raw).join(', ') || '(none)';
        return {
          content:
            `No files matched glob filters in the visible scope. `
            + `include=${includeText} exclude=${excludeText}`,
        };
      }

      let scanned = 0, skipped = 0, extracted = 0;
      const hits: GrepHit[] = [];
      const rgHandledRoots = new Set<string>();
      for (const { root, source } of rootKinds) {
        if (hits.length >= maxResults) break;
        const repositoryResult = await grepRepository(root, {
          pattern,
          regex: useRegex,
          caseSensitive,
          contextLines,
          maxResults: maxResults - hits.length,
          includeGlobs: includeGlobs.map((glob) => glob.raw),
          excludeGlobs: excludeGlobs.map((glob) => glob.raw),
          includeIgnored,
          signal: ctx.signal,
        });
        if (!repositoryResult.available) continue;
        if (repositoryResult.error) {
          return {
            content: errText(
              'E_GREP_FAILED',
              requestedRootResolution?.skillRef
                ? displayErrorMessage(repositoryResult.error, requestedRoot, requestedRootDisplay)
                : repositoryResult.error,
            ),
            isError: true,
          };
        }
        rgHandledRoots.add(path.resolve(root));
        for (const hit of repositoryResult.hits) {
          hits.push({
            path: hit.path,
            line: hit.line,
            column: hit.column,
            snippet: snippetFromLine(hit.text, matcher),
            before: hit.before,
            after: hit.after,
            source,
          });
        }
      }

      // Split into text-direct vs extract-required buckets. Text bucket is
      // fast (sync read + scan); extract bucket is bounded-concurrency async.
      const allTextTargets = scoped.filter((t) => {
        const k = kindOf(t.abs);
        if (k === 'image') return false;
        return k === 'text';
      });
      const textTargets = allTextTargets.filter((t) => !rgHandledRoots.has(path.resolve(t.root)));
      const extractTargets = scoped.filter((t) => {
        const k = kindOf(t.abs);
        return isExtractableRichKind(k);
      });
      // Images + unknown → skipped
      skipped += scoped.length - allTextTargets.length - extractTargets.length;

      // Text bucket — async, non-blocking line scan: read each file off the
      // event loop and yield every GREP_YIELD_EVERY files, so a large workspace
      // can't stall the main process (was a synchronous readFileSync loop).
      let sinceYield = 0;
      for (const t of textTargets) {
        if (hits.length >= maxResults) break;
        scanned++;
        if (++sinceYield >= GREP_YIELD_EVERY) { sinceYield = 0; await new Promise<void>((r) => setImmediate(r)); }
        let body: string;
        try { body = await fs.promises.readFile(t.abs, 'utf8'); }
        catch { continue; }
        const lines = body.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const hit = grepHitFromLines(t, lines, i, matcher, contextLines);
          if (hit) {
            hits.push(hit);
            if (filesMode) break;   // files/count: one snippet per file is enough for files-mode
            if (hits.length >= maxResults) break;
          }
        }
      }

      // Extract bucket — parallel extract with cache, then line scan.
      if (hits.length < maxResults && extractTargets.length) {
        await pMapLimit(extractTargets, GREP_EXTRACT_CONCURRENCY, async (t) => {
          if (hits.length >= maxResults) return;
          scanned++;
          let text: string;
          try {
            const { text: got } = await getExtractedText(opts.userId, t.abs);
            text = got;
            extracted++;
          } catch (err) {
            log.warn('grep_files extract failed', { user_id: maskId(opts.userId), path: logPathRef(t.abs), error: logErrorRef(err) });
            return;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= maxResults) return;
            const hit = grepHitFromLines(t, lines, i, matcher, contextLines);
            if (hit) {
              hits.push(hit);
              if (filesMode) return;   // one hit per file is enough for files-mode
            }
          }
        });
      }

      log.info('grep_files completed', {
        user_id: maskId(opts.userId),
        pattern_chars: pattern.length,
        use_regex: useRegex,
        hits: hits.length,
        scanned,
        extracted,
        skipped,
        backend: rgHandledRoots.size ? 'rg' : [...enumerationBackends].join('+'),
      });
      if (!hits.length) {
        return {
          content:
            `No matches for ${useRegex ? `/${pattern}/${caseSensitive ? '' : 'i'}` : `"${pattern}"`}.\n`
            + `scanned=${scanned} extracted=${extracted} skipped=${skipped}`,
        };
      }
      const tail =
        `  scanned=${scanned} extracted=${extracted} skipped=${skipped} `
        + `backend=${rgHandledRoots.size ? 'rg' : [...enumerationBackends].join('+') || 'walk'}`;
      const visibleHits = requestedRootResolution?.skillRef
        ? hits.map((hit) => ({
          ...hit,
          path: displayDescendantPath(hit.path, requestedRoot, requestedRootDisplay),
        }))
        : hits;
      const capped = visibleHits.length >= maxResults;
      if (mode === 'files') {
        const files = [...new Set(visibleHits.map((h) => h.path))];
        const header = `${files.length} file(s) with matches`
          + (capped ? ` (capped — narrow with glob)` : '') + tail;
        return { content: `${header}\n${files.map((f) => `  ${f}`).join('\n')}` };
      }
      if (mode === 'count') {
        const counts = new Map<string, number>();
        for (const h of visibleHits) counts.set(h.path, (counts.get(h.path) || 0) + 1);
        const body = [...counts.entries()].map(([p, n]) => `  ${p}: ${n}`).join('\n');
        const header = `${counts.size} file(s), ${hits.length} match(es)`
          + (capped ? ` (capped at ${maxResults})` : '') + tail;
        return { content: `${header}\n${body}` };
      }
      const lines = visibleHits.flatMap((h) => [
        ...h.before.map((entry) => `  ${h.path}-${entry.line}-  ${entry.text}`),
        `  ${h.path}:${h.line}:${h.column}  ${h.snippet}`,
        ...h.after.map((entry) => `  ${h.path}+${entry.line}+  ${entry.text}`),
      ]);
      const header = `${hits.length} match(es)`
        + (capped ? ` (capped at ${maxResults})` : '') + tail;
      return { content: `${header}\n${lines.join('\n')}` };
    },
  };
}

/** Scan `path.parse(absPath).dir` for siblings matching `<name>-N<ext>` —
 *  the shape produced by `util/uniquify-path.uniquifyPath` when an earlier
 *  write hit a collision. Returned newest-first by N. Tolerates a missing
 *  parent dir (returns []). Used by `read_file`'s ENOENT branch as a hint
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

function snippetFromLine(line: string, matcher: RegExp): string {
  const m = matcher.exec(line);
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
// file tool enforces. This override applies the same scope gate as read_file.
function createListFilesTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'list_files',
    executionMode: 'parallel',
    description:
      'List files and subdirectories in a visible directory. Output lines are "d <name>" for directories and "f <name>" for files.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Visible absolute directory, or @skill/<read-ref>[/relative-path] for a Skill advertised in this run.' },
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
    createReadFileTool(opts),
    createReadFilesTool(opts),
    createStatFileTool(opts),
    ...(opts.includeOcrFile ? [createOcrFileTool(opts)] : []),
    createSearchFilesTool(opts),
    createGrepFilesTool(opts),
    createListFilesTool(opts),
  ];
}

function isInsideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
