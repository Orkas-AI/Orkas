/**
 * Office document tools backed by the bundled OfficeCLI engine
 * (`features/office/office_engine.ts`). Tier-1 built-in capability: a
 * non-technical user asks for a Word/Excel/PPT file in the main chat and gets
 * one, zero-config, cross-platform (incl. Windows), no MS Office installed.
 *
 * Tools: `create_docx`, `create_xlsx`, `create_pptx` (create → batch-fill →
 * first-page PNG preview) and `office_review` (validate/render an existing doc). They
 * follow the same conventions as `local-tools.ts`: re-read the local-execution
 * permission on every call, path-sandbox to the conversation's scope,
 * uniquify-on-collision, and fire `onFileWritten` so the produced-file chip
 * shows. The OfficeCLI resident daemon is always reaped in a `finally`.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentTool, ToolContext, ToolResult, ToolResultImage } from '#core-agent';
import { isPathAllowed } from '../../util/path-sandbox';
import { getWorkspacePath } from '../../features/user_workspace';
import { chatAttachmentDirForConversation } from '../../util/project-layout';
import { uniquifyPath, renderRenameSignal } from '../../util/uniquify-path';
import { fileEditLock } from '../../util/locks';
import { officeCliAvailable, runOfficeCli, closeOfficeFile, OfficeCliError } from '../../features/office/office_engine';
import { renderOfficePageToPng } from '../../features/office/office_page_renderer';
import {
  buildDocxBatch, buildXlsxWorkbookBatch, buildPptxBatch, buildEditBatch, serializeOfficeBatch,
  type DocxParagraphSpec, type DocxTableSpec, type DocxImageSpec,
  buildXlsxCellProps, type XlsxCell, type XlsxCellProperties, type XlsxSheetSpec,
  type PptxSlideSpec, type PptxImageSpec,
  type EditOp, type OfficeBatchOp, OfficeEditInputError,
} from './office-batch';
import { createLogger } from '../../logger';
import { logErrorRef, logPathRef, maskId } from '../../util/log-redact';
import { auditPptxContrast } from './pptx-contrast';

const log = createLogger('office-tools');

function sha256Bytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sha256File(file: string): string {
  return sha256Bytes(fs.readFileSync(file));
}

function shortRevision(sha256: string): string {
  return sha256.replace(/^sha256:/, '').slice(0, 16);
}

/** Stable model-visible identity for the artifact that now exists on disk.
 * Keep the surrounding prose for older clients while giving every model one
 * unambiguous path/revision pair to reuse for review, edit, and publication. */
function renderOfficeArtifactReceipt(file: string): string {
  return `\n<office-artifact>${JSON.stringify({
    artifact_path: path.resolve(file),
    artifact_revision: shortRevision(sha256File(file)),
  })}</office-artifact>`;
}

function officeIssueCount(value: unknown): number | null {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Number.isFinite(record.count) && Number(record.count) >= 0) {
    return Math.trunc(Number(record.count));
  }
  if (Array.isArray(record.issues)) return record.issues.length;
  return officeIssueCount(record.data);
}

type OfficeIssueSeverity = 'blocker' | 'warning' | 'info' | 'unknown';

const BLOCKING_OFFICE_ISSUE_SUBTYPES = new Set([
  'formula_ref_missing_sheet',
  'formula_eval_error',
  'chart_series_ref_missing_sheet',
  'definedname_broken',
  'definedname_target_missing',
  'broken_part_ref',
]);

const WARNING_OFFICE_ISSUE_SUBTYPES = new Set([
  'formula_not_evaluated',
  'formula_cache_stale',
  'field_not_evaluated',
  'field_cache_stale',
  'slide_field_not_evaluated',
  'notes_unresolved_rid',
  'chart_cache_stale',
]);

function parseOfficeCliOutput(stdout: string, stderr: string): unknown {
  const raw = (stdout || stderr || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function unwrapOfficeCliResult(value: unknown): { ok: true; data: unknown } | { ok: false; error: unknown } {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.success === false) {
      return { ok: false, error: record.error ?? 'OfficeCLI returned success=false' };
    }
    if (record.success === true && Object.prototype.hasOwnProperty.call(record, 'data')) {
      return { ok: true, data: record.data };
    }
  }
  return { ok: true, data: value };
}

function officeIssueEntries(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  }
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.issues)) return officeIssueEntries(record.issues);
  return officeIssueEntries(record.data);
}

function officeIssueSeverity(issue: Record<string, unknown>): OfficeIssueSeverity {
  const upstream = typeof issue.severity === 'string' ? issue.severity.trim().toLowerCase() : '';
  if (['blocker', 'error', 'fatal', 'critical'].includes(upstream)) return 'blocker';
  if (['warning', 'warn', 'advisory'].includes(upstream)) return 'warning';
  if (['info', 'information'].includes(upstream)) return 'info';

  const subtype = [issue.subtype, issue.type, issue.code]
    .find((value): value is string => typeof value === 'string' && !!value.trim())
    ?.trim().toLowerCase();
  if (subtype && BLOCKING_OFFICE_ISSUE_SUBTYPES.has(subtype)) return 'blocker';
  if (subtype && WARNING_OFFICE_ISSUE_SUBTYPES.has(subtype)) return 'warning';
  return 'unknown';
}

function summarizeOfficeIssueSeverities(value: unknown, count: number | null): Record<OfficeIssueSeverity, number> {
  const entries = officeIssueEntries(value);
  const summary: Record<OfficeIssueSeverity, number> = {
    blocker: 0,
    warning: 0,
    info: 0,
    unknown: 0,
  };
  for (const entry of entries) summary[officeIssueSeverity(entry)] += 1;
  if (count !== null && count > entries.length) summary.unknown += count - entries.length;
  return summary;
}

function compactXlsxStats(value: unknown): {
  sheet_count: number;
  total_cells: number;
  formula_cells: number;
  error_cells: number;
} | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object'
    ? record.data as Record<string, unknown>
    : record;
  const fields = [data.sheets, data.totalCells, data.formulaCells, data.errorCells];
  if (!fields.every((field) => Number.isFinite(field) && Number(field) >= 0)) return null;
  return {
    sheet_count: Math.trunc(Number(data.sheets)),
    total_cells: Math.trunc(Number(data.totalCells)),
    formula_cells: Math.trunc(Number(data.formulaCells)),
    error_cells: Math.trunc(Number(data.errorCells)),
  };
}

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

function errResult(code: string, msg: string): ToolResult {
  return { content: `${code}: ${msg}`, isError: true };
}

function isResidentDeliveryFailure(result: { stdout: string; stderr: string }): boolean {
  const message = `${result.stderr || ''}\n${result.stdout || ''}`;
  return /batch could not be delivered|main pipe (?:busy|unresponsive)|resident.+(?:busy|unresponsive)/i
    .test(message);
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
  const fieldsByAction: Readonly<Record<string, ReadonlySet<string>>> = {
    set: new Set(['action', 'path', 'props']),
    add: new Set(['action', 'parent', 'type', 'props']),
    remove: new Set(['action', 'path']),
  };
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { error: `operations[${index}] must be an object` };
    }
    const operation = item as Record<string, unknown>;
    const action = String(operation.action ?? '');
    const allowed = fieldsByAction[action];
    if (!allowed) {
      return { error: `operations[${index}].action must be set, add, or remove` };
    }
    const unexpected = Object.keys(operation).filter((key) => !allowed.has(key)).sort();
    if (unexpected.length) {
      return {
        error: `edit_office ${action} at operations[${index}] does not accept: ${unexpected.join(', ')}`,
      };
    }
    const normalizedProps = normalizeEditProps(opts, ctx, operation.props);
    if ('error' in normalizedProps) return normalizedProps;
    operations.push({
      ...operation,
      ...(operation.props !== undefined ? { props: normalizedProps.value } : {}),
    } as EditOp);
  }
  return { operations };
}

function xlsxTablePlacementError(operations: readonly EditOp[]): string | null {
  for (const [index, operation] of operations.entries()) {
    if (operation.action !== 'add' || operation.type !== 'table') continue;
    const ref = operation.props?.ref;
    const range = operation.props?.range;
    const hasPlacement = (typeof ref === 'string' && ref.trim())
      || (typeof range === 'string' && range.trim());
    if (!hasPlacement) {
      return `Excel add-table operation at operations[${index}] requires props.ref or props.range (e.g. "A1:G6")`;
    }
  }
  return null;
}

const XLSX_CELL_WRAPPER_PATH = /\/cell\[[^\]]+\](?:\/|$)/i;
const XLSX_A1_LIKE_TAIL = /^[A-Za-z]+[0-9]+(?::[A-Za-z]+[0-9]+)?$/;
const XLSX_A1_TAIL = /^([A-Za-z]{1,3})([1-9][0-9]*)(?::([A-Za-z]{1,3})([1-9][0-9]*))?$/;
const XLSX_MAX_ROW = 1_048_576;
const XLSX_MAX_COLUMN = 16_384; // XFD

function xlsxColumnNumber(column: string): number {
  let value = 0;
  for (const char of column.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
  return value;
}

function xlsxA1TailError(tail: string): string | null {
  if (!XLSX_A1_LIKE_TAIL.test(tail)) return null;
  const match = tail.match(XLSX_A1_TAIL);
  if (!match) return `invalid XLSX cell path segment \`${tail}\``;
  const [, startColumn, startRow, endColumn, endRow] = match;
  const invalid = xlsxColumnNumber(startColumn) > XLSX_MAX_COLUMN
    || Number(startRow) > XLSX_MAX_ROW
    || (!!endColumn && xlsxColumnNumber(endColumn) > XLSX_MAX_COLUMN)
    || (!!endRow && Number(endRow) > XLSX_MAX_ROW);
  return invalid ? `XLSX cell path segment \`${tail}\` is outside A1:XFD1048576` : null;
}

/** Validate only XLSX-specific cell addressing while leaving sheet, table,
 * chart, picture, row, and column paths to OfficeCLI. Ordinary cell targets
 * use `/Sheet/A1` (or an A1 range); the XML-like `/cell[A1]` form is never a
 * valid stable XLSX path. */
function xlsxTargetPathError(target: unknown): string | null {
  if (typeof target !== 'string' || !target) return null;
  if (XLSX_CELL_WRAPPER_PATH.test(target)) {
    return `XLSX cells use an A1 path such as \`/Sheet1/A2\`; do not use \`/Sheet1/cell[A2]\``;
  }
  const tail = target.split('/').filter(Boolean).at(-1) || '';
  return xlsxA1TailError(tail);
}

function xlsxEditContractError(operations: readonly EditOp[]): string | null {
  for (const [index, operation] of operations.entries()) {
    const target = operation.action === 'add' ? operation.parent : operation.path;
    const pathError = xlsxTargetPathError(target);
    if (pathError) return `operations[${index}]: ${pathError}`;
    if (
      operation.action === 'add'
      && operation.type === 'cell'
      && operation.props
      && Object.prototype.hasOwnProperty.call(operation.props, 'cell')
    ) {
      return `operations[${index}]: XLSX cell placement belongs in the parent A1 path, e.g. \`parent:"/Sheet1/A2"\`; do not use \`props.cell\`. For an ordinary write, prefer \`action:"set"\` with \`path:"/Sheet1/A2"\`.`;
    }
  }
  return null;
}

function normalizeXlsxCellSetOperations(operations: readonly EditOp[]): EditOp[] {
  return operations.map((operation) => {
    if (operation.action !== 'set' || !operation.props) return operation;
    const tail = operation.path.split('/').filter(Boolean).at(-1) || '';
    if (!XLSX_A1_TAIL.test(tail)) return operation;
    return {
      ...operation,
      props: buildXlsxCellProps(operation.props as XlsxCellProperties, { allowEmptyValue: true }),
    };
  });
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
  try {
    const png = await renderOfficePageToPng(file, cwd, page, signal);
    return { data: png.toString('base64'), mediaType: 'image/png' };
  } catch (err) {
    log.warn('render error', { error: logErrorRef(err) });
    return null;
  }
}

/** Shared create pipeline: uniquify → create → batch-fill → preview → emit.
 *  The OfficeCLI resident is reaped in a `finally`. Caller has already checked
 *  the permission gate, engine availability, extension, and output sandbox. */
async function runCreate(
  opts: OfficeToolsOpts,
  ctx: ToolContext,
  args: {
    inputAbs: string;
    createFlags: string[];
    ops: OfficeBatchOp[];
    wantPreview: boolean;
    noun: string;
    unit: string;
    unitCount: number;
  },
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
      let batched = await runOfficeCli(['batch', workPath], {
        cwd: tempDir, stdin: serializeOfficeBatch(args.ops), ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      // A lost resident reply does not prove the batch was unapplied. Restart
      // this private creation once at a new path; never replay non-idempotent
      // operations against the possibly mutated file. Existing user files and
      // ordinary authoring/validation failures are not retry targets.
      if (batched.code !== 0 && isResidentDeliveryFailure(batched)) {
        await closeOfficeFile(workPath, tempDir);
        ctx.signal?.throwIfAborted();
        const retryDir = fs.mkdtempSync(path.join(tempDir, 'retry-'));
        workPath = path.join(retryDir, path.basename(finalPath));
        const recreated = await runOfficeCli(['create', workPath, ...args.createFlags], {
          cwd: tempDir, ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        if (recreated.code !== 0) {
          return errResult('E_OFFICE_CREATE_FAILED', recreated.stderr || recreated.stdout || `exit ${recreated.code}`);
        }
        batched = await runOfficeCli(['batch', workPath], {
          cwd: tempDir, stdin: serializeOfficeBatch(args.ops), ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }
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

    const n = args.unitCount;
    const base = `${args.noun} created: ${finalPath} (${n} ${args.unit}${n === 1 ? '' : 's'})`;
    const renameSignal = renamed ? renderRenameSignal(args.inputAbs, finalPath) : '';
    const content = `${base}${renameSignal}${renderOfficeArtifactReceipt(finalPath)}`;
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
      'Create one editable DOCX from ordered paragraphs, tables, and workspace or attachment images. Returns the saved path and an optional first-page PNG; use edit_office on the returned path for corrections. Name collisions are reported.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Output .docx path; absolute or workspace-relative.' },
        title: { type: 'string', description: 'Optional Heading 1 before the body.' },
        paragraphs: {
          type: 'array',
          description: 'Body paragraphs, in order.',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              style: { type: 'string', description: 'Style id, e.g. Heading1, Normal, or Quote.' },
              align: { type: 'string', enum: ['left', 'center', 'right', 'justify'] },
              list: { type: 'string', enum: ['bullet', 'ordered'] },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              font: { type: 'string' },
              size: { type: 'string', description: 'Font size, e.g. "14pt".' },
              color: { type: 'string', description: 'Text color, e.g. "#1F4E79".' },
              underline: { type: 'string', description: 'Underline style.' },
              highlight: { type: 'string', description: 'Highlight color name.' },
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
                description: 'Rectangular cell grid.',
                items: { type: 'array', items: { type: ['string', 'number'] } },
              },
              colWidths: { type: 'string', description: 'Comma-separated widths with units, e.g. "2in,3in".' },
            },
            required: ['rows'],
          },
        },
        images: {
          type: 'array',
          description: 'Images appended after tables; src must be in the workspace or attachments.',
          items: {
            type: 'object',
            properties: {
              src: { type: 'string', description: 'Absolute or workspace-relative image path.' },
              width: { type: 'string', description: 'Display width with unit, e.g. "3in".' },
              height: { type: 'string', description: 'Display height with unit.' },
              align: { type: 'string', description: 'Host paragraph: left, center, or right.' },
            },
            required: ['src'],
          },
        },
        locale: { type: 'string', description: 'Default-font locale, e.g. "zh-CN".' },
        preview: { type: 'boolean', description: 'Return a first-page PNG; default true.' },
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
        unitCount: paragraphs.length,
      });
    },
  };
}

/** One model-visible source for XLSX cell properties. The generic
 * `edit_office` tool also edits DOCX/PPTX, so these are advertised as the
 * XLSX-only subset of its otherwise open scalar `props` object. */
function xlsxCellPropertySchema(): Record<string, unknown> {
  return {
    value: { type: ['string', 'number', 'boolean'], description: 'Literal XLSX cell value.' },
    formula: { type: 'string', description: 'XLSX formula without a leading "="; when present it wins over value.' },
    format: { type: 'string', description: 'Excel number format, e.g. "#,##0.00", "yyyy-mm-dd", or "@".' },
    type: {
      type: 'string',
      enum: ['string', 'number', 'boolean', 'date', 'error', 'richtext'],
      description: 'Optional explicit XLSX cell type; normally inferred from value or formula.',
    },
    bold: { type: 'boolean' },
    italic: { type: 'boolean' },
    fill: { type: 'string', description: 'XLSX cell background fill color.' },
    'font.name': { type: 'string', description: 'XLSX cell font family.' },
    'font.color': { type: 'string', description: 'XLSX cell text color; do not use the ambiguous bare color key.' },
    'font.size': { type: 'string' },
    underline: { type: 'string', description: 'Underline style.' },
    halign: { type: 'string', description: 'Horizontal alignment.' },
    valign: { type: 'string', description: 'Vertical alignment.' },
    wrap: { type: 'boolean', description: 'Wrap text.' },
    border: { type: 'string', description: 'Border style on all sides.' },
    merge: { type: 'string', description: 'Merge range anchored at this cell, e.g. "A1:C1".' },
  };
}

function createXlsxTool(opts: OfficeToolsOpts): AgentTool {
  const chartSchema = {
    type: 'object',
    description: 'Native editable chart; prefer cell ranges over inline data.',
    properties: {
      type: {
        type: 'string',
        enum: [
          'bar', 'column', 'line', 'pie', 'doughnut', 'area', 'scatter', 'bubble', 'radar',
          'stock', 'combo', 'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker',
          'histogram', 'pareto',
        ],
      },
      dataRange: {
        type: 'string',
        description: 'Source range, e.g. "Trend!B1:C32"; headers name series.',
      },
      categories: {
        type: 'string',
        description: 'Category-label range, e.g. "Trend!A2:A32".',
      },
      data: {
        type: 'string',
        description: 'Inline fallback, e.g. "Sales:10,20,30".',
      },
      title: { type: 'string' },
      anchor: { type: 'string', description: 'Cell anchor rectangle, e.g. "D2:L18".' },
      legend: {
        type: 'string',
        enum: ['true', 'false', 'none', 'top', 'bottom', 'left', 'right', 'topRight'],
        description: 'Legend visibility or position.',
      },
      dataLabels: {
        type: 'string',
        description: 'Labels, e.g. "value", "percent", "outsideEnd", or "none".',
      },
      catTitle: { type: 'string', description: 'Category-axis title.' },
      axistitle: { type: 'string', description: 'Value-axis title.' },
      axismin: { type: 'number', description: 'Value-axis minimum.' },
      axismax: { type: 'number', description: 'Optional value-axis maximum.' },
      axisnumfmt: { type: 'string', description: 'Value-axis number format, e.g. "#,##0" or "0.0%".' },
      gridlines: { type: ['boolean', 'string'], description: 'Major gridlines or line style.' },
      colors: { type: 'string', description: 'Comma-separated series colors, e.g. "4472C4,ED7D31".' },
      preset: {
        type: 'string',
        enum: ['minimal', 'dark', 'corporate', 'magazine', 'dashboard', 'colorful', 'monochrome'],
      },
      style: { type: 'number', description: 'Built-in Excel chart style id (1-48).' },
      labelrotation: { type: 'number', description: 'Axis label rotation in degrees (-90 to 90).' },
      width: { type: 'string', description: 'Width with unit; anchor takes precedence.' },
      height: { type: 'string', description: 'Height with unit; anchor takes precedence.' },
      smooth: { type: 'boolean', description: 'Smooth line/scatter series.' },
      marker: { type: 'string', description: 'Line/scatter marker, e.g. "circle:6" or "none".' },
      linewidth: { type: 'number', description: 'Series line width in points.' },
      gapwidth: { type: 'number', description: 'Bar/column gap width from 0 to 500.' },
      overlap: { type: 'number', description: 'Bar/column overlap from -100 to 100.' },
      varyColors: { type: 'boolean', description: 'Vary colors by point for a single-series chart.' },
      secondaryaxis: {
        type: 'string',
        description: '1-based series indices on the secondary axis, e.g. "2".',
      },
      combotypes: {
        type: 'string',
        description: 'Per-series types for a combo chart, e.g. "column,line".',
      },
      combosplit: { type: 'number', description: 'Combo split: first N series use the primary chart type.' },
      referenceline: {
        type: 'string',
        description: 'Target line as "value:color:label:dash".',
      },
    },
    required: ['type'],
  };
  const cellSchema = {
    oneOf: [
      { type: 'string' },
      { type: 'number' },
      { type: 'boolean' },
      {
        type: 'object',
        properties: xlsxCellPropertySchema(),
      },
    ],
  };
  const columnSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Column letter, e.g. "A".' },
      width: { type: 'string', description: 'Width in character units.' },
      hidden: { type: 'boolean' },
    },
    required: ['name'],
  };
  return {
    name: 'create_xlsx',
    description:
      'Create one editable XLSX from sheets with styled or formula cells, column settings, and native charts bound to cell ranges. Returns the saved path and an optional PNG preview; use edit_office on the returned path for corrections. Name collisions are reported.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Output .xlsx path; absolute or workspace-relative.' },
        sheets: {
          type: 'array',
          minItems: 1,
          description: 'Worksheets in tab order.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Sheet tab name.' },
              rows: {
                type: 'array',
                description: 'Rows of cells in top-to-bottom order.',
                items: { type: 'array', items: cellSchema },
              },
              columns: {
                type: 'array',
                description: 'Column width and visibility settings.',
                items: columnSchema,
              },
              charts: {
                type: 'array',
                description: 'Native editable charts on this sheet.',
                items: chartSchema,
              },
            },
            required: ['name'],
          },
        },
        preview: { type: 'boolean', description: 'Return a PNG preview; default true.' },
      },
      required: ['path', 'sheets'],
    },
    async execute(input, ctx) {
      const prep = prepareOutput(opts, ctx, input, '.xlsx');
      if ('error' in prep) return prep.error;
      const hasCanonicalSheets = Array.isArray(input.sheets) && input.sheets.length > 0;
      const hasLegacyFields = ['sheet', 'rows', 'columns', 'charts']
        .some((key) => Object.prototype.hasOwnProperty.call(input, key));
      if (hasCanonicalSheets && hasLegacyFields) {
        return errResult('E_BAD_INPUT', 'use `sheets` alone; do not mix it with legacy sheet/rows/columns/charts fields');
      }
      // Direct execution of persisted historical calls remains supported even
      // though the public schema now exposes only the canonical sheets form.
      const sheets: XlsxSheetSpec[] = hasCanonicalSheets
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
        unitCount: sheets.reduce(
          (total, sheet) => total + (Array.isArray(sheet.rows)
            ? sheet.rows.reduce((sheetTotal, row) => sheetTotal + (Array.isArray(row) ? row.length : 0), 0)
            : 0),
          0,
        ),
      });
    },
  };
}

function createPptxTool(opts: OfficeToolsOpts): AgentTool {
  return {
    name: 'create_pptx',
    description:
      'Create one editable PPTX from slides containing positioned text, workspace or attachment images, native editable charts, tables, backgrounds, and transitions. Use edit_office on the returned path for corrections. Returns the collision-safe saved path and optional preview.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Output .pptx path; absolute or workspace-relative.' },
        slides: {
          type: 'array',
          description: 'Slides, in order.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Auto-placed title.' },
              body: { type: 'string', description: 'Auto-placed body; newlines split lines.' },
              layout: { type: 'string', description: 'Layout name, e.g. "Title and Content".' },
              background: { type: 'string', description: 'Hex, scheme color, or C1-C2[-angle] gradient.' },
              transition: { type: 'string', description: 'Transition, e.g. fade, push, wipe, or morph.' },
              shapes: {
                type: 'array',
                description: 'Positioned text shapes above title/body placeholders.',
                items: {
                  type: 'object',
                  description: 'Text shape with geometry and style properties.',
                  properties: {
                    text: { type: 'string' },
                    x: { type: 'string', description: 'Left position with unit.' },
                    y: { type: 'string', description: 'Top position with unit.' },
                    width: { type: 'string', description: 'Width with unit.' },
                    height: { type: 'string', description: 'Height with unit.' },
                    fill: { type: 'string', description: 'Fill color or gradient.' },
                    color: { type: 'string' },
                    size: { type: 'string', description: 'Font size.' },
                    bold: { type: 'boolean' },
                    align: { type: 'string', description: 'left, center, or right.' },
                    valign: { type: 'string', description: 'top, middle, or bottom.' },
                    font: { type: 'string' },
                    'font.ea': { type: 'string', description: 'CJK font family.' },
                    geometry: { type: 'string', description: 'Shape preset; default rect.' },
                    opacity: { type: 'number', description: 'Fill opacity, 0-100; requires a fill.' },
                    margin: { type: 'string', description: 'One or four internal margins.' },
                    line: { type: 'string', description: 'Outline color.' },
                    lineWidth: { type: 'string', description: 'Outline width.' },
                    lineDash: { type: 'string', description: 'Outline dash style.' },
                    lineOpacity: { type: 'number', description: 'Outline opacity, 0-100.' },
                    gradient: { type: 'string', description: 'Gradient fill.' },
                    rotation: { type: 'number', description: 'Clockwise rotation in degrees.' },
                    autoFit: { type: 'boolean', description: 'Fit text to the shape.' },
                    lineSpacing: { type: 'string' },
                    spaceBefore: { type: 'string' },
                    spaceAfter: { type: 'string' },
                    shadow: {
                      type: ['string', 'boolean'],
                      description: 'true, "none", or a shadow color; preset names are unsupported.',
                    },
                    name: { type: 'string', description: 'Stable edit name.' },
                  },
                },
              },
              images: {
                type: 'array',
                description: 'Pictures; src must be in the workspace or attachments.',
                items: {
                  type: 'object',
                  properties: {
                    src: { type: 'string', description: 'Absolute or workspace-relative path.' },
                    x: { type: 'string', description: 'Left position with unit.' },
                    y: { type: 'string', description: 'Top position with unit.' },
                    width: { type: 'string', description: 'Width with unit.' },
                    height: { type: 'string', description: 'Height with unit.' },
                    crop: { type: 'string', description: 'Crop mode or rectangle.' },
                    cropLeft: { type: 'number', description: 'Left crop percent.' },
                    cropRight: { type: 'number', description: 'Right crop percent.' },
                    cropTop: { type: 'number', description: 'Top crop percent.' },
                    cropBottom: { type: 'number', description: 'Bottom crop percent.' },
                    opacity: { type: 'number', description: 'Opacity, 0-100.' },
                    rotation: { type: 'number', description: 'Clockwise rotation in degrees.' },
                    alt: { type: 'string', description: 'Alternative text.' },
                    name: { type: 'string', description: 'Stable edit name.' },
                  },
                  required: ['src'],
                },
              },
              charts: {
                type: 'array',
                description: 'Native editable charts; source external data visibly on the slide.',
                items: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      enum: ['bar', 'column', 'line', 'pie', 'doughnut', 'area', 'scatter', 'bubble', 'radar', 'stock', 'combo', 'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker', 'histogram', 'pareto'],
                    },
                    data: { type: 'string', description: 'Series: "Name:1,2,3;Name 2:4,5,6".' },
                    categories: { type: 'string', description: 'Comma-separated category labels.' },
                    title: { type: 'string' },
                    x: { type: 'string', description: 'Left position with unit.' },
                    y: { type: 'string', description: 'Top position with unit.' },
                    width: { type: 'string', description: 'Width with unit.' },
                    height: { type: 'string', description: 'Height with unit.' },
                    anchor: { type: 'string', description: 'Positioning anchor.' },
                    legend: { type: 'string', description: 'Legend position or visibility.' },
                    colors: { type: 'string', description: 'Comma-separated series colors.' },
                    dataLabels: { type: 'string', description: 'Data-label style or visibility.' },
                    preset: { type: 'string', description: 'Built-in chart style preset.' },
                    axismin: { type: 'number', description: 'Value-axis minimum.' },
                    axismax: { type: 'number', description: 'Value-axis maximum.' },
                    catTitle: { type: 'string', description: 'Category-axis title.' },
                    axistitle: { type: 'string', description: 'Value-axis title.' },
                    gridlines: { type: 'string', description: 'Gridline style or visibility.' },
                    plotFill: { type: 'string', description: 'Plot-area fill color.' },
                    chartFill: { type: 'string', description: 'Chart-area fill color.' },
                    name: { type: 'string', description: 'Stable edit name.' },
                  },
                  required: ['type', 'data'],
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
                      description: 'Cell grid.',
                      items: { type: 'array', items: { type: ['string', 'number'] } },
                    },
                    x: { type: 'string', description: 'Left position with unit.' },
                    y: { type: 'string', description: 'Top position with unit.' },
                    width: { type: 'string', description: 'Table width with unit.' },
                    height: { type: 'string', description: 'Table height with unit.' },
                    rowHeight: { type: 'string', description: 'Default row height.' },
                    colWidths: { type: 'string', description: 'Comma-separated column widths.' },
                    headerFill: { type: 'string', description: 'Header-row fill color.' },
                    bodyFill: { type: 'string', description: 'Body-row fill color.' },
                    style: { type: 'string', description: 'Native PowerPoint table style name.' },
                    'border.all': { type: 'string', description: 'All-border style/color.' },
                    'border.horizontal': { type: 'string', description: 'Horizontal-border style/color.' },
                    'border.vertical': { type: 'string', description: 'Vertical-border style/color.' },
                    firstRow: { type: 'boolean', description: 'Emphasize header row.' },
                    bandedRows: { type: 'boolean', description: 'Alternate body-row styling.' },
                    name: { type: 'string', description: 'Stable edit name.' },
                  },
                  required: ['rows'],
                },
              },
            },
          },
        },
        preview: { type: 'boolean', description: 'Return a first-slide PNG; default true.' },
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
        unitCount: slides.length,
      });
    },
  };
}

function createOfficeRenderTool(opts: OfficeToolsOpts): AgentTool {
  return {
    name: 'office_render',
    description:
      'Render one numbered page of an existing Word/Excel/PowerPoint file to a PNG image so you can see how it looks ' +
      '(layout, fonts, CJK glyphs). Uses the built-in Office engine (no Microsoft Office required). ' +
      'Provide `path` (a .docx/.xlsx/.pptx in this conversation), an optional one-based positive-integer string ' +
      '`page` (default "1"), and ' +
      '`analysis_mode:"quality_review"` only when the returned image must be checked for visual defects. ' +
      'For XLSX, `page` is the worksheet position in workbook order; use office_read mode "outline" to map names ' +
      'to positions, and never pass a worksheet name or cell range as `page`. ' +
      'The image is available to the next inference only: preserve concrete findings in assistant text before follow-up tools. ' +
      'Returns the image plus artifact/image revision ids so later turns can distinguish current from stale evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to an existing .docx/.xlsx/.pptx (absolute or workspace-relative).' },
        page: {
          type: 'string',
          description: 'One-based page/slide number, or XLSX worksheet position in workbook order, e.g. "1". Never pass an XLSX worksheet name or cell range. Default "1".',
        },
        analysis_mode: {
          type: 'string',
          enum: ['understand', 'quality_review'],
          description:
            'How the model should analyze the returned PNG. Default "understand"; use "quality_review" only for explicit visual-defect review.',
        },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
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
      const analysisMode = input.analysis_mode === 'quality_review' ? 'quality_review' : 'understand';
      try {
        return await renderOfficePage(abs, cwd, page, analysisMode, ctx.signal, {
          artifactSha256: sha256File(abs),
          echoArtifactSha256: true,
        });
      } finally {
        await closeOfficeFile(abs, cwd);
      }
    },
  };
}

/** Render one page on whatever resident currently holds `abs`. The caller owns
 *  the resident lifetime and the artifact hash, so a multi-page review can keep
 *  one resident and hash the file once instead of once per page. */
async function renderOfficePage(
  abs: string,
  cwd: string,
  page: string,
  analysisMode: 'understand' | 'quality_review',
  signal: AbortSignal | undefined,
  artifact: { artifactSha256: string; echoArtifactSha256: boolean },
): Promise<ToolResult> {
  const img = await renderToImage(abs, cwd, page, signal);
  if (!img) return errResult('E_OFFICE_RENDER_FAILED', `could not render ${abs} page ${page}`);
  const imageSha256 = sha256Bytes(Buffer.from(img.data, 'base64'));
  return {
    content:
      `Rendered page=${page} mode=${analysisMode} ` +
      `artifact_revision=${shortRevision(artifact.artifactSha256)} ` +
      `image_revision=${shortRevision(imageSha256)} path=${abs}` +
      (artifact.echoArtifactSha256 ? ` artifact_sha256=${artifact.artifactSha256}` : '') +
      ` image_sha256=${imageSha256}`,
    images: [{ ...img, analysisMode }],
    observations: { fileReads: [{ path: abs, hash: artifact.artifactSha256 }] },
  };
}

function officeFileSnapshot(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    return st.isFile()
      ? JSON.stringify([st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs])
      : null;
  } catch {
    return null;
  }
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
      try {
        return (await checkOfficeFile(abs, cwd, ctx.signal)).result;
      } catch (err) {
        const code = err instanceof OfficeCliError ? err.code : 'E_OFFICE_CHECK_FAILED';
        return errResult(code, (err as Error).message);
      } finally {
        await closeOfficeFile(abs, cwd);
      }
    },
  };
}

/** Structural check on whatever resident currently holds `abs`. The caller
 *  owns the resident lifetime; the artifact hash is returned so a review that
 *  continues on the same resident does not hash the file again. */
async function checkOfficeFile(
  abs: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<{ result: ToolResult; artifactSha256: string }> {
  const validate = await runOfficeCli(['validate', abs, '--json'], {
    cwd, ...(signal ? { signal } : {}),
  });
  const issues = await runOfficeCli(['view', abs, 'issues', '--json'], {
    cwd, ...(signal ? { signal } : {}),
  });
  let normalizedIssues = parseOfficeCliOutput(issues.stdout, issues.stderr);
  let contrastScanOk: boolean | undefined;
  let contrastFindings: number | undefined;
  let contrastTextRuns: number | undefined;
  if (path.extname(abs).toLowerCase() === '.pptx') {
    const tree = await runOfficeCli(['get', abs, '/', '--depth', '6', '--json'], {
      cwd, ...(signal ? { signal } : {}),
    });
    contrastScanOk = tree.code === 0;
    if (contrastScanOk) {
      const audit = auditPptxContrast(
        normalizedIssues,
        parseOfficeCliOutput(tree.stdout, tree.stderr),
      );
      normalizedIssues = audit.issues;
      contrastFindings = audit.findingCount;
      contrastTextRuns = audit.scannedTextCount;
    }
  }
  const isXlsx = path.extname(abs).toLowerCase() === '.xlsx';
  let xlsxStats: ReturnType<typeof compactXlsxStats> = null;
  let xlsxStatsScanOk: boolean | undefined;
  if (isXlsx) {
    const stats = await runOfficeCli(['view', abs, 'stats', '--json'], {
      cwd, ...(signal ? { signal } : {}),
    });
    xlsxStats = compactXlsxStats(parseOfficeCliOutput(stats.stdout, stats.stderr));
    xlsxStatsScanOk = stats.code === 0 && xlsxStats !== null;
  }
  const artifactSha256 = sha256File(abs);
  const issueCount = officeIssueCount(normalizedIssues);
  const issueSeverities = summarizeOfficeIssueSeverities(normalizedIssues, issueCount);
  const reviewStatus = validate.code !== 0
    ? 'invalid'
    : issueSeverities.blocker > 0 || (xlsxStats?.error_cells ?? 0) > 0
      ? 'blockers_found'
      : issues.code !== 0 || issueCount === null || xlsxStatsScanOk === false || issueSeverities.unknown > 0
        ? 'indeterminate'
        : 'reviewed';
  const payload = {
    valid: validate.code === 0,
    issue_count: issueCount,
    issue_severity_counts: issueSeverities,
    structural_review_status: reviewStatus,
    artifact_revision: shortRevision(artifactSha256),
    issue_scan_ok: issues.code === 0,
    validation_exit_code: validate.code,
    issue_scan_exit_code: issues.code,
    ...(contrastScanOk === undefined ? {} : {
      contrast_scan_ok: contrastScanOk,
      contrast_findings: contrastFindings ?? 0,
      contrast_text_runs: contrastTextRuns ?? 0,
    }),
    ...(xlsxStatsScanOk === undefined ? {} : {
      xlsx_stats_scan_ok: xlsxStatsScanOk,
      ...(xlsxStats ? { xlsx_stats: xlsxStats } : {}),
    }),
    path: abs,
    artifact_sha256: artifactSha256,
    validation: parseOfficeCliOutput(validate.stdout, validate.stderr),
    issues: normalizedIssues,
  };
  return {
    result: {
      content: JSON.stringify(payload),
      observations: { fileReads: [{ path: abs, hash: artifactSha256 }] },
      ...(payload.valid ? {} : { isError: true }),
    },
    artifactSha256,
  };
}

function createOfficeReviewTool(opts: OfficeToolsOpts): AgentTool {
  const check = createOfficeCheckTool(opts);
  return {
    name: 'office_review',
    description:
      'Validate or render DOCX, XLSX, or PPTX for structural and visual review.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['check', 'render', 'check_and_render'],
          description: 'check scans OpenXML with path only; render/check_and_render use pages/analysis_mode; omit unrelated fields. check_and_render stops on validation failure.',
        },
        path: { type: 'string', description: 'Existing .docx/.xlsx/.pptx path, absolute or workspace-relative.' },
        pages: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: { type: 'string' },
          description: 'Render only: 1-based pages/slides/worksheet positions; default ["1"].',
        },
        analysis_mode: {
          type: 'string',
          enum: ['understand', 'quality_review'],
          description: 'Render only; default understand.',
        },
      },
      required: ['action', 'path'],
    },
    async execute(input, ctx) {
      if (!officeCliAvailable()) {
        return errResult('E_OFFICE_ENGINE_MISSING', 'the built-in Office engine is not available on this build.');
      }
      const action = String(input.action ?? '');
      const allowedFields = action === 'check'
        ? new Set(['action', 'path'])
        : action === 'render' || action === 'check_and_render'
          ? new Set(['action', 'path', 'pages', 'analysis_mode'])
          : undefined;
      if (allowedFields) {
        const unrelated = Object.keys(input).filter((key) => !allowedFields.has(key));
        if (unrelated.length) {
          return errResult('E_BAD_INPUT', `fields not allowed for ${action}: ${unrelated.sort().join(', ')}`);
        }
      }
      if (action === 'check') return check.execute({ path: input.path }, ctx);
      if (action !== 'render' && action !== 'check_and_render') {
        return errResult('E_BAD_INPUT', '`action` must be check, render, or check_and_render');
      }

      const rawPath = String(input.path ?? '');
      if (!rawPath) return errResult('E_BAD_INPUT', '`path` is required');
      const abs = path.resolve(ctx.workingDir ?? '.', rawPath);
      if (!['.docx', '.xlsx', '.pptx'].includes(path.extname(abs).toLowerCase())) {
        return errResult('E_BAD_INPUT', 'office_review supports .docx/.xlsx/.pptx only');
      }
      const scopeErr = guardPath(opts, abs, 'readable');
      if (scopeErr) return { content: scopeErr, isError: true };
      if (!fs.existsSync(abs)) return errResult('E_NOT_FOUND', `${abs}: file not found`);
      const rawPages = Array.isArray(input.pages) && input.pages.length ? input.pages : ['1'];
      const pages = rawPages.map((page) => String(page));
      const analysisMode = input.analysis_mode === 'quality_review' ? 'quality_review' : 'understand';
      const cwd = path.dirname(abs);

      // One OfficeCLI resident serves the check and every page: each command
      // otherwise re-parses the document and pays a close spawn per page. The
      // resident holds an in-memory copy, so if the file on disk changes while
      // the review runs (an external editor or another conversation), reopen
      // it and rehash before the next page rather than render the old bytes.
      let checkResult: ToolResult | undefined;
      let artifactSha256: string;
      const rendered: ToolResult[] = [];
      const changedBeforePage: string[] = [];
      try {
        if (action === 'check_and_render') {
          let checked: Awaited<ReturnType<typeof checkOfficeFile>>;
          try {
            checked = await checkOfficeFile(abs, cwd, ctx.signal);
          } catch (err) {
            const code = err instanceof OfficeCliError ? err.code : 'E_OFFICE_CHECK_FAILED';
            return errResult(code, (err as Error).message);
          }
          if (checked.result.isError) return checked.result;
          checkResult = checked.result;
          artifactSha256 = checked.artifactSha256;
        } else {
          artifactSha256 = sha256File(abs);
        }
        let snapshot = officeFileSnapshot(abs);
        for (const page of pages) {
          const pageErr = officeArgError(page, 'page');
          if (pageErr) {
            rendered.push(errResult('E_BAD_INPUT', pageErr));
            continue;
          }
          const current = officeFileSnapshot(abs);
          if (!current) {
            rendered.push(errResult('E_OFFICE_RENDER_FAILED', `could not read ${abs} before rendering page ${page}`));
            continue;
          }
          if (current !== snapshot) {
            await closeOfficeFile(abs, cwd);
            artifactSha256 = sha256File(abs);
            snapshot = current;
            changedBeforePage.push(page);
          }
          rendered.push(await renderOfficePage(abs, cwd, page, analysisMode, ctx.signal, {
            artifactSha256,
            echoArtifactSha256: false,
          }));
        }
      } finally {
        await closeOfficeFile(abs, cwd);
      }
      const blocks = [
        ...(checkResult
          ? [`<office-check>\n${checkResult.content}\n</office-check>`]
          // Distinct from the create/edit `<office-artifact>{json}` receipt:
          // this only names the file the page images below were rendered from.
          : [`<office-render-source path="${abs}" artifact_revision="${shortRevision(artifactSha256)}" artifact_sha256="${artifactSha256}" />`]),
        ...rendered.map((result, index) => {
          const changed = changedBeforePage.includes(pages[index]) ? ' artifact_changed_during_review="true"' : '';
          return `<office-render page="${pages[index]}"${changed}>\n${result.content}\n</office-render>`;
        }),
        ...(changedBeforePage.length
          ? [`<office-review-note>The file changed on disk before page(s) ${changedBeforePage.join(', ')} rendered; `
            + 'earlier blocks describe the previous revision. Rerun check_and_render to review the current file.'
            + '</office-review-note>']
          : []),
      ];
      const reads = [checkResult, ...rendered]
        .flatMap((result) => result?.observations?.fileReads ?? []);
      const seenReads = new Set<string>();
      const fileReads = reads.filter((read) => {
        const key = `${read.path}:${read.hash ?? ''}`;
        if (seenReads.has(key)) return false;
        seenReads.add(key);
        return true;
      });
      return {
        content: blocks.join('\n'),
        images: rendered.flatMap((result) => result.images ?? []),
        ...(rendered.some((result) => result.isError) ? { isError: true } : {}),
        ...(fileReads.length ? { observations: { fileReads } } : {}),
      };
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
    return /^(?!0+$)[0-9]+$/.test(value)
      ? null
      : '`page` must be a one-based positive integer string (e.g. "1"); for XLSX use worksheet order, not a name or range.';
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
      'Inspect DOCX, XLSX, or PPTX and return content plus stable element paths for edit_office. Use read_files when edit paths are unnecessary.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Existing .docx/.xlsx/.pptx; absolute or workspace-relative.' },
        mode: { type: 'string', enum: ['text', 'outline', 'get', 'query'], description: 'text (default) returns displayed content; outline returns structure; get reads paths with formula/value metadata; query applies selectors.' },
        targets: {
          type: 'array',
          minItems: 1,
          maxItems: 32,
          items: { type: 'string' },
          description: 'Paths for get or selectors for query, batched in one call; get defaults to ["/"].',
        },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
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
      if (Object.prototype.hasOwnProperty.call(input, 'target')) {
        return errResult('E_BAD_INPUT', '`target` is not supported; use `targets` with one or more entries');
      }
      const targets = input.targets === undefined
        ? (mode === 'get' ? ['/'] : [])
        : Array.isArray(input.targets)
          ? input.targets
          : null;
      if (targets === null || targets.length > 32 || targets.some((target) => typeof target !== 'string' || !target.trim())) {
        return errResult('E_BAD_INPUT', '`targets` must contain 1 to 32 non-empty strings');
      }
      if ((mode === 'get' || mode === 'query') && targets.length === 0) {
        return errResult('E_BAD_INPUT', `mode "${mode}" requires at least one entry in \`targets\``);
      }
      for (const target of targets) {
        const targetErr = officeArgError(target as string, 'target');
        if (targetErr) return errResult('E_BAD_INPUT', targetErr);
        if (path.extname(abs).toLowerCase() === '.xlsx' && mode === 'get') {
          const xlsxPathError = xlsxTargetPathError(target);
          if (xlsxPathError) return errResult('E_BAD_INPUT', xlsxPathError);
        }
      }
      let args: string[];
      if (mode === 'outline') args = ['view', abs, 'outline'];
      else args = ['view', abs, 'text'];

      const cwd = path.dirname(abs);
      try {
        if (mode === 'get' || mode === 'query') {
          const results: Array<Record<string, unknown>> = [];
          for (const target of targets) {
            const targetArgs = mode === 'get'
              ? ['get', abs, target as string, '--json']
              : ['query', abs, target as string, '--json'];
            const result = await runOfficeCli(targetArgs, { cwd, ...(ctx.signal ? { signal: ctx.signal } : {}) });
            const parsed = parseOfficeCliOutput(result.stdout, result.stderr);
            const unwrapped = unwrapOfficeCliResult(parsed);
            if (result.code !== 0) {
              results.push({ target, ok: false, error: result.stderr || result.stdout || `exit ${result.code}` });
            } else if ('error' in unwrapped) {
              results.push({ target, ok: false, error: unwrapped.error });
            } else {
              results.push({ target, ok: true, data: unwrapped.data });
            }
          }
          const succeeded = results.filter((result) => result.ok === true).length;
          const payload = {
            status: succeeded === results.length ? 'complete' : succeeded > 0 ? 'partial' : 'failed',
            results,
          };
          return { content: JSON.stringify(payload), ...(succeeded === 0 ? { isError: true } : {}) };
        }
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
      'Edit DOCX, XLSX, or PPTX with an ordered atomic batch after discovering stable targets with office_read. Existing user files produce a separate validated copy; files created this turn may be refined in place. Use office_review for final QA.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Source .docx/.xlsx/.pptx; absolute or workspace-relative.' },
        output_path: {
          type: 'string',
          description: 'Optional same-extension working-copy path.',
        },
        operations: {
          type: 'array',
          description: 'Atomic operations applied in order: set(path, props), add(parent, type, props), or remove(path).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              action: {
                type: 'string',
                enum: ['set', 'add', 'remove'],
                description: 'set: path/optional props; add: parent/type/optional props; remove: path; omit unrelated fields.',
              },
              path: {
                type: 'string',
                description: 'Target element path (action set/remove). For XLSX cells use the exact A1 path returned by office_read, e.g. "/Sheet1/A2"; never use "/Sheet1/cell[A2]".',
              },
              parent: {
                type: 'string',
                description: 'Parent element path (action add). For an XLSX structural cell insertion, put the A1 address here, e.g. "/Sheet1/A2"; ordinary XLSX writes should use set(path, props).',
              },
              type: {
                type: 'string',
                description: 'Add type: DOCX p/table/picture; XLSX cell/table/chart/picture; PPTX shape/textbox/picture/chart/table/slide.',
              },
              props: {
                type: 'object',
                additionalProperties: true,
                properties: xlsxCellPropertySchema(),
                description: 'Scalar props; file values use workspace/attachment paths. XLSX cell set reuses create_xlsx value/formula/format/style. Table rows are a primitive grid; XLSX tables require ref or range, e.g. "A1:G6".',
              },
            },
            required: ['action'],
          },
        },
        preview: { type: 'boolean', description: 'Return a first-page PNG; default false.' },
      },
      required: ['path', 'operations'],
    },
    async execute(input, ctx) {
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
      let normalizedOperations = normalized.operations;
      if (sourceExt === '.xlsx') {
        const contractError = xlsxEditContractError(normalizedOperations);
        if (contractError) return errResult('E_BAD_INPUT', contractError);
        const placementError = xlsxTablePlacementError(normalizedOperations);
        if (placementError) return errResult('E_BAD_INPUT', placementError);
        normalizedOperations = normalizeXlsxCellSetOperations(normalizedOperations);
      }
      let ops: OfficeBatchOp[];
      try {
        ops = buildEditBatch(normalizedOperations);
      } catch (err) {
        if (err instanceof OfficeEditInputError) return errResult('E_BAD_INPUT', err.message);
        throw err;
      }
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
        // A prior inspection can leave the destination's resident holding the
        // original file open. Release it before the atomic in-place replace.
        if (fs.existsSync(finalPath)) await closeOfficeFile(finalPath, finalCwd);
        fs.renameSync(workPath, finalPath);

        const preview = input.preview === true ? await renderToImage(finalPath, finalCwd, '1', ctx.signal) : null;
        if (opts.onFileWritten) {
          try { await opts.onFileWritten(finalPath); }
          catch (err) { log.warn('onFileWritten callback failed', { path: logPathRef(finalPath), error: logErrorRef(err) }); }
        }
        const sourceNote = sourceWasProduced && finalPath === sourceAbs
          ? ''
          : `; source preserved: ${sourceAbs}`;
        const renameSignal = renamed ? renderRenameSignal(requestedOutput, finalPath) : '';
        return {
          content: `Edited ${finalPath} (${ops.length} operation${ops.length === 1 ? '' : 's'})${sourceNote}${renameSignal}${renderOfficeArtifactReceipt(finalPath)}`,
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
    createOfficeReviewTool(opts),
  ];
}
