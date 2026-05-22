/**
 * Local-file encryption for credential-bearing JSON files (`connectors.json`, `auth-profiles.json`).
 *
 * Design intent — **obfuscation, not security**: the key is derived deterministically from a
 * compiled-in app salt + the active user's uid, so anyone who runs Orkas can decrypt their own
 * files (transparent to the user). It is NOT keychain-protected, deliberately — see
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
 * Anyone needing the stronger guarantee should adopt keychain-backed storage; that's a separate
 * Phase 2 work item.
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

function _deriveKey(uid: string): Buffer {
  if (_keyCache.has(uid)) return _keyCache.get(uid)!;
  const k = crypto.pbkdf2Sync(uid, APP_SALT, ITER, KEY_LEN, 'sha256');
  _keyCache.set(uid, k);
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

export function encrypt(uid: string, plaintext: string): string {
  if (!uid) throw new Error('crypto-vault: uid required');
  const key = _deriveKey(uid);
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([MAGIC, iv, tag, ct]);
  return blob.toString('base64');
}

export function decrypt(uid: string, b64: string): string {
  if (!uid) throw new Error('crypto-vault: uid required');
  const blob = Buffer.from(b64, 'base64');
  if (blob.length < MAGIC.length + IV_LEN + TAG_LEN) throw new Error('crypto-vault: payload too short');
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('crypto-vault: bad magic');
  const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
  const tag = blob.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
  const ct = blob.subarray(MAGIC.length + IV_LEN + TAG_LEN);
  const key = _deriveKey(uid);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
