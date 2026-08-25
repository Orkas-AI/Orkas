/**
 * Match the Fetch/undici header-value conversion used by provider SDKs.
 * This catches both non-ByteString characters and forbidden control bytes
 * before a credential reaches a request or transient retry classification.
 */
export function isBearerTokenHeaderSafe(token: string): boolean {
  try {
    const headers = new Headers();
    headers.set('Authorization', `Bearer ${token}`);
    return true;
  } catch {
    return false;
  }
}
