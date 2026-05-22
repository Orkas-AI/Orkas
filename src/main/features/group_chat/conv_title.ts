// Placeholder conversation-title helpers shared by group-chat modules.
// Keep this file dependency-free so `chats.ts` can import group_chat facade
// without entering the conv_workspace -> chats cycle.

// Match the literal default titles `chats.createConversation` writes when
// no title is supplied (currently `t('chat.default_title')` resolved at
// creation time per UI language) AND any historical / capitalization
// variant. Match by string equality, not
// lang lookup, because state can carry whatever the conv was named at
// creation regardless of the current UI language.
export const PLACEHOLDER_TITLES: ReadonlySet<string> = new Set([
  '新对话',
  'New conversation',
  'New Conversation',
  'New chat',
  'New Chat',
]);

/** True when `title` is a placeholder default written at conversation
 * creation, i.e. the user hasn't named the chat yet. Locale-agnostic: it
 * recognises every default form the title generator can emit. */
export function isPlaceholderTitle(title: string | undefined | null): boolean {
  if (!title) return true;
  return PLACEHOLDER_TITLES.has(title);
}
