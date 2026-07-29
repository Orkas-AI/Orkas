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
import { fileEditLock } from '../../util/locks';
import { officeCliAvailable, runOfficeCli, closeOfficeFile, OfficeCliError } from '../../features/office/office_engine';
import {
  buildDocxBatch, buildXlsxWorkbookBatch, buildPptxBatch, buildEditBatch, serializeOfficeBatch,
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

const LOCAL_FILE_PROP = /^(?:src|source|file|filename|filepath|path|template|templatepath|image(?:src|path|file)|media(?:src|path|file)|ole(?:src|path|file)|embeddedobject(?:src|path|file))$/i;
const LINK_PROP = /^(?:url|uri|href|link|hyperlink)$/i;
const UNSAFE_LINK_SCHEME = /^(?:data|file|javascript|vbscript):/i;

function uriScheme(value: string): string {
  if (/^[A-Za-z]:[\\/]/.test(value)) return '';
  return value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)?.[1]?.toLowerCase() || '';
}

/**
 * Validate and normalize model-controlled edit properties before they reach
 * OfficeCLI. Properties that make the engine read a local file are resolved
 * against the conversation sandbox. Link-like properties may embed ordinary
 * web links, but active/local schemes are rejected. Walk nested values too so
 * a future richer operation schema cannot accidentally bypass this boundary.
 */
function normalizeEditProps(
  opts: OfficeToolsOpts,
  ctx: ToolContext,
  raw: unknown,
  key = '',
): { value: unknown } | { error: string } {
  if (Array.isArray(raw)) {
    const out: unknown[] = [];
    for (const item of raw) {
      const normalized = normalizeEditProps(opts, ctx, item, key);
      if ('error' in normalized) return normalized;
      out.push(normalized.value);
    }
    return { value: out };
  }
  if (raw && typeof raw === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(raw as Record<string, unknown>)) {
      const normalized = normalizeEditProps(opts, ctx, childValue, childKey.replace(/[^A-Za-z]/g, ''));
      if ('error' in normalized) return normalized;
      out[childKey] = normalized.value;
    }
    return { value: out };
  }
  if (typeof raw !== 'string') return { value: raw };

  const value = raw.trim();
  if (LOCAL_FILE_PROP.test(key)) {
    if (!value) return { error: `file-bearing property \`${key}\` requires a path` };
    if (uriScheme(value)) {
      return { error: `file-bearing property \`${key}\` does not accept URI references` };
    }
    const abs = path.resolve(ctx.workingDir ?? '.', value);
    const scopeErr = guardPath(opts, abs, 'readable');
    if (scopeErr) return { error: scopeErr.replace(/^E_[A-Z_]+:\s*/, '') };
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); }
    catch { return { error: `referenced file not found: ${abs}` }; }
    if (!stat.isFile()) return { error: `referenced path is not a file: ${abs}` };
    return { value: abs };
  }
  if (LINK_PROP.test(key) && UNSAFE_LINK_SCHEME.test(value)) {
    return { error: `link property \`${key}\` uses an unsafe URI scheme` };
  }
  return { value: raw };
}

function normalizeEditOperations(
  opts: OfficeToolsOpts,
  ctx: ToolContext,
  raw: unknown,
): { operations: EditOp[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: '`operations` must be an array' };
  const operations: EditOp[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const operation = item as Record<string, unknown>;
    const normalizedProps = normalizeEditProps(opts, ctx, operation.props);
    if ('error' in normalizedProps) return normalizedProps;
    operations.push({
      ...operation,
      ...(operation.props !== undefined ? { props: normalizedProps.value } : {}),
    } as EditOp);
  }
  return { operations };
}

function editedCopyPath(source: string): string {
  const ext = path.extname(source);
  return path.join(path.dirname(source), `${path.basename(source, ext)}-edited${ext}`);
}

async function acquireFileLocks(absPaths: readonly string[]): Promise<() => void> {
  const releases: Array<() => void> = [];
  try {
    for (const abs of [...new Set(absPaths.map((item) => path.resolve(item)))].sort()) {
      releases.push(await fileEditLock(abs).acquire());
    }
  } catch (err) {
    for (const release of releases.reverse()) release();
    throw err;
  }
  return () => {
    for (const release of releases.reverse()) release();
  };
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
  let tempDir = '';
  let workPath = '';
  let releaseLocks: (() => void) | null = null;
  try {
    ({ finalPath, renamed } = await uniquifyPath(args.inputAbs, isMineFor(opts)));
    cwd = path.dirname(finalPath);
    fs.mkdirSync(cwd, { recursive: true });
    releaseLocks = await acquireFileLocks([finalPath]);
    tempDir = fs.mkdtempSync(path.join(cwd, '.orkas-office-create-'));
    workPath = path.join(tempDir, path.basename(finalPath));

    const created = await runOfficeCli(['create', workPath, ...args.createFlags], {
      cwd: tempDir, ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (created.code !== 0) {
      return errResult('E_OFFICE_CREATE_FAILED', created.stderr || created.stdout || `exit ${created.code}`);
    }

    if (args.ops.length) {
      const batched = await runOfficeCli(['batch', workPath], {
        cwd: tempDir, stdin: serializeOfficeBatch(args.ops), ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      if (batched.code !== 0) {
        return errResult('E_OFFICE_BATCH_FAILED', batched.stderr || batched.stdout || `exit ${batched.code}`);
      }
    }

    const preview = args.wantPreview ? await renderToImage(workPath, tempDir, '1', ctx.signal) : null;
    await closeOfficeFile(workPath, tempDir);

    // Promote only a fully created/batched file. Failed creation therefore
    // leaves neither a half-built artifact nor a collision that forces the
    // model's retry onto `-2.xlsx`. Preserve an owned prior version until the
    // replacement has reached its final path so retries cannot destroy it.
    let backupPath = '';
    if (fs.existsSync(finalPath)) {
      await closeOfficeFile(finalPath, cwd);
      backupPath = path.join(tempDir, `.previous-${path.basename(finalPath)}`);
      fs.renameSync(finalPath, backupPath);
    }
    try {
      fs.renameSync(workPath, finalPath);
    } catch (err) {
      if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(finalPath)) {
        fs.renameSync(backupPath, finalPath);
      }
      throw err;
    }
    if (backupPath) fs.rmSync(backupPath, { force: true });

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
    if (workPath && tempDir) await closeOfficeFile(workPath, tempDir);
    if (fs.existsSync(finalPath)) await closeOfficeFile(finalPath, cwd);
    if (releaseLocks) releaseLocks();
    if (tempDir) {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
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
  const chartSchema = {
    type: 'object',
    description:
      'A native editable Excel chart bound to worksheet cells. Prefer dataRange/categories over inline data so updates remain traceable.',
    properties: {
      type: {
        type: 'string',
        enum: [
          'bar', 'column', 'line', 'pie', 'doughnut', 'area', 'scatter', 'bubble', 'radar',
          'stock', 'combo', 'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker',
          'histogram', 'pareto',
        ],
        description: 'Native chart type. Use line for time trends and bar/column for category comparisons.',
      },
      dataRange: {
        type: 'string',
        description: 'Worksheet source range, e.g. "Trend!B1:C32". Header cells become series names.',
      },
      categories: {
        type: 'string',
        description: 'Category-label range, e.g. "Trend!A2:A32".',
      },
      data: {
        type: 'string',
        description: 'Inline fallback such as "Sales:10,20,30"; prefer cell ranges for auditable workbooks.',
      },
      title: { type: 'string', description: 'Chart title.' },
      anchor: { type: 'string', description: 'Cell anchor rectangle, e.g. "D2:L18".' },
      legend: {
        type: 'string',
        enum: ['true', 'false', 'none', 'top', 'bottom', 'left', 'right', 'topRight'],
        description: 'Legend visibility or position.',
      },
      dataLabels: {
        type: 'string',
        description: 'Labels such as "value", "percent", "value,percent", "outsideEnd", or "none".',
      },
      catTitle: { type: 'string', description: 'Category-axis title.' },
      axistitle: { type: 'string', description: 'Value-axis title.' },
      axismin: { type: 'number', description: 'Value-axis minimum. Bar/column charts normally use 0.' },
      axismax: { type: 'number', description: 'Optional value-axis maximum.' },
      axisnumfmt: { type: 'string', description: 'Value-axis number format, e.g. "#,##0" or "0.0%".' },
      gridlines: { type: ['boolean', 'string'], description: 'Major gridlines or a line style such as "E0E0E0:0.5".' },
      colors: { type: 'string', description: 'Comma-separated series colors, e.g. "4472C4,ED7D31".' },
      preset: {
        type: 'string',
        enum: ['minimal', 'dark', 'corporate', 'magazine', 'dashboard', 'colorful', 'monochrome'],
        description: 'Named chart style preset.',
      },
      style: { type: 'number', description: 'Built-in Excel chart style id (1-48).' },
      labelrotation: { type: 'number', description: 'Axis label rotation in degrees (-90 to 90).' },
      width: { type: 'string', description: 'Chart width with unit; ignored when anchor is set.' },
      height: { type: 'string', description: 'Chart height with unit; ignored when anchor is set.' },
      smooth: { type: 'boolean', description: 'Smooth line/scatter series.' },
      marker: { type: 'string', description: 'Line/scatter marker, e.g. "circle:6" or "none".' },
      linewidth: { type: 'number', description: 'Series line width in points.' },
      gapwidth: { type: 'number', description: 'Bar/column gap width from 0 to 500.' },
      overlap: { type: 'number', description: 'Bar/column overlap from -100 to 100.' },
      varyColors: { type: 'boolean', description: 'Vary colors by point for a single-series chart.' },
      secondaryaxis: {
        type: 'string',
        description: 'Comma-separated 1-based series indices placed on the secondary value axis, e.g. "2".',
      },
      combotypes: {
        type: 'string',
        description: 'Per-series types for a combo chart, e.g. "column,line".',
      },
      combosplit: { type: 'number', description: 'Combo split: first N series use the primary chart type.' },
      referenceline: {
        type: 'string',
        description: 'Target line as "value:color:label:dash", e.g. "100:FF0000:目标:dash".',
      },
    },
    required: ['type'],
  };
  return {
    name: 'create_xlsx',
    description:
      'Create one .xlsx workbook with rows/sheets and native editable charts. rows is [[cell]]; a cell is a value or {value, formula?, format?, bold?, fill?, font.color?, merge?}. formulas omit "=". sheets: [{name, rows, columns?, charts?}]. Charts bind dataRange/categories with type/title/anchor/axis/legend. Refine the returned path with edit_office instead of calling create_xlsx again. Returns path/preview; collisions return <file-renamed>.',
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
        charts: {
          type: 'array',
          description: 'Native editable charts for the default sheet. Chart ranges may reference any sheet in this workbook.',
          items: chartSchema,
        },
        sheets: {
          type: 'array',
          description: 'Multiple worksheets (use instead of top-level `sheet`/`rows`/`columns`/`charts`). The first sheet reuses the default tab.',
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
              charts: {
                type: 'array',
                description: 'Native editable charts placed on this sheet.',
                items: chartSchema,
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
            ...(Array.isArray(input.charts) ? { charts: input.charts as XlsxSheetSpec['charts'] } : {}),
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

function createOfficeCheckTool(opts: OfficeToolsOpts): AgentTool {
  return {
    name: 'office_check',
    description:
      'Check an existing Word/Excel/PowerPoint file before delivery with the built-in Office engine. Runs OpenXML ' +
      'validation plus the engine issue scan and returns structured results. Use after create_docx/create_xlsx/' +
      'create_pptx or edit_office. Invalid OpenXML is a fatal tool error; non-fatal issue findings remain structured QA output.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to an existing .docx/.xlsx/.pptx (absolute or workspace-relative).' },
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
      if (!['.docx', '.xlsx', '.pptx'].includes(path.extname(abs).toLowerCase())) {
        return errResult('E_BAD_INPUT', 'office_check supports .docx/.xlsx/.pptx only');
      }
      const scopeErr = guardPath(opts, abs, 'readable');
      if (scopeErr) return { content: scopeErr, isError: true };
      if (!fs.existsSync(abs)) return errResult('E_NOT_FOUND', `${abs}: file not found`);

      const cwd = path.dirname(abs);
      const normalizeOutput = (stdout: string, stderr: string): unknown => {
        const raw = (stdout || stderr || '').trim();
        if (!raw) return null;
        try { return JSON.parse(raw); } catch { return raw; }
      };
      try {
        const validate = await runOfficeCli(['validate', abs, '--json'], {
          cwd, ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const issues = await runOfficeCli(['view', abs, 'issues', '--json'], {
          cwd, ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const payload = {
          path: abs,
          valid: validate.code === 0,
          validation_exit_code: validate.code,
          validation: normalizeOutput(validate.stdout, validate.stderr),
          issue_scan_ok: issues.code === 0,
          issue_scan_exit_code: issues.code,
          issues: normalizeOutput(issues.stdout, issues.stderr),
        };
        return {
          content: JSON.stringify(payload),
          ...(payload.valid ? {} : { isError: true }),
        };
      } catch (err) {
        const code = err instanceof OfficeCliError ? err.code : 'E_OFFICE_CHECK_FAILED';
        return errResult(code, (err as Error).message);
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
      'Read an existing DOCX/XLSX/PPTX with element paths before a precise edit. Modes: "text" (default, path-prefixed ' +
      'content such as [/body/p[3]] or [/Sheet1/A1]), "outline" (structure), "get" (one `target` path as JSON), and ' +
      '"query" (CSS-like `target` selector as JSON). Use `office_read` to discover a stable path, then `edit_office`; ' +
      'use `read_file` instead when plain text without element paths is enough.',
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
      'Safely edit DOCX/XLSX/PPTX. Provide source `path`, optional `output_path`, and `operations`: ' +
      'only {action:"set",path,props}, {action:"add",parent,type,props}, or {action:"remove",path}. ' +
      'For targeted text replacement use {action:"set",path:"/body/p[2]",props:{find:"old",replace:"new"}}; ' +
      'there is no replace action or edits field. A pre-existing source becomes a ' +
      '`-edited` copy and is never overwritten; a conversation-produced file may be refined in place. ' +
      'Use `office_read` for stable element paths. File-bearing props such as `src` must be sandboxed. The batch is ' +
      'validated before atomic commit; returns the saved path and preview.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Source .docx/.xlsx/.pptx path (absolute or workspace-relative).' },
        output_path: {
          type: 'string',
          description: 'Optional output path with the same extension. Required only when a specific working-copy path is desired.',
        },
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
      const sourceAbs = path.resolve(ctx.workingDir ?? '.', rawPath);
      const sourceExt = path.extname(sourceAbs).toLowerCase();
      if (!['.docx', '.xlsx', '.pptx'].includes(sourceExt)) {
        return errResult('E_BAD_INPUT', 'edit_office supports .docx/.xlsx/.pptx only');
      }
      const sourceScopeErr = guardPath(opts, sourceAbs, 'readable');
      if (sourceScopeErr) return { content: sourceScopeErr, isError: true };
      if (!fs.existsSync(sourceAbs)) return errResult('E_NOT_FOUND', `${sourceAbs}: file not found`);

      const normalized = normalizeEditOperations(opts, ctx, input.operations);
      if ('error' in normalized) return errResult('E_BAD_INPUT', normalized.error);
      const ops = buildEditBatch(normalized.operations);
      if (!ops.length) return errResult('E_BAD_INPUT', '`operations` must contain at least one valid {action,…} entry');

      const sourceWasProduced = !!opts.hasProducedPath?.(sourceAbs);
      const rawOutputPath = typeof input.output_path === 'string' ? input.output_path.trim() : '';
      let requestedOutput = rawOutputPath
        ? path.resolve(ctx.workingDir ?? '.', rawOutputPath)
        : (sourceWasProduced ? sourceAbs : editedCopyPath(sourceAbs));
      if (path.extname(requestedOutput).toLowerCase() !== sourceExt) {
        return errResult('E_BAD_INPUT', '`output_path` must use the same Office extension as `path`');
      }
      const outputScopeErr = guardPath(opts, requestedOutput, 'writable');
      if (outputScopeErr) return { content: outputScopeErr, isError: true };
      if (path.resolve(requestedOutput) === path.resolve(sourceAbs) && !sourceWasProduced) {
        return errResult('E_SOURCE_OVERWRITE', 'output_path must differ from a pre-existing source; omit it for an automatic working copy');
      }

      let finalPath = requestedOutput;
      let renamed = false;
      let tempDir = '';
      let workPath = '';
      let workCwd = '';
      let finalCwd = path.dirname(finalPath);
      let releaseLocks: (() => void) | null = null;
      try {
        if (path.resolve(requestedOutput) !== path.resolve(sourceAbs)) {
          ({ finalPath, renamed } = await uniquifyPath(requestedOutput, () => false));
        }
        finalCwd = path.dirname(finalPath);
        fs.mkdirSync(finalCwd, { recursive: true });
        tempDir = fs.mkdtempSync(path.join(finalCwd, '.orkas-office-edit-'));
        workPath = path.join(tempDir, path.basename(finalPath));
        workCwd = path.dirname(workPath);
        releaseLocks = await acquireFileLocks([sourceAbs, finalPath]);
        fs.copyFileSync(sourceAbs, workPath);
        const r = await runOfficeCli(['batch', workPath, '--stop-on-error'], {
          cwd: workCwd, stdin: serializeOfficeBatch(ops), ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (r.code !== 0) {
          return errResult('E_OFFICE_EDIT_FAILED', r.stderr || r.stdout || `exit ${r.code}`);
        }
        const validation = await runOfficeCli(['validate', workPath, '--json'], {
          cwd: workCwd, ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (validation.code !== 0) {
          return errResult(
            'E_OFFICE_VALIDATION_FAILED',
            validation.stderr || validation.stdout || `exit ${validation.code}`,
          );
        }
        await closeOfficeFile(workPath, workCwd);
        fs.renameSync(workPath, finalPath);

        const preview = input.preview !== false ? await renderToImage(finalPath, finalCwd, '1', ctx.signal) : null;
        if (opts.onFileWritten) {
          try { await opts.onFileWritten(finalPath); }
          catch (err) { log.warn('onFileWritten callback failed', { path: logPathRef(finalPath), error: logErrorRef(err) }); }
        }
        const sourceNote = sourceWasProduced && finalPath === sourceAbs
          ? ''
          : `; source preserved: ${sourceAbs}`;
        const renameSignal = renamed ? renderRenameSignal(requestedOutput, finalPath) : '';
        return {
          content: `Edited ${finalPath} (${ops.length} operation${ops.length === 1 ? '' : 's'})${sourceNote}${renameSignal}`,
          ...(preview ? { images: [preview] } : {}),
        };
      } catch (err) {
        const code = err instanceof OfficeCliError ? err.code : 'E_OFFICE_EDIT_FAILED';
        return errResult(code, (err as Error).message || String(err));
      } finally {
        if (workPath && workCwd) {
          try { await closeOfficeFile(workPath, workCwd); }
          catch (err) { log.warn('close edited working copy failed', { error: logErrorRef(err) }); }
        }
        if (finalPath && finalCwd && finalPath !== workPath) {
          try { await closeOfficeFile(finalPath, finalCwd); }
          catch (err) { log.warn('close edited output failed', { error: logErrorRef(err) }); }
        }
        if (releaseLocks) releaseLocks();
        if (tempDir) {
          try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
        }
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
    createOfficeCheckTool(opts),
    createOfficeRenderTool(opts),
  ];
}
