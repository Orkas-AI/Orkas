/**
 * Office document tools backed by the bundled OfficeCLI engine
 * (`features/office/office_engine.ts`). Tier-1 built-in capability: a
 * non-technical user asks for a Word/Excel/PPT file in the main chat and gets
 * one, zero-config, cross-platform (incl. Windows), no MS Office installed.
 *
 * Tools: `create_docx`, `create_xlsx`, `create_pptx` (create → batch-fill →
 * first-page PNG preview) and `office_render` (preview an existing doc). They
 * follow the same conventions as `local-tools.ts`: re-read the local-execution
 * permission on every call, path-sandbox to the conversation's scope,
 * uniquify-on-collision, and fire `onFileWritten` so the produced-file chip
 * shows. The OfficeCLI resident daemon is always reaped in a `finally`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult, ToolResultImage } from '#core-agent';
import { getLocalExecGranted } from '../../features/permissions';
import { isPathAllowed } from '../../util/path-sandbox';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { officeCliAvailable, runOfficeCli, closeOfficeFile, OfficeCliError } from '../../features/office/office_engine';
import {
  buildDocxBatch, buildXlsxWorkbookBatch, buildPptxBatch, buildEditBatch,
  type DocxParagraphSpec, type DocxTableSpec, type DocxImageSpec,
  type XlsxCell, type XlsxSheetSpec, type PptxSlideSpec, type PptxImageSpec,
  type EditOp, type OfficeBatchOp,
} from './office-batch';
import { DENY_MESSAGE } from './local-tools';
import { createLogger } from '../../logger';
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';

const log = createLogger('office-tools');

export interface OfficeToolsOpts {
  /** Active uid — used to resolve the workspace + attachment sandbox roots. */
  userId?: string;
  /** Current conversation id — adds its attachment dir to the writable scope. */
  cid?: string;
  /** Project scope for workspace resolution. */
  projectId?: string;
  /** Extra writable/readable roots (skill-edit / agent-edit dirs). */
  extraRoots?: readonly string[];
  /** Fires with the absolute path after a successful create. */
  onFileWritten?: (absPath: string) => void | Promise<void>;
  /** True when the path was already produced by this caller this turn →
   *  overwrite in place instead of uniquifying. */
  hasProducedPath?: (absPath: string) => boolean;
}

function deniedResult(): ToolResult {
  return { content: DENY_MESSAGE, isError: true };
}

function errResult(code: string, msg: string): ToolResult {
  return { content: `${code}: ${msg}`, isError: true };
}

/** Workspace + attachment + extra roots for the current (uid, cid). Mirrors
 *  `local-tools.ts::allowedRootsFor`. */
function allowedRootsFor(opts: OfficeToolsOpts): string[] {
  const roots: string[] = [];
  if (opts.userId) {
    try {
      const ws = getWorkspacePath(opts.userId, opts.projectId);
      if (ws) roots.push(ws);
    } catch (err) { log.warn('resolve workspace failed', { user_id: maskId(opts.userId), project_id: maskId(opts.projectId), error: logErrorRef(err) }); }
    if (opts.cid) {
      try { roots.push(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
      catch (err) { log.warn('resolve attachment dir failed', { user_id: maskId(opts.userId), cid: maskId(opts.cid), error: logErrorRef(err) }); }
    }
  }
  if (opts.extraRoots?.length) {
    for (const r of opts.extraRoots) if (r) roots.push(r);
  }
  return roots;
}

function isMineFor(opts: OfficeToolsOpts): (p: string) => boolean {
  const fn = opts.hasProducedPath;
  return (p) => {
    if (fn?.(p)) return true;
    return !!opts.extraRoots?.length && isPathAllowed(path.resolve(p), opts.extraRoots);
  };
}

function guardPath(opts: OfficeToolsOpts, abs: string, action: string): string | null {
  const roots = allowedRootsFor(opts);
  if (!roots.length) return `E_NO_SCOPE: no ${action} roots for this conversation`;
  if (!isPathAllowed(abs, roots)) {
    return `E_PATH_OUT_OF_SCOPE: path is outside the conversation's ${action} scope (workspace + attachments): ${abs}`;
  }
  return null;
}

/** Resolve an embedded image `src` against the conversation's readable scope:
 *  returns the absolute path, or an error message. An image must live in the
 *  workspace / attachment scope (same sandbox as reads) and exist on disk —
 *  OfficeCLI embeds it by copying the bytes at create time. */
function resolveImagePath(opts: OfficeToolsOpts, ctx: ToolContext, rawSrc: unknown): { abs: string } | { error: string } {
  const raw = typeof rawSrc === 'string' ? rawSrc.trim() : '';
  if (!raw) return { error: 'an image requires a `src` path' };
  const abs = path.resolve(ctx.workingDir ?? '.', raw);
  const scopeErr = guardPath(opts, abs, 'readable');
  if (scopeErr) return { error: scopeErr.replace(/^E_[A-Z_]+:\s*/, '') };
  if (!fs.existsSync(abs)) return { error: `image not found: ${abs}` };
  return { abs };
}

/** Render one page to a PNG and return it as a tool-result image. Best-effort
 *  for the create-preview path; the caller decides whether a null is fatal. */
async function renderToImage(file: string, cwd: string, page: string, signal?: AbortSignal): Promise<ToolResultImage | null> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-prev-'));
  const png = path.join(dir, 'preview.png');
  try {
    const r = await runOfficeCli(['view', file, 'screenshot', '-o', png, '--page', page], {
      cwd, timeoutMs: 60_000, ...(signal ? { signal } : {}),
    });
    if (r.code !== 0 || !fs.existsSync(png)) {
      log.warn('render failed', {
        code: r.code,
        stderr_chars: r.stderr?.length || 0,
        stdout_chars: r.stdout?.length || 0,
      });
      return null;
    }
    return { data: fs.readFileSync(png).toString('base64'), mediaType: 'image/png' };
  } catch (err) {
    log.warn('render error', { error: logErrorRef(err) });
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Shared create pipeline: uniquify → create → batch-fill → preview → emit.
 *  The OfficeCLI resident is reaped in a `finally`. Caller has already checked
 *  the permission gate, engine availability, extension, and output sandbox. */
async function runCreate(
  opts: OfficeToolsOpts,
  ctx: ToolContext,
  args: { inputAbs: string; createFlags: string[]; ops: OfficeBatchOp[]; wantPreview: boolean; noun: string; unit: string },
): Promise<ToolResult> {
  // Resolve inside the try so a uniquify failure (collision exhaustion) returns
  // a ToolResult like every other error path instead of throwing past the
  // contract; finalPath/cwd default to the requested path for the finally.
  let finalPath = args.inputAbs;
  let cwd = path.dirname(finalPath);
  let renamed = false;
  try {
    ({ finalPath, renamed } = await uniquifyPath(args.inputAbs, isMineFor(opts)));
    cwd = path.dirname(finalPath);
    fs.mkdirSync(cwd, { recursive: true });

    const created = await runOfficeCli(['create', finalPath, ...args.createFlags], {
      cwd, ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (created.code !== 0) {
      return errResult('E_OFFICE_CREATE_FAILED', created.stderr || created.stdout || `exit ${created.code}`);
    }

    if (args.ops.length) {
      const batched = await runOfficeCli(['batch', finalPath], {
        cwd, stdin: JSON.stringify(args.ops), ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (batched.code !== 0) {
        return errResult('E_OFFICE_BATCH_FAILED', batched.stderr || batched.stdout || `exit ${batched.code}`);
      }
    }

    const preview = args.wantPreview ? await renderToImage(finalPath, cwd, '1', ctx.signal) : null;

    if (opts.onFileWritten) {
      try { await opts.onFileWritten(finalPath); }
      catch (err) { log.warn('onFileWritten callback failed', { path: logPathRef(finalPath), error: logErrorRef(err) }); }
    }

    const n = args.ops.length;
    const base = `${args.noun} created: ${finalPath} (${n} ${args.unit}${n === 1 ? '' : 's'})`;
    const content = renamed ? `${base}${renderRenameSignal(args.inputAbs, finalPath)}` : base;
    return { content, ...(preview ? { images: [preview] } : {}) };
  } catch (err) {
    const code = err instanceof OfficeCliError ? err.code : 'E_OFFICE_CREATE_FAILED';
    return errResult(code, (err as Error).message);
  } finally {
    await closeOfficeFile(finalPath, cwd);
  }
}

/** Validate gate + engine + extension + output sandbox, returning the resolved
 *  absolute path or a ToolResult error. */
function prepareOutput(
  opts: OfficeToolsOpts, ctx: ToolContext, input: Record<string, unknown>, ext: string,
): { abs: string } | { error: ToolResult } {
  if (!getLocalExecGranted()) return { error: deniedResult() };
  if (!officeCliAvailable()) {
    return { error: errResult('E_OFFICE_ENGINE_MISSING',
      'the built-in Office engine is not available on this build; nothing was created. Do not claim a file was created.') };
  }
  const rawPath = String(input.path ?? '');
  if (!rawPath) return { error: errResult('E_BAD_INPUT', '`path` is required') };
  const abs = path.resolve(ctx.workingDir ?? '.', rawPath);
  if (path.extname(abs).toLowerCase() !== ext) {
    return { error: errResult('E_BAD_INPUT', `this tool requires a \`${ext}\` path`) };
  }
  const scopeErr = guardPath(opts, abs, 'writable');
  if (scopeErr) {
    log.warn('office create scope reject', { user_id: maskId(opts.userId), path: logPathRef(abs), ext });
    return { error: errResult('E_PATH_OUT_OF_SCOPE', scopeErr.replace(/^E_PATH_OUT_OF_SCOPE:\s*/, '')) };
  }
  return { abs };
}

function createDocxTool(opts: OfficeToolsOpts): AgentTool {
  return {
    name: 'create_docx',
    description:
      'Create a .docx with path plus optional title, paragraphs, tables, images, locale, preview. paragraphs: [{text, style?, align?, list?, bold?, italic?, font?, size?, color?}]. tables: [{rows:[[cell]], colWidths?}]. images: [{src,width?,height?,align?}], src in workspace/attachments. Returns saved path/preview; collisions return <file-renamed>.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output .docx path (absolute or relative to the workspace).' },
        title: { type: 'string', description: 'Optional title, added as a Heading 1 paragraph at the top.' },
        paragraphs: {
          type: 'array',
          description: 'Body paragraphs, in order.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Paragraph text.' },
              style: { type: 'string', description: 'Paragraph style id, e.g. Heading1, Heading2, Normal, Quote.' },
              align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
              list: { type: 'string', enum: ['bullet', 'ordered'] },
              bold: { type: 'boolean', description: 'Bold text.' },
              italic: { type: 'boolean', description: 'Italic text.' },
              font: { type: 'string', description: 'Font family.' },
              size: { type: 'string', description: 'Font size, e.g. "14" or "14pt".' },
              color: { type: 'string', description: 'Text color, e.g. "#1F4E79".' },
              underline: { type: 'string', description: 'Underline style, e.g. "single".' },
              highlight: { type: 'string', description: 'Highlight color name, e.g. "yellow".' },
            },
            required: ['text'],
          },
        },
        tables: {
          type: 'array',
          description: 'Data tables, appended after the paragraphs.',
          items: {
            type: 'object',
            properties: {
              rows: {
                type: 'array',
                description: 'Grid of cell text, top to bottom; each row is an array of cells (left to right).',
                items: { type: 'array', items: { type: ['string', 'number'] } },
              },
              colWidths: { type: 'string', description: 'Comma-separated column widths with units, e.g. "2in,3in".' },
            },
            required: ['rows'],
          },
        },
        images: {
          type: 'array',
          description: 'Images, appended after the tables. Each src must be a file in this conversation\'s workspace/attachments.',
          items: {
            type: 'object',
            properties: {
              src: { type: 'string', description: 'Image file path (absolute or workspace-relative).' },
              width: { type: 'string', description: 'Display width with unit, e.g. "3in".' },
              height: { type: 'string', description: 'Display height with unit.' },
              align: { type: 'string', description: 'Host paragraph alignment: left/center/right.' },
            },
            required: ['src'],
          },
        },
        locale: { type: 'string', description: 'Locale tag for default fonts, e.g. "zh-CN". Recommended for CJK content.' },
        preview: { type: 'boolean', description: 'Render a first-page PNG preview. Default true.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const prep = prepareOutput(opts, ctx, input, '.docx');
      if ('error' in prep) return prep.error;
      const locale = typeof input.locale === 'string' && input.locale ? input.locale : undefined;
      if (locale) {
        const localeErr = officeArgError(locale, 'locale');
        if (localeErr) return errResult('E_BAD_INPUT', localeErr);
      }
      const paragraphs: DocxParagraphSpec[] = [];
      if (typeof input.title === 'string' && input.title) paragraphs.push({ text: input.title, style: 'Heading1' });
      if (Array.isArray(input.paragraphs)) for (const p of input.paragraphs as DocxParagraphSpec[]) paragraphs.push(p);
      const tables = Array.isArray(input.tables) ? (input.tables as DocxTableSpec[]) : [];
      const images: DocxImageSpec[] = [];
      if (Array.isArray(input.images)) {
        for (const img of input.images as DocxImageSpec[]) {
          if (!img || typeof img !== 'object') continue;
          const r = resolveImagePath(opts, ctx, img.src);
          if ('error' in r) return errResult('E_OFFICE_IMAGE', r.error);
          images.push({ ...img, src: r.abs });
        }
      }
      return runCreate(opts, ctx, {
        inputAbs: prep.abs,
        createFlags: ['--force', ...(locale ? ['--locale', locale] : [])],
        ops: buildDocxBatch(paragraphs, tables, images),
        wantPreview: input.preview !== false,
        noun: 'Word document', unit: 'paragraph',
      });
    },
  };
}

function createXlsxTool(opts: OfficeToolsOpts): AgentTool {
  return {
    name: 'create_xlsx',
    description:
      'Create a .xlsx workbook with path plus rows or sheets. rows is [[cell]], where cell is string/number or {value, formula?, format?, bold?, fill?, font.color?, font.size?, merge?}; formulas omit the leading "=". sheets: [{name, rows, columns?}]. Returns saved path/preview; collisions return <file-renamed>.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output .xlsx path (absolute or relative to the workspace).' },
        sheet: { type: 'string', description: 'Sheet name. Default "Sheet1".' },
        rows: {
          type: 'array',
          description: 'Rows of cells, top to bottom. Each row is an array of cells (left to right).',
          items: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                { type: 'number' },
                {
                  type: 'object',
                  properties: {
                    value: { type: ['string', 'number'] },
                    formula: { type: 'string', description: 'Excel formula without leading "=".' },
                    format: { type: 'string', description: 'Excel number format code, e.g. "#,##0.00", "yyyy-mm-dd".' },
                    bold: { type: 'boolean' },
                    italic: { type: 'boolean' },
                    fill: { type: 'string', description: 'Cell background color, e.g. "#1F4E79".' },
                    'font.color': { type: 'string', description: 'Text color, e.g. "#FFFFFF".' },
                    'font.size': { type: 'string', description: 'Font size, e.g. "12".' },
                    underline: { type: 'string', description: 'Underline style, e.g. "single".' },
                    halign: { type: 'string', description: 'Horizontal alignment: left/center/right.' },
                    valign: { type: 'string', description: 'Vertical alignment: top/center/bottom.' },
                    wrap: { type: 'boolean', description: 'Wrap text in the cell.' },
                    border: { type: 'string', description: 'Border on all sides, e.g. "thin".' },
                    merge: { type: 'string', description: 'Merge range anchored at this cell, e.g. "A1:C1".' },
                  },
                },
              ],
            },
          },
        },
        columns: {
          type: 'array',
          description: 'Column widths for the (default) sheet.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Column letter, e.g. "A".' },
              width: { type: 'string', description: 'Column width in character units, e.g. "18".' },
              hidden: { type: 'boolean' },
            },
            required: ['name'],
          },
        },
        sheets: {
          type: 'array',
          description: 'Multiple worksheets (use instead of top-level `sheet`/`rows`/`columns`). The first sheet reuses the default tab.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Sheet tab name.' },
              rows: { type: 'array', description: 'Rows of cells — same cell shape as the top-level `rows`.', items: { type: 'array' } },
              columns: {
                type: 'array',
                description: 'Per-column widths for this sheet.',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Column letter, e.g. "A".' },
                    width: { type: 'string', description: 'Column width in character units.' },
                    hidden: { type: 'boolean' },
                  },
                  required: ['name'],
                },
              },
            },
          },
        },
        preview: { type: 'boolean', description: 'Render a PNG preview. Default true.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const prep = prepareOutput(opts, ctx, input, '.xlsx');
      if ('error' in prep) return prep.error;
      const sheets: XlsxSheetSpec[] = Array.isArray(input.sheets) && input.sheets.length
        ? (input.sheets as XlsxSheetSpec[])
        : [{
            name: typeof input.sheet === 'string' && input.sheet ? input.sheet : 'Sheet1',
            rows: Array.isArray(input.rows) ? (input.rows as XlsxCell[][]) : [],
            ...(Array.isArray(input.columns) ? { columns: input.columns as XlsxSheetSpec['columns'] } : {}),
          }];
      return runCreate(opts, ctx, {
        inputAbs: prep.abs,
        createFlags: ['--force'],
        ops: buildXlsxWorkbookBatch(sheets),
        wantPreview: input.preview !== false,
        noun: 'Excel workbook', unit: 'cell',
      });
    },
  };
}

function createPptxTool(opts: OfficeToolsOpts): AgentTool {
  return {
    name: 'create_pptx',
    description:
      'Create a .pptx with path and slides. slides: [{title?, body?, layout?, background?, transition?, shapes?, images?, tables?}]. shapes need text/x/y/width/height plus style fields; images need src/x/y/width/height with src in workspace/attachments. Returns saved path/preview; collisions return <file-renamed>.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output .pptx path (absolute or relative to the workspace).' },
        slides: {
          type: 'array',
          description: 'Slides, in order.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Slide title (auto-placed title placeholder).' },
              body: { type: 'string', description: 'Body text (auto-placed body placeholder); use newlines for separate lines.' },
              layout: { type: 'string', description: 'Slide layout name, e.g. "Title Slide", "Title and Content".' },
              background: { type: 'string', description: 'Slide background: hex ("#RRGGBB"), scheme color ("accent1"…), or gradient ("C1-C2[-angle]").' },
              transition: { type: 'string', description: 'Slide transition name, e.g. "fade", "push", "wipe", "morph".' },
              shapes: {
                type: 'array',
                description: 'Free-positioned text boxes for a designed slide. Added on top of any title/body placeholders.',
                items: {
                  type: 'object',
                  description: 'A text box: position (x/y/width/height) plus any OfficeCLI shape style prop.',
                  properties: {
                    text: { type: 'string', description: 'Text content.' },
                    x: { type: 'string', description: 'Left position with unit, e.g. "0.65in", "120pt".' },
                    y: { type: 'string', description: 'Top position with unit.' },
                    width: { type: 'string', description: 'Width with unit.' },
                    height: { type: 'string', description: 'Height with unit.' },
                    fill: { type: 'string', description: 'Fill color, e.g. "#38BDF8" (or gradient).' },
                    color: { type: 'string', description: 'Text color, e.g. "#FFFFFF".' },
                    size: { type: 'string', description: 'Font size, e.g. "24" or "24pt".' },
                    bold: { type: 'boolean', description: 'Bold text.' },
                    align: { type: 'string', description: 'Text alignment: left/center/right.' },
                    font: { type: 'string', description: 'Font family.' },
                    geometry: { type: 'string', description: 'Preset shape, e.g. "rect", "roundRect", "ellipse". Default rect.' },
                  },
                },
              },
              images: {
                type: 'array',
                description: 'Pictures on the slide. Each src must be a file in this conversation\'s workspace/attachments.',
                items: {
                  type: 'object',
                  properties: {
                    src: { type: 'string', description: 'Image file path (absolute or workspace-relative).' },
                    x: { type: 'string', description: 'Left position with unit, e.g. "1in".' },
                    y: { type: 'string', description: 'Top position with unit.' },
                    width: { type: 'string', description: 'Width with unit.' },
                    height: { type: 'string', description: 'Height with unit.' },
                  },
                  required: ['src'],
                },
              },
              tables: {
                type: 'array',
                description: 'Tables on the slide.',
                items: {
                  type: 'object',
                  properties: {
                    rows: {
                      type: 'array',
                      description: 'Grid of cell text; each row is an array of cells.',
                      items: { type: 'array', items: { type: ['string', 'number'] } },
                    },
                    x: { type: 'string', description: 'Left position with unit.' },
                    y: { type: 'string', description: 'Top position with unit.' },
                    colWidths: { type: 'string', description: 'Comma-separated column widths, e.g. "2in,3in".' },
                  },
                  required: ['rows'],
                },
              },
            },
          },
        },
        preview: { type: 'boolean', description: 'Render a first-slide PNG preview. Default true.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const prep = prepareOutput(opts, ctx, input, '.pptx');
      if ('error' in prep) return prep.error;
      const rawSlides = Array.isArray(input.slides) ? (input.slides as PptxSlideSpec[]) : [];
      const slides: PptxSlideSpec[] = [];
      for (const s of rawSlides) {
        if (!s || typeof s !== 'object') { slides.push(s); continue; }
        if (!Array.isArray(s.images)) { slides.push(s); continue; }
        const images: PptxImageSpec[] = [];
        for (const img of s.images as PptxImageSpec[]) {
          if (!img || typeof img !== 'object') continue;
          const r = resolveImagePath(opts, ctx, img.src);
          if ('error' in r) return errResult('E_OFFICE_IMAGE', r.error);
          images.push({ ...img, src: r.abs });
        }
        slides.push({ ...s, images });
      }
      return runCreate(opts, ctx, {
        inputAbs: prep.abs,
        createFlags: ['--force'],
        ops: buildPptxBatch(slides),
        wantPreview: input.preview !== false,
        noun: 'PowerPoint deck', unit: 'slide',
      });
    },
  };
}

function createOfficeRenderTool(opts: OfficeToolsOpts): AgentTool {
  return {
    name: 'office_render',
    description:
      'Render a page of an existing Word/Excel/PowerPoint file to a PNG image so you can see how it looks ' +
      '(layout, fonts, CJK glyphs). Uses the built-in Office engine (no Microsoft Office required). ' +
      'Provide `path` (a .docx/.xlsx/.pptx in this conversation) and an optional `page` (default "1"). Returns the image.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to an existing .docx/.xlsx/.pptx (absolute or workspace-relative).' },
        page: { type: 'string', description: 'Page / slide number to render, e.g. "1". Default "1".' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();
      if (!officeCliAvailable()) {
        return errResult('E_OFFICE_ENGINE_MISSING', 'the built-in Office engine is not available on this build.');
      }
      const rawPath = String(input.path ?? '');
      if (!rawPath) return errResult('E_BAD_INPUT', '`path` is required');
      const abs = path.resolve(ctx.workingDir ?? '.', rawPath);
      const ext = path.extname(abs).toLowerCase();
      if (!['.docx', '.xlsx', '.pptx'].includes(ext)) {
        return errResult('E_BAD_INPUT', 'office_render supports .docx/.xlsx/.pptx only');
      }
      const scopeErr = guardPath(opts, abs, 'readable');
      if (scopeErr) return { content: scopeErr, isError: true };
      if (!fs.existsSync(abs)) return errResult('E_NOT_FOUND', `${abs}: file not found`);

      const page = typeof input.page === 'string' && input.page ? input.page : '1';
      const pageErr = officeArgError(page, 'page');
      if (pageErr) return errResult('E_BAD_INPUT', pageErr);
      const cwd = path.dirname(abs);
      try {
        const img = await renderToImage(abs, cwd, page, ctx.signal);
        if (!img) return errResult('E_OFFICE_RENDER_FAILED', `could not render ${abs} page ${page}`);
        return { content: `Rendered ${abs} page ${page}`, images: [img] };
      } finally {
        await closeOfficeFile(abs, cwd);
      }
    },
  };
}

/**
 * Validate a model-controlled value before it becomes an OfficeCLI argv token.
 *
 * OfficeCLI is spawned with an arg ARRAY (no shell — so no shell injection), but
 * its parser (.NET System.CommandLine) treats any token starting with `-` as an
 * OPTION rather than a positional value/option-argument. A value like
 * `--save=<path>` injected via `target` would bind `get`'s `--save` option, which
 * extracts a binary payload to an ARBITRARY path — escaping the workspace sandbox,
 * which only guards the input file, not these values. (The `--` end-of-options
 * separator is not a reliable fix here: OfficeCLI strands the trailing `--json`
 * flag and doesn't bind post-`--` tokens to the positional.) So validate each
 * model-controlled value: `page` is a positive integer, `locale` a BCP-47-style
 * tag, and `target` (free-form DOM path / CSS selector) must not look like an
 * option. Returns an error string, or null if ok.
 */
export function officeArgError(value: string, kind: 'target' | 'page' | 'locale'): string | null {
  if (typeof value !== 'string') return `\`${kind}\` must be a string.`;
  if (kind === 'page') {
    return /^[0-9]+$/.test(value) ? null : '`page` must be a positive integer (e.g. "1").';
  }
  if (kind === 'locale') {
    return /^[A-Za-z][A-Za-z0-9-]*$/.test(value) ? null : '`locale` must be a BCP-47-style tag (e.g. "zh-CN").';
  }
  // target: free-form DOM path (`/body/p[1]`) / CSS selector (`paragraph[...]`) /
  // `selected` — none start with `-`, so reject only option-like values.
  return value.startsWith('-')
    ? '`target` must not start with "-" (it would be parsed as an OfficeCLI option, not a selector/path).'
    : null;
}

function createOfficeReadTool(opts: OfficeToolsOpts): AgentTool {
  return {
    name: 'office_read',
    description:
      'Read an existing Word/Excel/PowerPoint file WITH element paths, using the built-in Office engine — so you can ' +
      'target an in-place edit afterwards. Modes: "text" (default; each line prefixed with its [/element/path], e.g. ' +
      '[/body/p[3]] …, [/Sheet1/A1] …), "outline" (document structure), "get" (one node by `target` path as JSON), ' +
      '"query" (CSS-like `target` selector as JSON). Typical flow: office_read to find the path, then edit_office to ' +
      'change it. (For plain text without paths, read_file also works and needs no tool-execution permission.)',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to an existing .docx/.xlsx/.pptx (absolute or workspace-relative).' },
        mode: { type: 'string', enum: ['text', 'outline', 'get', 'query'], description: 'Default "text".' },
        target: { type: 'string', description: 'Element path (mode "get", e.g. "/body/p[3]") or selector (mode "query"). Defaults to "/" for get.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();
      if (!officeCliAvailable()) return errResult('E_OFFICE_ENGINE_MISSING', 'the built-in Office engine is not available on this build.');
      const rawPath = String(input.path ?? '');
      if (!rawPath) return errResult('E_BAD_INPUT', '`path` is required');
      const abs = path.resolve(ctx.workingDir ?? '.', rawPath);
      if (!['.docx', '.xlsx', '.pptx'].includes(path.extname(abs).toLowerCase())) {
        return errResult('E_BAD_INPUT', 'office_read supports .docx/.xlsx/.pptx only');
      }
      const scopeErr = guardPath(opts, abs, 'readable');
      if (scopeErr) return { content: scopeErr, isError: true };
      if (!fs.existsSync(abs)) return errResult('E_NOT_FOUND', `${abs}: file not found`);

      const mode = typeof input.mode === 'string' ? input.mode : 'text';
      const target = typeof input.target === 'string' && input.target ? input.target : '';
      const targetErr = officeArgError(target, 'target');
      if (targetErr) return errResult('E_BAD_INPUT', targetErr);
      let args: string[];
      if (mode === 'get') args = ['get', abs, target || '/', '--json'];
      else if (mode === 'query') {
        if (!target) return errResult('E_BAD_INPUT', 'mode "query" requires a `target` selector');
        args = ['query', abs, target, '--json'];
      } else if (mode === 'outline') args = ['view', abs, 'outline'];
      else args = ['view', abs, 'text'];

      const cwd = path.dirname(abs);
      try {
        const r = await runOfficeCli(args, { cwd, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        if (r.code !== 0) return errResult('E_OFFICE_READ_FAILED', r.stderr || r.stdout || `exit ${r.code}`);
        return { content: r.stdout || '(empty)' };
      } finally {
        await closeOfficeFile(abs, cwd);
      }
    },
  };
}

function createEditOfficeTool(opts: OfficeToolsOpts): AgentTool {
  return {
    name: 'edit_office',
    description:
      'Edit an existing Word/Excel/PowerPoint file IN PLACE (preserving its formatting), using the built-in Office ' +
      'engine. Provide `path` and `operations`, applied in order. Each operation is one of:\n' +
      '  - {action:"set", path, props} — change an element. props.text for a paragraph/run; props.value or ' +
      'props.formula (no leading "=") for an xlsx cell; props.style / props.align for a paragraph; etc.\n' +
      '  - {action:"add", parent, type, props} — insert a new element under `parent` (e.g. parent "/body" type "p").\n' +
      '  - {action:"remove", path} — delete the element at `path`.\n' +
      'Discover element paths with office_read first (e.g. /body/p[3], /Sheet1/B2, /slide[2]). Stops at the first ' +
      'failing operation and reports it. Returns the saved path and a first-page PNG preview.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to an existing .docx/.xlsx/.pptx (absolute or workspace-relative).' },
        operations: {
          type: 'array',
          description: 'Edit operations, applied in order.',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['set', 'add', 'remove'] },
              path: { type: 'string', description: 'Target element path (action set/remove).' },
              parent: { type: 'string', description: 'Parent element path (action add).' },
              type: { type: 'string', description: 'Element type to add, e.g. "p", "cell", "slide" (action add).' },
              props: { type: 'object', description: 'Property key/value pairs (action set/add).' },
            },
            required: ['action'],
          },
        },
        preview: { type: 'boolean', description: 'Render a first-page PNG preview after editing. Default true.' },
      },
      required: ['path', 'operations'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();
      if (!officeCliAvailable()) {
        return errResult('E_OFFICE_ENGINE_MISSING', 'the built-in Office engine is not available on this build; nothing was changed.');
      }
      const rawPath = String(input.path ?? '');
      if (!rawPath) return errResult('E_BAD_INPUT', '`path` is required');
      const abs = path.resolve(ctx.workingDir ?? '.', rawPath);
      if (!['.docx', '.xlsx', '.pptx'].includes(path.extname(abs).toLowerCase())) {
        return errResult('E_BAD_INPUT', 'edit_office supports .docx/.xlsx/.pptx only');
      }
      const scopeErr = guardPath(opts, abs, 'writable');
      if (scopeErr) return { content: scopeErr, isError: true };
      if (!fs.existsSync(abs)) return errResult('E_NOT_FOUND', `${abs}: file not found`);

      const ops = buildEditBatch(Array.isArray(input.operations) ? (input.operations as EditOp[]) : []);
      if (!ops.length) return errResult('E_BAD_INPUT', '`operations` must contain at least one valid {action,…} entry');

      const cwd = path.dirname(abs);
      try {
        const r = await runOfficeCli(['batch', abs, '--stop-on-error'], {
          cwd, stdin: JSON.stringify(ops), ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (r.code !== 0) {
          return errResult('E_OFFICE_EDIT_FAILED', r.stderr || r.stdout || `exit ${r.code}`);
        }
        const preview = input.preview !== false ? await renderToImage(abs, cwd, '1', ctx.signal) : null;
        if (opts.onFileWritten) {
          try { await opts.onFileWritten(abs); }
          catch (err) { log.warn('onFileWritten callback failed', { path: logPathRef(abs), error: logErrorRef(err) }); }
        }
        return { content: `Edited ${abs} (${ops.length} operation${ops.length === 1 ? '' : 's'})`, ...(preview ? { images: [preview] } : {}) };
      } finally {
        await closeOfficeFile(abs, cwd);
      }
    },
  };
}

/** Build the Office document tools for the current actor. Returns [] without a
 *  uid (no workspace/attachment scope to sandbox to), mirroring image/video gen. */
export function createOfficeTools(opts: OfficeToolsOpts = {}): AgentTool[] {
  if (!opts.userId) return [];
  return [
    createDocxTool(opts),
    createXlsxTool(opts),
    createPptxTool(opts),
    createOfficeReadTool(opts),
    createEditOfficeTool(opts),
    createOfficeRenderTool(opts),
  ];
}
