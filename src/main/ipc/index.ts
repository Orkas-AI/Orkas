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

import { ipcMain, dialog, BrowserWindow, type WebContents } from 'electron';

import * as users from '../features/users';
import * as chats from '../features/chats';
import * as groupChat from '../features/group_chat';
import type { GroupEvent } from '../features/group_chat/bus';
import * as agents from '../features/agents';
import { isAgentEnabled } from '../features/component_enabled';
import * as skills from '../features/skills';
import * as contexts from '../features/contexts';
import * as kbVector from '../features/kb_vector';
import * as kbIndexer from '../features/kb_indexer';
import * as chatAttachments from '../features/chat_attachments';
import * as search from '../features/search';
import * as auth from '../features/auth';
import * as imageAuth from '../features/image_auth';
import * as searchAuth from '../features/search_auth';
import * as permissions from '../features/permissions';
import * as appConfig from '../features/config';
import * as avatars from '../features/avatars';
import { getRendererTables, isLang, t } from '../i18n';
import * as userWorkspace from '../features/user_workspace';
import { invokeHandlers as localAgentsHandlers } from './local_agents';
import { safeId } from '../storage';
import { createLogger, logFromRenderer } from '../logger';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { shell } from 'electron';

const log = createLogger('ipc');

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
    return {
      conversation: { ...conv, agent_enabled },
      history: await chats.getMessages(ctx.userId, cid, limit),
    };
  },

  'conversations.create': async ({ title = '' } = {}, ctx) => {
    const conv = await chats.createConversation(ctx.userId, { kind: 'normal', title });
    return { conversation: conv };
  },

  'conversations.delete': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    const ok = await chats.deleteConversation(ctx.userId, cid);
    return { deleted: ok };
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
    return groupChat.listMembers(ctx.userId, cid);
  },

  'groupChat.readPlan': async ({ cid }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return groupChat.readPlanForCid(ctx.userId, cid);
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

  'conversations.attachments.delete': async ({ cid, name }, ctx) => {
    if (!safeId(cid)) throw new Error('invalid cid');
    return chatAttachments.deleteAttachment(ctx.userId, cid, name || '');
  },

  'conversations.attachments.adopt': async ({ from_cid, to_cid }, ctx) => {
    if (!safeId(from_cid)) throw new Error('invalid from_cid');
    if (!safeId(to_cid)) throw new Error('invalid to_cid');
    return chatAttachments.adoptDraftAttachments(ctx.userId, from_cid, to_cid);
  },

  // ── Agents ──
  'agents.list': async () => ({ agents: await agents.listAgents() }),

  'agents.get': async ({ agent_id }) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const agent = await agents.getAgent(agent_id);
    if (!agent) throw new Error('agent not found');
    return { agent };
  },

  'agents.create': async ({ name = '', description = '', workflow = '', icon, color, runtime } = {}) => {
    return { agent: await agents.createCustomAgent({ name, description, workflow, icon, color, runtime }) };
  },

  'agents.update': async ({ agent_id, updates }) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const data = await agents.updateCustomAgent(agent_id, updates || {});
    if (!data) throw new Error('agent not found or read-only');
    return { agent: data };
  },

  'agents.delete': async ({ agent_id }) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
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

  'agents.chat.history': async ({ agent_id, limit = 500 }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    if (!(await agents.getAgent(agent_id))) throw new Error('agent not found');
    return { messages: await agents.getAgentChatMessages(ctx.userId, agent_id, limit) };
  },

  'agents.chat.clear': async ({ agent_id }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    return { cleared: await agents.clearAgentChat(ctx.userId, agent_id) };
  },

  'agents.chat.send': async ({ agent_id, content }, ctx) => {
    if (!agents.isValidAgentId(agent_id)) throw new Error('invalid agent_id');
    const text = (content || '').trim();
    if (!text) throw new Error('empty message');
    return agents.sendToAgentEditChat(ctx.userId, agent_id, text);
  },

  // ── Skills ──
  'skills.list': async () => ({ skills: await skills.listSkills() }),

  'skills.read': async ({ source, id, file = 'SKILL.md' }) => {
    if (source !== 'builtin' && source !== 'custom') throw new Error('invalid source');
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return skills.readSkillFile(source, id, file);
  },

  'skills.writeFile': async ({ id, file, content }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    if (!file) throw new Error('missing file');
    const ok = skills.writeCustomSkillFile(id, file, content || '');
    if (!ok) throw new Error(t('errors.skill_write_failed'));
    return { written: true };
  },

  'skills.tree': async ({ source, id }) => {
    if (source !== 'builtin' && source !== 'custom') throw new Error('invalid source');
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return skills.listSkillTree(source, id);
  },

  'skills.create': async ({ name, description }) => {
    return { skill: await skills.createCustomSkill(name, description || '') };
  },

  'skills.pickImportDir': async () => {
    // Runs in main; show a native directory picker attached to the focused
    // BrowserWindow so the dialog is modal to Orkas.
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts: Electron.OpenDialogOptions = {
      properties: ['openDirectory'],
      title: '选择要导入的技能源目录',
    };
    const res = parent
      ? await dialog.showOpenDialog(parent, opts)
      : await dialog.showOpenDialog(opts);
    if (res.canceled || !res.filePaths?.length) return { cancelled: true };
    return { cancelled: false, path: res.filePaths[0] };
  },

  'skills.createFromUrl': async ({ name, description, url }) => {
    const r = await skills.createFromUrl(name ?? null, description ?? null, String(url || ''));
    if (!r.ok) throw new Error(r.error || 'import failed');
    return { skill: r.skill, seedMessage: r.seedMessage };
  },

  'skills.createFromDir': async ({ name, description, srcDir }) => {
    const r = await skills.createFromDir(name ?? null, description ?? null, String(srcDir || ''));
    if (!r.ok) throw new Error(r.error || 'import failed');
    return { skill: r.skill, seedMessage: r.seedMessage };
  },

  'skills.update': async ({ id, updates }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const data = await skills.updateCustomSkill(id, updates || {});
    if (!data) throw new Error('skill not found');
    return { skill: data };
  },

  'skills.delete': async ({ id }) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
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
    if (!(await skills.getCustomSkill(id))) throw new Error('skill not found');
    return { messages: await skills.getSkillChatMessages(ctx.userId, id, limit) };
  },

  'skills.chat.clear': async ({ id }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    return { cleared: await skills.clearSkillChat(ctx.userId, id) };
  },

  'skills.chat.send': async ({ id, content }, ctx) => {
    if (!skills.isValidSkillId(id)) throw new Error('invalid skill id');
    const text = (content || '').trim();
    if (!text) throw new Error('empty message');
    return skills.sendToSkillChat(ctx.userId, id, text);
  },

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

  'contexts.mkdir': async ({ path }) => {
    return contexts.createContextDir(path || '');
  },

  'contexts.rename': async ({ src, dst }) => {
    return contexts.renameContextEntry(src || '', dst || '');
  },

  'contexts.delete': async ({ path }) => {
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

  // Open a KB file in the OS default app (Preview / Acrobat / Word / etc.)
  // — used for pdf / docx where we don't render inline, and as a fallback
  // "open externally" button available on every file kind.
  'contexts.reveal': async ({ path }) => {
    return contexts.openContextFileInSystem(path || '');
  },

  // ── Knowledge base (向量库) ──
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

  // Re-enqueue a single file (typically the UI's "重新处理" button after a
  // failed extraction).
  'kb.reprocess': async ({ path }, ctx) => {
    if (typeof path !== 'string' || !path) throw new Error('path required');
    kbIndexer.enqueue(ctx.userId, path, 'upsert');
    return { path };
  },

  // ── Global search (knowledge base + chat history) ──
  'search.global': async ({ query, limit, scope }, ctx) => {
    return search.searchAll(ctx.userId, query || '', {
      limit: typeof limit === 'number' ? limit : 30,
      scope: scope || 'all',
    });
  },

  // ── UI language & locale tables (renderer i18n) ──
  'config.getLanguage': async () => ({ language: appConfig.getLanguage() }),
  'config.setLanguage': async ({ language }) => {
    if (!isLang(language)) throw new Error(`unsupported language: ${String(language)}`);
    return { language: appConfig.setLanguage(language) };
  },
  'config.getLocales': async () => ({ tables: getRendererTables() }),

  // 头像 catalog（图标 + 颜色 + 指挥官默认）—— 单一真相源在
  // src/main/data/avatars.json。renderer 启动时拉一次，自此用本地缓存。
  'avatars.getCatalog': async () => ({ catalog: avatars.getCatalog() }),

  // 指挥官头像偏好（云同步）。avatar = { icon, color }，token 走 catalog
  // 白名单校验；缺省时 renderer 用 commander 默认（crown + gold）兜底。
  'prefs.getCommanderAvatar': async () => ({ avatar: appConfig.getCommanderAvatar() }),
  'prefs.setCommanderAvatar': async ({ icon, color }) => {
    return { avatar: appConfig.setCommanderAvatar({ icon, color }) };
  },

  // 元认知级别的 agent 自演进开关。落 preferences.json::metacognition_enabled，
  // 真正的 gate 单点真相在 features/metacognition.isFeatureEnabled（叠加 env
  // kill switch）。env `ORKAS_METACOGNITION='0'` 永远压过 UI 设置。
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

  // Renderer-side logs — forwarded here so all logging ends up in the
  // same daily file (with a `renderer/<module>` scope). Payload matches
  // `logFromRenderer` in main/logger.ts: { level, module, message, data }.
  'log.record': async (payload) => {
    logFromRenderer(payload || {});
    return {};
  },

  // ── User workspace (working directory) ──
  'workspace.get': async (_payload, ctx) => {
    return { path: userWorkspace.getWorkspacePath(ctx.userId) };
  },
  'workspace.getInfo': async (_payload, ctx) => {
    return userWorkspace.getWorkspaceInfo(ctx.userId);
  },
  'workspace.set': async ({ path }, ctx) => {
    if (!path || typeof path !== 'string') throw new Error('missing path');
    const result = userWorkspace.setWorkspacePath(ctx.userId, path);
    if (!result.ok) throw new Error((result as any).error);
    return { path: result.path };
  },
  'workspace.reset': async (_payload, ctx) => {
    const result = userWorkspace.resetWorkspacePath(ctx.userId);
    return { path: result.path };
  },
  'workspace.selectDirectory': async () => {
    const selected = await userWorkspace.selectDirectory();
    return { path: selected };
  },
  'workspace.openPath': async (_payload, ctx) => {
    const result = await userWorkspace.openWorkspaceInFileManager(ctx.userId);
    if (!result.ok) throw new Error((result as { ok: false; error: string }).error);
    return { path: result.path };
  },

  // Open the OS file manager focused on a single file (Finder on macOS,
  // Explorer on Windows, default file manager on Linux). The path MUST
  // sit inside the active user's workspace — outside paths are refused
  // so a malicious / buggy LLM-emitted path can't pop arbitrary folders.
  'workspace.revealPath': async ({ path: target }, ctx) => {
    if (typeof target !== 'string' || !target) {
      throw new Error('missing path');
    }
    const ws = userWorkspace.getWorkspacePath(ctx.userId);
    const norm = path.resolve(target);
    const wsNorm = path.resolve(ws);
    if (!norm.startsWith(wsNorm + path.sep) && norm !== wsNorm) {
      throw new Error('path is outside the user workspace');
    }
    if (!fs.existsSync(norm)) throw new Error('file not found');
    shell.showItemInFolder(norm);
    return { path: norm };
  },

  // Local CLI agent discovery (claude / codex / openclaw / opencode / hermes).
  // Discovery + model catalogs only; actual spawning happens inside group_chat
  // dispatch via `features/local_agents/runner.ts`, never as a standalone IPC.
  ...localAgentsHandlers,
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
    // group_chat bus. **Subscribe to the bus directly BEFORE calling
    // `groupChat.send`** — `send` internally wakes the recipient worker
    // synchronously, and that worker's first state_changed / process events
    // can fire on the same microtask cycle as `send` returns. If we waited
    // and then opened the subscription via `streamEvents`, those first
    // events would arrive at the bus listener list before our listener
    // attached and be dropped. The previous "send + then for-await
    // streamEvents" pattern was the source of "agent reply doesn't appear
    // until I refresh".
    //
    // We relay events until the bus is fully quiescent (no worker running
    // AND every actor's queue empty) — checked via the in-memory bus
    // state, since on-disk state.json briefly shows 'idle' in the gap
    // between an actor finishing and the next one's wake.
    const buf: GroupEvent[] = [];
    let wake: (() => void) | null = null;
    let cancelled = signal.aborted;
    const onAbort = () => {
      cancelled = true;
      const w = wake; wake = null; w?.();
    };
    if (!cancelled) signal.addEventListener('abort', onAbort, { once: true });
    const unsub = groupChat.subscribeBus(ctx.userId, cid, (ev) => {
      buf.push(ev);
      const w = wake; wake = null; w?.();
    });
    try {
      const sendRes = await groupChat.send({
        userId: ctx.userId, cid, text,
        ...(atts.length ? { attachments: atts } : {}),
      });
      if (!sendRes.ok) {
        yield { type: 'error', text: sendRes.error || 'send failed' };
        return;
      }
      let sawWorkActivity = false;
      drainLoop: while (!cancelled) {
        while (buf.length) {
          const ev = buf.shift()!;
          if (ev.type === 'state_changed') {
            const st = (ev as any).state;
            if (st && st.status === 'running') sawWorkActivity = true;
            if (sawWorkActivity && st && st.status !== 'running'
                && (!st.in_flight || st.in_flight.length === 0)
                && groupChat.busIsQuiescent(ctx.userId, cid)) {
              yield { type: 'event', event: { stream: 'group', data: ev } };
              break drainLoop;
            }
          }
          yield { type: 'event', event: { stream: 'group', data: ev } };
        }
        if (cancelled) break;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    } finally {
      try { unsub(); } catch { /* ignore */ }
      try { signal.removeEventListener?.('abort', onAbort); } catch { /* ignore */ }
    }
  },

  'groupChat.events': async function* ({ cid }, ctx, signal) {
    if (!safeId(cid)) {
      yield { type: 'error', text: 'invalid cid' };
      return;
    }
    for await (const ev of groupChat.streamEvents(ctx.userId, cid, { abortSignal: signal })) {
      yield ev;
    }
  },

  'skills.chat.sendStream': async function* ({ id, content }, ctx, signal) {
    if (!skills.isValidSkillId(id)) {
      yield { type: 'error', text: 'invalid skill id' };
      return;
    }
    const text = (content || '').trim();
    if (!text) {
      yield { type: 'error', text: 'empty message' };
      return;
    }
    yield* skills.streamSendToSkillChat(ctx.userId, id, text, { abortSignal: signal });
  },

  'agents.chat.sendStream': async function* ({ id, content }, ctx, signal) {
    if (!safeId(id)) {
      yield { type: 'error', text: 'invalid agent id' };
      return;
    }
    const text = (content || '').trim();
    if (!text) {
      yield { type: 'error', text: 'empty message' };
      return;
    }
    yield* agents.streamSendToAgentEditChat(ctx.userId, id, text, { abortSignal: signal });
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
      return { ok: false, error: (err as Error).message || String(err) };
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
