/** On-demand setup guidance and its lightweight conversation association.
 * No workflow state, credentials, browser references, or capability grants.
 */
import { prompts } from '../prompts/loader';
import * as chats from './chats';
import { connectorCatalog } from './connectors/catalog';
import { setupGuideId } from './connectors/setup-guides';

export function connectorSetupGuidance(): string {
  return prompts.load('connector_setup_guidance', {}).trim();
}

/** Validate at the trusted entry boundary; never accept renderer-authored instructions. */
export function validateConnectorSetupAssistance(raw: unknown): chats.ConnectorSetupAssistance {
  const assistance = chats.normalizeConnectorSetupAssistance(raw);
  const entry = assistance && connectorCatalog().find(item => item.id === assistance.connector_id);
  if (!assistance || !entry || entry.availability === 'visible_disabled' || entry.unavailable_reason) {
    throw new Error('Connector setup is unavailable. Select an available connector and try again.');
  }
  return assistance;
}

export async function bindConnectorSetupAssistance(userId: string, cid: string, connectorId: string): Promise<void> {
  const assistance = validateConnectorSetupAssistance({ kind: 'connector_setup', connector_id: connectorId });
  const current = await chats.getConversationMetadata(userId, cid);
  if (!current) throw new Error('Open the conversation and try again.');
  if (current.assistance?.connector_id === connectorId) return;
  if (!await chats.updateConversation(userId, cid, { assistance })) {
    throw new Error('Open the conversation and try again.');
  }
}

/** Rebuilt for Commander turns, never persisted as a dialogue message.
 * Details/status remain on demand, so unrelated follow-ups incur only this short block.
 */
export async function formatConnectorSetupForTurn(userId: string, cid: string): Promise<string> {
  const conversation = await chats.getConversationMetadata(userId, cid);
  const assistance = conversation?.assistance;
  if (!assistance) return '';
  const entry = connectorCatalog().find(item => item.id === assistance.connector_id);
  // Old/synced metadata may refer to a connector absent from this edition.
  if (!entry) return '';
  return [
    '## Connector setup assistance',
    connectorSetupGuidance(),
    JSON.stringify({ connector_id: entry.id, setup_guide_id: setupGuideId(entry) }),
    'For setup assistance, use connector_setup inspect for configuration instructions and official links, and status for current connection facts. The association itself proves neither an active setup nor a successful connection.',
  ].join('\n\n');
}
