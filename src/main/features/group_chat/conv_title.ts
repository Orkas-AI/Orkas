// Placeholder conversation-title helpers shared by group-chat modules.
// Keep this file's import surface narrow (only `i18n` — itself a leaf that
// reads locale json) so `chats.ts` can import group_chat facade without
// entering the conv_workspace -> chats cycle.

import { SUPPORTED_LANGS, t } from '../../i18n';

// Capitalization variants from an older creation path. Live conversations
// may still carry these literal titles from their creation time, so they
// stay in the set as historical aliases.
const HISTORICAL_PLACEHOLDERS: readonly string[] = [
  'New Conversation',
  'New Chat',
];

function buildPlaceholderTitles(): Set<string> {
  const out = new Set<string>(HISTORICAL_PLACEHOLDERS);
  for (const lang of SUPPORTED_LANGS) {
    try {
      const value = t('chat.default_title', undefined, lang);
      // `t()` returns the raw key on miss — skip that to avoid polluting
      // the placeholder set with the literal "chat.default_title" string.
      if (value && value !== 'chat.default_title') out.add(value);
    } catch { /* locale load failure — keep set partial rather than crash */ }
  }
  return out;
}

// Match the literal default title `chats.createConversation` writes when
// no title is supplied (`t('chat.default_title')` resolved at creation
// time per UI language) AND any historical / capitalization variant.
// Built once at module load by enumerating every supported UI language —
// adding a new locale auto-populates the set; nothing to remember to sync.
// Match by string equality, not lang lookup, because state can carry
// whatever the conv was named at creation regardless of the current UI
// language.
export const PLACEHOLDER_TITLES: ReadonlySet<string> = buildPlaceholderTitles();

/** True when `title` is a placeholder default written at conversation
 * creation, i.e. the user hasn't named the chat yet. Locale-agnostic: it
 * recognises every default form the title generator can emit. */
export function isPlaceholderTitle(title: string | undefined | null): boolean {
  if (!title) return true;
  return PLACEHOLDER_TITLES.has(title);
}
