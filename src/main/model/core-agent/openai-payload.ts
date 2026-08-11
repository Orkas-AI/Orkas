function toolCallIds(message: Record<string, unknown>): string[] {
  const calls = message.tool_calls;
  if (!Array.isArray(calls)) return [];
  const ids: string[] = [];
  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    const id = (call as Record<string, unknown>).id;
    if (typeof id === 'string' && id.length > 0) ids.push(id);
  }
  return ids;
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (!part || typeof part !== 'object') return String(part ?? '');
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string') return p.text;
      if (p.type === 'image_url' || p.type === 'image' || p.type === 'input_image') return '[image]';
      try { return JSON.stringify(p); }
      catch { return String(p.type || '[content]'); }
    }).filter(Boolean).join('\n');
  }
  if (content == null) return '';
  try { return JSON.stringify(content); }
  catch { return String(content); }
}

function orphanToolAsUserMessage(message: Record<string, unknown>): Record<string, unknown> {
  const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
  const body = textFromContent(message.content);
  const header = id
    ? `Tool result for ${id} was detached from its tool_calls; preserving it as user-visible context.`
    : 'Detached tool result preserved as user-visible context.';
  return {
    role: 'user',
    content: body ? `${header}\n\n${body}` : header,
  };
}

/**
 * OpenAI-compatible chat completions reject `role:"tool"` messages unless
 * they answer an earlier assistant `tool_calls` entry in the same contiguous
 * tool-result cluster. Most histories are already valid; this is a final
 * payload guard for compacted/restored sessions where the assistant tool call
 * was lost but the tool result survived.
 */
export function repairOpenAIToolMessageOrder(params: unknown): unknown {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return params;
  const root = params as Record<string, unknown>;
  const messages = root.messages;
  if (!Array.isArray(messages)) return params;

  let changed = false;
  let pendingToolCallIds = new Set<string>();
  const repaired = messages.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      pendingToolCallIds = new Set();
      return raw;
    }

    const message = raw as Record<string, unknown>;
    const role = message.role;
    if (role === 'assistant') {
      pendingToolCallIds = new Set(toolCallIds(message));
      return raw;
    }
    if (role === 'tool') {
      const id = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
      if (id && pendingToolCallIds.has(id)) {
        pendingToolCallIds.delete(id);
        return raw;
      }
      changed = true;
      pendingToolCallIds = new Set();
      return orphanToolAsUserMessage(message);
    }

    pendingToolCallIds = new Set();
    return raw;
  });

  if (!changed) return params;
  return { ...root, messages: repaired };
}
