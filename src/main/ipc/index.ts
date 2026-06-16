/**
 * IPC wiring — replaces `bridge/routes.py` for the Electron era.
 *
 * Two channel families:
 *   - `orkas.invoke` (request/response): renderer → main with a logical
 *     channel name + payload; main returns `{ ok, ...result }` or
 *     `{ ok: false, error }`.
 *   - `orkas.streamStart` (server-push events): renderer registers a
 *     unique `requestId`, main pushes each event via `webContents.send`
 *     on channel `stream:<requestId>`, terminated by `{ type: 'done' }`.
 *     `orkas.streamCancel` aborts an in-flight stream.
 *
 * Handler tables below are the full router — add a new logical channel by
 * dropping it into `invokeHandlers` or `streamHandlers`.
 */

import { app, ipcMain, dialog, BrowserWindow, type WebContents } from 'electron';

import * as users from '../features/users';
import * as chats from '../features/chats';
import * as projects from '../features/projects';
import * as projectFiles from '../features/project_files';
import * as projectLibraryIndexer from '../features/project_library_indexer';
import * as groupChat from '../features/group_chat';
import type { GroupEvent } from '../features/group_chat/bus';
import * as agents from '../features/agents';
import * as autoTasks from '../features/auto_tasks';
import { isAgentEnabled } from '../features/component_enabled';
import * as skills from '../features/skills';
import * as marketplace from '../features/marketplace';
import * as marketplaceBiz from '../features/marketplace_biz';
import * as marketplaceCache from '../features/marketplace_cache';
import * as marketplaceReconcile from '../features/marketplace_reconcile';
import * as cacheClearable from '../features/cache_clearable';
import * as contexts from '../features/contexts';
import * as kbVector from '../features/kb_vector';
import * as kbIndexer from '../features/kb_indexer';
import * as chatAttachments from '../features/chat_attachments';
import * as chatArtifacts from '../features/chat_artifacts';
import * as conversationFiles from '../features/conversation_files';
import * as savedApps from '../features/saved_apps';
import * as recycleBin from '../features/recycle_bin';
import * as search from '../features/search';
import * as auth from '../features/auth';
import * as imageAuth from '../features/image_auth';
import * as searchAuth from '../features/search_auth';
import * as permissions from '../features/permissions';
import * as appConfig from '../features/config';
import * as avatars from '../features/avatars';
import { getRendererTables, isLang, t } from '../i18n';
import { isPathAllowed } from '../util/path-sandbox';
import * as userWorkspace from '../features/user_workspace';
import { invokeHandlers as localAgentsHandlers } from './local_agents';
import { invokeHandlers as qualityHandlers } from './quality';
import { invokeHandlers as connectorsHandlers } from './connectors';
import { invokeHandlers as memoryHandlers } from './memory';
import { safeId } from '../storage';
import { createLogger, logFromRenderer } from '../logger';
import { resolveConfirmation as resolveDeleteConfirmation } from '../model/core-agent/delete-file-confirm';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { shell } from 'electron';
import { WS_ROOT, chatAttachmentDir, projectFilesDir } from '../paths';
import { readState as readGroupChatState } from '../features/group_chat/state';
import { readPlan as readGroupChatPlan } from '../features/group_chat/plan';
import { logErrorRef } from '../util/log-redact';

const log = createLogger('ipc');

function markPreferencesDirty(): void {}

interface IpcContext {
  userId: string;
  user: { user_id: string; created_at: string };
  sender: WebContents;
}

type InvokeHandler = (payload: any, ctx: IpcContext) => Promise<any>;
type StreamHandler = (
  payload: any,
  ctx: IpcContext,
  signal: AbortSignal,
) => AsyncGenerator<any, void, unknown>;

const CHAT_PICK_EXTENSIONS = [
  'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log',
  'pdf', 'docx',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
  'mp4', 'webm', 'mov', 'm4v', 'ogv',
];
const CONTEXT_PICK_EXTENSIONS = [
  'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log',
  'html', 'htm', 'xml', 'toml', 'ini', 'conf',
  'py', 'pyi', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'sh', 'bash', 'zsh', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'cpp', 'cc', 'h', 'hpp', 'css', 'scss', 'less',
  'sql', 'graphql', 'gql',
  'pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'gif',
];
const PROJECT_PICK_EXTENSIONS = [
  ...CONTEXT_PICK_EXTENSIONS,
  'mp4', 'webm', 'mov', 'm4v', 'ogv',
];

async function _pickLocalFiles(
  title: string,
  extensions: string[],
  multiSelections = true,
): Promise<string[]> {
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const ext = Array.from(new Set(extensions.map((x) => String(x || '').replace(/^\./, '').toLowerCase()).filter(Boolean)));
  const opts: Electron.OpenDialogOptions = {
    title,
    properties: multiSelections ? ['openFile', 'multiSelections'] : ['openFile'],
    filters: ext.length ? [{ name: 'Supported files', extensions: ext }] : undefined,
  };
  const res = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  if (res.canceled || !res.filePaths?.length) return [];
  return res.filePaths;
}

function _targetInDir(targetDir: unknown, baseName: string): string {
  const dir = typeof targetDir === 'string' ? targetDir.trim().replace(/^\/+|\/+$/g, '') : '';
  return dir ? `${dir}/${baseName}` : baseName;
}

// Resolve the workspace scope hint a renderer payload carries. cid is
// authoritative (conv.project_id is the truth, so a cid uniquely picks a
// project); projectId is the fallback for commander-tab clicks where no cid
// exists yet. Returns `undefined` for default scope.
async function _resolveWorkspaceScope(
  userId: string,
  payload: any,
): Promise<string | undefined> {
  if (payload && typeof payload.cid === 'string' && payload.cid && safeId(payload.cid)) {
    return await userWorkspace.resolveProjectIdForCid(userId, payload.cid);
  }
  if (payload && typeof payload.projectId === 'string' && payload.projectId && safeId(payload.projectId)) {
    return payload.projectId;
  }
  return undefined;
}

// Resolve the cid-scoped attachment dir from a renderer payload, when present.
// The file-tools' allowed-paths scope is "active workspace ∪ this cid's
// attachment dir" (CLAUDE.md §5); reveal + preview must honour the same
// union so a user can preview an attachment they uploaded, not just files
// the LLM wrote into the workspace.
function _attachmentScopeForPayload(userId: string, payload: any): string | null {
  if (!payload || typeof payload.cid !== 'string' || !payload.cid) return null;
  if (!safeId(payload.cid)) return null;
  return path.resolve(chatAttachmentDir(userId, payload.cid));
}

// Project-file scope for sandbox checks. Takes the already-resolved projectId
// (computed by `_resolveWorkspaceScope`, which is cid-authoritative) rather
// than reading payload.projectId directly — this enforces that a caller
// passing `{cid, projectId}` where conv-cid.project_id !== projectId cannot
// reach a foreign project's files (the cid wins, the claimed projectId
// silently drops). When no cid is in payload, `_resolveWorkspaceScope`
// already falls back to payload.projectId, so the commander-tab path
// (project chip click before any conversation exists) continues to work.
function _projectFileScopeForUser(userId: string, projectId: string | undefined): string | null {
  if (!projectId || !safeId(projectId)) return null;
  return path.resolve(projectFilesDir(userId, projectId));
}

/** Build the allowed-roots list for the file-class IPC sandbox: workspace ∪
 *  current cid's attachment dir ∪ payload's project-file dir. The actual
 *  containment check happens via `util/path-sandbox.isPathAllowed`, which
 *  realpath-resolves both candidate and roots so a symlink planted inside
 *  any allowed root cannot exfiltrate to a path outside.
 *
 *  Centralised for `conversations.attachments.import` / `workspace.revealPath`
 *  / `produced.readText` / `produced.writeText` so the scope union stays in
 *  sync. Previously each handler did its own `path.resolve(target).startsWith(
 *  scope + path.sep)` triplet — lexical only, which let a symlink target
 *  outside the scope quietly slip through under a `<uid>` workspace path
 *  that itself contained one (the realistic attack: LLM-assisted skill
 *  drops a symlink into an attachment dir; user later writes to the
 *  apparent path through `produced.writeText` and the bytes land at
 *  attacker-chosen target). */
async function _ipcFileSandboxAllowedRoots(userId: string, payload: any): Promise<string[]> {
  const projectId = await _resolveWorkspaceScope(userId, payload);
  const roots: string[] = [userWorkspace.getWorkspacePath(userId, projectId)];
  const att = _attachmentScopeForPayload(userId, payload);
  if (att) roots.push(att);
  const pf = _projectFileScopeForUser(userId, projectId);
  if (pf) roots.push(pf);
  return roots;
}

/** Test-only export — see `test/main/ipc/{produced-readText,workspace-reveal}.test.ts`. */
export const _ipcFileSandboxAllowedRootsForTest = _ipcFileSandboxAllowedRoots;

async function _isConversationRecordedFile(userId: string, cid: string, absPath: string): Promise<boolean> {
  if (!safeId(cid)) return false;
  const target = path.resolve(absPath);
  const matches = (value: unknown): boolean =>
    typeof value === 'string' && !!value && path.resolve(value) === target;

  try {
    const messages = await chats.getMessages(userId, cid, 2000);
    for (const msg of messages as any[]) {
      const produced = Array.isArray(msg?.produced) ? msg.produced : [];
      if (produced.some(matches)) return true;
    }
  } catch { /* best-effort allow-list */ }

  try {
    const plan = await readGroupChatPlan(userId, cid);
    for (const step of plan?.steps || []) {
      const files = Array.isArray(step.output_files) ? step.output_files : [];
      if (files.some(matches)) return true;
    }
  } catch { /* best-effort allow-list */ }

  return false;
}

async function _isAllowedFileActionPath(userId: string, payload: any, absPath: string): Promise<boolean> {
  if (isPathAllowed(absPath, await _ipcFileSandboxAllowedRoots(userId, payload))) return true;
  const cid = payload?.cid;
  return typeof cid === 'string' && !!cid && await _isConversationRecordedFile(userId, cid, absPath);
}

function _contextTreeHasPath(nodes: contexts.ContextNode[], relPath: string): boolean {
  for (const node of nodes || []) {
    if (node.path === relPath) return true;
    if (node.type === 'dir' && node.children?.length && _contextTreeHasPath(node.children, relPath)) return true;
  }
  return false;
}

function _uniqueContextImportPath(rawName: string): string {
  const name = path.basename(String(rawName || '').trim() || 'artifact');
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  const tree = contexts.listContextsTree();
  if (!_contextTreeHasPath(tree, name)) return name;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    if (!_contextTreeHasPath(tree, candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${ext}`;
}

function _libraryImportTargetName(payload: any, sourcePath: string): string {
  const raw = typeof payload?.targetPath === 'string' && payload.targetPath.trim()
    ? payload.targetPath.trim()
    : (typeof payload?.name === 'string' && payload.name.trim() ? payload.name.trim() : path.basename(sourcePath));
  return raw || path.basename(sourcePath) || 'artifact';
}

function _libraryTextTargetName(payload: any): string {
  const raw = typeof payload?.targetPath === 'string' && payload.targetPath.trim()
    ? payload.targetPath.trim()
    : (typeof payload?.path === 'string' && payload.path.trim() ? payload.path.trim() : '');
  return raw || 'archive.md';
}

async function _resolveLibraryTargetProjectId(userId: string, payload: any): Promise<string | undefined> {
  const requestedScope = payload?.targetScope && typeof payload.targetScope === 'object'
    ? payload.targetScope
    : null;
  const cidProjectId = await _resolveWorkspaceScope(userId, payload);
  let projectId: string | undefined = cidProjectId;
  if (requestedScope?.type === 'global') projectId = undefined;
  if (requestedScope?.type === 'project' && typeof requestedScope.projectId === 'string' && safeId(requestedScope.projectId)) {
    projectId = requestedScope.projectId;
  }
  return projectId;
}

async function _importProducedToLibrary(payload: any, ctx: IpcContext): Promise<any> {
  const target = payload?.path;
  if (typeof target !== 'string' || !target) throw new Error('missing path');
  const norm = path.resolve(target);
  if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
    throw new Error('path is outside the user workspace');
  }
  let st: fs.Stats;
  try { st = fs.statSync(norm); }
  catch { return { ok: false, error: 'not_found' }; }
  if (!st.isFile()) return { ok: false, error: 'not_supported' };

  const projectId = await _resolveLibraryTargetProjectId(ctx.userId, payload);
  const buf = fs.readFileSync(norm);
  const targetName = _libraryImportTargetName(payload, norm);
  if (projectId) {
    const result = await projectFiles.uploadProjectFile(ctx.userId, projectId, targetName, buf);
    if (!result.ok) return result;
    return { ok: true, scope: 'project', projectId, info: result.info };
  }

  const relPath = typeof payload?.targetPath === 'string' && payload.targetPath.trim()
    ? payload.targetPath.trim()
    : _uniqueContextImportPath(targetName);
  const result = contexts.uploadContextFile(relPath, buf);
  if (!result.ok) return result;
  return { ok: true, scope: 'global', path: result.path, bytes: result.bytes };
}

async function _writeTextToLibrary(payload: any, ctx: IpcContext): Promise<any> {
  const content = typeof payload?.content === 'string' ? payload.content : '';
  const targetName = _libraryTextTargetName(payload);
  const projectId = await _resolveLibraryTargetProjectId(ctx.userId, payload);
  if (projectId) {
    const result = await projectFiles.uploadProjectFile(ctx.userId, projectId, targetName, Buffer.from(content, 'utf8'));
    if (!result.ok) return result;
    return { ok: true, scope: 'project', projectId, info: result.info };
  }

  const result = contexts.writeContextFile(targetName, content);
  if (!result.ok) return result;
  return { ok: true, scope: 'global', path: result.path };
}

export const _libraryWriteTextForTest = _writeTextToLibrary;
export const _libraryImportProducedForTest = _importProducedToLibrary;

function _recycleDataChangeForPaths(paths: string[]): { domains: string[]; cids: string[]; recycle: true } {
  const domains = new Set<string>();
  const cids = new Set<string>();
  for (const raw of paths || []) {
    const rel = String(raw || '').replace(/\\/g, '/');
    if (!rel.startsWith('cloud/')) continue;
    const first = rel.slice('cloud/'.length).split('/', 1)[0];
    if (first === 'chats' || first === 'chat_attachments' || first === 'chat_artifacts' || first === 'sessions') {
      domains.add('chats');
    } else if (first === 'contexts') domains.add('contexts');
    else if (first === 'projects') domains.add('projects');
    else if (first === 'auto_tasks') domains.add('auto_tasks');
    else if (first === 'saved_apps') domains.add('saved_apps');
    else if (first === 'agents') domains.add('agents');
    else if (first === 'skills') domains.add('skills');
    else if (first === 'marketplace') domains.add('marketplace');
    else if (first === 'config') domains.add('component_enabled');

    const chatFile = /^cloud\/chats\/([^/]+)\.jsonl$/.exec(rel);
    const chatDir = /^cloud\/chats\/([^/]+)\//.exec(rel);
    const chatPool = /^cloud\/chat_(?:attachments|artifacts)\/([^/]+)\//.exec(rel);
    const cid = chatFile?.[1] || chatDir?.[1] || chatPool?.[1] || '';
    if (cid && safeId(cid) && cid !== 'agent' && cid !== 'skill') cids.add(cid);
  }
  return { domains: Array.from(domains), cids: Array.from(cids), recycle: true };
}

function _codedError(code: string): Error & { code: string } {
  const err = new Error(code) as Error & { code: string };
  err.code = code;
  return err;
}

async function _afterRecycleRestore(ctx: IpcContext, paths: string[]): Promise<void> {
  const change = _recycleDataChangeForPaths(paths);
  for (const raw of paths || []) {
    const rel = String(raw || '').replace(/\\/g, '/');
    if (rel.startsWith('cloud/contexts/')) {
      const ctxRel = rel.slice('cloud/contexts/'.length);
      if (ctxRel) {
        search.upsertContext(ctx.userId, ctxRel);
        kbIndexer.enqueue(ctx.userId, ctxRel, 'upsert');
      }
    }
    const projectFile = /^cloud\/projects\/([^/]+)\/files\/(.+)$/.exec(rel);
    if (projectFile && safeId(projectFile[1]) && projectFile[2]) {
      projectLibraryIndexer.enqueue(ctx.userId, projectFile[1], projectFile[2], 'upsert');
    }
  }
  if (change.domains.includes('agents')) {
    try { agents.invalidateAgentListCache(); } catch { /* best-effort cache bust */ }
  }
  if (change.domains.includes('skills')) {
    try { skills.clearSkillListCache(); } catch { /* best-effort cache bust */ }
  }
  if (change.domains.includes('auto_tasks')) {
    autoTasks.rescheduleAllForActiveUser().catch((err) => {
      log.warn('auto task reschedule after recycle restore failed', { error: logErrorRef(err) });
    });
  }
  void change;
}

// ── Invoke handlers ──────────────────────────────────────────────────────
// Contract: `(payload, { userId, sender }) => result` where result is
// merged into a `{ ok: true, ...result }` response. Throw to signal error.

const invokeHandlers: Record<string, InvokeHandler> = {
  'user.init': async () => {
    const user = await users.getOrCreateSelfUser();
    return user;
  },

  'conversations.list': async (_payload, ctx) => {
    return { conversations: await chats.listConversations(ctx.userId) };
  },

  'conversations.get': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const conv = await chats.getConversation(ctx.userId, cid);
    if (!conv) throw new Error('conversation not found');
    return { conversation: conv };
  },

  'conversations.history': async ({ cid, limit = 500 }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const conv = await chats.getConversation(ctx.userId, cid);
    if (!conv) throw new Error('conversation not found');
    // Stamp the conv-bound agent's current enabled state so the renderer can
    // grey out the input + show a banner without making a second IPC round trip.
    // True for unbound (no agent_id) — input always allowed there.
    const agent_enabled = conv.agent_id ? isAgentEnabled(ctx.userId, conv.agent_id) : true;
    const runtime = await groupChat.runtimeStatus(ctx.userId, cid);
    return {
      conversation: { ...conv, ...runtime, agent_enabled },
      history: await chats.getMessages(ctx.userId, cid, limit),
    };
  },

  'conversations.files.list': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const projectId = await userWorkspace.resolveProjectIdForCid(ctx.userId, cid);
    const workspaceRoot = userWorkspace.getWorkspacePath(ctx.userId, projectId);
    const state = await readGroupChatState(ctx.userId, cid);
    const root = state.workspace_dir
      ? path.join(workspaceRoot, state.workspace_dir)
      : workspaceRoot;
    return conversationFiles.listWorkspaceFiles(root);
  },

  'conversations.create': async ({ title = '', projectId = '' } = {}, ctx) => {
    // Validate the projectId belongs to this user before persisting it on
    // the conv record. Unknown / invalid projectIds are dropped silently
    // (the conv lands without project membership) — the renderer should
    // not be able to put a conv into a project the backend doesn't know
    // about, but a stale / since-deleted pid coming from the commander chip
    // shouldn't fail the create either.
    let validProjectId = '';
    if (projectId && typeof projectId === 'string' && safeId(projectId)) {
      if (await projects.projectExists(ctx.userId, projectId)) validProjectId = projectId;
    }
    const conv = await chats.createConversation(ctx.userId, {
      kind: 'normal',
      title,
      ...(validProjectId ? { projectId: validProjectId } : {}),
    });
    return { conversation: conv };
  },

  'conversations.delete': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    await recycleBin.createAppRecycleBatchForConversation(ctx.userId, cid);
    const ok = await chats.deleteConversation(ctx.userId, cid);
    return { deleted: ok };
  },

  'conversations.pin': async ({ cid, pinned }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const conv = await chats.setConversationPinned(ctx.userId, cid, !!pinned);
    if (!conv) throw new Error('conversation not found');
    return { conversation: conv };
  },

  'conversations.rename': async ({ cid, title }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const conv = await chats.renameConversation(ctx.userId, cid, title);
    if (!conv) throw new Error('conversation not found');
    return { conversation: conv };
  },

  'conversations.deleteAll': async (_args, ctx) => {
    const convs = await chats.listConversations(ctx.userId);
    await recycleBin.createAppRecycleBatchForConversations(
      ctx.userId,
      convs.map((c) => c.conversation_id),
    );
    const deleted = await chats.deleteAllConversations(ctx.userId);
    return { deleted };
  },

  // ── Projects (logical groups of conversations + scoped workspace) ──
  'projects.list': async (_payload, ctx) => {
    return { projects: await projects.listProjects(ctx.userId) };
  },

  'projects.create': async ({ name }, ctx) => {
    const result = await projects.createProject(ctx.userId, name);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { project: result.project };
  },

  'projects.rename': async ({ projectId, name }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    const result = await projects.renameProject(ctx.userId, projectId, name);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { project: result.project };
  },

  'projects.delete': async ({ projectId }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    const batch = await recycleBin.createAppRecycleBatchForProject(ctx.userId, projectId);
    if (!batch?.items?.length) throw _codedError('recycle_archive_failed');
    const result = await projects.deleteProject(ctx.userId, projectId);
    if (!result.ok) {
      await recycleBin.deleteRecycleBatch(ctx.userId, batch.id).catch(() => {});
      throw new Error((result as { error: string }).error);
    }
    return { deleted_convs: result.deleted_convs, deleted_auto_tasks: result.deleted_auto_tasks };
  },

  'projects.get': async ({ projectId }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    const project = await projects.getProject(ctx.userId, projectId);
    if (!project) throw new Error('not_found');
    return { project };
  },

  'projects.files.list': async ({ projectId }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (!await projects.projectExists(ctx.userId, projectId)) throw new Error('not_found');
    return { files: await projectFiles.listProjectFiles(ctx.userId, projectId) };
  },

  'projects.files.tree': async ({ projectId }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (!await projects.projectExists(ctx.userId, projectId)) throw new Error('not_found');
    return { tree: await projectFiles.listProjectFileTree(ctx.userId, projectId) };
  },

  'projects.files.mkdir': async ({ projectId, path: relPath }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof relPath !== 'string' || !relPath) throw new Error('invalid path');
    return projectFiles.createProjectDir(ctx.userId, projectId, relPath);
  },

  'projects.files.upload': async ({ projectId, name, data }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof data !== 'string') throw new Error('missing data');
    const buf = Buffer.from(data, 'base64');
    return projectFiles.uploadProjectFile(ctx.userId, projectId, name || '', buf);
  },

  'projects.files.pickAndUpload': async ({ projectId, targetDir } = {}, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (!await projects.projectExists(ctx.userId, projectId)) throw new Error('not_found');
    const picked = await _pickLocalFiles('Choose files', PROJECT_PICK_EXTENSIONS, true);
    const results = [];
    for (const filePath of picked) {
      const name = path.basename(filePath);
      try {
        const buf = fs.readFileSync(filePath);
        const targetName = _targetInDir(targetDir, name);
        const res = await projectFiles.uploadProjectFile(ctx.userId, projectId, targetName, buf);
        results.push({ name, targetName, ...res });
      } catch (err) {
        results.push({ ok: false, name, error: (err as Error)?.message || String(err) });
      }
    }
    return { files: results };
  },

  'projects.files.createText': async ({ projectId, name }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    return projectFiles.createProjectTextFile(ctx.userId, projectId, name);
  },

  'projects.files.readText': async ({ projectId, name }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    return projectFiles.readProjectTextFile(ctx.userId, projectId, name);
  },

  'projects.files.updateText': async ({ projectId, name, content }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    if (typeof content !== 'string') throw new Error('missing content');
    return projectFiles.updateProjectTextFile(ctx.userId, projectId, name, content);
  },

  'projects.files.rename': async ({ projectId, oldName, name }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof oldName !== 'string' || !oldName) throw new Error('invalid oldName');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    return projectFiles.renameProjectFile(ctx.userId, projectId, oldName, name);
  },

  'projects.files.delete': async ({ projectId, name }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    await recycleBin.createAppRecycleBatchForCloudEntry(
      ctx.userId,
      `cloud/projects/${projectId}/files/${name}`,
      'project_file',
    );
    return projectFiles.deleteProjectEntry(ctx.userId, projectId, name);
  },

  'projects.files.absPath': async ({ projectId, name }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    const r = await projectFiles.resolveProjectFileAbsPath(ctx.userId, projectId, name);
    if (!r.ok) return { ok: false, error: (r as { error?: string }).error || 'failed' };
    return { ok: true, path: r.absPath, kind: r.kind };
  },

  'projects.files.image': async ({ projectId, name }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    return projectFiles.readProjectImage(ctx.userId, projectId, name);
  },

  'projects.files.docxHtml': async ({ projectId, name }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    return projectFiles.readProjectDocxHtml(ctx.userId, projectId, name);
  },

  'projects.files.status': async ({ projectId, skipReconcile }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (!await projects.projectExists(ctx.userId, projectId)) throw new Error('not_found');
    const reconcile = skipReconcile ? null : await projectLibraryIndexer.reconcile(ctx.userId, projectId);
    const summary = projectLibraryIndexer.statusSummary(ctx.userId, projectId);
    const files = projectLibraryIndexer.listFiles(ctx.userId, projectId).map((r) => ({
      name: r.rel_path,
      path: r.rel_path,
      kind: r.kind,
      status: r.status,
      chunks: r.chunks,
      bytes: r.bytes,
      mtime: r.mtime,
      error: r.error || undefined,
    }));
    return { summary, files, reconcile };
  },

  'projects.files.reconcile': async ({ projectId }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (!await projects.projectExists(ctx.userId, projectId)) throw new Error('not_found');
    const result = await projectLibraryIndexer.reconcile(ctx.userId, projectId);
    return { result };
  },

  'projects.files.reprocess': async ({ projectId, name }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    if (!await projects.projectExists(ctx.userId, projectId)) throw new Error('not_found');
    projectLibraryIndexer.enqueue(ctx.userId, projectId, name, 'upsert', { force: true });
    return { ok: true, name };
  },

  // ── Project bindings (the strict scope of agents/skills visible inside
  // a project conversation; see CLAUDE.md §6 outer-intersection rule) ──
  // `bindings.list` returns the bound ids JOINED with name/description so
  // the renderer can paint the detail page in one round-trip. Unknown ids
  // (referent deleted) are pruned here so stale bindings never become user
  // cleanup work.
  'projects.bindings.list': async ({ projectId }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (!await projects.projectExists(ctx.userId, projectId)) throw new Error('not_found');
    const [agentList, skillList] = await Promise.all([
      agents.listAgents(),
      skills.listSkills(),
    ]);
    const agentById = new Map(agentList.map((a: any) => [a.agent_id, a]));
    const skillById = new Map(skillList.map((s: any) => [s.id, s]));
    const pruned = await projects.pruneBindings(ctx.userId, projectId, {
      agents: new Set(agentList.map((a: any) => a.agent_id)),
      skills: new Set(skillList.map((s: any) => s.id)),
    });
    if (!pruned.ok) throw new Error((pruned as { error: string }).error);
    const bindings = pruned.bindings;
    return {
      bindings,
      agentDetails: bindings.agents
        .map((id) => agentById.get(id))
        .filter(Boolean),
      skillDetails: bindings.skills
        .map((id) => skillById.get(id))
        .filter(Boolean),
    };
  },

  'projects.bindings.add': async ({ projectId, kind, id }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof id !== 'string' || !id) throw new Error('invalid id');
    let result;
    if (kind === 'agent') {
      if (!agents.isValidAgentId(id)) throw new Error('invalid id');
      const agent = await agents.getAgent(id);
      if (!agent || agent.enabled === false) throw new Error('agent_disabled');
      result = await projects.addAgentBinding(ctx.userId, projectId, id);
    } else if (kind === 'skill') {
      result = await projects.addSkillBinding(ctx.userId, projectId, id);
    } else {
      throw new Error('invalid kind');
    }
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { bindings: result.bindings };
  },

  'projects.bindings.remove': async ({ projectId, kind, id }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (typeof id !== 'string' || !id) throw new Error('invalid id');
    let result;
    if (kind === 'agent') {
      result = await projects.removeAgentBinding(ctx.userId, projectId, id);
    } else if (kind === 'skill') {
      result = await projects.removeSkillBinding(ctx.userId, projectId, id);
    } else {
      throw new Error('invalid kind');
    }
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { bindings: result.bindings };
  },

  // Candidates = enabled [builtin + custom] minus already-bound. Powers the
  // "Add" picker on the project detail page so disabled agents never appear
  // as addable project members.
  'projects.bindings.candidates': async ({ projectId }, ctx) => {
    if (!safeId(projectId)) throw new Error('invalid projectId');
    if (!await projects.projectExists(ctx.userId, projectId)) throw new Error('not_found');
    const bindings = await projects.getBindings(ctx.userId, projectId);
    const boundAgents = new Set(bindings.agents);
    const boundSkills = new Set(bindings.skills);
    const [agentList, skillList] = await Promise.all([
      agents.listAgents(),
      skills.listSkills(),
    ]);
    return {
      agents: agentList.filter((a: any) => a.enabled !== false && !boundAgents.has(a.agent_id)),
      skills: skillList.filter((s: any) => !boundSkills.has(s.id)),
    };
  },

  // ── Auto tasks (per-task dir at cloud/auto_tasks/<id>/; see features/auto_tasks.ts) ──
  'autoTasks.list': async ({ projectId } = {}, ctx) => {
    const opts: { projectId?: string | null } = {};
    if (projectId === null) opts.projectId = null;
    else if (typeof projectId === 'string' && projectId) opts.projectId = projectId;
    const tasks = await autoTasks.listTasks(ctx.userId, opts);
    return { tasks };
  },

  'autoTasks.create': async ({ id, content, schedule, title, enabled, recipient, skill, connector, project_id, attachments }, ctx) => {
    const result = await autoTasks.createTask(ctx.userId, {
      ...(typeof id === 'string' && id ? { id } : {}),
      content: typeof content === 'string' ? content : '',
      schedule,
      title: typeof title === 'string' ? title : undefined,
      enabled: enabled !== false,
      recipient: recipient && typeof recipient === 'object' ? recipient : undefined,
      skill: skill && typeof skill === 'object' ? skill : undefined,
      connector: connector && typeof connector === 'object' ? connector : undefined,
      project_id: typeof project_id === 'string' ? project_id : undefined,
      attachments: Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string' && n) : undefined,
    });
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { task: result.task };
  },

  'autoTasks.allocateDraftId': async () => {
    return { id: autoTasks.allocateDraftTaskId() };
  },

  // Current device fingerprint — { id: <MAC>, name: <hostname> }. Renderer
  // uses this to decide which task rows are "本机" (matches MAC) vs. show
  // the device_name from the task as-is (other devices).
  'autoTasks.currentDevice': async () => {
    const d = autoTasks.getCurrentDevice();
    return { device: { id: d.id, name: d.name } };
  },

  'autoTasks.attachments.list': async ({ taskId } = {}, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    return { items: await autoTasks.listAttachments(ctx.userId, taskId) };
  },

  'autoTasks.attachments.upload': async ({ taskId, name, dataBase64 }, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    if (typeof dataBase64 !== 'string') throw new Error('invalid data');
    const buf = Buffer.from(dataBase64, 'base64');
    const res = await autoTasks.uploadAttachment(ctx.userId, taskId, name, buf);
    if (!res.ok) throw new Error((res as { error: string }).error);
    return { name: res.name };
  },

  'autoTasks.attachments.pickAndUpload': async ({ taskId } = {}, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    const picked = await _pickLocalFiles('Choose files', CHAT_PICK_EXTENSIONS, true);
    const items: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const filePath of picked) {
      const name = path.basename(filePath);
      try {
        const buf = fs.readFileSync(filePath);
        const res = await autoTasks.uploadAttachment(ctx.userId, taskId, name, buf);
        if (res.ok) items.push(res.name);
        else failed.push({ name, error: (res as any).error });
      } catch (err) {
        failed.push({ name, error: (err as Error)?.message || String(err) });
      }
    }
    return { items, failed };
  },

  'autoTasks.attachments.delete': async ({ taskId, name }, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    if (typeof name !== 'string' || !name) throw new Error('invalid name');
    await recycleBin.createAppRecycleBatchForCloudEntry(
      ctx.userId,
      `cloud/auto_tasks/${taskId}/attachments/${name}`,
      'attachment',
    );
    const res = await autoTasks.deleteAttachment(ctx.userId, taskId, name);
    return { deleted: res.ok };
  },

  'autoTasks.update': async ({ taskId, updates }, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    if (!updates || typeof updates !== 'object') throw new Error('invalid updates');
    const result = await autoTasks.updateTask(ctx.userId, taskId, updates as any);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { task: result.task };
  },

  'autoTasks.delete': async ({ taskId }, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    await recycleBin.createAppRecycleBatchForAutoTask(ctx.userId, taskId);
    const res = await autoTasks.deleteTask(ctx.userId, taskId);
    return { deleted: res.ok };
  },

  'autoTasks.setEnabled': async ({ taskId, enabled }, ctx) => {
    if (typeof taskId !== 'string' || !taskId) throw new Error('invalid taskId');
    const result = await autoTasks.setTaskEnabled(ctx.userId, taskId, !!enabled);
    if (!result.ok) throw new Error((result as { error: string }).error);
    return { task: result.task };
  },

  // ── Group chat (replaces legacy conversations.send / .stream / .markFormSubmitted) ──
  'groupChat.send': async ({ cid, content, attachments }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const text = (content || '').trim();
    if (!text) throw new Error('empty message');
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string') : [];
    return groupChat.send({ userId: ctx.userId, cid, text, ...(atts.length ? { attachments: atts } : {}) });
  },

  'groupChat.abort': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return groupChat.abort(ctx.userId, cid);
  },

  'groupChat.listMembers': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    if (!await chats.getConversation(ctx.userId, cid)) {
      return { ok: false, error: 'conversation not found', actors: [] };
    }
    return groupChat.listMembers(ctx.userId, cid);
  },

  'groupChat.readPlan': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return groupChat.readPlanForCid(ctx.userId, cid);
  },

  'groupChat.runtimeStatus': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return groupChat.runtimeStatus(ctx.userId, cid);
  },

  'groupChat.continuePlan': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return groupChat.continuePlan(ctx.userId, cid);
  },

  'groupChat.retryStep': async ({ cid, stepIndex }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return groupChat.retryStep(ctx.userId, cid, Number(stepIndex));
  },

  'groupChat.skipStep': async ({ cid, stepIndex }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return groupChat.skipStep(ctx.userId, cid, Number(stepIndex));
  },

  'groupChat.markFormSubmitted': async ({ cid, msgId, formId, values }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    if (typeof msgId !== 'string' || !msgId) throw new Error('invalid msgId');
    if (typeof formId !== 'string' || !/^[a-f0-9]{8,64}$/.test(formId)) {
      throw new Error('invalid formId');
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new Error('invalid values');
    }
    return groupChat.markFormSubmittedAndDispatch({
      userId: ctx.userId, cid, msgId, formId, values: values as Record<string, unknown>,
    });
  },

  'groupChat.resolveMarketplaceInstallRequest': async ({ cid, msgId, requestId, decision }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    if (typeof msgId !== 'string' || !safeId(msgId)) throw new Error('invalid msgId');
    if (typeof requestId !== 'string' || !safeId(requestId)) throw new Error('invalid requestId');
    if (decision !== 'install' && decision !== 'skip') throw new Error('invalid decision');
    return groupChat.resolveMarketplaceInstallRequest({
      userId: ctx.userId,
      cid,
      msgId,
      requestId,
      decision,
    });
  },

  // Generic native directory picker. Used by the agent-input-form
  // `directory` type so coding agents (claude / codex) collect their
  // project directory through the standard input-form pipeline.
  'common.pickDirectory': async ({ title } = {}) => {
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: typeof title === 'string' && title ? title : t('dialog.choose_directory'),
    };
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths?.length) return { cancelled: true };
    return { cancelled: false, path: res.filePaths[0] };
  },

  'common.pickFiles': async ({ title, extensions, multiple } = {}) => {
    const rawExts = Array.isArray(extensions) ? extensions : CHAT_PICK_EXTENSIONS;
    const picked = await _pickLocalFiles(
      typeof title === 'string' && title ? title : 'Choose files',
      rawExts,
      multiple !== false,
    );
    const files = picked.map((filePath) => {
      const buf = fs.readFileSync(filePath);
      return {
        name: path.basename(filePath),
        dataBase64: buf.toString('base64'),
        size: buf.length,
      };
    });
    return { files };
  },

  // ── Chat attachments (per-cid file pool for main chat) ──
  'conversations.attachments.list': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return { items: chatAttachments.listPendingAttachments(ctx.userId, cid) };
  },

  'conversations.attachments.upload': async ({ cid, name, data }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    // `data` arrives as base64 (contextBridge can't ferry Buffers cleanly —
    // same convention as contexts.tmp.upload).
    const buf = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data || []);
    return chatAttachments.uploadAttachment(ctx.userId, cid, name || '', buf);
  },

  'conversations.attachments.pickAndUpload': async ({ cid } = {}, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const picked = await _pickLocalFiles('Choose files', CHAT_PICK_EXTENSIONS, true);
    const items = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const filePath of picked) {
      const name = path.basename(filePath);
      try {
        const buf = fs.readFileSync(filePath);
        const res = await chatAttachments.uploadAttachment(ctx.userId, cid, name, buf);
        if (res.ok) items.push({ displayName: name, info: res.info, reused: !!res.reused });
        else failed.push({ name, error: (res as any).error });
      } catch (err) {
        failed.push({ name, error: (err as Error)?.message || String(err) });
      }
    }
    return { items, failed };
  },

  'conversations.attachments.import': async (payload, ctx) => {
    const cid = payload?.cid;
    const sourcePath = payload?.path;
    if (!safeId(cid)) throw new Error('invalid cid');
    if (typeof sourcePath !== 'string' || !sourcePath) throw new Error('missing path');

    const norm = path.resolve(sourcePath);
    const allowedRoots = await _ipcFileSandboxAllowedRoots(ctx.userId, payload);
    const inSandbox = isPathAllowed(norm, allowedRoots);
    const inRecordedFile = !inSandbox && await _isConversationRecordedFile(ctx.userId, cid, norm);
    if (!inSandbox && !inRecordedFile) {
      throw new Error('path is outside the user workspace');
    }
    return chatAttachments.importAttachmentFromPath(ctx.userId, cid, norm);
  },

  'conversations.attachments.delete': async ({ cid, name }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    await recycleBin.createAppRecycleBatchForCloudEntry(
      ctx.userId,
      `cloud/chat_attachments/${cid}/${name || ''}`,
      'attachment',
    );
    return chatAttachments.deleteAttachment(ctx.userId, cid, name || '');
  },

  'conversations.attachments.adopt': async ({ from_cid, to_cid }, ctx) => {
    if (!safeId(from_cid)) throw new Error('invalid from_cid');
    if (!safeId(to_cid)) throw new Error('invalid to_cid');
    return chatAttachments.adoptDraftAttachments(ctx.userId, from_cid, to_cid);
  },

  // ── Chat artifacts (interactive web-app bundles, served via chat-app://) ──
  // Open the artifact's index.html in the OS default browser (a `file://`
  // URL via `shell.openPath`). Path is resolved through
  // `chatArtifacts.resolveArtifactFilePath` so caller-supplied cid /
  // artifactId can only ever reach a file inside that artifact's pool.
  'conversations.artifacts.openExternal': async ({ cid, artifactId }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const r = chatArtifacts.resolveArtifactFilePath(ctx.userId, String(cid), String(artifactId || ''), 'index.html');
    if (!r.ok) throw new Error((r as { error?: string }).error || 'artifact not found');
    const absPath = (r as { absPath: string }).absPath;
    const err = await shell.openPath(absPath);
    if (err) throw new Error(err);
    return { ok: true, path: absPath };
  },
  // Copy a chat artifact into the persistent "My Apps" pool
  // (`<uid>/cloud/saved_apps/<appId>/`). Surfaced as the artifact card's
  // `⋯` → "保存".
  'conversations.artifacts.save': async ({ cid, artifactId }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const r = savedApps.saveFromArtifact(ctx.userId, String(cid), String(artifactId || ''));
    if (!r.ok) throw new Error((r as { error?: string }).error || 'failed to save app');
    return { ok: true, id: (r as { id: string }).id, title: (r as { title: string }).title };
  },

  'savedApps.inspectBundleFromPath': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) throw new Error('missing path');
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    return savedApps.inspectBundleFromPath(norm, {
      fenceRoots: await _ipcFileSandboxAllowedRoots(ctx.userId, payload),
    });
  },

  'savedApps.saveFromPath': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) throw new Error('missing path');
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    const r = savedApps.saveFromPath(ctx.userId, norm, {
      title: payload?.title,
      sourceCid: payload?.cid,
      fenceRoots: await _ipcFileSandboxAllowedRoots(ctx.userId, payload),
    });
    if (!r.ok) throw new Error((r as { error?: string }).error || 'failed to save app');
    return r;
  },

  // ── Saved apps ("My Apps" — user-kept copies of create_artifact bundles) ──
  'savedApps.list': async (_payload, ctx) => ({ apps: savedApps.listSavedApps(ctx.userId) }),
  'savedApps.openExternal': async ({ appId }, ctx) => {
    const r = savedApps.resolveSavedAppIndex(ctx.userId, String(appId || ''));
    if (!r.ok) throw new Error((r as { error?: string }).error || 'app not found');
    const absPath = (r as { absPath: string }).absPath;
    const err = await shell.openPath(absPath);
    if (err) throw new Error(err);
    return { ok: true, path: absPath };
  },
  'savedApps.openInApp': async ({ appId }, ctx) => {
    const id = String(appId || '');
    const r = savedApps.resolveSavedAppFilePath(ctx.userId, id, '');
    if (!r.ok) throw new Error((r as { error?: string }).error || 'app not found');
    const entry = (r as { entry: string }).entry || 'index.html';
    const url = ['chat-app://saved', encodeURIComponent(id)]
      .concat(entry.split('/').map((part) => encodeURIComponent(part)))
      .join('/');
    return { ok: true, url, entry };
  },
  // Open a saved app for editing — creates a fresh conversation with the
  // app's source bundled in as an `app-source.md` attachment. The renderer
  // navigates to it + pre-fills a draft.
  'savedApps.openForEditing': async ({ appId }, ctx) => {
    const r = await savedApps.openForEditing(ctx.userId, String(appId || ''));
    if (!r.ok) throw new Error((r as { error?: string }).error || 'failed to open the app for editing');
    return {
      ok: true,
      conversation: (r as { conversation: unknown }).conversation,
      title: (r as { title: string }).title,
      sourceFileName: (r as { sourceFileName: string }).sourceFileName,
    };
  },
  'savedApps.rename': async ({ appId, title }, ctx) => {
    const r = savedApps.renameSavedApp(ctx.userId, String(appId || ''), title);
    if (!r.ok) throw new Error((r as { error?: string }).error || 'failed to rename');
    return { ok: true, title: (r as { title: string }).title };
  },
  'savedApps.delete': async ({ appId }, ctx) => {
    await recycleBin.createAppRecycleBatchForCloudEntry(
      ctx.userId,
      `cloud/saved_apps/${String(appId || '')}`,
      'saved_app',
    );
    const r = savedApps.deleteSavedApp(ctx.userId, String(appId || ''));
    if (!r.ok) throw new Error((r as { error?: string }).error || 'failed to delete');
    return { ok: true };
  },

  // ── Agents ──
  'agents.list': async ({ force } = {}) => {
    if (force === true || force === '1') agents.clearAgentListCache();
    return { agents: await agents.listAgents() };
  },

  'agents.get': async ({ agent_id }) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const agent = await agents.getAgent(agent_id);
    if (!agent) throw new Error('agent not found');
    return { agent };
  },

  'agents.create': async ({ name = '', description = '', description_zh, description_en, workflow = '', icon, color, runtime, category, output_format } = {}) => {
    return { agent: await agents.createCustomAgent({ name, description, description_zh, description_en, workflow, icon, color, runtime, category, output_format }) };
  },


  'agents.update': async ({ agent_id, updates }) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const data = await agents.updateCustomAgent(agent_id, updates || {});
    if (!data) throw new Error('agent not found or read-only');
    return { agent: data };
  },

  'agents.delete': async ({ agent_id }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    await recycleBin.createAppRecycleBatchForAgent(ctx.userId, agent_id);
    return { deleted: await agents.deleteCustomAgent(agent_id) };
  },

  // Per-user enable/disable toggle. enabled=true clears the override; both
  // builtin and custom agents are toggleable (it's a personal preference,
  // not a spec mutation). Returns the resolved state for the renderer to
  // confirm the new value.
  'agents.setEnabled': async ({ agent_id, enabled }) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    agents.setAgentEnabledForActiveUser(agent_id, enabled);
    return { ok: true, enabled };
  },

  'agents.cliProjectDir.get': async ({ agent_id }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const info = await agents.getAgentCliProjectDirInfo(ctx.userId, agent_id);
    if (!info) throw new Error('agent not found');
    return { info };
  },

  'agents.cliProjectDir.set': async ({ agent_id, path: dirPath = '' }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    if (typeof dirPath !== 'string') throw new Error('path must be string');
    const info = await agents.setAgentCliProjectDir(ctx.userId, agent_id, dirPath);
    if (!info) throw new Error('agent not found');
    return { info };
  },

  'agents.chat.history': async ({ agent_id, limit = 500 }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    if (!(await agents.getAgent(agent_id))) throw new Error('agent not found');
    return { messages: await agents.getAgentChatMessages(ctx.userId, agent_id, limit) };
  },

  'agents.chat.clear': async ({ agent_id }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    return { cleared: await agents.clearAgentChat(ctx.userId, agent_id) };
  },

  'agents.chat.send': async ({ agent_id, content, model_text, attachments }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const text = (content || '').trim();
    if (!text) throw new Error('empty message');
    const modelText = typeof model_text === 'string' ? model_text.trim() : '';
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string' && n) : [];
    return agents.sendToAgentEditChat(ctx.userId, agent_id, text, {
      ...(atts.length ? { attachments: atts } : {}),
      ...(modelText ? { modelText } : {}),
    });
  },

  // ── Skills ──
  'skills.list': async ({ force } = {}) => {
    if (force === true || force === '1') skills.clearSkillListCache();
    return { skills: await skills.listSkills() };
  },

  'skills.read': async ({ source, id, file = 'SKILL.md' }) => {
    if (source !== 'marketplace' && source !== 'builtin' && source !== 'custom') throw new Error('invalid source');
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return skills.readSkillFile(source, id, file);
  },

  'skills.writeFile': async ({ id, file, content }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    if (!file) throw new Error('missing file');
    // Routes to custom in normal mode; in dev, built-in writes are accepted
    // and dual-write (src + data) via the dev module.
    const ok = await skills.writeSkillFileForEdit(id, file, content || '');
    if (!ok) throw new Error(t('errors.skill_write_failed'));
    return { written: true };
  },

  'skills.tree': async ({ source, id }) => {
    if (source !== 'marketplace' && source !== 'builtin' && source !== 'custom') throw new Error('invalid source');
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return skills.listSkillTree(source, id);
  },

  'skills.create': async ({ name, description, category }) => {
    return { skill: await skills.createCustomSkill(name, description || '', category || '') };
  },

  'skills.pickImportDir': async () => {
    // Runs in main; show a native directory picker attached to the focused
    // BrowserWindow so the dialog is modal to Orkas.
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: t('dialog.choose_skill_source_directory'),
    };
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths?.length) return { cancelled: true };
    return { cancelled: false, path: res.filePaths[0] };
  },

  'skills.createFromUrl': async ({ name, description, url }) => {
    const r = await skills.createFromUrl(name ?? null, description ?? null, String(url || ''));
    if (!r.ok) return r;
    return { skill: r.skill, skills: r.skills, seedModelText: r.seedModelText, seedMessage: r.seedMessage };
  },

  'skills.createFromDir': async ({ name, description, srcDir, force }) => {
    const r = await skills.createFromDir(name ?? null, description ?? null, String(srcDir || ''), { force: force === true });
    if (!r.ok) return r;
    return { skill: r.skill, skills: r.skills, seedModelText: r.seedModelText, seedMessage: r.seedMessage };
  },

  'skills.discardImportDraft': async ({ id }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return { discarded: await skills.discardImportDraftIfPristine(id) };
  },

  'skills.update': async ({ id, updates, skipRename }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const data = await skills.updateCustomSkill(id, updates || {}, { skipRename: !!skipRename });
    if (!data) throw new Error('skill not found');
    return { skill: data };
  },

  'skills.updateForEdit': async ({ id, updates }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const data = await skills.applySkillMetadataForEdit(id, updates || {});
    if (!data.ok) {
      return {
        ok: false,
        error: data.reason || 'skill not found or read-only',
        report: data.report,
      };
    }
    return {
      skill: { id: data.skillId, name: data.name },
      written: data.written,
      report: data.report,
    };
  },

  'skills.delete': async ({ id }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    await recycleBin.createAppRecycleBatchForSkill(ctx.userId, id);
    return { deleted: await skills.deleteCustomSkill(id) };
  },

  // Per-user enable/disable toggle. Builtin and custom both toggleable (it's
  // a personal preference, not a spec mutation). Wrapper handles the
  // _invalidateSkillListCache + invalidateCoreAgentSkills chain so the next
  // runner build re-renders the skills system-prompt block.
  'skills.setEnabled': async ({ id, enabled }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    if (typeof enabled !== 'boolean') throw new Error('enabled must be boolean');
    skills.setSkillEnabledForActiveUser(id, enabled);
    return { ok: true, enabled };
  },

  'skills.get': async ({ id }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const skill = await skills.getCustomSkill(id);
    if (!skill) throw new Error('skill not found');
    return { skill };
  },

  'skills.chat.history': async ({ id, limit = 500 }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    if (!(await skills.getSkillForEdit(id))) throw new Error('skill not found');
    return { messages: await skills.getSkillChatMessages(ctx.userId, id, limit) };
  },

  'skills.chat.clear': async ({ id }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return { cleared: await skills.clearSkillChat(ctx.userId, id) };
  },

  'skills.chat.send': async ({ id, content, model_text, attachments }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const text = (content || '').trim();
    if (!text) throw new Error('empty message');
    const modelText = typeof model_text === 'string' ? model_text.trim() : '';
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string' && n) : [];
    return skills.sendToSkillChat(ctx.userId, id, text, {
      ...(atts.length ? { attachments: atts } : {}),
      ...(modelText ? { modelText } : {}),
    });
  },

  // ── Marketplace ──
  // Listing + detail + install endpoints hit the public Server catalog; categories are served
  // from the local biz cache when callers pass `local_only`, otherwise refreshed on stale cache.
  'marketplace.categories': async (opts = {}) => ({
    list: await marketplaceBiz.getMarketplaceCategories({
      localOnly: !!opts.local_only,
      forceRefresh: !!opts.force_refresh,
    }),
  }),

  'marketplace.listAgents': async (opts = {}) => marketplace.listMarketplaceAgents(opts),

  'marketplace.listSkills': async (opts = {}) => marketplace.listMarketplaceSkills(opts),

  // Curated open-source projects catalog (read-only). Returns { list, total, categories }.
  'marketplace.listProjects': async (opts = {}) => marketplace.listMarketplaceProjects(opts),

  // Detail endpoints (cache-first) — used by the marketplace panel's detail view to render
  // full content. Caller passes the list-row's (version, freshness timestamp) so we can short-circuit
  // on a hot cache. Sweep is invoked once per openMarketplace at the entry point.
  'marketplace.detailAgent': async ({ id, version, published_at, updated_at }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    if (typeof version !== 'string' || typeof published_at !== 'number') {
      throw new Error('version + published_at required');
    }
    return marketplace.getAgentDetail(id, {
      version, published_at,
      ...(typeof updated_at === 'number' ? { updated_at } : {}),
    });
  },

  'marketplace.detailSkill': async ({ id, version, published_at, updated_at }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    if (typeof version !== 'string' || typeof published_at !== 'number') {
      throw new Error('version + published_at required');
    }
    return marketplace.getSkillDetail(id, {
      version, published_at,
      ...(typeof updated_at === 'number' ? { updated_at } : {}),
    });
  },

  'marketplace.installAgent': async ({ id, name, version, published_at, updated_at, force }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    if (typeof version !== 'string' || typeof published_at !== 'number') {
      throw new Error('version + published_at required');
    }
    return marketplace.installMarketplaceAgent(id, {
      version, published_at,
      ...(typeof updated_at === 'number' ? { updated_at } : {}),
    }, { force: force === true, name: typeof name === 'string' ? name : undefined });
  },

  'marketplace.installSkill': async ({ id, name, version, published_at, updated_at, force }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    if (typeof version !== 'string' || typeof published_at !== 'number') {
      throw new Error('version + published_at required');
    }
    return marketplace.installMarketplaceSkill(id, {
      version, published_at,
      ...(typeof updated_at === 'number' ? { updated_at } : {}),
    }, { force: force === true, name: typeof name === 'string' ? name : undefined });
  },

  // Uninstall is non-dev: wipes the local install copy + manifest entry. Does NOT touch the
  // server row (`marketplace_dev.deleteMarketplace*` does that, dev-only).
  'marketplace.uninstallAgent': async ({ id }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    return marketplace.uninstallMarketplaceAgent(id);
  },

  'marketplace.uninstallSkill': async ({ id }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    return marketplace.uninstallMarketplaceSkill(id);
  },

  // Entry-point housekeeping for the marketplace panel: sweep stale + over-sized cache entries.
  // Cheap (O(N entries) stat), so it's safe to call once per openMarketplace from the renderer.
  'marketplace.sweepCache': async () => ({ bytes_freed: await marketplaceCache.sweepIfNeeded() }),

  // Renderer queries this once at startup to learn the current reconcile state, then subscribes
  // to push-events `marketplace:reconcile-status` for in-flight progress. See main/index.ts
  // boot wiring + features/marketplace_reconcile.ts::subscribeReconcileStatus.
  'marketplace.reconcileStatus': async () => marketplaceReconcile.getReconcileStatus(),

  // Persistent listing-grid cache so cold starts don't show a blank panel. Renderer hydrates
  // from this on `openMarketplace` and writes back after every fresh /list response. See
  // `marketplace_cache.ts::{getListingsCache,setListingsCache}`.
  'marketplace.getListingsCache': async () => marketplaceCache.getListingsCache(),

  'marketplace.setListingsCache': async ({ entries }) => {
    if (!entries || typeof entries !== 'object') throw new Error('entries required');
    await marketplaceCache.setListingsCache(entries);
    return { ok: true as const };
  },

  'marketplace.mergeListingsCache': async ({ entries }) => {
    if (!entries || typeof entries !== 'object') throw new Error('entries required');
    await marketplaceCache.mergeListingsCache(entries);
    return { ok: true as const };
  },

  // Detail-page file viewer (skill kind only — agent payload is fully in the detail response).
  'marketplace.cacheSkillFiles': async ({ id }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    return { list: await marketplaceCache.listSkillCacheFiles(id) };
  },

  'marketplace.cacheSkillRead': async ({ id, file }) => {
    if (!id || typeof id !== 'string') throw new Error('id required');
    if (!file || typeof file !== 'string') throw new Error('file required');
    const content = await marketplaceCache.readSkillCacheFile(id, file);
    return { content: content || '' };
  },

  // ── Global recycle bin (sync tombstones + in-app deletes) ──
  'recycle.list': async (_payload, ctx) => ({
    batches: await recycleBin.listRecycleBatches(ctx.userId),
  }),

  'recycle.restore': async ({ id }, ctx) => {
    const res = await recycleBin.restoreRecycleBatch(ctx.userId, String(id || ''));
    if (!res.batch) throw _codedError('recycle_batch_not_found');
    const changed = Array.from(new Set([
      ...res.restored_paths,
      ...res.skipped_paths,
      ...res.reactivated_paths,
    ]));
    await _afterRecycleRestore(ctx, changed);
    return {
      ok: true,
      restored: changed.length,
      restored_paths: res.restored_paths,
      skipped_paths: res.skipped_paths,
      failed_paths: res.failed_paths,
      reactivated_paths: res.reactivated_paths,
    };
  },

  'recycle.delete': async ({ id }, ctx) => {
    const { deleted } = await recycleBin.deleteRecycleBatch(ctx.userId, String(id || ''));
    return { deleted };
  },

  // ── Cache (clearable umbrella under `<uid>/local/cache/<bucket>/`) ──
  'cache.listClearable': async () => ({ list: await cacheClearable.listClearableBuckets() }),

  'cache.clearBucket': async ({ name }) => {
    if (!name || typeof name !== 'string') throw new Error('name required');
    return { bytes_freed: await cacheClearable.clearBucket(name) };
  },

  'cache.clearAll': async () => ({ bytes_freed: await cacheClearable.clearAllClearable() }),

  // ── Contexts (user-owned directory tree; vectorized via kb_indexer) ──
  'contexts.tree': async () => ({ tree: contexts.listContextsTree() }),

  'contexts.read': async ({ path }) => {
    return contexts.readContextFile(path || '');
  },

  'contexts.index': async () => ({
    markdown: await contexts.getContextIndexMarkdown(),
    entries: await contexts.getContextIndexEntries(),
  }),

  // Create / overwrite a text file (md/txt/json/...).
  'contexts.write': async ({ path, content }) => {
    return contexts.writeContextFile(path || '', content || '');
  },

  // Edit an existing text file (refuses to create).
  'contexts.update': async ({ path, content }) => {
    return contexts.updateContextFile(path || '', content || '');
  },

  // Save an uploaded file (binary-safe: pdf / docx / image / text). The shim
  // encodes the target path in the `X-Filename` header and turns it into
  // `name` on this side; payload may also arrive with an explicit `path`
  // (direct programmatic callers). `data` is base64 (renderer can't cross
  // contextBridge with Buffer).
  'contexts.upload': async (payload) => {
    const target = payload?.path || payload?.name || '';
    const data = payload?.data;
    const buf = typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data || []);
    return contexts.uploadContextFile(target, buf);
  },

  'contexts.pickAndUpload': async ({ targetDir } = {}) => {
    const picked = await _pickLocalFiles('Choose files', CONTEXT_PICK_EXTENSIONS, true);
    const results = [];
    for (const filePath of picked) {
      const name = path.basename(filePath);
      try {
        const buf = fs.readFileSync(filePath);
        const target = _targetInDir(targetDir, name);
        const res = contexts.uploadContextFile(target, buf);
        results.push({ name, target, ...res });
      } catch (err) {
        results.push({ ok: false, name, error: (err as Error)?.message || String(err) });
      }
    }
    return { files: results };
  },

  'contexts.mkdir': async ({ path }) => {
    return contexts.createContextDir(path || '');
  },

  'contexts.rename': async ({ src, dst }) => {
    return contexts.renameContextEntry(src || '', dst || '');
  },

  'contexts.delete': async ({ path }, ctx) => {
    await recycleBin.createAppRecycleBatchForCloudEntry(
      ctx.userId,
      `cloud/contexts/${path || ''}`,
      'context',
    );
    return contexts.deleteContextTarget(path || '');
  },

  // Read an image file's bytes for inline viewer display.
  'contexts.image': async ({ path }) => {
    return contexts.readContextImage(path || '');
  },

  // Render a .docx as HTML (via mammoth) for the inline preview pane.
  'contexts.docxHtml': async ({ path }) => {
    return contexts.readContextDocxHtml(path || '');
  },

  // Reveal a Library file in the OS file manager.
  'contexts.reveal': async ({ path }) => {
    return contexts.showContextFileInSystem(path || '');
  },

  // ── Library import compatibility layer ──
  // First migration step for the unified "Library" product surface. Produced
  // files import into the current project's file pool when the cid belongs to
  // a project; otherwise they import into the global contexts tree. Future
  // work will replace both backends with a single scope-aware library module.
  'library.importProduced': async (payload, ctx) => {
    return _importProducedToLibrary(payload, ctx);
  },

  'library.writeText': async (payload, ctx) => {
    return _writeTextToLibrary(payload, ctx);
  },

  // ── Knowledge base (vector store) ──
  // Snapshot of what's in `kb_files`: status summary + per-file rows.
  // Renderer subscribes to the `kb.events` stream (below) for incremental
  // updates; this endpoint is the initial-load / full-refresh fetch.
  'kb.status': async (_payload, ctx) => {
    const summary = kbVector.statusSummary(ctx.userId);
    const files = kbVector.listFiles(ctx.userId).map((r) => ({
      path: r.rel_path,
      kind: r.kind,
      status: r.status,
      chunks: r.chunks,
      bytes: r.bytes,
      mtime: r.mtime,
      error: r.error || undefined,
    }));
    return { summary, files };
  },

  // Force a disk-vs-db reconcile pass. Useful after users drop files into
  // contexts/ via Finder, or when vector.db is swapped out by sync and the
  // UI wants to catch up without restarting the app.
  'kb.reconcile': async (_payload, ctx) => {
    const r = await kbIndexer.reconcile(ctx.userId);
    return { result: r };
  },

  // Re-enqueue a single file (typically the UI's "reprocess" button after
  // a failed extraction).
  'kb.reprocess': async ({ path }, ctx) => {
    if (typeof path !== 'string' || !path) throw new Error('path required');
    kbIndexer.enqueue(ctx.userId, path, 'upsert');
    return { ok: true, path };
  },

  // ── Global search (knowledge base + chat history) ──
  'search.global': async ({ query, limit, scope, projectId }, ctx) => {
    return search.searchAll(ctx.userId, query || '', {
      limit: typeof limit === 'number' ? limit : 30,
      scope: scope || 'all',
      ...(typeof projectId === 'string' && safeId(projectId) ? { projectId } : {}),
    });
  },

  // ── UI language & locale tables (renderer i18n) ──
  'config.getLanguage': async () => ({ language: appConfig.getLanguage() }),
  'config.setLanguage': async ({ language }) => {
    if (!isLang(language)) throw new Error(`unsupported language: ${String(language)}`);
    const next = appConfig.setLanguage(language);
    markPreferencesDirty();
    return { language: next };
  },
  'config.getLocales': async () => ({ tables: getRendererTables() }),

  // Avatar catalog (icons + colors + commander default) — single source of
  // truth lives in src/main/data/avatars.json. The renderer fetches once at
  // startup, then uses its local cache.
  'avatars.getCatalog': async () => ({ catalog: avatars.getCatalog() }),

  // Commander avatar preference (cloud-synced). avatar = { icon, color };
  // tokens are validated against the catalog allow-list. When absent the
  // renderer falls back to the commander default (crown + gold).
  'prefs.getCommanderAvatar': async () => ({ avatar: appConfig.getCommanderAvatar() }),
  'prefs.setCommanderAvatar': async ({ icon, color }) => {
    const avatar = appConfig.setCommanderAvatar({ icon, color });
    markPreferencesDirty();
    return { avatar };
  },

  // Metacognition-level agent self-evolution toggle. Stored at
  // preferences.json::metacognition_enabled; the actual gate's single
  // source of truth is features/metacognition.isFeatureEnabled (with the
  // env kill switch on top). The env var `ORKAS_METACOGNITION='0'` always
  // overrides the UI setting.
  'prefs.getMetacognition': async () => ({
    enabled: appConfig.getMetacognitionEnabled(),
    envForcedOff: process.env.ORKAS_METACOGNITION === '0',
  }),
  'prefs.setMetacognition': async ({ enabled }) => {
    return { enabled: appConfig.setMetacognitionEnabled(!!enabled) };
  },

  // ── Auth / model config (settings page) ──
  'auth.listProviders': async () => auth.listProviders(),
  'auth.listModels': async ({ provider }) => auth.listModels(provider),
  'auth.addApiKey': async ({ provider, apiKey, label }) => auth.addApiKey(provider, apiKey, label),
  // Legacy alias; renderer migrated to auth.addApiKey.
  'auth.saveApiKey': async ({ provider, apiKey, label }) => auth.saveApiKey(provider, apiKey, label),
  'auth.renameProfile': async ({ profileId, label }) => auth.renameProfile(profileId, label),
  'auth.removeCredential': async ({ profileId }) => auth.removeCredential(profileId),
  'auth.testConnection': async ({ provider, model, profileId }) => auth.testConnection(provider, model, profileId),
  'auth.getConfig': async () => auth.getConfig(),
  'auth.hasConfiguredModel': async () => auth.hasConfiguredModel(),
  // OAuth flow — startOAuth kicks off a background login; renderer polls
  // via pollOAuthFlow, feeds prompt answers via submitOAuthInput.
  'auth.startOAuth':       async ({ provider, label }) => auth.startOAuth(provider, label),
  'auth.pollOAuthFlow':    async ({ flowId }) => auth.pollOAuthFlow(flowId),
  'auth.submitOAuthInput': async ({ flowId, value }) => auth.submitOAuthInput(flowId, value),
  'auth.cancelOAuthFlow':  async ({ flowId }) => auth.cancelOAuthFlow(flowId),
  // Open a URL in the user's default browser (OAuth flow uses this so the
  // consent page renders where the user is already logged in).
  'auth.openExternal':     async ({ url }) => auth.openExternalUrl(url),
  // Priority list (entries) — ordered (provider, model, profile) tuples.
  'auth.listEntries':     async () => auth.listEntries(),
  'auth.addEntry':        async ({ provider, model, profileId }) => auth.addEntry({ provider, model, profileId }),
  'auth.removeEntry':     async ({ entryId }) => auth.removeEntry(entryId),
  'auth.reorderEntries':  async ({ orderedIds }) => auth.reorderEntries(orderedIds || []),
  'auth.updateEntryModel':async ({ entryId, model }) => auth.updateEntryModel(entryId, model),

  // ── Image-generation API key (independent from chat entries) ──
  // `list` strips raw apiKey and replaces it with `apiKeyMasked` so
  // renderer never sees the full key (parity with chat entries' `profileMasked`).
  'imageAuth.list':     async () => ({
    ok: true,
    profiles: imageAuth.listImageProfiles().map((p) => ({
      id: p.id, provider: p.provider, label: p.label, createdAt: p.createdAt,
      apiKeyMasked: auth.maskKey(p.apiKey),
    })),
  }),
  'imageAuth.add':      async ({ provider, apiKey, label }) => imageAuth.addImageProfile({ provider, apiKey, label }),
  'imageAuth.remove':   async ({ id }) => imageAuth.removeImageProfile(id),
  'imageAuth.reorder':  async ({ orderedIds }) => imageAuth.reorderImageProfiles(orderedIds || []),
  'imageAuth.test':     async ({ id }) => imageAuth.testImageProfile(id),

  // ── Search-tool API key (overrides built-in keyless web_search) ──
  'searchAuth.list':    async () => ({
    ok: true,
    profiles: searchAuth.listSearchProfiles().map((p) => ({
      id: p.id, provider: p.provider, label: p.label, createdAt: p.createdAt,
      extras: p.extras, apiKeyMasked: auth.maskKey(p.apiKey),
    })),
  }),
  'searchAuth.add':     async ({ provider, apiKey, label, extras }) => searchAuth.addSearchProfile({ provider, apiKey, label, extras }),
  'searchAuth.remove':  async ({ id }) => searchAuth.removeSearchProfile(id),
  'searchAuth.reorder': async ({ orderedIds }) => searchAuth.reorderSearchProfiles(orderedIds || []),
  'searchAuth.test':    async ({ id }) => searchAuth.testSearchProfile(id),

  // ── Local-exec permission (gates bash / write_file / *_to_pdf tools) ──
  // Flat state object returned as handler result so the renderer receives
  // `{ ok: true, granted, grantedAt?, revokedAt? }` — settings.js reads
  // those fields directly off the response.
  'permissions.getLocalExec':    async () => permissions.getLocalExecState(),
  'permissions.grantLocalExec':  async () => permissions.grantLocalExec(),
  'permissions.revokeLocalExec': async () => permissions.revokeLocalExec(),
  // Three-mode setter (off / risk_prompt / allow_all). Returns the new state
  // in the same shape as getLocalExec so settings.js can read it back.
  'permissions.setLocalExecMode': async ({ mode }: { mode?: unknown }) => {
    if (mode !== 'off' && mode !== 'risk_prompt' && mode !== 'allow_all') {
      throw new Error('invalid mode');
    }
    return permissions.setLocalExecMode(mode);
  },

  // ── User-granted folder access (plan §B2) ──────────────────────────────
  // Extra directories the file/bash tools may touch beyond workspace +
  // attachments. Grant goes through a native folder picker; the feature
  // enforces the deny-list (credential/system dirs) + realpath.
  'grantedRoots.list': async (_payload: unknown, ctx: { userId: string }) => {
    const granted = await import('../features/granted_roots');
    return { roots: granted.listGrantedRoots(ctx.userId) };
  },
  'grantedRoots.add': async (_payload: unknown, ctx: { userId: string }) => {
    const selected = await userWorkspace.selectDirectory();
    if (!selected) return { ok: false as const, cancelled: true };
    const granted = await import('../features/granted_roots');
    try {
      const row = granted.grantRoot(ctx.userId, selected);
      return { ok: true as const, root: row };
    } catch (err) {
      const code = err instanceof granted.GrantedRootError ? err.code : 'E_UNKNOWN';
      return { ok: false as const, error: code };
    }
  },
  'grantedRoots.remove': async (payload: { path?: unknown }, ctx: { userId: string }) => {
    if (typeof payload?.path !== 'string') throw new Error('invalid path');
    const granted = await import('../features/granted_roots');
    return { ok: true as const, removed: granted.revokeRoot(ctx.userId, payload.path) };
  },

  // ── External packages management (plan §A; UI is read + manage only) ────
  // Install stays on the commander/CLI path (it needs the clone + dependency
  // consent flow). The registry's single-writer is bin/orkas-pkg.cjs.
  'packages.list': async (_payload: unknown, ctx: { userId: string }) => {
    const pkgs = await import('../features/packages');
    return { ok: true as const, packages: pkgs.listPackagesForUi(ctx.userId) };
  },
  'packages.action': async (payload: { command?: unknown; name?: unknown }, ctx: { userId: string }) => {
    if (typeof payload?.command !== 'string' || typeof payload?.name !== 'string') {
      throw new Error('invalid command/name');
    }
    const pkgs = await import('../features/packages');
    const result = await pkgs.runPackageCommand(ctx.userId, payload.command, payload.name);
    // Skill listing reflects enable/disable + remove immediately.
    try { (await import('../model/core-agent/skill-registry')).invalidateSkills(); } catch { /* runner not loaded */ }
    return result;
  },
  // Open-tier skills (external packages + global folders) for the read-only
  // "From packages & global folders" group in the skills panel. External and
  // global are listed independently (no cross-tier display-name dedupe) so a
  // skill present in BOTH an installed package and a global folder shows under
  // each provenance. Disabled ids are NOT filtered here — the panel renders the
  // toggle state itself. (enable/disable is keyed by id, so a same-id skill in
  // both tiers shares one toggle state.)
  'skills.listOpen': async (_payload: unknown, ctx: { userId: string }) => {
    const reg = await import('../model/core-agent/skill-registry');
    const componentEnabled = await import('../features/component_enabled');
    const disabled = componentEnabled.readDisabledSets(ctx.userId).skills;
    const { external, global } = await reg.listOpenSkillsByTier(ctx.userId);
    const rows = [...external, ...global].map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      source: r.source,
      enabled: r.package_name ? r.package_enabled !== false : !disabled.has(r.id),
      ...(r.package_name ? { package_name: r.package_name } : {}),
      ...(r.package_kind ? { package_kind: r.package_kind } : {}),
      ...(typeof r.package_enabled === 'boolean' ? { package_enabled: r.package_enabled } : {}),
    }));
    return { ok: true as const, skills: rows };
  },

  // Renderer reply for the inline `delete_file` confirmation card. The
  // main-side tool is NOT blocking on this — it returned a token-bearing
  // `requires_user_confirmation` already (see core-agent/delete-file-confirm.ts).
  // This handler just flips the token state to granted / denied so the
  // LLM's NEXT delete_file call (Step 2, with the same token) can resolve
  // it. Idempotent: a second call with the same id is a no-op.
  'delete_file.respond': async ({ confirm_id, granted }: { confirm_id: string; granted: boolean }) => {
    // Static import (not dynamic) — dynamic `await import()` of a path that
    // is also reached via static `import` elsewhere can resolve to a
    // distinct module instance under tsx/ESM, yielding two independent
    // `_entries` Maps. The IPC handler then flips state on one Map while
    // the tool reads from the other → LLM Step 2 sees `pending` forever.
    const ok = resolveDeleteConfirmation(String(confirm_id || ''), !!granted);
    return { ok };
  },

  // Renderer-side logs — forwarded here so all logging ends up in the
  // same daily file (with a `renderer/<module>` scope). Payload matches
  // `logFromRenderer` in main/logger.ts: { level, module, message, data }.
  'log.record': async (payload) => {
    logFromRenderer(payload || {});
    return {};
  },

  // ── User workspace (working directory) ──
  // Workspace handlers accept an optional scope hint:
  //   `{ cid }`        → main resolves cid → conv.project_id → scope
  //   `{ projectId }`  → renderer-supplied scope (commander tab project chip,
  //                      where there's no cid yet)
  //   neither          → default scope
  // When both are passed, cid takes precedence (it's the authoritative source
  // — conv.project_id is the truth). Project membership is frozen at conv
  // create time, so `cid → projectId` is a stable mapping.
  'workspace.get': async (payload, ctx) => {
    const projectId = await _resolveWorkspaceScope(ctx.userId, payload);
    return { path: userWorkspace.getWorkspacePath(ctx.userId, projectId) };
  },
  'workspace.getInfo': async (payload, ctx) => {
    const projectId = await _resolveWorkspaceScope(ctx.userId, payload);
    return userWorkspace.getWorkspaceInfo(ctx.userId, projectId);
  },
  'workspace.set': async (payload, ctx) => {
    const target = payload?.path;
    if (!target || typeof target !== 'string') throw new Error('missing path');
    const projectId = await _resolveWorkspaceScope(ctx.userId, payload);
    const result = userWorkspace.setWorkspacePath(ctx.userId, target, projectId);
    if (!result.ok) return { ok: false, error: (result as any).error };
    return { path: result.path };
  },
  'workspace.reset': async (payload, ctx) => {
    const projectId = await _resolveWorkspaceScope(ctx.userId, payload);
    const result = userWorkspace.resetWorkspacePath(ctx.userId, projectId);
    return { path: result.path };
  },
  'workspace.selectDirectory': async () => {
    const selected = await userWorkspace.selectDirectory();
    return { path: selected };
  },
  'workspace.openPath': async (payload, ctx) => {
    const projectId = await _resolveWorkspaceScope(ctx.userId, payload);
    const result = await userWorkspace.openWorkspaceInFileManager(ctx.userId, projectId);
    if (!result.ok) throw new Error((result as { ok: false; error: string }).error);
    return { path: result.path };
  },

  // Open the OS file manager focused on a single file (Finder on macOS,
  // Explorer on Windows, default file manager on Linux). The path must sit
  // inside the active user's file scope, or be an exact produced-file path
  // already recorded on the current conversation.
  'workspace.revealPath': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { throw new Error('file not found'); }
    if (st.isDirectory()) {
      const openErr = await shell.openPath(norm);
      if (openErr) throw new Error(openErr);
    } else {
      shell.showItemInFolder(norm);
    }
    return { path: norm };
  },

  // Lightweight existence check for renderer previews. Same scope as
  // reveal/delete/read: workspace, current cid attachments, project library,
  // or an exact produced path already recorded on the conversation.
  'workspace.statPath': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { return { exists: false, path: norm }; }
    return {
      exists: true,
      path: norm,
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  },

  'workspace.deletePath': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }

    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { return { ok: false, error: 'not_found' }; }
    if (!st.isFile() && !st.isDirectory()) return { ok: false, error: 'not_supported' };

    try {
      if (typeof shell.trashItem === 'function') await shell.trashItem(norm);
      else if (st.isDirectory()) fs.rmSync(norm, { recursive: true });
      else fs.unlinkSync(norm);
    } catch (err) {
      try {
        if (st.isDirectory()) fs.rmSync(norm, { recursive: true });
        else fs.unlinkSync(norm);
      }
      catch {
        return { ok: false, error: String((err as Error).message || 'delete failed') };
      }
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const fileIndexer = require('../features/file_indexer') as { invalidateFileCache?: (userId: string, absPath: string) => void };
      fileIndexer.invalidateFileCache?.(ctx.userId, norm);
    } catch { /* cache invalidation is best-effort */ }

    return { ok: true, path: norm };
  },

  // Resolve a per-conversation attachment's absolute path. The renderer's
  // chip carries (cid, name) but the in-app file viewer's contract is
  // "abs path in"; we go through `resolveAttachmentAbsPath` so the same
  // safe-name / traversal / not-a-file gates the chat-media:// handler
  // already enforces apply here.
  'attachments.absPath': async (payload, ctx) => {
    const cid = payload?.cid;
    const name = payload?.name;
    if (typeof cid !== 'string' || !cid) throw new Error('missing cid');
    if (typeof name !== 'string' || !name) throw new Error('missing name');
    const r = chatAttachments.resolveAttachmentAbsPath(ctx.userId, cid, name);
    if (!r.ok) {
      const err = r as { code?: string; error?: string };
      return { ok: false, error: err.error || err.code || 'failed' };
    }
    return { ok: true, path: r.absPath, kind: r.kind };
  },

  // Read a file's text content for the in-app preview overlay
  // (markdown / plain text — pdf and html are streamed via `chat-media://`
  // instead). Same scope as the file actions above: active workspace ∪ the
  // attachment dir of the current cid ∪ exact recorded produced files. 2 MB cap is
  // intentional — the whole file is slurped into the JS heap and crosses
  // IPC, so larger files would balloon the renderer; the caller falls
  // through to the "too large → open folder" dialog on `error: 'too_large'`.
  'produced.readText': async (payload, ctx) => {
    const target = payload?.path;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const norm = path.resolve(target);
    if (!await _isAllowedFileActionPath(ctx.userId, payload, norm)) {
      throw new Error('path is outside the user workspace');
    }
    let st: fs.Stats;
    try { st = fs.statSync(norm); }
    catch { return { ok: false, error: 'not_found' }; }
    if (!st.isFile()) return { ok: false, error: 'not_found' };
    const MAX_TEXT_BYTES = 2 * 1024 * 1024;
    if (st.size > MAX_TEXT_BYTES) {
      return { ok: false, error: 'too_large', size: st.size, cap: MAX_TEXT_BYTES };
    }
    let text: string;
    try { text = fs.readFileSync(norm, 'utf8'); }
    catch (err) { return { ok: false, error: String((err as Error).message || 'read failed') }; }
    // Strip UTF-8 BOM so markdown / json don't render a leading invisible char.
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return { ok: true, text, size: st.size };
  },

  // Write a UTF-8 text file into the workspace (or current cid's attachment
  // dir). Sandbox parity with `produced.readText`: same scope, same 2MB cap on
  // the resulting bytes — the chat-md drawer is the sole caller today, and
  // the file's job is "human edits the LLM's md output", so anything larger
  // belongs in the OS editor (open via reveal).
  'produced.writeText': async (payload, ctx) => {
    const target = payload?.path;
    const content = payload?.content;
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    if (typeof content !== 'string') {
      throw new Error('missing content');
    }
    const MAX_TEXT_BYTES = 2 * 1024 * 1024;
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > MAX_TEXT_BYTES) {
      return { ok: false, error: 'too_large', size: bytes, cap: MAX_TEXT_BYTES };
    }
    const norm = path.resolve(target);
    if (!isPathAllowed(norm, await _ipcFileSandboxAllowedRoots(ctx.userId, payload))) {
      throw new Error('path is outside the user workspace');
    }

    try {
      fs.writeFileSync(norm, content, 'utf8');
    } catch (err) {
      return { ok: false, error: String((err as Error).message || 'write failed') };
    }
    return { ok: true, size: bytes };
  },

  // Read the install data root (`<container>/data`) — read-only display
  // for the settings page "Data root" row. WS_ROOT is process-stable so
  // no async work is needed.
  'app.dataRootPath': async () => ({ ok: true, path: WS_ROOT }),

  // Open the install data root in the OS file manager. WS_ROOT is the
  // only path this opens — no caller-supplied path, so no sandbox check.
  'app.openDataRoot': async () => {
    const target = WS_ROOT;
    if (!fs.existsSync(target)) throw new Error('data root not found');
    shell.openPath(target);
    return { ok: true, path: target };
  },

  // Internal debug panel data is stripped from OrkasOpen. Keep stable
  // handler shapes so stale renderer calls receive empty results.
  'devtools.listArchives':  async () => ({ items: [] }),
  'devtools.readArchive':   async () => ({ item: null }),
  'devtools.clearArchives': async () => ({ ok: true }),
  'devtools.getNativeSearchEnabled': async () => ({ enabled: true }),
  'devtools.setNativeSearchEnabled': async () => ({ enabled: true }),
  'devtools.skillMetricsReport': async ({ sinceDays } = {}) => {
    const { aggregateSkillMetrics } = await import('../features/skill_metrics');
    return aggregateSkillMetrics({ sinceDays: Number.isFinite(sinceDays) ? Number(sinceDays) : undefined });
  },

  // User-account login (Google OAuth). Stripped from the OrkasOpen build.

  // User feedback from Settings. Depends on the account session for Server auth.

  // Multi-device sync. Stripped from the OrkasOpen build (depends on account).

  // Quality validator — renderer reads persisted ValidationReports to display
  // why a spec write / marketplace install was rejected.
  ...qualityHandlers,
  // Connectors (MCP-based). User-installed MCP servers expose tools to commander + selected
  // agents. No Server dependency → kept in OrkasOpen.
  ...connectorsHandlers,

  // Cross-session memory UI — view/edit/import/export over features/memory.ts.
  ...memoryHandlers,
};

// ── Stream handlers ──────────────────────────────────────────────────────
// Contract: `async function*(payload, ctx) yielding SSE-shape events`.
// The runtime ensures a terminal `{ type: 'done' }` is always sent, even on
// unexpected throws.

const streamHandlers: Record<string, StreamHandler> = {
  'conversations.sendStream': async function* ({ cid, content, attachments }, ctx, signal) {
    if (!safeId(cid)) {
      yield { type: 'error', text: 'invalid cid' };
      return;
    }
    const text = (content || '').trim();
    if (!text) {
      yield { type: 'error', text: 'empty message' };
      return;
    }
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string') : [];
    // Legacy `conversations.stream` is now a thin wrapper around the
    // group_chat bus. Subscribe to the bus directly BEFORE calling
    // `groupChat.send` — `send` internally wakes the recipient worker
    // synchronously, and that worker's first state_changed / process events
    // can fire on the same microtask cycle as `send` returns. We also drain
    // the subscription while `send` is still in flight: plan-triggered runs
    // can spend real time dispatching/reconciling before `send` resolves,
    // but the bus is already carrying the agent's process/delta stream.
    //
    // We relay events until the bus is fully quiescent (no worker running
    // AND every actor's queue empty) — checked via the in-memory bus
    // state, since on-disk state.json briefly shows 'idle' in the gap
    // between an actor finishing and the next one's wake.
    const buf: GroupEvent[] = [];
    let wake: (() => void) | null = null;
    let cancelled = signal.aborted;
    const notify = () => {
      const w = wake; wake = null; w?.();
    };
    const onAbort = () => {
      cancelled = true;
      notify();
    };
    if (!cancelled) signal.addEventListener('abort', onAbort, { once: true });
    const unsub = groupChat.subscribeBus(ctx.userId, cid, (ev) => {
      buf.push(ev);
      notify();
    });
    let relayCount = 0;
    let processCount = 0;
    let firstProcessLogged = false;
    let sendDone = false;
    let sendRes: Awaited<ReturnType<typeof groupChat.send>> | null = null;
    let sendErr: unknown = null;
    const sendPromise = (async () => {
      try {
        sendRes = await groupChat.send({
          userId: ctx.userId, cid, text,
          ...(atts.length ? { attachments: atts } : {}),
        });
      } catch (err) {
        sendErr = err;
      } finally {
        sendDone = true;
        notify();
      }
    })();
    void sendPromise;
    try {
      drainLoop: while (!cancelled) {
        while (buf.length) {
          const ev = buf.shift()!;
          relayCount += 1;
          if (ev.type === 'process') {
            processCount += 1;
            if (!firstProcessLogged) {
              firstProcessLogged = true;
              log.info(`sendStream first process cid=${cid} actor=${(ev as any).actor || ''} kind=${(ev as any).data?.type || ''}`);
            }
          }
          yield { type: 'event', event: { stream: 'group', data: ev } };
        }
        if (sendDone) {
          if (sendErr) {
            const errText = sendErr instanceof Error ? sendErr.message : String(sendErr || 'send failed');
            yield { type: 'error', text: errText };
            return;
          }
          if (!sendRes?.ok) {
            yield { type: 'error', text: sendRes?.error || 'send failed' };
            return;
          }
          if (groupChat.busIsQuiescent(ctx.userId, cid)) break drainLoop;
        }
        if (cancelled) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      log.info(`sendStream closed cid=${cid} relayed=${relayCount} process=${processCount} sendDone=${sendDone} cancelled=${cancelled}`);
      try { unsub(); } catch { /* ignore */ }
      try { signal.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    }
  },

  'groupChat.events': async function* ({ cid, untilIdle }, ctx, signal) {
    if (!safeId(cid)) {
      yield { type: 'error', text: 'invalid cid' };
      return;
    }
    if (untilIdle) {
      const buf: GroupEvent[] = [];
      let wake: (() => void) | null = null;
      let cancelled = signal.aborted;
      let sawWorkActivity = !groupChat.busIsQuiescent(ctx.userId, cid);
      let relayCount = 0;
      let processCount = 0;
      let firstProcessLogged = false;
      const onAbort = () => { cancelled = true; const w = wake; wake = null; w?.(); };
      if (!cancelled) signal.addEventListener('abort', onAbort, { once: true });
      const unsub = groupChat.subscribeBus(ctx.userId, cid, (ev) => {
        buf.push(ev);
        const w = wake; wake = null; w?.();
      });
      try {
        while (!cancelled) {
          while (buf.length) {
            const ev = buf.shift()!;
            if (ev.type === 'process') sawWorkActivity = true;
            if (ev.type === 'artifact_created') sawWorkActivity = true;
            if (ev.type === 'message') {
              const msg = (ev as any).msg;
              if (msg && msg.from !== 'user') sawWorkActivity = true;
            }
            if (ev.type === 'state_changed') {
              const st = ev.state;
              const inFlight = Array.isArray(st?.in_flight) ? st.in_flight : [];
              if (st?.status === 'running' || inFlight.length > 0 || !groupChat.busIsQuiescent(ctx.userId, cid)) {
                sawWorkActivity = true;
              }
            }
            relayCount += 1;
            if (ev.type === 'process') {
              processCount += 1;
              if (!firstProcessLogged) {
                firstProcessLogged = true;
                log.info(`groupEvents first process cid=${cid} actor=${(ev as any).actor || ''} kind=${(ev as any).data?.type || ''}`);
              }
            }
            yield ev;
            if (sawWorkActivity && groupChat.busIsQuiescent(ctx.userId, cid)) return;
          }
          if (sawWorkActivity && groupChat.busIsQuiescent(ctx.userId, cid)) return;
          if (cancelled) break;
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      } finally {
        log.info(`groupEvents closed cid=${cid} relayed=${relayCount} process=${processCount} cancelled=${cancelled}`);
        try { unsub(); } catch { /* ignore */ }
        try { signal.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
      }
      return;
    }
    for await (const ev of groupChat.streamEvents(ctx.userId, cid, { abortSignal: signal })) {
      yield ev;
    }
  },

  // Long-lived global stream the renderer opens once on boot. Each
  // auto-task fire produces a `conv_created` event so the sidebar can
  // reload its conv list (manual runs mutate the list locally, but auto
  // fires create the conv from main with no other notification path).
  'autoTasks.events': async function* (_payload, _ctx, signal) {
    const buf: autoTasks.AutoFireEvent[] = [];
    let wake: (() => void) | null = null;
    let cancelled = signal.aborted;
    const onAbort = () => { cancelled = true; const w = wake; wake = null; w?.(); };
    if (!cancelled) signal.addEventListener('abort', onAbort, { once: true });
    const unsub = autoTasks.subscribeFires((ev) => {
      buf.push(ev);
      const w = wake; wake = null; w?.();
    });
    try {
      while (!cancelled) {
        while (buf.length) {
          const ev = buf.shift()!;
          yield { type: 'event', event: ev };
        }
        if (cancelled) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      try { unsub(); } catch { /* ignore */ }
      try { signal.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    }
  },

  'skills.chat.sendStream': async function* ({ id, content, model_text, attachments }, ctx, signal) {
    if (!skills.isValidSkillId(id)) {
      yield { type: 'error', text: 'invalid skill id' };
      return;
    }
    const text = (content || '').trim();
    if (!text) {
      yield { type: 'error', text: 'empty message' };
      return;
    }
    const modelText = typeof model_text === 'string' ? model_text.trim() : '';
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string' && n) : [];
    yield* skills.streamSendToSkillChat(ctx.userId, id, text, {
      abortSignal: signal,
      ...(atts.length ? { attachments: atts } : {}),
      ...(modelText ? { modelText } : {}),
    });
  },

  'agents.chat.sendStream': async function* ({ id, content, model_text, attachments }, ctx, signal) {
    if (!safeId(id)) {
      yield { type: 'error', text: 'invalid agent id' };
      return;
    }
    const text = (content || '').trim();
    if (!text) {
      yield { type: 'error', text: 'empty message' };
      return;
    }
    const modelText = typeof model_text === 'string' ? model_text.trim() : '';
    const atts = Array.isArray(attachments) ? attachments.filter((n: any) => typeof n === 'string' && n) : [];
    yield* agents.streamSendToAgentEditChat(ctx.userId, id, text, {
      abortSignal: signal,
      ...(atts.length ? { attachments: atts } : {}),
      ...(modelText ? { modelText } : {}),
    });
  },

  'project.kb.events': async function* ({ projectId }, ctx, signal) {
    if (!safeId(projectId)) {
      yield { type: 'error', text: 'invalid projectId' };
      return;
    }
    const queue: import('../features/project_library_indexer').ProjectLibraryStatusEvent[] = [];
    let notify: (() => void) | null = null;
    const listener = (ev: import('../features/project_library_indexer').ProjectLibraryStatusEvent) => {
      if (ev.userId !== ctx.userId || ev.projectId !== projectId) return;
      queue.push(ev);
      notify?.();
    };
    projectLibraryIndexer.projectLibraryEvents.on('status', listener);
    const abortPromise = new Promise<void>((r) => {
      if (signal.aborted) r();
      else signal.addEventListener('abort', () => r(), { once: true });
    });
    try {
      while (!signal.aborted) {
        if (queue.length) {
          yield { type: 'event', event: queue.shift()! };
          continue;
        }
        await Promise.race([
          new Promise<void>((r) => { notify = () => { notify = null; r(); }; }),
          abortPromise,
        ]);
      }
    } finally {
      projectLibraryIndexer.projectLibraryEvents.off('status', listener);
    }
  },

  // Long-lived subscription: each kb_indexer status transition (pending →
  // processing → ready / failed, plus deletes) is pushed to the renderer so
  // UI chips update live without polling. Filter to the caller's uid — in the
  // current single-active-user world that's the only uid anyway, but the
  // guard keeps us honest when multi-uid lands.
  'kb.events': async function* (_payload, ctx, signal) {
    const queue: import('../features/kb_indexer').KbStatusEvent[] = [];
    let notify: (() => void) | null = null;
    const listener = (ev: import('../features/kb_indexer').KbStatusEvent) => {
      if (ev.userId !== ctx.userId) return;
      queue.push(ev);
      notify?.();
    };
    kbIndexer.kbEvents.on('status', listener);
    const abortPromise = new Promise<void>((r) => {
      if (signal.aborted) r();
      else signal.addEventListener('abort', () => r(), { once: true });
    });
    try {
      while (!signal.aborted) {
        if (queue.length) {
          yield { type: 'event', event: queue.shift()! };
          continue;
        }
        await Promise.race([
          new Promise<void>((r) => { notify = () => { notify = null; r(); }; }),
          abortPromise,
        ]);
      }
    } finally {
      kbIndexer.kbEvents.off('status', listener);
    }
  },
};

// ── Runtime ──────────────────────────────────────────────────────────────

interface StreamState { cancelled: boolean; controller: AbortController }
const activeStreams = new Map<string, StreamState>();

/**
 * Resolve the current user context for an IPC request. `user.init` must be
 * callable without context (bootstrap); every other handler gets a resolved
 * `userId` injected.
 */
async function resolveContext(sender: WebContents): Promise<IpcContext> {
  const user = await users.getOrCreateSelfUser();
  return { userId: user.user_id, user, sender };
}

/** Send a push-event to every open renderer. Channel name must match preload's
 *  `PUSH_EVENT_PREFIXES` allow-list. Used by main-initiated status broadcasts
 *  (boot-time reconcile / sync / updater state). */
export function broadcastToRenderer(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

export function register(): void {
  ipcMain.handle('orkas.invoke', async (event, { channel, payload }) => {
    const handler = invokeHandlers[channel];
    if (!handler) return { ok: false, error: `unknown channel: ${channel}` };
    try {
      const ctx = await resolveContext(event.sender);
      const result = await handler(payload || {}, ctx);
      return { ok: true, ...(result || {}) };
    } catch (err) {
      log.error(`invoke ${channel} failed`, { error: (err as Error)?.message || String(err) });
      const out: {
        ok: false;
        error: string;
        code?: string | number;
        marketplaceKind?: string;
        marketplaceId?: string;
        marketplaceName?: string;
        marketplaceReason?: string;
        qualityReport?: unknown;
      } = {
        ok: false,
        error: (err as Error).message || String(err),
      };
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string' || typeof code === 'number') out.code = code;
      const qualityReport = (err as { qualityReport?: unknown }).qualityReport;
      if (qualityReport) out.qualityReport = qualityReport;
      const installInfo = marketplace.getMarketplaceInstallErrorInfo(err);
      if (installInfo.kind) {
        out.marketplaceKind = installInfo.kind;
        if (installInfo.id) out.marketplaceId = installInfo.id;
        if (installInfo.name) out.marketplaceName = installInfo.name;
        if (installInfo.reason) out.marketplaceReason = installInfo.reason;
      }
      return out;
    }
  });

  ipcMain.on('orkas.streamStart', async (event, { requestId, channel, payload }) => {
    const out = (ev: unknown) => {
      if (event.sender.isDestroyed()) return;
      event.sender.send(`stream:${requestId}`, ev);
    };

    const handler = streamHandlers[channel];
    if (!handler) {
      out({ type: 'error', text: `unknown stream channel: ${channel}` });
      out({ type: 'done' });
      return;
    }

    const controller = new AbortController();
    const state: StreamState = { cancelled: false, controller };
    activeStreams.set(requestId, state);
    log.info(`streamStart channel=${channel} requestId=${requestId} cid=${payload?.cid || payload?.id || payload?.agent_id || ''}`);
    try {
      const ctx = await resolveContext(event.sender);
      for await (const ev of handler(payload || {}, ctx, controller.signal)) {
        if (state.cancelled) break;
        if (ev && ev.type === 'done') continue; // normalize below
        out(ev);
      }
    } catch (err) {
      log.error(`stream ${channel} failed`, { error: (err as Error)?.message || String(err) });
      out({ type: 'error', text: (err as Error).message || String(err) });
    } finally {
      activeStreams.delete(requestId);
      log.info(`streamDone channel=${channel} requestId=${requestId} cancelled=${state.cancelled}`);
      out({ type: 'done' });
    }
  });

  ipcMain.on('orkas.streamCancel', (_event, requestId: string) => {
    const state = activeStreams.get(requestId);
    if (!state) {
      log.warn(`streamCancel: unknown requestId=${requestId}`);
      return;
    }
    log.info(`streamCancel requestId=${requestId}`);
    state.cancelled = true;
    // Propagate the cancel into the generator's async work — in particular
    // the in-flight LLM HTTP call inside `streamChatWithModel`. Without this
    // the `for await` loop above only breaks on the *next* yield, which can
    // be minutes away while the provider is blocked on network I/O, and the
    // `processing` flag stays pinned until the generator's finally runs.
    try { state.controller.abort(); } catch (_) { /* already aborted */ }
  });
}
