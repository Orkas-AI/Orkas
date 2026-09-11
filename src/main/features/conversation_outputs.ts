/**
 * Everything one conversation produced, as a single list for the info panel.
 *
 * The panel used to be a plain scan of the conversation workspace directory,
 * with the renderer merging chip-tracked paths from history on top. That left
 * two structural gaps and one misleading presentation:
 *
 *   - A `create_artifact` interactive app lives in `cloud/chat_artifacts/<cid>/`,
 *     never under the workspace, so it appeared in no listing at all. Scroll
 *     past the bubble that created it and it could not be found again.
 *   - A produced file outside the conversation workspace (an absolute path into
 *     the user's own tree, the attachment pool, a sibling directory) has no
 *     relative path under the scan root, so the renderer hung it off the tree
 *     root as a bare basename — visually indistinguishable from a file that
 *     really is in the workspace.
 *   - Membership rules lived in the renderer, where they could drift from what
 *     the main process actually knows.
 *
 * So the merge happens here, once, and each entry carries the `origin` that
 * decides how it opens: a workspace/outside file goes to the file viewer, an
 * artifact goes to the `chat-app://` frame. `origin` exists for that reason
 * alone — it is not a taxonomy.
 *
 * The disk scan stays the source of truth for files. `bash` and external CLI
 * agents write without announcing paths, so nothing else can see them; history
 * only adds what the scan structurally cannot reach.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { readState as readGroupChatState } from './group_chat/state';
import * as chatArtifacts from './chat_artifacts';
import type { ArtifactSummary } from './chat_artifacts';
import { listWorkspaceFiles } from './conversation_files';
import type { ConversationWorkspaceFileList } from './conversation_files';
import * as chats from './chats';
import * as userWorkspace from './user_workspace';

const log = createLogger('conversation_outputs');

export type ConversationOutputOrigin = 'workspace' | 'artifact' | 'outside';

export interface ConversationOutput {
  origin: ConversationOutputOrigin;
  name: string;
  /** POSIX path under the scan root. Empty for artifacts and outside files —
   *  the renderer uses that emptiness to keep them out of the workspace tree. */
  relPath: string;
  /** Absolute path. Absent for artifacts, which are directory bundles. */
  path?: string;
  artifactId?: string;
  /** Artifact title from `__orkas-meta.json`; empty when unavailable. */
  title?: string;
  /** Producing actor of an artifact. The viewer routes a user→artifact
   *  interaction result back to it, so opening one from the panel has to carry
   *  the same target the bubble's own frame does. */
  agentId?: string;
  bytes: number;
  mtime: number;
}

export interface ConversationOutputList {
  root: string;
  rootExists: boolean;
  items: ConversationOutput[];
  count: number;
  truncated: boolean;
  scanSkipped?: boolean;
  skipReason?: string;
}

export interface ProducedFileStat {
  bytes: number;
  mtime: number;
}

/** How many history-recorded paths may be added on top of the disk scan.
 *  History is already bounded by the caller's message limit; this bounds the
 *  pathological case where one conversation recorded thousands of paths. */
export const MAX_HISTORY_OUTPUTS = 200;

function toPosix(input: string): string {
  return String(input || '').split(path.sep).filter(Boolean).join('/');
}

function isUnder(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return !!rel
    && rel !== '..'
    && !rel.startsWith(`..${path.sep}`)
    && !path.isAbsolute(rel);
}

/**
 * Merge a workspace scan, the artifact pool, and history-recorded produced
 * paths into one list.
 *
 * `statProducedFile` returns null for a path that is gone, so a file the model
 * wrote and later deleted stops being listed. It is injected rather than called
 * directly so this stays a pure function over a controllable filesystem.
 */
export function mergeConversationOutputs(input: {
  workspace: ConversationWorkspaceFileList;
  artifacts: readonly ArtifactSummary[];
  producedPaths: Iterable<string>;
  statProducedFile: (absPath: string) => ProducedFileStat | null;
}): ConversationOutputList {
  const { workspace, artifacts, producedPaths, statProducedFile } = input;
  const root = path.resolve(workspace.root || '');
  const items: ConversationOutput[] = [];
  const seen = new Set<string>();

  for (const file of workspace.items) {
    const abs = path.resolve(file.path);
    seen.add(abs);
    items.push({
      origin: 'workspace',
      name: file.name,
      relPath: file.relPath,
      path: abs,
      bytes: file.bytes,
      mtime: file.mtime,
    });
  }

  for (const artifact of artifacts) {
    items.push({
      origin: 'artifact',
      name: artifact.title || artifact.artifactId,
      relPath: '',
      artifactId: artifact.artifactId,
      title: artifact.title,
      agentId: artifact.agentId,
      bytes: artifact.bytes,
      mtime: artifact.mtime,
    });
  }

  let truncated = workspace.truncated === true;
  let added = 0;
  for (const raw of producedPaths) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) continue;
    const abs = path.resolve(value);
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (added >= MAX_HISTORY_OUTPUTS) {
      truncated = true;
      continue;
    }
    const stat = statProducedFile(abs);
    if (!stat) continue;
    added += 1;
    // Under the scan root but missing from the scan: a dot-prefixed file or
    // directory the walker skips, or a scan that hit its own cap. It still
    // belongs in the workspace tree.
    const inWorkspace = !!root && isUnder(root, abs);
    items.push({
      origin: inWorkspace ? 'workspace' : 'outside',
      name: path.basename(abs),
      relPath: inWorkspace ? toPosix(path.relative(root, abs)) : '',
      path: abs,
      bytes: stat.bytes,
      mtime: stat.mtime,
    });
  }

  return {
    root: workspace.root,
    rootExists: workspace.rootExists,
    items,
    count: items.length,
    truncated,
    ...(workspace.scanSkipped ? { scanSkipped: true } : {}),
    ...(workspace.skipReason ? { skipReason: workspace.skipReason } : {}),
  };
}

/** History depth the produced-path merge reads. Matches the ceiling
 *  `conversations.history` serves the panel, so this listing never claims a
 *  file the panel's own history could not have shown — and never exceeds the
 *  window `ipc/index.ts::_isConversationRecordedFile` uses to authorize opening
 *  a path outside the sandbox roots. */
const PRODUCED_HISTORY_LIMIT = 500;

function statRegularFile(absPath: string): ProducedFileStat | null {
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return null;
    return { bytes: st.size, mtime: Math.floor(st.mtimeMs) };
  } catch {
    return null;
  }
}

/** Resolve the directory this conversation's own file output is scanned from.
 *  A conversation that has run a turn has a frozen `workspace_dir`; one that
 *  has not falls back to the workspace root, which is also where conversations
 *  predating that field genuinely wrote. */
async function conversationScanRoot(userId: string, cid: string): Promise<string> {
  const projectId = await userWorkspace.resolveProjectIdForCid(userId, cid);
  const workspaceRoot = userWorkspace.getWorkspacePath(userId, projectId);
  const state = await readGroupChatState(userId, cid);
  return state.workspace_dir ? path.join(workspaceRoot, state.workspace_dir) : workspaceRoot;
}

/** Everything this conversation produced: the workspace scan, its artifact
 *  bundles, and the history-recorded paths the scan structurally cannot see. */
export async function listConversationOutputs(
  userId: string,
  cid: string,
): Promise<ConversationOutputList> {
  const root = await conversationScanRoot(userId, cid);
  const workspace = listWorkspaceFiles(root);

  let artifacts: ArtifactSummary[] = [];
  try { artifacts = chatArtifacts.listArtifacts(userId, cid); }
  catch (err) {
    // An unreadable artifact pool must not blank the file list.
    log.warn('artifact listing failed', { error: (err as Error).message });
  }

  let producedPaths: string[] = [];
  try {
    producedPaths = await chats.listProducedPaths(userId, cid, PRODUCED_HISTORY_LIMIT);
  } catch (err) {
    log.warn('produced-path history read failed', { error: (err as Error).message });
  }

  return mergeConversationOutputs({
    workspace,
    artifacts,
    producedPaths,
    statProducedFile: statRegularFile,
  });
}
