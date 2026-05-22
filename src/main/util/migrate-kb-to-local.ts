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
 *     `.kb.legacy-<ts>` so we never delete user data automatically. Log warn
 *     so support can investigate. Stamp.
 *   - Old path is a file (not a directory): leave it alone (corrupt FS state),
 *     stamp anyway since the schema says it should be a directory.
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

const log = createLogger('migrate');
const MIGRATION_TAG = 'kb-to-local-contexts-v1';

function migrationsFile(uid: string): string {
  // userLocalConfigDir = <uid>/local/config; up one to <uid>/local/
  return path.join(path.dirname(userLocalConfigDir(uid)), '.migrations');
}

function alreadyApplied(uid: string): boolean {
  const f = migrationsFile(uid);
  if (!fs.existsSync(f)) return false;
  try {
    const content = fs.readFileSync(f, 'utf8');
    return content.split('\n').some((line) => line.trim() === MIGRATION_TAG);
  } catch {
    return false;
  }
}

function stamp(uid: string): void {
  const f = migrationsFile(uid);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, `${MIGRATION_TAG}\n`);
  } catch (err) {
    log.warn(`stamp failed uid=${uid}: ${(err as Error).message}`);
  }
}

export function migrateKbToLocalContexts(uid: string): void {
  if (alreadyApplied(uid)) return;

  const legacyKb = path.join(userContextsDir(uid), '.kb');  // <uid>/cloud/contexts/.kb
  const newKb = userKbDir(uid);                              // <uid>/local/contexts/.kb

  const legacyExists = fs.existsSync(legacyKb);
  const newExists = fs.existsSync(newKb);

  if (!legacyExists) {
    stamp(uid);
    return;
  }

  let legacyIsDir = false;
  try { legacyIsDir = fs.statSync(legacyKb).isDirectory(); } catch { /* ignore */ }

  if (!legacyIsDir) {
    log.warn(`kb migration: legacy .kb at ${legacyKb} is not a directory; leaving alone`);
    stamp(uid);
    return;
  }

  // Ensure parent of new path exists.
  fs.mkdirSync(path.dirname(newKb), { recursive: true });

  if (newExists) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const sidelined = `${legacyKb}.legacy-${ts}`;
    log.warn(
      `kb migration: both ${legacyKb} and ${newKb} exist; keeping ${newKb}, ` +
      `renaming legacy → ${sidelined}`,
    );
    try {
      fs.renameSync(legacyKb, sidelined);
    } catch (err) {
      log.warn(`kb migration: rename-to-sidelined failed: ${(err as Error).message}`);
    }
    stamp(uid);
    return;
  }

  try {
    fs.renameSync(legacyKb, newKb);
    log.info(`kb migration: moved ${legacyKb} → ${newKb}`);
  } catch (err) {
    // Cross-device rename can fail on some filesystems. Fall back to a copy +
    // delete; better to slow-pass than to leave the user without their index.
    const msg = (err as Error).message;
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      log.warn(`kb migration: cross-device rename, falling back to copy`);
      try {
        copyDirSync(legacyKb, newKb);
        rmRfSync(legacyKb);
      } catch (err2) {
        log.error(`kb migration: copy fallback failed: ${(err2 as Error).message}`);
        return; // do NOT stamp — retry next boot
      }
    } else {
      log.error(`kb migration: rename failed: ${msg}`);
      return;
    }
  }
  stamp(uid);
}

function copyDirSync(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyDirSync(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function rmRfSync(p: string): void {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ }
}
