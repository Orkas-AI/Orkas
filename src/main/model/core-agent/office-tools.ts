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
import { unassessedTextCollision, type TextCollisionAudit } from '../../features/office/pptx_text_collision';
import {
  buildDocxBatch, buildXlsxWorkbookBatch, buildPptxBatch, buildEditBatch, serializeOfficeBatch,
  type DocxParagraphSpec, type DocxTableSpec, type DocxImageSpec,
  buildXlsxCellProps, type XlsxCell, type XlsxCellProperties, type XlsxSheetSpec,
  type PptxSlideSpec, type PptxImageSpec, type PptxCreationOptions, PPTX_THEME_KEYS,
  type EditOp, type OfficeBatchOp, OfficeEditInputError,
} from './office-batch';
import { createLogger } from '../../logger';
import { logErrorRef, logPathRef, maskId, sanitizeLogText } from '../../util/log-redact';
import { auditPptxContrast } from './pptx-contrast';
import { readDocxText } from './docx-read';
import { OfficeCreationJournal, OfficeCreationStateError, officeCreationReceipt, type OfficeCreation } from '../../features/office/office_creation';

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
  // Bundled OfficeCLI's IssueSeverity enum serializes as numbers:
  // Error=0, Warning=1, Info=2. Preserve string/subtype compatibility below.
  if (issue.severity === 0) return 'blocker';
  if (issue.severity === 1) return 'warning';
  if (issue.severity === 2) return 'info';
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
  /** Host-bound retained state; never an artifact-directory or model input. */
  creationStateDir?: string;
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

const creationJournals = new WeakMap<OfficeToolsOpts, OfficeCreationJournal>();

function withCreation(result: ToolResult, operation?: OfficeCreation): ToolResult {
  return operation ? { ...result, content: result.content + officeCreationReceipt(operation) } : result;
}

function errResult(code: string, msg: string): ToolResult {
  return { content: `${code}: ${msg}`, isError: true };
}

function isResidentDeliveryFailure(result: { stdout: string; stderr: string }): boolean {
  const message = `${result.stderr || ''}\n${result.stdout || ''}`;
  return /batch could not be delivered|main pipe (?:busy|unresponsive)|resident.+(?:busy|unresponsive)/i
    .test(message);
}

/** Only the native batch protocol can certify an authoring rejection. Error
 * prose and a nonzero exit alone are not correction authority. */
function isAtomicInputRejection(stdout: string, operationCount: number): boolean {
  try {
    const result = JSON.parse(stdout);
    const summary = result?.data?.summary;
    const rows = result?.data?.results;
    if (result?.success !== false || !summary || summary.atomicRolledBack !== true
      || summary.total !== operationCount || summary.executed !== operationCount || summary.skipped !== 0
      || !Number.isInteger(summary.failed) || summary.failed < 1
      || !Number.isInteger(summary.succeeded) || summary.succeeded < 0
      || summary.failed + summary.succeeded !== operationCount
      || !Array.isArray(rows) || rows.length !== operationCount) return false;
    const failed = rows.filter(row => row?.success === false);
    return failed.length === summary.failed
      && rows.every((row, index) => row?.index === index && typeof row.success === 'boolean')
      && failed.every(row => row.code === 'invalid_value' || row.code === 'unsupported_type');
  } catch { return false; }
}

/** Workspace + attachment + extra roots for the current (uid, cid). Mirrors
 *  `local-tools.ts::allowedRootsFor`. */
function allowedRootsFor(opts: OfficeToolsOpts): string[] {
  const roots: string[] = [];
  if (opts.userId) {
    try {
      const ws = getWorkspacePath(opts.userId, opts.projectId, opts.cid);
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

/** Keep the original failure for explicit review; optional create/edit previews
 * remain best-effort. No retry or recovery decision belongs to this boundary. */
async function renderToImage(file: string, cwd: string, page: string, signal?: AbortSignal, onTextCollisionAudit?: (audit: TextCollisionAudit) => void): Promise<
  { image: ToolResultImage; error?: never } | { image?: never; error: ReturnType<typeof officeRenderFailure> }
> {
  try {
    const png = onTextCollisionAudit
      ? await renderOfficePageToPng(file, cwd, page, signal, { onTextCollisionAudit })
      : await renderOfficePageToPng(file, cwd, page, signal);
    return { image: { data: png.toString('base64'), mediaType: 'image/png' } };
  } catch (err) {
    const error = logErrorRef(err);
    log.warn('render error', { error });
    return { error: officeRenderFailure(err, error.message) };
  }
}

function officeRenderFailure(error: unknown, message: unknown): { message: string; source_code?: string; exit_code?: number } {
  const details = error instanceof Error ? error as Error & { code?: unknown; exitCode?: unknown } : undefined;
  // Reuse the existing bounded, redacted log message without scanning it again.
  // Cutting raw text before redaction can expose an incomplete quoted secret.
  // Codes come from structured fields only, never from error-looking prose.
  return {
    message: typeof message === 'string' && message ? message : 'No error details were provided.',
    ...(typeof details?.code === 'string' && details.code ? { source_code: sanitizeLogText(details.code).slice(0, 64) } : {}),
    ...(typeof details?.exitCode === 'number' && Number.isSafeInteger(details.exitCode) ? { exit_code: details.exitCode } : {}),
  };
}

/** A private, complete file is linked exclusively into a fresh destination.
 * External writers do not participate in our mutex; EEXIST must select another
 * name rather than replacing their bytes. Cap continuous collision storms. */
async function publishNewOfficeFile(
  workPath: string, requestedPath: string, signal?: AbortSignal,
  beforePublish?: (selected: string) => Promise<void>,
): Promise<string> {
  const occupied = new Set<string>();
  for (let attempt = 0; attempt < 32; attempt++) {
    signal?.throwIfAborted();
    const { finalPath } = await uniquifyPath(requestedPath, () => false, occupied);
    await beforePublish?.(finalPath);
    signal?.throwIfAborted();
    try { fs.linkSync(workPath, finalPath); return finalPath; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      occupied.add(finalPath);
    }
  }
  throw new Error('Office output could not be saved because destination names kept changing.');
}

function officeFileIdentity(file: string): string | undefined {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    return stat.isFile() ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return undefined;
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
    retryOf?: unknown;
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
  let operation: OfficeCreation | undefined;
  let published = false;
  let replacementIdentity: string | undefined;
  const journal = creationJournals.get(opts)!;
  try {
    const fingerprint = createHash('sha256').update(JSON.stringify([args.createFlags, args.ops])).digest('hex');
    const admission = await journal.begin(args.inputAbs, fingerprint, args.retryOf, path.extname(args.inputAbs).toLowerCase() === '.docx');
    if (admission.error) return withCreation(errResult('E_OFFICE_RETRY_NOT_ALLOWED', admission.error), admission.operation);
    operation = admission.operation!;
    // A corrected attempt has never published a file. Even conversation-owned
    // bytes that appeared meanwhile belong to other work and must survive.
    ({ finalPath, renamed } = await uniquifyPath(args.inputAbs, args.retryOf === undefined ? isMineFor(opts) : () => false));
    cwd = path.dirname(finalPath);
    fs.mkdirSync(cwd, { recursive: true });
    // Capture ownership before waiting: an outside replacement during lock
    // admission is independent work, just like a replacement during creation.
    if (args.retryOf === undefined && isMineFor(opts)(finalPath)) replacementIdentity = officeFileIdentity(finalPath);
    releaseLocks = await acquireFileLocks([finalPath]);
    tempDir = fs.mkdtempSync(path.join(cwd, '.orkas-office-create-'));
    workPath = path.join(tempDir, path.basename(finalPath));

    const created = await runOfficeCli(['create', workPath, ...args.createFlags], {
      cwd: tempDir, ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (created.code !== 0) {
      await journal.finish(operation, 'failed');
      return withCreation(errResult('E_OFFICE_CREATE_FAILED', created.stderr || created.stdout || `exit ${created.code}`), operation);
    }

    if (args.ops.length) {
      let batched = await runOfficeCli(['batch', workPath, '--json'], {
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
          await journal.finish(operation, 'unknown');
          return withCreation(errResult('E_OFFICE_CREATE_FAILED', recreated.stderr || recreated.stdout || `exit ${recreated.code}`), operation);
        }
        batched = await runOfficeCli(['batch', workPath, '--json'], {
          cwd: tempDir, stdin: serializeOfficeBatch(args.ops), ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      }
      if (batched.code !== 0) {
        const rejectedInput = isAtomicInputRejection(batched.stdout, args.ops.length);
        await journal.finish(operation, rejectedInput ? operation.attempt === 1 ? 'retryable' : 'failed' : 'unknown');
        return withCreation(errResult('E_OFFICE_BATCH_FAILED', batched.stderr || batched.stdout || `exit ${batched.code}`), operation);
      }
    }

    const preview = args.wantPreview ? (await renderToImage(workPath, tempDir, '1', ctx.signal)).image : undefined;
    await closeOfficeFile(workPath, tempDir);
    ctx.signal?.throwIfAborted();
    let backupPath = '';
    // Only the same prior owned revision may be replaced. A path registered
    // earlier in the turn does not establish ownership of later outside bytes.
    let replaceOwned = replacementIdentity !== undefined && officeFileIdentity(finalPath) === replacementIdentity;
    if (replaceOwned) {
      await closeOfficeFile(finalPath, cwd);
      replaceOwned = officeFileIdentity(finalPath) === replacementIdentity;
    }
    if (replaceOwned) {
      await journal.bindFinal(operation, finalPath);
      ctx.signal?.throwIfAborted();
      replaceOwned = officeFileIdentity(finalPath) === replacementIdentity;
    }
    if (replaceOwned) {
      backupPath = path.join(tempDir, `.previous-${path.basename(finalPath)}`);
      fs.renameSync(finalPath, backupPath);
      try { fs.renameSync(workPath, finalPath); published = true; }
      catch (error) {
        if (fs.existsSync(backupPath) && !fs.existsSync(finalPath)) fs.renameSync(backupPath, finalPath);
        throw error;
      }
    } else {
      finalPath = await publishNewOfficeFile(workPath, args.inputAbs, ctx.signal,
        selected => journal.bindFinal(operation!, selected));
      renamed = finalPath !== args.inputAbs;
      cwd = path.dirname(finalPath);
      published = true;
    }
    // Publication is already durable. Register the saved artifact before
    // fallible bookkeeping/backup cleanup so a later error cannot hide it
    // from the turn's produced-file delivery. Keep that error and no-replay
    // state; registration does not claim the whole task or QA completed.
    if (opts.onFileWritten) {
      try { await opts.onFileWritten(finalPath); }
      catch (err) { log.warn('onFileWritten callback failed', { path: logPathRef(finalPath), error: logErrorRef(err) }); }
    }
    await journal.finish(operation, 'published');
    if (backupPath) fs.rmSync(backupPath, { force: true });

    const n = args.unitCount;
    const base = `${args.noun} created: ${finalPath} (${n} ${args.unit}${n === 1 ? '' : 's'})`;
    const renameSignal = renamed ? renderRenameSignal(args.inputAbs, finalPath) : '';
    const content = `${base}${renameSignal}${renderOfficeArtifactReceipt(finalPath)}`;
    return withCreation({ content, ...(preview ? { images: [preview] } : {}) }, operation);
  } catch (err) {
    if (operation?.status === 'started') {
      try { await journal.finish(operation, published ? 'published' : 'unknown'); }
      catch { operation.status = published ? 'published' : 'unknown'; }
    }
    if (!operation) return errResult('E_OFFICE_CREATION_STATE_UNAVAILABLE', 'Creation state could not be verified; no Office creation was dispatched.');
    const code = err instanceof OfficeCreationStateError ? 'E_OFFICE_CREATION_STATE_UNAVAILABLE'
      : err instanceof OfficeCliError ? err.code : 'E_OFFICE_CREATE_FAILED';
    return withCreation(errResult(code, (err as Error).message), operation);
  } finally {
    if (workPath && tempDir) await closeOfficeFile(workPath, tempDir);
    if (releaseLocks && fs.existsSync(finalPath)) await closeOfficeFile(finalPath, cwd);
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
      'Create an editable DOCX from paragraphs, tables and local images. Returns the collision-safe path and optional preview; correct it with edit_office.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Output .docx path; absolute or workspace-relative.' },
        retry_of: { type: 'string', description: 'Retryable failure\'s operation_id; retain its path.' },
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
        retryOf: input.retry_of,
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
    underline: { type: 'string' },
    halign: { type: 'string' },
    valign: { type: 'string' },
    wrap: { type: 'boolean' },
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
      catTitle: { type: 'string' },
      axistitle: { type: 'string', description: 'Value-axis title.' },
      axismin: { type: 'number' },
      axismax: { type: 'number' },
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
    type: ['string', 'number', 'boolean', 'object'],
    properties: xlsxCellPropertySchema(),
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
    compatibilityInputFields: ['sheet', 'rows', 'columns', 'charts'],
    description:
      'Create an editable XLSX with sheets, styled cells, formulas, column settings and native charts bound to cell ranges. Returns the collision-safe path and optional preview; correct it with edit_office.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Output .xlsx path; absolute or workspace-relative.' },
        retry_of: { type: 'string', description: 'Retryable failure\'s operation_id; retain its path.' },
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
      const hasRetiredFields = ['sheet', 'rows', 'columns', 'charts']
        .some((key) => Object.prototype.hasOwnProperty.call(input, key));
      if (hasRetiredFields || !Array.isArray(input.sheets) || input.sheets.length === 0) {
        return errResult('E_BAD_INPUT', 'provide sheets; flat sheet/rows/columns/charts fields are unsupported');
      }
      const sheets = input.sheets as XlsxSheetSpec[];
      return runCreate(opts, ctx, {
        inputAbs: prep.abs,
        createFlags: ['--force'],
        ops: buildXlsxWorkbookBatch(sheets),
        wantPreview: input.preview !== false,
        noun: 'Excel workbook', unit: 'cell',
        retryOf: input.retry_of,
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

/** Validate the optional production features before reserving a creation identity.
 * Existing supported object units retain their native meaning and validation path. */
const PPTX_GEOMETRY_FIELDS = ['x', 'y', 'width', 'height'] as const;
const PPTX_GEOMETRY_PROPERTIES = Object.fromEntries(PPTX_GEOMETRY_FIELDS.map(key => [key, {
  type: 'string',
}]));

function pptxProductionInputError(input: Record<string, unknown>): string | undefined {
  const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  const length = (value: unknown, positive: boolean): boolean => {
    if (typeof value !== 'string' || !/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:in|cm|pt)$/i.test(value)) return false;
    const number = Number.parseFloat(value);
    return Number.isFinite(number) && (!positive || number > 0);
  };
  if (input.canvas !== undefined) {
    const canvas = input.canvas;
    if (!record(canvas) || Object.keys(canvas).some(key => !['size', 'width', 'height'].includes(key))) {
      return 'canvas accepts size or explicit width and height only.';
    }
    const preset = typeof canvas.size === 'string' && ['widescreen', 'standard', '16:10'].includes(canvas.size);
    if (!(preset && canvas.width === undefined && canvas.height === undefined)
      && !(canvas.size === undefined && length(canvas.width, true) && length(canvas.height, true))) {
      return 'canvas needs either a supported size or both positive width and height in in, cm, or pt.';
    }
  }
  if (input.theme !== undefined) {
    if (!record(input.theme) || Object.entries(input.theme).some(([key, value]) =>
      !(PPTX_THEME_KEYS as readonly string[]).includes(key) || typeof value !== 'string' || !value.trim())) {
      return 'theme accepts the declared font and color properties with non-empty string values only.';
    }
  }
  if (Array.isArray(input.slides)) {
    for (const [index, slide] of input.slides.entries()) {
      if (!record(slide)) continue;
      // Match the pinned engine's syntax, not a guessed inches default. Preserve
      // raw integer/scientific EMU and unit-qualified lengths byte-for-byte.
      for (const group of ['shapes', 'images', 'charts', 'tables']) {
        const objects = slide[group];
        if (!Array.isArray(objects)) continue;
        for (const [objectIndex, object] of objects.entries()) {
          if (!record(object)) continue;
          for (const field of PPTX_GEOMETRY_FIELDS) {
            const value = object[field];
            if ((typeof value === 'string' || typeof value === 'number')
              && /^[+-]?(?:\d+\.\d*|\.\d+)$/.test(String(value).trim())) {
              return `slides[${index}].${group}[${objectIndex}].${field} is a unitless decimal. Give geometry an explicit unit, e.g. "0.8in" or "24pt"; bare integers/scientific notation mean EMU. No changes were applied; correct the slide array and submit it again.`;
            }
          }
        }
      }
      for (const key of ['titleStyle', 'bodyStyle']) {
        const style = slide[key];
        if (style === undefined) continue;
        if (!record(style) || Object.values(style).some(value => value !== null && typeof value === 'object')) {
          return `slides[${index}].${key} accepts scalar geometry and style properties, like shapes.`;
        }
        for (const field of PPTX_GEOMETRY_FIELDS) {
          const value = style[field];
          if ((typeof value === 'string' || typeof value === 'number')
            && /^[+-]?(?:\d+\.\d*|\.\d+)$/.test(String(value).trim())) {
            return `slides[${index}].${key}.${field} is a unitless decimal. Use an explicit unit such as "0.8in" or "24pt".`;
          }
        }
      }
      if (slide.diagrams === undefined) continue;
      if (!Array.isArray(slide.diagrams) || slide.diagrams.length > 16) return `Slide ${index + 1}: diagrams must be an array of at most 16 native graphs.`;
      for (const diagram of slide.diagrams) {
        if (!record(diagram) || Object.keys(diagram).some(key => !['mermaid', 'x', 'y', 'width', 'height'].includes(key))
          || typeof diagram.mermaid !== 'string' || !diagram.mermaid.trim() || diagram.mermaid.length > 16_000
          || !length(diagram.x, false) || !length(diagram.y, false) || !length(diagram.width, true) || !length(diagram.height, true)) {
          return `Slide ${index + 1}: each diagram needs non-empty mermaid (at most 16000 characters) and x/y/positive width/height in in, cm, or pt; other properties are unsupported.`;
        }
      }
    }
  }
}

function createPptxTool(opts: OfficeToolsOpts): AgentTool {
  return {
    name: 'create_pptx',
    description:
      'Create editable PPTX; charts/diagrams are native. title/body auto-place; body newlines split lines.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Output .pptx path (absolute or workspace-relative).' },
        retry_of: { type: 'string', description: 'Retryable operation_id; same path.' },
        canvas: {
          type: 'object', additionalProperties: false,
          description: 'Preset OR positive width+height in in/cm/pt; default engine size.',
          properties: {
            size: { type: 'string', enum: ['widescreen', 'standard', '16:10'] },
            width: { type: 'string' },
            height: { type: 'string' },
          },
        },
        theme: {
          type: 'object', additionalProperties: false,
          description: 'Fonts (.ea:CJK, .cs:complex), hex colors; object styles override.',
          properties: Object.fromEntries(PPTX_THEME_KEYS.map(key => [key, { type: 'string' }])),
        },
        slides: {
          type: 'array',
          description: 'Lengths: units (0.8in/24pt) or integer/scientific EMU; bare decimals invalid. size/lineWidth: pt. Colors: hex/theme; gradients C1-C2[-angle]. Opacity/lineOpacity: 0-100; rotation: clockwise degrees; names: edit targets.',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              body: { type: 'string' },
              titleStyle: { type: 'object', description: 'Title placeholder: scalar shape properties.' },
              bodyStyle: { type: 'object', description: 'Body placeholder: scalar shape properties.' },
              layout: { type: 'string', description: 'Office layout, e.g. Title and Content.' },
              background: { type: 'string' },
              transition: { type: 'string' },
              diagrams: {
                type: 'array', maxItems: 16,
                description: 'Mermaid flowchart/sequence; bounds in in/cm/pt with positive width/height.',
                items: {
                  type: 'object', additionalProperties: false,
                  properties: {
                    mermaid: { type: 'string', minLength: 1, maxLength: 16000 },
                    x: { type: 'string' },
                    y: { type: 'string' },
                    width: { type: 'string' },
                    height: { type: 'string' },
                  },
                  required: ['mermaid', 'x', 'y', 'width', 'height'],
                },
              },
              shapes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    text: { type: 'string' },
                    ...PPTX_GEOMETRY_PROPERTIES,
                    fill: { type: 'string' },
                    color: { type: 'string' },
                    size: { type: 'string' },
                    bold: { type: 'boolean' },
                    align: { type: 'string' },
                    valign: { type: 'string' },
                    font: { type: 'string' },
                    'font.ea': { type: 'string' },
                    geometry: { type: 'string', description: 'Preset; default rect.' },
                    opacity: { type: 'number' },
                    margin: { type: 'string', description: 'One or four length insets.' },
                    line: { type: 'string' },
                    lineWidth: { type: 'string' },
                    lineDash: { type: 'string' },
                    lineOpacity: { type: 'number' },
                    gradient: { type: 'string' },
                    rotation: { type: 'number' },
                    autoFit: { type: 'boolean' },
                    lineSpacing: { type: 'string' },
                    spaceBefore: { type: 'string' },
                    spaceAfter: { type: 'string' },
                    shadow: {
                      type: ['string', 'boolean'],
                      description: 'true, none, or color; preset names are unsupported.',
                    },
                    name: { type: 'string' },
                  },
                },
              },
              images: {
                type: 'array',
                description: 'src: workspace/attachment path. Crop edges: percent; crop: all, vertical,horizontal, or left,top,right,bottom.',
                items: {
                  type: 'object',
                  properties: {
                    src: { type: 'string' },
                    ...PPTX_GEOMETRY_PROPERTIES,
                    crop: { type: 'string' },
                    cropLeft: { type: 'number' },
                    cropRight: { type: 'number' },
                    cropTop: { type: 'number' },
                    cropBottom: { type: 'number' },
                    opacity: { type: 'number' },
                    rotation: { type: 'number' },
                    alt: { type: 'string' },
                    name: { type: 'string' },
                  },
                  required: ['src'],
                },
              },
              charts: {
                type: 'array',
                description: 'data: Name:1,2;Other:3,4. categories/colors: comma-separated. anchor: x,y,width,height lengths. gridlines: hex color. Source external data visibly.',
                items: {
                  type: 'object',
                  properties: {
                    type: {
                      type: 'string',
                      enum: ['bar', 'column', 'line', 'pie', 'doughnut', 'area', 'scatter', 'bubble', 'radar', 'stock', 'combo', 'waterfall', 'funnel', 'treemap', 'sunburst', 'boxWhisker', 'histogram', 'pareto'],
                    },
                    data: { type: 'string' },
                    categories: { type: 'string' },
                    title: { type: 'string' },
                    ...PPTX_GEOMETRY_PROPERTIES,
                    anchor: { type: 'string' },
                    legend: { type: 'string' },
                    colors: { type: 'string' },
                    dataLabels: { type: 'string' },
                    preset: { type: 'string' },
                    axismin: { type: 'number' },
                    axismax: { type: 'number' },
                    catTitle: { type: 'string' },
                    axistitle: { type: 'string' },
                    gridlines: { type: 'string' },
                    plotFill: { type: 'string' },
                    chartFill: { type: 'string' },
                    name: { type: 'string' },
                  },
                  required: ['type', 'data'],
                },
              },
              tables: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    rows: {
                      type: 'array',
                      items: { type: 'array', items: { type: ['string', 'number'] } },
                    },
                    ...PPTX_GEOMETRY_PROPERTIES,
                    rowHeight: { type: 'string' },
                    colWidths: { type: 'string', description: 'Comma-separated widths.' },
                    headerFill: { type: 'string' },
                    bodyFill: { type: 'string' },
                    style: { type: 'string' },
                    'border.all': { type: 'string' },
                    'border.horizontal': { type: 'string' },
                    'border.vertical': { type: 'string' },
                    firstRow: { type: 'boolean' },
                    bandedRows: { type: 'boolean' },
                    name: { type: 'string' },
                  },
                  required: ['rows'],
                },
              },
            },
          },
        },
        preview: { type: 'boolean', description: 'First-slide PNG; default true.' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const productionError = pptxProductionInputError(input);
      if (productionError) return errResult('E_BAD_INPUT', productionError);
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
        ops: buildPptxBatch(slides, { canvas: input.canvas, theme: input.theme } as PptxCreationOptions),
        wantPreview: input.preview !== false,
        noun: 'PowerPoint deck', unit: 'slide',
        unitCount: slides.length,
        retryOf: input.retry_of,
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
  let collisionAudit = analysisMode === 'quality_review' && path.extname(abs).toLowerCase() === '.pptx'
    ? unassessedTextCollision('collection_unavailable') : undefined;
  const rendered = await renderToImage(abs, cwd, page, signal, collisionAudit
    ? audit => { collisionAudit = audit; } : undefined);
  if (!rendered.image) {
    const diagnostic = { page, artifact_revision: shortRevision(artifact.artifactSha256), ...rendered.error };
    return errResult('E_OFFICE_RENDER_FAILED', `could not render ${abs} page ${page}\n`
      + `<office-render-error>${JSON.stringify(diagnostic).replace(/</g, '\\u003c')}</office-render-error>`);
  }
  const img = rendered.image;
  const imageSha256 = sha256Bytes(Buffer.from(img.data, 'base64'));
  return {
    content:
      `Rendered page=${page} mode=${analysisMode} ` +
      `artifact_revision=${shortRevision(artifact.artifactSha256)} ` +
      `image_revision=${shortRevision(imageSha256)} path=${abs}` +
      (artifact.echoArtifactSha256 ? ` artifact_sha256=${artifact.artifactSha256}` : '') +
      ` image_sha256=${imageSha256}` +
      (collisionAudit ? `\n<office-text-collision>${JSON.stringify(collisionAudit).replace(/</g, '\\u003c')}</office-text-collision>` : ''),
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
      : issues.code !== 0 || issueCount === null || contrastScanOk === false || xlsxStatsScanOk === false || issueSeverities.unknown > 0
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
          description: 'check scans OpenXML with path only and reports ignored pages/analysis_mode; render/check_and_render use pages/analysis_mode. Omit unrelated fields. check_and_render stops on validation failure.',
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
        const unrelated = Object.keys(input).filter((key) => !allowedFields.has(key)).sort();
        const unexpected = unrelated.filter((key) => action !== 'check' || !['pages', 'analysis_mode'].includes(key));
        if (unexpected.length) {
          return errResult('E_BAD_INPUT', `fields not allowed for ${action}: ${unexpected.join(', ')}`);
        }
      }
      if (action === 'check') {
        const ignoredFields = Object.keys(input).filter((key) => key === 'pages' || key === 'analysis_mode').sort();
        const result = await check.execute({ path: input.path }, ctx);
        if (!ignoredFields.length) return result;
        try {
          const payload: unknown = JSON.parse(result.content);
          if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
            return { ...result, content: JSON.stringify({ ...payload, ignored_fields: ignoredFields }) };
          }
        } catch { /* Preserve non-JSON errors with a text receipt. */ }
        return { ...result, content: `ignored_fields: ${JSON.stringify(ignoredFields)}\n${result.content}` };
      }
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
        mode: { type: 'string', enum: ['text', 'outline', 'get', 'query'], description: 'text (default) returns content (DOCX body/notes with coverage); outline returns structure; get reads paths with formula/value metadata; query applies selectors.' },
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
        if (mode === 'text' && path.extname(abs).toLowerCase() === '.docx') {
          return await readDocxText(abs, cwd, ctx.signal);
        }
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
      'Edit DOCX/XLSX/PPTX in one ordered atomic batch using office_read targets. Existing files get a validated copy; current-turn outputs may update in place. office_review handles QA.',
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
                description: 'set/remove target. XLSX: exact A1 from office_read ("/Sheet1/A2"); never use "/Sheet1/cell[A2]".',
              },
              parent: {
                type: 'string',
                description: 'Add parent. XLSX structural cell insertion: A1 ("/Sheet1/A2"); ordinary writes use set(path, props).',
              },
              type: {
                type: 'string',
                description: 'DOCX p/table/picture/header/footer; header/footer use parent "/" and props text/align. XLSX cell/table/chart/picture; PPTX shape/textbox/picture/chart/table/slide.',
              },
              props: {
                type: 'object',
                additionalProperties: true,
                properties: xlsxCellPropertySchema(),
                description: 'Scalar props; local file paths. PPTX add slide at /: create_pptx slide fields, including object arrays. XLSX cell set: create_xlsx cell fields. Table rows: primitive grid; XLSX tables require ref or range ("A1:G6").',
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
      if (sourceExt === '.pptx') {
        const slides = normalizedOperations.flatMap(operation => operation.action === 'add'
          && operation.type === 'slide' && operation.parent === '/' ? [operation.props] : []);
        const productionError = pptxProductionInputError({ slides });
        if (productionError) return errResult('E_BAD_INPUT', productionError);
      }
      if (sourceExt === '.xlsx') {
        const contractError = xlsxEditContractError(normalizedOperations);
        if (contractError) return errResult('E_BAD_INPUT', contractError);
        const placementError = xlsxTablePlacementError(normalizedOperations);
        if (placementError) return errResult('E_BAD_INPUT', placementError);
        normalizedOperations = normalizeXlsxCellSetOperations(normalizedOperations);
      }
      let ops: OfficeBatchOp[];
      try {
        ops = buildEditBatch(normalizedOperations, { pptx: sourceExt === '.pptx' });
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
        ctx.signal?.throwIfAborted();
        if (finalPath === sourceAbs) {
          if (fs.existsSync(finalPath)) await closeOfficeFile(finalPath, finalCwd);
          ctx.signal?.throwIfAborted();
          fs.renameSync(workPath, finalPath);
        } else {
          finalPath = await publishNewOfficeFile(workPath, requestedOutput, ctx.signal);
          renamed = finalPath !== requestedOutput;
          finalCwd = path.dirname(finalPath);
        }

        const preview = input.preview === true ? (await renderToImage(finalPath, finalCwd, '1', ctx.signal)).image : undefined;
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
  creationJournals.set(opts, new OfficeCreationJournal(opts.creationStateDir));
  return [
    createDocxTool(opts),
    createXlsxTool(opts),
    createPptxTool(opts),
    createOfficeReadTool(opts),
    createEditOfficeTool(opts),
    createOfficeReviewTool(opts),
  ];
}
