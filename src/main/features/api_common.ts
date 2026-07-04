function envAppVersion(): string {
  const version = process.env.ORKAS_APP_VERSION || process.env.npm_package_version || '';
  return typeof version === 'string' && version.trim() ? version.trim() : '';
}

function currentAppVersion(): string {
  try {
    // This module is also loaded by node-based tests where Electron's app
    // module may be unavailable.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { app } = require('electron') as typeof import('electron');
    const version = app?.getVersion?.();
    if (typeof version === 'string' && version.trim()) return version.trim();
  } catch { /* fall through to env fallback */ }
  return envAppVersion();
}

/** Common headers for Orkas business API calls. */
export function commonHeaders(): Record<string, string> {
  const appVersion = currentAppVersion();
  return appVersion ? { app_version: appVersion } : {};
}

export function withCommonHeaders(headers?: Record<string, string>): Record<string, string> {
  return { ...commonHeaders(), ...(headers || {}) };
}
