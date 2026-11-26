import type { LLMProvider, Usage } from '#core-agent';
import { isOverTaskBudget, recordUsageTokens } from '../../util/conversation-cost-meter';

/** Per-request runaway backstop. Already-issued calls settle normally; only
 * subsequent calls are refused. Wrap each candidate so retries also pass here. */
export function withTaskBudget(provider: LLMProvider, cid?: string, observeUsage?: (usage: Partial<Usage>) => void): LLMProvider {
  if (!cid && !observeUsage) return provider;
  const admit = () => {
    if (cid && isOverTaskBudget(cid)) {
      throw Object.assign(new Error('Task token limit reached'), { code: 'TASK_TOKEN_LIMIT_REACHED' });
    }
  };
  const settle = (usage: Partial<Usage> | undefined) => {
    if (!usage) return;
    const { inputTokens, outputTokens, cacheWriteTokens } = usage;
    recordUsageTokens(cid, { inputTokens, outputTokens, cacheWriteTokens });
    try { observeUsage?.(usage); } catch { /* Usage diagnostics must not alter the request. */ }
  };
  return {
    id: provider.id,
    name: provider.name,
    validateAuth: () => provider.validateAuth(),
    async complete(params) {
      admit();
      const result = await provider.complete(params);
      settle(result.usage);
      return result;
    },
    async *stream(params) {
      admit();
      let usage: Partial<Usage> | undefined;
      try {
        for await (const event of provider.stream(params)) {
          if (event.type === 'message_end' && event.usage) {
            // Terminal usage is a snapshot, not a delta. Some transports emit
            // more than one terminal update; charge the final snapshot once.
            usage = {
              inputTokens: event.usage.inputTokens ?? usage?.inputTokens,
              outputTokens: event.usage.outputTokens ?? usage?.outputTokens,
              cacheWriteTokens: event.usage.cacheWriteTokens ?? usage?.cacheWriteTokens,
              cacheReadTokens: event.usage.cacheReadTokens ?? usage?.cacheReadTokens,
              totalTokens: event.usage.totalTokens ?? usage?.totalTokens,
            };
          }
          yield event;
        }
      } finally {
        settle(usage);
      }
    },
  };
}
