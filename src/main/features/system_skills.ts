/**
 * System skills.
 *
 * These are product protocol documents (creator rules), not user-authored
 * skills. Source lives in the app bundle under `resources/builtin/system/skills/`;
 * each active user gets a local mirror so model file tools can read a stable
 * data-root path without relying on marketplace installs.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { replaceDirectoryAtomically } from '../util/atomic-directory-replace';

import {
  packagedSystemSkillsManifestFile,
  packagedSystemSkillsDir,
  userSystemSkillDir,
  userSystemSkillsManifestFile,
  userSystemSkillsDir,
} from '../paths';
import { createLogger } from '../logger';
import { safeId } from '../storage';
import { logErrorSummary } from '../util/log-redact';
import { getActiveUserId, hasActiveUser } from './users';

const log = createLogger('system-skills');

export interface SystemSkillManifestEntry {
  id: string;
  update_at: number | string;
}

export interface SystemSkillReconcileResult {
  id: string;
  action: 'created' | 'updated' | 'deleted' | 'skipped' | 'missing_source' | 'invalid_manifest' | 'failed';
  error?: string;
}

export interface SystemSkillReconcileRetryOptions {
  retries?: number;
  delayMs?: number;
  shouldContinue?: () => boolean;
  reason?: string;
}

type SystemSkillManifestRead =
  | { ok: true; entries: SystemSkillManifestEntry[] }
  | { ok: false; entries: []; error: string };

function _sourceSkillDir(id: string): string {
  return path.join(packagedSystemSkillsDir(), id);
}

function _normaliseManifestEntry(raw: unknown): SystemSkillManifestEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as { id?: unknown; update_at?: unknown; updated_at?: unknown };
  const id = typeof obj.id === 'string' ? obj.id : '';
  if (!safeId(id)) return null;
  const updateAt = obj.update_at ?? obj.updated_at;
  if (typeof updateAt !== 'number' && typeof updateAt !== 'string') return null;
  return { id, update_at: updateAt };
}

function _readManifest(file: string, opts: { requireNonEmpty?: boolean } = {}): SystemSkillManifestRead {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, entries: [], error: `unable to read manifest: ${(err as Error).message}` };
  }
  return _parseManifest(raw, opts);
}

async function _readManifestAsync(file: string, opts: { requireNonEmpty?: boolean } = {}): Promise<SystemSkillManifestRead> {
  try {
    return _parseManifest(JSON.parse(await fsp.readFile(file, 'utf8')), opts);
  } catch (err) {
    return { ok: false, entries: [], error: `unable to read manifest: ${(err as Error).message}` };
  }
}

function _parseManifest(raw: unknown, opts: { requireNonEmpty?: boolean }): SystemSkillManifestRead {
  const wrapped = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as { skills?: unknown }
    : null;
  const items = Array.isArray(raw) ? raw : Array.isArray(wrapped?.skills) ? wrapped.skills : null;
  if (!items) return { ok: false, entries: [], error: 'manifest must be an array or contain a skills array' };
  if (opts.requireNonEmpty && items.length === 0) {
    return { ok: false, entries: [], error: 'packaged system skill manifest must not be empty' };
  }
  const entries: SystemSkillManifestEntry[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const entry = _normaliseManifestEntry(items[index]);
    if (!entry) return { ok: false, entries: [], error: `invalid manifest entry at index ${index}` };
    if (seen.has(entry.id)) return { ok: false, entries: [], error: `duplicate system skill id: ${entry.id}` };
    seen.add(entry.id);
    entries.push(entry);
  }
  return { ok: true, entries };
}

function _manifestMap(entries: SystemSkillManifestEntry[]): Map<string, SystemSkillManifestEntry> {
  const out = new Map<string, SystemSkillManifestEntry>();
  for (const entry of entries) out.set(entry.id, entry);
  return out;
}

function _sameEntry(a: SystemSkillManifestEntry | null | undefined, b: SystemSkillManifestEntry | null | undefined): boolean {
  return !!a && !!b && String(a.update_at) === String(b.update_at);
}

async function _writeManifestEntries(file: string, entries: SystemSkillManifestEntry[]): Promise<void> {
  const compact = entries
    .filter((entry) => safeId(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({ id: entry.id, update_at: entry.update_at }));
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(compact, null, 2)}\n`);
}

function _assertContinue(shouldContinue?: () => boolean): void {
  if (shouldContinue && !shouldContinue()) {
    throw Object.assign(new Error('System Skill publication cancelled'), { name: 'AbortError' });
  }
}

async function _copyDir(src: string, dest: string, shouldContinue?: () => boolean): Promise<void> {
  _assertContinue(shouldContinue);
  await fsp.mkdir(dest, { recursive: true });
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    _assertContinue(shouldContinue);
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) await _copyDir(from, to, shouldContinue);
    else if (entry.isFile()) await fsp.copyFile(from, to);
  }
}

async function _removeLegacyPerSkillManifest(uid: string, id: string): Promise<void> {
  try {
    await fsp.rm(path.join(userSystemSkillDir(uid, id), '_system.json'), { force: true });
  } catch { /* best-effort legacy cleanup */ }
}

export function listPackagedSystemSkillIds(): string[] {
  const manifest = _readManifest(packagedSystemSkillsManifestFile(), { requireNonEmpty: true });
  if (manifest.ok === false) {
    log.warn('packaged system skill manifest invalid', { error: logErrorSummary(manifest.error) });
    return [];
  }
  return manifest.entries.map((entry) => entry.id).sort();
}

export async function reconcileSystemSkill(uid: string, id: string): Promise<SystemSkillReconcileResult> {
  if (!safeId(uid) || !safeId(id)) return { id: String(id || ''), action: 'invalid_manifest', error: 'invalid id' };
  const sourceManifest = await _readManifestAsync(packagedSystemSkillsManifestFile(), { requireNonEmpty: true });
  if (sourceManifest.ok === false) return { id, action: 'invalid_manifest', error: sourceManifest.error };
  const localManifest = await _readManifestAsync(userSystemSkillsManifestFile(uid));
  const sourceEntries = _manifestMap(sourceManifest.entries);
  const localEntries = _manifestMap(localManifest.ok ? localManifest.entries : []);
  const result = await _reconcileSystemSkill(uid, id, sourceEntries.get(id), localEntries.get(id));
  if (result.action === 'created' || result.action === 'updated') {
    localEntries.set(id, sourceEntries.get(id)!);
    await _writeManifestEntries(userSystemSkillsManifestFile(uid), Array.from(localEntries.values()));
  }
  return result;
}

async function _reconcileSystemSkill(
  uid: string,
  id: string,
  srcManifest: SystemSkillManifestEntry | null | undefined,
  destManifest: SystemSkillManifestEntry | null | undefined,
  shouldContinue?: () => boolean,
): Promise<SystemSkillReconcileResult> {
  const src = _sourceSkillDir(id);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) return { id, action: 'missing_source' };
  if (!srcManifest || srcManifest.id !== id) return { id, action: 'invalid_manifest' };
  const dest = userSystemSkillDir(uid, id);
  if (fs.existsSync(path.join(dest, 'SKILL.md')) && _sameEntry(srcManifest, destManifest)) {
    await _removeLegacyPerSkillManifest(uid, id);
    return { id, action: 'skipped' };
  }
  try {
    const existed = fs.existsSync(dest);
    await replaceDirectoryAtomically(dest, (staged) => _copyDir(src, staged, shouldContinue), undefined, {
      assertReady: () => _assertContinue(shouldContinue),
    });
    await _removeLegacyPerSkillManifest(uid, id);
    return { id, action: existed ? 'updated' : 'created' };
  } catch (err) {
    if ((err as Error).name === 'AbortError') return { id, action: 'skipped' };
    return { id, action: 'failed', error: (err as Error).message };
  }
}

export async function reconcileAllForUser(uid: string, shouldContinue?: () => boolean): Promise<SystemSkillReconcileResult[]> {
  if (!safeId(uid)) return [];
  const sourceManifest = await _readManifestAsync(packagedSystemSkillsManifestFile(), { requireNonEmpty: true });
  if (sourceManifest.ok === false) {
    const failure: SystemSkillReconcileResult = {
      id: '*',
      action: 'invalid_manifest',
      error: sourceManifest.error,
    };
    log.warn('system skill reconcile invalid_manifest id=*', { error: logErrorSummary(sourceManifest.error) });
    return [failure];
  }
  const localManifest = await _readManifestAsync(userSystemSkillsManifestFile(uid));
  if (localManifest.ok === false && fs.existsSync(userSystemSkillsManifestFile(uid))) {
    log.warn('local system skill manifest invalid; rebuilding from packaged source', { error: logErrorSummary(localManifest.error) });
  }
  const sourceEntries = _manifestMap(sourceManifest.entries);
  const localEntries = _manifestMap(localManifest.ok ? localManifest.entries : []);
  const results: SystemSkillReconcileResult[] = [];
  for (const id of Array.from(sourceEntries.keys()).sort()) {
    if (shouldContinue && !shouldContinue()) break;
    results.push(await _reconcileSystemSkill(uid, id, sourceEntries.get(id), localEntries.get(id), shouldContinue));
  }
  let manifestChanged = false;
  for (const r of results) {
    if (r.action === 'created' || r.action === 'updated') {
      const src = sourceEntries.get(r.id);
      if (src) {
        localEntries.set(r.id, src);
        manifestChanged = true;
      }
    }
  }
  const localRoot = userSystemSkillsDir(uid);
  const diskIds = new Set<string>();
  try {
    for (const entry of await fsp.readdir(localRoot, { withFileTypes: true })) {
      if (entry.isDirectory() || entry.isSymbolicLink()) diskIds.add(entry.name);
    }
  } catch { /* no local mirror yet */ }
  const cleanupIds = new Set([...localEntries.keys(), ...diskIds]);
  for (const id of Array.from(cleanupIds).sort()) {
    if (shouldContinue && !shouldContinue()) break;
    if (sourceEntries.has(id)) continue;
    try {
      await fsp.rm(path.join(localRoot, id), { recursive: true, force: true });
      localEntries.delete(id);
      manifestChanged = true;
      results.push({ id, action: 'deleted' });
    } catch (err) {
      results.push({ id, action: 'failed', error: (err as Error).message });
    }
  }
  if (manifestChanged) {
    await _writeManifestEntries(userSystemSkillsManifestFile(uid), Array.from(localEntries.values()));
  }
  if (results.some((r) => r.action === 'created' || r.action === 'updated' || r.action === 'deleted')) {
    try {
      const registry = await import('../model/core-agent/skill-registry');
      await registry.invalidateSkills();
    } catch (err) {
      log.warn('system skill registry invalidation failed', { error: logErrorSummary(err) });
    }
  }
  for (const r of results) {
    if (r.action === 'created' || r.action === 'updated' || r.action === 'deleted') {
      log.info(`system skill ${r.action} id=${r.id}`);
    } else if (r.action === 'failed' || r.action === 'invalid_manifest' || r.action === 'missing_source') {
      log.warn(`system skill reconcile ${r.action} id=${r.id}`, r.error ? { error: logErrorSummary(r.error) } : undefined);
    }
  }
  return results;
}

export async function reconcileAllForActiveUser(): Promise<SystemSkillReconcileResult[]> {
  if (!hasActiveUser()) return [];
  return reconcileAllForUser(getActiveUserId());
}

function _hasRetryableFailure(results: SystemSkillReconcileResult[]): boolean {
  return results.some((r) => r.action === 'failed');
}

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function reconcileAllForUserWithRetry(
  uid: string,
  opts: SystemSkillReconcileRetryOptions = {},
): Promise<SystemSkillReconcileResult[]> {
  const retries = Number.isFinite(opts.retries) ? Math.max(0, Number(opts.retries)) : 2;
  const delayMs = Number.isFinite(opts.delayMs) ? Math.max(0, Number(opts.delayMs)) : 500;
  let attempt = 0;
  let last: SystemSkillReconcileResult[] = [];
  while (true) {
    if (opts.shouldContinue && !opts.shouldContinue()) return last;
    try {
      last = await reconcileAllForUser(uid, opts.shouldContinue);
    } catch (err) {
      last = [{ id: '*', action: 'failed', error: (err as Error).message || String(err) }];
    }
    if (!_hasRetryableFailure(last) || attempt >= retries) return last;
    attempt += 1;
    log.warn(`system skill reconcile retry ${attempt}/${retries}${opts.reason ? ` reason=${opts.reason}` : ''}`);
    if (delayMs > 0) await _sleep(delayMs);
  }
}

export async function reconcileAllForActiveUserWithRetry(
  opts: SystemSkillReconcileRetryOptions = {},
): Promise<SystemSkillReconcileResult[]> {
  if (!hasActiveUser()) return [];
  return reconcileAllForUserWithRetry(getActiveUserId(), opts);
}
