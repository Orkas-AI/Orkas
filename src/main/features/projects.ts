/**
 * Projects — logical groups of conversations + a strict scope of agents /
 * skills the conversations inside the project can use.
 *
 * Storage: each project is a self-contained directory under
 * `<uid>/cloud/projects/<pid>/` (cloud-synced):
 *   - `project.json`   {project_id, name, owner_uid, timestamps}
 *   - `bindings.json`  {agents: string[], skills: string[]} — id refs only,
 *                      no spec body copy. Missing file = empty bindings.
 *
 * **No aggregate `_index.json`**. Listing scans `projects/<pid>/project.json`.
 * **Why:** future server-mediated collaboration adds/removes a project from
 * a user's view by writing/removing the per-pid directory; an aggregate
 * index would force every membership change to be a multi-file
 * transactional update and would conflict on multi-device sync. The
 * directory's existence on disk is the single source of truth — see
 * CLAUDE.md §4 / §9.
 *
 * **Membership of a conversation** is still recorded as a `project_id`
 * field on the conv index entry (`features/chats.ts::Conversation`), NOT
 * as a path component — `<cid>.jsonl` / `groupChatDir` / `session_id`
 * paths stay verbatim, so cid uniqueness + §5 isolation are unaffected.
 *
 * **Scope semantics** (CLAUDE.md §6, outer intersection BEFORE the 4
 * enable-filter sites):
 *   conversation in project P → only agents/skills in `bindings.json` are
 *   visible to the LLM. Orphan conversation (no project_id) → unchanged
 *   global visibility. `resolveProjectScope` is the single resolver
 *   threaded through the runTurn pipeline (alongside the workspace
 *   resolver) — do not re-read bindings per tool call.
 *
 * **Per-user enable/disable** still applies AFTER project bindings, via
 * the existing 4 filter sites; do not add a 5th.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import {
  userProjectsDir,
  projectDir,
  projectMetaFile,
  projectBindingsFile,
} from '../paths';
import { nowIso, readJson, writeJson } from '../storage';
import { createLogger } from '../logger';
import * as chats from './chats';
import * as autoTasks from './auto_tasks';
import { readState } from './group_chat/state';
import { purgeProjectWorkspace } from './user_workspace';
import { limitNameDisplayText } from '../util/name-limit';

const log = createLogger('projects');

export interface Project {
  project_id: string;
  name: string;
  /** Reserved for future collaboration. Single-machine = active uid. */
  owner_uid: string;
  created_at: string;
  updated_at: string;
}

/** UI-extended project record: metadata + derived counts. */
export interface ProjectWithStats extends Project {
  conv_count: number;
}

/** Strict scope — only these ids are visible to the LLM inside the project.
 *  Empty arrays = "zero agents / zero skills" (intentional opt-out). */
export interface ProjectBindings {
  agents: string[];
  skills: string[];
}

// ── id helper ─────────────────────────────────────────────────────────────

function genProjectId(): string {
  return 'p_' + crypto.randomBytes(6).toString('hex');
}

// ── filesystem helpers ────────────────────────────────────────────────────

function ensureProjectsDir(uid: string): string {
  const d = userProjectsDir(uid);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** One-shot promotion of legacy `<uid>/cloud/projects/_index.json` to per-pid
 *  `project.json` files. Idempotent: bindings.json is NOT created (empty
 *  bindings on first read of any newly-promoted project — see plan: "no
 *  migration"). */
async function _ensurePromoted(uid: string): Promise<void> {
  const legacy = path.join(ensureProjectsDir(uid), '_index.json');
  if (!fs.existsSync(legacy)) return;
  let items: any[] = [];
  try {
    const data: any = await readJson(legacy);
    if (Array.isArray(data)) items = data;
    else if (data && Array.isArray(data.items)) items = data.items;
  } catch (err) {
    log.warn(`legacy _index.json read user=${uid}: ${(err as Error).message}`);
  }
  let promoted = 0;
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const pid = typeof raw.project_id === 'string' ? raw.project_id : '';
    if (!pid) continue;
    const meta = projectMetaFile(uid, pid);
    if (fs.existsSync(meta)) continue;
    try {
      fs.mkdirSync(projectDir(uid, pid), { recursive: true });
      await writeJson(meta, _normaliseProject(raw, uid, pid));
      promoted += 1;
    } catch (err) {
      log.warn(`legacy promote pid=${pid} user=${uid}: ${(err as Error).message}`);
    }
  }
  try { await fsp.unlink(legacy); }
  catch (err) {
    log.warn(`legacy _index.json unlink user=${uid}: ${(err as Error).message}`);
  }
  log.info(`legacy _index.json promoted user=${uid} count=${promoted}`);
}

async function _listProjectIds(uid: string): Promise<string[]> {
  const dir = ensureProjectsDir(uid);
  await _ensurePromoted(uid);
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip dotfiles / underscore-prefixed (reserved). Matches the
    // contexts.ts `.kb` hidden-dir convention.
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (fs.existsSync(projectMetaFile(uid, entry.name))) out.push(entry.name);
  }
  return out;
}

function _normaliseProject(raw: any, uid: string, pid: string): Project {
  const now = nowIso();
  return {
    project_id: typeof raw.project_id === 'string' ? raw.project_id : pid,
    name: typeof raw.name === 'string' ? raw.name : '',
    owner_uid: typeof raw.owner_uid === 'string' && raw.owner_uid ? raw.owner_uid : uid,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : now,
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : now,
  };
}

async function _readProject(uid: string, pid: string): Promise<Project | null> {
  const f = projectMetaFile(uid, pid);
  if (!fs.existsSync(f)) return null;
  try {
    const raw: any = await readJson(f);
    if (!raw || typeof raw !== 'object') return null;
    return _normaliseProject(raw, uid, pid);
  } catch (err) {
    log.warn(`read project user=${uid} pid=${pid}: ${(err as Error).message}`);
    return null;
  }
}

async function _writeProject(uid: string, p: Project): Promise<void> {
  fs.mkdirSync(projectDir(uid, p.project_id), { recursive: true });
  await writeJson(projectMetaFile(uid, p.project_id), p);
  _notifyDirty();
}

function _normaliseBindings(raw: any): ProjectBindings {
  if (!raw || typeof raw !== 'object') return { agents: [], skills: [] };
  const filt = (arr: unknown): string[] =>
    Array.isArray(arr) ? arr.filter((s) => typeof s === 'string' && !!s) as string[] : [];
  return { agents: filt(raw.agents), skills: filt(raw.skills) };
}

async function _readBindings(uid: string, pid: string): Promise<ProjectBindings> {
  const f = projectBindingsFile(uid, pid);
  if (!fs.existsSync(f)) return { agents: [], skills: [] };
  try {
    const raw: any = await readJson(f);
    return _normaliseBindings(raw);
  } catch (err) {
    log.warn(`read bindings user=${uid} pid=${pid}: ${(err as Error).message}`);
    return { agents: [], skills: [] };
  }
}

async function _writeBindings(uid: string, pid: string, b: ProjectBindings): Promise<void> {
  fs.mkdirSync(projectDir(uid, pid), { recursive: true });
  await writeJson(projectBindingsFile(uid, pid), b);
  _notifyDirty();
}

// Sync engine dirty signal (lazy-require — `features/sync` is stripped from OrkasOpen). Mirrors
// the pattern in `agents.ts::_invalidateAgentListCache`: any write to a `cloud/projects/...`
// file should kick the sync debounce so the change propagates within seconds rather than the
// 5-min periodic.
function _notifyDirty(): void {
}

// ── Validation ────────────────────────────────────────────────────────────

/** Trim + length cap. Returns null if the input is unusable. */
function normName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = limitNameDisplayText(raw.trim());
  if (!s) return null;
  return s;
}

async function _isDuplicateName(
  uid: string, name: string, excludePid?: string,
): Promise<boolean> {
  const ids = await _listProjectIds(uid);
  const lower = name.toLocaleLowerCase();
  const projects = await Promise.all(ids.map((pid) => _readProject(uid, pid)));
  for (const p of projects) {
    if (!p) continue;
    if (excludePid && p.project_id === excludePid) continue;
    if ((p.name || '').toLocaleLowerCase() === lower) return true;
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────

/** List projects with derived `conv_count`. Reads chats index once and groups. */
export async function listProjects(uid: string): Promise<ProjectWithStats[]> {
  const ids = await _listProjectIds(uid);
  if (!ids.length) return [];
  const projects = (await Promise.all(ids.map((pid) => _readProject(uid, pid))))
    .filter((p): p is Project => p !== null);
  // Newest first — matches the prior `items.unshift(project)` ordering.
  projects.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
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
  if (!projectId) return null;
  await _ensurePromoted(uid);
  return _readProject(uid, projectId);
}

export type ProjectError = 'name_empty' | 'name_dup' | 'not_found' | 'has_running_conv';

export async function createProject(
  uid: string,
  rawName: string,
): Promise<{ ok: true; project: Project } | { ok: false; error: ProjectError }> {
  const name = normName(rawName);
  if (!name) return { ok: false, error: 'name_empty' };
  if (await _isDuplicateName(uid, name)) return { ok: false, error: 'name_dup' };
  const now = nowIso();
  const project: Project = {
    project_id: genProjectId(),
    name,
    owner_uid: uid,
    created_at: now,
    updated_at: now,
  };
  await _writeProject(uid, project);
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
  await _ensurePromoted(uid);
  const cur = await _readProject(uid, projectId);
  if (!cur) return { ok: false, error: 'not_found' };
  if (await _isDuplicateName(uid, name, projectId)) return { ok: false, error: 'name_dup' };
  if (cur.name === name) return { ok: true, project: cur }; // no-op
  const next: Project = { ...cur, name, updated_at: nowIso() };
  await _writeProject(uid, next);
  log.info(`renamed user=${uid} pid=${projectId} name="${name}"`);
  return { ok: true, project: next };
}

/** Cascade-delete: every conversation under this project is dropped (full
 *  per-conv cascade — `<cid>.jsonl` / sessions / attachments / search idx /
 *  group dir / cli sessions), every auto task scoped to this project is
 *  dropped (config + attachments dir + scheduled timer cancelled via
 *  `auto_tasks.deleteTask`), then the project directory itself.
 *
 *  Aborts upfront if any conv is currently `running` (state.json::status). The
 *  user must stop the in-flight turn first; we do not silently abort. */
export async function deleteProject(
  uid: string,
  projectId: string,
): Promise<{ ok: true; deleted_convs: number; deleted_auto_tasks: number } | { ok: false; error: ProjectError }> {
  await _ensurePromoted(uid);
  const cur = await _readProject(uid, projectId);
  if (!cur) return { ok: false, error: 'not_found' };

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

  // Cascade-delete project-scoped auto tasks (config dir + attachments +
  // cancel the per-task timer in the scheduler). `deleteTask` is idempotent
  // and `rm -rf`s the whole `<uid>/cloud/auto_tasks/<task_id>/` directory.
  let deletedAutoTasks = 0;
  try {
    const ownedTasks = await autoTasks.listTasks(uid, { projectId });
    for (const t of ownedTasks) {
      try {
        const res = await autoTasks.deleteTask(uid, t.id);
        if (res.ok) deletedAutoTasks++;
      } catch (err) {
        log.warn(`cascade auto-task del user=${uid} pid=${projectId} task=${t.id}: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    log.warn(`enumerate auto tasks user=${uid} pid=${projectId}: ${(err as Error).message}`);
  }

  // Drop the per-project workspace selection (machine-private; no cascade
  // needed beyond removing the dangling pid → path entry).
  try { purgeProjectWorkspace(uid, projectId); }
  catch (err) { log.warn(`purge project ws user=${uid} pid=${projectId}: ${(err as Error).message}`); }

  // Drop the entire project directory (project.json + bindings.json + any
  // future per-project assets).
  try {
    const d = projectDir(uid, projectId);
    if (fs.existsSync(d)) await fsp.rm(d, { recursive: true, force: true });
  } catch (err) {
    log.warn(`drop project dir user=${uid} pid=${projectId}: ${(err as Error).message}`);
  }

  log.info(`deleted user=${uid} pid=${projectId} convs=${deletedConvs} auto_tasks=${deletedAutoTasks}`);
  return { ok: true, deleted_convs: deletedConvs, deleted_auto_tasks: deletedAutoTasks };
}

/** True iff the given pid is a known project for this user. Used by
 *  conversations.create to validate the projectId before persisting. */
export async function projectExists(uid: string, projectId: string): Promise<boolean> {
  if (!projectId) return false;
  await _ensurePromoted(uid);
  return fs.existsSync(projectMetaFile(uid, projectId));
}

// ── Bindings: per-project agent / skill scope ────────────────────────────

/** Read the project's bindings. Missing file or unknown project → empty.
 *  Unknown ids in the file are NOT filtered here — that is the caller's
 *  job (loaders are async). Missing project → returns empty so the LLM
 *  sees nothing rather than leaking global scope. */
export async function getBindings(uid: string, projectId: string): Promise<ProjectBindings> {
  if (!projectId) return { agents: [], skills: [] };
  await _ensurePromoted(uid);
  if (!fs.existsSync(projectMetaFile(uid, projectId))) return { agents: [], skills: [] };
  return _readBindings(uid, projectId);
}

export async function pruneBindings(
  uid: string,
  projectId: string,
  valid: { agents?: ReadonlySet<string>; skills?: ReadonlySet<string> },
): Promise<{ ok: true; bindings: ProjectBindings; pruned: ProjectBindings } | { ok: false; error: ProjectError }> {
  await _ensurePromoted(uid);
  if (!fs.existsSync(projectMetaFile(uid, projectId))) return { ok: false, error: 'not_found' };
  const cur = await _readBindings(uid, projectId);
  const validAgents = valid.agents;
  const validSkills = valid.skills;
  const next: ProjectBindings = {
    agents: validAgents ? cur.agents.filter((id) => validAgents.has(id)) : cur.agents,
    skills: validSkills ? cur.skills.filter((id) => validSkills.has(id)) : cur.skills,
  };
  const pruned: ProjectBindings = {
    agents: validAgents ? cur.agents.filter((id) => !validAgents.has(id)) : [],
    skills: validSkills ? cur.skills.filter((id) => !validSkills.has(id)) : [],
  };
  if (pruned.agents.length || pruned.skills.length) {
    await _writeBindings(uid, projectId, next);
    log.info(`pruned stale bindings user=${uid} pid=${projectId} agents=${pruned.agents.length} skills=${pruned.skills.length}`);
  }
  return { ok: true, bindings: next, pruned };
}

/** Single resolver, threaded through runTurn alongside the workspace lookup.
 *
 *  - `null` = orphan conversation (no project_id) → no scope filter; legacy
 *    global-visibility behavior.
 *  - present project → returns its bindings (possibly empty arrays).
 *  - stale projectId (project deleted but conv lingers) → returns null so
 *    the LLM falls back to global visibility instead of "zero scope". */
export async function resolveProjectScope(
  uid: string,
  projectId: string | null | undefined,
): Promise<ProjectBindings | null> {
  if (!projectId) return null;
  await _ensurePromoted(uid);
  if (!fs.existsSync(projectMetaFile(uid, projectId))) return null;
  return _readBindings(uid, projectId);
}

async function _mutateBindings(
  uid: string, projectId: string,
  fn: (b: ProjectBindings) => ProjectBindings,
): Promise<{ ok: true; bindings: ProjectBindings } | { ok: false; error: ProjectError }> {
  await _ensurePromoted(uid);
  if (!fs.existsSync(projectMetaFile(uid, projectId))) return { ok: false, error: 'not_found' };
  const cur = await _readBindings(uid, projectId);
  const next = fn(cur);
  await _writeBindings(uid, projectId, next);
  // Touch the project's updated_at so sidebar ordering reflects activity.
  const p = await _readProject(uid, projectId);
  if (p) await _writeProject(uid, { ...p, updated_at: nowIso() });
  return { ok: true, bindings: next };
}

export async function addAgentBinding(
  uid: string, projectId: string, agentId: string,
): Promise<{ ok: true; bindings: ProjectBindings } | { ok: false; error: ProjectError }> {
  if (!agentId) return { ok: false, error: 'not_found' };
  return _mutateBindings(uid, projectId, (b) => (
    b.agents.includes(agentId) ? b : { ...b, agents: [...b.agents, agentId] }
  ));
}

export async function removeAgentBinding(
  uid: string, projectId: string, agentId: string,
): Promise<{ ok: true; bindings: ProjectBindings } | { ok: false; error: ProjectError }> {
  return _mutateBindings(uid, projectId, (b) => (
    { ...b, agents: b.agents.filter((id) => id !== agentId) }
  ));
}

export async function addSkillBinding(
  uid: string, projectId: string, skillId: string,
): Promise<{ ok: true; bindings: ProjectBindings } | { ok: false; error: ProjectError }> {
  if (!skillId) return { ok: false, error: 'not_found' };
  return _mutateBindings(uid, projectId, (b) => (
    b.skills.includes(skillId) ? b : { ...b, skills: [...b.skills, skillId] }
  ));
}

export async function removeSkillBinding(
  uid: string, projectId: string, skillId: string,
): Promise<{ ok: true; bindings: ProjectBindings } | { ok: false; error: ProjectError }> {
  return _mutateBindings(uid, projectId, (b) => (
    { ...b, skills: b.skills.filter((id) => id !== skillId) }
  ));
}
