import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ImageStudioIssue, ImageStudioManifest } from './image_studio';

export interface ImageStudioDocumentPage { id: string; entry: string; required_copy: string[] }
export interface ImageStudioPageContext { id: string; index: number; total: number; number?: number }
export interface ImageStudioDocument {
  base: ImageStudioManifest;
  pages: ImageStudioDocumentPage[];
  numberStart?: number;
}
function fail(code: string, detail: string): never { throw new Error(`${code}: ${detail}`); }
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
type Validator = (value: unknown) => { manifest?: ImageStudioManifest; issues: ImageStudioIssue[] };

/** Version 2 is deliberately distinct: a legacy reader must reject the book,
 * rather than silently exporting a leftover single-page entry. */
export function compileImageStudioDocument(value: unknown, validate: Validator): ImageStudioDocument | undefined {
  if (!record(value)) return undefined;
  if (value.schema_version !== 2 && value.document === undefined) return undefined;
  if (value.schema_version !== 2 || !record(value.document) || value.entry !== undefined || value.raster_source !== undefined)
    fail('E_IMAGE_DOCUMENT_MANIFEST', 'use schema_version 2 with document.pages and no single-page final source');
  if (value.route !== 'compose' || value.generation_budget?.max_calls !== 0)
    fail('E_IMAGE_DOCUMENT_ROUTE', 'fixed-page documents use local COMPOSE sources and a zero generation budget');
  const list = value.document.pages;
  if (!Array.isArray(list) || list.length < 1 || list.length > 32)
    fail('E_IMAGE_DOCUMENT_PAGES', 'a fixed-page document requires 1 to 32 pages');
  const ids = new Set<string>();
  const pages = list.map((page: unknown): ImageStudioDocumentPage => {
    if (!record(page) || typeof page.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(page.id) || ids.has(page.id))
      fail('E_IMAGE_DOCUMENT_PAGE_ID', 'each page needs a unique stable identifier');
    ids.add(page.id);
    const entry = page.entry;
    if (typeof entry !== 'string' || !entry || path.posix.isAbsolute(entry) || path.win32.isAbsolute(entry)
      || entry.includes('\\') || entry.split('/').some(part => !part || part === '.' || part === '..')
      || /[?#:]/.test(entry) || !/\.html?$/i.test(entry))
      fail('E_IMAGE_DOCUMENT_ENTRY', 'page entries must be project-relative HTML files');
    if (!Array.isArray(page.required_copy) || page.required_copy.length > 100
      || page.required_copy.some((copy: unknown) => typeof copy !== 'string' || !copy.trim()))
      fail('E_IMAGE_DOCUMENT_COPY', 'each page needs its exact required_copy array');
    return { id: page.id, entry, required_copy: [...page.required_copy] };
  });
  const numbering = value.document.page_numbers;
  if (numbering !== undefined && (!record(numbering) || !Number.isSafeInteger(numbering.start) || numbering.start < 1 || numbering.start > 9999))
    fail('E_IMAGE_DOCUMENT_NUMBERING', 'page_numbers.start must be an integer from 1 to 9999');
  const { document: _document, ...source } = value;
  const single = validate({ ...source, schema_version: 1, entry: pages[0].entry });
  if (!single.manifest || single.issues.length) fail('E_IMAGE_DOCUMENT_MANIFEST', single.issues.map(x => x.message).join('; '));
  return { base: single.manifest, pages, ...(numbering ? { numberStart: numbering.start } : {}) };
}

export function imageStudioDocumentPage(document: ImageStudioDocument, pageId: string) {
  const index = document.pages.findIndex(page => page.id === pageId);
  if (index < 0) fail('E_IMAGE_DOCUMENT_PAGE_UNKNOWN', 'select an existing page identifier from the document');
  const page = document.pages[index];
  const context: ImageStudioPageContext = { id: page.id, index, total: document.pages.length,
    ...(document.numberStart !== undefined ? { number: document.numberStart + index } : {}) };
  const manifest: ImageStudioManifest = { ...document.base, entry: page.entry,
    brief: { ...document.base.brief, required_copy: [...document.base.brief.required_copy, ...page.required_copy] } };
  // Other pages and non-visible order do not invalidate an independent page.
  const signatureSource = JSON.stringify({ manifest, page_id: page.id,
    ...(context.number !== undefined ? { number: context.number, total: context.total } : {}) });
  return { manifest, context, signatureSource };
}

export async function readImageStudioDocument(projectDir: string): Promise<ImageStudioDocument | undefined> {
  const file = path.join(projectDir, 'image-manifest.json');
  try {
    const stat = await fs.stat(file);
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    if ((raw?.schema_version === 2 || raw?.document !== undefined) && stat.size > 1_048_576)
      fail('E_IMAGE_DOCUMENT_MANIFEST', 'document manifest exceeds 1 MiB');
    const { validateImageStudioManifest } = await import('./image_studio');
    return compileImageStudioDocument(raw, validateImageStudioManifest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function inspectImageStudioDocument(projectDir: string, statePath: (id: string) => string) {
  const document = await readImageStudioDocument(projectDir);
  if (!document) fail('E_IMAGE_DOCUMENT_MANIFEST', 'a version 2 document is required');
  const { inspectImageStudioProject, readImageStudioEvidenceState, assertCurrentEvidence } = await import('./image_studio');
  const pages = [];
  for (const page of document.pages) {
    const inspection = await inspectImageStudioProject(projectDir, undefined, page.id);
    const state = await readImageStudioEvidenceState(statePath(page.id));
    let current = false;
    if (state && path.resolve(state.project_dir) === path.resolve(projectDir) && state.page_id === page.id
      && state.signature === inspection.signature) try { await assertCurrentEvidence(statePath(page.id)); current = true; } catch { /* preserve stale work for repair */ }
    const approved = current && state?.review?.verdict === 'passed' && state.review.signature === inspection.signature;
    pages.push({ id: page.id, index: pages.length, entry: page.entry, ok: inspection.ok,
      blockers: inspection.blockers, current_signature: inspection.signature || null,
      evidence_path: state?.evidence_path || null, evidence_current: current, review_current: !!approved,
      review_verdict: state?.review?.verdict || null,
      next_operation: !inspection.ok ? 'repair_project_then_project.snapshot' : !current ? 'project.snapshot'
        : approved ? 'project.export' : state?.review?.verdict === 'repair' || state?.review?.verdict === 'blocked'
          ? 'repair_candidate_then_project.snapshot' : 'project.submit_design_review' });
  }
  return { ok: pages.every(page => page.ok), canvas: document.base.canvas, pages, ready_to_export: pages.every(page => page.review_current) };
}

/** Sequential, bounded printing; temporary pages never become delivered files.
 * A failed page retains its source/preview/review so an explicit retry resumes
 * from the existing per-page state. Publication is one create-only operation. */
export async function exportImageStudioDocument(input: {
  projectDir: string; statePath: (id: string) => string; outputAbsPath: string;
  scratchDir: string; footerText?: string; signal?: AbortSignal;
  finalizeOutput?: (file: string) => Promise<void>;
}) {
  const deadline = performance.now() + 180_000;
  const checkBudget = () => {
    input.signal?.throwIfAborted();
    if (performance.now() >= deadline) fail('E_IMAGE_DOCUMENT_TIMEOUT', 'document export timed out; retained page evidence can be reused');
  };
  checkBudget();
  const document = await readImageStudioDocument(input.projectDir);
  if (!document) fail('E_IMAGE_DOCUMENT_MANIFEST', 'a version 2 document is required');
  const { assertCurrentEvidence, exportImageStudioProject } = await import('./image_studio');
  const identity = async () => {
    const file = path.join(input.projectDir, 'image-manifest.json');
    if ((await fs.stat(file)).size > 1_048_576) fail('E_IMAGE_DOCUMENT_MANIFEST', 'document manifest exceeds 1 MiB');
    return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
  };
  const initial = await identity(), signatures: string[] = [];
  for (const page of document.pages) {
    checkBudget();
    const { state } = await assertCurrentEvidence(input.statePath(page.id));
    if (path.resolve(state.project_dir) !== path.resolve(input.projectDir) || state.page_id !== page.id
      || state.review?.verdict !== 'passed' || state.review.signature !== state.signature)
      fail('E_IMAGE_REVIEW_PASS_REQUIRED', 'every page needs a passing review of its exact current evidence');
    signatures.push(`${state.signature}:${state.image_hash}`);
  }
  await fs.mkdir(input.scratchDir, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(input.scratchDir, 'book-'));
  try {
    const { PDFDocument } = await import('pdf-lib');
    const merged = await PDFDocument.create();
    let bytesRead = 0;
    for (const [index, page] of document.pages.entries()) {
      checkBudget();
      const output = path.join(temporary, `${index}.pdf`);
      await exportImageStudioProject({ stateAbsPath: input.statePath(page.id), outputAbsPath: output,
        format: 'pdf', footerText: input.footerText, signal: input.signal, deadline });
      const bytes = await fs.readFile(output); bytesRead += bytes.length;
      if (bytesRead > 32 * 1024 * 1024) fail('E_IMAGE_DOCUMENT_SIZE', 'document PDF inputs exceed 32 MiB');
      const source = await PDFDocument.load(bytes, { updateMetadata: false });
      if (source.getPageCount() !== 1) fail('E_IMAGE_DOCUMENT_PDF', 'each rendered page must contain exactly one PDF page');
      const [copied] = await merged.copyPages(source, [0]); merged.addPage(copied);
    }
    const bytes = Buffer.from(await merged.save());
    if (bytes.length > 32 * 1024 * 1024 || merged.getPageCount() !== document.pages.length) fail('E_IMAGE_DOCUMENT_SIZE', 'document PDF exceeds supported bounds');
    const verify = async () => {
      checkBudget();
      if (await identity() !== initial) fail('E_IMAGE_DOCUMENT_CHANGED', 'document order or sources changed during export');
      for (const [index, page] of document.pages.entries()) {
        const { state } = await assertCurrentEvidence(input.statePath(page.id));
        if (`${state.signature}:${state.image_hash}` !== signatures[index] || state.review?.verdict !== 'passed')
          fail('E_IMAGE_DOCUMENT_CHANGED', 'page evidence changed during document export');
      }
    };
    await verify();
    await fs.mkdir(path.dirname(input.outputAbsPath), { recursive: true });
    await fs.writeFile(input.outputAbsPath, bytes, { flag: 'wx' });
    try {
      await input.finalizeOutput?.(input.outputAbsPath);
      await verify();
      if ((await fs.stat(input.outputAbsPath)).size !== bytes.length || !(await fs.readFile(input.outputAbsPath)).equals(bytes))
        fail('E_IMAGE_PDF_FINALIZED_MISMATCH', 'PDF output changed after verification');
    } catch (error) { await fs.rm(input.outputAbsPath, { force: true }); throw error; }
    return { output_path: input.outputAbsPath, signature: initial, is_generation: false, page_count: document.pages.length,
      pages: document.pages.map(page => page.id) };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
