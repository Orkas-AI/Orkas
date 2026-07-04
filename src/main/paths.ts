/**
 * Filesystem layout for Orkas.
 *
 * All path constants live here — never hardcode paths elsewhere.
 *
 * Layout (dev and packaged both use this tree; the only platform variation
 * is in `<container>` — see install-data-root.ts):
 *
 *   PC_ROOT/                      ← source + per-install binaries (asar-packed in prod)
 *     bootstrap.cjs package.json node_modules/ test/ docs/
 *     src/
 *       main/                     ← index.ts + preload.js + features/...
 *       renderer/ resources/ core-agent/
 *
 *   <container>/                  ← ~/.orkas (mac/linux) or <drive>:\.orkas (Windows, pinned)
 *     data/                       ← WS_ROOT
 *       users.json                ← Local uid registry + current_user_id / dev_current_user_id
 *       window-state.json         ← Last desktop window bounds (machine-local)
 *       logs/                     ← Local logs (rolled daily, global)
 *       venv/                     ← Machine-global dependency envs/caches
 *       local/marketplace/        ← Per-user platform installs reconciled from cloud manifests
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
 *           test/                 ← dev-only LLM archive
 *     userWorkSpace/              ← DEFAULT_USER_WORKSPACE (sibling of data/)
 *
 * Runtime overrides:
 *   ORKAS_WORKSPACE_ROOT   point data root elsewhere (set by index.ts to
 *                          `<container>/data`; tests / power users may
 *                          pre-set it to a tmp dir to bypass container
 *                          resolution)
 *   CORE_AGENT_AUTH_DIR    pinned by `activateUser()` to the active user's `<uid>/local/config/`
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';

// ── Roots ────────────────────────────────────────────────────────────────
// __dirname = PC/src/main → parents[0]=main, [1]=src, [2]=PC.
export const SRC_ROOT      = path.resolve(__dirname, '..');            // PC/src
export const PC_ROOT       = path.resolve(__dirname, '..', '..');      // PC
export const APP_ROOT      = PC_ROOT;
export const PROJECT_ROOT  = path.resolve(PC_ROOT, '..');              // Orkas

function packagedResourceDir(name: string): string {
  if (name === 'builtin' && process.env.ORKAS_BUILTIN_ROOT) {
    return path.resolve(process.env.ORKAS_BUILTIN_ROOT);
  }
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const looksPackaged = rp && !rp.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`);
  return looksPackaged ? path.join(rp, name) : path.join(PC_ROOT, 'resources', name);
}

// ── Data root ────────────────────────────────────────────────────────────
// `index.ts` always sets `ORKAS_WORKSPACE_ROOT` before this module loads
// (resolveInstallContainer + one-shot migration runs first). The constant
// is still named WS_ROOT (historical abbreviation of "workspace root" —
// internal TS symbol, not user-facing); the env var likewise keeps its
// old name for stability.
if (!process.env.ORKAS_WORKSPACE_ROOT) {
  throw new Error(
    'paths.ts: ORKAS_WORKSPACE_ROOT not set. index.ts must run resolveInstallContainer + set the env var before importing paths.',
  );
}
export const WS_ROOT = path.resolve(process.env.ORKAS_WORKSPACE_ROOT);

// ── Top-level (machine-global, shared across uids) ───────────────────────
// Machine-local profile registry. Persisted keys remain
// current_user_id/users[].user_id for compatibility. Hosted builds store
// `anonymous` while logged out and the real account uid while logged in.
// Dev builds use dev_current_user_id so they do not overwrite the packaged
// active profile pointer in the shared install-container users.json.
export const USERS_FILE        = path.join(WS_ROOT, 'users.json');
export const WINDOW_STATE_FILE = path.join(WS_ROOT, 'window-state.json');
// Machine-local logs (daily rolling, single global file shared across uids).
export const LOGS_DIR          = path.join(WS_ROOT, 'logs');
// Machine-local dependency environments shared across Orkas accounts on this
// device. Lives directly under data/ so app updates never overwrite it and
// multiple uids do not redownload the same package wheels.
export const VENV_ROOT         = path.join(WS_ROOT, 'venv');
export const PYTHON_VENV_ROOT  = path.join(VENV_ROOT, 'python');
export const PYTHON_VENV_BIN_DIR = path.join(PYTHON_VENV_ROOT, 'bin');
export const PYTHON_VENV_CACHE_DIR = path.join(PYTHON_VENV_ROOT, 'cache');
export const PYTHON_VENV_UV_CACHE_DIR = path.join(PYTHON_VENV_CACHE_DIR, 'uv');
export const PYTHON_VENV_PIP_CACHE_DIR = path.join(PYTHON_VENV_CACHE_DIR, 'pip');
export const pythonPackageVenvDir = (key: string) =>
  path.join(PYTHON_VENV_ROOT, 'packages', key, '.venv');
export const NODE_VENV_ROOT    = path.join(VENV_ROOT, 'node');
export const NODE_NPM_CACHE_DIR = path.join(NODE_VENV_ROOT, 'cache', 'npm');
export const NODE_NPM_PREFIX_DIR = path.join(NODE_VENV_ROOT, 'prefix');
export const NODE_NPM_GLOBAL_BIN_DIR = process.platform === 'win32'
  ? NODE_NPM_PREFIX_DIR
  : path.join(NODE_NPM_PREFIX_DIR, 'bin');
// Marketplace installs land under `<uid>/local/marketplace/` per machine — see
// `userMarketplace*` helpers below. There is no top-level platform install tree.

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

// LLM-generated interactive web-app bundles (artifacts). Layout:
// `<uid>/cloud/chat_artifacts/<cid>/<artifactId>/{index.html, ...assets, __orkas-meta.json}`.
// Served read-only via the `chat-app://` protocol (see index.ts). Cloud-synced
// with the conversation; purged by cid on conversation delete. Kept as a
// separate pool from chat_attachments/ on purpose — attachments are user
// uploads with an extension whitelist that `buildAttachmentManifest` scans to
// feed the model; artifacts are arbitrary directory trees that must not.
export const userChatArtifactsDir = (uid: string) => path.join(userCloudRoot(uid), 'chat_artifacts');
export const chatArtifactCidDir   = (uid: string, cid: string) => path.join(userChatArtifactsDir(uid), cid);
export const artifactDir          = (uid: string, cid: string, artifactId: string) =>
  path.join(chatArtifactCidDir(uid, cid), artifactId);

// User-kept copies of `create_artifact` apps ("My Apps"). Layout:
// `<uid>/cloud/saved_apps/<appId>/{index.html, ...siblings, __orkas-meta.json}`.
// Cloud-synced; never auto-purged (conversation-independent — only the user's
// explicit delete from the My Apps tab removes one). Served read-only via the
// `chat-app://saved` protocol for the in-app viewer; external open still uses
// `shell.openPath`. See `features/saved_apps.ts`.
export const userSavedAppsDir = (uid: string) => path.join(userCloudRoot(uid), 'saved_apps');
export const savedAppDir      = (uid: string, appId: string) => path.join(userSavedAppsDir(uid), appId);

// core-agent session jsonl (LLM-view). Two regions:
//   cloud/sessions/  — "resumable" kinds: gconv / gmember / skill / agent.
//     The user (or the system on the user's behalf) may continue these
//     conversations later, so the LLM history must cross devices.
//   local/sessions/  — "ephemeral" kinds: extract-img / reflect /
//     memory-extract / anon. One-shot background calls; nobody resumes them,
//     and they're large + worthless to sync. Sessions_sweep GCs by mtime.
// Routing lives in `model/core-agent/session-store.ts::resolveSessionPath`
// and is the single place that decides which side an id lands on.
export const userSessionsDir        = (uid: string) => path.join(userCloudRoot(uid), 'sessions');
export const userSessionFile        = (uid: string, sessionId: string) => path.join(userSessionsDir(uid), `${sessionId}.jsonl`);
export const userLocalSessionsDir   = (uid: string) => path.join(userLocalRoot(uid), 'sessions');
export const userLocalSessionFile   = (uid: string, sessionId: string) => path.join(userLocalSessionsDir(uid), `${sessionId}.jsonl`);

// Curated knowledge base (the "organized" region of the historical
// two-region contexts design).
export const userContextsDir        = (uid: string) => path.join(userCloudRoot(uid), 'contexts');
// Machine-private mirror of contexts/ — holds derived state that must NOT
// cross devices (currently just the KB vector store; see `userKbDir` below).
// **Why** mirror the cloud structure under local/ instead of an ad-hoc
// `<uid>/local/kb/`: keeps the mental model "everything KB lives under
// .../contexts/.kb/" intact across the cloud/local divide so paths.ts
// stays grep-able and the migration story is symmetric.
export const userLocalContextsDir   = (uid: string) => path.join(userLocalRoot(uid), 'contexts');

// Local vector store for the knowledge base (part of the cloud-sync domain,
// stored in the same directory tree as the text content; on conflict the
// newer mtime wins). The hidden sub-directory `.kb/` keeps it out of the
// contexts user-visible listing (listContextsTree filters dotfiles).
// Runtime WAL/SHM sidecar files are excluded from sync.
// KB vector store: machine-private, NOT cloud-synced (multi-device-sync
// batch 2 decision). Path moved from `<uid>/cloud/contexts/.kb/` (legacy)
// to `<uid>/local/contexts/.kb/` (current). One-shot rename runs from
// `util/migrate-kb-to-local.ts` on activateUser.
export const userKbDir           = (uid: string) => path.join(userLocalContextsDir(uid), '.kb');
export const userKbVectorDbPath  = (uid: string) => path.join(userKbDir(uid), 'vector.db');
export const userKbConfigPath    = (uid: string) => path.join(userKbDir(uid), 'config.json');

// Cross-session memory
export const userMemoryDir   = (uid: string) => path.join(userCloudRoot(uid), 'memory');
export const userMemoryFile  = (uid: string) => path.join(userMemoryDir(uid), 'MEMORY.md'); // shared/project tier
export const userProfileFile = (uid: string) => path.join(userMemoryDir(uid), 'USER.md');

/** Guard an agent id used as a single path segment for agent-scoped memory.
 *  The id is bound by the runner to the calling agent (never model-supplied),
 *  but memory paths derive from it, so reject traversal / separators defensively. */
function assertAgentSegment(agentId: string): string {
  if (!agentId || agentId.includes('/') || agentId.includes('\\') || agentId.includes('..') || agentId.includes('\0')) {
    throw new Error(`invalid agent id for memory path: ${JSON.stringify(agentId)}`);
  }
  return agentId;
}
export const agentMemoryDir  = (uid: string, agentId: string) => path.join(userMemoryDir(uid), 'agents', assertAgentSegment(agentId));
export const agentMemoryFile = (uid: string, agentId: string) => path.join(agentMemoryDir(uid, agentId), 'MEMORY.md');

// User-custom agents / skills (business kind = 'custom'; the loader scans
// cloud first). Agents use the directory shape
// `agents/<aid>/{agent.json, meta/, skills/, private_skills/}` — see CLAUDE.md §4 +
// docs/plans/agent-as-directory.md. The spec comes from the user; meta and
// skills are runtime-dynamic products (metacognition + the agent's
// self-evolved skills). `private_skills/` is an author-controlled publish
// source for agent-bundled skills; it is deliberately separate from the
// self-evolution store.
export const userAgentsDir = (uid: string) => path.join(userCloudRoot(uid), 'agents');
export const userSkillsDir = (uid: string) => path.join(userCloudRoot(uid), 'skills');
export const commanderDir = (uid: string) => path.join(userCloudRoot(uid), 'commander');
export const commanderRuntimeStatsFile = (uid: string) => path.join(commanderDir(uid), 'runtime_stats.json');

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
export const projectFilesDir        = (uid: string, pid: string) => path.join(projectDir(uid, pid), 'files');
export const projectLocalDir        = (uid: string, pid: string) => path.join(userLocalRoot(uid), 'projects', pid);
export const projectLibraryVectorDbPath = (uid: string, pid: string) => path.join(projectLocalDir(uid, pid), 'files', '.kb', 'vector.db');
export const agentDir            = (uid: string, agentId: string) => path.join(userAgentsDir(uid), agentId || '_default');
export const agentDefinitionFile = (uid: string, agentId: string) => path.join(agentDir(uid, agentId), 'agent.json');
export const userAgentMemoryDir  = (uid: string, agentId: string) => path.join(agentDir(uid, agentId), 'memory');
export const userAgentMemoryFile = (uid: string, agentId: string) => path.join(userAgentMemoryDir(uid, agentId), 'MEMORY.md');
export const agentRuntimeStatsFile = (uid: string, agentId: string) => path.join(agentDir(uid, agentId), 'runtime_stats.json');

// Agent metacognition (per-agent self-assessment + learning strategies).
// Writes go through features/metacognition.ts; reflection-orchestrator fires
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
export const agentPrivateSkillsDir = (uid: string, agentId: string) => path.join(agentDir(uid, agentId), 'private_skills');

// Cross-device user preferences (language, etc.)
export const userCloudConfigDir  = (uid: string) => path.join(userCloudRoot(uid), 'config');
export const userPreferencesFile = (uid: string) => path.join(userCloudConfigDir(uid), 'preferences.json');
// Per-user enable/disable config (agents + skills). Schema in features/component_enabled.ts.
// Same dir + cloud-sync policy as preferences.json; only `false` is stored.
export const userComponentEnabledFile = (uid: string) => path.join(userCloudConfigDir(uid), 'component-enabled.json');
// Per-user local-execution permission mode. Synced intentionally: this is the
// user's account-level safety posture, unlike granted-roots which contain
// machine-specific absolute paths and stay local-only.
export const userPermissionsFile = (uid: string) => path.join(userCloudConfigDir(uid), 'permissions.json');

// Packaged builtin resources. Source files ship with the app under
// `resources/builtin/` (extraResources in packaged builds); startup/login
// mirrors the relevant pieces into per-user runtime roots.
export const packagedBuiltinDir = () => packagedResourceDir('builtin');
export const packagedBuiltinMarketplaceDir = () => path.join(packagedBuiltinDir(), 'marketplace');
export const packagedBuiltinMarketplaceAgentsDir = () => path.join(packagedBuiltinMarketplaceDir(), 'agents');
export const packagedBuiltinMarketplaceSkillsDir = () => path.join(packagedBuiltinMarketplaceDir(), 'skills');

// Hidden system skills (product protocols, not user skills). Source files ship
// with the app under `resources/builtin/system/skills/`; startup mirrors them
// here so model file tools can read a stable per-user data-root path.
// Local-only: never cloud-synced, never shown in the Skills UI, never editable.
export const packagedSystemSkillsDir = () => path.join(packagedBuiltinDir(), 'system', 'skills');
export const packagedSystemSkillsManifestFile = () => path.join(packagedSystemSkillsDir(), '_system.json');
export const userSystemDir = (uid: string) => path.join(userLocalRoot(uid), 'system');
export const userSystemSkillsDir = (uid: string) => path.join(userSystemDir(uid), 'skills');
export const userSystemSkillDir = (uid: string, id: string) => path.join(userSystemSkillsDir(uid), id);
export const userSystemSkillsManifestFile = (uid: string) => path.join(userSystemSkillsDir(uid), '_system.json');

// Per-user auto tasks (sidebar "Automation" tab). Each task is a
// self-contained directory at `<uid>/cloud/auto_tasks/<task_id>/`:
//
//   <task_id>/
//     config.json    spec (schedule / recipient / skill / connector / ...)
//     attachments/   files attached to the task — copied into the new
//                    conversation's chat_attachments dir on fire
//
// Co-locating config + attachments under one dir means: deletion = rm -rf,
// cloud sync ships per-task bytes (no global file bottleneck), and the
// listing operation is a single directory scan + per-task config read.
// See features/auto_tasks.ts.
export const userAutoTasksDir = (uid: string) => path.join(userCloudRoot(uid), 'auto_tasks');
export const autoTaskDir = (uid: string, taskId: string) => path.join(userAutoTasksDir(uid), taskId);
export const autoTaskConfigFile = (uid: string, taskId: string) => path.join(autoTaskDir(uid, taskId), 'config.json');
export const autoTaskAttachmentsDir = (uid: string, taskId: string) => path.join(autoTaskDir(uid, taskId), 'attachments');
// Connector registry: installed MCP server instances + cached tool schemas + OAuth grants
// (local-secret encrypted with the active Orkas account's OAuth user_id as owner — see
// `features/connectors/registry.ts`). Cloud-synced as of 2026-05-15 so a user authorizing on
// one device sees the same connectors on another. **Secret owner:** OAuth user_id (not local uid)
// so any device logged into the same Orkas account can decrypt; the open-source build / not-logged-in
// users fall back to local uid (the file then sits in cloud/config/ but doesn't actually
// sync — sync engine is inactive without an account).
export const userConnectorsConfigFile = (uid: string) => path.join(userCloudConfigDir(uid), 'connectors.json');

// ── Local-only per-user (never synced) ───────────────────────────────────

// Local credentials + provider cache: CORE_AGENT_AUTH_DIR is pinned here by
// activateUser(); both core-agent's auth store and the web-search provider
// cache land in this same directory.
export const userLocalConfigDir   = (uid: string) => path.join(userLocalRoot(uid), 'config');
export const userAuthProfilesFile = (uid: string) => path.join(userLocalConfigDir(uid), 'auth-profiles.json');
export const userWebSearchCache   = (uid: string) => path.join(userLocalConfigDir(uid), 'web-search-cache.json');
export const userReflectionStateFile = (uid: string) => path.join(userLocalConfigDir(uid), 'reflection-state.json');
export const userDevtoolsFile     = (uid: string) => path.join(userLocalConfigDir(uid), 'devtools.json');
// Last-known-good product control-plane config fetched from the Server.
// Local cache only; Server JSON is the authority.
export const userRemoteConfigFile = (uid: string) => path.join(userLocalConfigDir(uid), 'remote-config.json');
// Machine-local defaults for external coding agents. Values are absolute
// project directories, so they must not sync across devices.
export const userAgentRuntimeConfigFile = (uid: string) => path.join(userLocalConfigDir(uid), 'agent-runtime.json');

// Local search index (derived data, self-healing via reconcile, never synced).
// Only the main conversation + knowledge base get a persistent inverted
// index; agents / skills themselves are searched in-memory via listAgents /
// listSkills (small datasets — switching UI language doesn't require an
// index rebuild).
export const userSearchDir           = (uid: string) => path.join(userLocalRoot(uid), 'search');
export const userContextsIndexPath   = (uid: string) => path.join(userSearchDir(uid), 'contexts.idx.json');
export const userChatsIndexPath      = (uid: string) => path.join(userSearchDir(uid), 'chats.idx.json');

// Dev-only LLM-call archive (features/devtools.ts + model/core-agent/client.ts).
export const userTestDir = (uid: string) => path.join(userLocalRoot(uid), 'test');

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

// ── Cache umbrella ─────────────────────────────────────────────────────
// `<uid>/local/cache/<bucket>/` is the convention for **user-clearable**
// caches: anything dropped here is fair game for the "clear cache" UI
// button. features/cache_clearable.ts enumerates the buckets and exposes
// clearBucket / clearAll. Distinct from `local/config/` (user prefs;
// untouched) and `local/biz/` (server-source business data; refreshable
// but not user-clearable).
export const userLocalCacheDir = (uid: string) => path.join(userLocalRoot(uid), 'cache');
export const localCacheBucketDir = (uid: string, bucket: string) =>
  path.join(userLocalCacheDir(uid), bucket);

// ── Business data ──────────────────────────────────────────────────────
// `<uid>/local/biz/` holds server-sourced reference data the client mirrors
// locally (e.g. marketplace.json carrying the category registry with a 24h
// TTL). Not user prefs (=> not in config/) and not throwaway cache
// (=> not in cache/) — losing it forces a re-fetch but is otherwise safe.
export const userLocalBizDir = (uid: string) => path.join(userLocalRoot(uid), 'biz');
export const marketplaceBizFile = (uid: string) =>
  path.join(userLocalBizDir(uid), 'marketplace.json');
export const marketplaceReconcileStateFile = (uid: string) =>
  path.join(userLocalBizDir(uid), 'marketplace-reconcile.json');

// ── Marketplace content cache (`<uid>/local/cache/marketplace/`) ────────
// Mirror of agent.json / skill bundle content fetched from the server, used
// to render the detail page without re-hitting the network on every visit
// and to short-circuit install when the same version is already on disk.
// Lives under cache/ (the "clearable" umbrella above) — losing it just
// triggers a re-fetch.
export const marketplaceCacheDir       = (uid: string) => localCacheBucketDir(uid, 'marketplace');
export const marketplaceCacheAgentsDir = (uid: string) => path.join(marketplaceCacheDir(uid), 'agents');
export const marketplaceCacheSkillsDir = (uid: string) => path.join(marketplaceCacheDir(uid), 'skills');
export const marketplaceCacheAgentDir  = (uid: string, id: string) =>
  path.join(marketplaceCacheAgentsDir(uid), id);
export const marketplaceCacheSkillDir  = (uid: string, id: string) =>
  path.join(marketplaceCacheSkillsDir(uid), id);
// Marketplace listing-grid cache: single JSON file storing the last `/list` response per
// (kind, category, q) key. Read at openMarketplace to render instantly; written on each
// fresh response. Under `cache/` umbrella so a "clear cache" wipe drops it.
export const marketplaceListingsCacheFile = (uid: string) =>
  path.join(marketplaceCacheDir(uid), 'listings.json');
// Marker dropped at the end of a successful default-install seed pass. Decoupled from
// `installs.json` (which gets mutated row-by-row during seed; a mid-write crash leaves a
// partial manifest). Presence of THIS file = "the entire seed completed at least once" —
// next launch skips seed; absence = "seed never finished, retry on next launch (add*Install
// is idempotent so re-runs are safe)". Under cloud/ so cross-device sync propagates "seeded
// already" once any device finishes the seed.
export const marketplaceDefaultsSeededFile = (uid: string) =>
  path.join(userMarketplaceDirCloud(uid), '.default-seeded.json');

// ── Marketplace install target (`<uid>/local/marketplace/`) ─────────────
// **Where actually-installed content lives on this machine.** Distinct from the cache above:
// cache holds anything the user has viewed; this holds anything the user has installed.
// Per-user and per-machine — multi-device install state is reconciled via the cloud-synced
// `installs.json` manifest below: each machine sees the same list of installed ids/urls and
// fetches whichever local copies are missing on startup (`features/marketplace_reconcile.ts`).
// Listed by `features/{agents,skills}.ts::list*` alongside cloud/{agents,skills}/ so installed
// items show under the "Platform" group in the UI.
export const userMarketplaceDir        = (uid: string) => path.join(userLocalRoot(uid), 'marketplace');
export const userMarketplaceAgentsDir  = (uid: string) => path.join(userMarketplaceDir(uid), 'agents');
export const userMarketplaceSkillsDir  = (uid: string) => path.join(userMarketplaceDir(uid), 'skills');
export const userMarketplaceAgentDir   = (uid: string, id: string) =>
  path.join(userMarketplaceAgentsDir(uid), id);
export const userMarketplaceAgentSkillsDir = (uid: string, id: string) =>
  path.join(userMarketplaceAgentDir(uid, id), 'skills');
export const userMarketplaceSkillDir   = (uid: string, id: string) =>
  path.join(userMarketplaceSkillsDir(uid), id);

// ── Marketplace install manifest (cloud-synced) ────────────────────────
// `<uid>/cloud/marketplace/installs.json` — the only marketplace state that crosses devices.
// Format: { version, agents:[{id, version, published_at, agent_json_url, installed_at}],
// skills:[{id, version, published_at, bundle_url, installed_at}] }. Used by
// `features/marketplace_reconcile.ts` to fetch missing content into `local/marketplace/`
// at startup. Touched by `features/marketplace_installs.ts` (single-writer for the file).
export const userMarketplaceDirCloud   = (uid: string) => path.join(userCloudRoot(uid), 'marketplace');
export const userMarketplaceInstallsFile = (uid: string) =>
  path.join(userMarketplaceDirCloud(uid), 'installs.json');

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
// can `--resume` through the CLI's own conversation memory.
// Lives under `local/` (NOT cloud-synced) because the session id
// references claude's machine-local session files (`~/.claude/...`)
// which aren't valid on a different device.
export const userLocalCliSessionsDir = (uid: string) =>
  path.join(userLocalRoot(uid), 'cli-sessions');
export const localCliSessionsFile = (uid: string, cid: string) =>
  path.join(userLocalCliSessionsDir(uid), `${cid}.json`);

// ── External packages (machine-private, verbatim third-party repos) ─────
// `<uid>/local/packages/<name>/` hosts a cloned open-source repo UNMODIFIED
// (including node_modules when consented — Python venvs live under top-level
// data/venv so they can be reused across Orkas accounts on this device).
// Package metadata lives OUTSIDE the package dirs in the
// sidecar `_registry.json` so `git pull` updates never conflict with Orkas
// bookkeeping. The registry is written only by `bin/orkas-pkg.cjs` (the
// bash-driven installer CLI); main-process code reads it via
// `features/packages.ts`. Marketplace reconcile must never touch this tree.
// `.bin/` holds generated shims for CLI-shaped packages; it is injected into
// the bash tool PATH (see `model/core-agent/client.ts`).
// See docs/plans/open-ecosystem-architecture.md §A.
export const userPackagesDir          = (uid: string) => path.join(userLocalRoot(uid), 'packages');
export const userPackageDir           = (uid: string, name: string) => path.join(userPackagesDir(uid), name);
export const userPackagesRegistryFile = (uid: string) => path.join(userPackagesDir(uid), '_registry.json');
export const userPackagesBinDir       = (uid: string) => path.join(userPackagesDir(uid), '.bin');

// ── CLI-package companion skills (machine-private, main+CLI-owned) ──────
// `<uid>/local/package_skills/<pkg>/SKILL.md` is an auto-authored usage skill
// that teaches the commander how to drive a CLI-only external package. It is
// kept OUTSIDE the verbatim `local/packages/<pkg>/` tree (which orkas-pkg.cjs
// never writes Orkas files into) and OUTSIDE cloud/ (so a machine-specific CLI
// wrapper never syncs to a device where the package is not installed). Written
// out-of-process by `bin/orkas-pkg.cjs skill-write`; read in main via
// `features/package_skills.ts`. Lifecycle is keyed to the package by dir name.
export const userPackageSkillsDir = (uid: string) => path.join(userLocalRoot(uid), 'package_skills');
export const userPackageSkillDir  = (uid: string, name: string) => path.join(userPackageSkillsDir(uid), name);

// ── Global skill roots (machine-global, read-only, outside WS_ROOT) ─────
// Skills the user already keeps for OTHER agent hosts on this machine, read
// purely for interop: `~/.claude/skills` (claude-code) and `~/.codex/skills`
// (codex). Both CLIs use the same `<id>/SKILL.md` layout, and each ships its
// system skills under a dot dir (`.system` etc.) which SkillLoader skips.
// There is intentionally NO Orkas-native `~/.orkas/skills` root: it was unused
// (no installer ever populated it) and only widened the untrusted-content
// attack surface, so it was dropped — Orkas skills live under the data root
// (custom / marketplace) or in tracked external packages instead. All roots
// here are READ-ONLY to Orkas: never write, normalize, or reconcile them.
// Gated by the `global_skill_roots_enabled` preference and injected only into
// in-app task/authoring sessions — never through the orkas-bridge, because
// each CLI reads its own global dir natively (see skill-registry.ts::listSkillsForBridge).
export const globalSkillRoots = (): string[] => [
  path.join(os.homedir(), '.claude', 'skills'),
  path.join(os.homedir(), '.codex', 'skills'),
];

// ── Global recycle bin (machine-private, user-managed) ──────────────────
// `<uid>/local/recycle/` stores recoverable snapshots for destructive
// actions. Sync-driven remote tombstones and in-app deletes both archive
// complete cloud-relative file sets here before unlinking from cloud/.
export const userRecycleDir = (uid: string) => path.join(userLocalRoot(uid), 'recycle');

// Per-user local workspace selection (features/user_workspace.ts): the
// absolute path of the folder the user picked + a recents list. Absolute
// paths are machine-specific, so this is never synced.
export const userWorkspaceConfigFile = (uid: string) => path.join(userLocalRoot(uid), 'workspace.json');

// Legacy one-time marker kept only so old installs/tests that reference the
// path do not break. Native pickers now always provide a safe Orkas-owned
// defaultPath and never intentionally hand off to the OS last-used directory.
export const pickerFirstOpenMarkerFile = (uid: string) => path.join(userLocalRoot(uid), '.picker-first-open-seeded');

// ── Expert signals (machine-private, append-only) ───────────────────────
// Per-day jsonl of T0/T1 user behavior signals emitted by bus.ts turn-end
// hook + IPC handlers (retry/skip/form/silence). Local-only: signals are
// extractor-version dependent and shouldn't cross devices; they're inputs
// to reflection / patch suggester / critic (phase 1+). See plan
// `Common/docs/plans/expert-signals-phase-0.md`. Daily rotation keeps query
// scoped to a date range; no archive sweep yet (50-200 KB/day × 365 ≈
// 18-73 MB/year is acceptable for append-only jsonl).
export const userSignalsDir = (uid: string) => path.join(userLocalRoot(uid), 'signals');
/** Returns `<signalsDir>/<yyyy-mm-dd>.jsonl`. `date` defaults to today (local). */
export const signalsDailyFile = (uid: string, date?: Date) => {
  const d = date || new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(userSignalsDir(uid), `${ymd}.jsonl`);
};

// ── Quality validator reports (machine-private) ──────────────────────────
// Per-spec ValidationReport produced by `src/main/quality/`. Local-only:
// validator version + ruleset are tied to the installed build, so a report
// from one machine isn't authoritative on another; the validator re-runs at
// every write anyway, so persistence is informational (UI rail / evolution
// signal source), not load-bearing. Only the latest report per spec is kept.
export const userQualityReportsDir = (uid: string) => path.join(userLocalRoot(uid), 'quality_reports');
export const userQualitySkillsDir  = (uid: string) => path.join(userQualityReportsDir(uid), 'skills');
export const userQualityAgentsDir  = (uid: string) => path.join(userQualityReportsDir(uid), 'agents');
export const qualitySkillReportFile = (uid: string, sid: string) =>
  path.join(userQualitySkillsDir(uid), `${sid}.json`);
export const qualityAgentReportFile = (uid: string, aid: string) =>
  path.join(userQualityAgentsDir(uid), `${aid}.json`);

// ── Multi-device sync (machine-private state) ────────────────────────────
// `<uid>/local/sync/` is the engine's per-machine bookkeeping; nothing here
// crosses devices (per plan §3.2). `index.json` is the last-synced snapshot
// (path → {sha256, size, mtime_ms, _v, compressed}), `state.json` carries
// generation / pending_uploads / device_id, and `conflicts/` retains
// overwritten versions. Recoverable deletes live in `local/recycle/`, shared
// with in-app deletes.
export const userSyncDir          = (uid: string) => path.join(userLocalRoot(uid), 'sync');
export const userSyncIndexFile    = (uid: string) => path.join(userSyncDir(uid), 'index.json');
export const userSyncStateFile    = (uid: string) => path.join(userSyncDir(uid), 'state.json');
export const userSyncConflictsDir = (uid: string) => path.join(userSyncDir(uid), 'conflicts');
// Legacy location; new batches are written to userRecycleDir().
export const userSyncRecycleDir   = (uid: string) => path.join(userSyncDir(uid), 'recycle');
// Cached copy of the last-fetched cloud manifest. Read on engine startup so
// the settings card's storage breakdown can render instantly without
// waiting for a network round-trip. Refreshed at the end of every
// successful sync pass.
export const userSyncManifestCacheFile = (uid: string) =>
  path.join(userSyncDir(uid), 'manifest_cached.json');

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

/** Runtime binaries shipped via electron-builder `extraResources`.
 *
 *   dev:    PC/resources/runtime/
 *   packed: <app>/Contents/Resources/runtime/      (darwin)
 *           <app>/resources/runtime/               (win/linux)
 */
export function runtimeResourcesDir(): string {
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (rp && !rp.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`)) {
    return path.join(rp, 'runtime');
  }
  return path.join(PC_ROOT, 'resources', 'runtime');
}

/** `${process.platform}-${process.arch}` → vendored OfficeCLI asset name.
 *  Mirrors `scripts/fetch-officecli.cjs`. Desktop targets only (mac + win). */
const OFFICECLI_ASSETS: Readonly<Record<string, string>> = {
  'darwin-arm64': 'officecli-mac-arm64',
  'darwin-x64': 'officecli-mac-x64',
  'win32-x64': 'officecli-win-x64.exe',
  'win32-arm64': 'officecli-win-arm64.exe',
};

/** Absolute path to the OfficeCLI binary for the current platform/arch, or
 *  null when no asset ships for it. Shipped via electron-builder
 *  `extraResources`:
 *    dev:    PC/resources/officecli/
 *    packed: <app>/Contents/Resources/officecli/   (darwin)
 *            <app>/resources/officecli/             (win)
 */
export function officeCliBinaryPath(): string | null {
  const asset = OFFICECLI_ASSETS[`${process.platform}-${process.arch}`];
  if (!asset) return null;
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const dir = (rp && !rp.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`))
    ? path.join(rp, 'officecli')
    : path.join(PC_ROOT, 'resources', 'officecli');
  return path.join(dir, asset);
}

// Builtin marketplace resources under `resources/builtin/marketplace/` are only
// a first-run/offline seed. Installed runtime content still lands in
// `<uid>/local/marketplace/` and is reconciled from the cloud manifest.

// ── User workspace (user-facing working directory for agent output) ──────
// Default: `userWorkSpace/` next to the workspace root (i.e. inside the
// install container, sibling of `data/`). The actual per-user selection is
// stored in a JSON config managed by features/user_workspace.ts; this
// constant is only the fallback default.
export const DEFAULT_USER_WORKSPACE = path.join(WS_ROOT, '..', 'userWorkSpace');

// ── Init: mkdir the top-level skeleton ───────────────────────────────────
// Only the top-level shared directories are created here; per-uid sub-trees
// are mkdir'd on demand by `features/users.activateUser(uid)`.
export function ensureTopLevelLayout(): void {
  for (const d of [LOGS_DIR, VENV_ROOT, DEFAULT_USER_WORKSPACE]) {
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
    userChatArtifactsDir(uid),
    userSavedAppsDir(uid),
    userSessionsDir(uid),
    userContextsDir(uid),
    userKbDir(uid),
    userMemoryDir(uid),
    userAgentsDir(uid),
    userSkillsDir(uid),
    userProjectsDir(uid),
    userMarketplaceAgentsDir(uid),
    userMarketplaceSkillsDir(uid),
    userSystemSkillsDir(uid),
    userMarketplaceDirCloud(uid),
    // userMetaDir is deprecated — per-agent meta now lands in the
    // `agents/<aid>/meta/` sub-directory, mkdir'd on demand at agent
    // creation time, so no top-level placeholder is required.
    userCloudConfigDir(uid),
    userLocalConfigDir(uid),
    userSearchDir(uid),
    userTestDir(uid),
    userFileCacheDir(uid),
    userToolResultsDir(uid),
    userSyncDir(uid),
    userSyncConflictsDir(uid),
    userLocalContextsDir(uid),
    userKbDir(uid),
    userQualitySkillsDir(uid),
    userQualityAgentsDir(uid),
    userSignalsDir(uid),
    userPackagesDir(uid),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });

  // Legacy sweep: `contexts_tmp/` was the staging area for the retired
  // two-region KB design (see features/contexts.ts header). Older builds
  // created the empty dir on every activate; remove it once if still
  // present + empty, leave it alone if a user somehow stuffed files there.
  const legacyContextsTmp = path.join(userLocalRoot(uid), 'contexts_tmp');
  try { fs.rmdirSync(legacyContextsTmp); } catch { /* ENOENT or ENOTEMPTY — both fine */ }
}
