/**
 * Open-source fallback / legacy local-file encryption.
 *
 * Design intent — **obfuscation, not security**: the key is derived deterministically from a
 * compiled-in app salt + a caller-provided seed, so anyone who runs Orkas can decrypt their own
 * files when they know the seed context. It is NOT keychain-protected, deliberately — see
 * PC/CLAUDE.md §6.5 OAuth section for the reasoning (portability + no OS-keystore dependency
 * trade-off the product owner accepted).
 *
 * What this protects against:
 *   - Files accidentally syncing to a cloud backup that runs OCR / text indexing on them.
 *   - Logging / crash-dump capture that incidentally reads the JSON.
 *   - Hand-inspecting the file in a text editor.
 *   - Random other apps reading `<uid>/local/config/` via filesystem permission slip-ups.
 *
 * What this does NOT protect against:
 *   - An attacker who has both the disk contents AND the Orkas binary (the derivation function
 *     is in source code → key is recoverable from `uid` alone).
 *   - Targeted forensic recovery from a stolen device.
 *
 * Hosted Orkas should normally go through `util/local-secret-store.ts`, which uses the private
 * `ORKLSEC1:` backend when available and calls this module only as an open-source fallback or for
 * one-shot migration of older files.
 *
 * File layout written to disk:
 *
 *   `ORKVAULT1` (8 ASCII bytes) || [12B IV] || [16B GCM tag] || ciphertext
 *
 * The whole thing is base64-encoded so the file remains text (easier to ship + back up).
 */
import * as crypto from 'node:crypto';

const MAGIC = Buffer.from('ORKVAULT1');
const ITER = 200_000;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

// Hardcoded compile-time salt. NOT a secret in any meaningful sense (it's in source) — just a
// per-app constant so a leaked encrypted file from one Orkas-derivative app can't be decrypted
// by another Orkas-derivative re-using uid alone.
const APP_SALT = Buffer.from('orkas/connectors/v1', 'utf8');

const _keyCache = new Map<string, Buffer>();

// The seed is any opaque string the caller controls — historically the local uid (machine-
// private encryption), now also the Orkas-account OAuth user_id when the file is meant to be
// decrypted cross-device after cloud sync (see `features/connectors/registry.ts` for that
// case). The function doesn't care which it is; the caller picks.
function _deriveKey(seed: string): Buffer {
  if (_keyCache.has(seed)) return _keyCache.get(seed)!;
  const k = crypto.pbkdf2Sync(seed, APP_SALT, ITER, KEY_LEN, 'sha256');
  _keyCache.set(seed, k);
  return k;
}

export function isEncryptedPayload(text: string): boolean {
  // Cheap probe — anything that doesn't decode to our magic header is treated as plaintext.
  if (!text) return false;
  const head = text.slice(0, 12);
  try {
    const bytes = Buffer.from(head, 'base64');
    return bytes.length >= MAGIC.length && bytes.subarray(0, MAGIC.length).equals(MAGIC);
  } catch {
    return false;
  }
}

export function encrypt(seed: string, plaintext: string): string {
  if (!seed) throw new Error('crypto-vault: seed required');
  const key = _deriveKey(seed);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([MAGIC, iv, tag, ct]);
  return blob.toString('base64');
}

export function decrypt(seed: string, b64: string): string {
  if (!seed) throw new Error('crypto-vault: seed required');
  const blob = Buffer.from(b64, 'base64');
  if (blob.length < MAGIC.length + IV_LEN + TAG_LEN) throw new Error('crypto-vault: payload too short');
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('crypto-vault: bad magic');
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ct = blob.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const key = _deriveKey(seed);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
