/**
 * Connector-only deep-link delivery for the public desktop build.
 *
 * Account login is intentionally absent. The only accepted URLs are:
 *   - orkas://connectors/oauth/callback
 *   - orkas://connectors/oauth/dcr-callback
 *
 * OAuth redirects always land on the public HTTPS Server first. Its landing page then opens one
 * of the URLs above so the exact app instance that started the flow can finish the exchange. This
 * module owns that final OS-protocol hop without restoring any account/session behavior.
 */
import * as path from 'node:path';
import { app, BrowserWindow } from 'electron';

import { createLogger } from '../../logger';
import { safeUrlAction } from '../../util/log-redact';
import { handleCallbackUrl, handleDcrCallbackUrl } from './index';

const log = createLogger('connectors:protocol');
const CONNECTOR_SCHEME = 'orkas';
const SERVER_CALLBACK_PATH = '/oauth/callback';
const DCR_CALLBACK_PATH = '/oauth/dcr-callback';

let _pending: string | null = null;

function _connectorCallbackKind(rawUrl: string): 'server' | 'dcr' | null {
  let parsed: URL;
  try { parsed = new URL(rawUrl); }
  catch { return null; }
  if (parsed.protocol !== `${CONNECTOR_SCHEME}:` || parsed.host.toLowerCase() !== 'connectors') return null;
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  if (pathname === SERVER_CALLBACK_PATH) return 'server';
  if (pathname === DCR_CALLBACK_PATH) return 'dcr';
  return null;
}

function _extractConnectorCallback(argv: readonly string[] | undefined): string | null {
  for (const value of argv || []) {
    if (typeof value === 'string' && _connectorCallbackKind(value)) return value;
  }
  return null;
}

function _focusMainWindow(): void {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

async function _dispatch(rawUrl: string): Promise<void> {
  const kind = _connectorCallbackKind(rawUrl);
  if (!kind) {
    log.warn('ignored non-connector deep link', { action: safeUrlAction(rawUrl) });
    return;
  }
  if (!app.isReady()) {
    _pending = rawUrl;
    return;
  }
  log.info('connector deep link received', { action: safeUrlAction(rawUrl), kind });
  _focusMainWindow();
  try {
    if (kind === 'dcr') await handleDcrCallbackUrl(rawUrl);
    else await handleCallbackUrl(rawUrl);
  } catch (err) {
    log.warn('connector deep link handling failed', { error: (err as Error).message, kind });
  }
}

/** Register the connector callback scheme before app readiness and the single-instance handoff. */
export function registerConnectorProtocol(): void {
  try {
    if (!app.isPackaged && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(CONNECTOR_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(CONNECTOR_SCHEME);
    }
  } catch (err) {
    log.warn('connector protocol registration failed', { error: (err as Error).message });
  }

  let isDefaultHandler = false;
  try { isDefaultHandler = app.isDefaultProtocolClient(CONNECTOR_SCHEME); }
  catch { /* diagnostics only */ }
  log.info('connector protocol registration', { scheme: CONNECTOR_SCHEME, isDefaultHandler });

  app.on('open-url', (event, rawUrl) => {
    if (!_connectorCallbackKind(rawUrl)) return;
    event.preventDefault();
    void _dispatch(rawUrl);
  });

  app.on('second-instance', (_event, argv) => {
    const rawUrl = _extractConnectorCallback(argv);
    if (rawUrl) void _dispatch(rawUrl);
    else _focusMainWindow();
  });

  const cold = _extractConnectorCallback(process.argv);
  if (cold) _pending = cold;
}

/** Flush a callback delivered while Electron was still starting. */
export async function consumeColdLaunchConnectorCallback(): Promise<void> {
  if (!_pending) return;
  const rawUrl = _pending;
  _pending = null;
  await _dispatch(rawUrl);
}

export const _test = { connectorCallbackKind: _connectorCallbackKind, extractConnectorCallback: _extractConnectorCallback };
