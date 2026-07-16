/**
 * Unified Library copy/move operations.
 *
 * Renderer payloads contain only relative paths and logical Library refs.
 * Source resolution and every destination write stay behind the global and
 * project Library path validators. Cross-Library moves are copy-then-delete:
 * the source is removed only after the destination copy and index refresh
 * succeed; a failed source delete rolls the destination back best-effort.
 */

import * as path from 'node:path';

import * as contexts from './contexts';
import * as projectFiles from './project_files';

export type LibraryScope = 'global' | 'project';
export type TransferMode = 'copy' | 'move';

export interface LibraryRef {
  scope: LibraryScope;
  projectId?: string;
}

export interface TransferRequest {
  mode: TransferMode;
  source: LibraryRef;
  paths: string[];
  destination: LibraryRef & { dir?: string };
}

export interface TransferItemResult {
  source: string;
  destination: string;
  ok: boolean;
  error?: string;
  fileCount?: number;
  bytes?: number;
}

export type TransferResult =
  | { ok: false; error: string }
  | {
    ok: true;
    mode: TransferMode;
    results: TransferItemResult[];
    succeeded: number;
    failed: number;
    skippedNested: number;
  };

const MAX_BATCH_ENTRIES = 100;

function normalizeRel(input: unknown, allowEmpty = false): string {
  if (typeof input !== 'string') throw new Error('invalid_path');
  const raw = input.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw) {
    if (allowEmpty) return '';
    throw new Error('invalid_path');
  }
  if (path.isAbsolute(raw) || raw.includes('\x00')) throw new Error('invalid_path');
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
    throw new Error('invalid_path');
  }
  return parts.join('/');
}

function normalizeRef(input: unknown): LibraryRef {
  const raw = input as { scope?: unknown; projectId?: unknown } | null;
  if (!raw || (raw.scope !== 'global' && raw.scope !== 'project')) throw new Error('invalid_scope');
  if (raw.scope === 'global') return { scope: 'global' };
  if (typeof raw.projectId !== 'string' || !raw.projectId || /[\\/\x00]/.test(raw.projectId)) {
    throw new Error('invalid_project');
  }
  return { scope: 'project', projectId: raw.projectId };
}

function libraryKey(ref: LibraryRef): string {
  return ref.scope === 'global' ? 'global' : `project:${ref.projectId}`;
}

function dedupeNested(paths: string[]): { paths: string[]; skipped: number } {
  const unique = Array.from(new Set(paths)).sort((a, b) => {
    const depth = a.split('/').length - b.split('/').length;
    return depth || a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  });
  const kept: string[] = [];
  for (const rel of unique) {
    if (kept.some((parent) => rel.startsWith(`${parent}/`))) continue;
    kept.push(rel);
  }
  return { paths: kept, skipped: unique.length - kept.length };
}

async function resolveSourceAbs(userId: string, ref: LibraryRef, rel: string): Promise<
  { ok: true; absPath: string } | { ok: false; error: string }
> {
  if (ref.scope === 'global') {
    try { return { ok: true, absPath: contexts.resolveContextEntryAbsPath(rel) }; }
    catch { return { ok: false, error: 'not_found' }; }
  }
  const resolved = await projectFiles.resolveProjectEntryAbsPath(userId, ref.projectId!, rel);
  if (resolved.ok === false) return { ok: false, error: resolved.error };
  return { ok: true, absPath: resolved.absPath };
}

async function copyInto(
  userId: string,
  destination: LibraryRef,
  sourceAbs: string,
  targetRel: string,
): Promise<{ ok: true; fileCount: number; bytes: number } | { ok: false; error: string }> {
  if (destination.scope === 'global') {
    const copied = contexts.copyContextEntryFromPath(sourceAbs, targetRel);
    if (copied.ok === false) return { ok: false, error: copied.error };
    return { ok: true, fileCount: copied.fileCount, bytes: copied.bytes };
  }
  const copied = await projectFiles.copyProjectEntryFromPath(
    userId,
    destination.projectId!,
    sourceAbs,
    targetRel,
  );
  if (copied.ok === false) return { ok: false, error: copied.error };
  return { ok: true, fileCount: copied.fileCount, bytes: copied.bytes };
}

async function deleteFrom(userId: string, ref: LibraryRef, rel: string): Promise<{ ok: boolean; error?: string }> {
  if (ref.scope === 'global') return contexts.deleteContextTarget(rel);
  return projectFiles.deleteProjectEntry(userId, ref.projectId!, rel);
}

async function moveWithin(
  userId: string,
  ref: LibraryRef,
  sourceRel: string,
  targetRel: string,
): Promise<{ ok: boolean; error?: string }> {
  if (ref.scope === 'global') return contexts.renameContextEntry(sourceRel, targetRel);
  return projectFiles.renameProjectFile(userId, ref.projectId!, sourceRel, targetRel);
}

function normalizeError(error: string | undefined): string {
  if (!error) return 'transfer_failed';
  if (error === 'destination already exists' || error === 'target_exists') return 'target_exists';
  if (error === 'unsupported_destination' || error.includes('unsupported')) return 'unsupported_destination';
  if (error === 'not_found') return 'not_found';
  if (error === 'forbidden' || error === 'invalid_target') return 'invalid_target';
  return 'transfer_failed';
}

export async function transferLibraryEntries(
  userId: string,
  request: TransferRequest,
): Promise<TransferResult> {
  let mode: TransferMode;
  let source: LibraryRef;
  let destination: LibraryRef;
  let targetDir: string;
  let normalizedPaths: string[];
  try {
    mode = request?.mode;
    if (mode !== 'copy' && mode !== 'move') throw new Error('invalid_mode');
    source = normalizeRef(request?.source);
    destination = normalizeRef(request?.destination);
    targetDir = normalizeRel(request?.destination?.dir || '', true);
    if (!Array.isArray(request?.paths) || !request.paths.length || request.paths.length > MAX_BATCH_ENTRIES) {
      throw new Error('invalid_batch');
    }
    normalizedPaths = request.paths.map((entry) => normalizeRel(entry));
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'invalid_request' };
  }

  const deduped = dedupeNested(normalizedPaths);
  const sameLibrary = libraryKey(source) === libraryKey(destination);
  const results: TransferItemResult[] = [];

  for (const sourceRel of deduped.paths) {
    const base = path.posix.basename(sourceRel);
    const targetRel = targetDir ? `${targetDir}/${base}` : base;
    const resultBase = { source: sourceRel, destination: targetRel };
    if (sameLibrary && (targetRel === sourceRel || targetRel.startsWith(`${sourceRel}/`))) {
      results.push({ ...resultBase, ok: false, error: targetRel === sourceRel ? 'target_exists' : 'invalid_target' });
      continue;
    }

    if (mode === 'move' && sameLibrary) {
      const moved = await moveWithin(userId, source, sourceRel, targetRel);
      results.push(moved.ok
        ? { ...resultBase, ok: true }
        : { ...resultBase, ok: false, error: normalizeError(moved.error) });
      continue;
    }

    const resolved = await resolveSourceAbs(userId, source, sourceRel);
    if (resolved.ok === false) {
      results.push({ ...resultBase, ok: false, error: normalizeError(resolved.error) });
      continue;
    }
    const copied = await copyInto(userId, destination, resolved.absPath, targetRel);
    if (copied.ok === false) {
      results.push({ ...resultBase, ok: false, error: normalizeError(copied.error) });
      continue;
    }
    if (mode === 'move') {
      const removed = await deleteFrom(userId, source, sourceRel);
      if (!removed.ok) {
        const rollback = await deleteFrom(userId, destination, targetRel);
        results.push({
          ...resultBase,
          ok: false,
          error: rollback.ok ? 'source_delete_failed' : 'rollback_failed',
        });
        continue;
      }
    }
    results.push({
      ...resultBase,
      ok: true,
      fileCount: copied.fileCount,
      bytes: copied.bytes,
    });
  }

  const succeeded = results.filter((row) => row.ok).length;
  return {
    ok: true,
    mode,
    results,
    succeeded,
    failed: results.length - succeeded,
    skippedNested: deduped.skipped,
  };
}
