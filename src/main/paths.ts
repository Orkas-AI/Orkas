/**
 * Filesystem layout for Orkas.
 *
 * All path constants live here — never hardcode paths elsewhere.
 *
 * Layout (dev and packaged both use this tree; only WS_ROOT differs):
 *
 *   PC_ROOT/                      ← source + per-install binaries (asar-packed in prod)
 *     bootstrap.cjs package.json node_modules/ test/ docs/
 *     src/
 *       main/                     ← index.ts + preload.js + features/...
 *       renderer/ builtin/ resources/ core-agent/
 *     data/                       ← WS_ROOT (dev default); userData/data in prod
 *       users.json                ← Local uid registry + current_user_id
 *       logs/                     ← Local logs (rolled daily, global)
 *       builtin/                  ← Local public builtin runtime copy (hash-synced from src/builtin/ at startup)
 *         agents/<agent_id>/
 *         skills/<skill_id>/
 *       <user_id>/
 *         cloud/                  ← Cloud-sync domain (synced per uid / org / team once accounts are integrated)
 *           chats/  chat_attachments/  sessions/  contexts/  memory/
 *           agents/<agent_id>/  skills/<skill_id>/  meta/<agent_id>/
 *           config/preferences.json
 *         local/                  ← Machine-private domain (never synced)
 *           config/               ← auth-profiles.json + web-search-cache.json
 *           search/               ← contexts / chats inverted idx (agent / skill bodies queried in-memory at request time)
 *
 * Runtime overrides:
 *   ORKAS_WORKSPACE_ROOT   point data root elsewhere (src/main/index.ts sets this in packaged builds; env var name predates the dir rename — kept for stability)
 *   ORKAS_BUILTIN_ROOT     optional override for the builtin source dir
 *   CORE_AGENT_AUTH_DIR     pinned by `activateUser()` to the active user's `<uid>/local/config/`
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

// ── Roots ────────────────────────────────────────────────────────────────
// __dirname = PC/src/main → parents[0]=main, [1]=src, [2]=PC.
export const SRC_ROOT      = path.resolve(__dirname, '..');            // PC/src
export const PC_ROOT       = path.resolve(__dirname, '..', '..');      // PC
export const APP_ROOT      = PC_ROOT;
export const PROJECT_ROOT  = path.resolve(PC_ROOT, '..');              // Orkas

// ── Data root (env > dev default) ────────────────────────────────────────
// The on-disk directory name is `data/`; the constant is still named WS_ROOT
// (a historical abbreviation of "workspace root" — it's an internal TS symbol
// and not part of any user-facing naming). The env var `ORKAS_WORKSPACE_ROOT`
// likewise keeps its old name so deployments upgrade transparently.
export const WS_ROOT = process.env.ORKAS_WORKSPACE_ROOT
  ? path.resolve(process.env.ORKAS_WORKSPACE_ROOT)
  : path.join(PC_ROOT, 'data');

// ── Top-level (machine-global, shared across uids) ───────────────────────
// Machine-local uid registry: { current_user_id, users: [{user_id, created_at}, ...] }
export const USERS_FILE        = path.join(WS_ROOT, 'users.json');
// Machine-local logs (daily rolling, single global file shared across uids).
export const LOGS_DIR          = path.join(WS_ROOT, 'logs');
// Builtin runtime copy: hash-synced from `src/builtin/` at startup; all uids
// read from here. The loader scans
// `[<uid>/cloud/{skills,agents}, <BUILTIN_{SKILLS,AGENTS}_DIR>]`.
export const BUILTIN_ROOT        = path.join(WS_ROOT, 'builtin');
export const BUILTIN_AGENTS_DIR  = path.join(BUILTIN_ROOT, 'agents');
export const BUILTIN_SKILLS_DIR  = path.join(BUILTIN_ROOT, 'skills');
// Builtin agents follow the same directory shape:
// `<BUILTIN_AGENTS_DIR>/<aid>/agent.json`. The runtime sub-directories
// (meta / skills) only exist on the user cloud side; the builtin side does
// not carry them.
export const builtinAgentDir            = (agentId: string) => path.join(BUILTIN_AGENTS_DIR, agentId);
export const builtinAgentDefinitionFile = (agentId: string) => path.join(builtinAgentDir(agentId), 'agent.json');

// ── Per-user roots ───────────────────────────────────────────────────────
export const userRoot       = (uid: string) => path.join(WS_ROOT, uid);
export const userCloudRoot  = (uid: string) => path.join(userRoot(uid), 'cloud');
export const userLocalRoot  = (uid: string) => path.join(userRoot(uid), 'local');

// ── Cloud-synced per-user ────────────────────────────────────────────────
export const userChatsDir           = (uid: string) => path.join(userCloudRoot(uid), 'chats');
export const userSkillChatDir       = (uid: string, sid: string) => path.join(userChatsDir(uid), 'skill', sid);
export const userAgentChatDir       = (uid: string, aid: string) => path.join(userChatsDir(uid), 'agent', aid);

// Group-chat per-conversation companion directory tree. `<cid>.jsonl` sits
// at userChatsDir level alongside this directory; this directory holds
// group-level metadata (members/state/plan) plus per-actor visibility slices.
// See features/group_chat/ and CLAUDE.md §5.
export const groupChatDir            = (uid: string, cid: string) => path.join(userChatsDir(uid), cid);
export const groupChatMembersFile    = (uid: string, cid: string) => path.join(groupChatDir(uid, cid), 'members.json');
export const groupChatStateFile      = (uid: string, cid: string) => path.join(groupChatDir(uid, cid), 'state.json');
export const groupChatPlanFile       = (uid: string, cid: string) => path.join(groupChatDir(uid, cid), 'plan.json');
export const groupChatVisibilityDir  = (uid: string, cid: string) => path.join(groupChatDir(uid, cid), 'visibility');
export const groupChatVisibilityFile = (uid: string, cid: string, actorId: string) =>
  path.join(groupChatVisibilityDir(uid, cid), `${actorId}.jsonl`);

export const userChatAttachmentsDir = (uid: string) => path.join(userCloudRoot(uid), 'chat_attachments');
export const chatAttachmentDir      = (uid: string, cid: string) => path.join(userChatAttachmentsDir(uid), cid);

// core-agent session jsonl (LLM-view) — all session kinds land here:
// conv (legacy) / gconv / gmember / skill / agent / extract-img.
export const userSessionsDir        = (uid: string) => path.join(userCloudRoot(uid), 'sessions');
export const userSessionFile        = (uid: string, sessionId: string) => path.join(userSessionsDir(uid), `${sessionId}.jsonl`);

// Curated knowledge base (the "organized" region of the historical
// two-region contexts design).
export const userContextsDir        = (uid: string) => path.join(userCloudRoot(uid), 'contexts');

// Local vector store for the knowledge base (part of the cloud-sync domain,
// stored in the same directory tree as the text content; on conflict the
// newer mtime wins). The hidden sub-directory `.kb/` keeps it out of the
// contexts user-visible listing (listContextsTree filters dotfiles).
// Runtime WAL/SHM sidecar files are excluded from sync.
export const userKbDir           = (uid: string) => path.join(userContextsDir(uid), '.kb');
export const userKbVectorDbPath  = (uid: string) => path.join(userKbDir(uid), 'vector.db');
export const userKbConfigPath    = (uid: string) => path.join(userKbDir(uid), 'config.json');

// Cross-session memory
export const userMemoryDir   = (uid: string) => path.join(userCloudRoot(uid), 'memory');
export const userMemoryFile  = (uid: string) => path.join(userMemoryDir(uid), 'MEMORY.md');
export const userProfileFile = (uid: string) => path.join(userMemoryDir(uid), 'USER.md');

// User-custom agents / skills (business kind = 'custom'; the loader scans
// cloud first). Agents use the directory shape
// `agents/<aid>/{agent.json, meta/, skills/}` — see CLAUDE.md §4 +
// docs/plans/agent-as-directory.md. The spec comes from the user; meta and
// skills are runtime-dynamic products (metacognition + the agent's
// self-evolved skills).
export const userAgentsDir = (uid: string) => path.join(userCloudRoot(uid), 'agents');
export const userSkillsDir = (uid: string) => path.join(userCloudRoot(uid), 'skills');

// Per-user projects (logical group of conversations + bindings + scoped
// workspace). Each project is a self-contained directory:
//   `<pid>/project.json`   metadata (project_id, name, owner_uid, timestamps)
//   `<pid>/bindings.json`  agent/skill ids the project pins (strict scope)
// **No aggregate `_index.json`** — listing scans `projects/*/project.json`.
// **Why:** future server-mediated collaboration adds/removes a project from
// a user's view by writing/removing the per-pid directory; an aggregate
// index would force every membership change to be a multi-file
// transactional update and would conflict on multi-device sync. See
// `features/projects.ts` and `PC/CLAUDE.md` §4 / §5 / §9.
//
// Project membership of a conversation stays as a `project_id` field on the
// conv index entry, NOT as a path component (cid stays globally unique;
// session_id schema is untouched — see CLAUDE.md §5).
export const userProjectsDir       = (uid: string) => path.join(userCloudRoot(uid), 'projects');
export const projectDir            = (uid: string, pid: string) => path.join(userProjectsDir(uid), pid);
export const projectMetaFile       = (uid: string, pid: string) => path.join(projectDir(uid, pid), 'project.json');
export const projectBindingsFile   = (uid: string, pid: string) => path.join(projectDir(uid, pid), 'bindings.json');
export const agentDir            = (uid: string, agentId: string) => path.join(userAgentsDir(uid), agentId || '_default');
export const agentDefinitionFile = (uid: string, agentId: string) => path.join(agentDir(uid, agentId), 'agent.json');

// Agent metacognition (per-agent self-assessment + learning strategies).
// Writes go through features/metacognition.ts; reflection-trigger fires
// automatically and the `metacognition` tool lets the agent maintain it
// itself.
export const agentMetaDir        = (uid: string, agentId: string) => path.join(agentDir(uid, agentId), 'meta');
export const agentCompetenceFile = (uid: string, agentId: string) => path.join(agentMetaDir(uid, agentId), 'COMPETENCE.md');
export const agentStrategiesFile = (uid: string, agentId: string) => path.join(agentMetaDir(uid, agentId), 'LEARNING_STRATEGIES.md');

// Agent self-evolved skill store (System B — written by core-agent's SkillStore;
// `skill_manage` tool creates / patches / deletes). **Visible only to the owning
// agent**; not included in the SkillLoader's `## Available skills` system prompt
// block; other agents / commander cannot see it. See CLAUDE.md §6 (dual system
// boundary).
export const agentEvolvedSkillsDir = (uid: string, agentId: string) => path.join(agentDir(uid, agentId), 'skills');

// Cross-device user preferences (language, etc.)
export const userCloudConfigDir  = (uid: string) => path.join(userCloudRoot(uid), 'config');
export const userPreferencesFile = (uid: string) => path.join(userCloudConfigDir(uid), 'preferences.json');
// Per-user enable/disable config (agents + skills). Schema in features/component_enabled.ts.
// Same dir + cloud-sync policy as preferences.json; only `false` is stored.
export const userComponentEnabledFile = (uid: string) => path.join(userCloudConfigDir(uid), 'component-enabled.json');

// ── Local-only per-user (never synced) ───────────────────────────────────

// Local credentials + provider cache: CORE_AGENT_AUTH_DIR is pinned here by
// activateUser(); both core-agent's auth store and the web-search provider
// cache land in this same directory.
export const userLocalConfigDir   = (uid: string) => path.join(userLocalRoot(uid), 'config');
export const userAuthProfilesFile = (uid: string) => path.join(userLocalConfigDir(uid), 'auth-profiles.json');
export const userWebSearchCache   = (uid: string) => path.join(userLocalConfigDir(uid), 'web-search-cache.json');
export const userReflectionStateFile = (uid: string) => path.join(userLocalConfigDir(uid), 'reflection-state.json');

// Local search index (derived data, self-healing via reconcile, never synced).
// Only the main conversation + knowledge base get a persistent inverted
// index; agents / skills themselves are searched in-memory via listAgents /
// listSkills (small datasets — switching UI language doesn't require an
// index rebuild).
export const userSearchDir           = (uid: string) => path.join(userLocalRoot(uid), 'search');
export const userContextsIndexPath   = (uid: string) => path.join(userSearchDir(uid), 'contexts.idx.json');
export const userChatsIndexPath      = (uid: string) => path.join(userSearchDir(uid), 'chats.idx.json');

// Spill copy for oversized tool output (>50K chars): the tool_result keeps
// only a preview + file reference; the model can pull back the full text
// via read_file(path). One subdirectory per session_id; startup
// `sweepToolResults(uid)` cleans entries older than 7 days by mtime.
// Never synced.
export const userToolResultsDir = (uid: string) => path.join(userLocalRoot(uid), 'tool-results');
export const sessionToolResultsDir = (uid: string, sessionId: string) =>
  path.join(userToolResultsDir(uid), sessionId);

// On-demand preprocessing cache for workspace / external path files
// (features/file_indexer.ts). The subdirectory name is
// sha1(absPath).slice(0,16); each entry contains four kinds of artifacts:
// meta.json, chunk.NNN.md, image.jpg, and processed.<taskHash>.md.
// Never synced — the source paths are local-absolute.
export const userFileCacheDir = (uid: string) => path.join(userLocalRoot(uid), 'file_cache');

// Run-history root for local CLI agent dispatches
// (features/local_agents/runner.ts). One subdirectory per dispatch:
// <uid>/local/file_cache/local-agent-runs/<runId>/{meta.json,
// prompt.txt, events.jsonl, output.txt}. Lives under file_cache so the
// existing local-domain GC sweep covers it (7-day default per plan).
export const userLocalAgentRunsDir = (uid: string) =>
  path.join(userFileCacheDir(uid), 'local-agent-runs');
export const localAgentRunDir = (uid: string, runId: string) =>
  path.join(userLocalAgentRunsDir(uid), runId);

// CLI agent session bindings (features/local_agents/sessions.ts) —
// per-conversation map `{aid → {cli, sessionId}}` so the next dispatch
// can `--resume` instead of re-replaying the whole visibility slice.
// Lives under `local/` (NOT cloud-synced) because the session id
// references claude's machine-local session files (`~/.claude/...`)
// which aren't valid on a different device.
export const userLocalCliSessionsDir = (uid: string) =>
  path.join(userLocalRoot(uid), 'cli-sessions');
export const localCliSessionsFile = (uid: string, cid: string) =>
  path.join(userLocalCliSessionsDir(uid), `${cid}.json`);

// Per-user local workspace selection (features/user_workspace.ts): the
// absolute path of the folder the user picked + a recents list. Absolute
// paths are machine-specific, so this is never synced.
export const userWorkspaceConfigFile = (uid: string) => path.join(userLocalRoot(uid), 'workspace.json');

// ── Build-time resources (shipped with installer, read-only) ────────────
// The 95MB ONNX embedding model ships via electron-builder's `extraResources`
// (it does not go through asar); dev and packaged builds have different paths:
//   dev:    PC/resources/embedding-model/
//   packed: <app>/Contents/Resources/embedding-model/      (darwin)
//           <app>/resources/embedding-model/               (win/linux)
// We deliberately don't depend on electron.app here — keeps the function
// usable from unit tests / scripts. `process.resourcesPath` only exists in
// the Electron runtime; in dev we fall back to the repo layout.
export function embeddingModelDir(): string {
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (rp && !rp.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`)) {
    // Packaged: process.resourcesPath points to app.Resources.
    return path.join(rp, 'embedding-model');
  }
  // Dev (when Electron runs electron-stub, resourcesPath points to electron
  // itself — filtered out by the line above; in other tsx / node scripts
  // resourcesPath simply does not exist).
  return path.join(PC_ROOT, 'resources', 'embedding-model');
}

// ── Builtin source dirs (shipped, read-only in packaged app) ─────────────
// All source lives under SRC_ROOT, and `builtin/` follows; electron-builder
// globs `src/builtin/**` into asar at packaging time. When the user
// overrides ORKAS_BUILTIN_ROOT, the path is used as-is and does not go
// through SRC_ROOT.
export const BUILTIN_SKILLS_SOURCE = process.env.ORKAS_BUILTIN_ROOT
  ? path.join(path.resolve(process.env.ORKAS_BUILTIN_ROOT), 'skills')
  : path.join(SRC_ROOT, 'builtin', 'skills');
export const BUILTIN_AGENTS_SOURCE = process.env.ORKAS_BUILTIN_ROOT
  ? path.join(path.resolve(process.env.ORKAS_BUILTIN_ROOT), 'agents')
  : path.join(SRC_ROOT, 'builtin', 'agents');

// ── User workspace (user-facing working directory for agent output) ──────
// Default: `userWorkSpace/` next to the workspace root.
// The actual per-user selection is stored in a JSON config managed by
// features/user_workspace.ts; this constant is only the fallback default.
export const DEFAULT_USER_WORKSPACE = process.env.ORKAS_WORKSPACE_ROOT
  ? path.join(path.resolve(process.env.ORKAS_WORKSPACE_ROOT), '..', 'userWorkSpace')
  : path.join(PC_ROOT, 'userWorkSpace');

// ── Init: mkdir the top-level skeleton ───────────────────────────────────
// Only the top-level shared directories are created here; per-uid sub-trees
// are mkdir'd on demand by `features/users.activateUser(uid)`.
export function ensureTopLevelLayout(): void {
  for (const d of [LOGS_DIR, BUILTIN_AGENTS_DIR, BUILTIN_SKILLS_DIR, DEFAULT_USER_WORKSPACE]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// Mkdir on module load — keeps legacy behavior of "paths.ts import = dir ready".
ensureTopLevelLayout();

// ── Per-user layout (called by activateUser) ─────────────────────────────
// Single-uid directory skeleton: every `<uid>/cloud/*` + `<uid>/local/*`
// sub-directory.
export function ensureUserLayout(uid: string): void {
  const dirs = [
    userChatsDir(uid),
    userChatAttachmentsDir(uid),
    userSessionsDir(uid),
    userContextsDir(uid),
    userKbDir(uid),
    userMemoryDir(uid),
    userAgentsDir(uid),
    userSkillsDir(uid),
    userProjectsDir(uid),
    // userMetaDir is deprecated — per-agent meta now lands in the
    // `agents/<aid>/meta/` sub-directory, mkdir'd on demand at agent
    // creation time, so no top-level placeholder is required.
    userCloudConfigDir(uid),
    userLocalConfigDir(uid),
    userSearchDir(uid),
    userFileCacheDir(uid),
    userToolResultsDir(uid),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });

  // Legacy sweep: `contexts_tmp/` was the staging area for the retired
  // two-region KB design (see features/contexts.ts header). Older builds
  // created the empty dir on every activate; remove it once if still
  // present + empty, leave it alone if a user somehow stuffed files there.
  const legacyContextsTmp = path.join(userLocalRoot(uid), 'contexts_tmp');
  try { fs.rmdirSync(legacyContextsTmp); } catch { /* ENOENT or ENOTEMPTY — both fine */ }
}
