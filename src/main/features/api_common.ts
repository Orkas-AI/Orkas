import { app as electronApp } from 'electron';

import { currentClientChannel } from './client_channel';
import { desktopPlatform, osVersion } from '../system_info';
import { getCurrentLang } from '../i18n';

export const CLIENT_HEADER_NAMES = {
  appVersion: 'Orkas-App-Version',
  platform: 'Orkas-Platform',
  osVersion: 'Orkas-OS-Version',
  arch: 'Orkas-Arch',
  channel: 'Orkas-Channel',
} as const;

function envAppVersion(): string {
  const version = process.env.ORKAS_APP_VERSION || process.env.npm_package_version || '';
  return typeof version === 'string' && version.trim() ? version.trim() : '';
}

function currentAppVersion(): string {
  try {
    const version = electronApp?.getVersion?.();
    if (typeof version === 'string' && version.trim()) return version.trim();
  } catch { /* fall through to env fallback */ }
  return envAppVersion();
}

let stableHeadersCache: Readonly<Record<string, string>> | null = null;
let stableHeadersContext = '';

function stableHeadersContextKey(): string {
  let appPath = '';
  try { appPath = electronApp?.getAppPath?.() || ''; } catch { /* pre-ready */ }
  return [
    appPath,
    process.env.ORKAS_APP_VERSION || '',
    process.env.npm_package_version || '',
  ].join('\u0000');
}

function stableClientHeaders(): Readonly<Record<string, string>> {
  const context = stableHeadersContextKey();
  if (stableHeadersCache && stableHeadersContext === context) return stableHeadersCache;
  const appVersion = currentAppVersion();
  stableHeadersCache = Object.freeze({
    [CLIENT_HEADER_NAMES.appVersion]: appVersion || 'unknown',
    [CLIENT_HEADER_NAMES.platform]: desktopPlatform(),
    [CLIENT_HEADER_NAMES.osVersion]: osVersion(),
    [CLIENT_HEADER_NAMES.arch]: process.arch,
    [CLIENT_HEADER_NAMES.channel]: currentClientChannel(),
  });
  stableHeadersContext = context;
  return stableHeadersCache;
}

/** Canonical client metadata for every Orkas business API call. */
export function commonHeaders(): Record<string, string> {
  const headers: Record<string, string> = { ...stableClientHeaders() };
  try {
    const language = getCurrentLang();
    if (language) headers['Accept-Language'] = language;
  } catch {
    headers['Accept-Language'] = 'en';
  }
  return headers;
}

export function withCommonHeaders(headers?: Record<string, string>): Record<string, string> {
  return { ...(headers || {}), ...commonHeaders() };
}
