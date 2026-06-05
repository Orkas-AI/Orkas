/**
 * Runtime availability gates for catalogued connectors.
 *
 * Server remote-config can temporarily hide or soft-disable Google connectors without shipping a
 * new desktop build. The gate is enforced in three places: catalog IPC (what the user sees),
 * OAuth start (no bypass by stale renderer state), and model-tool visibility (already-connected
 * connectors must stop being usable when disabled remotely).
 */
import { getGoogleConnectorsConfig, type ConnectorSwitchState } from '../client_config';
import type { CatalogEntry } from './types';

export type ConnectorAvailability = 'enabled' | 'hidden' | 'visible_disabled';

const GOOGLE_CONNECTOR_IDS = new Set(['google-workspace', 'gmail', 'gcal', 'gdocs', 'gsheets', 'gtasks']);
const GMAIL_SCOPE_CONNECTOR_IDS = new Set(['google-workspace', 'gmail']);

function _stateToAvailability(state: ConnectorSwitchState): ConnectorAvailability {
  if (state === 'enabled') return 'enabled';
  if (state === 'visible_disabled') return 'visible_disabled';
  return 'hidden';
}

function _overallStateToAvailability(state: ConnectorSwitchState): ConnectorAvailability {
  return state === 'enabled' ? 'enabled' : 'hidden';
}

export function isGoogleConnectorId(id: string): boolean {
  return GOOGLE_CONNECTOR_IDS.has(id);
}

export function connectorAvailabilityForId(id: string): ConnectorAvailability {
  if (!isGoogleConnectorId(id)) return 'enabled';
  const cfg = getGoogleConnectorsConfig();
  const overall = _overallStateToAvailability(cfg.google);
  if (overall !== 'enabled') return overall;
  if (GMAIL_SCOPE_CONNECTOR_IDS.has(id)) return _stateToAvailability(cfg.gmail);
  return 'enabled';
}

export function isConnectorRuntimeEnabled(id: string): boolean {
  return connectorAvailabilityForId(id) === 'enabled';
}

export function catalogWithAvailability(entries: readonly CatalogEntry[]): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const entry of entries) {
    const availability = connectorAvailabilityForId(entry.id);
    if (availability === 'hidden') continue;
    if (availability === 'visible_disabled') {
      out.push({
        ...entry,
        availability,
        disabled_reason: 'unsupported',
      });
    } else {
      out.push(entry);
    }
  }
  return out;
}

export function assertConnectorRuntimeEnabled(id: string): void {
  if (isConnectorRuntimeEnabled(id)) return;
  const err = new Error('connector_unsupported') as Error & { code?: string };
  err.code = 'connector_unsupported';
  throw err;
}
