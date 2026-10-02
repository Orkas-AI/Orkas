/** Ephemeral Host evidence for cleanup of a draft created by this task. Provider
 * names, argument hints and draft ids supplied by a model are not ownership. */
export interface DraftScope {
  uid: string;
  cid: string;
  connectorId: string;
  accountKey: string;
}
const drafts = new Map<string, DraftScope>();
function key(scope: DraftScope, id: string): string {
  return JSON.stringify([scope.uid, scope.cid, scope.connectorId, scope.accountKey, id]);
}
export function clearTaskCreatedDrafts(matches: (scope: DraftScope) => boolean): void {
  for (const [id, scope] of drafts) if (matches(scope)) drafts.delete(id);
}
export function isTaskCreatedDraft(scope: DraftScope | undefined, id: unknown): boolean {
  return !!scope?.uid && !!scope.cid && typeof id === 'string' && drafts.has(key(scope, id));
}
export function observeTaskDraftResult(scope: DraftScope | undefined, action: string, args: Record<string, unknown>, raw: unknown): void {
  if (!scope?.uid || !scope.cid || !['gmail', 'google-workspace'].includes(scope.connectorId)) return;
  if (!raw || typeof raw !== 'object' || (raw as { isError?: unknown }).isError === true) return;
  const content = (raw as { content?: unknown }).content;
  if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text'
    || typeof content[0].text !== 'string' || content[0].text.length > 4_096) return;
  try {
    const value = JSON.parse(content[0].text);
    if (action === 'delete_draft' && value?.ok === true && typeof args.id === 'string') drafts.delete(key(scope, args.id));
    if (action !== 'create_draft' || typeof value?.id !== 'string' || !value.id || value.id.length > 256
      || typeof value.messageId !== 'string' || !value.messageId) return;
    // Bounded per-host memory; eviction only restores confirmation.
    if (drafts.size >= 256) drafts.delete(drafts.keys().next().value!);
    drafts.set(key(scope, value.id), scope);
  } catch { /* Unknown response shapes provide no evidence. */ }
}
