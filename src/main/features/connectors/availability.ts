/**
 * Runtime availability gates for catalogued connectors.
 *
 * Runtime availability gate for catalogued connectors. Released Composio cards are bundled in
 * the PC catalog, while Server config supplies runtime auth/tool metadata and can append new
 * catalog rows. If a connector is in the resolved catalog, it is enabled unless the entry itself
 * is marked `availability: visible_disabled`.
 */
import type { CatalogEntry } from './types';

export type ConnectorAvailability = 'enabled' | 'hidden' | 'visible_disabled';

export function isGoogleConnectorId(id: string): boolean {
  return ['google-workspace', 'gmail', 'gdrive', 'gcal', 'gdocs', 'gsheets', 'gtasks'].includes(id);
}

export function connectorAvailabilityForId(id: string): ConnectorAvailability {
  void id;
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
