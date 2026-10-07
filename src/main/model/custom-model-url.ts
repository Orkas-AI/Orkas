/** Canonical SDK base for Anthropic Messages, retaining gateway path prefixes. */
export function normalizeAnthropicBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/v1(?:\/messages)?$/, '') || '/';
  return url.toString().replace(/\/+$/, '');
}
