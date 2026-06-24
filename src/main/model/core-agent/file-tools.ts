/**
 * File-scoped tools injected into every main-conv runner.
 *
 *   - `read_file`     — read a slice of a file's text by char offsets. All
 *                       kinds use `charStart` / `charEnd` (0-based, half-open);
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
 * first verify the target falls under
 *   [ active workspace dir, chat_attachments/<cid>/, caller-provided extra roots ].
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
import { chatAttachmentDir, userMarketplaceSkillsDir, userSkillsDir } from '../../paths';
import { getWorkspacePath } from '../../features/user_workspace';
import { isPathAllowed } from '../../util/path-sandbox';
import { macosTccSensitivePath } from '../../util/macos-tcc';
import { parseSkillPath } from '../../features/expert_signals/skill_path';
import { isSkillEnabled } from '../../features/component_enabled';
import { recordRead } from './read-tracker';

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
  /** Current conversation id. Scopes file tools to this cid's attachment
   *  dir (in addition to the user's active workspace). Omitted = no
   *  attachment scope (workspace-only). */
  cid?: string;
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
  } catch (err) { log.warn(`resolve workspace: ${(err as Error).message}`); }
  if (opts.cid) {
    try { roots.push(chatAttachmentDir(opts.userId, opts.cid)); }
    catch (err) { log.warn(`resolve attachment dir: ${(err as Error).message}`); }
  }
  if (opts.extraRoots?.length) {
    for (const r of opts.extraRoots) if (r) roots.push(r);
  }
  if (opts.readOnlyExtraRoots?.length) {
    for (const r of opts.readOnlyExtraRoots) if (r) roots.push(r);
  }
  return roots;
}

function resolveAbs(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.workingDir ?? '.', p);
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

function guardPath(opts: FileToolsOpts, abs: string): string | null {
  if (!isPathAllowed(abs, allowedRoots(opts))) {
    return errText(
      'E_PATH_OUT_OF_SCOPE',
      `path is outside the current conversation's visible scope (workspace + attachments + user-granted folders): ${abs}. `
      + 'If the user needs this folder, ask them to authorize it under "Settings → Folder Access" — do not retry until they do.',
    );
  }
  return null;
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

// ── read_file ─────────────────────────────────────────────────────────────

function createReadFileTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'read_file',
    executionMode: 'parallel',
    description:
      'Read a slice of a file\'s text by absolute path.\n'
      + '\n'
      + 'Parameters:\n'
      + '  path      — required. Must be inside the current workspace or this conversation\'s attachment dir.\n'
      + '  charStart — 0-based inclusive start offset. Default 0.\n'
      + '  charEnd   — 0-based exclusive end offset.  Default = total_chars (end of file).\n'
      + '\n'
      + 'Response header:\n'
      + '  <file path="..." kind="..." total_chars="N" covered="a-b" lines="x-y"> … </file>\n'
      + '  `covered` echoes the clamped [charStart, charEnd) actually returned; `lines` is the\n'
      + '  absolute line range shown.\n'
      + '\n'
      + 'Body format:\n'
      + '  Each line is prefixed with its absolute line number and a tab: `<n>\\t<line text>`.\n'
      + '  The `<n>\\t` prefix is a DISPLAY annotation, NOT part of the file — when you pass text\n'
      + '  back to `edit_file` as old_string, use the raw line WITHOUT the number+tab prefix.\n'
      + '\n'
      + 'How to use:\n'
      + '  - Whole file: omit charStart/charEnd. Header tells you total_chars.\n'
      + '  - Continue: set charStart = previous response\'s covered end.\n'
      + '  - total_chars is usually already in the `<attachments>` manifest or in a prior\n'
      + '    `search_files` hit — use it to plan charStart/charEnd.\n'
      + '  - If a PDF or modern Office file has never been read/stated before, this tool returns E_NEED_STAT.\n'
      + '    Call `stat_file(path)` first to trigger extraction, then come back.\n'
      + '  - Legacy Office files (.doc/.xls/.ppt) return E_UNSUPPORTED_FILE; ask the user\n'
      + '    for a .docx/.xlsx/.pptx export if the content is required.\n'
      + '  - For image kind, no range applies; a compressed grayscale JPEG is returned inline\n'
      + '    as a user-turn image.\n'
      + '\n'
      + 'The server does NOT truncate and has NO size cap — you receive exactly the range you ask for.\n'
      + 'You are responsible for your own context budget.',
    inputSchema: {
      type: 'object',
      properties: {
        path:      { type: 'string', description: 'Absolute path. Must be inside workspace or current attachment dir.' },
        charStart: { type: 'number', description: '0-based start char (inclusive). Default 0.' },
        charEnd:   { type: 'number', description: '0-based end char (exclusive). Default total_chars.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const raw = String(input.path ?? '');
      if (!raw) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const abs = resolveAbs(ctx, raw);

      const scopeErr = guardPath(opts, abs);
      if (scopeErr) {
        log.warn(`read_file scope reject user=${opts.userId} path=${abs}`);
        return { content: scopeErr, isError: true };
      }
      const disabledSkillErr = guardDisabledSkillAccess(opts, abs);
      if (disabledSkillErr) {
        log.warn(`read_file disabled skill reject user=${opts.userId} path=${abs}`);
        return { content: disabledSkillErr, isError: true };
      }

      try { fs.statSync(abs); }
      catch (err) {
        const siblings = findUniquifySiblings(abs);
        log.warn(`read_file not-found user=${opts.userId} path=${abs}: ${(err as Error).message}`);
        let content = errText('E_NOT_FOUND', `${abs}: ${(err as Error).message}`);
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
      try {
        if (kind === 'image') {
          const img = await readImageAsGrayJpeg(opts.userId, abs);
          const header = `<file path="${abs}" kind="image" bytes="${img.bytes}" compressed="${img.width}x${img.height} gray JPEG q=70"/>`;
          log.info(`read_file user=${opts.userId} kind=image bytes=${img.bytes} path=${abs}`);
          return {
            content: `${header}\nImage loaded — the compressed grayscale JPEG follows as a user-turn image.`,
            images: [{ data: img.base64, mediaType: img.mediaType }],
          };
        }

        const result = await readRange(opts.userId, abs, {
          ...(typeof input.charStart === 'number' ? { charStart: input.charStart } : {}),
          ...(typeof input.charEnd   === 'number' ? { charEnd:   input.charEnd   } : {}),
        });

        const total = result.meta.totalChars ?? 0;
        const cs = result.range.charStart;
        const ce = result.range.charEnd;
        // Number the lines for display (the model thinks in lines for code);
        // char offsets remain the addressing/paging unit.
        const { text: numberedContent, lastLine } = addLineNumbers(result.content, result.startLine);
        const attrs = [
          `path="${abs}"`,
          `kind="${kind}"`,
          `total_chars="${total}"`,
          `covered="${cs}-${ce}"`,
          `lines="${result.startLine}-${lastLine}"`,
          ...(result.meta.extractionEmpty ? ['extraction="empty_pages"'] : []),
        ];
        const header = `<file ${attrs.join(' ')}>`;
        log.info(
          `read_file user=${opts.userId} kind=${kind} covered=${cs}-${ce} total=${total} path=${abs}`,
        );
        // skill_invoked attribution: when the LLM read_file's a SKILL.md
        // body, the body is the progressive-disclosure "use this skill"
        // signal (per Claude Code conventions). Emit AFTER the successful
        // text read — image / rich-document SKILL.md is not a real shape.
        if (opts.onSkillInvoked) {
          const parsed = parseSkillPath(abs, opts.userId);
          if (parsed) {
            try { opts.onSkillInvoked(parsed.skill_id, parsed.system, 'read_file'); }
            catch (err) { log.warn(`onSkillInvoked callback failed: ${(err as Error).message}`); }
          }
        }
        // Stamp the read-state baseline so a later edit_file accepts an edit
        // built on these bytes (read-before-edit) and rejects it if the file
        // changed since (OCC). See read-tracker.ts.
        recordRead(ctx, abs);
        return { content: `${header}\n${numberedContent}\n</file>` };
      } catch (err) {
        if (err instanceof NeedStatError) {
          log.warn(`read_file need-stat user=${opts.userId} kind=${err.kind} path=${abs}`);
          return {
            content: errText(
              'E_NEED_STAT',
              `${abs}: ${err.kind} has not been extracted yet. Call stat_file(path=...) first to get total_chars, then call read_file with charStart/charEnd.`,
            ),
            isError: true,
          };
        }
        if (err instanceof NoTextError) {
          log.warn(`read_file no-text user=${opts.userId} path=${abs}`);
          return { content: errText('E_NO_TEXT', `${abs}: image has no text representation`), isError: true };
        }
        if (err instanceof UnsupportedFileKindError) {
          log.warn(`read_file unsupported user=${opts.userId} kind=${err.kind} path=${abs}`);
          return {
            content: errText(
              'E_UNSUPPORTED_FILE',
              `${abs}: ${err.kind} cannot be read by the model. Convert it to .docx/.xlsx/.pptx and attach again.`,
            ),
            isError: true,
          };
        }
        const msg = (err as Error).message;
        log.warn(`read_file failed user=${opts.userId} path=${abs}: ${msg}`);
        return { content: errText('E_READ_FAILED', msg), isError: true };
      }
    },
  };
}

// ── stat_file ────────────────────────────────────────────────────────────

function createStatFileTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'stat_file',
    description:
      'Ensure a file\'s text is extracted and return its `total_chars`. Use this when the\n'
      + '`<attachments>` manifest or a `search_files` result did NOT already include\n'
      + '`total_chars` for the file — typically for a PDF or modern Office file that has never been read.\n'
      + '\n'
      + 'Parameters:\n'
      + '  path — required. Absolute path inside workspace or current attachment dir.\n'
      + '\n'
      + 'Response:\n'
      + '  <file path="..." kind="text|pdf|docx|spreadsheet|presentation" total_chars="N"/>\n'
      + '\n'
      + 'Notes:\n'
      + '  - Skip this call when total_chars is already provided — go straight to read_file.\n'
      + '  - This tool does pdfjs / mammoth / OOXML extraction; first call on a large\n'
      + '    document may take a few seconds, subsequent read_file calls hit the cache instantly.\n'
      + '  - Returns E_NO_TEXT for image kind; images are displayed via read_file directly.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path. Must be inside workspace or current attachment dir.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const raw = String(input.path ?? '');
      if (!raw) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const abs = resolveAbs(ctx, raw);

      const scopeErr = guardPath(opts, abs);
      if (scopeErr) {
        log.warn(`stat_file scope reject user=${opts.userId} path=${abs}`);
        return { content: scopeErr, isError: true };
      }
      const disabledSkillErr = guardDisabledSkillAccess(opts, abs);
      if (disabledSkillErr) {
        log.warn(`stat_file disabled skill reject user=${opts.userId} path=${abs}`);
        return { content: disabledSkillErr, isError: true };
      }

      try { fs.statSync(abs); }
      catch (err) {
        log.warn(`stat_file not-found user=${opts.userId} path=${abs}: ${(err as Error).message}`);
        return { content: errText('E_NOT_FOUND', `${abs}: ${(err as Error).message}`), isError: true };
      }

      const kind = kindOf(abs);
      try {
        const meta = await statFile(opts.userId, abs);
        const total = meta.totalChars ?? 0;
        const emptyAttr = meta.extractionEmpty ? ' extraction="empty_pages"' : '';
        log.info(
          `stat_file user=${opts.userId} kind=${kind} total_chars=${total}`
          + `${meta.extractionEmpty ? ' extraction=empty_pages' : ''} path=${abs}`,
        );
        return {
          content: `<file path="${abs}" kind="${kind}" total_chars="${total}"${emptyAttr}/>`,
        };
      } catch (err) {
        if (err instanceof NoTextError) {
          log.warn(`stat_file no-text user=${opts.userId} path=${abs}`);
          return { content: errText('E_NO_TEXT', `${abs}: image has no text representation`), isError: true };
        }
        if (err instanceof UnsupportedFileKindError) {
          log.warn(`stat_file unsupported user=${opts.userId} kind=${err.kind} path=${abs}`);
          return {
            content: errText(
              'E_UNSUPPORTED_FILE',
              `${abs}: ${err.kind} cannot be read by the model. Convert it to .docx/.xlsx/.pptx and attach again.`,
            ),
            isError: true,
          };
        }
        const msg = (err as Error).message;
        log.warn(`stat_file failed user=${opts.userId} path=${abs}: ${msg}`);
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
      'Run local OCR on visual text in a file and return Markdown. Use this when read_file/stat_file cannot recover text from visual content: scanned PDFs, image-only PDF pages, screenshots, photos of documents, or text embedded in images. For normal text PDFs/Office files, use stat_file/read_file first. For mixed PDFs, combine read_file text with ocr_file visual text.\n'
      + '\n'
      + 'Parameters:\n'
      + '  path  — required. Absolute path inside the current workspace or this conversation\'s attachment dir.\n'
      + '  pages — optional for PDFs. Page list/ranges like "1-3,5". Omit to OCR all pages.\n'
      + '\n'
      + 'Supported inputs in this version: PDF pages and image files (.png/.jpg/.jpeg/.webp/.gif). Office documents should be read with read_file; embedded-image OCR for Office is not supported yet.\n'
      + 'The OCR engine is local RapidOCR + ONNXRuntime and does not consume cloud model credits. If the local OCR runtime is not installed, this tool installs it into Orkas\'s managed runtime directory. If this tool returns an E_OCR_* error, do not try to install or repair OCR dependencies with bash/pip/uv; report the tool error and process log.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path. Must be inside workspace or current attachment dir.' },
        pages: { type: 'string', description: 'Optional PDF pages, e.g. "1-3,5". Omit to OCR all pages.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const raw = String(input.path ?? '');
      if (!raw) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const abs = resolveAbs(ctx, raw);

      const scopeErr = guardPath(opts, abs);
      if (scopeErr) {
        log.warn(`ocr_file scope reject user=${opts.userId} path=${abs}`);
        return { content: scopeErr, isError: true };
      }
      const disabledSkillErr = guardDisabledSkillAccess(opts, abs);
      if (disabledSkillErr) {
        log.warn(`ocr_file disabled skill reject user=${opts.userId} path=${abs}`);
        return { content: disabledSkillErr, isError: true };
      }
      try { fs.statSync(abs); }
      catch (err) {
        log.warn(`ocr_file not-found user=${opts.userId} path=${abs}: ${(err as Error).message}`);
        return { content: errText('E_NOT_FOUND', `${abs}: ${(err as Error).message}`), isError: true };
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
        const repairHint = '\n\nDo not install or repair OCR dependencies with bash/pip/uv; ocr_file owns its local runtime.';
        return { content: errText(result.errorCode, `${result.message}${processBlock}${repairHint}`), isError: true };
      }
      log.info(`ocr_file user=${opts.userId} kind=${kind} cached=${result.cached} path=${abs}`);
      return { content: result.content };
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

function walkFiles(root: string, max: number): { files: string[]; skippedReason?: string } {
  const out: string[] = [];
  if (!root) return { files: out };
  const protectedRoot = macosTccSensitivePath(path.resolve(root), { recursive: true });
  if (protectedRoot) return { files: out, skippedReason: protectedRoot.reason };
  let rootStat: fs.Stats;
  try { rootStat = fs.statSync(root); }
  catch { return { files: out }; }
  if (!rootStat.isDirectory()) return { files: out };

  const stack: string[] = [root];
  while (stack.length && out.length < max) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        out.push(p);
        if (out.length >= max) break;
      }
    }
  }
  return { files: out };
}

function createSearchFilesTool(opts: FileToolsOpts): AgentTool {
  return {
    name: 'search_files',
    executionMode: 'parallel',
    description:
      'Discover files when you do NOT already have the path. Scans the active workspace +\n'
      + 'the current conversation\'s attachment dir.\n'
      + 'Query forms:\n'
      + '  • substring (case-insensitive): "contract" matches "Contract_v2.pdf"\n'
      + '  • glob:                         "*.pdf", "design*"\n'
      + 'Returns each hit with path/name/size/mtime/ext/source. If the file\'s text has\n'
      + 'already been extracted (cache hit), `total_chars` is also included — use it to\n'
      + 'plan read_file without an extra stat_file round-trip. If `total_chars` is absent,\n'
      + 'you need `stat_file(path)` before your first read_file on that file.\n'
      + 'This tool does NOT trigger extract — it stays cheap even over large directories.\n'
      + 'Use this when:\n'
      + '  • the user names a file that is NOT in the current <attachments> block — try here\n'
      + '    before telling them the file is missing; the workspace is in scope too\n'
      + '  • the user refers to a file by a fuzzy phrase ("the contract")\n'
      + '  • exploring the workspace for files matching a pattern\n'
      + 'Do NOT call this on a filename that is already listed in <attachments> — the `path`\n'
      + 'attribute there is the authoritative absolute path; feed it straight to `read_file`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring or glob. Omit to list everything.' },
      },
    },
    async execute(input) {
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
        rootKinds.push({ root: chatAttachmentDir(opts.userId, opts.cid), source: 'attachment' });
      }
      for (const root of [...(opts.extraRoots || []), ...(opts.readOnlyExtraRoots || [])]) {
        if (root) rootKinds.push({ root, source: 'extra' });
      }

      const hits: SearchHit[] = [];
      const skippedScans: string[] = [];
      let budget = MAX_SCAN_FILES;
      for (const { root, source } of rootKinds) {
        if (budget <= 0) break;
        const scan = walkFiles(root, budget);
        if (scan.skippedReason) {
          skippedScans.push(`${source}:${scan.skippedReason}`);
          continue;
        }
        const files = scan.files;
        budget -= files.length;
        for (const abs of files) {
          const name = path.basename(abs);
          if (!matcher(name)) continue;
          let st: fs.Stats;
          try { st = fs.statSync(abs); }
          catch { continue; }
          const ext = path.extname(name).toLowerCase();
          const hit: SearchHit = {
            path: abs,
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
      const shown = total > MAX_SEARCH_RESULTS ? hits.slice(0, MAX_SEARCH_RESULTS) : hits;
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
      log.info(`search_files user=${opts.userId} query="${query}" hits=${total} shown=${shown.length}`);
      const header = total > shown.length
        ? `${total} match(es), showing the ${MAX_SEARCH_RESULTS} most recently modified:`
        : `${total} match(es):`;
      return { content: `${header}\n${lines.join('\n')}` };
    },
  };
}

// ── grep_files ───────────────────────────────────────────────────────────

interface GrepHit {
  path: string;
  line: number;
  snippet: string;
  source: 'attachment' | 'workspace' | 'extra';
}

/** Minimal glob → RegExp for grep_files scoping. `*` = a run of non-slash
 *  chars, `**` = any directories, `?` = one non-slash char. A glob WITHOUT
 *  `/` is matched against the basename at any depth (e.g. `*.ts`); a glob WITH
 *  `/` is matched against the path relative to its root (e.g. `src/**`). */
function grepGlobToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // escape regex specials, keep * ? /
  const re = esc
    .replace(/\*\*\//g, '(?:.*/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp('^' + re + '$', 'i');
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
        regex: { type: 'boolean', description: 'Default false — treat pattern as a case-insensitive substring.' },
        glob: { type: 'string', description: 'Optional. Limit the search to files matching this glob. No "/" → match the basename at any depth (e.g. "*.ts", "*.{vue}"); with "/" → match the path relative to its root (e.g. "src/**", "src/**/*.ts"). Use it to cut noise + tokens on large projects.' },
        output_mode: { type: 'string', enum: ['content', 'files', 'count'], description: 'content (default): one line per match. files: just the file paths that contain a match — much cheaper when you only need which files. count: number of matches per file.' },
      },
      required: ['pattern'],
    },
    async execute(input) {
      const pattern = String(input.pattern ?? '');
      if (!pattern) {
        return { content: errText('E_BAD_INPUT', '`pattern` is required'), isError: true };
      }
      const useRegex = input.regex === true;
      let matcher: RegExp;
      try {
        matcher = useRegex
          ? new RegExp(pattern, 'i')
          : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      } catch (err) {
        return { content: errText('E_BAD_INPUT', `invalid regex: ${(err as Error).message}`), isError: true };
      }

      const globStr = typeof input.glob === 'string' ? input.glob.trim() : '';
      const globHasSlash = globStr.includes('/');
      let globRe: RegExp | null = null;
      if (globStr) { try { globRe = grepGlobToRegExp(globStr); } catch { globRe = null; } }
      const mode: 'content' | 'files' | 'count' =
        input.output_mode === 'files' || input.output_mode === 'count' ? input.output_mode : 'content';
      const filesMode = mode === 'files';

      const rootKinds: Array<{ root: string; source: 'attachment' | 'workspace' | 'extra' }> = [];
      try { rootKinds.push({ root: getWorkspacePath(opts.userId, opts.projectId), source: 'workspace' }); }
      catch { /* workspace unavailable */ }
      if (opts.cid) rootKinds.push({ root: chatAttachmentDir(opts.userId, opts.cid), source: 'attachment' });
      for (const root of [...(opts.extraRoots || []), ...(opts.readOnlyExtraRoots || [])]) {
        if (root) rootKinds.push({ root, source: 'extra' });
      }
      if (!rootKinds.length) {
        return { content: errText('E_NO_SCOPE', 'no visible roots for this conversation'), isError: true };
      }

      const targets: Array<{ abs: string; source: 'attachment' | 'workspace' | 'extra'; root: string }> = [];
      const skippedScans: string[] = [];
      let budget = MAX_SCAN_FILES;
      for (const { root, source } of rootKinds) {
        if (budget <= 0) break;
        const scan = walkFiles(root, budget);
        if (scan.skippedReason) {
          skippedScans.push(`${source}:${scan.skippedReason}`);
          continue;
        }
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
      const scoped = globRe
        ? targets.filter((t) => {
            const cmp = globHasSlash
              ? path.relative(t.root, t.abs).split(path.sep).join('/')
              : path.basename(t.abs);
            return globRe!.test(cmp);
          })
        : targets;
      if (globRe && !scoped.length) {
        return { content: `No files matched glob "${globStr}" in the visible scope.` };
      }

      let scanned = 0, skipped = 0, extracted = 0;
      const hits: GrepHit[] = [];

      // Split into text-direct vs extract-required buckets. Text bucket is
      // fast (sync read + scan); extract bucket is bounded-concurrency async.
      const textTargets = scoped.filter((t) => {
        const k = kindOf(t.abs);
        if (k === 'image') return false;
        return k === 'text';
      });
      const extractTargets = scoped.filter((t) => {
        const k = kindOf(t.abs);
        return isExtractableRichKind(k);
      });
      // Images + unknown → skipped
      skipped += scoped.length - textTargets.length - extractTargets.length;

      // Text bucket — async, non-blocking line scan: read each file off the
      // event loop and yield every GREP_YIELD_EVERY files, so a large workspace
      // can't stall the main process (was a synchronous readFileSync loop).
      let sinceYield = 0;
      for (const t of textTargets) {
        if (hits.length >= MAX_GREP_MATCHES) break;
        scanned++;
        if (++sinceYield >= GREP_YIELD_EVERY) { sinceYield = 0; await new Promise<void>((r) => setImmediate(r)); }
        let body: string;
        try { body = await fs.promises.readFile(t.abs, 'utf8'); }
        catch { continue; }
        const lines = body.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matcher.test(lines[i])) {
            hits.push({ path: t.abs, line: i + 1, snippet: snippetFromLine(lines[i], matcher), source: t.source });
            if (filesMode) break;   // files/count: one snippet per file is enough for files-mode
            if (hits.length >= MAX_GREP_MATCHES) break;
          }
        }
      }

      // Extract bucket — parallel extract with cache, then line scan.
      if (hits.length < MAX_GREP_MATCHES && extractTargets.length) {
        await pMapLimit(extractTargets, GREP_EXTRACT_CONCURRENCY, async (t) => {
          if (hits.length >= MAX_GREP_MATCHES) return;
          scanned++;
          let text: string;
          try {
            const { text: got } = await getExtractedText(opts.userId, t.abs);
            text = got;
            extracted++;
          } catch (err) {
            log.warn(`grep_files: extract failed ${t.abs}: ${(err as Error).message}`);
            return;
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (hits.length >= MAX_GREP_MATCHES) return;
            if (matcher.test(lines[i])) {
              hits.push({ path: t.abs, line: i + 1, snippet: snippetFromLine(lines[i], matcher), source: t.source });
              if (filesMode) return;   // one hit per file is enough for files-mode
            }
          }
        });
      }

      log.info(
        `grep_files user=${opts.userId} pattern=${useRegex ? `/${pattern}/i` : `"${pattern}"`}`
        + ` hits=${hits.length} scanned=${scanned} extracted=${extracted} skipped=${skipped}`,
      );
      if (!hits.length) {
        return {
          content:
            `No matches for ${useRegex ? `/${pattern}/i` : `"${pattern}"`}.\n`
            + `scanned=${scanned} extracted=${extracted} skipped=${skipped}`,
        };
      }
      const tail = `  scanned=${scanned} extracted=${extracted} skipped=${skipped}`;
      const capped = hits.length >= MAX_GREP_MATCHES;
      if (mode === 'files') {
        const files = [...new Set(hits.map((h) => h.path))];
        const header = `${files.length} file(s) with matches`
          + (capped ? ` (capped — narrow with glob)` : '') + tail;
        return { content: `${header}\n${files.map((f) => `  ${f}`).join('\n')}` };
      }
      if (mode === 'count') {
        const counts = new Map<string, number>();
        for (const h of hits) counts.set(h.path, (counts.get(h.path) || 0) + 1);
        const body = [...counts.entries()].map(([p, n]) => `  ${p}: ${n}`).join('\n');
        const header = `${counts.size} file(s), ${hits.length} match(es)`
          + (capped ? ` (capped at ${MAX_GREP_MATCHES})` : '') + tail;
        return { content: `${header}\n${body}` };
      }
      const lines = hits.map((h) => `  ${h.path}:${h.line}  ${h.snippet}`);
      const header = `${hits.length} match(es)`
        + (capped ? ` (capped at ${MAX_GREP_MATCHES})` : '') + tail;
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
      'List the entries (files and subdirectories) of a directory by absolute path.\n'
      + '\n'
      + 'Parameters:\n'
      + '  path — required. Must be inside the current workspace, this conversation\'s\n'
      + '         attachment dir, or a user-granted folder.\n'
      + '\n'
      + 'Each line is `d <name>` for a directory or `f <name>` for a file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path. Must be inside the conversation\'s visible scope.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const raw = String(input.path ?? '');
      if (!raw) return { content: errText('E_BAD_INPUT', '`path` is required'), isError: true };
      const abs = resolveAbs(ctx, raw);

      const scopeErr = guardPath(opts, abs);
      if (scopeErr) {
        log.warn(`list_files scope reject user=${opts.userId} path=${abs}`);
        return { content: scopeErr, isError: true };
      }
      const disabledSkillErr = guardDisabledSkillAccess(opts, abs);
      if (disabledSkillErr) {
        log.warn(`list_files disabled skill reject user=${opts.userId} path=${abs}`);
        return { content: disabledSkillErr, isError: true };
      }

      try {
        const entries = await fs.promises.readdir(abs, { withFileTypes: true });
        const lines = entries.map((e) => `${e.isDirectory() ? 'd' : 'f'} ${e.name}`);
        return { content: lines.join('\n') };
      } catch (err) {
        log.warn(`list_files failed user=${opts.userId} path=${abs}: ${(err as Error).message}`);
        return { content: errText('E_LIST_FAILED', `${abs}: ${(err as Error).message}`), isError: true };
      }
    },
  };
}

export function createFileTools(opts: FileToolsOpts): AgentTool[] {
  return [
    createReadFileTool(opts),
    createStatFileTool(opts),
    createOcrFileTool(opts),
    createSearchFilesTool(opts),
    createGrepFilesTool(opts),
    createListFilesTool(opts),
  ];
}
