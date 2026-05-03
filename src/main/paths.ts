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
 *       users.json                ← 本机 uid 注册表 + current_user_id
 *       logs/                     ← 本机日志（全局按天滚动）
 *       builtin/                  ← 本机公共 builtin 运行时副本（启动 hash 同步自 src/builtin/）
 *         agents/<agent_id>/
 *         skills/<skill_id>/
 *       <user_id>/
 *         cloud/                  ← ☁️ 云同步域（账号体系落地后按 uid / 组织 / 团队同步）
 *           chats/  chat_attachments/  sessions/  contexts/  memory/
 *           agents/<agent_id>/  skills/<skill_id>/  meta/<agent_id>/
 *           config/preferences.json
 *         local/                  ← 🔒 本机域（永不同步）
 *           contexts_tmp/
 *           config/               ← auth-profiles.json + web-search-cache.json
 *           search/               ← contexts / chats / skill_chats / agent_chats idx
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
// 磁盘目录名是 `data/`；常量名仍叫 WS_ROOT（"workspace root" 的历史缩写，
// 内部 TS 符号，不参与 user-facing 命名）。env var `ORKAS_WORKSPACE_ROOT`
// 同样保留旧名以便 deploy 端无感升级。
export const WS_ROOT = process.env.ORKAS_WORKSPACE_ROOT
  ? path.resolve(process.env.ORKAS_WORKSPACE_ROOT)
  : path.join(PC_ROOT, 'data');

// ── Top-level (本机全局，多 uid 共享) ────────────────────────────────────
// 本机 uid 注册表：{ current_user_id, users: [{user_id, created_at}, ...] }
export const USERS_FILE        = path.join(WS_ROOT, 'users.json');
// 本机日志（按天滚动，全局一份，多 uid 共享）
export const LOGS_DIR          = path.join(WS_ROOT, 'logs');
// Builtin 运行时副本：启动时由 `src/builtin/` 按 hash 同步到这里，
// 所有 uid 共享读取；loader 扫描路径为 `[<uid>/cloud/{skills,agents}, <BUILTIN_{SKILLS,AGENTS}_DIR>]`。
export const BUILTIN_ROOT        = path.join(WS_ROOT, 'builtin');
export const BUILTIN_AGENTS_DIR  = path.join(BUILTIN_ROOT, 'agents');
export const BUILTIN_SKILLS_DIR  = path.join(BUILTIN_ROOT, 'skills');
// builtin agent 同样目录形态：`<BUILTIN_AGENTS_DIR>/<aid>/agent.json`。
// runtime 子目录（meta / skills）只存在于 user cloud 侧，builtin 侧不携带。
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

// Group-chat per-conversation附属目录树。`<cid>.jsonl` 在 userChatsDir 同级；
// 该目录承载群级元数据（members/state/plan）+ 每个 actor 的可见性切片。
// 详见 features/group_chat/ 与 CLAUDE.md §5。
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

// 已整理知识库（contexts 两区的 organized 区）
export const userContextsDir        = (uid: string) => path.join(userCloudRoot(uid), 'contexts');

// 知识库本地向量库（纳入云同步域，与文本内容同目录树；冲突时 mtime 胜出）。
// 隐藏子目录 `.kb/` 避开 contexts 的用户可见列表（listContextsTree 已过滤 dot）。
// 运行时 WAL/SHM 旁落文件不纳入同步。
export const userKbDir           = (uid: string) => path.join(userContextsDir(uid), '.kb');
export const userKbVectorDbPath  = (uid: string) => path.join(userKbDir(uid), 'vector.db');
export const userKbConfigPath    = (uid: string) => path.join(userKbDir(uid), 'config.json');

// Cross-session memory
export const userMemoryDir   = (uid: string) => path.join(userCloudRoot(uid), 'memory');
export const userMemoryFile  = (uid: string) => path.join(userMemoryDir(uid), 'MEMORY.md');
export const userProfileFile = (uid: string) => path.join(userMemoryDir(uid), 'USER.md');

// 用户自定义 agents / skills（业务语义 kind='custom'；loader 扫描时 cloud 优先）。
// agent 走目录形态：`agents/<aid>/{agent.json, meta/, skills/}` —— 详见
// CLAUDE.md §4 + docs/plans/agent-as-directory.md。spec 是用户给的、meta 与
// skills 是 runtime 动态产物（元认知 + agent 自演进 skill）。
export const userAgentsDir = (uid: string) => path.join(userCloudRoot(uid), 'agents');
export const userSkillsDir = (uid: string) => path.join(userCloudRoot(uid), 'skills');
export const agentDir            = (uid: string, agentId: string) => path.join(userAgentsDir(uid), agentId || '_default');
export const agentDefinitionFile = (uid: string, agentId: string) => path.join(agentDir(uid, agentId), 'agent.json');

// Agent metacognition (per-agent self-assessment + learning strategies)。
// 写入靠 features/metacognition.ts；reflection-trigger 自动触发 +
// `metacognition` tool 让 agent 自维护。
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

// ── Local-only per-user (不同步) ─────────────────────────────────────────
// 待整理中转区（本地工作区，不云同步）
export const userContextsTmpDir = (uid: string) => path.join(userLocalRoot(uid), 'contexts_tmp');

// 本机凭证 + provider 缓存：CORE_AGENT_AUTH_DIR 由 activateUser() pin 到这里，
// core-agent 的 auth store 与 web-search provider cache 都落在同一目录。
export const userLocalConfigDir   = (uid: string) => path.join(userLocalRoot(uid), 'config');
export const userAuthProfilesFile = (uid: string) => path.join(userLocalConfigDir(uid), 'auth-profiles.json');
export const userWebSearchCache   = (uid: string) => path.join(userLocalConfigDir(uid), 'web-search-cache.json');
export const userReflectionStateFile = (uid: string) => path.join(userLocalConfigDir(uid), 'reflection-state.json');

// 本地搜索索引（派生数据，reconcile 自愈，永不同步）
export const userSearchDir           = (uid: string) => path.join(userLocalRoot(uid), 'search');
export const userContextsIndexPath   = (uid: string) => path.join(userSearchDir(uid), 'contexts.idx.json');
export const userChatsIndexPath      = (uid: string) => path.join(userSearchDir(uid), 'chats.idx.json');
export const userSkillChatsIndexPath = (uid: string) => path.join(userSearchDir(uid), 'skill_chats.idx.json');
export const userAgentChatsIndexPath = (uid: string) => path.join(userSearchDir(uid), 'agent_chats.idx.json');

// 超大工具输出（>50K 字符）落盘副本：tool_result 里只留 preview + 文件引用，
// 模型真要看完整原文时调 read_file(path) 拉回。按 session_id 分子目录，
// 启动期 `sweepToolResults(uid)` 按 mtime 清 7 天以上。永不同步。
export const userToolResultsDir = (uid: string) => path.join(userLocalRoot(uid), 'tool-results');
export const sessionToolResultsDir = (uid: string, sessionId: string) =>
  path.join(userToolResultsDir(uid), sessionId);

// workspace / 外部路径文件的按需预处理缓存（features/file_indexer.ts）。
// key = sha1(absPath).slice(0,16) 作为子目录名；每条目含 meta.json /
// chunk.NNN.md / image.jpg / processed.<taskHash>.md 四类产物。
// 永不同步 —— 源路径是本机绝对路径。
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

// 用户本机工作区选择（features/user_workspace.ts）：用户挑的文件夹绝对路径 +
// 最近列表。绝对路径本机相关，不同步。
export const userWorkspaceConfigFile = (uid: string) => path.join(userLocalRoot(uid), 'workspace.json');

// ── Build-time resources (shipped with installer, read-only) ────────────
// 95MB ONNX embedding model 走 electron-builder 的 `extraResources`，
// 不经 asar；dev / 打包两条路径不同：
//   dev:    PC/resources/embedding-model/
//   packed: <app>/Contents/Resources/embedding-model/      (darwin)
//           <app>/resources/embedding-model/               (win/linux)
// 这里故意不依赖 electron.app —— 便于单测/脚本环境使用。`process.resourcesPath`
// 只在 Electron runtime 存在；dev 下走仓库布局。
export function embeddingModelDir(): string {
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (rp && !rp.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`)) {
    // 打包态：process.resourcesPath 指向 app.Resources
    return path.join(rp, 'embedding-model');
  }
  // dev 态（Electron 跑 electron-stub 时 resourcesPath 指向 electron 自身，
  // 上面那一行会过滤掉；其它 tsx / node 脚本里 resourcesPath 不存在）。
  return path.join(PC_ROOT, 'resources', 'embedding-model');
}

// ── Builtin source dirs (shipped, read-only in packaged app) ─────────────
// 源码全部收在 SRC_ROOT 下，`builtin/` 也随之；打包时 electron-builder 按
// `src/builtin/**` glob 打入 asar。用户 override ORKAS_BUILTIN_ROOT 时仍
// 用原样，不经 SRC_ROOT。
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
// 只建顶层公共目录；uid 子目录由 `features/users.activateUser(uid)` 按需 mkdir。
export function ensureTopLevelLayout(): void {
  for (const d of [LOGS_DIR, BUILTIN_AGENTS_DIR, BUILTIN_SKILLS_DIR, DEFAULT_USER_WORKSPACE]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

// Mkdir on module load — keeps legacy behavior of "paths.ts import = dir ready".
ensureTopLevelLayout();

// ── Per-user layout (called by activateUser) ─────────────────────────────
// 单 uid 目录骨架：所有 `<uid>/cloud/*` + `<uid>/local/*` 子目录。
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
    // userMetaDir 已废弃 —— per-agent meta 落 `agents/<aid>/meta/` 子目录,
    // agent 创建时按需 mkdir,不需要顶层占位。
    userCloudConfigDir(uid),
    userContextsTmpDir(uid),
    userLocalConfigDir(uid),
    userSearchDir(uid),
    userFileCacheDir(uid),
    userToolResultsDir(uid),
  ];
  for (const d of dirs) fs.mkdirSync(d, { recursive: true });
}
