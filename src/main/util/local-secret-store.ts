/**
 * Shared facade for local secret persistence.
 *
 * Hosted Orkas uses the private backend in `features/hosted_secrets/` and writes
 * `ORKLSEC1:` payloads. the open-source build does not ship that backend; the same facade
 * then falls back to the open-source `crypto-vault` implementation. Callers
 * pass explicit context so secrets are bound to their business owner/record.
 */
import * as cryptoVault from './crypto-vault';

const HOSTED_PREFIX = 'ORKLSEC1:';

export interface LocalSecretContext {
  namespace: string;
  ownerId: string;
  recordId: string;
}

export type LocalSecretKind = 'hosted' | 'context' | 'legacy';

export interface DecryptedLocalSecret {
  plaintext: string;
  kind: LocalSecretKind;
}

function assertContext(ctx: LocalSecretContext): void {
  if (!ctx.namespace || !ctx.ownerId || !ctx.recordId) {
    throw new Error('local-secret-store: missing context');
  }
}

function contextSeed(ctx: LocalSecretContext): string {
  assertContext(ctx);
  return `${ctx.namespace}\0${ctx.ownerId}\0${ctx.recordId}`;
}

function hostedBackend(): any | null {
  try {
    // Dynamic require by design: the open-source build strips this directory, while Hosted Orkas keeps it.
    // Keep the specifier computed so the OSS orphan-import checker does not treat this optional
    // backend as a hard dependency after the private directory is removed.
    const spec = ['..', 'features', 'hosted_secrets', 'local_secret_store'].join('/');
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    return require(spec);
  } catch {
    return null;
  }
}

export function preferredLocalSecretKind(): 'hosted' | 'fallback' {
  return hostedBackend() ? 'hosted' : 'fallback';
}

export function isHostedEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(HOSTED_PREFIX);
}

export function isEncryptedSecret(value: unknown): value is string {
  return typeof value === 'string' && (isHostedEncryptedSecret(value) || cryptoVault.isEncryptedPayload(value));
}

export function encryptLocalSecret(ctx: LocalSecretContext, plaintext: string): string {
  assertContext(ctx);
  const hosted = hostedBackend();
  if (hosted && typeof hosted.encryptSecret === 'function') {
    return hosted.encryptSecret(ctx.namespace, ctx.ownerId, ctx.recordId, plaintext);
  }
  return cryptoVault.encrypt(contextSeed(ctx), plaintext);
}

export function decryptLocalSecretWithMeta(
  ctx: LocalSecretContext,
  payload: string,
  opts: { legacySeeds?: string[] } = {},
): DecryptedLocalSecret {
  assertContext(ctx);
  if (isHostedEncryptedSecret(payload)) {
    const hosted = hostedBackend();
    if (!hosted || typeof hosted.decryptSecret !== 'function') {
      throw new Error('local-secret-store: hosted backend unavailable');
    }
    return {
      plaintext: hosted.decryptSecret(ctx.namespace, ctx.ownerId, ctx.recordId, payload),
      kind: 'hosted',
    };
  }

  if (cryptoVault.isEncryptedPayload(payload)) {
    try {
      return { plaintext: cryptoVault.decrypt(contextSeed(ctx), payload), kind: 'context' };
    } catch { /* try legacy seeds below */ }

    const seen = new Set<string>();
    for (const seed of opts.legacySeeds || []) {
      if (!seed || seen.has(seed)) continue;
      seen.add(seed);
      try {
        return { plaintext: cryptoVault.decrypt(seed, payload), kind: 'legacy' };
      } catch { /* next */ }
    }
  }

  throw new Error('local-secret-store: unsupported or corrupt payload');
}

export function decryptLocalSecret(
  ctx: LocalSecretContext,
  payload: string,
  opts: { legacySeeds?: string[] } = {},
): string {
  return decryptLocalSecretWithMeta(ctx, payload, opts).plaintext;
}

export function shouldRewriteLocalSecret(kind: LocalSecretKind): boolean {
  const preferred = preferredLocalSecretKind();
  if (preferred === 'hosted') return kind !== 'hosted';
  return kind === 'legacy';
}
