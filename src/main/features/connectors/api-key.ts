import { getOrkasApiKey } from '../auth';

export class OrkasApiCredentialRequiredError extends Error {
  readonly code = 'orkas_api_key_required';

  constructor(message = 'Configure an Orkas API Key before using this connector.') {
    super(message);
    this.name = 'OrkasApiCredentialRequiredError';
  }
}

export function requireConnectorApiKey(): string {
  const key = getOrkasApiKey();
  if (!key) throw new OrkasApiCredentialRequiredError();
  return key;
}

export function connectorApiKeyHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${requireConnectorApiKey()}` };
}
