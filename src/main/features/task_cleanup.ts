/** Settings-only history maintenance. No model or application-SDK authority.
 * Metadata receipts freeze membership; deletion revalidates activity and
 * attachment revisions after backup. Recycle data retains task ownership.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as chats from './chats';
import * as recycle from './recycle_bin';
import { getProject } from './projects';
import { abort, isQuiescent } from './group_chat/bus';
import { flushBoards } from './group_chat/task_board';
import { hasPendingAttachmentsForCleanup } from './chat_attachments';
import { conversationLayout, conversationMessageReadFile, chatAttachmentDirForConversation } from '../util/project-layout';
import { indexedJsonlStamp } from '../util/indexed-jsonl';
import { safeId } from '../storage';

const PAGE_SIZE = 20;
const TTL = 30 * 60 * 1000;
interface Row {
  cid: string; title: string; activeAt: string; projectId: string | null;
  selectable: boolean; blocked?: 'busy' | 'unknown'; pinned: boolean; automation: boolean; draft: boolean;
}
interface ProjectRow {
  type: 'project'; projectId: string; title: string; total: number; selectableTotal: number;
}
interface Snapshot {
  token: string; expires: number; cutoff: number; rows: Row[]; entries: (Row | ProjectRow)[];
  projects: Map<string, Row[]>; selectableTotal: number;
  members: Map<string, Row>; remaining: Set<string>; busy: boolean;
  stopped: Map<string, { cutoff: number; revision: string }>;
}
const snapshots = new Map<string, Snapshot>();
const previewing = new Set<string>();
// Match the sidebar activity clock; metadata edits intentionally count.
function activity(c: chats.Conversation) { return Math.max(Date.parse(c.updated_at), Date.parse(c.created_at)); }
function eligible(c: chats.Conversation | null, cutoff: number): boolean {
  return !!c && c.kind === 'normal' && (!c.project_id || safeId(c.project_id))
    && !c.deleted_at && safeId(c.conversation_id) && Number.isFinite(activity(c)) && activity(c) < cutoff;
}
async function smallJson(filePath: string): Promise<any> {
  let file;
  try { file = await fs.open(filePath, 'r'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const size = (await file.stat()).size;
    if (size > 2 * 1024 * 1024) return null;
    const buffer = Buffer.alloc(size + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead === size ? JSON.parse(buffer.subarray(0, size).toString('utf8')) : null;
  } catch (error) { if (error instanceof SyntaxError) return null; throw error; }
  finally { await file.close(); }
}
async function inspect(uid: string, c: chats.Conversation, cutoff: number): Promise<Row | null> {
  const cid = c.conversation_id;
  const projectId = c.project_id || null;
  const layout = conversationLayout(uid, cid, projectId);
  if (layout.projectId !== projectId) return null;
  const [state, tasks] = await Promise.all([smallJson(layout.stateFile), smallJson(path.join(layout.groupDir, 'tasks.json'))]);
  let activeAt = activity(c);
  let blocked: Row['blocked'];
  let busy = false;
  const observeTime = (value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
    if (Number.isFinite(parsed)) activeAt = Math.max(activeAt, parsed); else blocked = 'unknown';
  };
  if (state === null || tasks === null || (tasks !== undefined && !Array.isArray(tasks))) blocked = 'unknown';
  if (state !== undefined && state !== null) {
    observeTime(state.last_active_at);
    if (!['idle', 'running', 'aborted'].includes(state.status) || !Array.isArray(state.in_flight)) blocked = 'unknown';
    else if (state.status === 'running' || state.in_flight.length) busy = true;
    if (state.orchestration_ledger && !['waiting_for_form', 'interrupted'].includes(state.orchestration_ledger.status)) busy = true;
  }
  if (Array.isArray(tasks)) for (const task of tasks) {
    if (!task || !['done', 'failed', 'stopped', 'cancelled', 'waiting_input', 'blocked', 'queued', 'running'].includes(task.status)) { blocked = 'unknown'; continue; }
    for (const key of ['created_at', 'updated_at', 'started_at', 'ended_at']) observeTime(task[key]);
    if (task.status === 'queued' || task.status === 'running') busy = true;
  }
  if (activeAt >= cutoff) return null;
  if (!blocked && (busy || !isQuiescent(uid, cid))) blocked = 'busy';
  return { cid, projectId, title: c.title.slice(0, 512), activeAt: new Date(activity(c)).toISOString(),
    selectable: blocked !== 'unknown', ...(blocked ? { blocked } : {}), pinned: !!c.pinned_at,
    automation: !!c.origin_auto_task_id, draft: await hasPendingAttachmentsForCleanup(uid, cid) };
}
async function executionRevision(uid: string, cid: string, projectId: string | null): Promise<string> {
  const layout = conversationLayout(uid, cid, projectId);
  return JSON.stringify(await Promise.all([layout.stateFile, path.join(layout.groupDir, 'tasks.json')].map(async file => {
    try {
      const stat = await fs.stat(file);
      return [stat.size, stat.mtimeMs, stat.ctimeMs];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  })));
}
// Compare bounded file metadata, not attachment contents. Existing draft files
// are allowed; a file added or edited while backing up invalidates this delete.
async function attachmentRevision(uid: string, cid: string): Promise<string> {
  const dir = chatAttachmentDirForConversation(uid, cid);
  let root;
  try { root = await fs.lstat(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '[]'; throw error; }
  if (!root.isDirectory()) throw new Error('cleanup_attachment_unknown');
  const stamps: unknown[] = [['', root.size, root.mtimeMs, root.ctimeMs]];
  const directories = [''];
  let count = 0;
  for (let cursor = 0; cursor < directories.length; cursor++) {
    const parent = directories[cursor];
    const names = (await fs.readdir(path.join(dir, parent))).sort();
    count += names.length;
    if (count > 10000) throw new Error('cleanup_attachment_limit');
    for (let i = 0; i < names.length; i += 8) {
      const children = await Promise.all(names.slice(i, i + 8).map(async name => {
        const relative = path.join(parent, name);
        const stat = await fs.lstat(path.join(dir, relative));
        if (!stat.isFile() && !stat.isDirectory()) throw new Error('cleanup_attachment_unknown');
        return { relative, stat };
      }));
      for (const { relative, stat } of children) {
        stamps.push([relative, stat.size, stat.mtimeMs, stat.ctimeMs]);
        if (stat.isDirectory()) directories.push(relative);
      }
    }
  }
  return JSON.stringify(stamps);
}
function snapshot(uid: string, token: string): Snapshot {
  const s = snapshots.get(uid);
  if (!s || s.token !== token || s.expires < Date.now()) throw new Error('cleanup_preview_expired');
  return s;
}
export async function preview(uid: string, args: { days: number; protectedIds?: string[]; draftIds?: string[] }) {
  // Accept the old input field for in-process compatibility, but annotations
  // no longer exclude explicitly selectable history.
  for (const ids of [args.protectedIds, args.draftIds]) {
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > 50000 || ids.some(id => typeof id !== 'string' || !safeId(id)))) throw new Error('invalid_cleanup_filter');
  }
  if (![7, 14, 30, 60, 90, 180].includes(args.days)) throw new Error('invalid_cleanup_filter');
  if (previewing.has(uid) || snapshots.get(uid)?.busy) throw new Error('cleanup_busy');
  previewing.add(uid);
  try {
    for (const [owner, s] of snapshots) if (!s.busy && s.expires < Date.now()) snapshots.delete(owner);
    const cutoff = Date.now() - args.days * 86400000;
    const draftIds = new Set(args.draftIds || []);
    const rows: Row[] = [];
    const candidates = (await chats.listCleanupConversationRows(uid)).filter(c => eligible(c, cutoff));
    if (candidates.length > 50000) throw new Error('cleanup_preview_too_large');
    for (let i = 0; i < candidates.length; i += 4) {
      await Promise.all(candidates.slice(i, i + 4).map(async c => {
        const row = await inspect(uid, c, cutoff);
        if (row) { row.draft ||= draftIds.has(row.cid); rows.push(row); }
      }));
    }
    rows.sort((a, b) => a.activeAt.localeCompare(b.activeAt) || a.cid.localeCompare(b.cid));
    const projects = new Map<string, Row[]>();
    for (const row of rows) if (row.projectId) {
      if (!projects.has(row.projectId)) projects.set(row.projectId, []);
      projects.get(row.projectId)!.push(row);
    }
    const projectRows: ProjectRow[] = [];
    const ids = [...projects.keys()];
    for (let i = 0; i < ids.length; i += 4) await Promise.all(ids.slice(i, i + 4).map(async projectId => {
      const project = await getProject(uid, projectId);
      const children = projects.get(projectId)!;
      projectRows.push({ type: 'project', projectId, title: project?.name || projectId,
        total: children.length, selectableTotal: children.filter(row => row.selectable).length });
    }));
    projectRows.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }) || a.projectId.localeCompare(b.projectId));
    const entries = [...projectRows, ...rows.filter(row => !row.projectId)];
    const s: Snapshot = { token: randomUUID(), expires: Date.now() + TTL, cutoff, rows, entries, projects,
      selectableTotal: rows.filter(row => row.selectable).length,
      members: new Map(rows.map(row => [row.cid, row])), remaining: new Set(rows.map(row => row.cid)), busy: false, stopped: new Map() };
    snapshots.set(uid, s);
    return { token: s.token, ...page(uid, s.token, 0), entries: entries.slice(0, PAGE_SIZE),
      treeTotal: entries.length, treeNextOffset: entries.length > PAGE_SIZE ? PAGE_SIZE : null };
  } finally { previewing.delete(uid); }
}
export function page(uid: string, token: string, offset: number, scope: { tree?: boolean; projectId?: string } = {}) {
  const s = snapshot(uid, token);
  if (scope.tree !== undefined && typeof scope.tree !== 'boolean') throw new Error('invalid_cleanup_page');
  if (scope.projectId !== undefined && (!safeId(scope.projectId) || !s.projects.has(scope.projectId) || scope.tree)) throw new Error('invalid_cleanup_page');
  const source = scope.tree ? s.entries : scope.projectId ? s.projects.get(scope.projectId)! : s.rows;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length) throw new Error('invalid_cleanup_page');
  const portion = source.slice(offset, offset + PAGE_SIZE);
  return { total: s.rows.length, selectableTotal: s.selectableTotal, listTotal: source.length,
    rows: scope.tree ? [] : portion as Row[], entries: scope.tree ? portion : [],
    offset, nextOffset: offset + portion.length < source.length ? offset + portion.length : null };
}
export async function remove(uid: string, token: string, cid: string) {
  const s = snapshot(uid, token);
  if (s.busy) throw new Error('cleanup_busy');
  const original = s.members.get(cid);
  if (!original) throw new Error('invalid_cleanup_selection');
  if (!original.selectable || !s.remaining.has(cid)) return { status: 'skipped' as const };
  const projectId = original.projectId;
  s.busy = true;
  try {
    let cutoff = s.stopped.get(cid)?.cutoff ?? s.cutoff;
    let current = await chats.getConversationMetadata(uid, cid, projectId);
    const row = eligible(current, cutoff) && (current!.project_id || null) === projectId
      ? await inspect(uid, current!, cutoff) : null;
    if (!row?.selectable) {
      s.remaining.delete(cid); return { status: 'skipped' as const };
    }
    if (row.blocked === 'busy' && !s.stopped.has(cid)) {
      await abort(uid, cid);
      if (!isQuiescent(uid, cid)) throw new Error('cleanup_stop_failed');
      // Stop writes current activity timestamps. Keep that boundary for backup
      // retries, but never accept later execution writes or another live run.
      cutoff = Date.now() + 1;
      // Stop's task-board terminal is coalesced asynchronously. Settle only
      // this conversation before freezing the file revision; keep the activity
      // cutoff at Stop completion so waiting does not admit later work.
      await flushBoards({ uid, cid });
      s.stopped.set(cid, { cutoff, revision: await executionRevision(uid, cid, projectId) });
    }
    const canDelete = async (candidate: chats.Conversation | null) => {
      if (!eligible(candidate, cutoff) || (candidate!.project_id || null) !== projectId || !isQuiescent(uid, cid)) return false;
      const checked = await inspect(uid, candidate!, cutoff);
      if (!checked?.selectable) return false;
      const stopped = s.stopped.get(cid);
      // An old queued/running disk record can outlive its process. Only the
      // explicit, completed Stop above permits deleting that unchanged record.
      return stopped ? stopped.revision === await executionRevision(uid, cid, projectId) : !checked.blocked;
    };
    current = await chats.getConversationMetadata(uid, cid, projectId);
    if (!await canDelete(current)) { s.remaining.delete(cid); return { status: 'skipped' as const }; }
    const metadataTime = current!.updated_at;
    const historyFile = conversationMessageReadFile(uid, cid, projectId);
    const historyRevision = await indexedJsonlStamp(historyFile);
    const revision = await attachmentRevision(uid, cid);
    const batch = await recycle.createAppRecycleBatchForConversation(uid, cid);
    if (!batch?.items?.length) throw new Error('recycle_archive_failed');
    const removed = await chats.deleteConversation(uid, cid, projectId, async current =>
      current.updated_at === metadataTime && await canDelete(current)
      && historyRevision === await indexedJsonlStamp(historyFile)
      && revision === await attachmentRevision(uid, cid) && isQuiescent(uid, cid));
    s.remaining.delete(cid);
    if (!removed) await recycle.deleteRecycleBatch(uid, batch.id);
    s.expires = Date.now() + TTL;
    return { status: removed ? 'deleted' as const : 'skipped' as const };
  } catch (_) { throw new Error('cleanup_failed'); }
  finally { s.busy = false; }
}
