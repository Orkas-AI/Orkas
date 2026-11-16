import { createHash } from 'node:crypto';

/** Stable across chats/devices and credential refresh, without sending raw uid.
 * This is a domain-separated pseudonym, not authentication or encryption.
 * Missing/anonymous scope retains per-chat SDK behavior instead of sharing it. */
export function providerUserCacheKey(userId: string | null | undefined): string | undefined {
  if (!userId || userId === 'anonymous') return undefined;
  return createHash('sha256').update(JSON.stringify(['orkas:user-cache:v1', userId])).digest('hex');
}
