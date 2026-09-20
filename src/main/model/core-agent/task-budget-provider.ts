import type { LLMProvider } from '#core-agent';
import { isOverTaskBudget, recordUsageTokens } from '../../util/conversation-cost-meter';

/** Per-request runaway backstop. Already-issued calls settle normally; only
 * subsequent calls are refused. Wrap each candidate so retries also pass here. */
export function withTaskBudget(provider: LLMProvider, cid?: string): LLMProvider {
  if (!cid) return provider;
  const admit = () => {
    if (isOverTaskBudget(cid)) {
      throw Object.assign(new Error('Task token limit reached'), { code: 'TASK_TOKEN_LIMIT_REACHED' });
    }
  };
  return {
    id: provider.id,
    name: provider.name,
    validateAuth: () => provider.validateAuth(),
    async complete(params) {
      admit();
      const result = await provider.complete(params);
      recordUsageTokens(cid, { inputTokens: result.usage?.inputTokens, outputTokens: result.usage?.outputTokens });
      return result;
    },
    async *stream(params) {
      admit();
      let inputTokens: number | undefined;
      let outputTokens: number | undefined;
      try {
        for await (const event of provider.stream(params)) {
          if (event.type === 'message_end' && event.usage) {
            // Terminal usage is a snapshot, not a delta. Some transports emit
            // more than one terminal update; charge the final snapshot once.
            inputTokens = event.usage.inputTokens ?? inputTokens;
            outputTokens = event.usage.outputTokens ?? outputTokens;
          }
          yield event;
        }
      } finally {
        recordUsageTokens(cid, { inputTokens, outputTokens });
      }
    },
  };
}
