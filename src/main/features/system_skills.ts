/**
 * System skills.
 *
 * These are product protocol documents (creator rules), not user-authored
 * skills. Source lives in the app bundle under `resources/builtin/system/skills/`;
 * each active user gets a local mirror so model file tools can read a stable
 * data-root path without relying on marketplace installs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  packagedSystemSkillsManifestFile,
  packagedSystemSkillsDir,
  userSystemSkillDir,
  userSystemSkillsManifestFile,
  userSystemSkillsDir,
} from '../paths';
import { createLogger } from '../logger';
import { safeId } from '../storage';
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

function _readManifestEntries(file: string): SystemSkillManifestEntry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const items = Array.isArray(raw) ? raw : Array.isArray(raw?.skills) ? raw.skills : [];
    return items.map(_normaliseManifestEntry).filter((x): x is SystemSkillManifestEntry => !!x);
  } catch {
    return [];
  }
}

function _manifestMap(entries: SystemSkillManifestEntry[]): Map<string, SystemSkillManifestEntry> {
  const out = new Map<string, SystemSkillManifestEntry>();
  for (const entry of entries) out.set(entry.id, entry);
  return out;
}

function _sameEntry(a: SystemSkillManifestEntry | null | undefined, b: SystemSkillManifestEntry | null | undefined): boolean {
  return !!a && !!b && String(a.update_at) === String(b.update_at);
}

function _writeManifestEntries(file: string, entries: SystemSkillManifestEntry[]): void {
  const compact = entries
    .filter((entry) => safeId(entry.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((entry) => ({ id: entry.id, update_at: entry.update_at }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(compact, null, 2)}\n`);
}

function _copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.' || entry.name === '..') continue;
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      _copyDir(from, to);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
}

function _replaceDir(src: string, dest: string): void {
  const parent = path.dirname(dest);
  const tmp = path.join(parent, `.${path.basename(dest)}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const bak = path.join(parent, `.${path.basename(dest)}.bak-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(bak, { recursive: true, force: true });
  _copyDir(src, tmp);
  if (fs.existsSync(dest)) fs.renameSync(dest, bak);
  fs.renameSync(tmp, dest);
  fs.rmSync(bak, { recursive: true, force: true });
}

function _removeLegacyPerSkillManifest(uid: string, id: string): void {
  try {
    fs.rmSync(path.join(userSystemSkillDir(uid, id), '_system.json'), { force: true });
  } catch { /* best-effort legacy cleanup */ }
}

export function listPackagedSystemSkillIds(): string[] {
  return _readManifestEntries(packagedSystemSkillsManifestFile()).map((entry) => entry.id).sort();
}

export function reconcileSystemSkill(uid: string, id: string): SystemSkillReconcileResult {
  if (!safeId(uid) || !safeId(id)) return { id: String(id || ''), action: 'invalid_manifest', error: 'invalid id' };
  const sourceEntries = _manifestMap(_readManifestEntries(packagedSystemSkillsManifestFile()));
  const localEntries = _manifestMap(_readManifestEntries(userSystemSkillsManifestFile(uid)));
  const result = _reconcileSystemSkill(uid, id, sourceEntries.get(id), localEntries.get(id));
  if (result.action === 'created' || result.action === 'updated') {
    localEntries.set(id, sourceEntries.get(id)!);
    _writeManifestEntries(userSystemSkillsManifestFile(uid), Array.from(localEntries.values()));
  }
  return result;
}

function _reconcileSystemSkill(
  uid: string,
  id: string,
  srcManifest: SystemSkillManifestEntry | null | undefined,
  destManifest: SystemSkillManifestEntry | null | undefined,
): SystemSkillReconcileResult {
  const src = _sourceSkillDir(id);
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) return { id, action: 'missing_source' };
  if (!srcManifest || srcManifest.id !== id) return { id, action: 'invalid_manifest' };
  const dest = userSystemSkillDir(uid, id);
  if (fs.existsSync(path.join(dest, 'SKILL.md')) && _sameEntry(srcManifest, destManifest)) {
    _removeLegacyPerSkillManifest(uid, id);
    return { id, action: 'skipped' };
  }
  try {
    const existed = fs.existsSync(dest);
    fs.mkdirSync(userSystemSkillsDir(uid), { recursive: true });
    _replaceDir(src, dest);
    _removeLegacyPerSkillManifest(uid, id);
    return { id, action: existed ? 'updated' : 'created' };
  } catch (err) {
    return { id, action: 'failed', error: (err as Error).message };
  }
}

export async function reconcileAllForUser(uid: string): Promise<SystemSkillReconcileResult[]> {
  if (!safeId(uid)) return [];
  const sourceEntries = _manifestMap(_readManifestEntries(packagedSystemSkillsManifestFile()));
  const localEntries = _manifestMap(_readManifestEntries(userSystemSkillsManifestFile(uid)));
  const results: SystemSkillReconcileResult[] = Array.from(sourceEntries.keys())
    .sort()
    .map((id) => _reconcileSystemSkill(uid, id, sourceEntries.get(id), localEntries.get(id)));
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
  for (const id of Array.from(localEntries.keys()).sort()) {
    if (sourceEntries.has(id)) continue;
    try {
      fs.rmSync(userSystemSkillDir(uid, id), { recursive: true, force: true });
      localEntries.delete(id);
      manifestChanged = true;
      results.push({ id, action: 'deleted' });
    } catch (err) {
      results.push({ id, action: 'failed', error: (err as Error).message });
    }
  }
  if (manifestChanged) {
    _writeManifestEntries(userSystemSkillsManifestFile(uid), Array.from(localEntries.values()));
  }
  if (results.some((r) => r.action === 'created' || r.action === 'updated' || r.action === 'deleted')) {
    try {
      const registry = await import('../model/core-agent/skill-registry');
      await registry.invalidateSkills();
    } catch (err) {
      log.warn(`system skill registry invalidation failed: ${(err as Error).message}`);
    }
  }
  for (const r of results) {
    if (r.action === 'created' || r.action === 'updated' || r.action === 'deleted') {
      log.info(`system skill ${r.action} id=${r.id}`);
    } else if (r.action === 'failed' || r.action === 'invalid_manifest' || r.action === 'missing_source') {
      log.warn(`system skill reconcile ${r.action} id=${r.id}${r.error ? ` error=${r.error}` : ''}`);
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
      last = await reconcileAllForUser(uid);
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
