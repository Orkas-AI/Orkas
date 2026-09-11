import { splitMarkdownProseCode } from '../../util/markdown-prose-code';

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
