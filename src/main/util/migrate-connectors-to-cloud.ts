/**
 * One-shot migration: relocate the connectors registry from `<uid>/local/config/connectors.json`
 * to `<uid>/cloud/config/connectors.json` and re-key the vault from local-uid encryption to
 * OAuth user_id encryption (so any device signed into the same Orkas account can decrypt).
 *
 * Called from `index.ts` after `account.bootstrap()` resolves to `ready`. Idempotent — second
 * runs detect the cloud file exists and bail. Migration is **bound to login**: without an
 * OAuth user_id we'd be re-encrypting with the same local-uid seed for no benefit (and the
 * cloud copy wouldn't sync anyway because the engine is inactive without an account), so we
 * defer to a future login.
 *
 * Failure modes:
 *   - decrypt of old file fails → leave the local file alone, log, return false. User
 *     reconnects when they hit a connector card.
 *   - write of new file fails → leave both, the next launch retries.
 *   - both succeed → unlink the old file. The cloud file is now authoritative.
 *
 * The strip-rules-aware lazy-require for `features/account` lets this file ship to OrkasOpen
 * unchanged; OrkasOpen has no account module → `oauthUserId()` resolves null → migration
 * skips. That matches the no-login fallback behavior baked into registry.ts.
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

// features/account stripped from the OrkasOpen build — no OAuth user_id available;
// the migration always falls back to the local-uid seed.
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
    plain = cryptoVault.isEncryptedPayload(raw) ? cryptoVault.decrypt(uid, raw) : raw;
  } catch (err) {
    log.error(`migrate decrypt failed: ${(err as Error).message} — leaving local file in place`);
    return false;
  }
  try {
    fs.mkdirSync(cloudDir, { recursive: true });
    const enc = cryptoVault.encrypt(oauth, plain);
    fs.writeFileSync(newPath, enc, { mode: 0o600 });
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
  log.info('connectors.json migrated to cloud + re-keyed to OAuth user_id');
  return true;
}
