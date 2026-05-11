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
 * Note on `bash`: shell-side writes (`cat > foo.py`, `tee`, etc.) bypass
 * this conflict protection by design — bash is a black box from this
 * wrapper's perspective. Prompts shouldn't claim otherwise.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { bashTool as coreBashTool, writeFileTool as coreWriteFileTool } from '../../../core-agent/src/tools/builtin';
import { getLocalExecGranted } from '../../features/permissions';
import { markdownToPdf, htmlToPdf } from '../../util/md-to-pdf';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { isPathAllowed } from '../../util/path-sandbox';
import { kindOf } from '../../features/file_indexer';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDir } from '../../paths';
import { createLogger } from '../../logger';

const log = createLogger('local-tools');

export interface LocalToolsOpts {
  /** Active uid. Used by `edit_file` to resolve workspace + attachment
   *  sandbox roots; also reserved for future tools that need user-scoped
   *  resolution. Optional so the catalog drift test can call
   *  `createLocalTools({})` without runtime user state. */
  userId?: string;
  /** Current conversation id. Used by `edit_file` to add the current
   *  conv's attachment dir to the sandbox. Without it, only the workspace
   *  (+ extraRoots) is editable. */
  cid?: string;
  /** Project id of the current conversation, when it belongs to one.
   *  Threaded through from group_chat at runTurn so workspace resolution
   *  picks up the project-scoped selection (per CLAUDE.md projects feature).
   *  Empty / missing → default-scope workspace. */
  projectId?: string;
  /** Extra absolute directory roots `edit_file` should treat as in-scope
   *  on top of workspace + attachment. Used by skill-edit / agent-edit
   *  chats so the LLM can edit files inside the skill / agent dir. */
  extraRoots?: readonly string[];
  /** Fires with absolute path after every successful write (write_file,
   * edit_file, markdown_to_pdf, html_to_pdf). Lets chats.ts surface
   * produced files to the UI. */
  onFileWritten?: (absPath: string) => void;
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
  'Local execution is not authorised for this machine. ' +
  'The user must open Settings → Local Execution and grant permission before this tool can run.';

function deniedResult(): ToolResult {
  return { content: DENY_MESSAGE, isError: true };
}

function resolveAbs(ctx: ToolContext, p: string): string {
  return path.resolve(ctx.workingDir ?? '.', p);
}

function isMineFor(opts: LocalToolsOpts): (p: string) => boolean {
  const fn = opts.hasProducedPath;
  return fn ? (p) => fn(p) : () => false;
}

function errText(code: string, msg: string): string {
  return `${code}: ${msg}`;
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

/** Wrapped `bash` tool — identical schema, permission-gated, host-shell wording. */
function createBashTool(): AgentTool {
  return {
    name: 'bash',
    description:
      'Execute a shell command on the user\'s local machine and return its output. ' +
      'Use for installing CLIs (brew, npm, pip), running builds, converting files, ' +
      'inspecting the filesystem, and any other host-side work. The shell runs in ' +
      'the user\'s current workspace directory.',
    inputSchema: coreBashTool.inputSchema,
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();
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
      if (!ctx.workingDir) return coreBashTool.execute(input, ctx);
      if (fs.existsSync(ctx.workingDir)) {
        return coreBashTool.execute(input, ctx);
      }
      try { fs.mkdirSync(ctx.workingDir, { recursive: true }); }
      catch { /* let spawn produce the canonical error */ }
      try {
        return await coreBashTool.execute(input, ctx);
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

/** Build the array of local-machine tools for a single runner. */
export function createLocalTools(opts: LocalToolsOpts = {}): AgentTool[] {
  return [
    createBashTool(),
    createWriteFileTool(opts),
    createEditFileTool(opts),
    createMarkdownToPdfTool(opts),
    createHtmlToPdfTool(opts),
  ];
}

export { createFileTools } from './file-tools';

/** Exposed for tests / diagnostics. */
export { DENY_MESSAGE };
