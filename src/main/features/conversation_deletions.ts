/** Durable deletion evidence lives atomically with the existing conversation
 * tombstone. No second outbox or per-file index reads on the sync hot path. */
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { userCloudRoot, userProjectsDir } from '../paths';
import { safeId } from '../storage';
import { isSafeCloudRelPath, resolveCloudRelPath } from '../util/cloud-path';

export interface TaskDeletion {
  cid: string;
  projectId: string | null;
  deletedAt: string;
  revision?: number;
  files?: Record<string, string>;
  indexPath?: string;
}
export type TaskDeletions = Map<string, TaskDeletion>;
export type TaskOwnership = TaskDeletions;
export type TaskIdentity = Pick<TaskDeletion, 'cid' | 'projectId' | 'revision'>;
const key = (pid: string | null, cid: string) => `${pid || ''}/${cid}`;
// The desktop has both CJS and ESM callers; share invalidation across them.
const registry = globalThis as typeof globalThis & { __orkasTaskDeletions?: Map<string, Promise<TaskDeletions>> };
const caches = registry.__orkasTaskDeletions ||= new Map<string, Promise<TaskDeletions>>();
const cacheKey = (uid: string) => userCloudRoot(uid);
export const isTaskIndexPath = (rel: string) => /^cloud\/(?:projects\/[^/]+\/)?chats\/_index\.json$/.test(rel);
export function invalidateTaskDeletions(uid: string): void { caches.delete(cacheKey(uid)); }

/** Exact ownership, including hyphenated ids and session sidecars. Never match
 * project metadata, saved apps, indexes, or a neighboring task's prefix. */
export function taskForPath(deletions: TaskDeletions, rel: string): TaskDeletion | undefined {
  if (!isSafeCloudRelPath(rel)) return;
  const parts = rel.split('/');
  const pid = parts[1] === 'projects' ? parts[2] : null;
  const rest = parts.slice(pid ? 3 : 1);
  const [domain, name] = rest;
  if (domain === 'chats' || domain === 'chat_attachments' || domain === 'chat_artifacts') {
    const cid = domain === 'chats' && rest.length === 2 && name?.endsWith('.jsonl') ? name.slice(0, -6) : name;
    return safeId(cid) ? deletions.get(key(pid, cid)) : undefined;
  }
  if (domain !== 'sessions' || !name) return;
  if (name.startsWith('gconv-')) {
    const cid = name.slice(6).split('.')[0];
    if (/^\.(?:jsonl(?:\.context\.json)?|tool-results)$/.test(name.slice(6 + cid.length))) return deletions.get(key(pid, cid));
  }
  if (name.startsWith('gmember-')) {
    const stem = name.slice(8).split('.')[0];
    if (!/\.(?:jsonl(?:\.context\.json)?|tool-results)$/.test(name)) return;
    for (let at = stem.lastIndexOf('-'); at > 0; at = stem.lastIndexOf('-', at - 1)) {
      const match = deletions.get(key(pid, stem.slice(0, at)));
      if (match) return match;
    }
  }
}
export function deletionForPath(deletions: TaskDeletions, rel: string): TaskDeletion | undefined {
  const task = taskForPath(deletions, rel);
  return task?.deletedAt ? task : undefined;
}

// Explicit archived/deleted ownership may span the pre-v4 global layout too.
// Foreign projects and other task ids never enter this lookup.
function ownershipLocations(task: TaskDeletion): TaskDeletions {
  return new Map([[key(task.projectId, task.cid), task], [key(null, task.cid), task]]);
}
export function normalizeDeletedFiles(raw: unknown, deletion: TaskDeletion): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const own = ownershipLocations(deletion);
  const files: Record<string, string> = {};
  for (const [rel, sha] of Object.entries(raw)) {
    if (typeof sha === 'string' && /^[a-f0-9]{64}$/.test(sha) && taskForPath(own, rel)) files[rel] = sha;
  }
  return files;
}
async function readDeletions(uid: string, projectIds?: string[]): Promise<TaskDeletions> {
  const out: TaskDeletions = new Map();
  let projects: string[] = projectIds || [];
  if (!projectIds) {
    try { projects = (await fsp.readdir(userProjectsDir(uid), { withFileTypes: true })).filter(e => e.isDirectory() && safeId(e.name)).map(e => e.name); }
    catch (err: any) { if (err.code !== 'ENOENT') throw err; }
  }
  for (const pid of [null, ...projects]) {
    // A received index can precede project.json in the same sync pass.
    const index = pid ? 'cloud/projects/' + pid + '/chats/_index.json' : 'cloud/chats/_index.json';
    let rows: any;
    try { rows = JSON.parse(await fsp.readFile(resolveCloudRelPath(userCloudRoot(uid), index), 'utf8')); }
    catch (err: any) { if (err.code === 'ENOENT') continue; throw err; }
    if (!Array.isArray(rows)) rows = rows?.items;
    if (!Array.isArray(rows)) throw new Error('invalid conversation index');
    for (const row of rows) {
      if (!safeId(row?.conversation_id)) continue;
      const d: TaskDeletion = { cid: row.conversation_id, projectId: pid || (safeId(row.project_id) ? row.project_id : null),
        indexPath: index,
        deletedAt: typeof row.deleted_at === 'string' && Number.isFinite(Date.parse(row.deleted_at)) ? row.deleted_at : '',
        revision: Number(row._sync_rev) || 0 };
      d.files = normalizeDeletedFiles(row._sync_deleted_files, d);
      out.set(key(pid, d.cid), d);
    }
  }
  // A project tombstone's exact captured global paths are durable legacy
  // aliases. Keep current independent global tasks authoritative on collision.
  for (const task of [...out.values()]) {
    if (!task.projectId) continue;
    const projectKey = key(task.projectId, task.cid);
    const projectTask = out.get(projectKey);
    if (!projectTask || (task.revision || 0) > (projectTask.revision || 0)) out.set(projectKey, task);
    const globalKey = key(null, task.cid), current = out.get(globalKey);
    if (current?.projectId === task.projectId && (task.revision || 0) >= (current.revision || 0)) out.set(globalKey, task);
    else if (!current && Object.keys(task.files || {}).some(rel => !rel.startsWith('cloud/projects/') && taskForPath(ownershipLocations(task), rel))) out.set(globalKey, task);
  }
  return out;
}
export async function taskDeletions(uid: string): Promise<TaskDeletions> {
  const k = cacheKey(uid);
  for (;;) {
    let pending = caches.get(k);
    if (!pending) { pending = readDeletions(uid); caches.set(k, pending); }
    try {
      const snapshot = await pending;
      if (caches.get(k) === pending) return snapshot;
    } catch (err) { if (caches.get(k) === pending) caches.delete(k); throw err; }
  }
}
export async function taskDeletionForPath(uid: string, rel: string) {
  return deletionForPath(await taskDeletions(uid), rel);
}

export interface ConversationFileInventory { files: string[]; roots: string[] }

/** Inventory physical ownership once for backup, deletion and sync receipts.
 * Keep both layouts, context sidecars and retained outputs; never follow links
 * or use a broad member-session prefix that could consume another task. */
export async function conversationFileInventory(uid: string, cid: string, pid: string | null, ownership?: TaskDeletions): Promise<ConversationFileInventory> {
  if (!safeId(cid) || (pid !== null && !safeId(pid))) throw new Error('invalid conversation identity');
  // Ordinary project deletion reads its own compact catalog and the legacy
  // global catalog, rather than scanning every project once per child.
  const all = ownership ? new Map(ownership) : await readDeletions(uid, pid ? [pid] : []);
  if (ownership && pid) for (const [key, owner] of await readDeletions(uid, [])) all.set(key, owner);
  const lookup: TaskDeletions = new Map(all);
  const task = lookup.get(key(pid, cid)) || { cid, projectId: pid, deletedAt: '' };
  let legacy = !!pid && (!lookup.has(key(null, cid)) || lookup.get(key(null, cid))!.projectId === pid);
  const root = userCloudRoot(uid);
  if (legacy && !lookup.has(key(null, cid))) {
    try {
      const meta = JSON.parse(await fsp.readFile(resolveCloudRelPath(root, `cloud/chats/${cid}/meta.json`), 'utf8'));
      if (meta.project_id && meta.project_id !== pid) legacy = false;
    } catch (err: any) { if (err.code !== 'ENOENT') throw err; }
  }
  // Populate legacy session identities for longest-id disambiguation. Existing
  // explicit global ownership always wins over a project's old location.
  const addSessionOwners = (owners: TaskDeletions) => {
    for (const owner of owners.values()) if (!lookup.has(key(null, owner.cid))) lookup.set(key(null, owner.cid), owner);
  };
  addSessionOwners(all);
  if (legacy) lookup.set(key(null, cid), task);
  const prefixes = [pid ? `cloud/projects/${pid}` : 'cloud', ...(legacy ? ['cloud'] : [])];
  const files: string[] = [], roots: string[] = [];
  async function visit(rel: string, top = false): Promise<void> {
    const file = resolveCloudRelPath(root, rel);
    let st: fs.Stats;
    try { st = await fsp.lstat(file); } catch (err: any) { if (err.code === 'ENOENT') return; throw err; }
    if (st.isSymbolicLink()) throw new Error('unsafe conversation file');
    if (top) roots.push(rel);
    if (st.isDirectory()) for (const name of await fsp.readdir(file)) await visit(`${rel}/${name}`);
    else if (st.isFile()) files.push(rel);
  }
  for (const prefix of prefixes) {
    for (const rel of [`${prefix}/chats/${cid}.jsonl`, `${prefix}/chats/${cid}`, `${prefix}/chat_attachments/${cid}`, `${prefix}/chat_artifacts/${cid}`]) await visit(rel, true);
    let names: string[];
    try { names = await fsp.readdir(resolveCloudRelPath(root, `${prefix}/sessions`)); }
    catch (err: any) { if (err.code !== 'ENOENT') throw err; names = []; }
    for (const name of names) {
      const rel = `${prefix}/sessions/${name}`;
      // Only an actual legacy member session needs cross-project longest-id
      // disambiguation; do not pay for a full catalog on the common path.
      if (prefix === 'cloud' && name.startsWith(`gmember-${cid}-`) && taskForPath(lookup, rel)?.cid === cid) addSessionOwners(await taskDeletions(uid));
      if (taskForPath(lookup, rel)?.cid === cid) await visit(rel, true);
    }
  }
  return { files, roots };
}

