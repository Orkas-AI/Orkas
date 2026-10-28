import { randomUUID } from 'node:crypto';
import type { Api, Context, Model } from '@earendil-works/pi-ai/compat';

const PLAINTEXT_FIELDS = new Set(['reasoning_content', 'reasoning', 'reasoning_text']);

/** pi-ai 1.3.0 drops an assistant with reasoning but no text/tool calls.
 * Keep only already-projected portable Chat reasoning alive inside the SDK,
 * then remove our request-local sentinel before payload hooks or transport.
 * The SDK still owns reasoning fields, source checks and generic conversion.
 * No sentinel enters model input, persisted history or visible answer text. */
export function prepareChatReasoningReplay<T extends Context>(context: T, model: Model<Api>) {
  let marker: string | undefined;
  let expected = 0;
  let messages: T['messages'] | undefined;
  if (model.api === 'openai-completions') {
    for (const [index, message] of context.messages.entries()) {
      if (message.role !== 'assistant' || !message.content.length
        || !message.content.every(block => block.type === 'text' ? !block.text.trim()
          : block.type === 'thinking' && !block.redacted && PLAINTEXT_FIELDS.has(block.thinkingSignature ?? ''))
        || !message.content.some(block => block.type === 'thinking' && block.thinking.trim())) continue;
      marker ??= `orkas-chat-replay:${randomUUID()}`;
      messages ??= context.messages.slice();
      messages[index] = { ...message, content: [...message.content, { type: 'text', text: marker }] };
      expected++;
    }
  }
  return {
    active: !!marker,
    context: messages ? { ...context, messages } : context,
    restore(payload: unknown): unknown {
      if (!marker) return payload;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || !Array.isArray((payload as { messages?: unknown }).messages)) {
        throw new Error('Chat reasoning replay payload is unavailable');
      }
      const body = payload as { messages: Record<string, unknown>[] };
      let restored = 0;
      const projected = body.messages.flatMap(message => {
        if (message.role !== 'assistant') return [message];
        let content = message.content;
        if (content === marker) content = null;
        else if (Array.isArray(content) && content.some(block => block?.type === 'text' && block.text === marker)) {
          // Preserve SDK-declared thinking-as-text compatibility, if enabled.
          content = content.filter(block => block?.type !== 'text' || block.text !== marker);
        } else return [message];
        restored++;
        const hasContent = typeof content === 'string' ? content.length > 0
          : Array.isArray(content) && content.length > 0;
        const hasReasoning = [...PLAINTEXT_FIELDS].some(field =>
          typeof message[field] === 'string' && (message[field] as string).trim().length > 0);
        // Never revive state the SDK itself omitted, or manufacture a body.
        return hasContent || hasReasoning ? [{ ...message, content }] : [];
      });
      // Fail before transport if a future serializer changes the sentinel's
      // shape; no internal text may escape under an unverified SDK contract.
      if (restored !== expected) throw new Error('Chat reasoning replay serializer mismatch');
      return { ...payload, messages: projected };
    },
  };
}
