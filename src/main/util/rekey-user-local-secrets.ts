/**
 * Local secret compatibility when a user directory is renamed.
 *
 * Some local config files are encrypted with an owner id as associated
 * context. When hosted builds rename `anonymous` / legacy 8-digit or dashless
 * directories to the real account uid directory, the file path moves but the
 * encrypted owner must move too.
 */
import * as fs from 'node:fs';

import { userAuthProfilesFile } from '../paths';
import * as localSecrets from './local-secret-store';
import { createLogger } from '../logger';
import { maskId } from './log-redact';

const log = createLogger('local-secret-rekey');

const AUTH_SECRET_NAMESPACE = 'auth.profiles';
const AUTH_SECRET_RECORD_ID = 'auth-profiles.json';

function authSecretContext(ownerId: string): localSecrets.LocalSecretContext {
  return {
    namespace: AUTH_SECRET_NAMESPACE,
    ownerId,
    recordId: AUTH_SECRET_RECORD_ID,
  };
}

function unique(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function tryReadAuthProfilesPlaintext(raw: string, owners: string[]): { plaintext: string; ownerId: string; needsRewrite: boolean } | null {
  if (!localSecrets.isEncryptedSecret(raw)) {
    JSON.parse(raw);
    return { plaintext: raw, ownerId: '', needsRewrite: true };
  }
  for (const ownerId of owners) {
    try {
      const dec = localSecrets.decryptLocalSecretWithMeta(
        authSecretContext(ownerId),
        raw,
        { legacySeeds: [ownerId] },
      );
      JSON.parse(dec.plaintext);
      return { plaintext: dec.plaintext, ownerId, needsRewrite: localSecrets.shouldRewriteLocalSecret(dec.kind) };
    } catch {
      /* try next owner */
    }
  }
  return null;
}

export function rekeyUserLocalSecretsAfterLocalIdChange(opts: {
  fromLocalId: string;
  toLocalId: string;
  accountUserId?: string | null;
}): void {
  const file = userAuthProfilesFile(opts.toLocalId);
  if (!fs.existsSync(file)) return;

  const targetOwner = opts.accountUserId || opts.toLocalId;
  const candidateOwners = unique([targetOwner, opts.fromLocalId, opts.toLocalId]);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log.warn('failed to read auth profiles for rekey', { file, error: (err as Error).message });
    return;
  }

  let dec: { plaintext: string; ownerId: string; needsRewrite: boolean } | null = null;
  try {
    dec = tryReadAuthProfilesPlaintext(raw, candidateOwners);
  } catch (err) {
    log.warn('failed to parse auth profiles for rekey', { file, error: (err as Error).message });
    return;
  }
  if (!dec) {
    log.warn('failed to decrypt auth profiles for rekey', { file, owners: candidateOwners.map(maskId) });
    return;
  }
  if (dec.ownerId === targetOwner && !dec.needsRewrite) return;

  try {
    const out = localSecrets.encryptLocalSecret(authSecretContext(targetOwner), dec.plaintext);
    fs.writeFileSync(file, out, { encoding: 'utf8', mode: 0o600 });
    log.info('auth profiles rekeyed after uid directory change', {
      fromLocalId: maskId(opts.fromLocalId),
      toLocalId: maskId(opts.toLocalId),
      fromOwner: dec.ownerId ? maskId(dec.ownerId) : 'plaintext',
      toOwner: maskId(targetOwner),
    });
  } catch (err) {
    log.warn('failed to write rekeyed auth profiles', { file, error: (err as Error).message });
  }
}
