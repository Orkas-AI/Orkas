/**
 * Sandboxed PDF editing and rendering tools.
 *
 * `pdf-lib` supplies deterministic, cross-platform structural edits without
 * shelling out to an optional CLI. `pdfjs-dist` + its existing napi canvas
 * runtime render the changed page for model-visible QA. Arbitrary replacement
 * of existing PDF text is intentionally out of scope: PDFs do not carry a
 * stable editable text model, and a visual overlay is not legal redaction.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  degrees as pdfDegrees,
} from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

import type { AgentTool, ToolContext, ToolResult } from '#core-agent';
import { getLocalExecGranted } from '../../features/permissions';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { isPathAllowed } from '../../util/path-sandbox';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { fileEditLock } from '../../util/locks';
import { createLogger } from '../../logger';
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';
import { DENY_MESSAGE } from './local-tools';

const log = createLogger('pdf-tools');
const MAX_INPUT_BYTES = 128 * 1024 * 1024;
const MAX_PAGE_COUNT = 2_000;
const MAX_RENDER_PIXELS = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000;

type PdfAction =
  | 'merge'
  | 'extract_pages'
  | 'delete_pages'
  | 'reorder_pages'
  | 'rotate_pages'
  | 'watermark'
  | 'overlay_text'
  | 'overlay_image'
  | 'fill_form';

export interface PdfToolsOpts {
  userId?: string;
  cid?: string;
  projectId?: string;
  extraRoots?: readonly string[];
  onFileWritten?: (absPath: string) => void | Promise<void>;
  hasProducedPath?: (absPath: string) => boolean;
}

function deniedResult(): ToolResult {
  return { content: DENY_MESSAGE, isError: true };
}

function errResult(code: string, message: string): ToolResult {
  return { content: `${code}: ${message}`, isError: true };
}

function allowedRootsFor(opts: PdfToolsOpts): string[] {
  const roots: string[] = [];
  if (opts.userId) {
    try {
      const workspace = getWorkspacePath(opts.userId, opts.projectId);
      if (workspace) roots.push(workspace);
    } catch (err) {
      log.warn('resolve workspace failed', {
        user_id: maskId(opts.userId),
        project_id: maskId(opts.projectId),
        error: logErrorRef(err),
      });
    }
    if (opts.cid) {
      try { roots.push(chatAttachmentDirForConversation(opts.userId, opts.cid)); }
      catch (err) {
        log.warn('resolve attachment dir failed', {
          user_id: maskId(opts.userId),
          cid: maskId(opts.cid),
          error: logErrorRef(err),
        });
      }
    }
  }
  for (const root of opts.extraRoots || []) if (root) roots.push(root);
  return roots;
}

function guardPath(opts: PdfToolsOpts, abs: string, action: 'read' | 'write'): string | null {
  const roots = allowedRootsFor(opts);
  if (!roots.length) return `E_NO_SCOPE: no ${action} roots for this conversation`;
  if (!isPathAllowed(abs, roots)) {
    return `E_PATH_OUT_OF_SCOPE: path is outside the conversation workspace/attachment scope: ${abs}`;
  }
  return null;
}

function isMineFor(opts: PdfToolsOpts): (abs: string) => boolean {
  return (abs) => !!opts.hasProducedPath?.(abs)
    || (!!opts.extraRoots?.length && isPathAllowed(abs, opts.extraRoots));
}

function resolvePath(ctx: ToolContext, raw: unknown): string {
  return path.resolve(ctx.workingDir ?? '.', String(raw ?? '').trim());
}

function ensurePdfInput(opts: PdfToolsOpts, abs: string): string | null {
  if (path.extname(abs).toLowerCase() !== '.pdf') return `PDF input must end in .pdf: ${abs}`;
  const scopeErr = guardPath(opts, abs, 'read');
  if (scopeErr) return scopeErr;
  let stat: fs.Stats;
  try { stat = fs.statSync(abs); }
  catch { return `PDF input not found: ${abs}`; }
  if (!stat.isFile()) return `PDF input is not a file: ${abs}`;
  if (stat.size > MAX_INPUT_BYTES) {
    return `E_PDF_LIMIT: PDF input exceeds the ${MAX_INPUT_BYTES}-byte processing limit: ${abs}`;
  }
  return null;
}

function integerArray(raw: unknown, label: string): number[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error(`${label} must be a non-empty integer array`);
  const values = raw.map((value) => Number(value));
  if (values.some((value) => !Number.isInteger(value) || value < 1)) {
    throw new Error(`${label} uses 1-based positive page numbers`);
  }
  return values;
}

function selectedPages(raw: unknown, pageCount: number, allowAll = true): number[] {
  if ((raw === undefined || raw === null) && allowAll) {
    return Array.from({ length: pageCount }, (_unused, index) => index + 1);
  }
  const pages = integerArray(raw, 'pages');
  if (pages.some((page) => page > pageCount)) {
    throw new Error(`pages must be within 1-${pageCount}`);
  }
  return [...new Set(pages)];
}

function requireString(raw: unknown, label: string, max = 16_000): string {
  const value = String(raw ?? '').trim();
  if (!value) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return value;
}

function finiteNumber(raw: unknown, fallback: number, min: number, max: number, label: string): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return value;
}

function canvasFontFamily(): string {
  if (process.platform === 'win32') {
    return '"Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", Arial, sans-serif';
  }
  if (process.platform === 'darwin') {
    return '"PingFang SC", "Hiragino Sans GB", "Helvetica Neue", Arial, sans-serif';
  }
  return '"Noto Sans CJK SC", "Noto Sans SC", "DejaVu Sans", Arial, sans-serif';
}

function renderTextPng(input: {
  text: string;
  fontSize: number;
  color: string;
  backgroundColor?: string;
}): Buffer {
  const lines = input.text.split(/\r?\n/).slice(0, 40);
  const padding = Math.max(4, Math.round(input.fontSize * 0.25));
  const lineHeight = Math.ceil(input.fontSize * 1.3);
  const probe = createCanvas(8, 8);
  const probeContext = probe.getContext('2d');
  probeContext.font = `600 ${input.fontSize}px ${canvasFontFamily()}`;
  const width = Math.max(
    8,
    Math.ceil(Math.max(...lines.map((line) => probeContext.measureText(line || ' ').width)) + padding * 2),
  );
  const height = Math.max(8, lineHeight * lines.length + padding * 2);
  if (width > 16_384 || height > 16_384) throw new Error('rendered text overlay is too large');

  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  if (input.backgroundColor) {
    context.fillStyle = input.backgroundColor;
    context.fillRect(0, 0, width, height);
  }
  context.font = `600 ${input.fontSize}px ${canvasFontFamily()}`;
  context.fillStyle = input.color;
  context.textBaseline = 'top';
  lines.forEach((line, index) => context.fillText(line, padding, padding + index * lineHeight));
  return canvas.toBuffer('image/png');
}

async function loadPdf(abs: string): Promise<PDFDocument> {
  const document = await PDFDocument.load(fs.readFileSync(abs), { updateMetadata: false });
  if (document.getPageCount() > MAX_PAGE_COUNT) {
    throw new Error(`PDF exceeds the ${MAX_PAGE_COUNT}-page processing limit`);
  }
  return document;
}

async function writePdf(abs: string, document: PDFDocument): Promise<void> {
  const tmp = path.join(
    path.dirname(abs),
    `.${path.basename(abs)}.orkas-pdf-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tmp, await document.save({ useObjectStreams: true, addDefaultPage: false }));
    fs.renameSync(tmp, abs);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
  }
}

async function documentForMerge(inputPaths: string[]): Promise<PDFDocument> {
  const output = await PDFDocument.create();
  for (const inputPath of inputPaths) {
    const source = await loadPdf(inputPath);
    const copied = await output.copyPages(source, source.getPageIndices());
    copied.forEach((page) => output.addPage(page));
  }
  return output;
}

async function documentForExtract(inputPath: string, pages: number[]): Promise<PDFDocument> {
  const source = await loadPdf(inputPath);
  const output = await PDFDocument.create();
  const copied = await output.copyPages(source, pages.map((page) => page - 1));
  copied.forEach((page) => output.addPage(page));
  return output;
}

async function applyPdfAction(
  action: PdfAction,
  input: Record<string, unknown>,
  inputPaths: string[],
  opts: PdfToolsOpts,
  ctx: ToolContext,
): Promise<{ document: PDFDocument; changedPages: number[]; notes?: string[] }> {
  if (action === 'merge') {
    if (inputPaths.length < 2) throw new Error('merge requires at least two input_paths');
    const document = await documentForMerge(inputPaths);
    if (document.getPageCount() > MAX_PAGE_COUNT) {
      throw new Error(`merged PDF exceeds the ${MAX_PAGE_COUNT}-page processing limit`);
    }
    return { document, changedPages: document.getPageIndices().map((index) => index + 1) };
  }

  const inputPath = inputPaths[0];
  if (!inputPath) throw new Error(`${action} requires input_path`);
  const document = await loadPdf(inputPath);
  const pageCount = document.getPageCount();
  if (!pageCount) throw new Error('input PDF has no pages');

  if (action === 'extract_pages') {
    const pages = selectedPages(input.pages, pageCount, false);
    return { document: await documentForExtract(inputPath, pages), changedPages: pages };
  }

  if (action === 'reorder_pages') {
    const order = integerArray(input.page_order, 'page_order');
    if (order.length !== pageCount || new Set(order).size !== pageCount
      || order.some((page) => page > pageCount)) {
      throw new Error(`page_order must be a permutation of every page from 1-${pageCount}`);
    }
    return { document: await documentForExtract(inputPath, order), changedPages: order };
  }

  if (action === 'delete_pages') {
    const pages = selectedPages(input.pages, pageCount, false);
    if (pages.length >= pageCount) throw new Error('delete_pages must leave at least one page');
    [...pages].sort((a, b) => b - a).forEach((page) => document.removePage(page - 1));
    return { document, changedPages: pages };
  }

  const pages = selectedPages(input.pages, pageCount, true);
  if (action === 'rotate_pages') {
    const amount = finiteNumber(input.degrees, 90, -360, 360, 'degrees');
    if (!Number.isInteger(amount) || amount % 90 !== 0) throw new Error('degrees must be a multiple of 90');
    pages.forEach((pageNumber) => {
      const page = document.getPage(pageNumber - 1);
      const current = page.getRotation().angle || 0;
      page.setRotation(pdfDegrees(((current + amount) % 360 + 360) % 360));
    });
    return { document, changedPages: pages };
  }

  if (action === 'watermark' || action === 'overlay_text') {
    const text = requireString(input.text, 'text', MAX_TEXT_CHARS);
    const fontSize = finiteNumber(input.font_size, action === 'watermark' ? 42 : 18, 6, 240, 'font_size');
    const opacity = finiteNumber(input.opacity, action === 'watermark' ? 0.18 : 1, 0.01, 1, 'opacity');
    const rotation = finiteNumber(input.rotation, action === 'watermark' ? 35 : 0, -360, 360, 'rotation');
    const png = await document.embedPng(renderTextPng({
      text,
      fontSize,
      color: String(input.color || (action === 'watermark' ? '#666666' : '#000000')),
      ...(input.background_color ? { backgroundColor: String(input.background_color) } : {}),
    }));
    pages.forEach((pageNumber) => {
      const page = document.getPage(pageNumber - 1);
      const size = page.getSize();
      const natural = png.scale(1);
      const maxWidth = action === 'watermark' ? size.width * 0.75 : size.width;
      const scale = Math.min(1, maxWidth / natural.width);
      const width = finiteNumber(input.width, natural.width * scale, 1, size.width * 4, 'width');
      const height = finiteNumber(input.height, natural.height * scale, 1, size.height * 4, 'height');
      const x = finiteNumber(input.x, action === 'watermark' ? (size.width - width) / 2 : 36, -size.width * 2, size.width * 3, 'x');
      const y = finiteNumber(input.y, action === 'watermark' ? (size.height - height) / 2 : 36, -size.height * 2, size.height * 3, 'y');
      page.drawImage(png, { x, y, width, height, opacity, rotate: pdfDegrees(rotation) });
    });
    return {
      document,
      changedPages: pages,
      notes: action === 'overlay_text'
        ? ['overlay_text adds visible content; it does not remove or redact underlying PDF text']
        : undefined,
    };
  }

  if (action === 'overlay_image') {
    const imagePath = resolvePath(ctx, input.image_path);
    const imageScopeErr = guardPath(opts, imagePath, 'read');
    if (imageScopeErr) throw new Error(imageScopeErr);
    if (!fs.existsSync(imagePath)) throw new Error(`image not found: ${imagePath}`);
    const ext = path.extname(imagePath).toLowerCase();
    const imageBytes = fs.readFileSync(imagePath);
    const image = ext === '.png'
      ? await document.embedPng(imageBytes)
      : ['.jpg', '.jpeg'].includes(ext)
        ? await document.embedJpg(imageBytes)
        : null;
    if (!image) throw new Error('overlay_image supports .png, .jpg, and .jpeg');
    const opacity = finiteNumber(input.opacity, 1, 0.01, 1, 'opacity');
    const rotation = finiteNumber(input.rotation, 0, -360, 360, 'rotation');
    pages.forEach((pageNumber) => {
      const page = document.getPage(pageNumber - 1);
      const size = page.getSize();
      const natural = image.scale(1);
      const scale = Math.min(1, size.width / natural.width, size.height / natural.height);
      const width = finiteNumber(input.width, natural.width * scale, 1, size.width * 4, 'width');
      const height = finiteNumber(input.height, natural.height * scale, 1, size.height * 4, 'height');
      const x = finiteNumber(input.x, 36, -size.width * 2, size.width * 3, 'x');
      const y = finiteNumber(input.y, 36, -size.height * 2, size.height * 3, 'y');
      page.drawImage(image, { x, y, width, height, opacity, rotate: pdfDegrees(rotation) });
    });
    return { document, changedPages: pages };
  }

  if (action === 'fill_form') {
    const fields = input.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      throw new Error('fill_form requires a fields object keyed by PDF field name');
    }
    const form = document.getForm();
    const available = new Map(form.getFields().map((field) => [field.getName(), field]));
    for (const [name, value] of Object.entries(fields as Record<string, unknown>)) {
      const field = available.get(name);
      if (!field) throw new Error(`unknown PDF form field: ${name}`);
      if (field instanceof PDFTextField) field.setText(String(value ?? ''));
      else if (field instanceof PDFCheckBox) value ? field.check() : field.uncheck();
      else if (field instanceof PDFDropdown) field.select(String(value ?? ''));
      else if (field instanceof PDFRadioGroup) field.select(String(value ?? ''));
      else if (field instanceof PDFOptionList) {
        field.select(Array.isArray(value) ? value.map(String) : String(value ?? ''));
      } else {
        throw new Error(`unsupported PDF form field type for ${name}`);
      }
    }
    if (input.flatten_form === true) form.flatten();
    return { document, changedPages: pages };
  }

  throw new Error(`unsupported action: ${action}`);
}

function createEditPdfTool(opts: PdfToolsOpts): AgentTool {
  return {
    name: 'edit_pdf',
    description:
      'Edit an existing PDF with deterministic built-in operations: merge files; extract, delete, reorder, or rotate pages; ' +
      'add CJK-capable visible text/watermarks or PNG/JPEG overlays; and fill form fields. Always writes a separate PDF. ' +
      'Page numbers are 1-based. overlay_text is not secure redaction and arbitrary replacement of existing PDF text is unsupported.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['merge', 'extract_pages', 'delete_pages', 'reorder_pages', 'rotate_pages', 'watermark', 'overlay_text', 'overlay_image', 'fill_form'],
        },
        input_path: { type: 'string', description: 'Source PDF for every action except merge.' },
        input_paths: { type: 'array', items: { type: 'string' }, description: 'Source PDFs in order for merge.' },
        output_path: { type: 'string', description: 'Separate output .pdf path; must differ from every input path.' },
        pages: { type: 'array', items: { type: 'number' }, description: 'Optional 1-based target pages; omit for all pages where allowed.' },
        page_order: { type: 'array', items: { type: 'number' }, description: 'Full 1-based permutation for reorder_pages.' },
        degrees: { type: 'number', description: 'Rotation amount; multiple of 90.' },
        text: { type: 'string', description: 'Text for watermark or overlay_text.' },
        image_path: { type: 'string', description: 'PNG/JPEG path for overlay_image.' },
        x: { type: 'number', description: 'Overlay x in PDF points from the bottom-left.' },
        y: { type: 'number', description: 'Overlay y in PDF points from the bottom-left.' },
        width: { type: 'number' },
        height: { type: 'number' },
        font_size: { type: 'number' },
        color: { type: 'string', description: 'CSS color for rendered overlay text.' },
        background_color: { type: 'string', description: 'Optional CSS background color for overlay text.' },
        opacity: { type: 'number' },
        rotation: { type: 'number' },
        fields: { type: 'object', additionalProperties: true, description: 'Form values keyed by exact PDF field name.' },
        flatten_form: { type: 'boolean', description: 'Flatten filled form fields into page content.' },
      },
      required: ['action', 'output_path'],
    },
    async execute(rawInput, ctx) {
      if (!getLocalExecGranted()) return deniedResult();
      const input = rawInput as Record<string, unknown>;
      const action = String(input.action || '') as PdfAction;
      const validActions = new Set<PdfAction>([
        'merge', 'extract_pages', 'delete_pages', 'reorder_pages', 'rotate_pages',
        'watermark', 'overlay_text', 'overlay_image', 'fill_form',
      ]);
      if (!validActions.has(action)) return errResult('E_BAD_INPUT', 'unsupported PDF action');

      const outputPath = resolvePath(ctx, input.output_path);
      if (path.extname(outputPath).toLowerCase() !== '.pdf') {
        return errResult('E_BAD_INPUT', 'output_path must end in .pdf');
      }
      const outputScopeErr = guardPath(opts, outputPath, 'write');
      if (outputScopeErr) return errResult('E_PATH_OUT_OF_SCOPE', outputScopeErr.replace(/^E_[A-Z_]+:\s*/, ''));

      const inputPaths = action === 'merge'
        ? (Array.isArray(input.input_paths) ? input.input_paths : []).map((raw) => resolvePath(ctx, raw))
        : [resolvePath(ctx, input.input_path)];
      for (const inputPath of inputPaths) {
        const inputErr = ensurePdfInput(opts, inputPath);
        if (inputErr) return errResult(inputErr.startsWith('E_') ? inputErr.split(':')[0] : 'E_BAD_INPUT', inputErr.replace(/^E_[A-Z_]+:\s*/, ''));
      }
      if (inputPaths.some((inputPath) => path.resolve(inputPath) === path.resolve(outputPath))) {
        return errResult('E_SOURCE_OVERWRITE', 'output_path must differ from every input PDF; preserve the source');
      }

      let finalPath = outputPath;
      let renamed = false;
      try {
        ({ finalPath, renamed } = await uniquifyPath(outputPath, isMineFor(opts)));
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        const release = await fileEditLock(finalPath).acquire();
        try {
          const result = await applyPdfAction(action, input, inputPaths, opts, ctx);
          if (!result.document.getPageCount()) throw new Error('PDF edit produced an empty document');
          await writePdf(finalPath, result.document);
          if (opts.onFileWritten) await opts.onFileWritten(finalPath);
          const payload = {
            path: finalPath,
            action,
            page_count: result.document.getPageCount(),
            changed_pages: result.changedPages,
            ...(result.notes?.length ? { notes: result.notes } : {}),
          };
          const signal = renamed ? renderRenameSignal(outputPath, finalPath) : '';
          return { content: `${JSON.stringify(payload)}${signal}` };
        } finally {
          release();
        }
      } catch (err) {
        log.warn('PDF edit failed', {
          user_id: maskId(opts.userId),
          action,
          output: logPathRef(finalPath),
          error: logErrorRef(err),
        });
        return errResult('E_PDF_EDIT_FAILED', (err as Error).message || String(err));
      }
    },
  };
}

let pdfJsPromise: Promise<any> | null = null;
function loadPdfJs(): Promise<any> {
  if (!pdfJsPromise) {
    pdfJsPromise = import('pdfjs-dist/legacy/build/pdf.mjs' as any).then(async (mod: any) => {
      try {
        const url = await import('node:url');
        mod.GlobalWorkerOptions.workerSrc = url.pathToFileURL(
          require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'),
        ).href;
      } catch { /* fake worker fallback */ }
      return mod;
    });
  }
  return pdfJsPromise;
}

function createPdfRenderTool(opts: PdfToolsOpts): AgentTool {
  return {
    name: 'pdf_render',
    executionMode: 'parallel',
    description:
      'Render one page of a PDF to an inline PNG for visual QA after edit_pdf. Page numbers are 1-based. ' +
      'Use read_file for text and ocr_file for scanned text; use this tool to inspect layout, overlays, clipping, and page selection.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        page: { type: 'number', description: '1-based page number. Default 1.' },
        scale: { type: 'number', description: 'Render scale from 0.5 to 3. Default 1.5.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      if (!getLocalExecGranted()) return deniedResult();
      const abs = resolvePath(ctx, input.path);
      const inputErr = ensurePdfInput(opts, abs);
      if (inputErr) return errResult(inputErr.startsWith('E_') ? inputErr.split(':')[0] : 'E_BAD_INPUT', inputErr.replace(/^E_[A-Z_]+:\s*/, ''));
      const pageNumber = finiteNumber(input.page, 1, 1, 100_000, 'page');
      if (!Number.isInteger(pageNumber)) return errResult('E_BAD_INPUT', 'page must be an integer');
      const scale = finiteNumber(input.scale, 1.5, 0.5, 3, 'scale');
      let document: any;
      try {
        const pdfjs = await loadPdfJs();
        const bytes = fs.readFileSync(abs);
        const task = pdfjs.getDocument({
          data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          isEvalSupported: false,
          useSystemFonts: true,
        });
        document = await task.promise;
        if (document.numPages > MAX_PAGE_COUNT) {
          return errResult('E_PDF_LIMIT', `PDF exceeds the ${MAX_PAGE_COUNT}-page rendering limit`);
        }
        if (pageNumber > document.numPages) {
          return errResult('E_BAD_INPUT', `page must be within 1-${document.numPages}`);
        }
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale });
        if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)
          || viewport.width <= 0 || viewport.height <= 0) {
          return errResult('E_PDF_RENDER_FAILED', 'page has invalid render dimensions');
        }
        const maxDimension = 4096;
        const pixelScale = Math.sqrt(MAX_RENDER_PIXELS / (viewport.width * viewport.height));
        const fittedScale = Math.min(
          1,
          maxDimension / viewport.width,
          maxDimension / viewport.height,
          pixelScale,
        );
        const fittedViewport = fittedScale < 1
          ? page.getViewport({ scale: scale * fittedScale })
          : viewport;
        const canvas = createCanvas(Math.ceil(fittedViewport.width), Math.ceil(fittedViewport.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: fittedViewport }).promise;
        page.cleanup();
        return {
          content: JSON.stringify({
            path: abs,
            page: pageNumber,
            page_count: document.numPages,
            width: canvas.width,
            height: canvas.height,
          }),
          images: [{ data: canvas.toBuffer('image/png').toString('base64'), mediaType: 'image/png' }],
        };
      } catch (err) {
        log.warn('PDF render failed', { path: logPathRef(abs), error: logErrorRef(err) });
        return errResult('E_PDF_RENDER_FAILED', (err as Error).message || String(err));
      } finally {
        try { await document?.destroy?.(); } catch { /* best effort */ }
      }
    },
  };
}

export function createPdfTools(opts: PdfToolsOpts = {}): AgentTool[] {
  return [createEditPdfTool(opts), createPdfRenderTool(opts)];
}
