/**
 * One-shot migration: move `<uid>/cloud/contexts/.kb/` to
 * `<uid>/local/contexts/.kb/` (multi-device-sync batch 2 decision —
 * vector store is machine-private and must not cross devices).
 *
 * Stamps `<uid>/local/.migrations` to prevent re-runs. Same convention as
 * `migrate-session-ids.ts`.
 *
 * Edge cases:
 *   - New path already exists, old path doesn't: nothing to do (post-migration
 *     baseline). Stamp and return.
 *   - New path exists AND old path exists: keep new, rename old to
 *     `<uid>/local/contexts/.kb.legacy-<ts>` so we never delete user data
 *     automatically and never leave derived KB data in the cloud sync tree.
 *     Log warn so support can investigate. Stamp.
 *   - Old path is a file (not a directory): preserve it under the local
 *     contexts directory as a legacy artifact. Do not stamp if that move
 *     fails, because the bytes must not be stranded in the syncable tree.
 *   - Older builds may already have created
 *     `<uid>/cloud/contexts/.kb.legacy-*`; a second one-shot moves those
 *     backup dirs to `<uid>/local/contexts/`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  userContextsDir,         // <uid>/cloud/contexts/
  userLocalContextsDir,    // <uid>/local/contexts/
  userKbDir,                // <uid>/local/contexts/.kb/ (after this migration)
  userLocalConfigDir,
} from '../paths';
import { createLogger } from '../logger';
import { logErrorSummary, maskId } from './log-redact';

const log = createLogger('migrate');
const MIGRATION_TAG = 'kb-to-local-contexts-v1';
const LEGACY_BACKUP_TAG = 'kb-legacy-backups-to-local-v1';

function migrationsFile(uid: string): string {
  // userLocalConfigDir = <uid>/local/config; up one to <uid>/local/
  return path.join(path.dirname(userLocalConfigDir(uid)), '.migrations');
}

function alreadyApplied(uid: string, tag = MIGRATION_TAG): boolean {
  const f = migrationsFile(uid);
  if (!fs.existsSync(f)) return false;
  try {
    const content = fs.readFileSync(f, 'utf8');
    return content.split('\n').some((line) => line.trim() === tag);
  } catch {
    return false;
  }
}

function stamp(uid: string, tag = MIGRATION_TAG): void {
  const f = migrationsFile(uid);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${tag}\n`);
  } catch (err) {
    log.warn('kb migration stamp failed', {
      userId: maskId(uid),
      error: logErrorSummary(err),
    });
  }
}

export function migrateKbToLocalContexts(uid: string): void {
  if (alreadyApplied(uid)) {
    migrateLegacyKbBackupsToLocal(uid);
    return;
  }

  const legacyKb = path.join(userContextsDir(uid), '.kb');  // <uid>/cloud/contexts/.kb
  const newKb = userKbDir(uid);                              // <uid>/local/contexts/.kb

  const legacyExists = fs.existsSync(legacyKb);
  const newExists = fs.existsSync(newKb);

  if (!legacyExists) {
    stamp(uid);
    migrateLegacyKbBackupsToLocal(uid);
    return;
  }

  let legacyIsDir = false;
  try { legacyIsDir = fs.statSync(legacyKb).isDirectory(); } catch { /* ignore */ }

  if (!legacyIsDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const preserved = uniquePath(
      path.join(userLocalContextsDir(uid), `.kb.legacy-file-${ts}`),
    );
    log.warn('kb migration legacy index is not a directory; preserving it locally', {
      userId: maskId(uid),
    });
    try {
      movePathSync(legacyKb, preserved);
    } catch (err) {
      log.warn('kb migration could not preserve the malformed legacy index', {
        userId: maskId(uid),
        error: logErrorSummary(err),
      });
      return;
    }
    stamp(uid);
    migrateLegacyKbBackupsToLocal(uid);
    return;
  }

  // Ensure parent of new path exists.
  fs.mkdirSync(path.dirname(newKb), { recursive: true });

  if (newExists) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const sidelined = uniquePath(path.join(userLocalContextsDir(uid), `.kb.legacy-${ts}`));
    log.warn('kb migration found both current and legacy indexes; preserving both', {
      userId: maskId(uid),
    });
    try {
      movePathSync(legacyKb, sidelined);
    } catch (err) {
      log.warn('kb migration could not preserve the legacy index', {
        userId: maskId(uid),
        error: logErrorSummary(err),
      });
      // The legacy index is still in the syncable tree. Do not stamp this
      // attempt complete; the next activation must retry the preservation
      // move instead of abandoning those bytes permanently.
      return;
    }
    stamp(uid);
    migrateLegacyKbBackupsToLocal(uid);
    return;
  }

  try {
    movePathSync(legacyKb, newKb);
    log.info('kb migration moved the machine-private index', {
      userId: maskId(uid),
    });
  } catch (err) {
    log.error('kb migration move failed', {
      userId: maskId(uid),
      error: logErrorSummary(err),
    });
    return;
  }
  stamp(uid);
  migrateLegacyKbBackupsToLocal(uid);
}

function migrateLegacyKbBackupsToLocal(uid: string): void {
  if (alreadyApplied(uid, LEGACY_BACKUP_TAG)) return;

  const cloudContexts = userContextsDir(uid);
  const localContexts = userLocalContextsDir(uid);
  let ok = true;
  let names: string[] = [];
  try {
    names = fs.readdirSync(cloudContexts).filter((name) => name.startsWith('.kb.legacy-'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      stamp(uid, LEGACY_BACKUP_TAG);
    } else {
      log.warn('kb migration legacy-backup scan failed', {
        userId: maskId(uid),
        error: logErrorSummary(err),
      });
    }
    return;
  }

  for (const name of names) {
    const src = path.join(cloudContexts, name);
    const dst = uniquePath(path.join(localContexts, name));
    try {
      movePathSync(src, dst);
      log.info('kb migration moved a legacy backup', {
        userId: maskId(uid),
      });
    } catch (err) {
      ok = false;
      log.warn('kb migration legacy-backup move failed', {
        userId: maskId(uid),
        error: logErrorSummary(err),
      });
    }
  }
  if (ok) stamp(uid, LEGACY_BACKUP_TAG);
}

function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else throw new Error('Unsupported entry in legacy KB index');
  }
}

function copyPathSync(src: string, dst: string): void {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    copyDirSync(src, dst);
  } else if (st.isFile()) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

function movePathSync(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Copy into a sibling temporary path and publish with a same-filesystem
    // rename. Copying directly to `dst` can leave a partial canonical index;
    // the next boot would then treat that partial directory as authoritative
    // and sideline the complete legacy source.
    const temporary = uniquePath(
      `${dst}.migrating-${process.pid}-${Date.now()}`,
    );
    try {
      copyPathSync(src, temporary);
      fs.renameSync(temporary, dst);
      rmRfSync(src);
    } catch (copyError) {
      rmRfSync(temporary);
      throw copyError;
    }
  }
}

function uniquePath(base: string): string {
  if (!fs.existsSync(base)) return base;
  for (let i = 1; i < 1000; i += 1) {
    const candidate = `${base}-${i}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

function rmRfSync(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
