/**
 * Projects — logical groups of conversations + a scoped workspace.
 *
 * A project is a thin index-only construct: just `{project_id, name, created_at,
 * updated_at}`. Conversation membership is a `project_id` field on the conv
 * index entry (`features/chats.ts::Conversation`), not a path component —
 * `<cid>.jsonl` / `groupChatDir` / `session_id = <uid>-gconv-<cid>` stay verbatim
 * (CLAUDE.md §5 isolation invariant).
 *
 * Storage: `<uid>/cloud/projects/_index.json` (cloud-synced; the project record
 * is logical and small). Per-project workspace selection lives in
 * `<uid>/local/workspace.json::projects[pid]` since absolute paths are
 * machine-specific (CLAUDE.md §4 sync-domain split).
 *
 * Future per-project assets (knowledge base, access permissions) will land
 * under `<uid>/cloud/projects/<pid>/` — `paths.projectDir` reserves the slot
 * but no writes happen yet.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { userProjectsDir, userProjectsIndexFile } from '../paths';
import { nowIso, readJson, writeJson } from '../storage';
import { createLogger } from '../logger';
import * as chats from './chats';
import { readState } from './group_chat/state';
import { purgeProjectWorkspace } from './user_workspace';

const log = createLogger('projects');

export interface Project {
  project_id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** UI-extended project record: index entry + derived counts. */
export interface ProjectWithStats extends Project {
  conv_count: number;
}

// ── id helper ─────────────────────────────────────────────────────────────

function genProjectId(): string {
  return 'p_' + crypto.randomBytes(6).toString('hex');
}

// ── index IO ──────────────────────────────────────────────────────────────

function ensureProjectsDir(uid: string): string {
  const d = userProjectsDir(uid);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function readIndex(uid: string): Promise<Project[]> {
  ensureProjectsDir(uid);
  const f = userProjectsIndexFile(uid);
  if (!fs.existsSync(f)) return [];
  const data: any = await readJson(f);
  if (Array.isArray(data)) return data as Project[];
  if (data && Array.isArray(data.items)) return data.items as Project[];
  return [];
}

async function writeIndex(uid: string, items: Project[]): Promise<void> {
  await writeJson(userProjectsIndexFile(uid), items);
}

// ── Validation ────────────────────────────────────────────────────────────

const NAME_MAX_LEN = 60;

/** Trim + length cap. Returns null if the input is unusable. */
function normName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  if (s.length > NAME_MAX_LEN) return s.slice(0, NAME_MAX_LEN);
  return s;
}

function isDuplicateName(items: Project[], name: string, excludePid?: string): boolean {
  const lower = name.toLocaleLowerCase();
  for (const p of items) {
    if (excludePid && p.project_id === excludePid) continue;
    if ((p.name || '').toLocaleLowerCase() === lower) return true;
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────

/** List projects with derived `conv_count`. Reads chats index once and groups. */
export async function listProjects(uid: string): Promise<ProjectWithStats[]> {
  const projects = await readIndex(uid);
  if (!projects.length) return [];
  const convs = await chats.listConversations(uid).catch(() => []);
  const counts = new Map<string, number>();
  for (const c of convs) {
    const pid = (c as any).project_id;
    if (!pid) continue;
    counts.set(pid, (counts.get(pid) || 0) + 1);
  }
  return projects.map((p) => ({ ...p, conv_count: counts.get(p.project_id) || 0 }));
}

/** Resolve a single project by id (no stats). */
export async function getProject(uid: string, projectId: string): Promise<Project | null> {
  const items = await readIndex(uid);
  return items.find((p) => p.project_id === projectId) || null;
}

export type ProjectError = 'name_empty' | 'name_dup' | 'not_found' | 'has_running_conv';

export async function createProject(
  uid: string,
  rawName: string,
): Promise<{ ok: true; project: Project } | { ok: false; error: ProjectError }> {
  const name = normName(rawName);
  if (!name) return { ok: false, error: 'name_empty' };
  const items = await readIndex(uid);
  if (isDuplicateName(items, name)) return { ok: false, error: 'name_dup' };
  const now = nowIso();
  const project: Project = {
    project_id: genProjectId(),
    name,
    created_at: now,
    updated_at: now,
  };
  items.unshift(project);
  await writeIndex(uid, items);
  log.info(`created user=${uid} pid=${project.project_id} name="${name}"`);
  return { ok: true, project };
}

export async function renameProject(
  uid: string,
  projectId: string,
  rawName: string,
): Promise<{ ok: true; project: Project } | { ok: false; error: ProjectError }> {
  const name = normName(rawName);
  if (!name) return { ok: false, error: 'name_empty' };
  const items = await readIndex(uid);
  const i = items.findIndex((p) => p.project_id === projectId);
  if (i < 0) return { ok: false, error: 'not_found' };
  if (isDuplicateName(items, name, projectId)) return { ok: false, error: 'name_dup' };
  if (items[i].name === name) {
    return { ok: true, project: items[i] };  // no-op
  }
  items[i] = { ...items[i], name, updated_at: nowIso() };
  await writeIndex(uid, items);
  log.info(`renamed user=${uid} pid=${projectId} name="${name}"`);
  return { ok: true, project: items[i] };
}

/** Cascade-delete: every conversation under this project is dropped (full
 *  per-conv cascade — `<cid>.jsonl` / sessions / attachments / search idx /
 *  group dir / cli sessions), then the project record itself.
 *
 *  Aborts upfront if any conv is currently `running` (state.json::status). The
 *  user must stop the in-flight turn first; we do not silently abort. */
export async function deleteProject(
  uid: string,
  projectId: string,
): Promise<{ ok: true; deleted_convs: number } | { ok: false; error: ProjectError }> {
  const items = await readIndex(uid);
  const i = items.findIndex((p) => p.project_id === projectId);
  if (i < 0) return { ok: false, error: 'not_found' };

  const allConvs = await chats.listConversations(uid).catch(() => []);
  const owned = allConvs.filter((c) => (c as any).project_id === projectId);

  // Running-conv guard: refuse if any conv has a live turn.
  for (const c of owned) {
    try {
      const s = await readState(uid, c.conversation_id);
      if (s.status === 'running') {
        log.info(`refused delete user=${uid} pid=${projectId} reason=running cid=${c.conversation_id}`);
        return { ok: false, error: 'has_running_conv' };
      }
    } catch { /* missing state file = idle */ }
  }

  let deletedConvs = 0;
  for (const c of owned) {
    try {
      if (await chats.deleteConversation(uid, c.conversation_id)) deletedConvs++;
    } catch (err) {
      log.warn(`cascade del user=${uid} pid=${projectId} cid=${c.conversation_id}: ${(err as Error).message}`);
    }
  }

  // Drop the project record itself.
  items.splice(i, 1);
  await writeIndex(uid, items);

  // Drop the per-project workspace selection (machine-private; no cascade
  // needed beyond removing the dangling pid → path entry).
  try { purgeProjectWorkspace(uid, projectId); }
  catch (err) { log.warn(`purge project ws user=${uid} pid=${projectId}: ${(err as Error).message}`); }

  // Clean up the (currently-empty) per-project asset dir if it exists.
  try {
    const d = path.join(userProjectsDir(uid), projectId);
    if (fs.existsSync(d)) await fsp.rm(d, { recursive: true, force: true });
  } catch (err) {
    log.warn(`drop project dir user=${uid} pid=${projectId}: ${(err as Error).message}`);
  }

  log.info(`deleted user=${uid} pid=${projectId} convs=${deletedConvs}`);
  return { ok: true, deleted_convs: deletedConvs };
}

/** True iff the given pid is a known project for this user. Used by
 *  conversations.create to validate the projectId before persisting. */
export async function projectExists(uid: string, projectId: string): Promise<boolean> {
  if (!projectId) return false;
  const items = await readIndex(uid);
  return items.some((p) => p.project_id === projectId);
}
