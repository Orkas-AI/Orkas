/** Check existing grants against catalog capabilities without another consent flow. */
export function missingRequiredOAuthScopes(required: string[] | undefined, scopes: string[]): string[] {
  if (!Array.isArray(required) || !required.length) return [];
  const granted = new Set(scopes.filter(Boolean));
  // Google documents this exact alternative for Search Console read APIs.
  // Do not infer scope hierarchies from prefixes or request broader access.
  if (granted.has('https://www.googleapis.com/auth/webmasters')) {
    granted.add('https://www.googleapis.com/auth/webmasters.readonly');
  }
  return required.filter(scope => !granted.has(scope));
}
