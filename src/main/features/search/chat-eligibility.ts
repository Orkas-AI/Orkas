import { taskDeletions } from '../conversation_deletions';
import type { ConversationDisplayRow } from '../chats';
import { listProjectIds } from '../../util/project-layout';
import { createLogger } from '../../logger';

const log = createLogger('search');

/** Search and rebuild share lifecycle eligibility. Old project transcripts can
 * remain in the global root after their project disappears. The deletion owner
 * also reads orphan project indexes, which the visible chat catalog omits.
 * This only controls derived search data; it never deletes source history. */
export async function chatEligibility(
  userId: string,
  rows: readonly ConversationDisplayRow[],
  projectIds: ReadonlySet<string> = new Set(listProjectIds(userId)),
): Promise<{ excluded: Set<string>; complete: boolean }> {
  const excluded = new Set<string>();
  const live = new Set<string>();
  for (const row of rows) {
    if (row.deleted || (row.project_id && !projectIds.has(row.project_id))) excluded.add(row.conversation_id);
    else live.add(row.conversation_id);
  }
  try {
    for (const owner of (await taskDeletions(userId)).values()) {
      // A current global/project row wins over an old location's remaining
      // index after a move. Unknown legacy global histories stay supported.
      if (owner.projectId && !projectIds.has(owner.projectId) && !live.has(owner.cid)) excluded.add(owner.cid);
    }
    return { excluded, complete: true };
  } catch {
    // Preserve healthy results and never certify unknown ownership as complete.
    log.warn('chat ownership catalog unavailable; coverage incomplete');
    return { excluded, complete: false };
  }
}
