import { hasHistoryProcess, historyProcessTexts, historyRecordTextParts } from '../chat-history-records';

/** Preserve the first-token snippet without projecting the rest of a large
 * execution trail after its display window is already known. Parts have the
 * same newline separator as historyRecordText; query tokens contain no spaces. */
export function makeSnippet(parts: Iterable<string>, tokens: readonly string[], radius = 60): string {
  const chunks: string[] = [];
  let length = 0, lowerLength = 0, trailingSpace = false;
  let bestIdx = -1, bestLen = 0;
  for (const part of parts) {
    if (!part) continue;
    let flat = part.replace(/\s+/g, ' ');
    if (length) {
      if (trailingSpace && flat.startsWith(' ')) flat = flat.slice(1);
      else if (!trailingSpace && !flat.startsWith(' ')) flat = ' ' + flat;
    }
    const lower = flat.toLowerCase();
    if (bestIdx < 0) {
      for (const token of tokens) {
        const idx = lower.indexOf(token);
        if (idx >= 0 && (bestIdx < 0 || lowerLength + idx < bestIdx)) {
          bestIdx = lowerLength + idx;
          bestLen = token.length;
        }
      }
    }
    chunks.push(flat);
    length += flat.length;
    lowerLength += lower.length;
    if (flat) trailingSpace = flat.endsWith(' ');
    // One character beyond the window proves the trailing ellipsis. Do not
    // touch later tool payloads just to discard them from the visible snippet.
    if (bestIdx >= 0 && length > bestIdx + bestLen + radius) break;
  }
  const flat = chunks.join('');
  if (bestIdx < 0) return flat.slice(0, radius * 2);
  const start = Math.max(0, bestIdx - radius);
  const end = Math.min(flat.length, bestIdx + bestLen + radius);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

export interface ChatSnippet {
  snippet: string;
  visible: boolean;
  msg_id?: string;
  has_process?: boolean;
  process_snippet?: string;
}

/** Only this small projection survives a source read. Large execution records
 * are released one at a time instead of retaining every search candidate. */
export function projectChatSnippet(message: any, tokens: readonly string[]): ChatSnippet | undefined {
  if (!message) return undefined;
  let visible = false;
  if (!message.deleted_at && !message.dispatch) {
    for (const part of historyRecordTextParts(message, true)) {
      if (part.trim()) { visible = true; break; }
    }
  }
  const result: ChatSnippet = { snippet: makeSnippet(historyRecordTextParts(message, true), tokens), visible };
  if (hasHistoryProcess(message)) {
    result.has_process = true;
    let best = '', coverage = 0;
    const terms = [...new Set(tokens)];
    for (const text of historyProcessTexts(message, true)) {
      const lower = text.toLowerCase();
      const matched = terms.reduce((count, term) => count + Number(lower.includes(term)), 0);
      if (matched > coverage) { best = text; coverage = matched; }
      // Later entries cannot improve full coverage; ties retain the first.
      if (coverage === terms.length) break;
    }
    if (best) result.process_snippet = makeSnippet([best], tokens);
  }
  if (typeof message.id === 'string' && message.id) result.msg_id = message.id;
  return result;
}
