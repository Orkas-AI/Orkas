import { fetchWithTimeout } from '../../util/abort';
import { withCommonHeaders } from '../api_common';
import { accountApiBase } from './_server_bridge';
import { connectorApiKeyHeaders } from './api-key';
import type { CatalogEntry, ConnectorUsageMetering } from './types';

export const COMPOSIO_CONNECTOR_CREDITS_MILLI_PER_CALL = 420;

export type ConnectorUsageStage = 'connect' | 'tool_call';

export function usageMeteringForEntry(entry: CatalogEntry | null | undefined): ConnectorUsageMetering | null {
  const metering = entry?.usage_metering || null;
  if (!metering || metering.provider !== 'composio') return null;
  const creditsMilli = Number(metering.credits_milli_per_call || COMPOSIO_CONNECTOR_CREDITS_MILLI_PER_CALL);
  if (!Number.isFinite(creditsMilli) || creditsMilli <= 0) return null;
  return { ...metering, credits_milli_per_call: Math.floor(creditsMilli) };
}

function parseJson(text: string): Record<string, unknown> {
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

export async function preflightConnectorCredits(
  entry: CatalogEntry,
  stage: ConnectorUsageStage,
  calls = 1,
): Promise<Record<string, unknown> | null> {
  const metering = usageMeteringForEntry(entry);
  if (!metering) return null;
  const response = await fetchWithTimeout(`${accountApiBase()}/connectors/usage/preflight`, {
    method: 'POST',
    headers: withCommonHeaders({
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...connectorApiKeyHeaders(),
    }),
    body: JSON.stringify({
      provider: metering.provider,
      connector_id: entry.id,
      stage,
      calls: Math.max(1, Math.floor(Number(calls) || 1)),
    }),
  }, 60_000, undefined, 'connector usage preflight timed out after 60s');
  const body = parseJson(await response.text());
  if (!response.ok || Number(body.code || 0) !== 0) {
    const nested = body.error && typeof body.error === 'object' && !Array.isArray(body.error)
      ? body.error as Record<string, unknown>
      : {};
    const error = new Error(String(nested.message || body.msg || 'Connector credit check failed')) as Error & { code?: string };
    const code = String(nested.code || '').trim();
    if (/^[A-Za-z0-9_.:-]{1,80}$/.test(code)) error.code = code;
    throw error;
  }
  return body;
}
