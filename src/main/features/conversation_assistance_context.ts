/** Feature-owned guidance from explicit task entry metadata, rebuilt per Commander turn. */
import * as chats from './chats';
import { prompts } from '../prompts/loader';
import { formatConnectorSetupAssistance } from './connector_setup_context';

export async function resolveConversationAssistanceForTurn(userId: string, cid: string): Promise<{
  kind?: chats.ConversationAssistance['kind'];
  guidance: string;
}> {
  const conversation = await chats.getConversationMetadata(userId, cid);
  const assistance = conversation?.assistance;
  return {
    kind: assistance?.kind,
    guidance: assistance?.kind === 'app_creation'
      ? prompts.load('app_creation_guidance').trim()
      : formatConnectorSetupAssistance(assistance),
  };
}
