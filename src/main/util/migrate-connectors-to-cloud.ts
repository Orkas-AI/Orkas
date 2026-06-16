/**
 * One-shot migration: relocate the connectors registry from `<uid>/local/config/connectors.json`
 * to `<uid>/cloud/config/connectors.json`.
 *
 * Historical PC-only migration. The open-source build has no account-backed connector
 * sync, so this function always defers and leaves existing local connector
 * files in place.
 *
 * Failure modes:
 *   - legacy whole-file encrypted local files are no longer migrated; leave the local file
 *     alone, log, return false. User reconnects when they hit a connector card.
 *   - write of current-format plaintext envelope fails → leave both, the next launch retries.
 *   - both succeed → unlink the old file. The cloud file is now authoritative.
 *
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { userCloudConfigDir, userLocalConfigDir } from '../paths';
import { createLogger } from '../logger';
import * as cryptoVault from './crypto-vault';

const log = createLogger('migrate-connectors');

const OLD_FILENAME = 'connectors.json';
const NEW_FILENAME = 'connectors.json';
const STAMP_FILE = '.migrate-connectors-to-cloud.done';

function _oauthUserId(): string | null {
  return null;
}

export function migrateConnectorsToCloud(uid: string): boolean {
  if (!uid) return false;
  const localDir = userLocalConfigDir(uid);
  const cloudDir = userCloudConfigDir(uid);
  const oldPath = path.join(localDir, OLD_FILENAME);
  const newPath = path.join(cloudDir, NEW_FILENAME);
  const stamp = path.join(cloudDir, STAMP_FILE);

  // Already done — stamp file is the cheap idempotency check.
  if (fs.existsSync(stamp)) return false;
  // Cloud file already exists but no stamp → still drop the stamp so we don't re-evaluate
  // every launch. (Fresh install or a manual cloud-side push from another device.)
  if (fs.existsSync(newPath)) {
    try { fs.mkdirSync(cloudDir, { recursive: true }); fs.writeFileSync(stamp, ''); } catch { /* ok */ }
    return false;
  }
  // Nothing to migrate.
  if (!fs.existsSync(oldPath)) {
    try { fs.mkdirSync(cloudDir, { recursive: true }); fs.writeFileSync(stamp, ''); } catch { /* ok */ }
    return false;
  }

  const oauth = _oauthUserId();
  if (!oauth) {
    // Defer until login. Don't drop the stamp — we WANT to retry on next launch.
    log.info('connectors.json migration deferred — no OAuth user_id yet (login required)');
    return false;
  }

  let plain: string;
  try {
    const raw = fs.readFileSync(oldPath, 'utf8');
    const trimmed = raw.trim();
    if (cryptoVault.isEncryptedPayload(trimmed) || !trimmed.startsWith('{')) {
      log.warn('connectors.json legacy whole-file vault migration skipped — reconnect connectors to recreate grants');
      return false;
    }
    plain = raw;
  } catch (err) {
    log.error(`migrate read failed: ${(err as Error).message} — leaving local file in place`);
    return false;
  }
  try {
    fs.mkdirSync(cloudDir, { recursive: true });
    fs.writeFileSync(newPath, plain, { mode: 0o600 });
  } catch (err) {
    log.error(`migrate write failed: ${(err as Error).message}`);
    return false;
  }
  try {
    fs.unlinkSync(oldPath);
  } catch (err) {
    // Cloud file written, but old left — non-fatal. The cloud file is authoritative; the
    // stale local file becomes unreachable garbage. Surface to log + continue.
    log.warn(`migrate cleanup (unlink old) failed: ${(err as Error).message}`);
  }
  try { fs.writeFileSync(stamp, ''); } catch { /* ok */ }
  log.info('connectors.json migrated to cloud');
  return true;
}
