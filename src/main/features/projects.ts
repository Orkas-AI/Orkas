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
  projectInstructionsFile,
} from '../paths';
import { nowIso, readJson, safeId, writeJson, writeTextAtomicSync } from '../storage';
import { createLogger } from '../logger';
import { getCurrentLang, getLocaleMeta } from '../i18n';
import { prompts } from '../prompts/loader';
import { logErrorRef } from '../util/log-redact';
import * as chats from './chats';
import * as autoTasks from './auto_tasks';
import { readState } from './group_chat/state';
import { purgeProjectWorkspace } from './user_workspace';
import { limitNameDisplayText } from '../util/name-limit';

const log = createLogger('projects');

// Project names are unique per user. Keep the duplicate check and the
// following metadata write in one in-process critical section so two renderer
// requests cannot both observe the same pre-write directory snapshot.
const projectNameMutationTails = new Map<string, Promise<void>>();
const projectInstructionsMutationTails = new Map<string, Promise<void>>();
type ProjectRootRemover = (dir: string) => Promise<void>;
let projectRootRemover: ProjectRootRemover = async (dir) => {
  await fsp.rm(dir, { recursive: true, force: true });
};

export function _setProjectRootRemoverForTest(remover: ProjectRootRemover | null): void {
  projectRootRemover = remover || (async (dir) => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
}

async function withProjectNameMutationLock<T>(uid: string, work: () => Promise<T>): Promise<T> {
  const previous = projectNameMutationTails.get(uid) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  projectNameMutationTails.set(uid, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (projectNameMutationTails.get(uid) === tail) projectNameMutationTails.delete(uid);
  }
}

async function withProjectInstructionsMutationLock<T>(
  uid: string,
  projectId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = `${uid}\0${projectId}`;
  const previous = projectInstructionsMutationTails.get(key) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  projectInstructionsMutationTails.set(key, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (projectInstructionsMutationTails.get(key) === tail) {
      projectInstructionsMutationTails.delete(key);
    }
  }
}

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
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip dotfiles / underscore-prefixed (reserved). Matches the
    // contexts.ts `.kb` hidden-dir convention.
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    if (safeId(entry.name)) out.push(entry.name);
  }
  return out;
}

async function _mapBounded<T, R>(
  items: T[], concurrency: number, fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    async () => {
      while (true) {
        const index = next++;
        if (index >= items.length) return;
        out[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
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
  try {
    const raw: any = JSON.parse(await fsp.readFile(f, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return _normaliseProject(raw, uid, pid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('read project failed', { uid, pid, error: logErrorRef(err) });
    }
    return null;
  }
}

async function _writeProject(uid: string, p: Project): Promise<void> {
  fs.mkdirSync(projectDir(uid, p.project_id), { recursive: true });
  await writeJson(projectMetaFile(uid, p.project_id), p);
  _invalidateSearchDisplayCatalog(uid);
  _notifyDirty();
}

function _invalidateSearchDisplayCatalog(uid: string): void {
  try {
    const search = require('./search') as { invalidateChatDisplayCatalog?: (userId: string) => void };
    search.invalidateChatDisplayCatalog?.(uid);
  } catch { /* search module may still be initializing */ }
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

// Sync engine dirty signal (lazy-require — `features/sync` is stripped from the open-source build). Mirrors
// the pattern in `agents.ts::_invalidateAgentListCache`: any write to a `cloud/projects/...`
// file should kick the sync debounce so the change propagates within seconds rather than the
// 5-min periodic.
function _notifyDirty(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('projects', 'cloud/projects');
  } catch { /* features/sync stripped */ }
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

/** List projects with derived `conv_count` from each compact project index.
 * Deliberately does not call `chats.listConversations`: project metadata is
 * renderer Stage A work, while full conversation enrichment belongs to the
 * parallel Stage B request. */
export async function listProjects(uid: string): Promise<ProjectWithStats[]> {
  const ids = await _listProjectIds(uid);
  if (!ids.length) return [];
  const [conversationCounts, projectRows] = await Promise.all([
    chats.getProjectConversationCounts(uid),
    _mapBounded(ids, 8, (pid) => _readProject(uid, pid)),
  ]);
  const entries = projectRows.map((project) => project ? {
    project,
    convCount: conversationCounts.get(project.project_id) || 0,
  } : null);
  const projects = entries.filter((entry): entry is { project: Project; convCount: number } => entry !== null);
  // Display-name order is shared by the sidebar and every picker backed by
  // `projects.list`. Numeric comparison keeps names such as Project 2 before
  // Project 10; project_id is a deterministic fallback for malformed legacy
  // data that collates to the same display name.
  const locale = getLocaleMeta(getCurrentLang()).intlLocale;
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  projects.sort((a, b) => (
    collator.compare(a.project.name || '', b.project.name || '')
    || a.project.project_id.localeCompare(b.project.project_id)
  ));
  return projects.map(({ project, convCount }) => ({ ...project, conv_count: convCount }));
}

/** Project names only, for chips/search catalogs that do not need counts. */
export async function listProjectNameRows(uid: string): Promise<Array<{ project_id: string; name: string }>> {
  const ids = await _listProjectIds(uid);
  if (!ids.length) return [];
  const rows = await _mapBounded(ids, 8, (pid) => _readProject(uid, pid));
  return rows
    .filter((project): project is Project => project !== null)
    .map((project) => ({ project_id: project.project_id, name: project.name || '' }));
}

/** Resolve a single project by id (no stats). */
export async function getProject(uid: string, projectId: string): Promise<Project | null> {
  if (!projectId) return null;
  await _ensurePromoted(uid);
  return _readProject(uid, projectId);
}

export type ProjectError =
  | 'name_empty'
  | 'name_dup'
  | 'not_found'
  | 'has_running_conv'
  | 'too_long'
  | 'cascade_failed';

export async function createProject(
  uid: string,
  rawName: string,
): Promise<{ ok: true; project: Project } | { ok: false; error: ProjectError }> {
  const name = normName(rawName);
  if (!name) return { ok: false, error: 'name_empty' };
  return withProjectNameMutationLock(uid, async () => {
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
  });
}

export async function renameProject(
  uid: string,
  projectId: string,
  rawName: string,
): Promise<{ ok: true; project: Project } | { ok: false; error: ProjectError }> {
  const name = normName(rawName);
  if (!name) return { ok: false, error: 'name_empty' };
  return withProjectNameMutationLock(uid, async () => {
    await _ensurePromoted(uid);
    const cur = await _readProject(uid, projectId);
    if (!cur) return { ok: false, error: 'not_found' };
    if (await _isDuplicateName(uid, name, projectId)) return { ok: false, error: 'name_dup' };
    if (cur.name === name) return { ok: true, project: cur }; // no-op
    const next: Project = { ...cur, name, updated_at: nowIso() };
    await _writeProject(uid, next);
    log.info(`renamed user=${uid} pid=${projectId} name="${name}"`);
    return { ok: true, project: next };
  });
}

// ── Project instructions (ORKAS.md) ─────────────────────────────────────────
//
// A per-project markdown file: the project's standing goal + rules, injected
// into the system prompt of every session that belongs to the project
// (runner.ts). The USER edits it in the project settings UI; the COMMANDER may
// also replace it via the `project_instructions` tool (runner injects that tool
// for the commander session only — sub-agents read only). Same sync posture as the
// sibling project files (projects domain, no explicit markDirty — matches
// `_writeProject`).

export const PROJECT_INSTRUCTIONS_CHAR_LIMIT = 4000;

/**
 * Static contract for the user-managed layers injected into project sessions.
 * Keep this separate from ORKAS.md so the conflict policy is present even when
 * the project has no user-authored instructions yet.
 */
export function formatProjectContextPolicyForSystemPrompt(): string {
  return prompts.load('chat_project_context_policy').trim();
}

export async function readProjectInstructions(
  uid: string,
  projectId: string,
): Promise<{ ok: true; content: string; limit: number } | { ok: false; error: ProjectError }> {
  const cur = await _readProject(uid, projectId);
  if (!cur) return { ok: false, error: 'not_found' };
  let content = '';
  try {
    content = await fsp.readFile(projectInstructionsFile(uid, projectId), 'utf8');
  } catch { /* missing file = no instructions yet */ }
  return { ok: true, content, limit: PROJECT_INSTRUCTIONS_CHAR_LIMIT };
}

export async function writeProjectInstructions(
  uid: string,
  projectId: string,
  content: string,
): Promise<{ ok: true } | { ok: false; error: ProjectError }> {
  if (content.length > PROJECT_INSTRUCTIONS_CHAR_LIMIT) return { ok: false, error: 'too_long' };
  return withProjectInstructionsMutationLock(uid, projectId, async () => {
    const cur = await _readProject(uid, projectId);
    if (!cur) return { ok: false, error: 'not_found' };
    writeTextAtomicSync(projectInstructionsFile(uid, projectId), content);
    log.info(`instructions saved user=${uid} pid=${projectId} chars=${content.length}`);
    return { ok: true };
  });
}

export type ProjectInstructionsConditionalWriteError =
  | ProjectError
  | 'conflict'
  | 'read_failed';

/**
 * Replace ORKAS.md only when it still contains the exact text observed by the
 * caller. Model turns use this compare-and-set path because their prompt can
 * become stale while the user edits project instructions in the UI. All local
 * instruction writers share the same lock, so a renderer save cannot slip
 * between the comparison and the atomic replacement.
 */
export async function writeProjectInstructionsIfUnchanged(
  uid: string,
  projectId: string,
  expectedContent: string,
  content: string,
): Promise<{ ok: true } | { ok: false; error: ProjectInstructionsConditionalWriteError }> {
  if (content.length > PROJECT_INSTRUCTIONS_CHAR_LIMIT) return { ok: false, error: 'too_long' };
  return withProjectInstructionsMutationLock(uid, projectId, async () => {
    const cur = await _readProject(uid, projectId);
    if (!cur) return { ok: false, error: 'not_found' };

    let currentContent = '';
    try {
      currentContent = await fsp.readFile(projectInstructionsFile(uid, projectId), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`instructions compare read failed user=${uid} pid=${projectId}: ${(err as Error).message}`);
        return { ok: false, error: 'read_failed' };
      }
    }
    if (currentContent !== expectedContent) return { ok: false, error: 'conflict' };

    writeTextAtomicSync(projectInstructionsFile(uid, projectId), content);
    log.info(`instructions conditionally saved user=${uid} pid=${projectId} chars=${content.length}`);
    return { ok: true };
  });
}

/**
 * Render the project's user-authored instructions as a system-prompt block.
 * Read side for `runner.ts::buildRunner` — low-churn user configuration, so it
 * sits in the stable prompt-prefix region (unlike the per-turn memory block).
 * Returns '' when the project has no instructions (zero prompt tokens).
 * Defensive slice: the write path enforces the limit, but the file can arrive
 * oversized via sync — never let it flood the prompt.
 */
export function formatProjectInstructionsForSystemPrompt(uid: string, projectId: string): string {
  let raw = '';
  try {
    raw = fs.readFileSync(projectInstructionsFile(uid, projectId), 'utf8');
  } catch {
    return '';
  }
  const content = raw.trim().slice(0, PROJECT_INSTRUCTIONS_CHAR_LIMIT);
  if (!content) return '';
  return [
    '## Project instructions (user-authored)',
    "These are the project's standing instructions (its goal and rules). They are configuration, not conversation content. They apply to every conversation in this project; follow them unless the user overrides them in the conversation.",
    content,
  ].join('\n\n');
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

  let allConvs: Awaited<ReturnType<typeof chats.listConversations>>;
  let ownedTasks: Awaited<ReturnType<typeof autoTasks.listTasks>>;
  try {
    // Enumerate every durable child before mutating any of them. Treating a
    // transient list failure as an empty project previously removed the whole
    // project tree and reported success even though the cascade scope was
    // unknown.
    [allConvs, ownedTasks] = await Promise.all([
      chats.listConversations(uid),
      autoTasks.listTasks(uid, { projectId }),
    ]);
  } catch (err) {
    log.warn('project cascade preflight failed', {
      uid,
      pid: projectId,
      error: logErrorRef(err),
    });
    return { ok: false, error: 'cascade_failed' };
  }
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
  let cascadeFailed = false;
  for (const c of owned) {
    try {
      if (await chats.deleteConversation(uid, c.conversation_id, projectId)) deletedConvs++;
      else cascadeFailed = true;
    } catch (err) {
      cascadeFailed = true;
      log.warn(`cascade del user=${uid} pid=${projectId} cid=${c.conversation_id}: ${(err as Error).message}`);
    }
  }

  // Cascade-delete project-scoped auto tasks (config dir + attachments +
  // cancel the per-task timer in the scheduler). `deleteTask` is idempotent
  // and `rm -rf`s the whole `<uid>/cloud/auto_tasks/<task_id>/` directory.
  let deletedAutoTasks = 0;
  for (const t of ownedTasks) {
    try {
      const res = await autoTasks.deleteTask(uid, t.id);
      if (res.ok) deletedAutoTasks++;
      else cascadeFailed = true;
    } catch (err) {
      cascadeFailed = true;
      log.warn(`cascade auto-task del user=${uid} pid=${projectId} task=${t.id}: ${(err as Error).message}`);
    }
  }

  // Never convert a partial child cascade into a green project deletion. The
  // user-facing IPC owner has already created a strict recycle snapshot and
  // can restore any child removed before the failure. Keeping project.json
  // here also keeps the project visible while that recovery runs.
  if (cascadeFailed) {
    log.warn(`project cascade incomplete user=${uid} pid=${projectId} convs=${deletedConvs}/${owned.length} auto_tasks=${deletedAutoTasks}/${ownedTasks.length}`);
    return { ok: false, error: 'cascade_failed' };
  }

  // Drop the entire project directory (project.json + bindings.json + any
  // future per-project assets).
  try {
    const d = projectDir(uid, projectId);
    if (fs.existsSync(d)) await projectRootRemover(d);
  } catch (err) {
    log.warn(`drop project dir user=${uid} pid=${projectId}: ${(err as Error).message}`);
    return { ok: false, error: 'cascade_failed' };
  }
  // Remove the machine-private workspace selection only after the durable
  // project root is gone. If root deletion fails, IPC restores child data from
  // the recycle snapshot and the user's workspace choice must survive too.
  try { purgeProjectWorkspace(uid, projectId); }
  catch (err) { log.warn(`purge project ws user=${uid} pid=${projectId}: ${(err as Error).message}`); }
  try {
    const projectLibrary = await import('./project_library_indexer');
    await projectLibrary.dropProjectIndex(uid, projectId);
  } catch (err) {
    log.warn(`drop project library index user=${uid} pid=${projectId}: ${(err as Error).message}`);
  }

  _invalidateSearchDisplayCatalog(uid);

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
