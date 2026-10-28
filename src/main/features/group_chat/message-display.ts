import { splitMarkdownProseCode } from '../../util/markdown-prose-code';
import type { GroupMessage } from './visibility';

/** Called at the native successor boundary, before persistence. Classification
 * never edits source prose or model history, and is idempotent on reload. */
export function classifyNativeCommentary(record: GroupMessage): GroupMessage {
  if (record.display_phase === 'commentary') return record;
  return { ...record, display_phase: 'commentary', process: [
    ...(record.text.trim() ? [{ type: 'progress' as const, text: record.text,
      event: { stream: 'assistant', data: { phase: 'commentary', native_segment: record.seg } } }] : []),
    ...(record.process || []),
  ] };
}

/** Compatibility for the old persisted segmented-record contract: flushed
 * native messages always stored an array (including empty); official terminal
 * records include a runtime end receipt. Commander dispatches are distinct
 * public messages. Unknown shapes and active snapshots remain untouched.
 * Runs in the history projection owner and is retained in its disk cache. */
export function normalizeNativeMessageDisplay(record: GroupMessage): GroupMessage {
  // A host interruption receipt is already public reply content, not an
  // unfinished native segment. Its clock may be absent or recovered later.
  if (record.system_kind === 'reply_interrupted') return record;
  if (record.display_phase || !record.id || !record.source_message_id || !record.turn_id
      || typeof record.text !== 'string'
      || !record.from || record.from === 'user' || record.from === 'commander'
      || !Number.isInteger(record.seg) || Number(record.seg) < 0 || record.dispatch
      || !Array.isArray(record.process)) return record;
  const terminal = record.process.some(item => item?.type === 'event'
    && item.event?.stream === 'runtime'
    && (item.event.data as { phase?: unknown } | undefined)?.phase === 'end');
  return terminal ? { ...record, display_phase: 'final_answer' } : classifyNativeCommentary(record);
}

/** Composer provenance, captured before automatic recipient-prefix injection.
 * Absence retains the legacy behavior of hiding every Commander marker. */
export type CommanderMentionDisplay = 'preserve' | 'hide_generated_prefix';

export function commanderMentionDisplayText(text: string, mode: unknown): string | undefined {
  if (mode === 'preserve') return text;
  if (mode !== 'hide_generated_prefix') return undefined;
  // Only the exact prefix emitted by the composer is transport-only.
  const prefix = ['@commander ', '@commander\n'].find((value) => text.startsWith(value));
  return prefix ? text.slice(prefix.length) : text;
}

/** Preserve the existing canonical cleanup, including code and punctuation. */
export function stripReservedRoutingMentions(text: string, tokens: Set<string>): string {
  if (!tokens.size) return text;
  return splitMarkdownProseCode(text).map((segment) => {
    if (segment.kind === 'code') return segment.text;
    let prose = segment.text;
    for (const tok of tokens) {
      const safeTok = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(
        `(^|\\s|[,，:：。！？!?])@${safeTok}(?=$|\\s|[,，:：。！？!?])`,
        'g',
      );
      prose = prose.replace(re, (_full, prev) => prev);
    }
    prose = prose.replace(/[ \t]+([,，:：。！？!?])/g, '$1');
    prose = prose.replace(/[ \t]{2,}/g, ' ');
    prose = prose.replace(/\n[ \t]+/g, '\n');
    return prose;
  }).join('').trim();
}
