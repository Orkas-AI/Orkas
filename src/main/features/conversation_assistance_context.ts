/** Feature-owned guidance from explicit task entry metadata, rebuilt per Commander turn. */
import * as chats from './chats';
import { prompts } from '../prompts/loader';
import { formatConnectorSetupAssistance } from './connector_setup_context';
import { hasPendingConversationFiling } from './conversation_filing';

export async function resolveConversationAssistanceForTurn(userId: string, cid: string): Promise<{
  kind?: chats.ConversationAssistance['kind'];
  guidance: string;
}> {
  const conversation = await chats.getConversationMetadata(userId, cid);
  const assistance = conversation?.assistance;
  const entryGuidance = assistance?.kind === 'app_creation'
    ? prompts.load('app_creation_guidance').trim()
    : formatConnectorSetupAssistance(assistance);
  const followUp = conversation && !conversation.project_id
    && !hasPendingConversationFiling(userId, cid)
    ? prompts.load('followup_offer_guidance').trim()
    : '';
  return {
    kind: assistance?.kind,
    guidance: [entryGuidance, followUp].filter(Boolean).join('\n\n'),
  };
}
