/**
 * Local-machine tool wrappers injected into every AgentRunner built by
 * this app.
 *
 * Four tools:
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

import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { bashTool as coreBashTool, writeFileTool as coreWriteFileTool } from '../../../core-agent/src/tools/builtin';
import { getLocalExecGranted } from '../../features/permissions';
import { markdownToPdf, htmlToPdf } from '../../util/md-to-pdf';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { createLogger } from '../../logger';

const log = createLogger('local-tools');

export interface LocalToolsOpts {
  /** Active uid. Reserved for tools that need user-scoped resolution
   *  (none currently — kept on the signature for forward compatibility
   *  and so existing callers don't have to change). */
  userId?: string;
  /** Fires with absolute path after every successful write (write_file,
   * markdown_to_pdf, html_to_pdf). Lets chats.ts surface produced files
   * to the UI. */
  onFileWritten?: (absPath: string) => void;
  /** Predicate: returns true when the given absolute path was already
   *  written by this caller in the current scope (typically: a Set
   *  populated by `onFileWritten` this turn). When true, the wrapped
   *  tool overwrites in place — the refinement pattern. When false /
   *  absent, an existing file at the target is treated as a foreign
   *  collision and uniquify (`-2 / -3 / ...`) kicks in. */
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
      return coreBashTool.execute(input, ctx);
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
    createMarkdownToPdfTool(opts),
    createHtmlToPdfTool(opts),
  ];
}

export { createFileTools } from './file-tools';

/** Exposed for tests / diagnostics. */
export { DENY_MESSAGE };
