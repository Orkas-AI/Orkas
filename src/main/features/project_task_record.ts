/** Shared compatibility reader for private task imports and local task reads. */
import * as path from 'node:path';
import { nowIso } from '../storage';
import { taskContent } from '../util/project-task-content';
import type { ProjectTask, TaskStatus } from './project_tasks';

export const TASK_RESULT_REF_MAX = 400;
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'progress', 'review', 'done'];
const TASK_ID_RE = /^t_[a-f0-9]{12}$/;

export function clampStr(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

/** Coerce a persisted (possibly hand-edited / synced / older-shape) record into
 *  a valid ProjectTask, or null if unusable. Never throws on bad input. */
export function normaliseTask(raw: any): ProjectTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!TASK_ID_RE.test(id)) return null;
  const content = taskContent(raw);
  if (!content) return null;
  // Older names retain their stage; retired blocked/cancelled tasks reopen as
  // todo. Reads preserve the source file; an ordinary edit persists the mapping.
  const storedStatus = raw.status === 'in_progress' ? 'progress'
    : raw.status === 'in_review' ? 'review' : raw.status;
  const status: TaskStatus = TASK_STATUSES.includes(storedStatus) ? storedStatus : 'todo';
  const now = nowIso();
  const t: ProjectTask = {
    id,
    content,
    status,
    created_by: typeof raw.created_by === 'string' && raw.created_by ? raw.created_by : 'user',
    created_at: typeof raw.created_at === 'string' ? raw.created_at : now,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : now,
  };
  const owner = clampStr(raw.owner_agent, 200);
  if (owner) t.owner_agent = owner;
  if (typeof raw.owner_agent_id === 'string' && raw.owner_agent_id) t.owner_agent_id = raw.owner_agent_id;
  if (Array.isArray(raw.depends_on)) {
    const depCandidates: string[] = raw.depends_on.filter(
      (d: unknown): d is string => typeof d === 'string' && TASK_ID_RE.test(d),
    );
    const deps = [...new Set(depCandidates)];
    if (deps.length) t.depends_on = deps;
  }
  const resultRef = clampStr(raw.result_ref, TASK_RESULT_REF_MAX);
  if (resultRef) t.result_ref = resultRef;
  if (typeof raw.origin_cid === 'string' && raw.origin_cid) t.origin_cid = raw.origin_cid;
  if (Array.isArray(raw.attachments)) {
    const names = [...new Set(
      raw.attachments.map((n: unknown) => sanitiseTaskAttachmentName(n)).filter((n: string): n is string => !!n),
    )] as string[];
    if (names.length) t.attachments = names;
  }
  if (status === 'done' && typeof raw.done_at === 'string' && raw.done_at) t.done_at = raw.done_at;
  return t;
}

// Attachment names cross OS boundaries via IPC and cloud-synced task JSON. Treat
// both separator styles as directory boundaries, take the basename, and reject
// traversal / dotfiles — host-independent, mirroring auto_tasks._sanitiseFilename.
export function sanitiseTaskAttachmentName(name: unknown): string {
  if (typeof name !== 'string') return '';
  const base = path.posix.basename(name.replace(/\\/g, '/')).trim();
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return '';
  return base.length > 200 ? base.slice(0, 200) : base;
}
